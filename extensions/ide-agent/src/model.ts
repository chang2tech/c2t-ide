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
export type ModeName = "agent" | "chat" | "plan" | "edit" | "debug" | "background" | "multitask";

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
  createdAt: number;
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
  | { type: "done" };
