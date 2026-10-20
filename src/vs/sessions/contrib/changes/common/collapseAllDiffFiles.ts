/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * IDE-CODE (DEV-GAPS-103, collapse-all-files-shortcut): pure definitions
 * for Cursor's glass command "Collapse / Expand All Files".
 *
 * QA step 1 — evidence, self-verified 2026-10-20 against the Cursor
 * 3.25.9 binary:
 * - Command id table (workbench.desktop.main.js @28710016):
 *   `ioS="collapseOrExpandAllDiffFiles", pCC=\`glass.${ioS}\``; the same
 *   table exists in workbench.glass.main.js @25985230
 *   (`zHl="collapseOrExpandAllDiffFiles", VHl=\`glass.${zHl}\``)
 *   → id **glass.collapseOrExpandAllDiffFiles**.
 * - Registration (glass @45494583), VERBATIM:
 *   `{ id: zHl, title: "Collapse / Expand All Files", icon: "list-bullets",
 *      glassCategory: "View", keywords: ["collapse","expand","files",
 *      "diffs","all"], f1: !1, scope: AGENT_WORKSPACE,
 *      keybindingCategory: DIFF,
 *      keybinding: j7({ weight: gp, primary: t => t|Shift|Semicolon,
 *        when: or(activeTabKind == Diff, == AgentChanges, == Pr),
 *        suppressBackwardCompatibility: true }),
 *      run: emit({ type: "collapseOrExpandAllDiffsRequested" }) }`
 *   with `gp = 250` (glass @45469683).
 * - Chord decoding: `j7` (glass @45457978) expands
 *   `primary(t)` with `t = Alt` for non-mac and `t = WinCtrl` for mac
 *   (`NZb = dt.Alt, LZb = dt.WinCtrl`, glass @45457841), so the resolved
 *   chords are **Alt+Shift+Semicolon** (Windows/Linux) and
 *   **WinCtrl+Shift+Semicolon** (macOS) — matching the official docs
 *   (https://cursor.com/docs/release-notes, quoted in the feature
 *   matrix: "Ctrl+Shift+; (macOS) / Shift+Alt+; (Windows/Linux)").
 *   `suppressBackwardCompatibility: !0` means there is NO fallback chord.
 *   `f1: !1` means the command is NOT listed in the Command Palette.
 * - Tab kinds (`Ot`, editor-panel-tab-kind.js, glass @23585381):
 *   Diff = "diff", AgentChanges = "agentChanges", Pr = "pr". The `when`
 *   is the ACTIVE editor-panel tab kind being one of those three.
 * - Handler semantics (listeners of `collapseOrExpandAllDiffsRequested`):
 *   Diff/Agent Changes tab (glass @33630478) sets every file card's open
 *   state (`setCardOpen({ filePath, open })` for all files), with the
 *   pending-action label `allCollapsed ? "Expand All" : "Collapse All"`;
 *   the PR tab (glass @34031310) fires
 *   `allCollapsed ? "expand_all_files" : "collapse_all_files"` and then
 *   toggles. The desktop diff view's ellipsis menu carries the same pair
 *   as separate actions "Expand All" / "Collapse All"
 *   (workbench.desktop.main.js @22830065).
 *
 * Fork mapping (browser/changesViewActions.ts): a single Action2 with the
 * verbatim glass id/title, `f1: false`, weight
 * `KeybindingWeight.SessionsContrib` (= 250, the fork's existing numeric
 * match for the glass `gp`), the decoded chords, and a `when` covering the
 * fork's diff-file-card surfaces: the session Changes editor (which hosts
 * both the Diff and Agent Changes surfaces, including the Review Changes
 * editor used for PR review) and the stock multi-diff editor.
 * HONEST-DIVERGENCE: (1) the fork has no standalone PR tab with diff file
 * cards — pull requests open through the GitHub contrib and PR review
 * goes through the Review Changes editor, which IS covered; the `pr`
 * tab-kind itself has no fork counterpart. (2) The binary icon
 * "list-bullets" does not exist in this codicon set (verified by grep
 * over src/vs/base/common/codiconsLibrary.ts), so the action registers
 * the closest codicon (`listTree`) — same precedent as "plus-minus" →
 * `diff` in composerChangesTab.ts. (3) Cursor dispatches through a glass
 * event bus to React tab components; the fork calls the editor panes'
 * existing collapseAllDiffs()/expandAllDiffs() (multi-diff view model),
 * the same primitives its own Collapse/Expand All actions use.
 * (4) Menu entry: the fork's Action2 additionally registers a
 * `menu: { id: Menus.SessionsEditorHeaderLayout, group: 'secondary/1_diff',
 * order: 11 }` entry (see browser/changesViewActions.ts) — the binary
 * registration at glass @45494583 (re-verified by GAPS-124, dump of the
 * `Ir({id:zHl,...})` call) has NO `menu` field at all, so this header-menu
 * surface is a fork-only extra, not Cursor behavior. It is kept because
 * the fork's own Collapse/Expand All pair drives the same header menu,
 * but it must not be claimed as binary parity. (Disclosure added by
 * GAPS-124 per QA-ADVERSARIAL round 5, GAPS-116 ITEM 1 minor.)
 */

/** Verbatim binary command id: `glass.${"collapseOrExpandAllDiffFiles"}`. */
export const COLLAPSE_OR_EXPAND_ALL_DIFF_FILES_COMMAND_ID = 'glass.collapseOrExpandAllDiffFiles';

/** Verbatim binary title (glass @45494583). */
export const COLLAPSE_OR_EXPAND_ALL_DIFF_FILES_TITLE = 'Collapse / Expand All Files';

/** Verbatim binary icon id (glass font icon; no codicon equivalent — see header). */
export const COLLAPSE_OR_EXPAND_ALL_DIFF_FILES_ICON = 'list-bullets';

/** Verbatim binary keywords (glass @45494583). */
export const COLLAPSE_OR_EXPAND_ALL_DIFF_FILES_KEYWORDS: readonly string[] = ['collapse', 'expand', 'files', 'diffs', 'all'];

/** Verbatim glass event-bus type emitted by the command's `run`. */
export const COLLAPSE_OR_EXPAND_ALL_DIFFS_REQUESTED_EVENT = 'collapseOrExpandAllDiffsRequested';

/** Binary keybinding weight (`gp = 250`, glass @45469683). */
export const COLLAPSE_OR_EXPAND_ALL_DIFF_FILES_KEYBINDING_WEIGHT = 250;

/** Editor-panel tab kinds the binary `when` accepts (Ot, glass @23585381). */
export const COLLAPSE_OR_EXPAND_ALL_DIFF_FILES_TAB_KINDS: readonly string[] = ['diff', 'agentChanges', 'pr'];

export type CollapseOrExpandAllDiffFilesTarget = 'expand' | 'collapse' | 'none';

/**
 * Toggle decision, verbatim from the binary handlers: when every file is
 * collapsed the command expands all files, otherwise it collapses all
 * files. With no files there is nothing to toggle (the binary's PR
 * handler additionally guards on `hasDiffs`).
 */
export function planCollapseOrExpandAllDiffFiles(itemCount: number, allCollapsed: boolean): CollapseOrExpandAllDiffFilesTarget {
	if (itemCount <= 0) {
		return 'none';
	}
	return allCollapsed ? 'expand' : 'collapse';
}

/**
 * Whether every diff file is collapsed — same computation as the
 * multi-diff widget's `multiDiffEditorAllCollapsed` context key
 * (multiDiffEditorWidgetImpl.ts): `items.every(item => item.collapsed)`,
 * which is vacuously true for an empty list.
 */
export function computeAllDiffFilesCollapsed(collapsedStates: readonly boolean[]): boolean {
	return collapsedStates.every(state => state);
}

/**
 * The label the tab menu shows for the pending toggle action (binary:
 * `allCollapsed ? "Expand All" : "Collapse All"`, glass @33630478; the
 * same two strings are the desktop diff menu's action pair,
 * workbench.desktop.main.js @22830065).
 */
export function collapseOrExpandAllDiffFilesMenuLabel(allCollapsed: boolean): 'Expand All' | 'Collapse All' {
	return allCollapsed ? 'Expand All' : 'Collapse All';
}
