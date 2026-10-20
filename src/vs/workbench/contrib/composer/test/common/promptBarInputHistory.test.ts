/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { test } from 'node:test';
import {
	canRedoPromptBarInput,
	canUndoPromptBarInput,
	clearPromptBarInputHistory,
	createPromptBarInputHistoryState,
	IPromptBarInputSnapshot,
	promptBarHistoryShortcut,
	recordPromptBarInputHistory,
	redoPromptBarInputHistory,
	undoPromptBarInputHistory,
} from '../../common/promptBarInputHistory.js';

/**
 * GAPS-139 — per-prompt-bar input history tests
 * (feature_id `lexical-undo-redo-prompt-bar`).
 *
 * Evidence grounding (Cursor 3.25.9 workbench.desktop.main.js —
 * docs/rea/work-notes-gaps139.md):
 *   - History state `ONp()`: `{current:null, redoStack:[], undoStack:[]}`.
 *   - `Ifr` (undo) @24365252 / `Efr` (redo) @24364990: pop one stack,
 *     push current onto the other, apply popped with tag "historic";
 *     empty stack → no-op.
 *   - Update listener PUSH branch: redo stack cleared
 *     (`t.redoStack=[]`), previous current pushed onto undo stack.
 *   - Prompt-bar history delay is 100ms (`n2b(..., 100, ...)`); rapid
 *     same-kind continuation edits MERGE into one step.
 *   - Keys (`QKo` keydown @24505898): undo = (meta||ctrl)+z+!shift;
 *     redo = (meta||ctrl)+((z&&shift) || (!mac && ctrl && y && !shift)).
 */

function snap(value: string, selectionStart = value.length, selectionEnd = value.length): IPromptBarInputSnapshot {
	return { value, selectionStart, selectionEnd };
}

test('create: ONp shape — current null, both stacks empty', () => {
	const s = createPromptBarInputHistoryState();
	assert.strictEqual(s.current, null);
	assert.deepStrictEqual(s.undoStack, []);
	assert.deepStrictEqual(s.redoStack, []);
	assert.strictEqual(canUndoPromptBarInput(s), false);
	assert.strictEqual(canRedoPromptBarInput(s), false);
});

test('initial record becomes current and creates NO undo step', () => {
	const s = createPromptBarInputHistoryState();
	assert.strictEqual(recordPromptBarInputHistory(s, snap(''), 0), 'initial');
	assert.strictEqual(s.current?.value, '');
	assert.strictEqual(s.undoStack.length, 0);
	// Bottom of stack: undo is a no-op (binary Ifr guards length!==0).
	assert.strictEqual(undoPromptBarInputHistory(s), undefined);
	assert.strictEqual(s.current?.value, '');
});

test('typing burst within 100ms merges into ONE undo step', () => {
	const s = createPromptBarInputHistoryState();
	recordPromptBarInputHistory(s, snap(''), 0);
	assert.strictEqual(recordPromptBarInputHistory(s, snap('a'), 10), 'push');
	assert.strictEqual(recordPromptBarInputHistory(s, snap('ab'), 50), 'merge');
	assert.strictEqual(recordPromptBarInputHistory(s, snap('abc'), 90), 'merge');
	assert.strictEqual(s.undoStack.length, 1);
	assert.strictEqual(canUndoPromptBarInput(s), true);
	// One undo returns to the initial (empty) snapshot…
	assert.strictEqual(undoPromptBarInputHistory(s)?.value, '');
	assert.strictEqual(canUndoPromptBarInput(s), false);
	// …and one redo restores the whole burst.
	assert.strictEqual(redoPromptBarInputHistory(s)?.value, 'abc');
	assert.strictEqual(canRedoPromptBarInput(s), false);
});

test('edit after the merge delay is a separate PUSH step', () => {
	const s = createPromptBarInputHistoryState();
	recordPromptBarInputHistory(s, snap(''), 0);
	assert.strictEqual(recordPromptBarInputHistory(s, snap('a'), 10), 'push');
	assert.strictEqual(recordPromptBarInputHistory(s, snap('ab'), 500), 'push');
	assert.strictEqual(s.undoStack.length, 2);
	assert.strictEqual(undoPromptBarInputHistory(s)?.value, 'a');
	assert.strictEqual(undoPromptBarInputHistory(s)?.value, '');
	assert.strictEqual(undoPromptBarInputHistory(s), undefined);
	assert.strictEqual(redoPromptBarInputHistory(s)?.value, 'a');
	assert.strictEqual(redoPromptBarInputHistory(s)?.value, 'ab');
	assert.strictEqual(redoPromptBarInputHistory(s), undefined);
});

test('backspace burst merges; direction change starts a new step', () => {
	const s = createPromptBarInputHistoryState();
	recordPromptBarInputHistory(s, snap('hello'), 0);
	assert.strictEqual(recordPromptBarInputHistory(s, snap('hell'), 10), 'push');
	assert.strictEqual(recordPromptBarInputHistory(s, snap('hel'), 40), 'merge');
	assert.strictEqual(recordPromptBarInputHistory(s, snap('he'), 70), 'merge');
	assert.strictEqual(s.undoStack.length, 1);
	// Insert right after deletes — different kind → PUSH even within delay.
	assert.strictEqual(recordPromptBarInputHistory(s, snap('hex'), 90), 'push');
	assert.strictEqual(s.undoStack.length, 2);
	assert.strictEqual(undoPromptBarInputHistory(s)?.value, 'he');
	assert.strictEqual(undoPromptBarInputHistory(s)?.value, 'hello');
});

test('a fresh edit after undo CLEARS the redo stack (binary PUSH branch)', () => {
	const s = createPromptBarInputHistoryState();
	recordPromptBarInputHistory(s, snap(''), 0);
	recordPromptBarInputHistory(s, snap('a'), 10);
	recordPromptBarInputHistory(s, snap('ab'), 500);
	assert.strictEqual(undoPromptBarInputHistory(s)?.value, 'a');
	assert.strictEqual(canRedoPromptBarInput(s), true);
	assert.strictEqual(recordPromptBarInputHistory(s, snap('ax'), 1000), 'push');
	assert.strictEqual(canRedoPromptBarInput(s), false);
	assert.strictEqual(redoPromptBarInputHistory(s), undefined);
	// And the new branch undoes cleanly: ax → a → ''.
	assert.strictEqual(undoPromptBarInputHistory(s)?.value, 'a');
	assert.strictEqual(undoPromptBarInputHistory(s)?.value, '');
});

test('identical snapshot and selection-only changes are discarded', () => {
	const s = createPromptBarInputHistoryState();
	recordPromptBarInputHistory(s, snap('abc', 3, 3), 0);
	assert.strictEqual(recordPromptBarInputHistory(s, snap('abc', 3, 3), 10), 'discard');
	// Selection moved, text unchanged → no history entry.
	assert.strictEqual(recordPromptBarInputHistory(s, snap('abc', 0, 0), 20), 'discard');
	assert.strictEqual(s.undoStack.length, 0);
	assert.strictEqual(s.current?.selectionStart, 3); // untouched by the discard
});

test('replace edits never merge — each is its own step', () => {
	const s = createPromptBarInputHistoryState();
	recordPromptBarInputHistory(s, snap('abc'), 0);
	// Select-all + retype twice in quick succession.
	assert.strictEqual(recordPromptBarInputHistory(s, snap('x', 1, 1), 10), 'push');
	assert.strictEqual(recordPromptBarInputHistory(s, snap('y', 1, 1), 30), 'push');
	assert.strictEqual(s.undoStack.length, 2);
	assert.strictEqual(undoPromptBarInputHistory(s)?.value, 'x');
	assert.strictEqual(undoPromptBarInputHistory(s)?.value, 'abc');
});

test('non-contiguous insert does not merge (caret jump)', () => {
	const s = createPromptBarInputHistoryState();
	recordPromptBarInputHistory(s, snap(''), 0);
	assert.strictEqual(recordPromptBarInputHistory(s, snap('a'), 10), 'push');
	// Insert at position 0 while the previous insert ended at 1.
	assert.strictEqual(recordPromptBarInputHistory(s, snap('ba', 1, 1), 40), 'push');
	assert.strictEqual(s.undoStack.length, 2);
});

test('an undo breaks the merge burst — next edit pushes (and kills redo)', () => {
	const s = createPromptBarInputHistoryState();
	recordPromptBarInputHistory(s, snap(''), 0);
	recordPromptBarInputHistory(s, snap('a'), 10);
	recordPromptBarInputHistory(s, snap('ab'), 40); // merge
	assert.strictEqual(undoPromptBarInputHistory(s)?.value, '');
	// Same continuation shape, but we just undid: must PUSH, not merge.
	assert.strictEqual(recordPromptBarInputHistory(s, snap('x'), 60), 'push');
	assert.strictEqual(canRedoPromptBarInput(s), false);
});

test('clear empties both stacks and current (xfr port)', () => {
	const s = createPromptBarInputHistoryState();
	recordPromptBarInputHistory(s, snap(''), 0);
	recordPromptBarInputHistory(s, snap('a'), 10);
	recordPromptBarInputHistory(s, snap('ab'), 500);
	undoPromptBarInputHistory(s);
	clearPromptBarInputHistory(s);
	assert.strictEqual(s.current, null);
	assert.strictEqual(canUndoPromptBarInput(s), false);
	assert.strictEqual(canRedoPromptBarInput(s), false);
	// After clear, the next record is an initial again.
	assert.strictEqual(recordPromptBarInputHistory(s, snap('z'), 1000), 'initial');
});

test('snapshots carry the selection through undo/redo', () => {
	const s = createPromptBarInputHistoryState();
	recordPromptBarInputHistory(s, snap('hello', 5, 5), 0);
	recordPromptBarInputHistory(s, snap('hello world', 11, 11), 1000);
	const undone = undoPromptBarInputHistory(s);
	assert.strictEqual(undone?.value, 'hello');
	assert.strictEqual(undone?.selectionStart, 5);
	const redone = redoPromptBarInputHistory(s);
	assert.strictEqual(redone?.value, 'hello world');
	assert.strictEqual(redone?.selectionStart, 11);
});

test('history states are independent per bar (promptBarId scoping)', () => {
	const a = createPromptBarInputHistoryState();
	const b = createPromptBarInputHistoryState();
	recordPromptBarInputHistory(a, snap(''), 0);
	recordPromptBarInputHistory(a, snap('aaa'), 10);
	recordPromptBarInputHistory(b, snap('seed'), 0);
	// Undo in bar A must not touch bar B.
	assert.strictEqual(undoPromptBarInputHistory(a)?.value, '');
	assert.strictEqual(b.current?.value, 'seed');
	assert.strictEqual(canUndoPromptBarInput(b), false);
});

/**
 * GAPS-151 (NF-146-1) — ↑/↓ prompt-history navigation recording.
 *
 * Binary evidence (QA-146 point 9/D5, re-sliced; spot-checked by
 * GAPS-151): the prompt bar's props carry `useArrowsForHistory:!0`
 * with its `externalHistoryBundle` (desk @24802531 / @24803750), and
 * the ↑/↓ plugin `s3b` @24716506 navigates via `t.update(...)`
 * replacing the root paragraph WITHOUT the `"historic"` tag, so the
 * history listener (`wPb`/`NNp` @24366344/@24364484) classifies every
 * navigation as a PUSH — one undo step per ↑/↓.
 *
 * The browser layer's `cycleHistory` performs exactly this record
 * sequence when it sets the input value programmatically: break the
 * merge burst (`lastEdit = null` — the binary's full-node replacement
 * is never a merge continuation), record the navigated snapshot,
 * break the burst again so the next typed edit cannot be absorbed
 * into the navigation step. `recordNavigation` mirrors that sequence
 * against the pure history state.
 */
function recordNavigation(
	state: ReturnType<typeof createPromptBarInputHistoryState>,
	value: string,
	now: number,
) {
	state.lastEdit = null;
	const result = recordPromptBarInputHistory(state, snap(value), now);
	state.lastEdit = null;
	return result;
}

test('NF-146-1 (a): type → navigate(↑) → undo returns the PRE-navigation text', () => {
	const s = createPromptBarInputHistoryState();
	recordPromptBarInputHistory(s, snap(''), 0);
	// Typing burst "abc" merges into ONE step.
	assert.strictEqual(recordPromptBarInputHistory(s, snap('a'), 10), 'push');
	assert.strictEqual(recordPromptBarInputHistory(s, snap('ab'), 20), 'merge');
	assert.strictEqual(recordPromptBarInputHistory(s, snap('abc'), 30), 'merge');
	assert.strictEqual(s.undoStack.length, 1);
	// ↑ shows the previous prompt "xyz": a navigation PUSH of its own.
	assert.strictEqual(recordNavigation(s, 'xyz', 40), 'push');
	assert.strictEqual(s.current?.value, 'xyz');
	assert.strictEqual(s.undoStack.length, 2);
	// Ctrl+Z must land on "abc" (the text before navigation) — before
	// the fix it skipped straight past the navigation.
	assert.strictEqual(undoPromptBarInputHistory(s)?.value, 'abc');
	assert.strictEqual(undoPromptBarInputHistory(s)?.value, '');
	assert.strictEqual(undoPromptBarInputHistory(s), undefined);
	// Redo walks forward through the navigation step too.
	assert.strictEqual(redoPromptBarInputHistory(s)?.value, 'abc');
	assert.strictEqual(redoPromptBarInputHistory(s)?.value, 'xyz');
	assert.strictEqual(redoPromptBarInputHistory(s), undefined);
});

test('NF-146-1: navigation never merges into the typing burst, even for continuation-shaped text within the delay', () => {
	const s = createPromptBarInputHistoryState();
	recordPromptBarInputHistory(s, snap(''), 0);
	recordPromptBarInputHistory(s, snap('a'), 10);
	recordPromptBarInputHistory(s, snap('ab'), 20);
	recordPromptBarInputHistory(s, snap('abc'), 30);
	// The history entry "abcd" is a contiguous insert continuation of
	// "abc" inside the 100ms window — a plain record would MERGE it
	// into the typing step. The binary replaces the whole root node,
	// so navigation is always a PUSH of its own.
	assert.strictEqual(recordNavigation(s, 'abcd', 40), 'push');
	assert.strictEqual(s.undoStack.length, 2);
	assert.strictEqual(undoPromptBarInputHistory(s)?.value, 'abc');
	assert.strictEqual(undoPromptBarInputHistory(s)?.value, '');
});

test('NF-146-1 (b): navigate → type more → undo walks each step in order, no phantom step', () => {
	const s = createPromptBarInputHistoryState();
	// Bar opens with draft "abc" as its initial current (no step).
	assert.strictEqual(recordPromptBarInputHistory(s, snap('abc'), 0), 'initial');
	// ↑ to the previous prompt "xyz".
	assert.strictEqual(recordNavigation(s, 'xyz', 10), 'push');
	// Typing right after navigation is its own step — before the fix
	// this INPUT diffed against the stale current "abc" and created a
	// phantom 'replace' step whose undo restored the wrong text.
	assert.strictEqual(recordPromptBarInputHistory(s, snap('xyz!'), 20), 'push');
	assert.strictEqual(s.undoStack.length, 2);
	assert.strictEqual(undoPromptBarInputHistory(s)?.value, 'xyz');
	assert.strictEqual(undoPromptBarInputHistory(s)?.value, 'abc');
	assert.strictEqual(undoPromptBarInputHistory(s), undefined);
	assert.strictEqual(redoPromptBarInputHistory(s)?.value, 'xyz');
	assert.strictEqual(redoPromptBarInputHistory(s)?.value, 'xyz!');
	// ↓ past the newest entry restores the draft — also a recorded
	// step (same untagged update path in the binary).
	const s2 = createPromptBarInputHistoryState();
	recordPromptBarInputHistory(s2, snap('abc'), 0);
	assert.strictEqual(recordNavigation(s2, 'xyz', 10), 'push'); // ↑
	assert.strictEqual(recordNavigation(s2, 'abc', 20), 'push'); // ↓ draft restore
	assert.strictEqual(s2.current?.value, 'abc');
	assert.strictEqual(undoPromptBarInputHistory(s2)?.value, 'xyz');
	assert.strictEqual(undoPromptBarInputHistory(s2)?.value, 'abc');
	assert.strictEqual(undoPromptBarInputHistory(s2), undefined);
});

test('shortcut truth table — verbatim QKo conditions', () => {
	const key = (key: string, mods: Partial<{ ctrlKey: boolean; metaKey: boolean; shiftKey: boolean }> = {}) => ({
		key, ctrlKey: false, metaKey: false, shiftKey: false, ...mods,
	});
	// Undo: Ctrl+Z / Cmd+Z, no shift (both platforms).
	assert.strictEqual(promptBarHistoryShortcut(key('z', { ctrlKey: true }), false), 'undo');
	assert.strictEqual(promptBarHistoryShortcut(key('Z', { metaKey: true }), true), 'undo');
	// Redo: Ctrl/Cmd+Shift+Z (both platforms).
	assert.strictEqual(promptBarHistoryShortcut(key('Z', { ctrlKey: true, shiftKey: true }), false), 'redo');
	assert.strictEqual(promptBarHistoryShortcut(key('Z', { metaKey: true, shiftKey: true }), true), 'redo');
	// Redo: Ctrl+Y only when NOT mac (binary `!Di`).
	assert.strictEqual(promptBarHistoryShortcut(key('y', { ctrlKey: true }), false), 'redo');
	assert.strictEqual(promptBarHistoryShortcut(key('y', { ctrlKey: true }), true), undefined);
	// Cmd+Y is NOT redo even off-mac (the y-branch requires ctrlKey).
	assert.strictEqual(promptBarHistoryShortcut(key('y', { metaKey: true }), false), undefined);
	// Ctrl+Shift+Y is not redo (y-branch requires !shift).
	assert.strictEqual(promptBarHistoryShortcut(key('Y', { ctrlKey: true, shiftKey: true }), false), undefined);
	// No modifier → nothing.
	assert.strictEqual(promptBarHistoryShortcut(key('z'), false), undefined);
	assert.strictEqual(promptBarHistoryShortcut(key('z'), true), undefined);
});
