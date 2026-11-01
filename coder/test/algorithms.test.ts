import { describe, expect, it } from "vitest";
import {
  handoffBudget,
  selectHistory,
  historyCost,
  contextUsageForHandoff,
  historicalMessage,
} from "../src/t3/handoffBudget.ts";
import { coalesceLiveUpdatedEvents } from "../src/t3/liveEvents.ts";
import type {
  OrchestrationV2HistoricalMessage,
  OrchestrationV2ThreadStreamItem,
} from "../src/t3/contracts.ts";
const message = (
  id: number,
  text: string,
): OrchestrationV2HistoricalMessage => ({
  itemId: "item-" + id,
  threadId: "thread",
  runId: "run",
  providerThreadId: "native",
  status: "completed",
  kind: id % 2 ? "assistant_message" : "user_message",
  role: id % 2 ? "assistant" : "user",
  text,
});
describe("T3 source transplant edge cases", () => {
  it("keeps complete multilingual/escaped items inside the real serialized budget", () => {
    const messages = Array.from({ length: 200 }, (_, index) =>
      message(index, ('µ╝óσ¡ù≡ƒÖé\\\n"' + index).repeat((index % 9) + 1)),
    );
    for (const budget of [2000, 4096, 8000, 16000]) {
      const selected = selectHistory({
        messages,
        coverage: "Native VIMS coverage.",
        budget,
      });
      expect(
        historyCost(selected.messages, selected.context),
      ).toBeLessThanOrEqual(budget);
      for (const item of selected.messages)
        expect(
          messages.find((original) => original.itemId === item.itemId),
        ).toEqual(item);
      expect(selected.omittedItems + selected.messages.length).toBe(
        messages.length,
      );
    }
  });
  it("preserves the original constraint and recent user/assistant work when they fit", () => {
    const messages = [
      message(0, "ORIGINAL CONSTRAINT"),
      message(1, "x".repeat(100000)),
      message(2, "LATEST REQUEST"),
      message(3, "LATEST RESULT"),
    ];
    const selected = selectHistory({
      messages,
      coverage: "coverage",
      budget: 4096,
    });
    expect(selected.messages.map((item) => item.itemId)).toEqual([
      "item-0",
      "item-2",
      "item-3",
    ]);
    expect(selected.omittedItemIds).toEqual(["item-1"]);
  });
  it("subtracts occupied native context and attachment allowance", () => {
    const base = {
      tokenCap: 16000,
      userText: "x",
      attachments: [],
      providerThread: {
        id: "p",
        contextUsage: { usedTokens: 20000, maxTokens: 48000 },
      },
      nativeContextEstimate: 0,
    };
    const empty = handoffBudget(base);
    const image = handoffBudget({ ...base, attachments: [{ type: "image" }] });
    expect(image).toBeLessThan(empty);
    expect(
      handoffBudget({
        ...base,
        providerThread: {
          id: "p",
          contextUsage: { usedTokens: 47000, maxTokens: 48000 },
        },
      }),
    ).toBe(0);
    expect(
      contextUsageForHandoff({
        sameNativeThread: true,
        sameSelection: false,
        reuseTelemetry: false,
        previousUsage: { usedTokens: 20000, maxTokens: 100000 },
        knownModelWindow: 32000,
      }),
    ).toEqual({ usedTokens: 20000, maxTokens: 32000 });
  });
  it("does not replay reasoning as portable history", () => {
    expect(
      historicalMessage({
        id: "x",
        threadId: "t",
        runId: "r",
        providerThreadId: "p",
        status: "completed",
        type: "reasoning",
        text: "internal",
      }),
    ).toBeNull();
  });
  it("coalesces only superseded whole updates without losing a resume cursor barrier", () => {
    const event = (
      seq: number,
      type = "message.updated",
      id = "a",
      streaming = true,
    ): OrchestrationV2ThreadStreamItem => ({
      kind: "event",
      sequence: seq,
      event: {
        threadId: "t",
        runId: "r",
        type,
        payload: { id, role: "assistant", streaming },
      },
    });
    expect(
      coalesceLiveUpdatedEvents([
        event(1),
        event(2),
        event(3, "run.finished"),
        event(4),
        event(5),
      ]).map((item) => item.sequence),
    ).toEqual([2, 3, 5]);
    expect(
      coalesceLiveUpdatedEvents([
        event(1),
        event(2, "message.updated", "other"),
        event(3),
      ]).map((item) => item.sequence),
    ).toEqual([1, 2, 3]);
    expect(
      coalesceLiveUpdatedEvents([
        event(1),
        event(2, "message.updated", "a", false),
      ]).map((item) => item.sequence),
    ).toEqual([1, 2]);
  });
});
