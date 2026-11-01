import path from "node:path";
import {
  RpcChild,
  RpcFault,
  type RpcChildOptions,
  type RpcId,
} from "./rpcChild.ts";
import type { NativeDriver, NativeTurn, DriverItem } from "./types.ts";
import type {
  NativeCapabilities,
  V2ThreadTokenUsageUpdatedNotification,
  HistoryReadInput,
} from "./providerTypes.ts";
import type { RuntimeRequestSpec, InputQuestion } from "./requestTypes.ts";
import { renderHistory } from "./t3/handoffBudget.ts";
import {
  toCodexUserInputAnswers,
  codexFileChangeApprovalPrompt,
} from "./t3/codexApprovalMappings.ts";
import {
  makeCodexTurnTokenUsageState,
  getCodexTurnAccumulator,
  accumulateCodexTurnTokenUsage,
  completeCodexTurnTokenUsage,
} from "./t3/codexTokenUsage.ts";
const object = (value: unknown): Record<string, unknown> => {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new RpcFault(-32602, "Expected an object");
  return value as Record<string, unknown>;
};
const string = (value: unknown, name: string, max = 8192): string => {
  if (
    typeof value !== "string" ||
    !value.length ||
    value.includes("\0") ||
    Buffer.byteLength(value) > max
  )
    throw new RpcFault(-32602, `Invalid ${name}`);
  return value;
};
const nativeId = (value: unknown) => string(value, "native id", 256);
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  void promise.catch(() => {});
  return { promise, resolve, reject };
}
async function withAbort<T>(
  promise: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  signal.throwIfAborted();
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(new Error("Native request no longer active"));
    signal.addEventListener("abort", abort, { once: true });
    void promise.then(
      (value) => {
        signal.removeEventListener("abort", abort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", abort);
        reject(error);
      },
    );
  });
}
export const VIMS_HISTORY_TOOL = {
  type: "function",
  name: "vims_thread_read",
  description:
    "Read bounded prior VIMS history for this task or its frozen checkpoint ancestors. Cannot read unrelated threads or future runs.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      threadId: { type: "string" },
      view: { const: "activity" },
      afterPosition: { type: "integer", minimum: 0 },
      limit: { type: "integer", minimum: 1, maximum: 50 },
      itemId: { type: "string" },
      textOffset: { type: "integer", minimum: 0 },
      maxCharsPerItem: { type: "integer", minimum: 1, maximum: 8000 },
      throughSequence: { type: "integer", minimum: 0 },
      maxOrdinal: { type: "integer", minimum: 0 },
    },
    required: ["threadId"],
  },
};
export function codexQuestions(raw: unknown): RuntimeRequestSpec {
  const payload = object(raw);
  if (
    !Array.isArray(payload.questions) ||
    payload.questions.length < 1 ||
    payload.questions.length > 8
  )
    throw new RpcFault(-32602, "Invalid native question count");
  const questions: InputQuestion[] = payload.questions.map((raw) => {
    const q = object(raw);
    if (q.isSecret === true)
      throw new RpcFault(
        -32602,
        "Secret elicitation is unsupported; use the provider directly",
      );
    if (
      q.options !== null &&
      q.options !== undefined &&
      !Array.isArray(q.options)
    )
      throw new RpcFault(-32602, "Invalid native options");
    const options = (q.options ?? []) as unknown[];
    if (options.length > 16) throw new RpcFault(-32602, "Too many options");
    return {
      id: nativeId(q.id),
      header: string(q.header, "question header", 128),
      question: string(q.question, "question", 4096),
      allowCustomAnswer: q.isOther === true || options.length === 0,
      options: options.map((raw) => {
        const option = object(raw);
        const label = string(option.label, "option label", 256);
        return {
          label,
          value: label,
          ...(typeof option.description === "string"
            ? { description: option.description }
            : {}),
        };
      }),
    };
  });
  return { kind: "questions", title: "Codex needs your answer", questions };
}
function usageValue(
  value: unknown,
): V2ThreadTokenUsageUpdatedNotification["tokenUsage"] {
  const raw = object(value);
  for (const key of ["total", "last"]) {
    const part = object(raw[key]);
    for (const field of [
      "totalTokens",
      "inputTokens",
      "cachedInputTokens",
      "outputTokens",
      "reasoningOutputTokens",
    ])
      if (!Number.isSafeInteger(part[field]) || Number(part[field]) < 0)
        throw new Error("Invalid native token counters");
    if (
      part.cacheWriteInputTokens !== undefined &&
      (!Number.isSafeInteger(part.cacheWriteInputTokens) ||
        Number(part.cacheWriteInputTokens) < 0)
    )
      throw new Error("Invalid native cache counters");
  }
  return raw as unknown as V2ThreadTokenUsageUpdatedNotification["tokenUsage"];
}
export interface CodexAppServerOptions {
  allowWorkspaceWrites?: boolean;
  contextWindow?: number;
  timeoutMs?: number;
  requestTimeoutMs?: number;
}
/** Direct native Codex app-server protocol, never a T3 child or remote socket. */
export class CodexAppServerDriver implements NativeDriver {
  readonly contextMode = "portable" as const;
  readonly capabilities: NativeCapabilities = {
    transport: "app-server-stdio",
    context: "portable",
    runtimeApprovals: true,
    userQuestions: true,
    historyTool: true,
    tokenUsage: true,
    nativeResume: false,
    providerInterrupt: true,
  };
  constructor(
    readonly id: string,
    readonly binary: string,
    readonly options: CodexAppServerOptions = {},
    private readonly createClient: (options: RpcChildOptions) => RpcChild = (
      options,
    ) => new RpcChild(options),
  ) {}
  get contextWindow() {
    return this.options.contextWindow;
  }
  async run(
    turn: NativeTurn,
    emit: (item: DriverItem) => void,
    signal: AbortSignal,
  ): Promise<void> {
    signal.throwIfAborted();
    if (!turn.request)
      throw new Error(
        "Codex app-server requires the VIMS human-request broker",
      );
    const timeout = this.options.timeoutMs ?? 600000;
    if (!Number.isSafeInteger(timeout) || timeout < 10 || timeout > 3600000)
      throw new Error("Invalid native turn deadline");
    const completion = deferred<void>(),
      turnReady = deferred<void>();
    let threadId: string | undefined, turnId: string | undefined;
    let accepted = false,
      finished = false,
      success = false;
    let turnRequested = false;
    let interruptSent = false;
    const usage = makeCodexTurnTokenUsageState();
    const startedItems = new Map<string, Record<string, unknown>>();
    const completedItems = new Set<string>();
    const early: Array<[string, unknown]> = [];
    let earlyBytes = 0;
    let prompts: Promise<unknown> = Promise.resolve();
    const requestTasks = new Set<Promise<unknown>>();
    const stopSignal = new AbortController();
    const activeSignal = AbortSignal.any([signal, stopSignal.signal]);
    const unsupported = (code: string) =>
      turn.telemetry?.({
        kind: "notice",
        code,
        message:
          "A native request outside the configured VIMS capability set was denied.",
      });
    const reject = (error: Error) => {
      completion.reject(error);
    };
    const scope = (raw: unknown) => {
      const params = object(raw);
      if (
        params.threadId !== threadId ||
        params.turnId !== turnId ||
        !turnId ||
        finished
      )
        throw new RpcFault(
          -32602,
          "Native request is outside the active thread/turn",
        );
      return params;
    };
    const ask = (
      spec: RuntimeRequestSpec,
      requestSignal: AbortSignal,
      deadline?: number,
    ) => {
      const task = prompts.then(async () => {
        requestSignal.throwIfAborted();
        activeSignal.throwIfAborted();
        if (finished) throw new RpcFault(-32800, "Turn already finished");
        return turn.request!(
          spec,
          deadline,
          AbortSignal.any([activeSignal, requestSignal]),
        );
      });
      prompts = task.then(
        () => {},
        () => {},
      );
      return task;
    };
    let rpc: RpcChild;
    const handleNotification = (method: string, raw: unknown) => {
      if (
        ![
          "serverRequest/resolved",
          "item/started",
          "item/completed",
          "turn/completed",
          "turn/started",
          "thread/tokenUsage/updated",
        ].includes(method)
      )
        return;
      const p = raw === undefined ? {} : object(raw);
      if (method === "serverRequest/resolved") {
        if (p.threadId !== threadId) return;
        if (typeof p.requestId === "string" || typeof p.requestId === "number")
          rpc.cancelServerRequest(p.requestId);
        return;
      }
      if (
        ![
          "item/started",
          "item/completed",
          "turn/completed",
          "turn/started",
          "thread/tokenUsage/updated",
        ].includes(method)
      )
        return;
      if (!threadId || p.threadId !== threadId) return;
      if (!accepted) {
        if (!turnRequested) return;
        earlyBytes += Buffer.byteLength(JSON.stringify(raw));
        if (early.length >= 256 || earlyBytes > 2 * 1024 * 1024)
          throw new Error("Native pre-ack notification budget exceeded");
        early.push([method, raw]);
        return;
      }
      if (finished) return;
      const eventTurn =
        method === "turn/completed" || method === "turn/started"
          ? object(p.turn).id
          : p.turnId;
      if (eventTurn !== turnId) return;
      if (method === "thread/tokenUsage/updated") {
        accumulateCodexTurnTokenUsage(usage, turnId!, usageValue(p.tokenUsage));
        return;
      }
      if (method === "turn/started") return;
      if (method === "turn/completed") {
        const result = object(p.turn);
        finished = true;
        rpc.cancelAllServerRequests();
        if (result.status === "completed" && !signal.aborted) {
          success = true;
          completion.resolve();
        } else
          completion.reject(
            new Error(
              `Native Codex turn ${result.status === "interrupted" ? "interrupted" : "failed"}; inspect its local history before retrying`,
            ),
          );
        return;
      }
      const item = object(p.item);
      const id = nativeId(item.id);
      if (method === "item/started") {
        if (startedItems.size >= 2000)
          throw new Error("Native item budget exceeded");
        startedItems.set(id, item);
        if (item.type === "collabAgentToolCall")
          getCodexTurnAccumulator(usage, turnId!).hasSubagents = true;
        return;
      }
      if (completedItems.has(id))
        throw new Error("Duplicate completed native item");
      completedItems.add(id);
      if (completedItems.size > 2000)
        throw new Error("Native completed-item budget exceeded");
      startedItems.delete(id);
      if (item.type === "agentMessage") {
        if (typeof item.text !== "string")
          throw new Error("Invalid native agent text");
        if (item.text.length)
          emit({
            type: "assistant_message",
            text: string(item.text, "agent message", 200000),
          });
      } else if (item.type === "plan") {
        emit({
          type: "proposed_plan",
          markdown: string(item.text, "plan", 200000),
        });
      } else if (item.type === "commandExecution") {
        emit({
          type: "command_execution",
          input: string(item.command, "command", 32768),
          output:
            typeof item.aggregatedOutput === "string"
              ? item.aggregatedOutput
              : "",
          exitCode: typeof item.exitCode === "number" ? item.exitCode : null,
        });
      } else if (item.type === "fileChange") {
        if (!Array.isArray(item.changes) || item.changes.length > 256)
          throw new Error("Invalid native file changes");
        for (const change of item.changes)
          emit({
            type: "file_change",
            fileName: string(object(change).path, "changed path", 4096),
          });
      }
      // Deliberately omit reasoning content and provider-private raw response events.
    };
    const serverRequest = async (
      method: string,
      raw: unknown,
      _id: RpcId,
      requestSignal: AbortSignal,
    ): Promise<unknown> => {
      if (!turnRequested)
        throw new RpcFault(-32601, "No active VIMS-native turn");
      await withAbort(turnReady.promise, requestSignal);
      const p = scope(raw);
      if (method === "item/tool/call") {
        if (
          p.tool !== "vims_thread_read" ||
          p.namespace != null ||
          !turn.readHistory
        )
          throw new RpcFault(
            -32601,
            "Dynamic tool is not provided by this task",
          );
        const args = object(p.arguments);
        const allowed = [
          "threadId",
          "view",
          "afterPosition",
          "limit",
          "itemId",
          "textOffset",
          "maxCharsPerItem",
          "throughSequence",
          "maxOrdinal",
        ];
        if (Object.keys(args).some((k) => !allowed.includes(k)))
          throw new RpcFault(-32602, "Unsupported history argument");
        try {
          const result = turn.readHistory(args as unknown as HistoryReadInput);
          const text = JSON.stringify(result);
          if (Buffer.byteLength(text) > 128 * 1024)
            throw new Error("output limit");
          return { contentItems: [{ type: "inputText", text }], success: true };
        } catch {
          return {
            contentItems: [
              {
                type: "inputText",
                text: "History request denied or exceeds bounds. Use only the current task or listed snapshot ancestors, with smaller limits.",
              },
            ],
            success: false,
          };
        }
      }
      if (method === "item/permissions/requestApproval") {
        unsupported("permission_grant_denied");
        return { permissions: {}, scope: "turn" };
      }
      if (method === "mcpServer/elicitation/request") {
        unsupported("mcp_elicitation_denied");
        return { action: "decline" };
      }
      if (
        method === "item/tool/requestUserInput" ||
        method === "tool/requestUserInput"
      ) {
        const spec = codexQuestions(p);
        const ms =
          typeof p.autoResolutionMs === "number"
            ? Math.max(10, Math.min(120000, p.autoResolutionMs))
            : 120000;
        const reply = await ask(spec, requestSignal, ms);
        requestSignal.throwIfAborted();
        if (reply.kind !== "questions" || spec.kind !== "questions")
          throw new RpcFault(-32603, "Mismatched VIMS answer kind");
        return {
          answers: toCodexUserInputAnswers(
            reply.answers,
            new Set(spec.questions.map((q) => q.id)),
          ),
        };
      }
      if (
        method === "item/commandExecution/requestApproval" ||
        method === "item/fileChange/requestApproval"
      ) {
        if (!this.options.allowWorkspaceWrites) {
          unsupported("read_only_approval_denied");
          return { decision: "decline" };
        }
        if (
          p.additionalPermissions != null ||
          p.networkApprovalContext != null ||
          p.grantRoot != null
        ) {
          unsupported("broader_permission_denied");
          return { decision: "decline" };
        }
        if (
          Array.isArray(p.availableDecisions) &&
          !p.availableDecisions.includes("accept")
        ) {
          unsupported("no_one_time_decision");
          return { decision: "decline" };
        }
        const itemId = nativeId(p.itemId);
        const pending = startedItems.get(itemId);
        if (
          method === "item/fileChange/requestApproval" &&
          (!pending || pending.type !== "fileChange")
        )
          throw new RpcFault(
            -32602,
            "No complete proposed file change to review",
          );
        if (
          method === "item/commandExecution/requestApproval" &&
          typeof p.command !== "string" &&
          typeof pending?.command !== "string"
        )
          throw new RpcFault(-32602, "No command available to review");
        const summary =
          method === "item/fileChange/requestApproval"
            ? (codexFileChangeApprovalPrompt({
                reason: typeof p.reason === "string" ? p.reason : null,
              }) ?? "Review proposed file changes.")
            : "Review this native command.";
        // Include the full action and proposal; never approve an abbreviated/truncated action.
        const detail =
          summary +
          "\n\nOne action only. No session, network, or persistent permission grant.\n" +
          JSON.stringify(
            { request: p, proposedItem: pending ?? null },
            null,
            2,
          );
        if (Buffer.byteLength(detail) > 8192)
          throw new RpcFault(
            -32602,
            "Native approval is too large to review here; use the provider directly",
          );
        const reply = await ask(
          {
            kind: "approval",
            title:
              method === "item/fileChange/requestApproval"
                ? "Codex: approve file change"
                : "Codex: approve command",
            detail,
          },
          requestSignal,
        );
        requestSignal.throwIfAborted();
        activeSignal.throwIfAborted();
        if (reply.kind !== "approval")
          throw new RpcFault(-32603, "Mismatched VIMS approval kind");
        return {
          decision: reply.decision === "allow_once" ? "accept" : "decline",
        };
      }
      throw new RpcFault(
        -32601,
        "Unsupported native server request; no authority granted",
      );
    };
    rpc = this.createClient({
      binary: this.binary,
      args: ["app-server", "--listen", "stdio://"],
      cwd: turn.cwd,
      requestTimeoutMs: this.options.requestTimeoutMs,
      onNotification: (method, params) => {
        try {
          handleNotification(method, params);
        } catch {
          reject(
            new Error("Native notification violated the active-turn contract"),
          );
        }
      },
      onRequest: (method, params, id, requestSignal) => {
        const task = serverRequest(method, params, id, requestSignal).catch(
          (error) => {
            if (!requestSignal.aborted && !finished)
              reject(
                new Error(
                  "Native request could not be safely handled; no automatic retry",
                ),
              );
            throw error;
          },
        );
        requestTasks.add(task);
        void task.finally(() => requestTasks.delete(task)).catch(() => {});
        return task;
      },
    });
    const abort = () => {
      rpc.cancelAllServerRequests();
      if (threadId && turnId && !finished) {
        if (interruptSent) return;
        interruptSent = true;
        void rpc
          .request("turn/interrupt", { threadId, turnId }, 1000)
          .catch(() => {})
          .finally(() =>
            reject(
              new Error(
                "Native task cancelled; interruption requested, no rollback implied",
              ),
            ),
          );
      } else {
        const error = new Error(
          "Native task cancelled before a turn acknowledgement; outcome may be uncertain",
        );
        reject(error);
        rpc.fail(error);
      }
    };
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    const timer = setTimeout(() => {
      const error = new Error(
        "Native turn deadline exceeded; task outcome may be uncertain",
      );
      reject(error);
      stopSignal.abort();
      rpc.fail(error);
    }, timeout);
    timer.unref();
    const closed = rpc.closed.then((error) => {
      throw (
        error ?? new Error("Native server exited without a turn completion")
      );
    });
    void closed.catch(() => {});
    try {
      const init = object(
        await rpc.request("initialize", {
          clientInfo: {
            name: "vims_native_coder",
            title: "VIMS Native Coder",
            version: "0.1.0",
          },
          capabilities: {
            experimentalApi: true,
            requestAttestation: false,
            explicitGatewayOauth: true,
          },
        }),
      );
      string(init.userAgent, "native initialization", 2048);
      rpc.notify("initialized");
      signal.throwIfAborted();
      const sandbox = this.options.allowWorkspaceWrites
        ? "workspace-write"
        : "read-only";
      const result = object(
        await rpc.request("thread/start", {
          model: turn.model,
          cwd: turn.cwd,
          runtimeWorkspaceRoots: [turn.cwd],
          approvalPolicy: "on-request",
          approvalsReviewer: "user",
          sandbox,
          ephemeral: true,
          allowProviderModelFallback: false,
          config: {
            "sandbox_workspace_write.network_access": false,
            web_search: "disabled",
          },
          ...(turn.readHistory ? { dynamicTools: [VIMS_HISTORY_TOOL] } : {}),
        }),
      );
      threadId = nativeId(object(result.thread).id);
      if (
        result.model !== turn.model ||
        result.approvalPolicy !== "on-request" ||
        result.approvalsReviewer !== "user" ||
        path.resolve(string(result.cwd, "native cwd", 4096)) !==
          path.resolve(turn.cwd)
      )
        throw new Error(
          "Codex did not confirm the requested model, directory or human approval policy",
        );
      const policy = object(result.sandbox);
      const expectedType = this.options.allowWorkspaceWrites
        ? "workspaceWrite"
        : "readOnly";
      if (policy.type !== expectedType || policy.networkAccess !== false)
        throw new Error("Codex returned a broader sandbox/network policy");
      if (
        expectedType === "workspaceWrite" &&
        (!Array.isArray(policy.writableRoots) ||
          policy.writableRoots.some(
            (root) =>
              typeof root !== "string" ||
              path.resolve(root) !== path.resolve(turn.cwd),
          ))
      )
        throw new Error("Codex returned missing or additional writable roots");
      turn.telemetry?.({ kind: "session", threadId });
      signal.throwIfAborted();
      const history = turn.history.length
        ? renderHistory(turn.history, turn.historyContext)
        : "";
      const prompt = [
        history,
        turn.readHistory
          ? "vims_thread_read is available for bounded omitted prior history of this VIMS task and its frozen ancestors."
          : "Do not assume host history tools are available.",
        "CURRENT USER REQUEST:",
        turn.prompt,
      ]
        .filter(Boolean)
        .join("\n\n");
      turnRequested = true;
      const started = object(
        await rpc.request("turn/start", {
          threadId,
          cwd: turn.cwd,
          model: turn.model,
          approvalPolicy: "on-request",
          approvalsReviewer: "user",
          sandboxPolicy: this.options.allowWorkspaceWrites
            ? {
                type: "workspaceWrite",
                writableRoots: [turn.cwd],
                networkAccess: false,
                excludeTmpdirEnvVar: true,
                excludeSlashTmp: true,
              }
            : { type: "readOnly", networkAccess: false },
          input: [{ type: "text", text: prompt, text_elements: [] }],
        }),
      );
      turnId = nativeId(object(started.turn).id);
      accepted = true;
      usage.activeTurnId = turnId;
      getCodexTurnAccumulator(usage, turnId);
      turn.telemetry?.({ kind: "session", threadId, turnId });
      turnReady.resolve();
      for (const [method, params] of early) handleNotification(method, params);
      early.length = 0;
      if (signal.aborted) abort();
      await Promise.race([completion.promise, closed]);
    } finally {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      finished = true;
      turnReady.reject(new Error("Native turn closed"));
      stopSignal.abort();
      rpc.cancelAllServerRequests();
      await rpc.close();
      await Promise.allSettled([...requestTasks]);
      if (turnId)
        turn.telemetry?.({
          kind: "usage",
          usage: completeCodexTurnTokenUsage(usage, turnId, success),
        });
    }
  }
}
