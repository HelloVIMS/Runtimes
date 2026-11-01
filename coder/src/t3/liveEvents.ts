// Copyright (c) 2026 T3 Tools Inc. ΓÇö MIT; see vendor/t3/LICENSE.
// Copied/adapted from pingdotgg/t3code@575579d68ac4bae09f8426a345d4a3eac1e90c67
// Source: apps/server/src/orchestration-v2/ThreadLiveEventCoalescer.ts; exact upstream bytes and changes: vendor/t3/manifest.json.
import type { OrchestrationV2ThreadStreamItem } from "./contracts.ts";

type ThreadLiveEvent = Extract<OrchestrationV2ThreadStreamItem, { readonly kind: "event" }>;
export type ThreadLiveInput = ThreadLiveEvent | { readonly kind: "synchronized" };

function coalescibleUpdateKey(input: ThreadLiveEvent): string | null {
  const { event } = input;
  const prefix = `${event.threadId}\u0000${event.runId ?? ""}\u0000${event.type}`;
  if (event.type === "message.updated") {
    return event.payload.role === "assistant" && event.payload.streaming
      ? `${prefix}\u0000${event.payload.id}`
      : null;
  }
  if (event.type !== "turn-item.updated" || event.payload.status !== "running") return null;
  switch (event.payload.type) {
    case "assistant_message":
    case "reasoning":
      if (!event.payload.streaming) return null;
      break;
    case "command_execution":
    case "file_change":
    case "file_search":
    case "web_search":
    case "dynamic_tool":
      break;
    default:
      return null;
  }
  return `${prefix}\u0000${event.payload.type}\u0000${event.payload.id}`;
}

// These events replace whole entities. Keep each survivor at its original
// position/sequence so a resume cursor cannot skip an unrelated earlier update.
export function coalesceLiveUpdatedEvents(
  events: ReadonlyArray<ThreadLiveEvent>,
): ReadonlyArray<ThreadLiveEvent> {
  const latestUpdates = new Map<string, number>();
  const superseded = new Set<number>();
  const pendingKeys = new Map<ThreadLiveEvent["event"]["type"], string>();

  for (const [index, event] of events.entries()) {
    const key = coalescibleUpdateKey(event);
    if (key === null) {
      latestUpdates.clear();
      pendingKeys.clear();
      continue;
    }
    // Both entity families use insertion order; partial timelines also reject
    // unseen items below their watermark. Keep identity switches within each
    // family, while allowing paired message/item updates to coalesce.
    const pendingKey = pendingKeys.get(event.event.type);
    if (pendingKey !== undefined && pendingKey !== key) latestUpdates.clear();
    pendingKeys.set(event.event.type, key);
    const previous = latestUpdates.get(key);
    if (previous !== undefined) superseded.add(previous);
    latestUpdates.set(key, index);
  }
  return events.filter((_, index) => !superseded.has(index));
}
