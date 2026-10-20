/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * IDE-CODE (DEV-GAPS-103, settings-autohide-editor): pure definitions for
 * Cursor's Settings › General › Layout › "Auto-Hide Editor When Empty".
 *
 * QA step 1 — evidence, self-verified 2026-10-20 against the Cursor 3.25.9
 * binary (`workbench.desktop.main.js`):
 * - Storage descriptor @14325017: `autoHideEditorWhenEmpty:Jh(!1,-1,0)`.
 *   `Jh` (@14318746) builds a boolean storage descriptor
 *   `{ fromStorage: i => i === "true", toStorage: i => i ? "true" : "false",
 *      defaultValue, storageScope, storageTarget }`, so the VERBATIM facts
 *   are: default **false**, storageScope **-1 (APPLICATION)**,
 *   storageTarget **0 (USER)**. The storage key is `"cursor/" + name`
 *   (`uGt`, @14321085) read through `ph(storage, "autoHideEditorWhenEmpty")`
 *   (@14318746); the layout reader is
 *   `function TJo(e){ return ph(e, "autoHideEditorWhenEmpty") }` (@25510115).
 *   This is a Cursor reactive-storage preference, NOT a VS Code
 *   configuration property — there is no `cursor.*` / `ide.*` configuration
 *   key for it in the binary.
 * - Settings registry @37325620:
 *   `hl("general","auto-hide-editor",{label:"Auto-Hide Editor When Empty",surface:"ide"})`
 *   — section "general", right after the "layout" entry (General › Layout).
 * - Settings UI control (`M3k`, @37533652–37533928), VERBATIM:
 *   description "When all editors are closed, hide the editor area and
 *   maximize chat", label "Auto-Hide Editor When Empty",
 *   searchAliases ["editor","hide","empty","maximize chat"], rendered as a
 *   switch bound to the preference via `Tce("autoHideEditorWhenEmpty")`.
 *   Boolean only — no enum/values.
 * - Behavior (layout `registerLayoutListeners`, @38454971), VERBATIM logic:
 *   on every main editor group's `onDidCloseEditor` (via queueMicrotask),
 *   and again when part visibility changes such that the panel was hidden
 *   or the auxiliary bar was shown:
 *     if (!pref || isTogglingUnifiedMaximization
 *         || isVisible("workbench.parts.panel")
 *         || !isVisible("workbench.parts.auxiliarybar")) return;
 *     if (no main editor group has count > 0
 *         && isVisible("workbench.parts.editor"))
 *       setUnifiedMaximizeState(true, { skipHideSidebar: true });
 *   The same preference is also read by
 *   `shouldMaximizeAfterOpeningComposerInUnifiedMode` (@31233549) and by
 *   the first-open layout picker (@26983383, `editorsVisible = !autoHide`
 *   for the default-agent layout).
 *
 * HONEST-DIVERGENCE (fork architecture): the fork has no Cursor-style
 * reactive storage settings page and no `setUnifiedMaximizeState`. Per the
 * established fork precedent for Cursor storage-backed settings
 * (DEV-GAPS-83 `ide.window.defaultLayout`, DEV-GAPS-75 in
 * common/composerConfiguration.ts), the setting is exposed as the VS Code
 * configuration {@link AUTO_HIDE_EDITOR_CONFIG_KEY} in the IDE Code ›
 * General section — same default (false), same verbatim description, and
 * APPLICATION scope matching the binary's storageScope -1. The layout
 * behavior lives in browser/autoHideEditorActions.ts and hides the editor
 * part through `IWorkbenchLayoutService.setPartHidden`, the fork's
 * observable equivalent of Cursor's unified maximize for this guard set
 * (the auxiliary bar / chat keeps its space and the editor area goes
 * away). Only the editor-close trigger and the panel/auxiliary-bar
 * visibility triggers of the binary are wired; the composer-open and
 * first-open-layout reads are NOT replicated (the fork's composer does
 * not open through a unified-mode path) — they are listed here so a
 * future dissection pass can wire them if that path appears.
 */

export const AUTO_HIDE_EDITOR_LABEL = 'Auto-Hide Editor When Empty';
export const AUTO_HIDE_EDITOR_DESCRIPTION = 'When all editors are closed, hide the editor area and maximize chat';
export const AUTO_HIDE_EDITOR_SEARCH_ALIASES: readonly string[] = ['editor', 'hide', 'empty', 'maximize chat'];

/** Binary storage key (`"cursor/" + "autoHideEditorWhenEmpty"`, scope -1, target 0). */
export const AUTO_HIDE_EDITOR_STORAGE_KEY = 'cursor/autoHideEditorWhenEmpty';

/** Binary-verbatim default: `Jh(!1, -1, 0)` — false. */
export const AUTO_HIDE_EDITOR_DEFAULT = false;

/** Fork configuration key backing the setting (see header divergence note). */
export const AUTO_HIDE_EDITOR_CONFIG_KEY = 'ide.window.autoHideEditorWhenEmpty';

/** Snapshot of the layout facts the binary's guard reads. */
export interface IAutoHideEditorLayoutState {
	/** The preference itself (`TJo(storageService)`). */
	readonly autoHideEditorWhenEmpty: boolean;
	/** `isVisible("workbench.parts.panel")` — must be false. */
	readonly panelVisible: boolean;
	/** `isVisible("workbench.parts.auxiliarybar")` — chat must be visible. */
	readonly auxiliaryBarVisible: boolean;
	/** `isVisible("workbench.parts.editor")` — editor area currently shown. */
	readonly editorVisible: boolean;
	/** True when any main editor group has `count > 0`. */
	readonly anyMainEditorGroupHasEditors: boolean;
	/** Binary guard `isTogglingUnifiedMaximization` (fork: an auto-hide/restore is in flight). */
	readonly togglingMaximization: boolean;
}

/**
 * The binary's hide guard (@38454971), verbatim: hide (maximize chat) only
 * when the preference is on, no maximization toggle is in flight, the
 * panel is hidden, the auxiliary bar (chat) is visible, the editor part is
 * visible, and every main editor group is empty.
 */
export function shouldAutoHideEditor(state: IAutoHideEditorLayoutState): boolean {
	return state.autoHideEditorWhenEmpty
		&& !state.togglingMaximization
		&& !state.panelVisible
		&& state.auxiliaryBarVisible
		&& state.editorVisible
		&& !state.anyMainEditorGroupHasEditors;
}

/**
 * Restore counterpart. In the binary, un-maximizing when editors exist is
 * done by the sibling listener in `registerLayoutListeners` (@38454971):
 * `!isVisible("workbench.parts.editor") && groups.some(g => g.editors.length)`
 * → `setUnifiedMaximizeState(false)`. The fork narrows this to the case it
 * can attribute: it only restores an editor part that the auto-hide
 * behavior itself hid (`hiddenByAutoHide`), so it never fights a layout
 * the user chose manually.
 */
export function shouldRestoreAutoHiddenEditor(state: Pick<IAutoHideEditorLayoutState, 'anyMainEditorGroupHasEditors'> & { readonly editorVisible: boolean; readonly hiddenByAutoHide: boolean }): boolean {
	return state.hiddenByAutoHide
		&& !state.editorVisible
		&& state.anyMainEditorGroupHasEditors;
}
