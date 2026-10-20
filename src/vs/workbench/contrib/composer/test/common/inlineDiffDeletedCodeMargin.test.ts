/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import {
	computeDeletedMarginLayout,
	type IInlineDiffDeletedLine,
} from '../../common/inlineDiffDeletedCodeMargin.js';

/**
 * DEV-GAPS-53 — deleted-code margin (`inline-diff-deleted-code-margin`).
 *
 * Binary evidence (Cursor 3.25.9, workbench.glass.main.js,
 * `inlineDiffDeletedCodeMargin.js`): a dedicated scroll-aware margin shows
 * the inline diff's deleted code; it computes the visible deleted-line
 * counts above and below the viewport (`_visibleLineCountTop`,
 * `_visibleLineCountBottom`), each clamped by the line count.
 */
suite('computeDeletedMarginLayout (DEV-GAPS-53)', () => {

	const lines = (anchors: number[]): IInlineDiffDeletedLine[] =>
		anchors.map((anchorLineNumber, i) => ({
			anchorLineNumber,
			text: `deleted ${i}`,
			hunkIndex: Math.floor(i / 2),
		}));

	test('rows only contain lines anchored inside the viewport', () => {
		const layout = computeDeletedMarginLayout(lines([5, 10, 15, 20]), 10, 15);
		assert.deepStrictEqual(layout.rows.map(r => r.anchorLineNumber), [10, 15]);
		assert.strictEqual(layout.totalLineCount, 4);
	});

	test('top/bottom counts reflect lines anchored outside the viewport', () => {
		const layout = computeDeletedMarginLayout(lines([5, 10, 15, 20]), 10, 15);
		assert.strictEqual(layout.visibleLineCountTop, 1);
		assert.strictEqual(layout.visibleLineCountBottom, 1);
	});

	test('counts are clamped by the line count', () => {
		const layout = computeDeletedMarginLayout(lines([1, 2, 3]), 10, 20);
		// All 3 lines are above the viewport; top count is bounded by the total.
		assert.strictEqual(layout.visibleLineCountTop, 3);
		assert.strictEqual(layout.visibleLineCountBottom, 0);
		assert.ok(layout.visibleLineCountTop <= layout.totalLineCount);
		assert.ok(layout.visibleLineCountBottom <= layout.totalLineCount);

		const below = computeDeletedMarginLayout(lines([30, 31]), 1, 10);
		assert.strictEqual(below.visibleLineCountTop, 0);
		assert.strictEqual(below.visibleLineCountBottom, 2);
	});

	test('empty input yields empty layout with zero counts', () => {
		const layout = computeDeletedMarginLayout([], 1, 100);
		assert.deepStrictEqual(layout.rows, []);
		assert.strictEqual(layout.visibleLineCountTop, 0);
		assert.strictEqual(layout.visibleLineCountBottom, 0);
		assert.strictEqual(layout.totalLineCount, 0);
	});

	test('rows carry the deleted text and hunk index', () => {
		const layout = computeDeletedMarginLayout(lines([12]), 1, 100);
		assert.strictEqual(layout.rows.length, 1);
		assert.strictEqual(layout.rows[0]!.text, 'deleted 0');
		assert.strictEqual(layout.rows[0]!.hunkIndex, 0);
		assert.strictEqual(layout.rows[0]!.anchorLineNumber, 12);
	});
});
