/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * DEV-GAPS-103 — `collapse-all-files-shortcut` pure-logic tests.
 *
 * Expectations pinned to self-verified Cursor 3.25.9 binary evidence:
 * - id table: workbench.desktop.main.js @28710016 /
 *   workbench.glass.main.js @25985230 —
 *   `glass.collapseOrExpandAllDiffFiles`
 * - registration: glass @45494583 — title "Collapse / Expand All Files",
 *   icon "list-bullets", keywords ["collapse","expand","files","diffs",
 *   "all"], f1:!1, event "collapseOrExpandAllDiffsRequested"
 * - keybinding weight: `gp = 250` (glass @45469683)
 * - tab kinds: Ot (glass @23585381) — "diff" | "agentChanges" | "pr"
 * - toggle semantics: glass @34031310 (allCollapsed → expand, else
 *   collapse) and glass @33630478 (menu label "Expand All"/"Collapse
 *   All"); desktop pair at workbench.desktop.main.js @22830065.
 *
 * Action/keybinding wiring is asserted in
 * test/browser/changesViewActions.test.ts.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert';
import {
	COLLAPSE_OR_EXPAND_ALL_DIFF_FILES_COMMAND_ID,
	COLLAPSE_OR_EXPAND_ALL_DIFF_FILES_ICON,
	COLLAPSE_OR_EXPAND_ALL_DIFF_FILES_KEYBINDING_WEIGHT,
	COLLAPSE_OR_EXPAND_ALL_DIFF_FILES_KEYWORDS,
	COLLAPSE_OR_EXPAND_ALL_DIFF_FILES_TAB_KINDS,
	COLLAPSE_OR_EXPAND_ALL_DIFF_FILES_TITLE,
	COLLAPSE_OR_EXPAND_ALL_DIFFS_REQUESTED_EVENT,
	collapseOrExpandAllDiffFilesMenuLabel,
	computeAllDiffFilesCollapsed,
	planCollapseOrExpandAllDiffFiles,
} from '../../common/collapseAllDiffFiles.js';

describe('collapseAllDiffFiles (DEV-GAPS-103, Cursor 3.25.9 parity)', () => {
	it('verbatim command registration data', () => {
		assert.equal(COLLAPSE_OR_EXPAND_ALL_DIFF_FILES_COMMAND_ID, 'glass.collapseOrExpandAllDiffFiles');
		assert.equal(COLLAPSE_OR_EXPAND_ALL_DIFF_FILES_TITLE, 'Collapse / Expand All Files');
		assert.equal(COLLAPSE_OR_EXPAND_ALL_DIFF_FILES_ICON, 'list-bullets');
		assert.deepEqual([...COLLAPSE_OR_EXPAND_ALL_DIFF_FILES_KEYWORDS], ['collapse', 'expand', 'files', 'diffs', 'all']);
		assert.equal(COLLAPSE_OR_EXPAND_ALL_DIFFS_REQUESTED_EVENT, 'collapseOrExpandAllDiffsRequested');
		assert.equal(COLLAPSE_OR_EXPAND_ALL_DIFF_FILES_KEYBINDING_WEIGHT, 250);
		assert.deepEqual([...COLLAPSE_OR_EXPAND_ALL_DIFF_FILES_TAB_KINDS], ['diff', 'agentChanges', 'pr']);
	});

	it('toggle: all collapsed expands, anything else collapses', () => {
		assert.equal(planCollapseOrExpandAllDiffFiles(5, true), 'expand');
		assert.equal(planCollapseOrExpandAllDiffFiles(5, false), 'collapse');
		assert.equal(planCollapseOrExpandAllDiffFiles(1, true), 'expand');
		assert.equal(planCollapseOrExpandAllDiffFiles(1, false), 'collapse');
	});

	it('toggle: no files is a no-op', () => {
		assert.equal(planCollapseOrExpandAllDiffFiles(0, true), 'none');
		assert.equal(planCollapseOrExpandAllDiffFiles(0, false), 'none');
	});

	it('all-collapsed computation matches the multi-diff widget (every, vacuous true)', () => {
		assert.equal(computeAllDiffFilesCollapsed([true, true, true]), true);
		assert.equal(computeAllDiffFilesCollapsed([true, false]), false);
		assert.equal(computeAllDiffFilesCollapsed([false]), false);
		assert.equal(computeAllDiffFilesCollapsed([]), true);
	});

	it('menu label is Expand All only when all files are collapsed', () => {
		assert.equal(collapseOrExpandAllDiffFilesMenuLabel(true), 'Expand All');
		assert.equal(collapseOrExpandAllDiffFilesMenuLabel(false), 'Collapse All');
	});
});
