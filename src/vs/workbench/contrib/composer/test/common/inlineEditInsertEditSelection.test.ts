/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { test } from 'node:test';
import { Range } from '../../../../../editor/common/core/range.js';
import { URI } from '../../../../../base/common/uri.js';
import {
	createPromptBarDataSelection,
	dedentPromptBarSelectionText,
	ITextModelSelectionSource,
	selectNewestPromptBarIdForUri,
} from '../../common/inlineEditPromptBar.js';

/**
 * DEV-GAPS-68 — `cmdk-insert-edit-selection` common-layer tests (Cursor parity).
 *
 * Evidence grounding (Cursor 3.25.9 workbench.glass.main.js, byte offsets
 * verified by direct reads):
 * - `Mfh({model, inBoundsSelectionRange})` @4286500 builds the data-selection
 *   item: text = "```"+languageId+"\n"+dedented+"\n```", rawText =
 *   model.getValueInRange(range), range mapped to
 *   {selectionStartLineNumber, selectionStartColumn, positionLineNumber,
 *   positionColumn}, uri = model.uri.
 * - `myn(t)` @4285903 is the dedent helper: minimum indentation of the
 *   non-empty lines, stripped; blank lines preserved as-is.
 * - `insertEditSelection` run (class Xfy @40742061):
 *   `!c || (r.appendDataSelection(n,c), !r.getPromptBar(n)) ||
 *   o.executeCommand(C$e,n)` — C$e = "aipopup.action.focusEdit"; guard order
 *   is `!s` (no editor) → `!s.hasModel()` ("No model found, cannot edit.") →
 *   `!l` ("No selection found, cannot edit.").
 * - `StartEditPrompt.run` @~40732800: `P = getPromptBars().filter(uri)`;
 *   when a bar is open for the document, the NEWEST bar gets
 *   `insertEditSelection(barId)` (non-empty selection) or `focusEdit(barId)`.
 */

function stubModel(text: string, languageId = 'typescript'): ITextModelSelectionSource {
	return {
		getValueInRange: () => text,
		getLanguageIdAtPosition: () => languageId,
		uri: URI.parse('file:///src/app.ts'),
	};
}

test('fence format is verbatim the binary: ```<languageId>\\n<dedented>\\n```', () => {
	const item = createPromptBarDataSelection(stubModel('const a = 1;'), new Range(2, 3, 2, 14));
	assert.strictEqual(item.text, '```typescript\nconst a = 1;\n```');
	assert.strictEqual(item.rawText, 'const a = 1;');
	assert.strictEqual(item.uri.toString(), 'file:///src/app.ts');
});

test('range maps selection→{selectionStart*, position*} like the binary', () => {
	const item = createPromptBarDataSelection(stubModel('x'), new Range(4, 5, 9, 2));
	assert.deepStrictEqual(item.range, {
		selectionStartLineNumber: 4,
		selectionStartColumn: 5,
		positionLineNumber: 9,
		positionColumn: 2,
	});
});

test('empty selection text still builds an item (binary appends unconditionally)', () => {
	const item = createPromptBarDataSelection(stubModel(''), new Range(1, 1, 1, 1));
	assert.strictEqual(item.text, '```typescript\n\n```');
});

test('dedent: strips the common indent, keeps blank lines (verbatim myn)', () => {
	// The trailing whitespace-only line stays as-is — verbatim `myn`
	// behavior (`s.trim().length===0 ? s : s.slice(i)`).
	assert.strictEqual(
		dedentPromptBarSelectionText('    const a = 1;\n\n      const b = 2;\n    '),
		'const a = 1;\n\n  const b = 2;\n    ',
	);
});

test('dedent: lines without indentation are untouched', () => {
	assert.strictEqual(dedentPromptBarSelectionText('a\nb\nc'), 'a\nb\nc');
});

test('dedent: single line never changes', () => {
	assert.strictEqual(dedentPromptBarSelectionText('  indented'), 'indented');
});

test('dedent of empty string stays empty (Math.min of [] = Infinity → slice = "")', () => {
	assert.strictEqual(dedentPromptBarSelectionText(''), '');
});

test('dedent: deep selection indents are dedented like the binary before fencing', () => {
	const item = createPromptBarDataSelection(
		stubModel('        if (x) {\n            return 1;\n        }'),
		new Range(10, 9, 12, 10),
	);
	assert.strictEqual(item.text, '```typescript\nif (x) {\n    return 1;\n}\n```');
});

test('selectNewestPromptBarIdForUri: newest bar for the document uri', () => {
	const bars = [
		{ id: 'bar-a', createdAt: 100, uri: 'file:///a.ts' },
		{ id: 'bar-b', createdAt: 200, uri: 'file:///b.ts' },
		{ id: 'bar-c', createdAt: 300, uri: 'file:///a.ts' },
	];
	assert.strictEqual(selectNewestPromptBarIdForUri(bars, 'file:///a.ts'), 'bar-c');
	assert.strictEqual(selectNewestPromptBarIdForUri(bars, 'file:///b.ts'), 'bar-b');
});

test('selectNewestPromptBarIdForUri: no bar for uri → undefined', () => {
	const bars = [{ id: 'bar-a', createdAt: 100, uri: 'file:///a.ts' }];
	assert.strictEqual(selectNewestPromptBarIdForUri(bars, 'file:///c.ts'), undefined);
	assert.strictEqual(selectNewestPromptBarIdForUri([], 'file:///a.ts'), undefined);
});

test('selectNewestPromptBarIdForUri: bars without uri are ignored (backward compat)', () => {
	const bars = [
		{ id: 'bar-a', createdAt: 100 },
		{ id: 'bar-b', createdAt: 50, uri: 'file:///a.ts' },
	];
	assert.strictEqual(selectNewestPromptBarIdForUri(bars, 'file:///a.ts'), 'bar-b');
});

test('selectNewestPromptBarIdForUri: equal createdAt prefers the later entry', () => {
	const bars = [
		{ id: 'bar-a', createdAt: 100, uri: 'file:///a.ts' },
		{ id: 'bar-b', createdAt: 100, uri: 'file:///a.ts' },
	];
	assert.strictEqual(selectNewestPromptBarIdForUri(bars, 'file:///a.ts'), 'bar-b');
});
