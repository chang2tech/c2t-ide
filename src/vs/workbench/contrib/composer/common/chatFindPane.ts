/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// GAPS-134 (`chat-find-in-chat-pane-level`, 2026-10-20): pure spec +
// predicate for Cursor's pane-level Find in Chat family — the glass-layer
// sibling of the older `composer.find.*` family (DEV-GAPS-29). Kept free of
// vscode imports so the when-clause semantics are unit-testable standalone
// (see the GAPS-134 static/pure tests); `composerActions.ts` builds the
// real ContextKeyExpr from the same shape.
//
// Binary spec (Cursor 3.25.9, workbench.glass.main.js, verified first-hand
// by GAPS-130 + re-verified by GAPS-134):
//   ids (decl @25980630): showChatFind / hideChatFind / nextChatFindMatch /
//     previousChatFindMatch — bare, unprefixed; `glass.*` aliases exist
//     ONLY for hide/next/previous (consumed via executeCommand from the
//     glass React find bar).
//   registrations (QJi @45496556–45497364): titles "Find in Chat" /
//     "Close Find in Chat" / "Find Next in Chat" / "Find Previous in
//     Chat"; ALL keybindings weight gp+7 = 257 (gp=250 @45469675);
//     show = CtrlCmd+F when YRx, f1:{when:isGlassAgentSelected};
//     hide = Escape when glassChatFindBarVisible, f1:!1 hidden:!0;
//     next = Enter primary / F3 secondary, previous = Shift+Enter /
//     Shift+F3, both when glassChatFindBarVisible &&
//     glassChatFindInputFocused, f1:!1 hidden:!0.
//   YRx (@45444507): or(glassTranscriptFocused, glassPromptInputFocused,
//     glassChatFindInputFocused,
//     and(glassEditorPanelFocused.negate(), glassCustomizePanelActive.negate()))

/** Command ids of the pane-level family (binary-verbatim, unprefixed). */
export const SHOW_CHAT_FIND_ID = 'showChatFind';
export const HIDE_CHAT_FIND_ID = 'hideChatFind';
export const NEXT_CHAT_FIND_MATCH_ID = 'nextChatFindMatch';
export const PREVIOUS_CHAT_FIND_MATCH_ID = 'previousChatFindMatch';

/** `glass.*` aliases — binary has these ONLY for hide/next/previous. */
export const GLASS_HIDE_CHAT_FIND_ID = 'glass.hideChatFind';
export const GLASS_NEXT_CHAT_FIND_MATCH_ID = 'glass.nextChatFindMatch';
export const GLASS_PREVIOUS_CHAT_FIND_MATCH_ID = 'glass.previousChatFindMatch';

/** Command titles (binary-verbatim). */
export const SHOW_CHAT_FIND_TITLE = 'Find in Chat';
export const HIDE_CHAT_FIND_TITLE = 'Close Find in Chat';
export const NEXT_CHAT_FIND_MATCH_TITLE = 'Find Next in Chat';
export const PREVIOUS_CHAT_FIND_MATCH_TITLE = 'Find Previous in Chat';

/** Binary keybinding weight: gp+7 with gp=250 (@45469675) = 257. */
export const CHAT_FIND_KEYBINDING_WEIGHT = 257;

/** Verbatim context key names (binary @23559549 / @23559590). */
export const GLASS_CHAT_FIND_BAR_VISIBLE_KEY = 'glassChatFindBarVisible';
export const GLASS_CHAT_FIND_INPUT_FOCUSED_KEY = 'glassChatFindInputFocused';

/**
 * Focus snapshot the fork's YRx port is evaluated against. Field names map
 * 1:1 onto the context keys `chatFindShowWhen` in composerActions.ts is
 * built from:
 *   chatSurface          <- fork merge of the binary's first two YRx arms
 *                           (glassTranscriptFocused / glassPromptInputFocused:
 *                           in the fork both the transcript and the prompt
 *                           live in the one chat surface — sidebar view
 *                           `composer.chat` or an `ide-chat` editor tab —
 *                           the same port the old family uses for
 *                           `composerFocused`).
 *   chatFindInputFocused <- glassChatFindInputFocused (verbatim key).
 *   editorTextFocus      <- port of glassEditorPanelFocused (see below).
 *   terminalFocusInAny   <- extra negate in the fallback arm (see below).
 */
export interface ChatFindShowFocusState {
	readonly chatSurface: boolean;
	readonly chatFindInputFocused: boolean;
	readonly editorTextFocus: boolean;
	readonly terminalFocusInAny: boolean;
}

/**
 * The fork port of the binary `showChatFind` when-clause YRx:
 *   binary: or(transcriptFocused, promptInputFocused, findInputFocused,
 *              and(!editorPanelFocused, !customizePanelActive))
 *   fork:   chatSurface || chatFindInputFocused ||
 *           (!editorTextFocus && !terminalFocusInAny)
 *
 * Documented divergences (also in composerActions.ts):
 * - The fork has no `glassCustomizePanelActive` key (no core customize
 *   panel focus state), so that negate is dropped.
 * - `glassEditorPanelFocused` is ported as `editorTextFocus` (the same
 *   port GAPS-119 used for the chat-jump `gno` clause), PLUS a
 *   `terminalFocusInAny` negate: fork terminals live in the bottom panel,
 *   not inside the editor panel like glass tabs, so `!editorTextFocus`
 *   alone would let this weight-257 binding shadow the stock terminal
 *   find (weight 200) whenever a terminal has focus. In the binary the
 *   single editor-panel negate already covers its terminals.
 */
export function shouldShowChatFind(state: ChatFindShowFocusState): boolean {
	return state.chatSurface
		|| state.chatFindInputFocused
		|| (!state.editorTextFocus && !state.terminalFocusInAny);
}

/** Binary when for hideChatFind: `glassChatFindBarVisible` alone. */
export function shouldHideChatFind(barVisible: boolean): boolean {
	return barVisible;
}

/** Binary when for next/previous: `glassChatFindBarVisible && glassChatFindInputFocused`. */
export function shouldNavigateChatFind(barVisible: boolean, inputFocused: boolean): boolean {
	return barVisible && inputFocused;
}
