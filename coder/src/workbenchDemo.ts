import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { execFileSync } from "node:child_process";
import { CoderCore } from "./core.ts";
import { startWorkbench } from "./workbench.ts";
import type { NativeDriver } from "./types.ts";
/** Disposable real Git/SQLite demo, explicitly using a fixture instead of a paid model. */
export async function createDemoWorkbench() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "vims-workbench-demo-"));
  const repository = path.join(root, "project");
  await fs.mkdir(repository);
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", repository, ...args], {
      encoding: "utf8",
      windowsHide: true,
    });
  git("init", "-q");
  git("config", "user.name", "VIMS offline demo");
  git("config", "user.email", "demo@localhost");
  git("config", "core.autocrlf", "false");
  await fs.writeFile(
    path.join(repository, "README.md"),
    "# Native VIMS workbench fixture\n\nThe primary checkout stays unchanged.\n",
  );
  git("add", ".");
  git("commit", "-qm", "Fixture baseline");
  const driver: NativeDriver = {
    id: "fixture",
    contextMode: "portable",
    async run(turn, emit, signal) {
      emit({
        type: "assistant_message",
        text: "Offline fixture: preparing a note in the isolated worktree. This is not a model response.",
      });
      const answer = await turn.request!({
        kind: "questions",
        title: "Choose the note format",
        questions: [
          {
            id: "format",
            header: "Format",
            question: "What should the fixture write?",
            options: [
              { label: "Compact note", value: "compact" },
              { label: "Detailed note", value: "detailed" },
            ],
            multiSelect: false,
            allowCustomAnswer: true,
          },
        ],
      });
      signal.throwIfAborted();
      const approval = await turn.request!({
        kind: "approval",
        title: "Approve this file write",
        detail:
          "Write demo-result.md inside this threadΓÇÖs isolated worktree. No primary-checkout changes, network calls, or deployment.",
      });
      if (approval.kind !== "approval" || approval.decision !== "allow_once") {
        emit({
          type: "assistant_message",
          text: "The file write was declined. No output file was created.",
        });
        return;
      }
      signal.throwIfAborted();
      const content = `# VIMS-native fixture result\n\n${turn.prompt}\n\nFormat: ${answer.kind === "questions" ? JSON.stringify(answer.answers.format) : "unknown"}\n\nInherited history items: ${turn.history.length}\n`;
      await fs.writeFile(path.join(turn.cwd, "demo-result.md"), content);
      if (
        (await fs.readFile(path.join(turn.cwd, "demo-result.md"), "utf8")) !==
        content
      )
        throw new Error("Fixture output verification failed");
      emit({ type: "file_change", fileName: "demo-result.md" });
      emit({
        type: "assistant_message",
        text: "Saved demo-result.md and verified its contents. Review the checkpoint diff; the original checkout is unchanged.",
      });
    },
  };
  const core = new CoderCore(path.join(root, "state"), [driver]);
  try {
    const workbench = await startWorkbench({
      core,
      projects: [{ id: "demo", name: "Disposable demo project", repository }],
      profiles: [
        {
          id: "fixture",
          name: "Offline native fixture ┬╖ no model calls",
          driverId: "fixture",
          model: "offline",
        },
      ],
      fixtureMode: true,
    });
    return {
      ...workbench,
      core,
      repository,
      root,
      async close() {
        await workbench.close();
        core.close();
        await fs.rm(root, { recursive: true, force: true });
      },
    };
  } catch (error) {
    core.close();
    await fs.rm(root, { recursive: true, force: true });
    throw error;
  }
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  const demo = await createDemoWorkbench();
  console.log(
    "OFFLINE FIXTURE ONLY. No model calls. The local token below grants control; do not share it.",
  );
  console.log(`${demo.url}/#${demo.token}`);
  let closing = false;
  const stop = () => {
    if (closing) return;
    closing = true;
    void demo.close().catch((error) => {
      console.error(error instanceof Error ? error.message : "Shutdown failed");
      process.exitCode = 1;
    });
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}
