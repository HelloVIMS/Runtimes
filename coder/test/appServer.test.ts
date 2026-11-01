import { describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { RpcChild, envelope } from "../src/rpcChild.ts";
import { CodexAppServerDriver, codexQuestions } from "../src/codexAppServer.ts";
import type { NativeTurn, DriverItem } from "../src/types.ts";
import type { ProviderTelemetry } from "../src/providerTypes.ts";
import type { RuntimeReply, RuntimeRequestSpec } from "../src/requestTypes.ts";
import { fixture } from "./fixtures.ts";
import { CoderCore } from "../src/core.ts";
const peer = fileURLToPath(new URL("./fakeAppServer.mjs", import.meta.url));
const native = (
  mode: string,
  log: string,
  host = "host-thread",
  write = true,
  deadline = 10000,
) =>
  new CodexAppServerDriver(
    "app",
    process.execPath,
    {
      allowWorkspaceWrites: write,
      timeoutMs: deadline,
      requestTimeoutMs: 1200,
    },
    (options) =>
      new RpcChild({
        ...options,
        binary: process.execPath,
        args: [peer, mode, log, host],
      }),
  );
async function direct(
  mode: string,
  options: {
    write?: boolean;
    request?: NativeTurn["request"];
    readHistory?: NativeTurn["readHistory"];
    signal?: AbortSignal;
    deadline?: number;
  } = {},
) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "vims-appserver-test-"));
  const log = path.join(root, "wire.jsonl");
  const items: DriverItem[] = [];
  const telemetry: ProviderTelemetry[] = [];
  const requests: RuntimeRequestSpec[] = [];
  const turn: NativeTurn = {
    runId: "run",
    threadId: "host-thread",
    cwd: root,
    model: "owner-model",
    prompt: "Do not deploy. Literal $(not-shell) task.",
    history: [],
    historyContext: "",
    telemetry: (event) => telemetry.push(event),
    readHistory:
      options.readHistory ?? (() => ({ items: [{ text: "prior context" }] })),
    request:
      options.request ??
      (async (spec) => {
        requests.push(spec);
        return spec.kind === "approval"
          ? {
              kind: "approval",
              decision: mode === "denial" ? "deny" : "allow_once",
            }
          : { kind: "questions", answers: { format: "  keep spacing  " } };
      }),
  };
  try {
    await native(
      mode,
      log,
      turn.threadId,
      options.write ?? true,
      options.deadline ?? 10000,
    ).run(
      turn,
      (item) => items.push(item),
      options.signal ?? new AbortController().signal,
    );
    return {
      items,
      telemetry,
      requests,
      wire: (await fs.readFile(log, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line)),
    };
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}
describe("native app-server transport and integration", () => {
  it("initializes before use, binds policy, routes one-time approvals/questions/history and accounts tokens", async () => {
    const result = await direct("sequence");
    expect(result.requests.map((r) => r.kind)).toEqual([
      "approval",
      "questions",
      "approval",
    ]);
    const command = result.wire.find((m) => m.commandReply)?.commandReply;
    expect(command.result).toEqual({ decision: "accept" });
    expect(
      JSON.stringify(result.wire.filter((m) => m.result?.decision)),
    ).not.toContain("acceptForSession");
    expect(
      result.wire.find((m) => m.questionReply)?.questionReply.result,
    ).toEqual({ answers: { format: { answers: ["  keep spacing  "] } } });
    expect(
      result.wire.find((m) => m.historyReply)?.historyReply.result,
    ).toEqual({
      contentItems: [
        { type: "inputText", text: '{"items":[{"text":"prior context"}]}' },
      ],
      success: true,
    });
    expect(result.items.map((item) => item.type)).toEqual([
      "command_execution",
      "file_change",
      "assistant_message",
    ]);
    const usage = result.telemetry.findLast((e) => e.kind === "usage");
    expect(usage).toMatchObject({
      kind: "usage",
      usage: {
        usageStatus: "complete",
        inputTokens: 100,
        cachedInputTokens: 25,
        outputTokens: 25,
        reasoningTokens: 5,
      },
    });
    const thread = result.wire.find((m) => m.method === "thread/start").params;
    expect(thread.dynamicTools[0].name).toBe("vims_thread_read");
    expect(thread.ephemeral).toBe(true);
    expect(thread.approvalsReviewer).toBe("user");
    const start = result.wire.find((m) => m.method === "turn/start").params;
    expect(start.sandboxPolicy.networkAccess).toBe(false);
    expect(start.sandboxPolicy.excludeSlashTmp).toBe(true);
    expect(start.input[0].text).toContain("$(not-shell)");
  });
  it("does not double-count repeated cumulative usage updates", async () => {
    const result = await direct("usage");
    expect(result.telemetry.findLast((e) => e.kind === "usage")).toMatchObject({
      usage: { inputTokens: 100, outputTokens: 25, cachedInputTokens: 25 },
    });
  });
  it("buffers pre-ack completion and ignores other-turn completion messages", async () => {
    for (const mode of ["early", "wrongturn"]) {
      const result = await direct(mode);
      expect(result.items).toHaveLength(1);
      expect(result.items[0]).toMatchObject({ type: "assistant_message" });
    }
  });
  it("enforces the whole-turn deadline even before initialization acknowledges", async () => {
    const start = Date.now();
    await expect(direct("noinit", { deadline: 100 })).rejects.toThrow();
    expect(Date.now() - start).toBeLessThan(1100);
  });
  it("keeps numeric and string server IDs distinct and serializes human prompts", async () => {
    let active = 0,
      maximum = 0;
    const result = await direct("typedids", {
      request: async (spec) => {
        active++;
        maximum = Math.max(maximum, active);
        await new Promise((resolve) => setTimeout(resolve, 30));
        active--;
        if (spec.kind !== "questions") throw new Error("unexpected prompt");
        return { kind: "questions", answers: { q: spec.questions[0]!.header } };
      },
    });
    expect(maximum).toBe(1);
    const replies = result.wire.find((m) => m.typedReplies).typedReplies;
    expect(replies.map((r: { id: string | number }) => r.id)).toEqual([
      42,
      "42",
    ]);
    expect(
      replies.map(
        (r: { result: { answers: { q: { answers: string[] } } } }) =>
          r.result.answers.q.answers,
      ),
    ).toEqual([["Numeric"], ["String"]]);
  });
  it("ignores unrecognized future notifications rather than parsing their private payload", async () => {
    expect((await direct("unknownnotification")).items).toHaveLength(1);
  });
  it("returns a bounded history denial without revealing errors or terminating a valid turn", async () => {
    const result = await direct("historyforeign", {
      readHistory: () => {
        throw new Error("PRIVATE_OTHER_PROJECT_PATH");
      },
    });
    const reply = result.wire.find((m) => m.historyReply).historyReply.result;
    expect(reply.success).toBe(false);
    expect(JSON.stringify(reply)).not.toContain("PRIVATE_OTHER_PROJECT_PATH");
    expect(result.telemetry.findLast((e) => e.kind === "usage")).toBeDefined();
  });
  it("passes human denial as decline rather than inventing approval", async () => {
    const result = await direct("denial");
    expect(
      result.wire.find((m) => m.commandReply).commandReply.result.decision,
    ).toBe("decline");
  });
  it("denies escalations, persistent grants and unsupported MCP flows without a human-authority bypass", async () => {
    const result = await direct("permissions");
    expect(result.requests).toEqual([]);
    expect(
      result.wire.find((m) => m.permissionReply).permissionReply.result,
    ).toEqual({ permissions: {}, scope: "turn" });
    expect(result.wire.find((m) => m.fileReply).fileReply.result).toEqual({
      decision: "decline",
    });
    expect(result.wire.find((m) => m.mcpReply).mcpReply.result).toEqual({
      action: "decline",
    });
  });
  it("keeps read-only mode from authorizing an escalation callback", async () => {
    const result = await direct("approval", { write: false });
    expect(result.requests).toEqual([]);
    expect(
      result.wire.find((m) => m.commandReply).commandReply.result.decision,
    ).toBe("decline");
  });
  for (const mode of ["wrongmodel", "autoreviewer", "widesandbox"])
    it(`rejects ${mode} before sending a model turn`, async () => {
      const root = await fs.mkdtemp(
        path.join(os.tmpdir(), "vims-policy-test-"),
      );
      const log = path.join(root, "wire.jsonl");
      try {
        const turn: NativeTurn = {
          runId: "r",
          threadId: "t",
          cwd: root,
          model: "owner-model",
          prompt: "x",
          history: [],
          historyContext: "",
          request: async () => ({ kind: "approval", decision: "deny" }),
        };
        await expect(
          native(mode, log).run(turn, () => {}, new AbortController().signal),
        ).rejects.toThrow();
        const data = await fs.readFile(log, "utf8");
        expect(data).not.toContain('"method":"turn/start"');
      } finally {
        await fs.rm(root, { recursive: true, force: true });
      }
    });
  for (const mode of [
    "unknown",
    "wrongscope",
    "duplicate",
    "failed",
    "malformed",
    "flood",
    "missingack",
    "secret",
  ])
    it(`fails closed for ${mode}`, async () => {
      await expect(direct(mode)).rejects.toThrow();
    }, 5000);
  it("does not leak provider stderr in errors", async () => {
    await expect(direct("exit")).rejects.not.toThrow(
      "DO_NOT_LEAK_PROVIDER_SECRET",
    );
  });
  it("invalidates withdrawn native prompts without sending a late answer", async () => {
    let aborted = false;
    const result = await direct("resolved", {
      request: async (_spec, _timeout, signal) =>
        new Promise<RuntimeReply>((_resolve, reject) => {
          signal!.addEventListener(
            "abort",
            () => {
              aborted = true;
              reject(new Error("withdrawn"));
            },
            { once: true },
          );
        }),
    });
    expect(aborted).toBe(true);
    expect(
      result.wire.some(
        (m) => m.id === "stale" && ("result" in m || "error" in m),
      ),
    ).toBe(false);
  });
  it("interrupts the exact active native turn when VIMS cancellation arrives", async () => {
    const controller = new AbortController();
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), "vims-interrupt-test-"),
    );
    const log = path.join(root, "wire.jsonl");
    try {
      const turn: NativeTurn = {
        runId: "r",
        threadId: "t",
        cwd: root,
        model: "owner-model",
        prompt: "x",
        history: [],
        historyContext: "",
        request: async (_spec, _timeout, signal) => {
          controller.abort();
          await new Promise<void>((resolve) => {
            if (signal!.aborted) resolve();
            else
              signal!.addEventListener("abort", () => resolve(), {
                once: true,
              });
          });
          throw new Error("cancelled");
        },
      };
      await expect(
        native("cancel", log).run(turn, () => {}, controller.signal),
      ).rejects.toThrow();
      const rows = (await fs.readFile(log, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      expect(rows.find((m) => m.method === "turn/interrupt")?.params).toEqual({
        threadId: "native-thread",
        turnId: "native-turn",
      });
      expect(rows.some((m) => m.result?.decision === "accept")).toBe(false);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
  it("rejects secret elicitation and preserves exact offered option labels", () => {
    expect(() =>
      codexQuestions({
        questions: [
          { id: "q", header: "q", question: "q", isSecret: true, options: [] },
        ],
      }),
    ).toThrow("Secret");
    const spec = codexQuestions({
      questions: [
        {
          id: "q",
          header: "q",
          question: "q",
          isSecret: false,
          isOther: false,
          options: [{ label: " x ", description: "" }],
        },
      ],
    });
    expect(spec).toMatchObject({
      questions: [
        { options: [{ label: " x ", value: " x " }], allowCustomAnswer: false },
      ],
    });
  });
  it("validates RPC envelopes without exposing malformed payload content", () => {
    for (const input of [
      null,
      [],
      { id: 1, result: {}, error: { code: 0, message: "secret" } },
      { id: null, result: {} },
      { method: 5 },
      { id: NaN, result: {} },
      { id: 1, error: { code: "bad", message: "secret" } },
    ])
      expect(() => envelope(input)).toThrow();
    expect(envelope({ id: 0, result: null })).toEqual({ id: 0, result: null });
    expect(envelope({ id: "0", method: "test", params: {} })).toEqual({
      id: "0",
      method: "test",
      params: {},
    });
  });
});
describe("native protocol through persistent VIMS controls", () => {
  it("round-trips protocol approvals through the real broker and stores native usage/session IDs", async () => {
    const f = await fixture();
    const log = path.join(f.root, "wire.jsonl");
    const core = new CoderCore(f.state, [native("sequence", log)]);
    const control = new CoderCore(f.state);
    let execution: Promise<unknown> | undefined,
      runId = "";
    try {
      const thread = await core.createThread("create", {
        repository: f.repo,
        title: "Native protocol",
      });
      const run = core.queue("queue", {
        threadId: thread.id,
        driverId: "app",
        model: "owner-model",
        prompt: "Native flow",
      });
      runId = run.id;
      // Give the fixture the allowed host-thread ID without exposing another thread.
      core.close();
      const executor = new CoderCore(f.state, [
        native("sequence", log, thread.id),
      ]);
      try {
        executor.approve("approve", run.id);
        execution = executor.executeNext(thread.id);
        const answered = new Set<string>();
        const until = Date.now() + 8000;
        while (
          !["completed", "failed", "cancelled"].includes(
            control.store.run(run.id).status,
          )
        ) {
          for (const request of control.requests.pending(thread.id)) {
            if (answered.has(request.id)) continue;
            answered.add(request.id);
            control.respond(
              "reply-" + request.id,
              request.id,
              request.digest,
              request.spec.kind === "approval"
                ? { kind: "approval", decision: "allow_once" }
                : {
                    kind: "questions",
                    drafts: {
                      format: { selectedOptionValues: ["  keep spacing  "] },
                    },
                  },
            );
          }
          if (Date.now() > until) throw new Error("Native flow did not settle");
          await new Promise((resolve) => setTimeout(resolve, 30));
        }
        await execution;
        expect(control.store.run(run.id).status).toBe("completed");
        expect(answered.size).toBe(3);
        expect(control.store.run(run.id).usage).toMatchObject({
          inputTokens: 100,
          outputTokens: 25,
        });
        expect(control.store.run(run.id).nativeSession).toEqual({
          threadId: "native-thread",
          turnId: "native-turn",
        });
      } finally {
        executor.cancel("cleanup", run.id);
        await execution;
        executor.close();
      }
    } finally {
      control.close();
      await f.cleanup();
    }
  }, 15000);
  it("does not reveal an earlier-ordinal draft that has never executed", async () => {
    const f = await fixture([
      { id: "fixture", contextMode: "portable", async run() {} },
    ]);
    try {
      const t = await f.core.createThread("t", {
        repository: f.repo,
        title: "Private draft",
      });
      const earlier = f.core.queue("q1", {
        threadId: t.id,
        driverId: "fixture",
        model: "x",
        prompt: "UNAPPROVED PRIVATE DRAFT",
      });
      const active = f.core.queue("q2", {
        threadId: t.id,
        driverId: "fixture",
        model: "x",
        prompt: "Authorized task",
      });
      const result = f.core.readHistoryForRun(active.id, {
        threadId: t.id,
        limit: 50,
      });
      expect(result.items).toEqual([]);
      expect(
        f.core
          .vims_thread_read({ threadId: t.id })
          .items.some((item) => item.runId === earlier.id),
      ).toBe(true);
    } finally {
      await f.cleanup();
    }
  });
  it("scopes history to prior runs and fixed checkpoint ancestors, not arbitrary threads", async () => {
    const f = await fixture([
      {
        id: "fixture",
        contextMode: "portable",
        async run(_turn, emit) {
          emit({ type: "assistant_message", text: "prior result" });
        },
      },
    ]);
    try {
      const t = await f.core.createThread("t", {
        repository: f.repo,
        title: "One",
      });
      const foreign = await f.core.createThread("other", {
        repository: f.repo,
        title: "Other",
      });
      const r = f.core.queue("r", {
        threadId: t.id,
        driverId: "fixture",
        model: "x",
        prompt: "first",
      });
      f.core.approve("a", r.id);
      await f.core.executeNext(t.id);
      const next = f.core.queue("r2", {
        threadId: t.id,
        driverId: "fixture",
        model: "x",
        prompt: "NOT HISTORY YET",
      });
      const read = f.core.readHistoryForRun(next.id, {
        threadId: t.id,
        maxOrdinal: 99999,
        limit: 50,
      });
      expect(JSON.stringify(read)).toContain("prior result");
      expect(JSON.stringify(read)).not.toContain("NOT HISTORY YET");
      expect(() =>
        f.core.readHistoryForRun(next.id, { threadId: foreign.id }),
      ).toThrow("lineage");
    } finally {
      await f.cleanup();
    }
  });
});
