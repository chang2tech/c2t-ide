/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { test } from 'node:test';
import type { IPromptBarRef } from '../../common/inlineEditPromptBar.js';
import { selectNextPromptBarId } from '../../common/inlineEditPromptBar.js';

/**
 * WORKER W60C — `cmdk-next-prompt-bar` tests (Cursor parity).
 *
 * Evidence grounding (Cursor 3.25.9 workbench.glass.main.js, class Yfy —
 * `Jqc.ID="aipopup.action.nextPromptBar"`, LABEL "Next Prompt Bar", f1:!0):
 *   const l = [...r.getPromptBars()].sort((u, d) => u.createdAt - d.createdAt),
 *         c = l.findIndex(u => u.id === n);
 *   if (c < l.length - 1 ? o = l[c + 1] : o = l[0], o && o.id !== n)
 *       s.executeCommand(C$e, o.id);   // C$e = "aipopup.action.focusEdit"
 *   else { focus the active code editor (when it has a model) }
 *
 * `selectNextPromptBarId` returns the id to pass to focusEdit, or
 * `undefined` for the binary's else-branch (focus the editor instead).
 * The action-level behavior is covered by
 * test/browser/aipopupPromptBarActions.test.ts.
 */

const A: IPromptBarRef = { id: 'bar-a', createdAt: 100 };
const B: IPromptBarRef = { id: 'bar-b', createdAt: 200 };
const C: IPromptBarRef = { id: 'bar-c', createdAt: 300 };

test('no bars open → undefined (binary else-branch: focus editor)', () => {
	assert.strictEqual(selectNextPromptBarId([], undefined), undefined);
	assert.strictEqual(selectNextPromptBarId([], 'bar-a'), undefined);
});

test('single bar, no current id (palette invocation) → focuses that bar', () => {
	// Binary: c = -1 < l.length-1 = 0 → o = l[0]; o.id !== undefined.
	assert.strictEqual(selectNextPromptBarId([A], undefined), 'bar-a');
});

test('single bar already focused → undefined (o.id === n → focus editor)', () => {
	assert.strictEqual(selectNextPromptBarId([A], 'bar-a'), undefined);
});

test('two bars: cycles forward and wraps around (createdAt order)', () => {
	assert.strictEqual(selectNextPromptBarId([A, B], 'bar-a'), 'bar-b');
	// Wrap: current is the newest → next is the oldest.
	assert.strictEqual(selectNextPromptBarId([A, B], 'bar-b'), 'bar-a');
	// No current id → the oldest bar (binary picks l[0]).
	assert.strictEqual(selectNextPromptBarId([A, B], undefined), 'bar-a');
});

test('sorts by createdAt even when the service returns unsorted bars', () => {
	assert.strictEqual(selectNextPromptBarId([C, A, B], 'bar-a'), 'bar-b');
	assert.strictEqual(selectNextPromptBarId([C, A, B], 'bar-c'), 'bar-a');
	assert.strictEqual(selectNextPromptBarId([B, C, A], undefined), 'bar-a');
});

test('three bars: middle → next younger; newest wraps to oldest', () => {
	assert.strictEqual(selectNextPromptBarId([A, B, C], 'bar-b'), 'bar-c');
	assert.strictEqual(selectNextPromptBarId([A, B, C], 'bar-c'), 'bar-a');
});

test('unknown current id behaves like no current id (findIndex = -1)', () => {
	assert.strictEqual(selectNextPromptBarId([A, B, C], 'bar-gone'), 'bar-a');
});

test('equal createdAt keeps input order (stable sort, like the binary)', () => {
	const X: IPromptBarRef = { id: 'bar-x', createdAt: 500 };
	const Y: IPromptBarRef = { id: 'bar-y', createdAt: 500 };
	assert.strictEqual(selectNextPromptBarId([X, Y], 'bar-x'), 'bar-y');
	assert.strictEqual(selectNextPromptBarId([X, Y], 'bar-y'), 'bar-x');
});
