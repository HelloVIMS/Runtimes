import type {
  PendingUserInputQuestion,
  PendingUserInputDraftAnswer,
  PendingUserInputAnswer,
} from "./t3/pendingUserInput.ts";
export interface InputQuestion extends PendingUserInputQuestion {
  readonly header: string;
  readonly question: string;
  readonly options: ReadonlyArray<{
    label: string;
    value?: string;
    description?: string;
  }>;
}
export type RuntimeRequestSpec =
  | { kind: "approval"; title: string; detail: string }
  | { kind: "questions"; title: string; questions: readonly InputQuestion[] };
export type RuntimeReply =
  | { kind: "approval"; decision: "allow_once" | "deny" }
  | { kind: "questions"; answers: Record<string, PendingUserInputAnswer> };
export type RuntimeResponseInput =
  | { kind: "approval"; decision: "allow_once" | "deny" }
  | { kind: "questions"; drafts: Record<string, PendingUserInputDraftAnswer> };
export interface RuntimeRequest {
  id: string;
  threadId: string;
  runId: string;
  digest: string;
  spec: RuntimeRequestSpec;
  status: "pending" | "answered" | "cancelled" | "expired";
  createdAt: string;
  expiresAt: number;
  response: RuntimeReply | null;
  answeredAt: string | null;
}
