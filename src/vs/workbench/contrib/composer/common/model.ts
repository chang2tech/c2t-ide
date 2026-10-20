/**
 * Shared view-model types for the ide-agent chat UI.
 * Mirrors Cursor 3.25.6's composer bubble architecture (deep-composer-ui.md):
 * fine-grained bubble store keyed by bubbleId, dual client/server identity,
 * tool-call view-models, and a unified mode enum.
 */

/** Unified mode enum. Runtime truth (Cursor 3.25.9, verified live via CDP):
 * exactly 5 chat modes — agent/chat/plan/debug/multitask.
 * Wire ids are stable: `chat` is user-facing "Ask" (post-0.46 rename).
 * "edit" is the Cmd+K inline-edit flow's internal mode value (submitted by
 * InlineEditService), "background" a separate composer kind — neither is a
 * chat mode; both kept as enum values for compat. */
export type ModeName = "agent" | "chat" | "plan" | "edit" | "debug" | "background" | "multitask" | "triage";

export type BubbleRole = "human" | "assistant" | "tool" | "system";

export type ToolCallStatus = "pending" | "running" | "done" | "failed";

export interface ToolCallViewModel {
  toolCallId: string;
  kind: string;
  title: string;
  status: ToolCallStatus;
  description: string;
  outputPreview: string;
  expanded: boolean;
  /**
   * Absolute or workspace-relative path the tool targets, when known.
   * Populated by the engine adapter from the tool input (path/file field).
   * Used by CheckpointService to snapshot pre-edit file state.
   */
  filePath?: string;
  /**
   * Clarifying-question payload (Cursor parity — doc-gap A12). Present only
   * when kind === "ask_question_tool_call": the agent's question with
   * clickable options. The webview renders option buttons; the user's pick
   * is fed back as a steer message so the answer is incorporated on arrival
   * while the turn keeps running.
   */
  question?: ClarifyingQuestion;
}

/** One clarifying question from the agent's `question` tool. */
export interface QuestionOption {
  id: string;
  label: string;
  description?: string;
}

export interface ClarifyingQuestion {
  questionId: string;
  header: string;
  question: string;
  options: QuestionOption[];
  multiple: boolean;
  /** The toolCallId that asked — used to correlate the answer. */
  toolCallId: string;
  /**
   * P2-4 rework (QA-CHATTABS Round B): the approval card's toolCallId
   * (`tc-<permission-request-id>`), linked when the engine's permission
   * request for this question arrives. The request's `source.id` is the
   * tool call id, so the link is exact even with several questions pending.
   * Answering the widget resolves that card as approve-once instead of
   * letting it hang to the 5-minute timeout.
   *
   * NOTE: this is NOT set from the `toolCall` event — the engine publishes
   * Tool.Called BEFORE the tool's execute fiber runs, and the question tool
   * only raises its approval card inside execute (permission.assert) — so
   * no card can exist yet at that point (the old wiring was dead code in
   * production, and could link the WRONG card with two questions pending).
   * It is set from the `questionApproval` turn event, which the adapter
   * emits when it actually creates the card.
   */
  approvalToolCallId?: string;
  /**
   * P3-2 (QA-CHATTABS-01): the mode of the turn that asked the question.
   * An answer submitted while idle steers with THIS mode, not the live UI
   * mode (which the user may have switched meanwhile).
   */
  mode?: ModeName;
}

export interface ThinkingBlock {
  text: string;
  durationMs: number;
  done: boolean;
}

export interface BubbleData {
  /** Optimistic client-assigned id (bubbleId). */
  bubbleId: string;
  /** Server-assigned id, reconciled after the round-trip. */
  serverBubbleId?: string;
  role: BubbleRole;
  mode: ModeName;
  /** Chunked-streamed markdown source. */
  text: string;
  thinking?: ThinkingBlock;
  toolCalls: ToolCallViewModel[];
  checkpointId?: string;
  /**
   * DD-AR-9 (turnSettled protocol): how this bubble's turn ended.
   * Set from the adapter's turnSettled event; undefined while running.
   */
  turnOutcome?: TurnOutcome;
  createdAt: number;
}

/**
 * DD-AR-9 — turnSettled protocol (Cursor 3.25.9, OBSERVED host 2402900-area):
 * turnSettled{turnId, outcome, interruptedBy?, stopReason?, error?} with
 * outcome ∈ COMPLETED | FAILED | INTERRUPTED. Replaces the divergent
 * MAX_STEPS_PROMPT injection with a clean stop-reason enum.
 */
export type TurnOutcome = "COMPLETED" | "FAILED" | "INTERRUPTED";
/** Who interrupted the turn: HOST (observed) or USER. */
export type TurnInterruptedBy = "HOST" | "USER";
/** stopReason: MAX_STEPS_REACHED (observed). */
export type TurnStopReason = "MAX_STEPS_REACHED";

export interface TurnSettled {
  type: "turnSettled";
  turnId: string;
  /**
   * Extension-side routing: the assistant bubble this turn streamed into.
   * (Cursor's mailbox event carries turnId only; we add bubbleId so the
   * composer can record the outcome on the right bubble.)
   */
  bubbleId: string;
  outcome: TurnOutcome;
  interruptedBy?: TurnInterruptedBy;
  stopReason?: TurnStopReason;
  error?: string;
}

/** Events a turn produces; the data service applies them to the bubble store. */
export type TurnEvent =
  | { type: "thinking"; bubbleId: string; text: string; durationMs: number }
  | { type: "textDelta"; bubbleId: string; delta: string }
  | { type: "toolCall"; bubbleId: string; toolCall: ToolCallViewModel }
  | { type: "toolCallDelta"; toolCallId: string; delta: Partial<ToolCallViewModel> }
  /**
   * P2-4 rework (QA-CHATTABS Round B): the adapter created an approval card
   * for a `question` tool call. `toolCallId` is the question's tool call id
   * (from the permission request's `source.id`); `approvalToolCallId` is
   * the card's toolCallId (`tc-<permission-request-id>`). The composer
   * records the link on the pending question so answering the widget
   * resolves the card.
   */
  | { type: "questionApproval"; toolCallId: string; approvalToolCallId: string }
  | { type: "reconcile"; clientBubbleId: string; serverBubbleId: string }
  /**
   * DD-AR-9 (turnSettled protocol): the adapter reports how the turn ended —
   * COMPLETED | FAILED | INTERRUPTED (+ interruptedBy / stopReason). The
   * composer records the outcome on the bubble instead of inferring it.
   */
  | TurnSettled
  | { type: "done" };
