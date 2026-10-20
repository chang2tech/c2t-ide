/**
 * Find in Chat — host-side glue for the composer.find.* family.
 *
 * The chat surface is a webview, and the VS Code native find widget cannot
 * search inside a webview, so the find bar lives in the webview itself
 * (see components/composer.ts — FIND-IN-CHAT). The host only tells the
 * ACTIVE chat surface's webview what to do:
 *   { type: "showFindInChat" }     → overlay bar appears, searches the rendered
 *                                    transcript, highlights matches, Enter jumps.
 *   { type: "hideFindInChat" }     → bar hides, DOM focus returns to the input.
 *   { type: "findNextInChat" }     → advance to the next match.
 *   { type: "findPreviousInChat" } → go back to the previous match.
 *
 * Keybindings (binary-verbatim composer.find.focus/next/previous/hide) are
 * declared in workbench core — src/vs/workbench/contrib/composer/browser/composerActions.ts
 * (ComposerFindInChatAction / ComposerHideFindInChatAction /
 * ComposerFindNextInChatAction / ComposerFindPreviousInChatAction) — and
 * delegate to the ide.* commands registered in extension.ts. The find widget
 * reports its open/close state back to the host (webview message
 * {type:'findBarState', open:boolean}), which sets the verbatim context key
 * `composerFindWidgetFocused` so the core next/previous/hide keybindings
 * fire only while the bar is open (binary when-clauses).
 */

/** Webview message types understood by the composer's find bar. */
export const SHOW_FIND_IN_CHAT = "showFindInChat";
export const HIDE_FIND_IN_CHAT = "hideFindInChat";
export const FIND_NEXT_IN_CHAT = "findNextInChat";
export const FIND_PREVIOUS_IN_CHAT = "findPreviousInChat";
/** Webview → host message reporting the find bar's open/close state. */
export const FIND_BAR_STATE = "findBarState";

/**
 * GAPS-134 (`chat-find-in-chat-pane-level`): context keys maintained from
 * the findBarState report. `composerFindWidgetFocused` is the DEV-GAPS-29
 * key for the old `composer.find.*` family; `glassChatFindBarVisible` /
 * `glassChatFindInputFocused` are the VERBATIM Cursor 3.25.9 keys
 * (workbench.glass.main.js @23559549 / @23559590) gating the pane-level
 * `showChatFind` / `hideChatFind` / `nextChatFindMatch` /
 * `previousChatFindMatch` family in workbench core. The webview reports
 * `inputFocused` alongside `open` (its find input is the only find input
 * on the chat surface; findShow() focuses it synchronously).
 */
export const COMPOSER_FIND_WIDGET_FOCUSED_KEY = "composerFindWidgetFocused";
export const GLASS_CHAT_FIND_BAR_VISIBLE_KEY = "glassChatFindBarVisible";
export const GLASS_CHAT_FIND_INPUT_FOCUSED_KEY = "glassChatFindInputFocused";

/** Shape of the webview → host find-bar state report. */
export interface FindBarStateReport {
  open: boolean;
  inputFocused?: boolean;
}

/**
 * Pure mapping from a findBarState report to the context-key updates the
 * host must apply via `setContext` — one source of truth so BOTH chat
 * surfaces (sidebar view + chat editor tab) keep all three keys in sync.
 * `glassChatFindInputFocused` can only be true while the bar is open
 * (a closed bar's input cannot hold focus; the webview also reports
 * inputFocused:false on hide, this clamp keeps the keys truthful even
 * for a stale/racing report).
 */
export function findBarContextUpdates(report: FindBarStateReport): Array<readonly [string, boolean]> {
  const open = report.open === true;
  const inputFocused = open && report.inputFocused === true;
  return [
    [COMPOSER_FIND_WIDGET_FOCUSED_KEY, open],
    [GLASS_CHAT_FIND_BAR_VISIBLE_KEY, open],
    [GLASS_CHAT_FIND_INPUT_FOCUSED_KEY, inputFocused],
  ];
}

/** Minimal host surface — anything that can post to the chat webview. */
export interface FindInChatHost {
  postToWebview(message: unknown): void;
}

/**
 * Show the find bar in the active chat surface's webview.
 * The caller (extension.ts) resolves the host to the active surface —
 * sidebar view or chat editor tab — via makeChatAttachHost().
 */
export function showFindInChat(host: FindInChatHost): void {
  host.postToWebview({ type: SHOW_FIND_IN_CHAT });
}

/** Hide the find bar; the webview returns focus to the composer input. */
export function hideFindInChat(host: FindInChatHost): void {
  host.postToWebview({ type: HIDE_FIND_IN_CHAT });
}

/**
 * Advance the find bar to the next match (binary `composer.find.next`,
 * F3 / Enter). The host only forwards the intent — the webview owns the
 * <mark> highlights. Harmless no-op when the bar is closed (the core
 * keybinding's when-clause gates it anyway).
 */
export function findNextInChat(host: FindInChatHost): void {
  host.postToWebview({ type: FIND_NEXT_IN_CHAT });
}

/**
 * Go back to the previous match (binary `composer.find.previous`,
 * Shift+F3 / Shift+Enter). Same no-op-when-closed semantics as findNextInChat.
 */
export function findPreviousInChat(host: FindInChatHost): void {
  host.postToWebview({ type: FIND_PREVIOUS_IN_CHAT });
}
