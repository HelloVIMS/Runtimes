import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import path from "node:path";
import type { DriverItem, NativeDriver, NativeTurn } from "./types.ts";
import { renderHistory } from "./t3/handoffBudget.ts";
/** Fixed executable/argv come from the trusted host, never a submitted task. */
export async function runJsonLines(options: {
  binary: string;
  args: string[];
  cwd: string;
  stdin: string;
  signal: AbortSignal;
  onLine: (line: string) => void;
  timeoutMs?: number;
  maxBytes?: number;
}): Promise<void> {
  if (!path.isAbsolute(options.binary) || /\.(cmd|bat)$/i.test(options.binary))
    throw new Error(
      "use an absolute native executable; shell launchers are not supported",
    );
  options.signal.throwIfAborted();
  const timeout = options.timeoutMs ?? 600_000;
  const maximum = options.maxBytes ?? 1024 * 1024;
  if (
    !Number.isSafeInteger(timeout) ||
    timeout < 1 ||
    timeout > 3_600_000 ||
    !Number.isSafeInteger(maximum) ||
    maximum < 1 ||
    maximum > 16 * 1024 * 1024
  )
    throw new Error("invalid subprocess limits");
  await new Promise<void>((resolve, reject) => {
    const child = spawn(options.binary, options.args, {
      cwd: options.cwd,
      stdio: ["pipe", "pipe", "pipe"],
      shell: false,
      windowsHide: true,
    });
    const decoder = new StringDecoder("utf8");
    let pending = "";
    let bytes = 0;
    let stderr = 0;
    let failure: Error | null = null;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const fail = (error: Error) => {
      if (failure) return;
      failure = error;
      child.kill();
      child.stdin.destroy();
      child.stdout.destroy();
      child.stderr.destroy();
      // Escalate only this exact captured child, never a process-name match.
      killTimer = setTimeout(() => child.kill("SIGKILL"), 1000);
      killTimer.unref();
    };
    const abort = () =>
      fail(
        new Error(
          "native process cancelled; detached descendants are outside this adapter",
        ),
      );
    options.signal.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(
      () => fail(new Error("native process deadline exceeded")),
      timeout,
    );
    timer.unref();
    child.on("error", () =>
      fail(new Error("could not execute configured native driver")),
    );
    child.stdin.on("error", () => {
      /* A child can exit before reading the complete prompt; close determines outcome. */
    });
    const line = (value: string) => {
      if (failure || !value.trim()) return;
      if (Buffer.byteLength(value) > 256 * 1024) {
        fail(new Error("native JSON line budget exceeded"));
        return;
      }
      try {
        options.onLine(value);
      } catch (error) {
        fail(
          error instanceof Error ? error : new Error("invalid native output"),
        );
      }
    };
    child.stdout.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > maximum) {
        fail(new Error("native stdout budget exceeded"));
        return;
      }
      pending += decoder.write(chunk);
      let split: number;
      while ((split = pending.indexOf("\n")) >= 0) {
        const value = pending.slice(0, split);
        pending = pending.slice(split + 1);
        line(value);
        if (failure) return;
      }
      if (Buffer.byteLength(pending) > 256 * 1024)
        fail(new Error("native JSON line budget exceeded"));
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.length;
      if (stderr > 64 * 1024) fail(new Error("native stderr budget exceeded"));
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      clearTimeout(killTimer);
      options.signal.removeEventListener("abort", abort);
      if (!failure) {
        pending += decoder.end();
        if (pending.trim()) line(pending);
      }
      if (failure) reject(failure);
      else if (code !== 0)
        reject(
          new Error(
            `native process exited ${code ?? signal}; inspect provider locally`,
          ),
        );
      else resolve();
    });
    if (options.signal.aborted) abort();
    child.stdin.end(options.stdin);
  });
}
/** Direct Codex CLI adapter, not T3. Task approval is enforced by CoderCore. */
export class CodexExecDriver implements NativeDriver {
  readonly contextMode = "portable" as const;
  constructor(
    readonly id: string,
    readonly binary: string,
    readonly options: {
      allowWorkspaceWrites?: boolean;
      contextWindow?: number;
      timeoutMs?: number;
    } = {},
    private readonly execute: typeof runJsonLines = runJsonLines,
  ) {}
  get contextWindow() {
    return this.options.contextWindow;
  }
  async run(
    turn: NativeTurn,
    emit: (item: DriverItem) => void,
    signal: AbortSignal,
  ): Promise<void> {
    let completed = false;
    const history = turn.history.length
      ? renderHistory(turn.history, turn.historyContext)
      : "";
    const prompt = [
      history
        ? "Historical context follows. VIMS history APIs mentioned here are host APIs, not automatically installed Codex tools. Ask the host for omitted material if needed."
        : "",
      history,
      "CURRENT USER REQUEST:",
      turn.prompt,
    ]
      .filter(Boolean)
      .join("\n\n");
    await this.execute({
      binary: this.binary,
      args: [
        "exec",
        "--json",
        "--sandbox",
        this.options.allowWorkspaceWrites ? "workspace-write" : "read-only",
        "--model",
        turn.model,
        "--cd",
        turn.cwd,
        "-",
      ],
      cwd: turn.cwd,
      stdin: prompt,
      signal,
      timeoutMs: this.options.timeoutMs,
      onLine: (line) => {
        const event: unknown = JSON.parse(line);
        if (event === null || typeof event !== "object")
          throw new Error("invalid Codex event");
        const e = event as Record<string, unknown>;
        if (e.type === "turn.failed" || e.type === "error")
          throw new Error(
            "Codex reported a failed turn; inspect provider locally",
          );
        if (e.type === "turn.completed") completed = true;
        if (e.type !== "item.completed") return;
        if (e.item === null || typeof e.item !== "object")
          throw new Error("missing Codex item");
        const item = e.item as Record<string, unknown>;
        if (item.type === "agent_message") {
          if (typeof item.text !== "string")
            throw new Error("invalid Codex agent message");
          emit({ type: "assistant_message", text: item.text });
        } else if (item.type === "command_execution") {
          if (typeof item.command !== "string")
            throw new Error("invalid Codex command result");
          emit({
            type: "command_execution",
            input: item.command,
            output:
              typeof item.aggregated_output === "string"
                ? item.aggregated_output
                : "",
            exitCode:
              typeof item.exit_code === "number" ? item.exit_code : null,
          });
        } else if (item.type === "file_change" && Array.isArray(item.changes)) {
          for (const change of item.changes) {
            if (
              change &&
              typeof change === "object" &&
              typeof change.path === "string"
            )
              emit({ type: "file_change", fileName: change.path });
          }
        }
        // Never import hidden reasoning or replay foreign native tool calls.
      },
    });
    if (!completed)
      throw new Error(
        "Codex exited without a completion acknowledgement; do not automatically retry",
      );
  }
}
