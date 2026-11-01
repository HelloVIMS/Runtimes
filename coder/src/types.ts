import type { RuntimeRequestSpec, RuntimeReply } from "./requestTypes.ts";
import type {
  ModelSelection,
  OrchestrationV2HistoricalMessage,
  OrchestrationV2TurnItem,
} from "./t3/contracts.ts";
export type RunState =
  | "waiting"
  | "queued"
  | "preparing"
  | "running"
  | "blocked"
  | "cancel_requested"
  | "completed"
  | "failed"
  | "cancelled"
  | "interrupted";
export interface HistorySource {
  threadId: string;
  throughSequence: number;
  maxOrdinal: number;
}
export interface Thread {
  id: string;
  title: string;
  repository: string;
  baseRef: string;
  forkedFrom?: {
    threadId: string;
    runId: string;
    phase: "before" | "after";
    checkpoint: string;
    sources: HistorySource[];
  };
  worktree: string | null;
  createdAt: string;
  updatedAt: string;
}
export interface Run {
  id: string;
  threadId: string;
  ordinal: number;
  userMessageId: string;
  queuePosition: number;
  providerInstanceId: string;
  modelSelection: ModelSelection;
  prompt: string;
  status: RunState;
  automaticCompletion: boolean;
  approved: boolean;
  revision?: number;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
  contextHandoffId: string | null;
  before: string | null;
  after: string | null;
  error: string | null;
}
export interface JournalEvent {
  sequence: number;
  threadId: string;
  runId: string | null;
  kind: string;
  payload: unknown;
  at: string;
}
export interface NativeTurn {
  runId: string;
  threadId: string;
  cwd: string;
  model: string;
  prompt: string;
  history: readonly OrchestrationV2HistoricalMessage[];
  historyContext: string;
  /** Only adapters using this callback participate in VIMS runtime input/approval gating. */
  request?: (
    spec: RuntimeRequestSpec,
    timeoutMs?: number,
  ) => Promise<RuntimeReply>;
}
export type DriverItem =
  | { type: "assistant_message"; text: string }
  | {
      type: "command_execution";
      input: string;
      output: string;
      exitCode: number | null;
    }
  | { type: "file_change"; fileName: string }
  | { type: "proposed_plan"; markdown: string };
export interface NativeDriver {
  readonly id: string;
  readonly contextWindow?: number;
  /** This MVP uses explicit portable context, never a hidden T3/native session. */
  readonly contextMode: "portable";
  run(
    turn: NativeTurn,
    emit: (item: DriverItem) => void,
    signal: AbortSignal,
  ): Promise<void>;
}
export type StoredItem = OrchestrationV2TurnItem;
export interface QueueInput {
  threadId: string;
  driverId: string;
  model: string;
  prompt: string;
  /** Set only for host-generated child-completion delivery, not untrusted UI input. */
  automaticCompletion?: boolean;
}
