import { createHash, randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { Store, identifier, text, stable } from "./store.ts";
import {
  buildPendingUserInputAnswers,
  normalizeSelectedOptionValues,
} from "./t3/pendingUserInput.ts";
import type { PendingUserInputDraftAnswer } from "./t3/pendingUserInput.ts";
import type {
  RuntimeReply,
  RuntimeRequest,
  RuntimeRequestSpec,
  RuntimeResponseInput,
} from "./requestTypes.ts";
const RESERVED = new Set(Object.getOwnPropertyNames(Object.prototype));
const assertObject = (v: unknown): Record<string, unknown> => {
  if (v === null || typeof v !== "object" || Array.isArray(v))
    throw new Error("expected a JSON object");
  return v as Record<string, unknown>;
};
const only = (v: object, keys: readonly string[]) => {
  if (Object.keys(v).some((k) => !keys.includes(k)))
    throw new Error("unexpected request/answer field");
};
function optionalText(value: unknown, name: string, max: number): string {
  if (
    typeof value !== "string" ||
    Buffer.byteLength(value) > max ||
    value.includes("\0")
  )
    throw new Error(`invalid ${name}`);
  return value;
}
function specValue(raw: RuntimeRequestSpec): RuntimeRequestSpec {
  const r = assertObject(raw);
  text(r.title, "request title", 256);
  if (r.kind === "approval") {
    only(r, ["kind", "title", "detail"]);
    text(r.detail, "approval detail", 8192);
  } else if (r.kind === "questions") {
    only(r, ["kind", "title", "questions"]);
    if (
      !Array.isArray(r.questions) ||
      r.questions.length < 1 ||
      r.questions.length > 8
    )
      throw new Error("request must contain 1ΓÇô8 questions");
    const ids = new Set<string>();
    for (const item of r.questions) {
      const q = assertObject(item);
      only(q, [
        "id",
        "header",
        "question",
        "options",
        "multiSelect",
        "allowCustomAnswer",
        "initialAnswer",
      ]);
      const id = identifier(q.id);
      if (RESERVED.has(id) || ids.has(id))
        throw new Error("duplicate or reserved question id");
      ids.add(id);
      text(q.header, "question header", 128);
      text(q.question, "question", 4096);
      for (const key of ["multiSelect", "allowCustomAnswer"])
        if (q[key] !== undefined && typeof q[key] !== "boolean")
          throw new Error("invalid question boolean");
      if (q.initialAnswer !== undefined)
        optionalText(q.initialAnswer, "initial answer", 8192);
      if (
        !Array.isArray(q.options) ||
        q.options.length > 16 ||
        (q.allowCustomAnswer === false && q.options.length === 0)
      )
        throw new Error("invalid question options");
      const values = new Set<string>();
      for (const item of q.options) {
        const option = assertObject(item);
        only(option, ["label", "value", "description"]);
        text(option.label, "option label", 256);
        if (option.value !== undefined) text(option.value, "option value", 512);
        if (option.description !== undefined)
          optionalText(option.description, "option description", 1024);
        const value =
          option.value === undefined
            ? (option.label as string).trim()
            : (option.value as string);
        if (values.has(value)) throw new Error("duplicate option value");
        values.add(value);
      }
    }
  } else throw new Error("unsupported runtime request kind");
  if (Buffer.byteLength(JSON.stringify(raw)) > 32768)
    throw new Error("request exceeds 32 KiB");
  return structuredClone(raw);
}
function responseValue(
  request: RuntimeRequest,
  raw: RuntimeResponseInput,
): RuntimeReply {
  const r = assertObject(raw);
  if (r.kind !== request.spec.kind)
    throw new Error("response kind does not match request");
  if (r.kind === "approval") {
    only(r, ["kind", "decision"]);
    if (r.decision !== "allow_once" && r.decision !== "deny")
      throw new Error("only allow_once or deny is supported");
    return { kind: "approval", decision: r.decision };
  }
  only(r, ["kind", "drafts"]);
  if (request.spec.kind !== "questions")
    throw new Error("not a question request");
  const drafts = assertObject(r.drafts);
  const questions = request.spec.questions;
  if (Object.keys(drafts).some((id) => !questions.some((q) => q.id === id)))
    throw new Error("answer names an unknown question");
  const parsed: Record<string, PendingUserInputDraftAnswer> = {};
  for (const question of questions) {
    const raw = Object.hasOwn(drafts, question.id) ? drafts[question.id] : {};
    const draft = assertObject(raw);
    only(draft, ["selectedOptionValues", "customAnswer"]);
    if (draft.customAnswer !== undefined) {
      optionalText(draft.customAnswer, "custom answer", 8192);
      if (
        question.allowCustomAnswer === false &&
        (draft.customAnswer as string).length > 0
      )
        throw new Error("custom answers are disabled");
    }
    if (draft.selectedOptionValues !== undefined) {
      const values = draft.selectedOptionValues;
      if (
        !Array.isArray(values) ||
        values.some((x) => typeof x !== "string") ||
        values.length > 16
      )
        throw new Error("invalid selected options");
      if (!question.multiSelect && values.length > 1)
        throw new Error("question is single-select");
      if (
        values.some(
          (v) => normalizeSelectedOptionValues(question, [v]).length !== 1,
        )
      )
        throw new Error("unknown option value");
    }
    parsed[question.id] = draft as PendingUserInputDraftAnswer;
  }
  const answers = buildPendingUserInputAnswers(questions, parsed);
  if (answers === null) throw new Error("every question must be answered");
  if (Buffer.byteLength(JSON.stringify(answers)) > 32768)
    throw new Error("answers exceed 32 KiB");
  return { kind: "questions", answers };
}
export class RequestBroker {
  constructor(private readonly store: Store) {}
  get(id: string): RuntimeRequest {
    identifier(id);
    const row = this.store.db
      .prepare("SELECT body FROM runtime_requests WHERE id=?")
      .get(id);
    if (!row) throw new Error("unknown runtime request");
    return JSON.parse(String(row.body)) as RuntimeRequest;
  }
  pending(threadId: string): RuntimeRequest[] {
    this.store.thread(threadId);
    return this.store.db
      .prepare(
        "SELECT body FROM runtime_requests WHERE thread_id=? AND status='pending' ORDER BY id",
      )
      .all(threadId)
      .map((row) => JSON.parse(String(row.body)) as RuntimeRequest);
  }
  private put(r: RuntimeRequest): void {
    this.store.db
      .prepare(
        "INSERT INTO runtime_requests(id,thread_id,run_id,status,body) VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET status=excluded.status,body=excluded.body",
      )
      .run(r.id, r.threadId, r.runId, r.status, JSON.stringify(r));
  }
  cancelRun(runId: string): void {
    const rows = this.store.db
      .prepare(
        "SELECT body FROM runtime_requests WHERE run_id=? AND status='pending'",
      )
      .all(runId);
    for (const row of rows) {
      const r = JSON.parse(String(row.body)) as RuntimeRequest;
      this.put({ ...r, status: "cancelled" });
      this.store.event(r.threadId, r.runId, "request.cancelled", {
        requestId: r.id,
      });
    }
  }
  respond(
    commandId: string,
    id: string,
    digest: string,
    input: RuntimeResponseInput,
  ): RuntimeRequest {
    identifier(id);
    text(digest, "request digest", 64);
    return this.store.command(
      commandId,
      { type: "request.respond", id, digest, input },
      () => {
        const request = this.get(id);
        if (request.digest !== digest)
          throw new Error("stale or mismatched request content");
        if (request.status !== "pending")
          throw new Error("runtime request is no longer pending");
        if (Date.now() >= request.expiresAt)
          throw new Error("runtime request expired");
        const run = this.store.run(request.runId);
        if (run.status !== "blocked")
          throw new Error("request executor is no longer waiting");
        const response = responseValue(request, input);
        const updated: RuntimeRequest = {
          ...request,
          status: "answered",
          response,
          answeredAt: new Date().toISOString(),
        };
        this.put(updated);
        this.store.event(request.threadId, request.runId, "request.answered", {
          requestId: id,
          response,
        });
        return updated;
      },
    );
  }
  async ask(
    runId: string,
    raw: RuntimeRequestSpec,
    signal: AbortSignal,
    timeoutMs = 120000,
  ): Promise<RuntimeReply> {
    signal.throwIfAborted();
    const spec = specValue(raw);
    if (
      !Number.isSafeInteger(timeoutMs) ||
      timeoutMs < 10 ||
      timeoutMs > 600000
    )
      throw new Error("request timeout must be 10ΓÇô600000 ms");
    const request = this.store.transaction(() => {
      const run = this.store.run(runId);
      if (run.status !== "running")
        throw new Error("request requires a running native task");
      const count = Number(
        this.store.db
          .prepare(
            "SELECT COUNT(*) AS count FROM runtime_requests WHERE run_id=?",
          )
          .get(runId)!.count,
      );
      if (count >= 32) throw new Error("runtime request budget exceeded");
      const id = randomUUID();
      const value: RuntimeRequest = {
        id,
        threadId: run.threadId,
        runId,
        digest: createHash("sha256")
          .update(stable({ runId, id, spec }))
          .digest("hex"),
        spec,
        status: "pending",
        createdAt: new Date().toISOString(),
        expiresAt: Date.now() + timeoutMs,
        response: null,
        answeredAt: null,
      };
      this.put(value);
      this.store.putRun({ ...run, status: "blocked" });
      this.store.event(run.threadId, runId, "request.created", value);
      return value;
    });
    try {
      while (true) {
        signal.throwIfAborted();
        const run = this.store.run(runId);
        if (
          run.status === "cancel_requested" ||
          !["running", "blocked"].includes(run.status)
        )
          throw new Error("native task no longer accepts input");
        const current = this.get(request.id);
        if (current.status === "answered" && current.response) {
          this.store.transaction(() => {
            const latest = this.store.run(runId);
            if (latest.status !== "blocked")
              throw new Error("native task no longer waits for this request");
            this.store.putRun({ ...latest, status: "running" });
            this.store.event(request.threadId, runId, "request.consumed", {
              requestId: request.id,
            });
          });
          return current.response;
        }
        if (current.status !== "pending")
          throw new Error("runtime request was cancelled");
        if (Date.now() >= current.expiresAt) {
          const expired = this.store.transaction(() => {
            const latest = this.get(request.id);
            if (latest.status !== "pending") return false;
            this.put({ ...latest, status: "expired" });
            this.store.event(request.threadId, runId, "request.expired", {
              requestId: request.id,
            });
            return true;
          });
          if (expired) throw new Error("runtime request expired");
          continue;
        }
        await sleep(
          Math.min(40, Math.max(1, current.expiresAt - Date.now())),
          undefined,
          { signal },
        );
      }
    } finally {
      this.store.transaction(() => {
        const current = this.get(request.id);
        if (current.status === "pending") {
          this.put({ ...current, status: "cancelled" });
          this.store.event(request.threadId, runId, "request.cancelled", {
            requestId: request.id,
          });
        }
        const run = this.store.run(runId);
        if (run.status === "blocked")
          this.store.putRun({ ...run, status: "running" });
      });
    }
  }
}
