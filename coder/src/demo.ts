// Offline native-core demonstration: real Git and SQLite, no model or T3 process.
import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { CoderCore } from "./core.ts";
import type { NativeDriver } from "./types.ts";
const root = await fs.mkdtemp(path.join(os.tmpdir(), "vims-native-demo-"));
const repository = path.join(root, "repository");
await fs.mkdir(repository);
const git = (...args: string[]) =>
  execFileSync("git", ["-C", repository, ...args], {
    encoding: "utf8",
    windowsHide: true,
  });
git("init", "-q");
git("config", "user.name", "VIMS demo");
git("config", "user.email", "demo@localhost");
git("config", "core.autocrlf", "false");
await fs.writeFile(path.join(repository, "answer.txt"), "before\n");
git("add", ".");
git("commit", "-qm", "baseline");
const research: NativeDriver = {
  id: "research-fixture",
  contextMode: "portable",
  async run(_turn, emit) {
    emit({
      type: "assistant_message",
      text: "Evidence: write a clear answer. Constraint: do not deploy.",
    });
  },
};
const builder: NativeDriver = {
  id: "builder-fixture",
  contextMode: "portable",
  async run(turn, emit) {
    if (!turn.history.some((item) => item.text.includes("Evidence:")))
      throw new Error("native handoff missing");
    await fs.writeFile(
      path.join(turn.cwd, "answer.txt"),
      "VIMS owns this task, history and worktree.\n",
    );
    emit({ type: "file_change", fileName: "answer.txt" });
    emit({
      type: "assistant_message",
      text: "Implemented in the isolated worktree.",
    });
  },
};
const core = new CoderCore(path.join(root, "state"), [research, builder]);
try {
  const thread = await core.createThread("demo-thread", {
    repository,
    title: "Native VIMS source transplant",
  });
  const first = core.queue("demo-research", {
    threadId: thread.id,
    driverId: research.id,
    model: "offline",
    prompt: "Research the task.",
  });
  core.approve("demo-approve-research", first.id);
  await core.executeNext(thread.id);
  const second = core.queue("demo-build", {
    threadId: thread.id,
    driverId: builder.id,
    model: "offline",
    prompt: "Implement the research.",
  });
  core.approve("demo-approve-build", second.id);
  const result = await core.executeNext(thread.id);
  const review = await core.review(second.id);
  console.log(
    JSON.stringify(
      {
        t3ProcessRequired: false,
        providerCalls: 0,
        status: result?.status,
        historyItems: core.buildHandoff(second.id).messages.length,
        primaryCheckout: await fs.readFile(
          path.join(repository, "answer.txt"),
          "utf8",
        ),
        changedFiles: review.files,
        patch: review.patch,
        inbox: core
          .inbox()
          .attention.map((item) => ({
            title: item.title,
            status: item.latestRun?.status,
          })),
      },
      null,
      2,
    ),
  );
} finally {
  core.close();
  await fs.rm(root, { recursive: true, force: true });
}
