/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// IDE-CODE: Context keys for the Composer (AI chat) workbench contribution.
//
// Migration note (contributes-migration-map.md):
// - `ideAgent.chatInputFocused`    -> `composer.chatInputFocused`
// - `ideAgent.toolApprovalVisible` -> `composer.toolApprovalVisible`
// - `ideAgent.inlineEditPending`   -> `composer.inlineEditPending`
// The ide-agent extension still sets the legacy `ideAgent.*` keys at runtime
// (via `setContext` from its webview host). The canonical `composer.*` keys
// are CORE-OWNED: ComposerWorkbenchContribution. syncLegacyComposerContextKeys
// (composer.contribution.ts) derives them from the `ideAgent.*` signals until
// the chat webview migrates to core DOM, at which point core focus tracking
// becomes the source and the bridge is deleted. Do NOT have the extension
// set `composer.*` directly — single core-owned writer, like Cursor.

import { localize } from '../../../../nls.js';
import { RawContextKey } from '../../../../platform/contextkey/common/contextkey.js';

export namespace ComposerContextKeys {

	/**
	 * Whether the composer chat input (sidebar view or chat editor tab) has
	 * DOM focus. Replaces the extension-owned `ideAgent.chatInputFocused`.
	 */
	export const chatInputFocused = new RawContextKey<boolean>(
		'composer.chatInputFocused',
		false,
		localize('composer.chatInputFocused', "Whether the composer chat input is focused.")
	);

	/**
	 * Whether the composer chat prompt is empty.
	 * DEV-GAPS-119 (`chat-jump-messages-kbd`): fork port of Cursor's
	 * VERBATIM context key `glassPromptInputEmpty`
	 * (workbench.glass.main.js 3.25.9, glassContextKeys.js — `ARl`), the
	 * last conjunct of the jump-between-messages when-clause
	 * `gno = !glassEditorPanelFocused && !terminalFocusInAny &&
	 * (!inputFocus || glassPromptInputEmpty)` (glass @45335715): the
	 * Cmd/Ctrl+Up/Down jump bindings also fire while the prompt has focus,
	 * as long as it's empty (docs release-notes, verbatim). Core-owned;
	 * bridged from the extension's `ideAgent.chatInputEmpty` (the chat
	 * webview reports {type:'inputEmpty'} on every edit) via
	 * composerContextKeysBridge — same writer pattern as chatInputFocused.
	 * Default false matches the binary's RawContextKey default (!1).
	 */
	export const chatInputEmpty = new RawContextKey<boolean>(
		'composer.chatInputEmpty',
		false,
		localize('composer.chatInputEmpty', "Whether the composer chat prompt is empty.")
	);

	/**
	 * Whether a shell tool-call approval card is currently visible in the
	 * composer. Replaces the extension-owned `ideAgent.toolApprovalVisible`.
	 */
	export const toolApprovalVisible = new RawContextKey<boolean>(
		'composer.toolApprovalVisible',
		false,
		localize('composer.toolApprovalVisible', "Whether a composer shell tool approval prompt is visible.")
	);

	/**
	 * Whether a shell tool-call approval is pending and its keyboard
	 * shortcuts (Enter/Shift+Enter/Escape) are live. Cursor-verbatim context
	 * key `composerShellToolPendingKeybindingsActive` (workbench.glass.main.js
	 * 3.25.9; dotted here per the fork's `composer.*` convention) — bound
	 * from the per-composer shell-tool state (blocking pending user decision
	 * whose bubble review model is in REQUESTED status for the terminal
	 * tool). Core-owned; bridged from the extension's
	 * `ideAgent.shellToolPendingKeybindingsActive` until the chat webview
	 * migrates to core DOM.
	 */
	export const shellToolPendingKeybindingsActive = new RawContextKey<boolean>(
		'composer.shellToolPendingKeybindingsActive',
		false,
		localize('composer.shellToolPendingKeybindingsActive', "Whether a shell tool approval is pending and its keyboard shortcuts are active.")
	);

	/**
	 * Whether the shell-tool allowlist shortcut (Shift+Enter) is available.
	 * Cursor-verbatim `composerShellToolAllowlistShortcutActive` (glass
	 * bundle 3.25.9) — true when the pending shell approval carries
	 * non-empty `candidatesForAllowlist` and the composer is not in
	 * full-auto-run. Core-owned; bridged from the extension's
	 * `ideAgent.shellToolAllowlistShortcutActive`.
	 */
	export const shellToolAllowlistShortcutActive = new RawContextKey<boolean>(
		'composer.shellToolAllowlistShortcutActive',
		false,
		localize('composer.shellToolAllowlistShortcutActive', "Whether the shell tool allowlist shortcut is available.")
	);

	/**
	 * Whether an inline-edit (Cmd+K style) preview is pending in the editor.
	 * Replaces the extension-owned `ideAgent.inlineEditPending`.
	 */
	export const inlineEditPending = new RawContextKey<boolean>(
		'composer.inlineEditPending',
		false,
		localize('composer.inlineEditPending', "Whether a composer inline edit preview is pending.")
	);

	/**
	 * Whether a terminal tool call is currently running.
	 * GAPS-14 note: this key was introduced to gate
	 * `composer.cancelTerminalToolCall` (Shift+Backspace), but fresh
	 * dissection (DEV-GAPS-12, workbench.glass.main.js 3.25.9) shows the
	 * binary DOES pin a when-clause for that command —
	 * `composerFocused || focusedView =~ /^workbench.panel.aichat.view/` —
	 * so the binding is chat-surface-scoped, not run-scoped. The key is kept
	 * as a truthful signal (still set by TerminalService and bridged) but no
	 * longer gates the cancel binding.
	 */
	export const terminalToolCallRunning = new RawContextKey<boolean>(
		'composer.terminalToolCallRunning',
		false,
		localize('composer.terminalToolCallRunning', "Whether a composer terminal tool call is currently running.")
	);

	/**
	 * Whether the active editor has an open Cmd+K prompt bar (PromptBarViewZone).
	 * Verbatim Cursor context key (binary §4.2): `editorHasPromptBar`.
	 */
	export const editorHasPromptBar = new RawContextKey<boolean>(
		'editorHasPromptBar',
		false,
		localize('composer.editorHasPromptBar', "Whether the active editor has an open inline-edit prompt bar.")
	);

	/**
	 * Whether the Cmd+K prompt bar input currently has DOM focus.
	 * Verbatim Cursor context key (binary §4.2): `editorPromptBarFocused`.
	 */
	export const editorPromptBarFocused = new RawContextKey<boolean>(
		'editorPromptBarFocused',
		false,
		localize('composer.editorPromptBarFocused', "Whether the inline-edit prompt bar input is focused.")
	);

	/**
	 * Whether the (glass) composer bar is visible.
	 * Verbatim Cursor context key (binary: glass `arf = new pn("composerBarIsVisible", !1)`
	 * @17969685; desktop `mdh` @16722748) — the PRECONDITION of
	 * `aipopup.action.modal.generate` is `arf.negate()` (`!composerBarIsVisible`).
	 * GAPS-171: the fork has no glass composer-bar overlay and nothing sets
	 * this key, so it keeps the binary's default `false` and the precondition
	 * passes — documented divergence, not a silent omission.
	 */
	export const composerBarIsVisible = new RawContextKey<boolean>(
		'composerBarIsVisible',
		false,
		localize('composer.composerBarIsVisible', "Whether the composer bar is visible.")
	);

	/**
	 * Whether the edit-context bar cursor is active.
	 * Verbatim Cursor context key (binary: glass `pil = new pn("editcontextbarcursor", !1)`
	 * @18093186; desktop `bSo` @16841945) — second disjunct of the
	 * `aipopup.action.modal.generate` "new" keybinding rule:
	 * `editorFocus || editcontextbarcursor`.
	 * GAPS-171: the fork has no edit-context bar; nothing sets this key, so it
	 * keeps the binary's default `false` and the rule reduces to `editorFocus`
	 * — documented divergence, not a silent omission.
	 */
	export const editcontextbarcursor = new RawContextKey<boolean>(
		'editcontextbarcursor',
		false,
		localize('composer.editcontextbarcursor', "Whether the edit context bar cursor is active.")
	);

	/**
	 * Whether the editor panel (composer) is currently fullscreen.
	 * VERBATIM Cursor context key `glassEditorPanelFullscreen`
	 * (binary: workbench.glass.main.js 3.25.9 — `VXt`; set by
	 * `setEditorPanelFullscreen(v, {entrypoint})`). Set at runtime by the
	 * ide-agent extension via `setContext` (its `setFullscreenComposerActive`
	 * is the fork's `setEditorPanelFullscreen` analog); read by the
	 * `glass.enterEditorPanelFullscreen` / `glass.exitEditorPanelFullscreen`
	 * keybinding/palette `when` clauses:
	 * enter = `glassEditorPanelFullscreenAvailable && !glassEditorPanelFullscreen`
	 * (binary `Wlu=ft.and(YDi,VXt.negate())`),
	 * exit = `glassEditorPanelVisible && glassEditorPanelFullscreen`
	 * (binary `Glu=ft.and(u7,VXt)`).
	 * (Supersedes the earlier `composer.fullscreenActive` analog —
	 * WORKER-GAPS-20C, 2026-10-20 — verbatim key per the binary.)
	 */
	export const glassEditorPanelFullscreen = new RawContextKey<boolean>(
		'glassEditorPanelFullscreen',
		false,
		localize('composer.glassEditorPanelFullscreen', "Whether the editor panel (composer) is currently fullscreen.")
	);

	/**
	 * Whether the editor panel (composer) is visible.
	 * VERBATIM Cursor context key `glassEditorPanelVisible`
	 * (binary: workbench.glass.main.js 3.25.9 — `u7`; required by the
	 * `glass.exitEditorPanelFullscreen` when clause
	 * `Glu=ft.and(u7,VXt)`). Bound to `true` by the composer workbench
	 * contribution — a fullscreen (maximized) editor group is visible by
	 * construction, so the binary's exit-when conjunct is behaviorally
	 * implied in this fork; binding it keeps the when-clause structure
	 * verbatim.
	 */
	export const glassEditorPanelVisible = new RawContextKey<boolean>(
		'glassEditorPanelVisible',
		true,
		localize('composer.glassEditorPanelVisible', "Whether the editor panel (composer) is visible.")
	);

	/**
	 * Whether the fullscreen-composer feature is available in this window.
	 * VERBATIM Cursor context key `glassEditorPanelFullscreenAvailable`
	 * (binary: workbench.glass.main.js 3.25.9 —
	 * `YDi=new pn("glassEditorPanelFullscreenAvailable",!1)`; the
	 * `glass.enterEditorPanelFullscreen` when clause requires it via
	 * `Wlu=ft.and(YDi,VXt.negate())`). Cursor sets it at runtime from
	 * `_isEditorPanelFullscreenAvailable()` (= `!this._settingsActive`) via
	 * `this._keybindingRouterService.setContext(YDi.key, ...)`; this fork has
	 * no settings-overlay state for the composer panel, so the composer
	 * workbench contribution binds it to `true` at startup — equivalent to
	 * Cursor whenever settings are not open. Read by the
	 * `glass.enterEditorPanelFullscreen` keybinding/palette `when` clause:
	 * `glassEditorPanelFullscreenAvailable && !glassEditorPanelFullscreen`.
	 * (Supersedes the earlier `composer.fullscreenAvailable` analog —
	 * WORKER-GAPS-17E, 2026-10-20 — verbatim key per the binary.)
	 */
	export const glassEditorPanelFullscreenAvailable = new RawContextKey<boolean>(
		'glassEditorPanelFullscreenAvailable',
		true,
		localize('composer.glassEditorPanelFullscreenAvailable', "Whether the fullscreen composer feature is available.")
	);

	/**
	 * Whether the Changes tab action (`composer.openChangesTab`) is enabled.
	 * DEV-GAPS-9B: our analog of Cursor's binary `showChangesAction` gate
	 * (whose semantics are UNKNOWN). Synced from the
	 * `composer.changesTab.enabled` setting (default true) by the composer
	 * workbench contribution.
	 */
	export const changesTabEnabled = new RawContextKey<boolean>(
		'composer.changesTabEnabled',
		true,
		localize('composer.changesTabEnabled', "Whether the Changes tab action is enabled.")
	);

	/**
	 * Whether the active composer chat tab is attached to a git worktree.
	 * DEV-GAPS-18-W4 (`agent-worktree-chat-actions`): fork analog of the
	 * chat-tab `gitWorktree.worktreePath` gate in Cursor's chat-tab overflow
	 * menu builder (workbench.glass.main.js 3.25.9, `sSv`): the three
	 * worktree menu items ("Copy worktree path", "Open terminal in worktree",
	 * "Open new window in worktree") are only shown when this is true.
	 * Core-owned; synced from the active `ComposerChatEditorInput.worktreePath`
	 * by ComposerWorkbenchContribution.
	 */
	export const chatHasWorktree = new RawContextKey<boolean>(
		'composer.chatHasWorktree',
		false,
		localize('composer.chatHasWorktree', "Whether the active composer chat tab is attached to a git worktree.")
	);
	/**
	 * Whether the active composer chat editor tab can be renamed
	 * (WORKER-GAPS-66A, `chat-tab-title-menu-inventory`).
	 * VERBATIM Cursor context key `composerEditorTabCanRename`
	 * (workbench.desktop.main.js 3.25.9 — `VXi=new Mt("composerEditorTabCanRename",!1)`):
	 * the precondition on the EditorTitleContext "Rename Chat" item (Opa @29968468).
	 * Cursor binds it to the editor group's context-menu-scoped keys from
	 * loaded composer data (`a = isCloudAgent || hasConversationHeaders`);
	 * the fork has no core composer data service, so
	 * ComposerWorkbenchContribution binds it true whenever the ACTIVE editor
	 * is a `ComposerChatEditorInput` (fork chats are always renamable once
	 * loaded — see common/chatTitleMenu.ts HONEST-DIVERGENCES).
	 */
	export const chatEditorTabCanRename = new RawContextKey<boolean>(
		'composerEditorTabCanRename',
		false,
		localize('composer.chatEditorTabCanRename', "Whether the active composer chat editor tab can be renamed.")
	);

	/**
	 * Whether the active composer chat editor tab is a cloud (background)
	 * agent chat (WORKER-GAPS-66A). VERBATIM Cursor context key
	 * `composerEditorTabIsCloudAgent` (workbench.desktop.main.js 3.25.9 —
	 * `jXi=new Mt("composerEditorTabIsCloudAgent",!1)`): the "Fork Chat"
	 * title-menu item's `when` is `scheme == composer && !composerEditorTabIsCloudAgent`.
	 * The fork has no cloud-agent chats, so this stays false (bound
	 * explicitly by ComposerWorkbenchContribution).
	 */
	export const chatEditorTabIsCloudAgent = new RawContextKey<boolean>(
		'composerEditorTabIsCloudAgent',
		false,
		localize('composer.chatEditorTabIsCloudAgent', "Whether the active composer chat editor tab is a cloud agent chat.")
	);

	/**
	 * Whether conversation sharing is available (WORKER-GAPS-66A).
	 * VERBATIM Cursor context key `isSharedChatsEnabled`
	 * (workbench.desktop.main.js 3.25.9 — `MQt=new Mt("isSharedChatsEnabled",!1)`):
	 * gates the "Share Transcript" title-menu item and is the precondition of
	 * the `composer.shareChat` action. Cursor drives it from server-side
	 * sharing availability (aiReactiveContextKeys contribution); the fork has
	 * no share backend, so ComposerWorkbenchContribution binds it false and
	 * the item stays hidden exactly like Cursor's unavailable state — when a
	 * share backend lands, the extension flips this key (same writer pattern
	 * as `glassEditorPanelFullscreen`).
	 */
	export const isSharedChatsEnabled = new RawContextKey<boolean>(
		'isSharedChatsEnabled',
		false,
		localize('composer.isSharedChatsEnabled', "Whether conversation (chat transcript) sharing is available.")
	);

	/**
	 * Whether the chat input is submitted with Cmd/Ctrl+Enter.
	 * VERBATIM Cursor context key `composerSubmitOnCmdEnterEnabled`
	 * (workbench.glass.main.js 3.25.9 —
	 * `Jis=new pn("composerSubmitOnCmdEnterEnabled",!1)` @17969880): the
	 * switch between the two `composer.acceptComposerStep` keybindings:
	 * Cmd/Ctrl+Enter accepts pending agent pane actions when this is
	 * false; Cmd/Ctrl+Alt+Enter does when it is true. Cursor binds it from
	 * the `chatSubmitOnCmdEnter` storage key
	 * (`_bindComposerSubmitOnCmdEnterKey`, default false when unset); the
	 * fork has no such setting yet, so ComposerWorkbenchContribution binds
	 * it to the binary default (false) — the fork's chat-input
	 * Cmd/Ctrl+Enter "send now" is a webview-internal input behavior, not
	 * the configurable submit mode this key toggles.
	 * (DEV-GAPS-66/W66A, `agent-accept-pending-decisions`.)
	 */
	export const submitOnCmdEnterEnabled = new RawContextKey<boolean>(
		'composerSubmitOnCmdEnterEnabled',
		false,
		localize('composer.submitOnCmdEnterEnabled', "Whether the composer input is submitted with Ctrl/Cmd+Enter.")
	);

	/**
	 * Whether the composer chat find widget (Find in Chat) is currently open.
	 * VERBATIM Cursor context key `composerFindWidgetFocused`
	 * (workbench.glass.main.js 3.25.6/3.25.9 — gates the composer.find.*
	 * keybindings: focus requires `composerFocused && !composerFindWidgetFocused`;
	 * hide/next/previous require `composerFindWidgetFocused`).
	 * Core-owned; set at runtime by the ide-agent extension via `setContext`
	 * from the chat webview's find-bar open/close messages (the webview is
	 * the find bar's owner until the chat surface migrates to core DOM).
	 */
	export const findWidgetFocused = new RawContextKey<boolean>(
		'composerFindWidgetFocused',
		false,
		localize('composer.findWidgetFocused', "Whether the composer Find in Chat widget is focused.")
	);

	/**
	 * Whether the pane-level chat find bar is visible.
	 * VERBATIM Cursor context key `glassChatFindBarVisible`
	 * (workbench.glass.main.js 3.25.9 — `ADn=new pn("glassChatFindBarVisible",!1)`
	 * @23559549): gates the `hideChatFind` keybinding (Escape) alone and,
	 * ANDed with `glassChatFindInputFocused`, the `nextChatFindMatch` /
	 * `previousChatFindMatch` keybindings (GAPS-134,
	 * `chat-find-in-chat-pane-level`). In Cursor the glassChatFindService's
	 * `syncVisibleContext()` maintains it; the fork's find bar lives in the
	 * ide-agent chat webview, so the extension maintains it from the same
	 * webview `findBarState` report that drives `findWidgetFocused` above
	 * (extension.ts / chatEditorProvider.ts via the pure
	 * `findBarContextUpdates()` helper in services/findInChat.ts).
	 */
	export const glassChatFindBarVisible = new RawContextKey<boolean>(
		'glassChatFindBarVisible',
		false,
		localize('composer.glassChatFindBarVisible', "Whether the chat find bar is visible.")
	);

	/**
	 * Whether the pane-level chat find bar's input has focus.
	 * VERBATIM Cursor context key `glassChatFindInputFocused`
	 * (workbench.glass.main.js 3.25.9 — `RDn=new pn("glassChatFindInputFocused",!1)`
	 * @23559590): one arm of the `showChatFind` when-clause `YRx`
	 * (@45444507) and, ANDed with `glassChatFindBarVisible`, the when of
	 * `nextChatFindMatch` / `previousChatFindMatch`. Maintained by the
	 * ide-agent extension from the webview find input's focus/blur reports
	 * (the `inputFocused` field of the `findBarState` message — the webview
	 * find bar is the only find input on the chat surface).
	 */
	export const glassChatFindInputFocused = new RawContextKey<boolean>(
		'glassChatFindInputFocused',
		false,
		localize('composer.glassChatFindInputFocused', "Whether the chat find bar input is focused.")
	);

	/**
	 * Whether the pane-level plan find bar is visible.
	 * VERBATIM Cursor context key `glassPlanFindBarVisible`
	 * (workbench.glass.main.js 3.25.9 — `e3i=new pn("glassPlanFindBarVisible",!1)`
	 * @23559865): gates the `hidePlanFind` keybinding (Escape, ANDed with
	 * the plan-tab-kind arm) and, ANDed with `glassFindInputFocused`, the
	 * `nextPlanFindMatch` / `previousPlanFindMatch` keybindings
	 * (GAPS-157, `plan-find-in-plan`). In Cursor the generic glass find
	 * bar sets it from its visibility effect; the fork's plan find bar
	 * lives in the ide-agent chat webview, so the extension maintains it
	 * from the webview's `planFindBarState` reports (extension.ts /
	 * chatEditorProvider.ts via the pure `planFindBarContextUpdates()`
	 * helper in services/findInPlan.ts).
	 */
	export const glassPlanFindBarVisible = new RawContextKey<boolean>(
		'glassPlanFindBarVisible',
		false,
		localize('composer.glassPlanFindBarVisible', "Whether the plan find bar is visible.")
	);

	/**
	 * Whether a glass find bar's input area has focus.
	 * VERBATIM Cursor context key `glassFindInputFocused`
	 * (workbench.glass.main.js 3.25.9 — `MX=new pn("glassFindInputFocused",!1)`
	 * @23559425): the GENERIC glass find-input key, shared by every glass
	 * find bar (plan, markdown preview, …) and distinct from the chat
	 * family's `glassChatFindInputFocused` above. In Cursor the generic
	 * find bar's container sets it on focus and deletes it on blur /
	 * unmount. The fork's plan find bar is the only generic-bar surface,
	 * so the extension maintains it from the webview plan find bar's
	 * focus/blur reports (the `inputFocused` field of the
	 * `planFindBarState` message, via services/findInPlan.ts).
	 */
	export const glassFindInputFocused = new RawContextKey<boolean>(
		'glassFindInputFocused',
		false,
		localize('composer.glassFindInputFocused', "Whether the plan find bar input is focused.")
	);

	/**
	 * Whether a pending plan is being reviewed on the chat surface (the
	 * fork's plan tray is shown). FORK-ONLY key — the port of the binary's
	 * `glassActiveTabKind == Plan` arm (`cf.isEqualTo(Ot.Plan)`) in the
	 * plan find family's when-clauses: the fork has no glass plan tab, so
	 * "the plan surface is active" is carried by this key instead.
	 * Maintained by the ide-agent extension from the ComposerDataService
	 * planReady/planCleared events — the same events that show/hide the
	 * tray itself (see `planTrayContextUpdates()` in
	 * services/findInPlan.ts). The webview pill's local collapse/expand
	 * fold does not clear it: the plan remains the surface's pending plan
	 * (the binary's tab-kind test is likewise about the tab, not about a
	 * folded header).
	 */
	export const planTrayVisible = new RawContextKey<boolean>(
		'composerPlanTrayVisible',
		false,
		localize('composer.planTrayVisible', "Whether a pending plan tray is shown on the chat surface.")
	);
}
