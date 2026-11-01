import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { JournalEvent, Run, Thread } from "./types.ts";
export function stable(value: unknown): string {
  const normalize = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(normalize);
    if (v !== null && typeof v === "object")
      return Object.fromEntries(
        Object.entries(v)
          .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
          .map(([k, x]) => [k, normalize(x)]),
      );
    return v;
  };
  return JSON.stringify(normalize(value));
}
export function text(value: unknown, name: string, max: number): string {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    Buffer.byteLength(value) > max ||
    value.includes("\0")
  )
    throw new Error(
      `${name} must be non-empty, NUL-free, and at most ${max} bytes`,
    );
  return value;
}
export function identifier(value: unknown): string {
  const id = text(value, "id", 128);
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.:-]*$/.test(id)) throw new Error("invalid id");
  return id;
}
export class Store {
  readonly db: DatabaseSync;
  constructor(directory: string) {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const file = path.join(directory, "coder.sqlite");
    this.db = new DatabaseSync(file);
    if (process.platform !== "win32") fs.chmodSync(file, 0o600);
    this.db.exec(
      "PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=3000;",
    );
    const version = Number(
      this.db.prepare("PRAGMA user_version").get()!.user_version,
    );
    if (version !== 0 && version !== 1 && version !== 2) {
      this.db.close();
      throw new Error("unsupported coder database version");
    }
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS threads(id TEXT PRIMARY KEY, body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS runs(id TEXT PRIMARY KEY, thread_id TEXT NOT NULL REFERENCES threads(id), ordinal INTEGER NOT NULL,
        status TEXT NOT NULL, body TEXT NOT NULL, UNIQUE(thread_id,ordinal));
      CREATE INDEX IF NOT EXISTS runs_by_thread ON runs(thread_id,ordinal);
      CREATE TABLE IF NOT EXISTS commands(id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, reply TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS events(sequence INTEGER PRIMARY KEY AUTOINCREMENT, thread_id TEXT NOT NULL REFERENCES threads(id),
        run_id TEXT, kind TEXT NOT NULL, payload TEXT NOT NULL, at TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS events_by_thread ON events(thread_id,sequence);
      CREATE TABLE IF NOT EXISTS runtime_requests(id TEXT PRIMARY KEY,thread_id TEXT NOT NULL REFERENCES threads(id),run_id TEXT NOT NULL REFERENCES runs(id),status TEXT NOT NULL,body TEXT NOT NULL);
      CREATE UNIQUE INDEX IF NOT EXISTS one_pending_request ON runtime_requests(run_id) WHERE status='pending';
      CREATE INDEX IF NOT EXISTS requests_by_thread ON runtime_requests(thread_id,status);
      CREATE INDEX IF NOT EXISTS item_identity ON events(thread_id,json_extract(payload,'$.id'),sequence) WHERE kind='item';
      PRAGMA user_version=2;
    `);
  }
  transaction<T>(operation: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = operation();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  command<T>(id: string, input: unknown, operation: () => T): T {
    identifier(id);
    const fingerprint = createHash("sha256")
      .update(stable(input))
      .digest("hex");
    return this.transaction(() => {
      const prior = this.db
        .prepare("SELECT fingerprint,reply FROM commands WHERE id=?")
        .get(id);
      if (prior) {
        if (prior.fingerprint !== fingerprint)
          throw new Error("command id already used with different input");
        return JSON.parse(String(prior.reply)) as T;
      }
      const reply = operation();
      this.db
        .prepare("INSERT INTO commands VALUES(?,?,?)")
        .run(id, fingerprint, JSON.stringify(reply));
      return reply;
    });
  }
  thread(id: string): Thread {
    const row = this.db.prepare("SELECT body FROM threads WHERE id=?").get(id);
    if (!row) throw new Error("unknown thread");
    return JSON.parse(String(row.body)) as Thread;
  }
  threads(): Thread[] {
    return this.db
      .prepare("SELECT body FROM threads ORDER BY id")
      .all()
      .map((row) => JSON.parse(String(row.body)) as Thread);
  }
  putThread(value: Thread): void {
    this.db
      .prepare(
        "INSERT INTO threads VALUES(?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body",
      )
      .run(value.id, JSON.stringify(value));
  }
  run(id: string): Run {
    const row = this.db.prepare("SELECT body FROM runs WHERE id=?").get(id);
    if (!row) throw new Error("unknown run");
    return JSON.parse(String(row.body)) as Run;
  }
  runs(threadId: string): Run[] {
    return this.db
      .prepare("SELECT body FROM runs WHERE thread_id=? ORDER BY ordinal")
      .all(threadId)
      .map((row) => JSON.parse(String(row.body)) as Run);
  }
  putRun(value: Run): void {
    this.db
      .prepare(
        "INSERT INTO runs VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET status=excluded.status,body=excluded.body",
      )
      .run(
        value.id,
        value.threadId,
        value.ordinal,
        value.status,
        JSON.stringify(value),
      );
  }
  event(
    threadId: string,
    runId: string | null,
    kind: string,
    payload: unknown,
  ): number {
    return Number(
      this.db
        .prepare(
          "INSERT INTO events(thread_id,run_id,kind,payload,at) VALUES(?,?,?,?,?)",
        )
        .run(
          threadId,
          runId,
          kind,
          JSON.stringify(payload),
          new Date().toISOString(),
        ).lastInsertRowid,
    );
  }
  events(threadId: string, after = 0, limit = 100): JournalEvent[] {
    this.thread(threadId);
    if (
      !Number.isSafeInteger(after) ||
      after < 0 ||
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > 500
    )
      throw new Error("invalid event cursor/limit");
    return this.db
      .prepare(
        "SELECT * FROM events WHERE thread_id=? AND sequence>? ORDER BY sequence LIMIT ?",
      )
      .all(threadId, after, limit)
      .map((row) => ({
        sequence: Number(row.sequence),
        threadId: String(row.thread_id),
        runId: row.run_id === null ? null : String(row.run_id),
        kind: String(row.kind),
        payload: JSON.parse(String(row.payload)),
        at: String(row.at),
      }));
  }
  close(): void {
    this.db.close();
  }
}
