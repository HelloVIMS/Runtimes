import { describe, it, expect } from "vitest";
import {
  makeCodexTurnTokenUsageState,
  getCodexTurnAccumulator,
  accumulateCodexTurnTokenUsage,
  completeCodexTurnTokenUsage,
} from "../src/t3/codexTokenUsage.ts";
import { toCodexUserInputAnswers } from "../src/t3/codexApprovalMappings.ts";
const part = (
  input: number,
  output: number,
  cache = 0,
  reasoning = 0,
  write = 0,
) => ({
  totalTokens: input + output,
  inputTokens: input,
  outputTokens: output,
  cachedInputTokens: cache,
  reasoningOutputTokens: reasoning,
  cacheWriteInputTokens: write,
});
describe("copied native token-accounting boundaries", () => {
  it("reports unavailable rather than inventing zero-cost usage", () => {
    const state = makeCodexTurnTokenUsageState();
    state.activeTurnId = "t";
    getCodexTurnAccumulator(state, "t");
    expect(completeCodexTurnTokenUsage(state, "t", true)).toEqual({
      usageStatus: "unavailable",
      usageScope: "main_agent",
      hasSubagents: false,
    });
  });
  it("uses response-local usage when cumulative totals reset and labels interrupted runs partial", () => {
    const state = makeCodexTurnTokenUsageState();
    state.activeTurnId = "t";
    accumulateCodexTurnTokenUsage(state, "t", {
      total: part(100, 20),
      last: part(100, 20),
    });
    accumulateCodexTurnTokenUsage(state, "t", {
      total: part(10, 2),
      last: part(10, 2),
    });
    expect(completeCodexTurnTokenUsage(state, "t", false)).toMatchObject({
      usageStatus: "partial",
      inputTokens: 110,
      outputTokens: 22,
    });
  });
  it("bounds cache and reasoning subcounts and preserves the subagent caveat", () => {
    const state = makeCodexTurnTokenUsageState();
    state.activeTurnId = "t";
    getCodexTurnAccumulator(state, "t").hasSubagents = true;
    accumulateCodexTurnTokenUsage(state, "t", {
      total: part(10, 2, 99, 90, 80),
      last: part(10, 2, 99, 90, 80),
    });
    expect(completeCodexTurnTokenUsage(state, "t", true)).toMatchObject({
      inputTokens: 10,
      cachedInputTokens: 10,
      cacheCreationTokens: 10,
      outputTokens: 2,
      reasoningTokens: 2,
      usageScope: "main_agent",
      hasSubagents: true,
    });
  });
  it("does not count finished-turn notifications toward the active turn", () => {
    const state = makeCodexTurnTokenUsageState();
    state.activeTurnId = "live";
    accumulateCodexTurnTokenUsage(state, "old", {
      total: part(100, 20),
      last: part(100, 20),
    });
    expect(state.byTurnId.size).toBe(0);
    accumulateCodexTurnTokenUsage(state, "live", {
      total: part(130, 26),
      last: part(30, 6),
    });
    expect(completeCodexTurnTokenUsage(state, "live", true)).toMatchObject({
      inputTokens: 30,
      outputTokens: 6,
    });
  });
  it("converts only allowed question IDs and retains exact strings/arrays", () => {
    expect(
      toCodexUserInputAnswers(
        { q: "  a\n", multi: ["x", " y "], private: "not requested" },
        new Set(["q", "multi"]),
      ),
    ).toEqual({ q: { answers: ["  a\n"] }, multi: { answers: ["x", " y "] } });
  });
});
