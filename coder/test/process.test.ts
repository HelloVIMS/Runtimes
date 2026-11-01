import { describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { CodexExecDriver, runJsonLines } from "../src/processDriver.ts";
import type { DriverItem, NativeTurn } from "../src/types.ts";
const turn: NativeTurn = {
  runId: "r",
  threadId: "t",
  cwd: process.cwd(),
  model: "configured-model",
  prompt: "literal $(not-shell) prompt",
  history: [],
  historyContext: "",
};
describe("native process adapter, with no T3 executable", () => {
  it("calls Codex directly using stdin, read-only by default, and retains public outcomes only", async () => {
    const seen: DriverItem[] = [];
    let args: string[] = [];
    let input = "";
    const d = new CodexExecDriver(
      "codex",
      process.execPath,
      {},
      async (options) => {
        args = options.args;
        input = options.stdin;
        options.onLine(
          JSON.stringify({
            type: "item.completed",
            item: { type: "reasoning", text: "not exported" },
          }),
        );
        options.onLine(
          JSON.stringify({
            type: "item.completed",
            item: { type: "agent_message", text: "answer" },
          }),
        );
        options.onLine(JSON.stringify({ type: "turn.completed" }));
      },
    );
    await d.run(turn, (item) => seen.push(item), new AbortController().signal);
    expect(args).toEqual([
      "exec",
      "--json",
      "--sandbox",
      "read-only",
      "--model",
      "configured-model",
      "--cd",
      turn.cwd,
      "-",
    ]);
    expect(args.join(" ")).not.toContain("literal");
    expect(input).toContain(turn.prompt);
    expect(seen).toEqual([{ type: "assistant_message", text: "answer" }]);
  });
  it("requires completion acknowledgement and handles failed turns", async () => {
    const d = new CodexExecDriver(
      "codex",
      process.execPath,
      {},
      async () => {},
    );
    await expect(
      d.run(turn, () => {}, new AbortController().signal),
    ).rejects.toThrow("without a completion");
    const failed = new CodexExecDriver(
      "codex",
      process.execPath,
      {},
      async (options) => options.onLine('{"type":"turn.failed"}'),
    );
    await expect(
      failed.run(turn, () => {}, new AbortController().signal),
    ).rejects.toThrow("failed turn");
  });
  it("permits workspace writes only by explicit adapter configuration", async () => {
    const d = new CodexExecDriver(
      "codex",
      process.execPath,
      { allowWorkspaceWrites: true },
      async (options) => {
        expect(options.args).toContain("workspace-write");
        expect(options.args).not.toContain("danger-full-access");
        options.onLine('{"type":"turn.completed"}');
      },
    );
    await d.run(turn, () => {}, new AbortController().signal);
  });
  it("runs a real fixture process with literal stdin and bounded output", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "vims-process-"));
    try {
      const script = path.join(root, "echo.mjs");
      await fs.writeFile(
        script,
        "let text='';for await(const c of process.stdin)text+=c;console.log(JSON.stringify({text,args:process.argv.slice(2)}));",
      );
      const lines: string[] = [];
      await runJsonLines({
        binary: process.execPath,
        args: [script, "arg with spaces", "$(literal)"],
        cwd: root,
        stdin: "prompt\nnot argv",
        signal: new AbortController().signal,
        onLine: (line) => lines.push(line),
      });
      expect(JSON.parse(lines[0]!)).toEqual({
        text: "prompt\nnot argv",
        args: ["arg with spaces", "$(literal)"],
      });
      const huge = path.join(root, "huge.mjs");
      await fs.writeFile(huge, "process.stdout.write('x'.repeat(5000));");
      await expect(
        runJsonLines({
          binary: process.execPath,
          args: [huge],
          cwd: root,
          stdin: "",
          signal: new AbortController().signal,
          onLine: () => {},
          maxBytes: 100,
        }),
      ).rejects.toThrow("stdout budget");
      const fail = path.join(root, "fail.mjs");
      await fs.writeFile(
        fail,
        "console.error('DO_NOT_EXPOSE_SECRET');process.exit(2);",
      );
      await expect(
        runJsonLines({
          binary: process.execPath,
          args: [fail],
          cwd: root,
          stdin: "",
          signal: new AbortController().signal,
          onLine: () => {},
        }),
      ).rejects.not.toThrow("DO_NOT_EXPOSE_SECRET");
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
  it("cancels the captured live child after its ready event", async () => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), "vims-process-cancel-"),
    );
    const c = new AbortController();
    let pid: number | undefined;
    try {
      const script = path.join(root, "wait.mjs");
      // Ignore SIGTERM on Unix to exercise escalation; Windows terminates it immediately.
      await fs.writeFile(
        script,
        "process.on('SIGTERM',()=>{});console.log(JSON.stringify({ready:true,pid:process.pid}));setInterval(()=>{},1000);",
      );
      await expect(
        runJsonLines({
          binary: process.execPath,
          args: [script],
          cwd: root,
          stdin: "",
          signal: c.signal,
          onLine: (line) => {
            pid = JSON.parse(line).pid;
            c.abort();
          },
        }),
      ).rejects.toThrow("cancelled");
      expect(pid).toBeTypeOf("number");
      expect(() => process.kill(pid!, 0)).toThrow();
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
  it("bounds newline-terminated oversized JSON lines too", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "vims-process-line-"));
    try {
      const script = path.join(root, "line.mjs");
      await fs.writeFile(
        script,
        "console.log(JSON.stringify({text:'x'.repeat(300000)}));",
      );
      await expect(
        runJsonLines({
          binary: process.execPath,
          args: [script],
          cwd: root,
          stdin: "",
          signal: new AbortController().signal,
          onLine: () => {
            throw new Error("oversized line escaped validation");
          },
        }),
      ).rejects.toThrow("line budget");
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
  it("refuses cancellation before spawning and shell launcher executables", async () => {
    const c = new AbortController();
    c.abort();
    await expect(
      runJsonLines({
        binary: process.execPath,
        args: [],
        cwd: process.cwd(),
        stdin: "",
        signal: c.signal,
        onLine: () => {},
      }),
    ).rejects.toThrow();
    await expect(
      runJsonLines({
        binary: path.resolve("unsafe.cmd"),
        args: [],
        cwd: process.cwd(),
        stdin: "",
        signal: new AbortController().signal,
        onLine: () => {},
      }),
    ).rejects.toThrow("native executable");
  });
});
