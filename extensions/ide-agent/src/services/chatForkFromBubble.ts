import * as vscode from "vscode";
import type { BubbleData } from "../model";
import { dedupeDuplicateName } from "./chatDuplicateService";
import type { ChatTab, ChatTabService } from "./chatTabService";

/**
 * chatForkFromBubble — per-message "Fork Chat" (Cursor parity).
 *
 * Binary evidence (Cursor 3.25.9, workbench.desktop.main.js — verified
 * 2026-10-20 against the extracted squashfs):
 *
 * - Message-level entry point: the `jav` component in
 *   `AgentTranscriptTurnActions.js` — prop `onForkChat`, tooltip
 *   "Fork Chat", button label "Fork chat" (busy: "Forking chat" with an
 *   indeterminate ring), "split" icon, tertiary tone. It is a per-turn
 *   action in the agent transcript (the "..." menu on the message is the
 *   same entry point staff describe as "Duplicate Chat" on
 *   forum.cursor.com/t/reverting-changes-does-not-reset-the-context/148549 —
 *   the staff label differs from the shipped binary label "Fork Chat"; the
 *   binary is authoritative, so the shipped label is "Fork Chat").
 * - Command `composer.duplicateChat` (title "Fork Chat", category `Cursor`,
 *   f1:true) takes args `{sourceComposerId, bubbleId,
 *   preferredTargetGroupId}`:
 *   - "Fork is not available for Cloud Agent chats." (this fork has no
 *     cloud-agent target — N/A here)
 *   - `loadConversationFromBubble(y, bubbleId)` loads the conversation
 *     prefix, then: `x = headers.slice(0, V+1)` — retain everything through
 *     the selected bubble INCLUSIVE — and when the bubble right after the
 *     selected one is an AI bubble it is retained too
 *     (`Y.type===Tr.AI && x.push(Y)`); the conversation map is rebuilt to
 *     the retained bubbles only.
 *   - The fork is created via `deepCloneComposer` (fresh composer id),
 *     name deduped with `js0()` from "composerForkNameUtils.js": strip an
 *     existing "(N) " prefix, then the first free "(1) <name>", "(2) <name>",
 *     ...; createdAt/lastUpdatedAt = now; telemetry `composer.duplicate_tab`.
 *
 * Mapping to this codebase's architecture (ide-agent extension composer):
 * - Cursor's header list ≅ the composer's `bubbles.getAllInOrder()`.
 * - `slice(0,V+1)` + include-next-assistant-bubble is implemented in
 *   `computeForkPrefix` below (verbatim semantics: the NEXT bubble is
 *   retained iff it is an assistant bubble, regardless of the selected
 *   bubble's role — exactly as the binary checks `Y.type===Tr.AI`).
 * - `deepCloneComposer` ≅ the same deep-copy pattern the existing
 *   `ide.forkChat` (extension.ts) and the orphaned `duplicateChatTab`
 *   (chatDuplicateService.ts) use: fresh client bubble ids from the target
 *   composer's store, `serverBubbleId` cleared (the fork has no server
 *   session yet), tool calls + thinking deep-copied so a still-streaming
 *   source tab cannot mutate the fork. What is NOT carried: the engine
 *   session, the pending message queue (transient turn state of the source
 *     tab — Cursor's forkBubbleId path truncates the TRANSCRIPT only), and
 *   checkpoint records (the fork's CheckpointService starts empty; restore
 *   on a cloned bubble degrades to the existing "no checkpoint found"
 *   warning — same as `ide.forkChat`).
 *
 * HONEST-UNKNOWN: whether Cursor also copies the source tab's queued
 * messages on a bubble-level fork is not observable from the binary's
 * header-truncation logic; the queue is NOT copied here and the info
 * message tells the user exactly that.
 */

/** Thrown when the fork target bubble cannot be resolved in the tab. */
export class ForkFromBubbleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ForkFromBubbleError";
  }
}

/**
 * Cursor 3.25.9 `composer.duplicateChat` truncation semantics (verbatim):
 * retain the transcript through the selected bubble INCLUSIVE; then, when
 * the bubble immediately after the selected one is an ASSISTANT bubble,
 * retain it too (binary: `Y.type===Tr.AI && x.push(Y)`). Forking from the
 * latest bubble keeps the whole transcript.
 *
 * @throws {ForkFromBubbleError} when the bubble id is unknown or there is
 * nothing to fork.
 */
export function computeForkPrefix(
  bubbles: readonly BubbleData[],
  bubbleId: string,
): BubbleData[] {
  if (bubbles.length === 0) {
    throw new ForkFromBubbleError(
      "IDE Agent: this chat has no messages to fork from.",
    );
  }
  const idx = bubbles.findIndex((b) => b.bubbleId === bubbleId);
  if (idx < 0) {
    throw new ForkFromBubbleError(
      "IDE Agent: the message to fork from was not found in this chat.",
    );
  }
  const retained = bubbles.slice(0, idx + 1);
  const next = bubbles[idx + 1];
  if (next && next.role === "assistant") {
    retained.push(next);
  }
  return retained;
}

/** Deep-copy one bubble into the fork's id space (mirror of `ide.forkChat`). */
function cloneBubbleForFork(
  target: ChatTab,
  source: BubbleData,
): BubbleData {
  return {
    ...source,
    bubbleId: target.composer.bubbles.newClientBubbleId(),
    serverBubbleId: undefined,
    text: source.text,
    // Detach: a still-streaming source tab mutates thinking/toolCalls
    // in place; a shared reference would corrupt the fork mid-turn.
    thinking: source.thinking ? structuredClone(source.thinking) : undefined,
    toolCalls: source.toolCalls.map((tc) => structuredClone(tc)),
  };
}

export interface ForkFromBubbleResult {
  /** The newly created fork tab (registered with the tab service). */
  tab: ChatTab;
  /** Transcript bubbles copied into the fork. */
  retainedCount: number;
  /** Id of the source tab (untouched). */
  sourceTabId: string;
}

/**
 * Fork a chat tab from one message: new tab seeded with the transcript
 * prefix per `computeForkPrefix`, same mode + model selection, fresh
 * session. The source tab is untouched. The caller reveals the new tab
 * (this service owns no UI).
 *
 * @throws {ForkFromBubbleError} when the bubble id is unknown.
 */
export function forkTabFromBubble(
  tabs: ChatTabService,
  sourceTab: ChatTab,
  bubbleId: string,
): ForkFromBubbleResult {
  const retained = computeForkPrefix(
    sourceTab.composer.bubbles.getAllInOrder(),
    bubbleId,
  );
  // Cursor js0() name rule (composerForkNameUtils.js): strip an existing
  // "(N) " prefix, then the first free "(1) <name>", "(2) <name>", ...
  const title = dedupeDuplicateName(
    sourceTab.title,
    tabs.listTabs().map((t) => t.title),
  );
  const fork = tabs.createTab({
    title,
    mode: sourceTab.composer.modes.getMode(),
  });
  const copies = retained.map((b) => cloneBubbleForFork(fork, b));
  fork.composer.bubbles.appendBubbles(copies);
  // Same model continues in the branch (same as the whole-tab duplicate).
  fork.composer.models.setSelection(
    structuredClone(sourceTab.composer.models.getSelection()),
  );
  // HONEST-DIVERGENCE (telemetry): Cursor emits trackEvent("composer.duplicate_tab")
  // at the fork site (binary 3.25.9, workbench.glass.main.js — verified
  // 2026-10-20: r.trackEvent("composer.duplicate_tab") beside the
  // deepCloneComposer fork). This path has no telemetry seam: there is no
  // analytics backend in the fork (same as composerDataService DEV-GAPS-16),
  // so no event is emitted — this is a documented gap, not a silent drop.
  return {
    tab: fork,
    retainedCount: copies.length,
    sourceTabId: sourceTab.id,
  };
}

/**
 * Notify the user what the fork did and did not copy (the fork has no
 * server session yet and the pending queue stays with the source tab —
 * Cursor's forkBubbleId path truncates the transcript only).
 */
export function forkInfoMessage(result: ForkFromBubbleResult): string {
  return (
    "IDE Agent: forked chat from that message — " +
    `${result.retainedCount} message(s) copied into a new tab; ` +
    "the agent session starts fresh there. Pending queued messages stay " +
    "with the original tab."
  );
}

/** Convenience: run a fork and surface errors to the user. Returns the
 * fork result, or undefined when the bubble could not be resolved. */
export async function tryForkTabFromBubble(
  tabs: ChatTabService,
  sourceTab: ChatTab,
  bubbleId: string,
): Promise<ForkFromBubbleResult | undefined> {
  try {
    return forkTabFromBubble(tabs, sourceTab, bubbleId);
  } catch (err) {
    const m = err instanceof Error ? err.message : String(err);
    void vscode.window.showErrorMessage(m);
    return undefined;
  }
}
