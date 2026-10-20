/**
 * Chat jump-between-messages — host-side glue + the binary-verbatim
 * navigation algorithm (DEV-GAPS-119, `chat-jump-messages-kbd`).
 *
 * QA step 1 = CONFIRMED on Cursor 3.25.9 (see
 * docs/rea/work-notes-gaps119.md for the full dissection):
 *
 * - Docs (https://cursor.com/docs/release-notes, "Move through long
 *   conversations from the keyboard."): "Press Cmd/Ctrl+Up or
 *   Cmd/Ctrl+Down to jump between your messages, and Cmd/Ctrl+Shift+Up or
 *   Cmd/Ctrl+Shift+Down to jump to the top or bottom of the conversation.
 *   The shortcuts also work while the prompt has focus, as long as it's
 *   empty."
 * - Commands (workbench.glass.main.js @45371395-45371863, registrar `Ir`):
 *     jumpToNextUserMessage     "Jump to Next User Message"     f1:!1
 *     jumpToPrevUserMessage     "Jump to Previous User Message" f1:!1
 *     scrollAgentPanelToTop     "Scroll Agent Panel to Top"     f1:!1
 *     scrollAgentPanelToBottom "Scroll Agent Panel to Bottom"  f1:!1
 *   (ids from the id table @25984829-25984921; glassCategory "Agent",
 *   keybinding weight `yk=250` @45343381.)
 * - Keybindings (@45335715):
 *     WQb = [CtrlCmd|UpArrow,   CtrlCmd|Shift|KeyU]  (prev)
 *     GQb = [CtrlCmd|DownArrow, CtrlCmd|Shift|KeyY]  (next)
 *   First entry carries `when: gno`, the second entry has NO when.
 *   Top = CtrlCmd|Shift|UpArrow, Bottom = CtrlCmd|Shift|DownArrow,
 *   both with `when: gno`.
 *     gno = !glassEditorPanelFocused && !terminalFocusInAny
 *           && (!inputFocus || glassPromptInputEmpty)
 * - Runtime: the commands emit on the glass event bus —
 *   {type:"jumpToNextUserMessageRequested"},
 *   {type:"jumpToPrevUserMessageRequested"},
 *   {type:"agentPanelScrollToEdgeRequested", payload:{direction:-1|1}} —
 *   and the AgentPanel handler (@44528112) forwards them to the transcript
 *   session's jumpToNextHumanMessage / jumpToPrevHumanMessage /
 *   scrollToEdge (composerReactTranscriptCommands.js, in BOTH bundles:
 *   glass @25908293, desk @28640600).
 *
 * Fork wiring (mirrors the Find-in-Chat precedent, DEV-GAPS-29): the
 * workbench-core Action2s live in contrib/composer/browser/
 * composerActions.ts under the binary-verbatim ids/titles and delegate to
 * the `ide.*` runtime commands registered in extension.ts, which post the
 * binary-verbatim *Requested events to the ACTIVE chat surface's webview
 * via makeChatAttachHost(). The webview (components/composer.ts) owns the
 * rendered transcript and performs the scroll with the algorithm below.
 */

/* ------------------------------------------------------------------ */
/* Binary-verbatim ids, titles and webview event types.                */
/* ------------------------------------------------------------------ */

/** Core/extension command ids (binary id table, glass @25984888). */
export const JUMP_TO_NEXT_USER_MESSAGE_ID = "jumpToNextUserMessage";
export const JUMP_TO_PREV_USER_MESSAGE_ID = "jumpToPrevUserMessage";
export const SCROLL_AGENT_PANEL_TO_TOP_ID = "scrollAgentPanelToTop";
export const SCROLL_AGENT_PANEL_TO_BOTTOM_ID = "scrollAgentPanelToBottom";

/** Runtime commands the core Action2s delegate to (fork `ide.*` layer). */
export const IDE_JUMP_TO_NEXT_USER_MESSAGE_ID = "ide.jumpToNextUserMessage";
export const IDE_JUMP_TO_PREV_USER_MESSAGE_ID = "ide.jumpToPrevUserMessage";
export const IDE_SCROLL_AGENT_PANEL_TO_TOP_ID = "ide.scrollAgentPanelToTop";
export const IDE_SCROLL_AGENT_PANEL_TO_BOTTOM_ID = "ide.scrollAgentPanelToBottom";

/** Command titles (binary-verbatim, glass @45371395-45371863). */
export const JUMP_TO_NEXT_USER_MESSAGE_TITLE = "Jump to Next User Message";
export const JUMP_TO_PREV_USER_MESSAGE_TITLE = "Jump to Previous User Message";
export const SCROLL_AGENT_PANEL_TO_TOP_TITLE = "Scroll Agent Panel to Top";
export const SCROLL_AGENT_PANEL_TO_BOTTOM_TITLE = "Scroll Agent Panel to Bottom";

/** Webview event types — the binary's glass event-bus names, verbatim. */
export const JUMP_TO_NEXT_USER_MESSAGE_REQUESTED = "jumpToNextUserMessageRequested";
export const JUMP_TO_PREV_USER_MESSAGE_REQUESTED = "jumpToPrevUserMessageRequested";
export const AGENT_PANEL_SCROLL_TO_EDGE_REQUESTED = "agentPanelScrollToEdgeRequested";

/** Webview → host message reporting whether the chat prompt is empty. */
export const INPUT_EMPTY = "inputEmpty";
/** Legacy context key the hosts set from INPUT_EMPTY (core mirrors it to
 *  `composer.chatInputEmpty` via composerContextKeysBridge). This is the
 *  fork's analog of the binary's `glassPromptInputEmpty` context key
 *  (glassContextKeys.js @23559271, `ARl`). */
export const CHAT_INPUT_EMPTY_CONTEXT_KEY = "ideAgent.chatInputEmpty";

/* ------------------------------------------------------------------ */
/* The navigation algorithm (composerReactTranscriptCommands.js).      */
/* ------------------------------------------------------------------ */

/** One jump target: a rendered human ("user") row of the transcript. */
export interface HumanRowTarget {
  rowKey: string;
  /** The row's top edge in transcript content coordinates (binary: the
   *  plane's `getRowPlacement(rowKey).topPx`). */
  absoluteTop: number;
}

/**
 * Binary threshold: the current scroll position only counts as "at" a
 * human row within ±2px — next = first target with
 * `absoluteTop > scrollTop + 2`, prev = last target with
 * `absoluteTop < scrollTop - 2` (glass @25908293, desk @28640600).
 */
export const HUMAN_ROW_JUMP_EPSILON_PX = 2;

/**
 * Binary `jumpToNextHumanMessage`:
 *   targets.find(r => r.absoluteTop > scrollTop + 2)?.rowKey
 * No wrap-around: past the last human message this returns undefined and
 * the caller no-ops.
 */
export function pickNextHumanRowKey(
  targets: readonly HumanRowTarget[],
  scrollTop: number,
): string | undefined {
  return targets.find((r) => r.absoluteTop > scrollTop + HUMAN_ROW_JUMP_EPSILON_PX)?.rowKey;
}

/**
 * Binary `jumpToPrevHumanMessage`:
 *   let r; for (const s of targets) s.absoluteTop < scrollTop - 2 && (r = s.rowKey); return r
 * i.e. the LAST target above the current position (targets are in
 * transcript order). No wrap-around.
 */
export function pickPrevHumanRowKey(
  targets: readonly HumanRowTarget[],
  scrollTop: number,
): string | undefined {
  let rowKey: string | undefined;
  for (const s of targets) {
    if (s.absoluteTop < scrollTop - HUMAN_ROW_JUMP_EPSILON_PX) {
      rowKey = s.rowKey;
    }
  }
  return rowKey;
}

/**
 * Binary `scrollToEdge(direction)`: `commands.scrollBy("document", dir)` —
 * direction -1 scrolls to the very top of the conversation, +1 to the
 * very bottom. Returns the target scrollTop for a container.
 */
export function scrollTopForEdge(
  direction: -1 | 1,
  scrollHeight: number,
  clientHeight: number,
): number {
  return direction < 0 ? 0 : Math.max(0, scrollHeight - clientHeight);
}

/* ------------------------------------------------------------------ */
/* The `gno` when-clause, as a pure predicate (pinned by tests).       */
/* ------------------------------------------------------------------ */

export interface JumpKeyContext {
  /** Binary `glassEditorPanelFocused`. Fork port: a code editor has
   *  text focus (core when uses `!editorTextFocus`). */
  editorPanelFocused: boolean;
  /** Binary + stock VS Code: `terminalFocusInAny`. */
  terminalFocusInAny: boolean;
  /** Binary `inputFocus` (uW). In the BINARY this one signal covers the
   *  prompt, because the prompt is core DOM there. In this FORK it is
   *  only the host-DOM signal (stock `InputFocusedContext`): the host
   *  document's activeElement is the webview IFRAME while the chat
   *  prompt is focused, so this stays false in that scenario
   *  (NF-136-1). Callers must ALSO pass `chatInputFocused` below. */
  inputFocus: boolean;
  /** Fork-only adaptation signal (NF-136-1 / GAPS-141): the chat prompt
   *  inside the webview has focus — first-hand from the webview
   *  ({type:'inputFocus'} focus/blur posts -> hosts setContext
   *  `ideAgent.chatInputFocused` -> core `composer.chatInputFocused`).
   *  Optional for backward compatibility with pre-fix callers/tests;
   *  defaults to false, which reproduces the old (buggy in the webview
   *  scenario) single-signal formula. */
  chatInputFocused?: boolean;
  /** Binary `glassPromptInputEmpty`; fork: `composer.chatInputEmpty`. */
  promptInputEmpty: boolean;
}

/**
 * Binary `gno = and(GMe.negate(), is.focusInAny.negate(),
 * or(uW.negate(), ARl))` (glass @45335715) — with the fork adaptation
 * of NF-136-1 / GAPS-141: uW is split into the host-DOM signal
 * (`inputFocus`) and the webview prompt signal (`chatInputFocused`),
 * mirroring the core when-clause in composerActions.ts
 * (`chatJumpMessagesWhen`):
 *   or(and(!inputFocus, !composer.chatInputFocused), chatInputEmpty)
 * Checked (GAPS-141): this predicate has NO runtime caller in the
 * extension — the live gate is the core when-clause — so the split is
 * for consistency/pinning only; the webview-side focus signal itself
 * is first-hand and was already correct.
 */
export function jumpKeybindingWhenMatches(ctx: JumpKeyContext): boolean {
  return (
    !ctx.editorPanelFocused &&
    !ctx.terminalFocusInAny &&
    ((!ctx.inputFocus && !ctx.chatInputFocused) || ctx.promptInputEmpty)
  );
}

/* ------------------------------------------------------------------ */
/* Host-side posting (same seam shape as findInChat.ts).               */
/* ------------------------------------------------------------------ */

/** Minimal host surface — anything that can post to the chat webview. */
export interface ChatJumpHost {
  postToWebview(message: unknown): void;
}

/** Post the binary's `jumpToNextUserMessageRequested` event. */
export function jumpToNextUserMessage(host: ChatJumpHost): void {
  host.postToWebview({ type: JUMP_TO_NEXT_USER_MESSAGE_REQUESTED });
}

/** Post the binary's `jumpToPrevUserMessageRequested` event. */
export function jumpToPrevUserMessage(host: ChatJumpHost): void {
  host.postToWebview({ type: JUMP_TO_PREV_USER_MESSAGE_REQUESTED });
}

/** Post the binary's `agentPanelScrollToEdgeRequested` event (-1 = top). */
export function scrollAgentPanelToEdge(host: ChatJumpHost, direction: -1 | 1): void {
  host.postToWebview({
    type: AGENT_PANEL_SCROLL_TO_EDGE_REQUESTED,
    payload: { direction },
  });
}
