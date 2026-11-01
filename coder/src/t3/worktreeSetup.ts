// Copyright (c) 2026 T3 Tools Inc. ΓÇö MIT; see vendor/t3/LICENSE.
// Copied/adapted from pingdotgg/t3code@575579d68ac4bae09f8426a345d4a3eac1e90c67
// Source: packages/client-runtime/src/worktreeSetup.ts; exact upstream bytes and changes: vendor/t3/manifest.json.
import type { WorktreeSetupSnapshot } from "./contracts.ts";

export function resolveVisibleWorktreeSetup(input: {
  live: WorktreeSetupSnapshot | null;
  recorded: WorktreeSetupSnapshot | null;
  turnStarted: boolean;
  followUpSent: boolean;
}): WorktreeSetupSnapshot | null {
  const snapshot =
    input.live && (!input.recorded || input.live.sequence >= input.recorded.sequence)
      ? input.live
      : input.recorded;
  if (!snapshot) return null;
  if (snapshot.phase === "running") return snapshot;
  if (input.followUpSent) return null;
  if (snapshot.phase !== "done") return snapshot;
  if (!input.turnStarted) return snapshot;
  return snapshot.stages.some((stage) => stage.status === "failed") ? snapshot : null;
}

export function worktreeSetupAgentStarted(snapshot: WorktreeSetupSnapshot): boolean {
  return snapshot.stages.some((stage) => stage.id === "agent" && stage.status === "done");
}
