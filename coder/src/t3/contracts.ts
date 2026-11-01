// Structural compatibility types for the directly copied T3 pure algorithms.
// These are not a wire-compatible replacement for T3's full Effect schemas.
export type ProviderInstanceId = string;
export const ProviderInstanceId = { make: (value: string) => value };
export const RunId = { make: (value: string) => value };
export const ContextHandoffId = { make: (value: string) => value };
export interface ModelSelection {
  instanceId: string;
  model: string;
}
export interface ServerProvider {
  instanceId: string;
  driver: string;
  continuation?: { groupKey?: string };
}
export interface ThreadTokenUsageSnapshot {
  usedTokens: number;
  maxTokens?: number | null;
  autoCompactThreshold?: number | null;
}
export interface ChatAttachment {
  type: string;
}
export interface OrchestrationV2ProviderThread {
  id: string;
  nativeThreadRef?: { nativeId: string } | null;
  contextUsage?: ThreadTokenUsageSnapshot | null;
}
export interface OrchestrationV2Run {
  id: string;
  ordinal: number;
  status: string;
  userMessageId: string;
  queuePosition?: number | null;
  providerInstanceId: string;
  modelSelection: ModelSelection;
  startedAt: string | null;
  contextHandoffId: string | null;
}
export interface OrchestrationV2HistoricalMessage {
  role: "user" | "assistant";
  text: string;
  threadId: string;
  runId: string | null;
  itemId: string;
  providerThreadId: string | null;
  status: string;
  kind: string;
  runStatus?: string;
}
interface ItemBase {
  id: string;
  threadId: string;
  runId: string | null;
  providerThreadId: string | null;
  status: string;
}
export type OrchestrationV2TurnItem = ItemBase &
  (
    | { type: "user_message" | "assistant_message"; text: string }
    | {
        type: "command_execution";
        input: string;
        output?: string | null;
        exitCode?: number | null;
      }
    | { type: "error"; failure: { message: string } }
    | { type: "run_interrupt_result"; message: string }
    | { type: "file_change"; fileName: string }
    | { type: "proposed_plan"; markdown: string }
    | { type: "reasoning"; text: string }
    | {
        type: "handoff";
        fromModelSelections?: ModelSelection[];
        fromProviderInstanceIds: string[];
        toModel?: string;
        toProviderInstanceId: string;
      }
  );
export interface OrchestrationV2ContextHandoff {
  coveredRunOrdinals: { from: number; to: number };
}
export interface OrchestrationV2ThreadProjection {
  runs: OrchestrationV2Run[];
  messages: Array<{ id: string; delegatedCompletion?: unknown }>;
  visibleTurnItems: unknown[];
  attempts: Array<{
    id: string;
    nativeThreadId: string;
    providerThreadId: string;
    rootNodeId: string;
    runId: string;
  }>;
  providerTurns: Array<{
    providerThreadId: string;
    runAttemptId: string | null;
    nodeId: string;
    tokenUsage?: {
      usedTokens: number;
      maxTokens?: number | null;
      updatedAt: string;
    } | null;
  }>;
}
export type ThreadStructure = OrchestrationV2ThreadProjection;
export interface WorktreeSetupSnapshot {
  sequence: number;
  phase: string;
  stages: Array<{ id: string; status: string }>;
}
export interface OrchestrationV2ThreadStreamItem {
  kind: "event";
  sequence: number;
  event: {
    threadId: string;
    runId: string | null;
    type: string;
    payload: {
      id: string;
      type?: string;
      role?: string;
      streaming?: boolean;
      status?: string;
      text?: string;
    };
  };
}
export interface ThreadRuntimeSummary {
  status: string;
  activeRunId: string | null;
  lastError?: string | null;
}
export type ThreadStructureRuntime = ThreadRuntimeSummary;
export interface EnvironmentThreadShell {
  id: string;
  environmentId: string;
  createdAt: string;
  unsettledAt?: string | null;
  hasActionableProposedPlan: boolean;
  hasPendingApprovals: boolean;
  hasPendingUserInput: boolean;
  pendingSubagentRequest?: unknown;
  interactionMode: string;
  latestRun: {
    status: string;
    runId: string;
    requestedAt?: string;
    completedAt?: string | null;
  } | null;
  runtime: ThreadRuntimeSummary | null;
  latestUserAuthoredMessageAt?: string | null;
}
