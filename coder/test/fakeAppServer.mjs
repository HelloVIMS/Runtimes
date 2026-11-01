// Protocol fixture only. Never starts Codex or calls a model/network service.
import readline from "node:readline";
import fs from "node:fs";
const mode = process.argv[2] ?? "basic";
const log = process.argv[3];
const hostThread = process.argv[4] ?? "host-thread";
const send = (value) => process.stdout.write(JSON.stringify(value) + "\n");
const note = (method, params) => send({ method, params });
const trace = (value) => {
  if (log) fs.appendFileSync(log, JSON.stringify(value) + "\n");
};
const pending = new Map();
let initialized = false,
  threadParams,
  turnParams;
const thread = "native-thread",
  turn = "native-turn";
let id = 10;
function ask(method, params, requestId = ++id) {
  return new Promise((resolve) => {
    pending.set(typeof requestId + ":" + requestId, resolve);
    send({ id: requestId, method, params });
  });
}
const scope = (itemId = "item") => ({ threadId: thread, turnId: turn, itemId });
const done = (status = "completed") =>
  note("turn/completed", {
    threadId: thread,
    turn: {
      id: turn,
      status,
      items: [],
      error: status === "failed" ? { message: "fixture failure" } : null,
    },
  });
const message = () =>
  note("item/completed", {
    ...scope(),
    item: {
      id: "answer",
      type: "agentMessage",
      text: "Native protocol fixture finished.",
    },
  });
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function run() {
  if (mode === "basic" || mode === "usage") {
    const part = {
      totalTokens: 125,
      inputTokens: 100,
      cachedInputTokens: 25,
      cacheWriteInputTokens: 10,
      outputTokens: 25,
      reasoningOutputTokens: 5,
    };
    note("thread/tokenUsage/updated", {
      ...scope(),
      tokenUsage: { total: part, last: part, modelContextWindow: 32000 },
    });
    note("thread/tokenUsage/updated", {
      ...scope(),
      tokenUsage: { total: part, last: part, modelContextWindow: 32000 },
    });
    message();
    done();
    return;
  }
  if (mode === "unknownnotification") {
    note("future/heartbeat", null);
    message();
    done();
    return;
  }
  if (mode === "typedids") {
    const first = {
      ...scope("q-number"),
      questions: [
        {
          id: "q",
          header: "Numeric",
          question: "Numeric request?",
          isSecret: false,
          isOther: true,
          options: [],
        },
      ],
    };
    const second = {
      ...scope("q-string"),
      questions: [
        {
          id: "q",
          header: "String",
          question: "String request?",
          isSecret: false,
          isOther: true,
          options: [],
        },
      ],
    };
    const replies = await Promise.all([
      ask("item/tool/requestUserInput", first, 42),
      ask("item/tool/requestUserInput", second, "42"),
    ]);
    trace({ typedReplies: replies });
    message();
    done();
    return;
  }
  if (mode === "early") {
    message();
    done();
    return;
  }
  if (mode === "wrongturn") {
    note("turn/completed", {
      threadId: thread,
      turn: { id: "some-other-turn", status: "completed" },
    });
    await delay(60);
    message();
    done();
    return;
  }
  if (mode === "failed") {
    done("failed");
    return;
  }
  if (mode === "exit") {
    process.stderr.write("DO_NOT_LEAK_PROVIDER_SECRET");
    process.exit(1);
  }
  if (mode === "malformed") {
    process.stdout.write("not valid json\n");
    return;
  }
  if (mode === "flood") {
    process.stdout.write("x".repeat(1024 * 1024 + 1) + "\n");
    return;
  }
  if (mode === "unknown") {
    await ask("account/privateNewApproval", scope());
    done();
    return;
  }
  if (mode === "wrongscope") {
    await ask("item/commandExecution/requestApproval", {
      ...scope(),
      threadId: "foreign",
      command: "echo x",
    });
    done();
    return;
  }
  if (mode === "duplicate") {
    send({
      id: "same",
      method: "item/tool/requestUserInput",
      params: {
        ...scope(),
        questions: [
          {
            id: "q",
            header: "q",
            question: "q?",
            isSecret: false,
            isOther: true,
            options: [],
          },
        ],
      },
    });
    send({
      id: "same",
      method: "item/tool/requestUserInput",
      params: { ...scope(), questions: [] },
    });
    return;
  }
  if (mode === "resolved") {
    send({
      id: "stale",
      method: "item/tool/requestUserInput",
      params: {
        ...scope(),
        questions: [
          {
            id: "q",
            header: "Question",
            question: "This will be withdrawn.",
            isSecret: false,
            isOther: true,
            options: [],
          },
        ],
      },
    });
    await delay(120);
    note("serverRequest/resolved", { threadId: thread, requestId: "stale" });
    await delay(120);
    message();
    done();
    return;
  }
  if (mode === "secret") {
    await ask("item/tool/requestUserInput", {
      ...scope(),
      questions: [
        {
          id: "secret",
          header: "Private",
          question: "Secret input",
          isSecret: true,
          isOther: true,
          options: [],
        },
      ],
    });
    done();
    return;
  }
  if (mode === "permissions") {
    const reply = await ask("item/permissions/requestApproval", {
      ...scope(),
      permissions: { network: { enabled: true }, fileSystem: { write: ["/"] } },
    });
    trace({ permissionReply: reply });
    const file = await ask("item/fileChange/requestApproval", {
      ...scope(),
      grantRoot: "/",
    });
    trace({ fileReply: file });
    const mcp = await ask("mcpServer/elicitation/request", {
      ...scope(),
      mode: "url",
      url: "https://not-opened.invalid/",
    });
    trace({ mcpReply: mcp });
    message();
    done();
    return;
  }
  if (
    mode === "approval" ||
    mode === "denial" ||
    mode === "cancel" ||
    mode === "sequence"
  ) {
    note("item/started", {
      ...scope("command-1"),
      item: {
        id: "command-1",
        type: "commandExecution",
        command: "node fixture-check.mjs",
        cwd: threadParams.cwd,
        status: "inProgress",
        aggregatedOutput: null,
      },
    });
    const reply = await ask("item/commandExecution/requestApproval", {
      ...scope("command-1"),
      command: "node fixture-check.mjs",
      cwd: threadParams.cwd,
      availableDecisions: ["accept", "acceptForSession", "decline", "cancel"],
    });
    trace({ commandReply: reply });
    if (mode === "cancel") return;
    note("item/completed", {
      ...scope("command-1"),
      item: {
        id: "command-1",
        type: "commandExecution",
        command: "node fixture-check.mjs",
        aggregatedOutput:
          reply.result?.decision === "accept"
            ? "fixture allowed"
            : "fixture declined",
        exitCode: 0,
      },
    });
    if (mode !== "sequence") {
      message();
      done();
      return;
    }
    const q = await ask("item/tool/requestUserInput", {
      ...scope("q1"),
      isBlocking: true,
      autoResolutionMs: null,
      questions: [
        {
          id: "format",
          header: "Format",
          question: "Choose exact value",
          isSecret: false,
          isOther: false,
          options: [
            { label: "  keep spacing  ", description: "exact native label" },
            { label: "other", description: "" },
          ],
        },
      ],
    });
    trace({ questionReply: q });
    note("item/started", {
      ...scope("file-1"),
      item: {
        id: "file-1",
        type: "fileChange",
        changes: [
          { path: "fixture.txt", kind: { type: "add" }, diff: "+fixture" },
        ],
        status: "inProgress",
      },
    });
    const file = await ask("item/fileChange/requestApproval", {
      ...scope("file-1"),
      reason: "Create a fixture file",
    });
    trace({ fileReply: file });
    if (file.result?.decision === "accept") {
      note("item/completed", {
        ...scope("file-1"),
        item: {
          id: "file-1",
          type: "fileChange",
          changes: [
            { path: "fixture.txt", kind: { type: "add" }, diff: "+fixture" },
          ],
          status: "completed",
        },
      });
    }
    const history = await ask("item/tool/call", {
      threadId: thread,
      turnId: turn,
      callId: "history-call",
      namespace: null,
      tool: "vims_thread_read",
      arguments: { threadId: hostThread, limit: 1 },
    });
    trace({ historyReply: history });
    const part = {
      totalTokens: 125,
      inputTokens: 100,
      cachedInputTokens: 25,
      cacheWriteInputTokens: 10,
      outputTokens: 25,
      reasoningOutputTokens: 5,
    };
    note("thread/tokenUsage/updated", {
      ...scope(),
      tokenUsage: { total: part, last: part, modelContextWindow: 32000 },
    });
    message();
    done();
    return;
  }
  if (mode === "historyforeign") {
    const reply = await ask("item/tool/call", {
      threadId: thread,
      turnId: turn,
      callId: "foreign-call",
      namespace: null,
      tool: "vims_thread_read",
      arguments: { threadId: "unrelated-thread" },
    });
    trace({ historyReply: reply });
    done();
    return;
  }
  if (mode === "hang") {
    return;
  }
  throw new Error("unknown test scenario");
}
const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  const request = JSON.parse(line);
  trace(request);
  if (!request.method) {
    pending.get(typeof request.id + ":" + request.id)?.(request);
    pending.delete(typeof request.id + ":" + request.id);
    return;
  }
  if (request.method === "initialize") {
    if (mode === "noinit") return;
    send({
      id: request.id,
      result: {
        userAgent: "fixture-native/0.160.0",
        platformFamily: "fixture",
        platformOs: "fixture",
        codexHome: "/fixture",
      },
    });
    return;
  }
  if (request.method === "initialized") {
    initialized = true;
    return;
  }
  if (!initialized) {
    send({
      id: request.id,
      error: { code: -32000, message: "not initialized" },
    });
    return;
  }
  if (request.method === "thread/start") {
    threadParams = request.params;
    const write = threadParams.sandbox === "workspace-write";
    send({
      id: request.id,
      result: {
        thread: { id: thread },
        model: mode === "wrongmodel" ? "unapproved-model" : threadParams.model,
        cwd: threadParams.cwd,
        approvalPolicy: "on-request",
        approvalsReviewer: mode === "autoreviewer" ? "auto_review" : "user",
        sandbox:
          mode === "widesandbox"
            ? { type: "dangerFullAccess" }
            : {
                type: write ? "workspaceWrite" : "readOnly",
                networkAccess: false,
                ...(write ? { writableRoots: [threadParams.cwd] } : {}),
              },
      },
    });
    return;
  }
  if (request.method === "turn/start") {
    turnParams = request.params;
    if (mode === "missingack") return;
    if (mode === "early") {
      void run().then(() =>
        send({
          id: request.id,
          result: { turn: { id: turn, status: "inProgress", items: [] } },
        }),
      );
      return;
    }
    send({
      id: request.id,
      result: { turn: { id: turn, status: "inProgress", items: [] } },
    });
    note("turn/started", {
      threadId: thread,
      turn: { id: turn, status: "inProgress" },
    });
    void run().catch(() => done("failed"));
    return;
  }
  if (request.method === "turn/interrupt") {
    send({ id: request.id, result: {} });
    done("interrupted");
    return;
  }
  send({
    id: request.id,
    error: { code: -32601, message: "unknown fixture method" },
  });
});
rl.on("close", () => process.exit(0));
