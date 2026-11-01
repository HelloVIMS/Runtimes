// Copyright (c) 2026 T3 Tools Inc. ΓÇö MIT; see vendor/t3/LICENSE.
// Copied/adapted from pingdotgg/t3code@575579d68ac4bae09f8426a345d4a3eac1e90c67
// Source: apps/server/src/orchestration-v2/ThreadForkService.ts; exact upstream bytes and changes: vendor/t3/manifest.json.
import type { OrchestrationV2Run } from "./contracts.ts";

/** waiting means provider-finished with checkpoint capture pending. */
export function isForkableSourceRunStatus(status: OrchestrationV2Run["status"]): boolean {
  return (
    status === "completed" ||
    status === "waiting" ||
    status === "failed" ||
    status === "interrupted" ||
    status === "cancelled"
  );
}

export function forkableSourceRunStatusError(
  run: Pick<OrchestrationV2Run, "id" | "status">,
): string {
  return `Fork source run ${run.id} is ${run.status}; in-progress and rolled-back runs cannot be forked.`;
}
