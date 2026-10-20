import { ModeName, ToolCallViewModel, TurnEvent } from "../model";
import { ApprovalDetails, ApprovalResult } from "./humanReviewService";

export interface TurnContext {
  prompt: string;
  mode: ModeName;
  /** Assistant bubble the turn streams into. */
  bubbleId: string;
  /**
   * DD-AR-3 (resume-from-checkpoint): the human bubble the turn answers.
   * The "before" checkpoint is captured on this bubble, so the adapter
   * reads the resume checkpoint from it.
   */
  humanBubbleId?: string;
  /**
   * File attachments (browser-tab screenshots) — forwarded to the engine
   * prompt's `files` field so the agent receives the image bytes.
   */
  attachments?: { uri: string; name: string; description?: string }[];
}

/**
 * Engine model reference — mirrors the engine wire's Model.Ref
 * (packages/schema/src/model.ts): { id, providerID, variant? }.
 */
export interface ModelRef {
  id: string;
  providerID: string;
  variant?: string;
}

/**
 * One entry from the engine's model catalog (GET /api/model → Model.Info).
 */
export interface EngineModelInfo {
  id: string;
  providerID: string;
  /** Friendly display name (falls back to id when the engine omits it). */
  name: string;
  variant?: string;
  /**
   * Context window size, in tokens (DEV-GAPS-88).
   *
   * Cursor parity: `aiserver.v1.AvailableModelsResponse.AvailableModel`
   * carries `context_token_limit` (field 15, int32, optional) — JS name
   * `contextTokenLimit` (Cursor 3.25.9 workbench.glass.main.js, offset
   * ~1947656). The engine wire source is `Model.Info.limit.context`
   * (ide-code schema `packages/schema/src/model.ts`), mapped by
   * IdeCodeEngineAdapter; absent when the engine reports no limit —
   * never fabricated.
   */
  contextTokenLimit?: number;
  /**
   * Context window size in tokens when the model runs in Max Mode
   * (DEV-GAPS-88). Cursor: `context_token_limit_for_max_mode` (field 16
   * of the same AvailableModel message, JS `contextTokenLimitForMaxMode`).
   *
   * The ide-code engine has no Max Mode concept and its Model.Info wire
   * carries no such value, so the adapter never sets this — it stays
   * undefined rather than being filled with an invented number.
   */
  contextTokenLimitForMaxMode?: number;
}

/**
 * EngineAdapter — THE seam where the ide-code (OpenCode) core connects.
 * The real adapter will translate ide-code's agent session events into
 * TurnEvents; the chat UI above it never changes.
 */
export interface EngineAdapter {
  runTurn(ctx: TurnContext): AsyncIterable<TurnEvent>;
  /**
   * Abort the in-flight turn, if any. Called from the webview's Stop button
   * path (ComposerDataService.abort). Implementations should kill their
   * network/streaming work promptly and end their runTurn generator cleanly
   * (no spurious "Engine error" yields — the composer posts the
   * "Turn stopped by user" note itself).
   */
  abortTurn(): void;
  /**
   * Optional: list the models the engine can run (M-03 model picker).
   * Absent = this engine has no model catalog (e.g. the scripted stub) —
   * the picker then explains honestly instead of faking a list.
   */
  listModels?(): Promise<EngineModelInfo[]>;
  /**
   * Optional: the engine's default model (used when no explicit model is
   * selected). Absent or undefined = unknown; "auto" then just means "no
   * explicit selection".
   */
  getDefaultModel?(): Promise<EngineModelInfo | undefined>;
  /**
   * Optional: switch the model for the engine session(s).
   * `ref` undefined = clear the explicit selection: future sessions are
   * created without a model (engine default); already-running sessions are
   * switched to the engine default when one is known, otherwise left alone.
   */
  setModel?(ref: ModelRef | undefined): Promise<void>;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * StubEngineAdapter — scripted turn demonstrating the full lifecycle:
 * thinking → tool-call card (pending → running → approval → done) →
 * chunked text streaming → server-id reconciliation.
 * Replace with the real ide-code core adapter; the UI contract is TurnEvent.
 */
export class StubEngineAdapter implements EngineAdapter {
  constructor(
    private readonly requestApproval: (
      toolCallId: string,
      title: string,
      reasons: string[],
      /** P1 (QA-CHATTABS-01): stable allowlist identity (action+resources). */
      allowlistIdentity?: string,
      /** GAPS-12: file-edit diff payload (unused by the stub's scripted card). */
      approvalDetails?: ApprovalDetails,
      /** GAPS-22B: shell/terminal candidate labels (unused by the stub). */
      allowlistCandidates?: readonly string[],
      /** DEV-GAPS-66/W66A: engine tool identity (binary `clientSideTool`). */
      clientSideTool?: string,
    ) => Promise<ApprovalResult>,
  ) {}
  /** P1 (QA-FILE-01): Stop button — the stub's scripted turn is interruptible between yields. */
  private stubAborted = false;
  abortTurn(): void {
    this.stubAborted = true;
  }

  async *runTurn(ctx: TurnContext): AsyncIterable<TurnEvent> {
    this.stubAborted = false;
    yield { type: "thinking", bubbleId: ctx.bubbleId, text: "Planning how to answer (stub engine)…", durationMs: 900 };
    await sleep(900);
    if (this.stubAborted) { return; }

    const toolCall: ToolCallViewModel = {
      toolCallId: `tc-${Date.now().toString(36)}`,
      kind: "read",
      title: "read package.json",
      status: "pending",
      description: "Waiting for approval",
      outputPreview: "",
      expanded: false,
    };
    yield { type: "toolCall", bubbleId: ctx.bubbleId, toolCall };
    yield {
      type: "toolCallDelta",
      toolCallId: toolCall.toolCallId,
      delta: { status: "running", description: "Reading package.json…" },
    };

    const decision = await this.requestApproval(toolCall.toolCallId, toolCall.title, [
      "Stub engine wants to demonstrate the approval card.",
      "No real file access happens in the scaffold.",
    ], undefined, undefined, undefined, toolCall.kind);
    if (!decision || decision.optionId === "skip") {
      yield {
        type: "toolCallDelta",
        toolCallId: toolCall.toolCallId,
        delta: { status: "failed", description: "Skipped by user" },
      };
    } else {
      await sleep(600);
      const note = decision.optionId === "approve-allowlist" ? " (allowlisted for this session)" : "";
      yield {
        type: "toolCallDelta",
        toolCallId: toolCall.toolCallId,
        delta: {
          status: "done",
          description: `Read 14 lines${note}`,
          outputPreview: '{\n  "name": "ide-agent",\n  "version": "0.1.0"\n}',
        },
      };
    }

    const chunks = [
      "This is a **stubbed** agent turn demonstrating the bubble pipeline: ",
      "optimistic client bubble → thinking block → tool-call card with approval → ",
      "chunked text streaming → server ID reconciliation. ",
      "Wire `StubEngineAdapter` to the ide-code core to go live.",
    ];
    for (const chunk of chunks) {
      await sleep(220);
      if (this.stubAborted) { return; }
      yield { type: "textDelta", bubbleId: ctx.bubbleId, delta: chunk };
    }
    yield { type: "reconcile", clientBubbleId: ctx.bubbleId, serverBubbleId: `srv-${Date.now().toString(36)}` };
    yield { type: "done" };
  }
}
