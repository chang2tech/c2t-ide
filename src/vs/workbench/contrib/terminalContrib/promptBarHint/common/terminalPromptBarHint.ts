/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * IDE-CODE (GAPS-142, settings-terminal-hint): pure definitions + decision
 * logic for Cursor's Settings › Chat › "Terminal Hint" entry — the
 * Cmd/Ctrl+K hint rendered at the top of every terminal instance.
 *
 * QA STEP 1 — evidence, self-verified 2026-10-20 against the Cursor 3.25.9
 * bundles (`workbench.desktop.main.js` = desk, `workbench.glass.main.js` =
 * glass; byte offsets are into those files; full slices in
 * docs/rea/work-notes-gaps142.md):
 *
 * - Settings registry (desk@37340021, glass@28386494), VERBATIM:
 *   `hl("chat","terminal-hint",{label:"Terminal Hint",surface:"ide",description:"Show the Cmd/Ctrl+K hint in Terminal"})`
 *   There is NO VS Code-style configuration key in Cursor for this entry
 *   (grep `terminalHint` = 0 hits in both bundles): the entry is backed by
 *   the reactive persistent-storage key `hideTerminalTooltip`.
 * - Settings control (desk@37442481, group "Terminal and Editing"):
 *   label "Terminal Hint", control description
 *   `` `Show a hint for ${isMac ? "⌘" : "Ctrl+"}K in the Terminal` ``,
 *   `checked = PL(r, I2k)` with the selector (desk@37443354)
 *   `function I2k(e){return e.hideTerminalTooltip===!1}` (`!1` = false),
 *   and `onCheckedChange: M => setApplicationUserPersistentStorage("hideTerminalTooltip", !M)`
 *   plus analytics `terminal_hint` / `inline_terminal`.
 *   `hideTerminalTooltip` occurs ONLY at the consumer (desk@36723159,
 *   desk@36726703), the setter and the selector — no initializer/default
 *   assignment exists in either bundle. Storage `undefined` therefore
 *   means: toggle OFF and hint hidden. The hint is OPT-IN: it renders only
 *   after the user enables the setting (storage becomes exactly `false`).
 *   (Contrast the neighbouring entries, which deliberately use the
 *   opposite comparisons: Toolbar on Selection `hideChatEditTooltip!==!0`,
 *   Auto-Parse Links `shouldAutoParseCmdKLinks!==!1` — both default ON.)
 * - Consumer (desk@36723159+): class `qme`, `qme.ID="terminal.promptBar"`,
 *   a per-terminal-instance workbench contribution. Its constructor appends
 *   `div.prompt-bar-container` to `instance.domElement` (display:none),
 *   re-renders the hint when `hideTerminalTooltip` changes (only while the
 *   prompt bar is not visible) and when keybindings change, and renders
 *   once immediately. `_renderPromptBarHint()` (desk@36726703):
 *     1. feature gate `_isFeatureEnabled()` =
 *        `instance.cursorAttachOptions?.enablePromptBar ?? true` — else hide.
 *     2. if NOT a read-only (agent) terminal AND
 *        (`hideTerminalTooltip !== false` OR `shellLaunchConfig.hideFromUser`)
 *        → hide. I.e. the Cmd+K hint shows only when the storage value is
 *        exactly `false`.
 *     3. read-only terminals instead show the text
 *        "Agent terminals are read-only" (a different hint sharing the
 *        container; NOT governed by this setting — see divergences below).
 *     4. a worktree branch can instead show an "Open worktree" link (also
 *        not governed by this setting — see divergences).
 *     5. otherwise `keybindingService.lookupKeybinding("cursorai.action.generateInTerminal")`;
 *        no keybinding → hide; else the hint div gets
 *        `textContent = `${keybinding.getLabel()} to generate command``.
 *   Hint element (VERBATIM styles, set inline by Cursor): class
 *   `prompt-bar-hint`, textAlign center, opacity 1,
 *   color `var(--vscode-input-placeholderForeground)`, fontSize 10px,
 *   height 20px. Showing sets the container display:block and calls
 *   `instance.setTopUiContributionHeight("terminal.promptBar", 20)`;
 *   hiding sets display:none and height 0. `show()` (Cmd+K) swaps the
 *   container to the prompt bar; `hide()`/`close()`/`accept()` re-render
 *   the hint. Glass has the registry + settings control but NO consumer
 *   (matches `surface:"ide"`).
 * - The hint points at terminal Cmd+K: `cursorai.action.generateInTerminal`
 *   "Generate in Terminal" (id table desk@484110; registration desk@36730361+,
 *   CtrlCmd+K, weight 10200) — the prompt bar owned by the same contribution.
 *
 * FORK MAPPING (following the fork precedent for Cursor reactive-storage
 * settings, e.g. `ide.window.autoHideEditorWhenEmpty` in
 * contrib/composer/common/composerConfiguration.ts): the setting is
 * surfaced as the positive boolean configuration
 * {@link TerminalPromptBarHintSettingId.ShowCmdkHint}, default `false`.
 * This is behaviorally identical to Cursor's tri-state in every reachable
 * state: unset → off/hidden; enabled → shown; disabled → hidden (Cursor:
 * unset → hidden, `false` → shown, `true` → hidden). The configuration is
 * registered in composerConfiguration.ts (Agents section, next to the
 * sibling terminal settings `ide.terminal.toolbarOnSelection` and
 * `ide.terminal.usePreviewBox` from the same Cursor settings group) and the
 * consumer is the workbench-core terminal contribution in
 * `../browser/terminalPromptBarHint.ts` — the same layer Cursor uses
 * (extension APIs cannot render inside a terminal instance).
 *
 * HONEST-DIVERGENCES:
 * - No per-instance `cursorAttachOptions.enablePromptBar` exists in the
 *   fork, so the feature gate (step 1 above) has no fork counterpart and is
 *   not reproduced; the fork's prompt bar itself is gated where it opens
 *   (`ide.agent.terminal.enableAiChecks` in terminalCmdkActions.ts).
 * - The fork's TerminalInstance has no `setTopUiContributionHeight` API,
 *   so the hint overlays the top 20px of the terminal instance (absolute
 *   positioning, transparent background — exactly Cursor's colors/size)
 *   instead of pushing the terminal content down by 20px.
 * - Prompt-bar visibility in the fork is a single global core state
 *   (ITerminalGeneratePromptBar in contrib/composer), not per-instance
 *   state inside the contribution, so "prompt bar visible" is evaluated
 *   globally: while any terminal prompt bar is open, all hints hide; they
 *   re-render when it closes. User-visible difference is limited to
 *   multi-terminal layouts during the seconds a prompt bar is open.
 * - The read-only "Agent terminals are read-only" text and the
 *   "Open worktree" link share Cursor's container but are NOT the Terminal
 *   Hint setting's behavior (they ignore `hideTerminalTooltip`); they are
 *   not implemented here.
 */

/** The fork configuration key for Cursor's "Terminal Hint" setting. */
export const enum TerminalPromptBarHintSettingId {
	ShowCmdkHint = 'ide.terminal.showCmdkHint',
}

/** Command the hint advertises — Cursor's `S_n` id (desk@484110). */
export const GENERATE_IN_TERMINAL_COMMAND_ID = 'cursorai.action.generateInTerminal';

/** Context key (fork core) that is true while the terminal prompt bar is open. */
export const TERMINAL_PROMPT_BAR_VISIBLE_CONTEXT_KEY = 'promptBarVisible';

/** Height of the hint in px (Cursor: hint height 20, top UI height 20). */
export const TERMINAL_PROMPT_BAR_HINT_HEIGHT = 20;

/**
 * Cursor's settings selector, VERBATIM semantics (desk@37443354):
 * `function I2k(e){return e.hideTerminalTooltip===!1}`.
 * The stored value is the INVERSE of the toggle (`hide…`), and only the
 * exact value `false` means "enabled" — `undefined` (never touched) and
 * `true` both mean the hint is off.
 */
export function isTerminalHintEnabledFromCursorStorage(hideTerminalTooltip: unknown): boolean {
	return hideTerminalTooltip === false;
}

/** Everything the hint render decision depends on (Cursor `_renderPromptBarHint`). */
export interface TerminalPromptBarHintState {
	/** Fork setting value; the equivalent of `hideTerminalTooltip === false` in Cursor. */
	readonly settingEnabled: boolean;
	/** Whether the terminal Cmd+K prompt bar is currently open (fork: global core state). */
	readonly promptBarVisible: boolean;
	/** `shellLaunchConfig.hideFromUser` of the terminal instance. */
	readonly hideFromUser: boolean;
	/**
	 * Label of the resolved keybinding for `cursorai.action.generateInTerminal`
	 * (e.g. "⌘K" / "Ctrl+K"), or `undefined` when no keybinding is bound —
	 * Cursor hides the hint in that case.
	 */
	readonly keybindingLabel: string | undefined;
}

/**
 * The hint text, VERBATIM from Cursor (desk@36728545):
 * `` `${n.getLabel()} to generate command` ``.
 * Returns `undefined` when there is no keybinding label (hint hidden).
 */
export function terminalPromptBarHintText(keybindingLabel: string | undefined): string | undefined {
	if (!keybindingLabel) {
		return undefined;
	}
	return `${keybindingLabel} to generate command`;
}

/**
 * Whether the Cmd/Ctrl+K hint is rendered for a terminal instance.
 * Mirrors Cursor's guard order in `_renderPromptBarHint()`:
 * prompt bar open → no hint (the container shows the prompt bar instead);
 * setting not explicitly enabled → no hint; `hideFromUser` → no hint;
 * no keybinding for generateInTerminal → no hint.
 */
export function shouldShowTerminalPromptBarHint(state: TerminalPromptBarHintState): boolean {
	if (state.promptBarVisible) {
		return false;
	}
	if (!state.settingEnabled) {
		return false;
	}
	if (state.hideFromUser) {
		return false;
	}
	return terminalPromptBarHintText(state.keybindingLabel) !== undefined;
}
