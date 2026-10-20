/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { test } from 'node:test';
import { Range } from '../../../../../editor/common/core/range.js';
import type { IPromptBarRef } from '../../common/inlineEditPromptBar.js';
import { resolveSameUriOverrideTarget } from '../../common/inlineEditPromptBar.js';
import type { IAutoSelectModel } from '../../common/autoSelect.js';
import { resolveEmptySelectionTarget } from '../../common/autoSelect.js';

/**
 * GAPS-189 — regression locks for QA-185 round 24 (NF-1 + point 5).
 *
 * NF-1 (same-uri branch of the modal.generate OVERRIDE path). Evidence
 * (Cursor 3.25.9 workbench.glass.main.js, `goo.run` @40731968+, re-sliced
 * by GAPS-189):
 *   P = getPromptBars().filter(ce => ce.uri.toString() === A.toString())
 *     with A = n?.overrideUri ?? active uri;
 *   if (P.length > 0) {
 *     ce = P[P.length - 1], ae = n?.overrideRange ?? T.getSelection();
 *     ae && !ae.isEmpty() ? executeCommand("aipopup.action.insertEditSelection", ce.id)
 *                         : executeCommand("aipopup.action.focusEdit", ce.id);
 *     return; // undefined
 *   }
 * The column-1 trim exists only AFTER this branch, on the create path's
 * `M` — `ae` is used AS GIVEN. GAPS-174 returned undefined without the
 * insert/focus side effect; `resolveSameUriOverrideTarget` is the shared
 * decision both fixed call sites (modal.generate's override branch and
 * `openPromptForRange`) execute through.
 *
 * Point 5 (explicitRange EMPTY at captureTarget): an explicit range
 * `(n,1,n,1)` — the shape `cmdK.resolveConflictInCmdK` produces when
 * startLine === endLine — takes the binary's empty-`M` flow in
 * `captureTarget`: heuristic expansion on a non-empty anchor line,
 * zero-width insert on an empty one. That decision now lives in
 * `resolveEmptySelectionTarget` (common/autoSelect.ts), which
 * captureTarget calls; the heuristic scoring itself is pinned by
 * inlineEditHeuristicSelect.test.ts (GAPS-172).
 */

const URI_A = 'file:///src/a.ts';
const URI_B = 'file:///src/b.ts';

const A_OLD: IPromptBarRef = { id: 'bar-a-old', createdAt: 100, uri: URI_A };
const A_NEW: IPromptBarRef = { id: 'bar-a-new', createdAt: 300, uri: URI_A };
const B_BAR: IPromptBarRef = { id: 'bar-b', createdAt: 200, uri: URI_B };

test('same-uri override: no bar for the uri → create', () => {
	assert.deepStrictEqual(resolveSameUriOverrideTarget([], URI_A, new Range(5, 1, 11, 1)), { kind: 'createPromptBar' });
	assert.deepStrictEqual(resolveSameUriOverrideTarget([B_BAR], URI_A, new Range(5, 1, 11, 1)), { kind: 'createPromptBar' });
});

test('same-uri override: bar + non-empty override range → insertEditSelection on the newest bar', () => {
	// The JcI-shaped range (startLine,1)-(endLine,1), startLine < endLine.
	assert.deepStrictEqual(
		resolveSameUriOverrideTarget([A_OLD, A_NEW, B_BAR], URI_A, new Range(5, 1, 11, 1)),
		{ kind: 'insertEditSelection', barId: 'bar-a-new' },
	);
	assert.deepStrictEqual(
		resolveSameUriOverrideTarget([A_OLD], URI_A, new Range(5, 1, 11, 1)),
		{ kind: 'insertEditSelection', barId: 'bar-a-old' },
	);
});

test('same-uri override: the range is used UNTRIMMED (column-1 trim belongs to the create path only)', () => {
	// (5,1)-(6,1) ends at column 1: the create path would trim it to
	// line 5 alone (collapsing to empty when line 5 is empty). The
	// same-uri branch never trims `ae` — the raw range is non-empty,
	// so the binary inserts.
	assert.deepStrictEqual(
		resolveSameUriOverrideTarget([A_OLD], URI_A, new Range(5, 1, 6, 1)),
		{ kind: 'insertEditSelection', barId: 'bar-a-old' },
	);
});

test('same-uri override: bar + EMPTY override range → focusEdit', () => {
	// (n,1,n,1) — the JcI range when startLine === endLine.
	assert.deepStrictEqual(
		resolveSameUriOverrideTarget([A_OLD], URI_A, new Range(7, 1, 7, 1)),
		{ kind: 'focusEdit', barId: 'bar-a-old' },
	);
});

test('same-uri override: bar + no override range → focusEdit (binary: ae falls back, empty selection focuses)', () => {
	assert.deepStrictEqual(
		resolveSameUriOverrideTarget([A_OLD], URI_A, undefined),
		{ kind: 'focusEdit', barId: 'bar-a-old' },
	);
});

// ---- explicitRange EMPTY at captureTarget (QA-185 point 5) ----

function stubModel(lines: string[], fsPath = '/src/app.ts'): IAutoSelectModel {
	return {
		uri: { fsPath },
		getLineCount: () => lines.length,
		getLineContent: (n) => lines[n - 1]!,
		getLineLength: (n) => lines[n - 1]!.length,
		getLineMaxColumn: (n) => lines[n - 1]!.length + 1,
		getLineFirstNonWhitespaceColumn: (n) => {
			const text = lines[n - 1]!;
			for (let i = 0; i < text.length; i++) {
				if (text[i] !== ' ' && text[i] !== '\t') {
					return i + 1;
				}
			}
			return text.length + 1;
		},
	};
}

test('empty explicit range (2,1,2,1) on a NON-EMPTY anchor line → heuristic expansion, not an insert', async () => {
	// Same fixture as the GAPS-172 isolated-line case: the top
	// suggestion is the folding fallback (2,1)-(2,13), score 30.
	const model = stubModel(['', 'const a = 1;', '']);
	let optionResolutions = 0;
	const resolved = await resolveEmptySelectionTarget(model, { lineNumber: 2, column: 1 }, async () => {
		optionResolutions++;
		return undefined;
	});
	assert.strictEqual(resolved.insertMode, false);
	assert.deepStrictEqual(resolved.range, { startLineNumber: 2, startColumn: 1, endLineNumber: 2, endColumn: 13 });
	assert.strictEqual(optionResolutions, 1, 'heuristic options are resolved on the non-empty path');
});

test('empty explicit range (2,1,2,1) inside an indented block → top heuristic suggestion wins', async () => {
	// GAPS-172 hand-computed fixture: folding 25 > group 18 > line 0,
	// top range (2,1)-(2,15).
	const model = stubModel(['function f() {', '  const a = 1;', '  const b = 2;', '}']);
	const resolved = await resolveEmptySelectionTarget(model, { lineNumber: 2, column: 1 }, async () => undefined);
	assert.strictEqual(resolved.insertMode, false);
	assert.deepStrictEqual(resolved.range, { startLineNumber: 2, startColumn: 1, endLineNumber: 2, endColumn: 15 });
});

test('empty explicit range (2,1,2,1) on an EMPTY anchor line → zero-width insert at the anchor', async () => {
	const model = stubModel(['const a = 1;', '', 'const b = 2;']);
	let optionResolutions = 0;
	const resolved = await resolveEmptySelectionTarget(model, { lineNumber: 2, column: 1 }, async () => {
		optionResolutions++;
		return undefined;
	});
	assert.strictEqual(resolved.insertMode, true);
	assert.deepStrictEqual(resolved.range, { startLineNumber: 2, startColumn: 1, endLineNumber: 2, endColumn: 1 });
	assert.strictEqual(optionResolutions, 0, 'folding options are NOT resolved for an empty anchor line (lazy, as in captureTarget)');
});
