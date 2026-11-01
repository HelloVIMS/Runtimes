// Copyright (c) 2026 T3 Tools Inc. ΓÇö MIT; see vendor/t3/LICENSE.
// Copied/adapted from pingdotgg/t3code@575579d68ac4bae09f8426a345d4a3eac1e90c67
// Source: packages/client-runtime/src/state/models.ts; exact upstream bytes and changes: vendor/t3/manifest.json.
import type { ThreadStructureRuntime, ThreadRuntimeSummary } from "./contracts.ts";

export function threadRuntimeIsActive(runtime: ThreadStructureRuntime | null | undefined): boolean {
  return runtime !== null && runtime !== undefined && threadRunStatusIsActive(runtime.status);
}

function threadRunStatusIsActive(status: ThreadRuntimeSummary["status"]): boolean {
  return (
    status === "preparing" ||
    status === "queued" ||
    status === "starting" ||
    status === "running" ||
    status === "waiting"
  );
}
