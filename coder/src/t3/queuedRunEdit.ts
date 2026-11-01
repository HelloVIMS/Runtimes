// Copyright (c) 2026 T3 Tools Inc. ΓÇö MIT; see vendor/t3/LICENSE.
// Copied/adapted from pingdotgg/t3code@575579d68ac4bae09f8426a345d4a3eac1e90c67
// Source: packages/client-runtime/src/queuedRunEdit.ts; exact upstream bytes and changes: vendor/t3/manifest.json.
export function resolveQueuedEditExit(input: {
  readonly editChanged: boolean;
  readonly threadDraftEmpty: boolean;
}): "kept" | "discarded" | "clean" {
  if (!input.editChanged) return "clean";
  return input.threadDraftEmpty ? "kept" : "discarded";
}

/**
 * Why a queued message can't be opened in the composer now, or null when it
 * can. An open question takes the composer over for its answer, so an edit
 * begun then would happen out of sight and could be sent before it is seen.
 */
export function queuedRunEditBlockedReason(input: {
  readonly openQuestionCount: number;
}): string | null {
  return input.openQuestionCount > 0 ? "Answer the question to edit queued messages" : null;
}
