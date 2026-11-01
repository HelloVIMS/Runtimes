/** Small, explicit public-data contracts; not a vendored/generated Codex schema. */
export interface NativeTokenUsage {
  usageStatus: "unavailable" | "complete" | "partial";
  usageScope: "main_agent";
  hasSubagents: boolean;
  inputTokens?: number;
  cachedInputTokens?: number;
  cacheCreationTokens?: number;
  outputTokens?: number;
  reasoningTokens?: number;
}
export interface V2ThreadTokenUsageUpdatedNotification__TokenUsageBreakdown {
  totalTokens: number;
  inputTokens: number;
  cachedInputTokens: number;
  cacheWriteInputTokens?: number;
  outputTokens: number;
  reasoningOutputTokens: number;
}
export interface V2ThreadTokenUsageUpdatedNotification {
  tokenUsage: {
    total: V2ThreadTokenUsageUpdatedNotification__TokenUsageBreakdown;
    last: V2ThreadTokenUsageUpdatedNotification__TokenUsageBreakdown;
    modelContextWindow?: number | null;
  };
}
export interface HistoryReadInput {
  threadId: string;
  view?: "activity";
  afterPosition?: number;
  limit?: number;
  itemId?: string;
  textOffset?: number;
  maxCharsPerItem?: number;
  throughSequence?: number;
  maxOrdinal?: number;
}
export type ProviderTelemetry =
  | { kind: "session"; threadId: string; turnId?: string }
  | { kind: "usage"; usage: NativeTokenUsage }
  | { kind: "notice"; code: string; message: string };
export interface NativeCapabilities {
  transport: "exec-jsonl" | "app-server-stdio" | "embedded";
  context: "portable";
  runtimeApprovals: boolean;
  userQuestions: boolean;
  historyTool: boolean;
  tokenUsage: boolean;
  nativeResume: boolean;
  providerInterrupt: boolean;
}
