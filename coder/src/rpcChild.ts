import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import path from "node:path";
export type RpcId = string | number;
export type RpcEnvelope =
  | { id: RpcId; method: string; params?: unknown }
  | { method: string; params?: unknown }
  | { id: RpcId; result: unknown }
  | { id: RpcId; error: { code: number; message: string; data?: unknown } };
export class RpcFault extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
  }
}
const idKey = (id: RpcId) => `${typeof id}:${id}`;
export function rpcId(value: unknown): value is RpcId {
  return (
    (typeof value === "number" && Number.isSafeInteger(value)) ||
    (typeof value === "string" && value.length > 0 && value.length <= 256)
  );
}
export function envelope(raw: unknown): RpcEnvelope {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw))
    throw new Error("Invalid RPC envelope");
  const r = raw as Record<string, unknown>;
  if (r.jsonrpc !== undefined && r.jsonrpc !== "2.0")
    throw new Error("Unsupported RPC version");
  const hasId = Object.hasOwn(r, "id"),
    method = Object.hasOwn(r, "method"),
    result = Object.hasOwn(r, "result"),
    error = Object.hasOwn(r, "error");
  if (hasId && !rpcId(r.id)) throw new Error("Invalid RPC id");
  if (method) {
    if (
      typeof r.method !== "string" ||
      !r.method.length ||
      r.method.length > 256 ||
      result ||
      error
    )
      throw new Error("Invalid RPC method envelope");
    return r as RpcEnvelope;
  }
  if (!hasId || result === error)
    throw new Error("Invalid RPC response envelope");
  if (error) {
    const e = r.error as Record<string, unknown> | null;
    if (
      !e ||
      Array.isArray(e) ||
      typeof e !== "object" ||
      !Number.isSafeInteger(e.code) ||
      typeof e.message !== "string"
    )
      throw new Error("Invalid RPC error");
  }
  return r as RpcEnvelope;
}
export interface RpcChildOptions {
  binary: string;
  args: readonly string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
  maxLineBytes?: number;
  maxOutputBytes?: number;
  requestTimeoutMs?: number;
  onNotification?: (method: string, params: unknown) => void;
  onRequest?: (
    method: string,
    params: unknown,
    id: RpcId,
    signal: AbortSignal,
  ) => Promise<unknown>;
}
/** Bounded bidirectional stdio. Never retries requests or logs protocol/stderr payloads. */
export class RpcChild {
  readonly child: ChildProcessWithoutNullStreams;
  readonly closed: Promise<Error | null>;
  private finishClosed!: (error: Error | null) => void;
  private failure: Error | null = null;
  private stopping = false;
  private ended = false;
  private next = 0;
  private pending = new Map<
    string,
    {
      resolve: (v: unknown) => void;
      reject: (e: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  private serving = new Map<string, AbortController>();
  private seenRequests = new Set<string>();
  private decoder = new StringDecoder("utf8");
  private buffered = "";
  private output = 0;
  private stderr = 0;
  private killTimer: ReturnType<typeof setTimeout> | undefined;
  private hardKillTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly maxLine: number;
  private readonly maxOutput: number;
  constructor(private readonly options: RpcChildOptions) {
    if (
      !path.isAbsolute(options.binary) ||
      /\.(cmd|bat|ps1)$/i.test(options.binary)
    )
      throw new Error("RPC requires an absolute native executable");
    this.maxLine = options.maxLineBytes ?? 1024 * 1024;
    this.maxOutput = options.maxOutputBytes ?? 8 * 1024 * 1024;
    for (const n of [this.maxLine, this.maxOutput])
      if (!Number.isSafeInteger(n) || n < 64 || n > 32 * 1024 * 1024)
        throw new Error("Invalid RPC byte limits");
    this.closed = new Promise((resolve) => {
      this.finishClosed = resolve;
    });
    this.child = spawn(options.binary, [...options.args], {
      cwd: options.cwd,
      env: options.env ?? process.env,
      stdio: ["pipe", "pipe", "pipe"],
      shell: false,
      windowsHide: true,
    });
    this.child.on("error", () =>
      this.fail(new Error("Native RPC process could not start")),
    );
    this.child.stdin.on("error", () => {
      if (!this.stopping)
        this.fail(new Error("Native RPC input closed unexpectedly"));
    });
    this.child.stdout.on("data", (chunk: Buffer) => {
      if (this.stopping) return;
      this.output += chunk.length;
      if (this.output > this.maxOutput) {
        this.fail(new Error("Native RPC output budget exceeded"));
        return;
      }
      this.buffered += this.decoder.write(chunk);
      let pos: number;
      while ((pos = this.buffered.indexOf("\n")) >= 0) {
        const line = this.buffered.slice(0, pos);
        this.buffered = this.buffered.slice(pos + 1);
        this.line(line);
        if (this.stopping) return;
      }
      if (Buffer.byteLength(this.buffered) > this.maxLine)
        this.fail(new Error("Native RPC line budget exceeded"));
    });
    this.child.stderr.on("data", (chunk: Buffer) => {
      this.stderr += chunk.length;
      if (this.stderr > 64 * 1024)
        this.fail(new Error("Native RPC stderr budget exceeded"));
    });
    this.child.on("exit", () => {
      if (this.stopping) {
        this.child.stdout.destroy();
        this.child.stderr.destroy();
      }
    });
    this.child.on("close", () => {
      if (!this.stopping) {
        this.failure ??= new Error(
          "Native RPC process exited before client shutdown",
        );
        this.stopping = true;
        this.rejectAll(this.failure);
      }
      this.ended = true;
      clearTimeout(this.killTimer);
      clearTimeout(this.hardKillTimer);
      this.finishClosed(this.failure);
    });
  }
  private rejectAll(error: Error) {
    for (const request of this.pending.values()) {
      clearTimeout(request.timer);
      request.reject(error);
    }
    this.pending.clear();
    for (const c of this.serving.values()) c.abort();
  }
  fail(error: Error): void {
    if (this.stopping) return;
    this.failure = error;
    this.stop();
  }
  private stop() {
    if (this.stopping) return;
    this.stopping = true;
    this.rejectAll(this.failure ?? new Error("RPC client closed"));
    this.child.stdin.end();
    this.killTimer = setTimeout(() => {
      this.child.kill();
      this.child.stdout.destroy();
      this.child.stderr.destroy();
    }, 1500);
    this.hardKillTimer = setTimeout(() => this.child.kill("SIGKILL"), 2500);
    this.killTimer.unref();
    this.hardKillTimer.unref();
  }
  async close(): Promise<void> {
    this.stop();
    await this.closed;
  }
  cancelServerRequest(id: RpcId): void {
    this.serving.get(idKey(id))?.abort();
  }
  cancelAllServerRequests(): void {
    for (const c of this.serving.values()) c.abort();
  }
  private write(value: unknown) {
    if (this.stopping || this.ended)
      throw this.failure ?? new Error("RPC client is closed");
    const line = JSON.stringify(value) + "\n";
    if (
      Buffer.byteLength(line) > this.maxLine ||
      this.child.stdin.writableLength > this.maxLine
    )
      throw new Error("Native RPC input budget exceeded");
    this.child.stdin.write(line);
  }
  notify(method: string, params?: unknown): void {
    this.write({ method, ...(params !== undefined ? { params } : {}) });
  }
  request(
    method: string,
    params?: unknown,
    timeoutMs = this.options.requestTimeoutMs ?? 15000,
  ): Promise<unknown> {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 600000)
      return Promise.reject(new Error("Invalid RPC deadline"));
    if (this.pending.size >= 16)
      return Promise.reject(
        new Error("Too many outstanding native RPC requests"),
      );
    const id = "vims-" + ++this.next;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(idKey(id));
        const error = new Error(
          `Native RPC ${method} timed out; submission may be uncertain, never auto-retry`,
        );
        reject(error);
        this.fail(error);
      }, timeoutMs);
      timer.unref();
      this.pending.set(idKey(id), { resolve, reject, timer });
      try {
        this.write({ id, method, ...(params !== undefined ? { params } : {}) });
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(idKey(id));
        reject(error as Error);
        this.fail(error as Error);
      }
    });
  }
  private line(line: string) {
    if (!line.trim()) return;
    if (Buffer.byteLength(line) > this.maxLine) {
      this.fail(new Error("Native RPC line budget exceeded"));
      return;
    }
    try {
      const message = envelope(JSON.parse(line));
      if ("method" in message) {
        if ("id" in message) {
          const key = idKey(message.id);
          if (this.seenRequests.has(key))
            throw new Error("Duplicate native server request id");
          if (this.seenRequests.size >= 256 || this.serving.size >= 16)
            throw new Error("Native server request budget exceeded");
          this.seenRequests.add(key);
          const controller = new AbortController();
          this.serving.set(key, controller);
          void Promise.resolve()
            .then(() => {
              if (controller.signal.aborted)
                throw new RpcFault(-32800, "Request no longer active");
              if (!this.options.onRequest)
                throw new RpcFault(-32601, "Method not supported");
              return this.options.onRequest(
                message.method,
                message.params,
                message.id,
                controller.signal,
              );
            })
            .then((result) => {
              if (!controller.signal.aborted && !this.stopping)
                this.write({ id: message.id, result: result ?? null });
            })
            .catch((error) => {
              if (controller.signal.aborted || this.stopping) return;
              try {
                this.write({
                  id: message.id,
                  error: {
                    code: error instanceof RpcFault ? error.code : -32603,
                    message:
                      error instanceof RpcFault
                        ? error.message
                        : "Native request rejected by VIMS",
                  },
                });
              } catch (writeError) {
                this.fail(writeError as Error);
              }
            })
            .finally(() => this.serving.delete(key));
        } else this.options.onNotification?.(message.method, message.params);
      } else {
        const request = this.pending.get(idKey(message.id));
        if (!request) throw new Error("Unexpected native RPC response id");
        this.pending.delete(idKey(message.id));
        clearTimeout(request.timer);
        if ("error" in message)
          request.reject(
            new RpcFault(
              message.error.code,
              `Native RPC request failed (code ${message.error.code}); provider details withheld`,
            ),
          );
        else request.resolve(message.result);
      }
    } catch {
      this.fail(new Error("Malformed or unexpected native RPC message"));
    }
  }
}
