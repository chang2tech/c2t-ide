import * as vscode from "vscode";
import type { MessageQueueService } from "./messageQueueService";
import type { DebugServerService } from "./debugServerService";

/**
 * DEV-DEBUG-HOLD-UI — per-chat Debug mode controller
 * (dig-debug-multitask-2026-10-19.md §3: D4 dispatch hold, D5 Debug Logs UI +
 * proceed flow, D6 entry guards).
 *
 * Cursor's Debug loop: the agent instruments code and asks the user to
 * reproduce the bug; while the user reproduces, queue dispatch is HELD
 * (`heldForDebugRepro` / `debugReproWaitingForUser`) and the chat renders a
 * live "Debug Logs" block. Enter on an empty input submits the VERBATIM
 * proceed instruction; a mark-fixed flow submits the VERBATIM cleanup
 * instruction. Any other user message also ends the wait.
 *
 * GAP (documented, not invented): runTurn's drain loop in
 * composerDataService drains the queue without consulting
 * `queue.isDispatchHeld()`. The hold is honored by the dispatch decision
 * point (`tryDispatchNextQueueItem`) and cleared by `releaseDispatchHold`;
 * wiring the loop to consult the hold needs a composerDataService edit that
 * is outside this task's scope.
 */

/** [BIN verbatim] experiment config `proceed_instructions`. */
export const DEBUG_PROCEED_INSTRUCTIONS = "Issue reproduced, please proceed";

/** [BIN verbatim] experiment config `mark_fixed_instructions`. */
export const DEBUG_MARK_FIXED_INSTRUCTIONS =
  "The issue has been fixed. Please clean up the instrumentation.";

/** Verbatim UI strings (spec §2/§3.5 [BIN]). */
export const DEBUG_LOGS_TITLE = "Debug Logs";
export const DEBUG_LOGS_EMPTY = "Waiting for log entries...";

/**
 * Minimal ComposerDataService surface the controller needs. Structural (not
 * the concrete class) so node:test can pass a mock.
 */
export interface DebugModeControllerDeps {
  /** Submit a user message — the verbatim proceed/mark-fixed instructions go through here. */
  submit(prompt: string): void;
  /** The chat's message queue — the D4 dispatch hold lives here. */
  readonly queue: MessageQueueService;
  /** Current per-chat mode. */
  modes: { getMode(): string };
  /** Per-chat NDJSON ingest server (additive `getDebugServer()` getter). */
  getDebugServer(): Pick<DebugServerService, "onLine" | "getRecentLines">;
}

export class DebugModeController implements vscode.Disposable {
  /** Spec D4: `debugReproWaitingForUser`. */
  private debugReproWaitingForUser = false;
  private readonly disposables: vscode.Disposable[] = [];
  /**
   * Spec §7 UNKNOWN #3: the binary's Debug Logs block constants
   * (100/500/80/250) have unknown semantics, so we do not invent meanings
   * for them. Forwarded HISTORY is capped at 100 lines (matching
   * DebugServerService.getRecentLines' default); the webview caps rendering
   * at 100 lines too.
   */
  private static readonly MAX_FORWARDED_LINES = 100;

  constructor(
    private readonly deps: DebugModeControllerDeps,
    private readonly postToWebview: (message: unknown) => void,
  ) {
    // D5: live NDJSON feed → webview `debugLogLine` messages.
    this.disposables.push(this.deps.getDebugServer().onLine((line) => this.onDebugLogLine(line)));
  }

  /** Whether we are currently waiting for the user to reproduce the bug. */
  isWaitingForUser(): boolean {
    return this.debugReproWaitingForUser;
  }

  /**
   * Spec D4: called when a debug-mode turn ends (the agent has instrumented
   * and asked for a repro). Sets waitingForUser, sets the queue dispatch
   * hold, replays buffered log history, and notifies the webview
   * (`debugState`).
   */
  onDebugTurnSettled(): void {
    this.debugReproWaitingForUser = true;
    this.deps.queue.setDispatchHold(true);
    this.pushRecentLines();
    this.notifyState();
  }

  /**
   * Spec D4/D5: the user pressed Enter on an empty input or clicked
   * Proceed — submit the VERBATIM proceed instruction as a user message,
   * clear the wait, and release the hold (Cursor's
   * `retryDispatchHeldForDebugRepro`).
   */
  proceed(): void {
    this.deps.submit(DEBUG_PROCEED_INSTRUCTIONS);
    this.clearWaitAndRelease();
  }

  /**
   * Spec D4/D5: mark-fixed flow — submit the VERBATIM cleanup instruction,
   * clear the wait, and release the hold.
   */
  markFixed(): void {
    this.deps.submit(DEBUG_MARK_FIXED_INSTRUCTIONS);
    this.clearWaitAndRelease();
  }

  /** Any normal user message submit also clears the wait and releases the hold. */
  onUserSubmit(): void {
    this.clearWaitAndRelease();
  }

  /**
   * Spec D2: leaving debug mode releases held dispatches
   * (`retryDispatchHeldForDebugRepro`). Entering (or re-entering) debug
   * replays buffered lines so the block shows what already arrived.
   */
  onModeChanged(isDebug: boolean): void {
    if (isDebug) {
      this.pushRecentLines();
    } else {
      this.debugReproWaitingForUser = false;
      this.deps.queue.releaseDispatchHold();
    }
    this.notifyState();
  }

  /** Initial state for a freshly resolved webview (buffered until ready). */
  syncInitialState(): void {
    this.pushRecentLines();
    this.notifyState();
  }

  private clearWaitAndRelease(): void {
    this.debugReproWaitingForUser = false;
    this.deps.queue.releaseDispatchHold();
    this.notifyState();
  }

  /** D5: forward a newly ingested NDJSON line to the webview (`debugLogLine`). */
  private onDebugLogLine(line: string): void {
    this.postToWebview({ type: "debugLogLine", line });
  }

  /**
   * Push buffered history (capped at 100 lines) so a re-resolved webview or
   * a fresh debug session shows what already arrived. The webview replaces
   * its rendered lines with history, then appends live `debugLogLine`s.
   */
  private pushRecentLines(): void {
    const lines = this.deps
      .getDebugServer()
      .getRecentLines(DebugModeController.MAX_FORWARDED_LINES);
    if (lines.length > 0) {
      this.postToWebview({ type: "debugLogHistory", lines });
    }
  }

  private notifyState(): void {
    this.postToWebview({
      type: "debugState",
      active: this.deps.modes.getMode() === "debug",
      waitingForUser: this.debugReproWaitingForUser,
    });
  }

  dispose(): void {
    for (const d of this.disposables) {
      d.dispose();
    }
  }
}
