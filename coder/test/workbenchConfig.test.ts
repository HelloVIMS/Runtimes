import { describe, expect, it } from "vitest";
import path from "node:path";
import { parseWorkbenchConfig } from "../src/workbenchCli.ts";
import { derivePendingUserInputProgress } from "../src/t3/pendingUserInputProgress.ts";
import {
  resolveQueuedEditExit,
  queuedRunEditBlockedReason,
} from "../src/t3/queuedRunEdit.ts";
import { CoderCore } from "../src/core.ts";
import { fixture } from "./fixtures.ts";
const good = () => ({
  stateDirectory: path.resolve("private-state"),
  projects: [{ id: "p", name: "Project", repository: path.resolve("project") }],
  drivers: [{ id: "codex", binary: process.execPath }],
  profiles: [
    { id: "review", name: "Review", driverId: "codex", model: "owner-chosen" },
  ],
});
describe("explicit owner configuration", () => {
  it("defaults to read-only and refuses public bind/executable/permission surprises", () => {
    expect(parseWorkbenchConfig(good()).drivers[0]!.allowWorkspaceWrites).toBe(
      false,
    );
    expect(() => parseWorkbenchConfig({ ...good(), host: "0.0.0.0" })).toThrow(
      "Unknown",
    );
    expect(() =>
      parseWorkbenchConfig({
        ...good(),
        drivers: [
          {
            id: "codex",
            binary: process.execPath,
            allowWorkspaceWrites: "false",
          },
        ],
      }),
    ).toThrow("boolean");
    expect(() =>
      parseWorkbenchConfig({
        ...good(),
        drivers: [{ id: "codex", binary: path.resolve("codex.cmd") }],
      }),
    ).toThrow("native");
    expect(() =>
      parseWorkbenchConfig({
        ...good(),
        profiles: [
          { id: "review", name: "Review", driverId: "other", model: "model" },
        ],
      }),
    ).toThrow("unknown driver");
  });
  it("preserves the copied input-progress and queued-edit recovery behavior", () => {
    const question = {
      id: "q",
      header: "Edited text",
      question: "Keep or change?",
      options: [],
      initialAnswer: "original",
    };
    const progress = derivePendingUserInputProgress(
      [question],
      { q: { customAnswer: "" } },
      0,
    );
    expect(progress.isComplete).toBe(true);
    expect(progress.resolvedAnswer).toBe("");
    expect(
      resolveQueuedEditExit({ editChanged: true, threadDraftEmpty: true }),
    ).toBe("kept");
    expect(
      resolveQueuedEditExit({ editChanged: true, threadDraftEmpty: false }),
    ).toBe("discarded");
    expect(queuedRunEditBlockedReason({ openQuestionCount: 1 })).toContain(
      "Answer",
    );
  });
  it("migrates the original v1 state without dropping thread or command receipts", async () => {
    const f = await fixture();
    let reopened: CoderCore | undefined;
    try {
      const thread = await f.core.createThread("original", {
        repository: f.repo,
        title: "Preserved v1 thread",
      });
      f.core.store.db.exec(
        "DROP TABLE runtime_requests; PRAGMA user_version=1;",
      );
      f.core.close();
      reopened = new CoderCore(f.state);
      expect(reopened.store.thread(thread.id).title).toBe(
        "Preserved v1 thread",
      );
      expect(reopened.requests.pending(thread.id)).toEqual([]);
      expect(
        Number(
          reopened.store.db.prepare("PRAGMA user_version").get()!.user_version,
        ),
      ).toBe(2);
      expect(
        (
          await reopened.createThread("original", {
            repository: f.repo,
            title: "Preserved v1 thread",
          })
        ).id,
      ).toBe(thread.id);
    } finally {
      reopened?.close();
      if (!reopened) f.core.close();
      const fs = await import("node:fs/promises");
      await fs.rm(f.root, { recursive: true, force: true });
    }
  });
});
