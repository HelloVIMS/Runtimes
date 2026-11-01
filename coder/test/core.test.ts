import { describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import { CoderCore } from "../src/core.ts";
import type { NativeDriver, NativeTurn } from "../src/types.ts";
import { fixture, git, deferred } from "./fixtures.ts";
const driver = (id: string, run: NativeDriver["run"]): NativeDriver => ({
  id,
  contextMode: "portable",
  run,
});
async function queued(
  core: CoderCore,
  repo: string,
  id = "a",
  provider = "writer",
) {
  const thread = await core.createThread("thread-" + id, {
    repository: repo,
    title: "Native task " + id,
  });
  const run = core.queue("queue-" + id, {
    threadId: thread.id,
    driverId: provider,
    model: "fixture",
    prompt: "Make one isolated change. Do not deploy.",
  });
  return { thread, run };
}
describe("native task ownership and persistence", () => {
  it("requires approval, executes independently of T3, and reviews real checkpoints", async () => {
    let calls = 0;
    const f = await fixture([
      driver("writer", async (turn, emit) => {
        calls++;
        await fs.writeFile(path.join(turn.cwd, "code.txt"), "native result\n");
        await fs.writeFile(path.join(turn.cwd, "new.txt"), "added\n");
        await fs.writeFile(
          path.join(turn.cwd, "credentials.secret"),
          "ignored-secret",
        );
        emit({
          type: "assistant_message",
          text: "Changed code and added a file.",
        });
      }),
    ]);
    try {
      // A dirty primary checkout and its index must remain untouched.
      await fs.writeFile(path.join(f.repo, "code.txt"), "owner staged work\n");
      git(f.repo, "add", "code.txt");
      const originalIndex = git(f.repo, "diff", "--cached", "--binary");
      const { thread, run } = await queued(f.core, f.repo);
      expect(f.core.inbox().attention[0]?.hasPendingApprovals).toBe(true);
      expect(await f.core.executeNext(thread.id)).toBeNull();
      expect(calls).toBe(0);
      f.core.approve("approve-a", run.id);
      const completed = await f.core.executeNext(thread.id);
      expect(completed?.status).toBe("completed");
      expect(calls).toBe(1);
      const review = await f.core.review(run.id);
      expect(review.files.map((file) => file.path)).toEqual([
        "code.txt",
        "new.txt",
      ]);
      expect(review.patch).toContain("+native result");
      expect(review.patch).not.toContain("ignored-secret");
      expect(await fs.readFile(path.join(f.repo, "code.txt"), "utf8")).toBe(
        "owner staged work\n",
      );
      expect(git(f.repo, "diff", "--cached", "--binary")).toBe(originalIndex);
      expect(await f.core.executeNext(thread.id)).toBeNull();
      expect(f.core.liveBatch(thread.id).length).toBeGreaterThan(0);
    } finally {
      await f.cleanup();
    }
  });
  it("replays command receipts across restart without re-running a task", async () => {
    let calls = 0;
    const d = driver("writer", async () => {
      calls++;
    });
    const f = await fixture([d]);
    let reopened: CoderCore | undefined;
    try {
      const { thread, run } = await queued(f.core, f.repo);
      const same = f.core.queue("queue-a", {
        threadId: thread.id,
        driverId: "writer",
        model: "fixture",
        prompt: "Make one isolated change. Do not deploy.",
      });
      expect(same.id).toBe(run.id);
      expect(() =>
        f.core.queue("queue-a", {
          threadId: thread.id,
          driverId: "writer",
          model: "fixture",
          prompt: "changed",
        }),
      ).toThrow("different input");
      f.core.approve("approve-a", run.id);
      await f.core.executeNext(thread.id);
      f.core.close();
      reopened = new CoderCore(f.state, [d]);
      expect(reopened.store.run(run.id).status).toBe("completed");
      expect(await reopened.executeNext(thread.id)).toBeNull();
      expect(calls).toBe(1);
      const replay = reopened.queue("queue-a", {
        threadId: thread.id,
        driverId: "writer",
        model: "fixture",
        prompt: "Make one isolated change. Do not deploy.",
      });
      expect(replay.id).toBe(run.id);
      expect(calls).toBe(1);
    } finally {
      reopened?.close();
      if (!reopened) f.core.close();
      await fs.rm(f.root, { recursive: true, force: true });
    }
  });
  it("does not double-dispatch concurrent requests and exposes stop state", async () => {
    const entered = deferred();
    let calls = 0;
    const f = await fixture([
      driver("writer", async (_turn, _emit, signal) => {
        calls++;
        entered.resolve();
        await new Promise<void>((resolve) =>
          signal.addEventListener("abort", () => resolve(), { once: true }),
        );
      }),
    ]);
    try {
      const { thread, run } = await queued(f.core, f.repo);
      f.core.approve("approve-a", run.id);
      const executing = f.core.executeNext(thread.id);
      await entered.promise;
      expect(f.core.inbox().working[0]?.id).toBe(thread.id);
      expect(() => f.core.close()).toThrow("active");
      expect(await f.core.executeNext(thread.id)).toBeNull();
      expect(f.core.cancel("cancel-a", run.id).status).toBe("cancel_requested");
      expect((await executing)?.status).toBe("cancelled");
      expect(calls).toBe(1);
    } finally {
      await f.cleanup();
    }
  });
  it("serializes admission across two independent cores sharing the database", async () => {
    const entered = deferred();
    const release = deferred();
    let calls = 0;
    const d = driver("writer", async () => {
      calls++;
      entered.resolve();
      await release.promise;
    });
    const f = await fixture([d]);
    const second = new CoderCore(f.state, [d]);
    try {
      const { thread, run } = await queued(f.core, f.repo);
      f.core.approve("approve", run.id);
      const executing = f.core.executeNext(thread.id);
      await entered.promise;
      expect(await second.executeNext(thread.id)).toBeNull();
      expect(calls).toBe(1);
      release.resolve();
      expect((await executing)?.status).toBe("completed");
      expect(second.store.run(run.id).status).toBe("completed");
    } finally {
      release.resolve();
      second.close();
      await f.cleanup();
    }
  });
  it("persists uncertain running state and never automatically retries after restart", async () => {
    let calls = 0;
    const d = driver("writer", async () => {
      calls++;
    });
    const f = await fixture([d]);
    let reopened: CoderCore | undefined;
    try {
      const { thread, run } = await queued(f.core, f.repo);
      f.core.approve("approve-a", run.id);
      // Represent a process that persisted admission and vanished before recording its outcome.
      f.core.store.transaction(() =>
        f.core.store.putRun({
          ...f.core.store.run(run.id),
          status: "running",
          startedAt: new Date().toISOString(),
        }),
      );
      f.core.close();
      reopened = new CoderCore(f.state, [d]);
      expect(await reopened.executeNext(thread.id)).toBeNull();
      expect(calls).toBe(0);
      expect(() =>
        reopened!.reconcileInterrupted("recover", run.id, false),
      ).toThrow("confirmed stopped");
      expect(
        reopened.reconcileInterrupted("recover", run.id, true).status,
      ).toBe("interrupted");
      expect(await reopened.executeNext(thread.id)).toBeNull();
      expect(calls).toBe(0);
    } finally {
      reopened?.close();
      if (!reopened) f.core.close();
      await fs.rm(f.root, { recursive: true, force: true });
    }
  });
  it("uses copied T3 queue priority with explicit user reordering", async () => {
    const seen: string[] = [];
    const f = await fixture([
      driver("writer", async (turn) => {
        seen.push(turn.prompt);
      }),
    ]);
    try {
      const thread = await f.core.createThread("thread", {
        repository: f.repo,
        title: "queue",
      });
      const a = f.core.queue("a", {
        threadId: thread.id,
        driverId: "writer",
        model: "fixture",
        prompt: "first",
      });
      const b = f.core.queue("b", {
        threadId: thread.id,
        driverId: "writer",
        model: "fixture",
        prompt: "second",
      });
      const c = f.core.queue("c", {
        threadId: thread.id,
        driverId: "writer",
        model: "fixture",
        prompt: "child completion",
        automaticCompletion: true,
      });
      f.core.reorder("reorder", thread.id, [b.id, a.id, c.id]);
      for (const run of [a, b, c]) f.core.approve("approve-" + run.id, run.id);
      await f.core.executeNext(thread.id);
      await f.core.executeNext(thread.id);
      await f.core.executeNext(thread.id);
      expect(seen).toEqual(["child completion", "second", "first"]);
      expect(() => f.core.reorder("invalid", thread.id, [a.id])).toThrow(
        "every pending",
      );
    } finally {
      await f.cleanup();
    }
  });
  it("uses copied T3 portable history across two native providers with recoverable omitted text", async () => {
    let received: NativeTurn | undefined;
    const f = await fixture([
      driver("researcher", async (_turn, emit) =>
        emit({
          type: "assistant_message",
          text:
            "Evidence A. Keep the project offline. " + "detail ".repeat(2500),
        }),
      ),
      driver("builder", async (turn, emit) => {
        received = turn;
        emit({ type: "assistant_message", text: "Implemented from research." });
      }),
    ]);
    try {
      const { thread, run } = await queued(f.core, f.repo, "a", "researcher");
      f.core.approve("approve-a", run.id);
      await f.core.executeNext(thread.id);
      expect(
        f.core.handoffPreview(thread.id, "builder", "fixture")?.to.instanceId,
      ).toBe("builder");
      const next = f.core.queue("build", {
        threadId: thread.id,
        driverId: "builder",
        model: "fixture",
        prompt: "Implement the evidence without network access.",
      });
      const selected = f.core.buildHandoff(next.id);
      expect(selected.context).toContain("Historical material is context");
      expect(selected.context).toContain("vims_thread_read");
      f.core.approve("approve-build", next.id);
      await f.core.executeNext(thread.id);
      expect(received?.history.some((item) => item.role === "user")).toBe(true);
      const page = f.core.vims_thread_read({
        threadId: thread.id,
        limit: 2,
        maxCharsPerItem: 100,
      });
      expect(page.hasMore).toBe(true);
      const long = page.items.find(
        (item) => item.kind === "assistant_message",
      )!;
      expect(long.textTruncated).toBe(true);
      let text = long.text;
      let offset = long.nextTextOffset;
      while (offset !== null) {
        const part = f.core.vims_thread_read({
          threadId: thread.id,
          itemId: long.itemId,
          textOffset: offset,
          maxCharsPerItem: 4000,
        }).items[0]!;
        text += part.text;
        offset = part.nextTextOffset;
      }
      expect(text).toBe(
        "Evidence A. Keep the project offline. " + "detail ".repeat(2500),
      );
      expect(
        f.core
          .vims_thread_read({
            threadId: thread.id,
            afterPosition: page.nextPosition,
          })
          .items.every((item) => item.position > page.nextPosition),
      ).toBe(true);
    } finally {
      await f.cleanup();
    }
  });
  it("records failed work with checkpoint evidence and preserves dirty worktrees", async () => {
    const f = await fixture([
      driver("writer", async (turn) => {
        await fs.writeFile(path.join(turn.cwd, "code.txt"), "partial\n");
        throw new Error("test failure");
      }),
    ]);
    try {
      const { thread, run } = await queued(f.core, f.repo);
      f.core.approve("approve", run.id);
      expect((await f.core.executeNext(thread.id))?.status).toBe("failed");
      expect((await f.core.review(run.id)).patch).toContain("+partial");
      await expect(
        f.core.workspaces.remove(f.core.store.thread(thread.id), true),
      ).rejects.toThrow("dirty");
      expect(f.core.inbox().attention[0]?.latestRun?.status).toBe("failed");
    } finally {
      await f.cleanup();
    }
  });
  it("rejects traversal, unsafe cursors, and unsupported drivers before execution", async () => {
    const f = await fixture([driver("writer", async () => {})]);
    try {
      const { thread } = await queued(f.core, f.repo);
      await expect(
        f.core.workspaces.ensure({ ...thread, id: "../../outside" }),
      ).rejects.toThrow("owner id");
      expect(() =>
        f.core.vims_thread_read({ threadId: thread.id, limit: 100000 }),
      ).toThrow("limit");
      expect(() =>
        f.core.vims_thread_read({ threadId: thread.id, textOffset: -1 }),
      ).toThrow("offset");
      expect(() =>
        f.core.queue("x", {
          threadId: thread.id,
          driverId: "missing",
          model: "x",
          prompt: "x",
        }),
      ).toThrow("registered");
      await expect(f.core.workspaces.remove(thread, false)).rejects.toThrow(
        "confirmation",
      );
    } finally {
      await f.cleanup();
    }
  });
  it("isolates concurrent threads sharing the same repository", async () => {
    const f = await fixture([
      driver("writer", async (turn) => {
        await fs.writeFile(
          path.join(turn.cwd, "code.txt"),
          turn.threadId + "\n",
        );
      }),
    ]);
    try {
      const a = await queued(f.core, f.repo, "a");
      const b = await queued(f.core, f.repo, "b");
      f.core.approve("approve-a", a.run.id);
      f.core.approve("approve-b", b.run.id);
      const results = await Promise.all([
        f.core.executeNext(a.thread.id),
        f.core.executeNext(b.thread.id),
      ]);
      expect(results.map((run) => run?.status)).toEqual([
        "completed",
        "completed",
      ]);
      expect(f.core.store.thread(a.thread.id).worktree).not.toBe(
        f.core.store.thread(b.thread.id).worktree,
      );
      expect(await fs.readFile(path.join(f.repo, "code.txt"), "utf8")).toBe(
        "baseline\n",
      );
      expect((await f.core.review(a.run.id)).patch).toContain(a.thread.id);
      expect((await f.core.review(b.run.id)).patch).toContain(b.thread.id);
    } finally {
      await f.cleanup();
    }
  });
});
