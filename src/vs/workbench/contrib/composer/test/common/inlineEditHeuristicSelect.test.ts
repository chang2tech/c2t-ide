/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { test } from 'node:test';
import {
	calculateScore,
	findSuggestionRangeOfType,
	heuristicSelect,
	trimSelectionEndingAtColumn1,
	type IAutoSelectModel,
} from '../../common/autoSelect.js';

/**
 * GAPS-172 — `inline-edit-empty-selection` (#28) common-layer tests.
 *
 * Evidence grounding (Cursor 3.25.9, byte offsets verified by GAPS-172):
 * - `autoSelectService.heuristicSelect` definition: glass @40724602,
 *   desktop @32221107 — candidates `["line","group","folding"]`, scored by
 *   `calculateScore`, sorted desc, deduped by range (default).
 * - Sole caller: `StartEditPrompt.run` (glass @40734485) — empty selection
 *   on a NON-EMPTY line → top suggestion (`ce[0]`) becomes the edit range.
 * - Column-1 trim: glass @40733372 / desktop @32229876 — non-empty,
 *   multi-line, `endColumn===1` → end becomes
 *   `(endLineNumber-1, getLineMaxColumn(endLineNumber-1))`.
 *
 * Every expected score below is computed by hand from the binary's scoring
 * table (see work-notes-gaps172.md Slice 1.4), not from the implementation.
 */

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

const BLOCK = ['function f() {', '  const a = 1;', '  const b = 2;', '}'];

test('heuristicSelect: isolated line — folding fallback wins, group deduped against it', async () => {
	// Scores by hand: folding 30 (+10 base, +10 prev-blank, +10 same indents),
	// group 20 (+10 prev-blank, +10 end/start indent equal), line 18 (+18 both-blank).
	// Folding fallback range (2,1)-(2,13) == group range → group deduped out.
	const result = await heuristicSelect(stubModel(['', 'const a = 1;', '']), { lineNumber: 2, column: 5 });
	assert.deepStrictEqual(result, [
		{ score: 30, type: 'folding', initialSelectionRange: { startLineNumber: 2, startColumn: 1, endLineNumber: 2, endColumn: 13 }, rangeDecorationId: '' },
		{ score: 18, type: 'line', initialSelectionRange: { startLineNumber: 2, startColumn: 1, endLineNumber: 2, endColumn: 12 }, rangeDecorationId: '' },
	]);
});

test('heuristicSelect: cursor inside an indented block — order folding > group > line', async () => {
	// folding 25 (+10 base, +10 c===u, +5 !o&&!a), group 18 (+10 c===u, +5 prev
	// indent differs, +3 !o&&!a), line 0 (neighbours non-blank).
	const result = await heuristicSelect(stubModel(BLOCK), { lineNumber: 2, column: 3 });
	assert.deepStrictEqual(result, [
		{ score: 25, type: 'folding', initialSelectionRange: { startLineNumber: 2, startColumn: 1, endLineNumber: 2, endColumn: 15 }, rangeDecorationId: '' },
		{ score: 18, type: 'group', initialSelectionRange: { startLineNumber: 2, startColumn: 1, endLineNumber: 3, endColumn: 15 }, rangeDecorationId: '' },
		{ score: 0, type: 'line', initialSelectionRange: { startLineNumber: 2, startColumn: 1, endLineNumber: 2, endColumn: 14 }, rangeDecorationId: '' },
	]);
});

test('heuristicSelect: folding region with end-line indent shallower → region end + 1', async () => {
	// Region {1,3}: indent(start)=1 < indent(end line 3)=3 → o = end+1 = 4.
	// folding 25, group range identical → deduped, line 0.
	const result = await heuristicSelect(stubModel(BLOCK), { lineNumber: 1, column: 1 }, { foldingRegion: { startLineNumber: 1, endLineNumber: 3 } });
	assert.deepStrictEqual(result, [
		{ score: 25, type: 'folding', initialSelectionRange: { startLineNumber: 1, startColumn: 1, endLineNumber: 4, endColumn: 2 }, rangeDecorationId: '' },
		{ score: 0, type: 'line', initialSelectionRange: { startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 14 }, rangeDecorationId: '' },
	]);
});

test('heuristicSelect: folding region with equal end indent → region end kept', async () => {
	// Region {1,3} over ["if (x) {","  y();","}"]: indent(1)=1 >= indent(3)=1 → o=3.
	const result = await heuristicSelect(stubModel(['if (x) {', '  y();', '}']), { lineNumber: 1, column: 1 }, { foldingRegion: { startLineNumber: 1, endLineNumber: 3 } });
	assert.strictEqual(result[0]!.type, 'folding');
	assert.strictEqual(result[0]!.score, 25);
	assert.deepStrictEqual(result[0]!.initialSelectionRange, { startLineNumber: 1, startColumn: 1, endLineNumber: 3, endColumn: 2 });
});

test('heuristicSelect: folding model present but no region at line → single-line range', async () => {
	const result = await heuristicSelect(stubModel(BLOCK), { lineNumber: 2, column: 3 }, { foldingRegion: null });
	const folding = result.find(r => r.type === 'folding');
	assert.deepStrictEqual(folding!.initialSelectionRange, { startLineNumber: 2, startColumn: 1, endLineNumber: 2, endColumn: 15 });
});

test('heuristicSelect: Rust comment line gets the +15 line bonus and wins', async () => {
	// line 33 (+18 both-blank, +15 ".rs" + "#"), folding 30, group deduped.
	const result = await heuristicSelect(stubModel(['', '# comment', ''], '/src/x.rs'), { lineNumber: 2, column: 2 });
	assert.strictEqual(result[0]!.type, 'line');
	assert.strictEqual(result[0]!.score, 33);
	assert.deepStrictEqual(result[0]!.initialSelectionRange, { startLineNumber: 2, startColumn: 1, endLineNumber: 2, endColumn: 9 });
	assert.strictEqual(result[1]!.type, 'folding');
	assert.strictEqual(result[1]!.score, 30);
});

test('heuristicSelect: skipSuggestionTypes removes candidates (binary option)', async () => {
	const result = await heuristicSelect(stubModel(BLOCK), { lineNumber: 2, column: 3 }, { skipSuggestionTypes: ['folding', 'group'] });
	assert.deepStrictEqual(result.map(r => r.type), ['line']);
});

test('heuristicSelect: shouldDedupe=false keeps duplicate ranges', async () => {
	const result = await heuristicSelect(stubModel(['', 'const a = 1;', '']), { lineNumber: 2, column: 5 }, { shouldDedupe: false });
	assert.deepStrictEqual(result.map(r => r.type), ['folding', 'group', 'line']);
});

test('findSuggestionRangeOfType: group stops at lower indent and at blank lines', () => {
	const model = stubModel(['const x = 0;', '  a();', '  b();', '', '  c();']);
	assert.deepStrictEqual(
		findSuggestionRangeOfType(model, { lineNumber: 2, column: 3 }, 'group'),
		{ startLineNumber: 2, startColumn: 1, endLineNumber: 3, endColumn: 7 },
	);
});

test('calculateScore: group candidate starting above the cursor takes the −10 penalty', () => {
	// Cursor on line 3 of BLOCK: group range is (2..3); by hand: +10 (c===u),
	// +3 (!o&&!a), −10 (l===u && cursor line !== range start) = 3.
	const model = stubModel(BLOCK);
	const range = findSuggestionRangeOfType(model, { lineNumber: 3, column: 3 }, 'group');
	assert.deepStrictEqual(range, { startLineNumber: 2, startColumn: 1, endLineNumber: 3, endColumn: 15 });
	assert.strictEqual(calculateScore(model, { type: 'group', range, base: { lineNumber: 3, column: 3 } }), 3);
});

test('trim: multi-line selection ending at column 1 drops the last line', () => {
	const model = stubModel(['aaa', 'bbb', 'ccc']);
	assert.deepStrictEqual(
		trimSelectionEndingAtColumn1(model, { startLineNumber: 1, startColumn: 1, endLineNumber: 3, endColumn: 1 }),
		{ startLineNumber: 1, startColumn: 1, endLineNumber: 2, endColumn: 4 },
	);
});

test('trim: start column is preserved verbatim', () => {
	const model = stubModel(['aaa', 'bbb', 'ccc']);
	assert.deepStrictEqual(
		trimSelectionEndingAtColumn1(model, { startLineNumber: 1, startColumn: 2, endLineNumber: 2, endColumn: 1 }),
		{ startLineNumber: 1, startColumn: 2, endLineNumber: 1, endColumn: 4 },
	);
});

test('trim: selection ending past column 1 is untouched', () => {
	const model = stubModel(['aaa', 'bbb', 'ccc']);
	const sel = { startLineNumber: 1, startColumn: 1, endLineNumber: 2, endColumn: 3 };
	assert.deepStrictEqual(trimSelectionEndingAtColumn1(model, sel), sel);
});

test('trim: single-line selection ending at column 1 is untouched (not multi-line)', () => {
	const model = stubModel(['aaa', 'bbb', 'ccc']);
	const sel = { startLineNumber: 2, startColumn: 1, endLineNumber: 2, endColumn: 1 };
	assert.deepStrictEqual(trimSelectionEndingAtColumn1(model, sel), sel);
});

test('trim: empty selection is untouched even at a line boundary', () => {
	const model = stubModel(['aaa', 'bbb', 'ccc']);
	const sel = { startLineNumber: 3, startColumn: 1, endLineNumber: 3, endColumn: 1 };
	assert.deepStrictEqual(trimSelectionEndingAtColumn1(model, sel), sel);
});

test('trim: Range-shaped input (isEmpty as a method) is honoured', () => {
	const model = stubModel(['aaa', 'bbb', 'ccc']);
	const rangeLike = { startLineNumber: 1, startColumn: 1, endLineNumber: 3, endColumn: 1, isEmpty: () => false };
	assert.deepStrictEqual(
		trimSelectionEndingAtColumn1(model, rangeLike),
		{ startLineNumber: 1, startColumn: 1, endLineNumber: 2, endColumn: 4 },
	);
	const emptyLike = { startLineNumber: 1, startColumn: 1, endLineNumber: 3, endColumn: 1, isEmpty: () => true };
	assert.deepStrictEqual(trimSelectionEndingAtColumn1(model, emptyLike), emptyLike);
});
