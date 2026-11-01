import { describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import { CoderCore } from "../src/core.ts";
import { fixture, git } from "./fixtures.ts";
import type { NativeDriver, NativeTurn } from "../src/types.ts";
import type { RuntimeReply, RuntimeRequestSpec } from "../src/requestTypes.ts";
const d = (run: NativeDriver["run"]): NativeDriver => ({
  id: "native",
  contextMode: "portable",
  run,
});
async function task(
  core: CoderCore,
  repo: string,
  prompt = "original",
  threadId?: string,
) {
  const thread = threadId
    ? core.store.thread(threadId)
    : await core.createThread("thread-" + crypto.randomUUID(), {
        repository: repo,
        title: "extension test",
      });
  const run = core.queue("queue-" + crypto.randomUUID(), {
    threadId: thread.id,
    driverId: "native",
    model: "fixture",
    prompt,
  });
  return { thread, run };
}
const questions: RuntimeRequestSpec = {
  kind: "questions",
  title: "Choose the implementation",
  questions: [
    {
      id: "scope",
      header: "Scope",
      question: "Which result?",
      options: [
        { label: "Same label", value: " first\t" },
        { label: "Same label", value: "second" },
      ],
      allowCustomAnswer: false,
    },
    {
      id: "note",
      header: "Note",
      question: "Revise the note",
      options: [],
      initialAnswer: "  keep spacing\n",
    },
  ],
};
describe("editable native queues", () => {
  it("revokes approval, rejects stale saves/approvals, and projects only the new prompt", async () => {
    let received = "";
    const f = await fixture([
      d(async (turn) => {
        received = turn.prompt;
      }),
    ]);
    try {
      const { thread, run } = await task(f.core, f.repo);
      f.core.approve("approve-old", run.id, 1);
      const edited = f.core.editQueued("edit", run.id, 1, {
        prompt: "corrected",
      });
      expect(edited.revision).toBe(2);
      expect(edited.status).toBe("waiting");
      expect(edited.approved).toBe(false);
      expect(
        f.core.editQueued("edit", run.id, 1, { prompt: "corrected" }),
      ).toEqual(edited);
      expect(() =>
        f.core.editQueued("stale", run.id, 1, { prompt: "overwrite" }),
      ).toThrow("changed");
      expect(() => f.core.approve("stale-approval", run.id, 1)).toThrow(
        "changed",
      );
      expect(await f.core.executeNext(thread.id)).toBeNull();
      const history = f.core.vims_thread_read({ threadId: thread.id });
      expect(history.items.map((item) => item.text)).toEqual(["corrected"]);
      const audit = f.core.store
        .events(thread.id)
        .filter((event) => event.kind === "item");
      expect(audit.length).toBe(2);
      f.core.approve("approve-new", run.id, 2);
      await f.core.executeNext(thread.id);
      expect(received).toBe("corrected");
      expect(() =>
        f.core.editQueued("too-late", run.id, 2, { prompt: "no" }),
      ).toThrow("left");
    } finally {
      await f.cleanup();
    }
  });
});
describe("durable native runtime requests", () => {
  it("uses the copied exact-choice/edit semantics, receives answers through a second core, then asks for approval", async () => {
    const replies: RuntimeReply[] = [];
    const f = await fixture([
      d(async (turn, emit) => {
        replies.push(await turn.request!(questions));
        replies.push(
          await turn.request!({
            kind: "approval",
            title: "Write file",
            detail: "Create answer.txt in this isolated worktree.",
          }),
        );
        if (
          replies[1]?.kind === "approval" &&
          replies[1].decision === "allow_once"
        )
          await fs.writeFile(path.join(turn.cwd, "answer.txt"), "approved");
        emit({ type: "assistant_message", text: "Input gates completed." });
      }),
    ]);
    const control = new CoderCore(f.state);
    let execution: Promise<unknown> | undefined;
    let runId = "";
    try {
      const { thread, run } = await task(f.core, f.repo);
      runId = run.id;
      f.core.approve("approve", run.id, 1);
      execution = f.core.executeNext(thread.id);
      await vi.waitFor(
        () => expect(control.requests.pending(thread.id).length).toBe(1),
        { timeout: 8000 },
      );
      expect(control.store.run(run.id).status).toBe("blocked");
      expect(control.inbox().attention[0]?.hasPendingUserInput).toBe(true);
      const request = control.requests.pending(thread.id)[0]!;
      expect(() =>
        control.queue("unsupported", {
          threadId: thread.id,
          driverId: "native",
          model: "fixture",
          prompt: "cannot queue",
        }),
      ).toThrow("registered");
      const pending = f.core.queue("followup", {
        threadId: run.threadId,
        driverId: "native",
        model: "fixture",
        prompt: "queued followup",
      });
      expect(() =>
        f.core.editQueued("hidden-edit", pending.id, 1, {
          prompt: "changed behind question",
        }),
      ).toThrow("Answer the question");
      expect(() =>
        control.respond("bad-digest", request.id, "0".repeat(64), {
          kind: "questions",
          drafts: {},
        }),
      ).toThrow("mismatched");
      expect(() =>
        control.respond("bad-option", request.id, request.digest, {
          kind: "questions",
          drafts: {
            scope: { selectedOptionValues: ["Same label"] },
            note: { customAnswer: "" },
          },
        }),
      ).toThrow("unknown option");
      const response = {
        kind: "questions" as const,
        drafts: {
          scope: { selectedOptionValues: [" first\t"] },
          note: { customAnswer: "  edited\n" },
        },
      };
      const answered = control.respond(
        "answer",
        request.id,
        request.digest,
        response,
      );
      expect(
        control.respond("answer", request.id, request.digest, response),
      ).toEqual(answered);
      await vi.waitFor(
        () =>
          expect(control.requests.pending(run.threadId)[0]?.spec.kind).toBe(
            "approval",
          ),
        { timeout: 3000 },
      );
      const approval = control.requests.pending(run.threadId)[0]!;
      expect(control.inbox().attention[0]?.hasPendingApprovals).toBe(true);
      control.respond("allow-once", approval.id, approval.digest, {
        kind: "approval",
        decision: "allow_once",
      });
      await execution;
      expect(f.core.store.run(runId).status).toBe("completed");
      expect(replies[0]).toEqual({
        kind: "questions",
        answers: { scope: " first\t", note: "  edited\n" },
      });
      expect(
        (await f.core.review(runId)).files.some(
          (file) => file.path === "answer.txt",
        ),
      ).toBe(true);
    } finally {
      if (runId) f.core.cancel("cleanup-" + crypto.randomUUID(), runId);
      await execution;
      control.close();
      await f.cleanup();
    }
  });
  it("denial is a specific answer, not permission escalation", async () => {
    let allowed = false;
    const f = await fixture([
      d(async (turn) => {
        const answer = await turn.request!({
          kind: "approval",
          title: "Delete?",
          detail: "Request is for a fixture only.",
        });
        allowed =
          answer.kind === "approval" && answer.decision === "allow_once";
      }),
    ]);
    let execution: Promise<unknown> | undefined;
    let runId = "";
    try {
      const { thread, run } = await task(f.core, f.repo);
      runId = run.id;
      f.core.approve("approve", run.id);
      execution = f.core.executeNext(thread.id);
      await vi.waitFor(
        () => expect(f.core.requests.pending(thread.id).length).toBe(1),
        { timeout: 8000 },
      );
      const request = f.core.requests.pending(thread.id)[0]!;
      expect(() =>
        f.core.respond("bad", request.id, request.digest, {
          kind: "approval",
          decision: "full_access",
        } as never),
      ).toThrow("only allow_once");
      f.core.respond("deny", request.id, request.digest, {
        kind: "approval",
        decision: "deny",
      });
      await execution;
      expect(allowed).toBe(false);
      expect(f.core.store.run(run.id).status).toBe("completed");
    } finally {
      if (runId) f.core.cancel("cleanup-" + crypto.randomUUID(), runId);
      await execution;
      await f.cleanup();
    }
  });
  it("expires unanswered requests and refuses late answers", async () => {
    const f = await fixture([
      d(async (turn) => {
        await turn.request!(
          {
            kind: "approval",
            title: "Bounded request",
            detail: "Expires without an answer.",
          },
          100,
        );
      }),
    ]);
    try {
      const { thread, run } = await task(f.core, f.repo);
      f.core.approve("approve", run.id);
      const result = await f.core.executeNext(thread.id);
      expect(result?.status).toBe("failed");
      expect(result?.error).toContain("expired");
      const row = f.core.store.db
        .prepare("SELECT body FROM runtime_requests WHERE run_id=?")
        .get(run.id)!;
      const request = JSON.parse(String(row.body));
      expect(request.status).toBe("expired");
      expect(() =>
        f.core.respond("late", request.id, request.digest, {
          kind: "approval",
          decision: "allow_once",
        }),
      ).toThrow("no longer pending");
    } finally {
      await f.cleanup();
    }
  });
  it("cancels a blocked task from another control instance and never consumes an old answer", async () => {
    const native = d(async (turn) => {
      await turn.request!(questions);
      throw new Error("must not continue");
    });
    const f = await fixture([native]);
    const control = new CoderCore(f.state);
    let execution: Promise<unknown> | undefined;
    let runId = "";
    try {
      const { thread, run } = await task(f.core, f.repo);
      runId = run.id;
      f.core.approve("approve", run.id);
      execution = f.core.executeNext(thread.id);
      await vi.waitFor(
        () => expect(control.requests.pending(thread.id).length).toBe(1),
        { timeout: 8000 },
      );
      const request = control.requests.pending(thread.id)[0]!;
      expect(control.cancel("cancel", run.id).status).toBe("cancel_requested");
      await execution;
      expect(control.store.run(run.id).status).toBe("cancelled");
      expect(() =>
        control.respond("late", request.id, request.digest, {
          kind: "questions",
          drafts: {},
        }),
      ).toThrow("no longer pending");
    } finally {
      if (runId) f.core.cancel("cleanup-" + crypto.randomUUID(), runId);
      await execution;
      control.close();
      await f.cleanup();
    }
  });
  it("rejects malformed questions before creating a blocked state", async () => {
    const f = await fixture([
      d(async (turn) => {
        await expect(
          turn.request!({
            kind: "questions",
            title: "Bad",
            questions: [
              {
                id: "constructor",
                header: "bad",
                question: "bad",
                options: [],
              },
            ],
          }),
        ).rejects.toThrow("reserved");
      }),
    ]);
    try {
      const { thread, run } = await task(f.core, f.repo);
      f.core.approve("approve", run.id);
      expect((await f.core.executeNext(thread.id))?.status).toBe("completed");
      expect(f.core.requests.pending(thread.id)).toEqual([]);
    } finally {
      await f.cleanup();
    }
  });
});
describe("non-destructive checkpoint branching", () => {
  it("forks exact before/after snapshots with frozen history and preserves later parent work", async () => {
    const observed: Record<string, { file: string; history: string }> =
      Object.create(null);
    const f = await fixture([
      d(async (turn, emit) => {
        if (turn.prompt.startsWith("write")) {
          await fs.writeFile(
            path.join(turn.cwd, "code.txt"),
            turn.prompt + "\n",
          );
          emit({ type: "assistant_message", text: "RESULT " + turn.prompt });
        } else {
          observed[turn.prompt] = {
            file: await fs.readFile(path.join(turn.cwd, "code.txt"), "utf8"),
            history: turn.history.map((item) => item.text).join("\n"),
          };
          emit({ type: "assistant_message", text: "inspected" });
        }
      }),
    ]);
    try {
      const { thread, run } = await task(f.core, f.repo, "write first");
      f.core.approve("a1", run.id);
      await f.core.executeNext(thread.id);
      const child = await f.core.forkThread("fork-after", {
        runId: run.id,
        phase: "after",
        title: "After snapshot",
      });
      expect(
        await f.core.forkThread("fork-after", {
          runId: run.id,
          phase: "after",
          title: "After snapshot",
        }),
      ).toEqual(child);
      const before = await f.core.forkThread("fork-before", {
        runId: run.id,
        phase: "before",
        title: "Before snapshot",
      });
      const later = await task(f.core, f.repo, "write later", thread.id);
      f.core.approve("a2", later.run.id);
      await f.core.executeNext(thread.id);
      for (const [childThread, prompt] of [
        [child, "inspect after"],
        [before, "inspect before"],
      ] as const) {
        const next = await task(f.core, f.repo, prompt, childThread.id);
        f.core.approve("approve-" + next.run.id, next.run.id);
        expect((await f.core.executeNext(childThread.id))?.status).toBe(
          "completed",
        );
      }
      expect(observed["inspect after"]!.file).toBe("write first\n");
      expect(observed["inspect after"]!.history).toContain(
        "RESULT write first",
      );
      expect(observed["inspect after"]!.history).not.toContain("write later");
      expect(observed["inspect before"]!.file).toBe("baseline\n");
      expect(observed["inspect before"]!.history).not.toContain("write first");
      expect(
        await fs.readFile(
          path.join(f.core.store.thread(thread.id).worktree!, "code.txt"),
          "utf8",
        ),
      ).toBe("write later\n");
      expect(await fs.readFile(path.join(f.repo, "code.txt"), "utf8")).toBe(
        "baseline\n",
      );
      const childRun = f.core.store.runs(child.id)[0]!;
      const nested = await f.core.forkThread("nested", {
        runId: childRun.id,
        phase: "after",
        title: "Nested",
      });
      const nestedRun = await task(f.core, f.repo, "inspect nested", nested.id);
      f.core.approve("nested-a", nestedRun.run.id);
      await f.core.executeNext(nested.id);
      expect(observed["inspect nested"]!.history).toContain(
        "RESULT write first",
      );
      expect(observed["inspect nested"]!.history).not.toContain("write later");
      expect(nested.forkedFrom?.sources.length).toBe(2);
    } finally {
      await f.cleanup();
    }
  }, 20000);
  it("rejects approval-pending runs and changed checkpoint refs", async () => {
    const f = await fixture([d(async () => {})]);
    try {
      const { thread, run } = await task(f.core, f.repo);
      await expect(
        f.core.forkThread("bad", {
          runId: run.id,
          phase: "after",
          title: "Bad",
        }),
      ).rejects.toThrow("awaiting_approval");
      f.core.approve("approve", run.id);
      await f.core.executeNext(thread.id);
      git(
        f.repo,
        "update-ref",
        `refs/vims/checkpoints/${thread.id}/${run.id}/after`,
        "HEAD",
      );
      await expect(
        f.core.forkThread("tamper", {
          runId: run.id,
          phase: "after",
          title: "Bad",
        }),
      ).rejects.toThrow("no longer matches");
    } finally {
      await f.cleanup();
    }
  });
});
