import http from "node:http";
import {
  createHash,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import { once } from "node:events";
import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { AddressInfo } from "node:net";
import type { CoderCore } from "./core.ts";
import { identifier, text } from "./store.ts";
import type { Run, Thread } from "./types.ts";
import type { RuntimeResponseInput } from "./requestTypes.ts";
export interface WorkbenchProject {
  id: string;
  name: string;
  repository: string;
}
export interface WorkbenchProfile {
  id: string;
  name: string;
  driverId: string;
  model: string;
}
export interface WorkbenchOptions {
  core: CoderCore;
  projects: readonly WorkbenchProject[];
  profiles: readonly WorkbenchProfile[];
  port?: number;
  label?: string;
  fixtureMode?: boolean;
}
class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}
const object = (raw: unknown) => {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw))
    throw new HttpError(400, "Expected a JSON object");
  return raw as Record<string, unknown>;
};
const only = (value: object, allowed: readonly string[]) => {
  if (Object.keys(value).some((key) => !allowed.includes(key)))
    throw new HttpError(400, "Unexpected command field");
};
const integer = (
  value: unknown,
  name: string,
  min = 0,
  max = Number.MAX_SAFE_INTEGER,
) => {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < min ||
    value > max
  )
    throw new HttpError(400, `Invalid ${name}`);
  return value;
};
function body(request: http.IncomingMessage): Promise<unknown> {
  if (
    !/^application\/json(?:\s*;|$)/i.test(request.headers["content-type"] ?? "")
  )
    throw new HttpError(415, "Use application/json");
  const maximum = 65536;
  if (Number(request.headers["content-length"] ?? 0) > maximum)
    throw new HttpError(413, "Command exceeds 64 KiB");
  return new Promise((resolve, reject) => {
    const parts: Buffer[] = [];
    let size = 0;
    let settled = false;
    request.on("data", (part: Buffer) => {
      if (settled) return;
      size += part.length;
      if (size > maximum) {
        settled = true;
        reject(new HttpError(413, "Command exceeds 64 KiB"));
        return;
      }
      parts.push(part);
    });
    request.on("error", () => {
      if (!settled) {
        settled = true;
        reject(new HttpError(400, "Interrupted request body"));
      }
    });
    request.on("end", () => {
      if (settled) return;
      settled = true;
      try {
        resolve(JSON.parse(Buffer.concat(parts).toString("utf8")));
      } catch {
        reject(new HttpError(400, "Invalid JSON"));
      }
    });
  });
}
/** Explicitly launched, authenticated loopback-only workbench. Never a public/remote server. */
export async function startWorkbench(options: WorkbenchOptions) {
  const { core } = options;
  const projects = new Map<string, WorkbenchProject>();
  const profiles = new Map<string, WorkbenchProfile>();
  if (
    options.projects.length < 1 ||
    options.projects.length > 32 ||
    options.profiles.length < 1 ||
    options.profiles.length > 32
  )
    throw new Error("Configure 1ΓÇô32 projects and profiles");
  for (const project of options.projects) {
    identifier(project.id);
    text(project.name, "project name", 128);
    if (projects.has(project.id)) throw new Error("duplicate project id");
    projects.set(project.id, {
      ...project,
      repository: await core.workspaces.repository(project.repository),
    });
  }
  for (const profile of options.profiles) {
    identifier(profile.id);
    identifier(profile.driverId);
    text(profile.name, "profile name", 128);
    text(profile.model, "model", 256);
    if (profiles.has(profile.id)) throw new Error("duplicate profile id");
    profiles.set(profile.id, { ...profile });
  }
  const token = randomBytes(32).toString("base64url");
  const digest = createHash("sha256")
    .update("Bearer " + token)
    .digest();
  const executions = new Map<string, Promise<Run | null>>();
  const executionRuns = new Map<string, string>();
  let closing = false;
  let origin = "";
  let host = "";
  const distAssets = fileURLToPath(new URL("./workbench/", import.meta.url));
  const assets = existsSync(distAssets)
    ? distAssets
    : fileURLToPath(new URL("../web/", import.meta.url));
  const t3 = fileURLToPath(new URL("./t3/", import.meta.url));
  const staticFiles = new Map<string, { file: string; type: string }>([
    [
      "/",
      {
        file: path.join(assets, "index.html"),
        type: "text/html; charset=utf-8",
      },
    ],
    [
      "/app.js",
      {
        file: path.join(assets, "app.js"),
        type: "text/javascript; charset=utf-8",
      },
    ],
    [
      "/style.css",
      { file: path.join(assets, "style.css"), type: "text/css; charset=utf-8" },
    ],
    ...["pendingUserInput", "pendingUserInputProgress", "queuedRunEdit"].map(
      (name) =>
        [
          "/t3/" + name + ".js",
          {
            file: path.join(t3, name + ".js"),
            type: "text/javascript; charset=utf-8",
          },
        ] as [string, { file: string; type: string }],
    ),
  ]);
  const allowedThread = (id: string): Thread => {
    identifier(id);
    const thread = core.store.thread(id);
    if (
      ![...projects.values()].some(
        (project) => project.repository === thread.repository,
      )
    )
      throw new HttpError(403, "Project is not available in this workbench");
    return thread;
  };
  const allowedRun = (id: string): Run => {
    identifier(id);
    const run = core.store.run(id);
    allowedThread(run.threadId);
    return run;
  };
  const allowedExecutable = (run: Run) => {
    if (
      ![...profiles.values()].some(
        (profile) =>
          profile.driverId === run.providerInstanceId &&
          profile.model === run.modelSelection.model,
      )
    )
      throw new HttpError(
        403,
        "Task provider/model is not permitted by this workbench",
      );
  };
  const profile = (id: unknown) => {
    const p = profiles.get(identifier(id));
    if (!p) throw new HttpError(400, "Unknown provider profile");
    return p;
  };
  const json = (res: http.ServerResponse, status: number, value: unknown) => {
    const encoded = JSON.stringify(value);
    if (Buffer.byteLength(encoded) > 2 * 1024 * 1024)
      throw new HttpError(413, "Result too large; use paged history");
    res.writeHead(status, {
      "content-type": "application/json; charset=utf-8",
    });
    res.end(encoded);
  };
  const server = http.createServer(
    { maxHeaderSize: 8192, requestTimeout: 15000, headersTimeout: 10000 },
    (req, res) => {
      res.setHeader("Cache-Control", "no-store");
      res.setHeader("X-Content-Type-Options", "nosniff");
      res.setHeader("Referrer-Policy", "no-referrer");
      res.setHeader(
        "Content-Security-Policy",
        "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'; object-src 'none'",
      );
      const route = async () => {
        if (closing) throw new HttpError(503, "Workbench is closing");
        if (req.headers.host !== host)
          throw new HttpError(403, "Unexpected Host");
        if (req.headers.origin !== undefined && req.headers.origin !== origin)
          throw new HttpError(403, "Cross-origin access is not allowed");
        if (req.headers["sec-fetch-site"] === "cross-site")
          throw new HttpError(403, "Cross-site access is not allowed");
        if (
          !req.url?.startsWith("/") ||
          req.url.startsWith("//") ||
          req.url.includes("\\") ||
          req.url.length > 4096
        )
          throw new HttpError(400, "Invalid request target");
        const url = new URL(req.url, origin);
        const staticFile = staticFiles.get(url.pathname);
        if (req.method === "GET" && staticFile) {
          const data = await fs.readFile(staticFile.file);
          res.writeHead(200, { "content-type": staticFile.type });
          res.end(data);
          return;
        }
        if (!url.pathname.startsWith("/api/"))
          throw new HttpError(404, "Not found");
        const provided = createHash("sha256")
          .update(req.headers.authorization ?? "")
          .digest();
        if (!timingSafeEqual(provided, digest))
          throw new HttpError(401, "Workbench token required");
        if (req.method === "GET" && url.pathname === "/api/state") {
          const permitted = new Set(
            [...projects.values()].map((project) => project.repository),
          );
          const inbox = core.inbox();
          const threads = core.store
            .threads()
            .filter((thread) => permitted.has(thread.repository));
          const allowed = new Set(threads.map((thread) => thread.id));
          const summaries = threads.slice(-200).map((thread) => ({
            id: thread.id,
            title: thread.title,
            updatedAt: thread.updatedAt,
            projectId: [...projects.values()].find(
              (p) => p.repository === thread.repository,
            )!.id,
            forkedFrom: thread.forkedFrom
              ? {
                  threadId: thread.forkedFrom.threadId,
                  phase: thread.forkedFrom.phase,
                }
              : null,
          }));
          json(res, 200, {
            label: options.label ?? "VIMS Native Workbench",
            fixtureMode: options.fixtureMode === true,
            projects: [...projects.values()].map(({ id, name }) => ({
              id,
              name,
            })),
            profiles: [...profiles.values()],
            capabilities: core
              .capabilities()
              .filter((capability) =>
                [...profiles.values()].some(
                  (profile) => profile.driverId === capability.driverId,
                ),
              ),
            threads: summaries,
            truncated: threads.length > 200,
            inbox: {
              working: inbox.working
                .filter((t) => allowed.has(t.id))
                .map((t) => t.id),
              attention: inbox.attention
                .filter((t) => allowed.has(t.id))
                .map((t) => t.id),
            },
          });
          return;
        }
        const match =
          /^\/api\/threads\/([A-Za-z0-9_.:-]+)(?:\/(events|history))?$/.exec(
            url.pathname,
          );
        if (req.method === "GET" && match) {
          const thread = allowedThread(match[1]!);
          if (match[2] === "events") {
            const after = integer(
              Number(url.searchParams.get("after") ?? 0),
              "event cursor",
            );
            const events = core.store.events(thread.id, after, 100);
            const selected: unknown[] = [];
            let total = 0;
            let next = after;
            for (const event of events) {
              const payload = event.payload as Record<string, unknown>;
              const entry = {
                sequence: event.sequence,
                runId: event.runId,
                kind: event.kind,
                at: event.at,
                item:
                  event.kind === "item"
                    ? {
                        id: payload.id,
                        type: payload.type,
                        text: String(
                          payload.text ??
                            payload.markdown ??
                            payload.output ??
                            payload.fileName ??
                            "",
                        ).slice(0, 16000),
                        input:
                          typeof payload.input === "string"
                            ? payload.input.slice(0, 4000)
                            : undefined,
                        truncated:
                          Buffer.byteLength(JSON.stringify(payload)) > 16000,
                      }
                    : null,
                summary:
                  event.kind === "item"
                    ? undefined
                    : JSON.stringify(event.payload).slice(0, 1000),
              };
              const size = Buffer.byteLength(JSON.stringify(entry));
              if (total + size > 512 * 1024 && selected.length) break;
              total += size;
              selected.push(entry);
              next = event.sequence;
            }
            json(res, 200, {
              events: selected,
              nextCursor: next,
              hasMore: selected.length < events.length || events.length === 100,
            });
            return;
          }
          if (match[2] === "history") {
            const optional = (key: string) =>
              url.searchParams.has(key)
                ? integer(Number(url.searchParams.get(key)), key)
                : undefined;
            json(
              res,
              200,
              core.vims_thread_read({
                threadId: thread.id,
                afterPosition: optional("after"),
                itemId: url.searchParams.get("itemId") ?? undefined,
                textOffset: optional("offset"),
                throughSequence: optional("throughSequence"),
                maxOrdinal: optional("maxOrdinal"),
                limit: 50,
                maxCharsPerItem: 4000,
              }),
            );
            return;
          }
          const runs = core.store.runs(thread.id);
          json(res, 200, {
            thread,
            runs: runs.slice(-50),
            olderRunsOmitted: Math.max(0, runs.length - 50),
            requests: core.requests.pending(thread.id),
            progress: core.workspaceProgress(thread.id),
          });
          return;
        }
        const review = /^\/api\/runs\/([A-Za-z0-9_.:-]+)\/(review|patch)$/.exec(
          url.pathname,
        );
        if (req.method === "GET" && review) {
          const run = allowedRun(review[1]!);
          const result = await core.review(run.id);
          if (review[2] === "patch") {
            res.writeHead(200, {
              "content-type": "text/x-diff; charset=utf-8",
              "content-disposition": `attachment; filename="vims-${run.id}.patch"`,
            });
            res.end(result.patch);
            return;
          }
          json(res, 200, {
            ...result,
            patch: result.patch.slice(0, 131072),
            patchTruncated: result.patch.length > 131072,
          });
          return;
        }
        if (req.method !== "POST" || url.pathname !== "/api/command")
          throw new HttpError(
            req.method === "GET" ? 404 : 405,
            "Unsupported route or method",
          );
        const command = object(await body(req));
        const kind = text(command.type, "command type", 64);
        const commandId = identifier(command.commandId);
        let result: unknown;
        switch (kind) {
          case "thread.create": {
            only(command, ["type", "commandId", "projectId", "title"]);
            const p = projects.get(identifier(command.projectId));
            if (!p) throw new HttpError(403, "Unknown project");
            result = await core.createThread(commandId, {
              repository: p.repository,
              title: text(command.title, "title", 256),
            });
            break;
          }
          case "run.queue": {
            only(command, [
              "type",
              "commandId",
              "threadId",
              "profileId",
              "prompt",
            ]);
            const t = allowedThread(identifier(command.threadId));
            const p = profile(command.profileId);
            result = core.queue(commandId, {
              threadId: t.id,
              driverId: p.driverId,
              model: p.model,
              prompt: text(command.prompt, "prompt", 32768),
            });
            break;
          }
          case "run.edit": {
            only(command, [
              "type",
              "commandId",
              "runId",
              "revision",
              "profileId",
              "prompt",
            ]);
            const r = allowedRun(identifier(command.runId));
            const p = profile(command.profileId);
            result = core.editQueued(
              commandId,
              r.id,
              integer(command.revision, "revision", 1),
              {
                prompt: text(command.prompt, "prompt", 32768),
                driverId: p.driverId,
                model: p.model,
              },
            );
            break;
          }
          case "run.approve": {
            only(command, ["type", "commandId", "runId", "revision"]);
            const r = allowedRun(identifier(command.runId));
            allowedExecutable(r);
            result = core.approve(
              commandId,
              r.id,
              integer(command.revision, "revision", 1),
            );
            break;
          }
          case "run.cancel": {
            only(command, ["type", "commandId", "runId"]);
            const r = allowedRun(identifier(command.runId));
            result = core.cancel(commandId, r.id);
            break;
          }
          case "queue.reorder": {
            only(command, ["type", "commandId", "threadId", "runIds"]);
            const t = allowedThread(identifier(command.threadId));
            if (!Array.isArray(command.runIds) || command.runIds.length > 200)
              throw new HttpError(400, "Invalid queue order");
            const ids = command.runIds.map(identifier);
            for (const id of ids) {
              if (allowedRun(id).threadId !== t.id)
                throw new HttpError(400, "Run belongs to another thread");
            }
            result = core.reorder(commandId, t.id, ids);
            break;
          }
          case "run.execute": {
            only(command, ["type", "commandId", "threadId"]);
            const t = allowedThread(identifier(command.threadId));
            for (const run of core.store.runs(t.id))
              if (run.status === "queued") allowedExecutable(run);
            if (executions.size >= 16 && !executions.has(commandId))
              throw new HttpError(429, "Too many active workbench executions");
            const admission = core.dispatchNext(t.id, commandId);
            if (admission.admitted && !executions.has(commandId)) {
              executions.set(commandId, admission.completion);
              executionRuns.set(commandId, admission.runId!);
              void admission.completion
                .finally(() => {
                  executions.delete(commandId);
                  executionRuns.delete(commandId);
                })
                .catch(() => {});
            }
            json(res, 202, { runId: admission.runId });
            return;
          }
          case "thread.fork": {
            only(command, ["type", "commandId", "runId", "phase", "title"]);
            const r = allowedRun(identifier(command.runId));
            if (command.phase !== "before" && command.phase !== "after")
              throw new HttpError(400, "Invalid fork phase");
            result = await core.forkThread(commandId, {
              runId: r.id,
              phase: command.phase,
              title: text(command.title, "title", 256),
            });
            break;
          }
          case "request.respond": {
            only(command, [
              "type",
              "commandId",
              "requestId",
              "digest",
              "response",
            ]);
            const id = identifier(command.requestId);
            const request = core.requests.get(id);
            allowedThread(request.threadId);
            result = core.respond(
              commandId,
              id,
              text(command.digest, "request digest", 64),
              object(command.response) as RuntimeResponseInput,
            );
            break;
          }
          default:
            throw new HttpError(400, "Unknown command");
        }
        json(res, 200, result);
      };
      void route().catch((error) => {
        if (res.headersSent) {
          res.destroy();
          return;
        }
        const status =
          error instanceof HttpError
            ? error.status
            : (error as NodeJS.ErrnoException).code === "ENOENT"
              ? 404
              : 409;
        res.setHeader("Connection", "close");
        json(res, status, {
          error:
            error instanceof HttpError
              ? error.message
              : error instanceof Error
                ? error.message.slice(0, 1000)
                : "Command failed",
        });
      });
    },
  );
  server.maxConnections = 64;
  server.keepAliveTimeout = 2000;
  const port = options.port ?? 0;
  if (!Number.isSafeInteger(port) || port < 0 || port > 65535)
    throw new Error("Invalid port");
  server.listen(port, "127.0.0.1");
  await once(server, "listening");
  const address = server.address() as AddressInfo;
  host = `127.0.0.1:${address.port}`;
  origin = "http://" + host;
  return {
    url: origin,
    token,
    async close() {
      if (closing) return;
      closing = true;
      const closed = new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
      server.closeIdleConnections();
      for (const runId of new Set(executionRuns.values())) {
        const run = core.store.run(runId);
        if (
          ["preparing", "running", "blocked", "cancel_requested"].includes(
            run.status,
          )
        )
          core.cancel("shutdown-" + randomUUID(), runId);
      }
      await Promise.allSettled([...executions.values()]);
      server.closeAllConnections();
      await closed;
    },
  };
}
