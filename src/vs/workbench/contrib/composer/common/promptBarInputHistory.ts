/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// IDE-CODE: GAPS-139 — per-prompt-bar input history for
// `editor.action.undoLexical` / `editor.action.redoLexical`
// (feature_id `lexical-undo-redo-prompt-bar`).
//
// REA EVIDENCE (Cursor 3.25.9 workbench.desktop.main.js, byte offsets
// verified by direct reads — docs/rea/work-notes-gaps139.md):
//   - Each Cmd+K prompt bar owns a Lexical history state
//     (`ONp()`: `{current:null, redoStack:[], undoStack:[]}`).
//   - Undo `Ifr` @24365252 / redo `Efr` @24364990 pop one stack, push the
//     current state onto the other, and `setEditorState(popped,
//     {tag:"historic"})`. Clear `xfr`: both stacks emptied, current null.
//   - The history update listener's PUSH branch clears the redo stack
//     (`t.redoStack=[]`) and pushes `{...current}` onto the undo stack —
//     a fresh edit always invalidates redo.
//   - The prompt bar registers its history with delay 100
//     (`n2b(editor, () => externalHistoryState, 100, runExternalUndo,
//     runExternalRedo, addToExternalUndoStack)` @24716440/@24546440) and
//     change-type decisions (PUSH / MERGE / discard) come from `NNp(...)`
//     diffing Lexical editor states.
//   - Keyboard (input component `QKo` keydown @24505898, active because
//     the prompt bar always carries an external history bundle):
//       undo: (meta||ctrl) && key 'z' && !shift
//       redo: (meta||ctrl) && (('z' && shift) || (!mac && ctrl && 'y' && !shift))
//     preventDefault + dispatch UNDO_COMMAND/REDO_COMMAND, which the
//     prompt-bar history plugin delegates to the workbench
//     `undoRedoService.undo(uri)` / `redo(uri)`.
//
// HONEST-DIVERGENCE (see work-notes-gaps139.md D1/D3):
//   D1 The fork's prompt-bar input is a plain <textarea>, not a Lexical
//      editor, so a snapshot here is `{value, selectionStart,
//      selectionEnd}` instead of a Lexical EditorState. The stack
//      mechanics (push/merge/discard, undo/redo transfers, redo cleared
//      on push, historic applies not re-recorded) port Ifr/Efr/ONp/xfr
//      one-to-one.
//   D3 The binary's MERGE decision (`NNp`) diffs Lexical node trees;
//      the plain-text port below merges only same-kind contiguous
//      insert/delete bursts at the caret within the binary's 100ms
//      prompt-bar delay. It does not claim verbatim parity.

/** One immutable snapshot of the prompt-bar input (the fork's "editor state"). */
export interface IPromptBarInputSnapshot {
	readonly value: string;
	readonly selectionStart: number;
	readonly selectionEnd: number;
}

type PromptBarEditKind = 'insert' | 'delete' | 'replace';

/**
 * Per-bar history state — port of the binary's `ONp()` shape
 * (`{current:null, redoStack:[], undoStack:[]}`), plus the bookkeeping
 * the change-type decision needs (last edit kind/span/time for merges).
 */
export interface IPromptBarInputHistoryState {
	current: IPromptBarInputSnapshot | null;
	undoStack: IPromptBarInputSnapshot[];
	redoStack: IPromptBarInputSnapshot[];
	/** Internal: last recorded edit, for the merge decision. */
	lastEdit: { readonly kind: PromptBarEditKind; readonly start: number; readonly end: number; readonly time: number } | null;
}

/** Binary prompt-bar history delay (`n2b(..., 100, ...)`). */
export const PROMPT_BAR_HISTORY_MERGE_DELAY_MS = 100;

/** Port of `ONp()` — `createEmptyHistoryState`. */
export function createPromptBarInputHistoryState(): IPromptBarInputHistoryState {
	return { current: null, undoStack: [], redoStack: [], lastEdit: null };
}

/** Port of `xfr(state)` — clear both stacks and the current snapshot. */
export function clearPromptBarInputHistory(state: IPromptBarInputHistoryState): void {
	state.undoStack = [];
	state.redoStack = [];
	state.current = null;
	state.lastEdit = null;
}

export function canUndoPromptBarInput(state: IPromptBarInputHistoryState): boolean {
	return state.undoStack.length !== 0;
}

export function canRedoPromptBarInput(state: IPromptBarInputHistoryState): boolean {
	return state.redoStack.length !== 0;
}

export type PromptBarHistoryRecordResult =
	/** First snapshot ever: becomes `current`, creates no undo step (binary: PUSH branch only pushes when the previous current is non-null). */
	| 'initial'
	/** New undo step: previous current pushed, redo stack cleared (binary PUSH branch). The caller mirrors this as one workbench undo element. */
	| 'push'
	/** Continuation of the previous edit burst: only `current` advances, no new undo step. */
	| 'merge'
	/** No state change (identical snapshot, or selection-only change). */
	| 'discard';

function snapshotsEqual(a: IPromptBarInputSnapshot, b: IPromptBarInputSnapshot): boolean {
	return a.value === b.value && a.selectionStart === b.selectionStart && a.selectionEnd === b.selectionEnd;
}

interface ITextEditSpan {
	readonly kind: PromptBarEditKind;
	/** Start of the changed region in the NEW value. */
	readonly start: number;
	/** End (exclusive) of the inserted text in the NEW value; for deletes, the caret position after deletion. */
	readonly end: number;
	/** End (exclusive) of the removed text in the OLD value. */
	readonly removedEnd: number;
}

/**
 * Single contiguous diff between two plain-text values (longest common
 * prefix/suffix). Returns undefined when the values are identical.
 */
function diffTextEdit(prev: string, next: string): ITextEditSpan | undefined {
	if (prev === next) {
		return undefined;
	}
	let prefix = 0;
	const maxPrefix = Math.min(prev.length, next.length);
	while (prefix < maxPrefix && prev[prefix] === next[prefix]) {
		prefix++;
	}
	let suffix = 0;
	while (
		suffix < prev.length - prefix &&
		suffix < next.length - prefix &&
		prev[prev.length - 1 - suffix] === next[next.length - 1 - suffix]
	) {
		suffix++;
	}
	const removedLength = prev.length - prefix - suffix;
	const insertedLength = next.length - prefix - suffix;
	const kind: PromptBarEditKind = removedLength === 0 ? 'insert' : insertedLength === 0 ? 'delete' : 'replace';
	return { kind, start: prefix, end: prefix + insertedLength, removedEnd: prefix + removedLength };
}

/**
 * Merge decision — plain-text approximation of the binary's `NNp`
 * change-type (D3): same edit kind as the previous record, within the
 * 100ms prompt-bar delay, and the edit continues where the last one
 * left off (typing forward, backspace continuing left, or forward
 * delete at the same caret). Replaces never merge.
 */
function isMergeContinuation(
	state: IPromptBarInputHistoryState,
	edit: ITextEditSpan,
	now: number,
	mergeDelayMs: number,
): boolean {
	const last = state.lastEdit;
	if (!last || last.kind !== edit.kind || edit.kind === 'replace') {
		return false;
	}
	if (now - last.time > mergeDelayMs) {
		return false;
	}
	if (edit.kind === 'insert') {
		// Typing continues at the end of the previous insertion.
		return edit.start === last.end;
	}
	// delete: backspace removes the char just before the previous
	// deletion point (removedEnd === last.start), or forward-delete
	// repeats at the same caret (start === last.start).
	return edit.removedEnd === last.start || edit.start === last.start;
}

/**
 * Record a new input snapshot — port of the binary's history update
 * listener (`kPb`/`wPb`): ghost/selection-only updates are discarded,
 * PUSH clears the redo stack and pushes `{...current}`, MERGE only
 * advances `current`. `now` is injected for testability.
 */
export function recordPromptBarInputHistory(
	state: IPromptBarInputHistoryState,
	snapshot: IPromptBarInputSnapshot,
	now: number,
	mergeDelayMs: number = PROMPT_BAR_HISTORY_MERGE_DELAY_MS,
): PromptBarHistoryRecordResult {
	const current = state.current;
	if (current === null) {
		state.current = snapshot;
		state.lastEdit = null;
		return 'initial';
	}
	if (snapshotsEqual(current, snapshot)) {
		return 'discard';
	}
	const edit = diffTextEdit(current.value, snapshot.value);
	if (edit === undefined) {
		// Selection-only change: the binary's listener sees no dirty
		// leaves and records nothing.
		return 'discard';
	}
	if (isMergeContinuation(state, edit, now, mergeDelayMs)) {
		state.current = snapshot;
		state.lastEdit = { kind: edit.kind, start: edit.start, end: edit.end, time: now };
		return 'merge';
	}
	// PUSH branch (verbatim semantics): a fresh edit invalidates redo,
	// and the previous current becomes the newest undo step.
	if (state.redoStack.length !== 0) {
		state.redoStack = [];
	}
	state.undoStack.push({ ...current });
	state.current = snapshot;
	state.lastEdit = { kind: edit.kind, start: edit.start, end: edit.end, time: now };
	return 'push';
}

/**
 * Port of `Ifr` (undo): pop the undo stack, push the current snapshot
 * onto the redo stack, make the popped snapshot current. Returns the
 * snapshot the caller must apply (with the "historic" tag semantics:
 * applying it must NOT be recorded again), or undefined at the bottom
 * of the stack (binary: `if(i.length!==0){...}` — otherwise no-op).
 */
export function undoPromptBarInputHistory(state: IPromptBarInputHistoryState): IPromptBarInputSnapshot | undefined {
	if (state.undoStack.length === 0) {
		return undefined;
	}
	const current = state.current;
	const popped = state.undoStack.pop()!;
	if (current !== null) {
		state.redoStack.push(current);
	}
	state.current = popped ?? null;
	// An undo boundary breaks any merge burst: the next user edit is a
	// fresh PUSH (it also clears the redo stack, per the PUSH branch).
	state.lastEdit = null;
	return popped;
}

/**
 * Port of `Efr` (redo): symmetric to undo. Returns the snapshot to
 * apply, or undefined when the redo stack is empty.
 */
export function redoPromptBarInputHistory(state: IPromptBarInputHistoryState): IPromptBarInputSnapshot | undefined {
	if (state.redoStack.length === 0) {
		return undefined;
	}
	const current = state.current;
	const popped = state.redoStack.pop()!;
	if (current !== null) {
		state.undoStack.push(current);
	}
	state.current = popped ?? null;
	state.lastEdit = null;
	return popped;
}

/**
 * The prompt-bar input's undo/redo keys — verbatim conditions from the
 * binary's `QKo` keydown handler @24505898:
 *   g = (meta||ctrl) && h==="z" && !shift            → undo
 *   f = (meta||ctrl) && (h==="z"&&shift || (!mac && ctrl && h==="y" && !shift)) → redo
 * (`h` is the lower-cased key; `!mac` is the binary's `!Di`.)
 */
export function promptBarHistoryShortcut(
	event: { readonly key: string; readonly ctrlKey: boolean; readonly metaKey: boolean; readonly shiftKey: boolean },
	isMacintoshPlatform: boolean,
): 'undo' | 'redo' | undefined {
	const p = event.metaKey || event.ctrlKey;
	if (!p) {
		return undefined;
	}
	const h = event.key.toLowerCase();
	if (h === 'z' && !event.shiftKey) {
		return 'undo';
	}
	if ((h === 'z' && event.shiftKey) || (!isMacintoshPlatform && event.ctrlKey && h === 'y' && !event.shiftKey)) {
		return 'redo';
	}
	return undefined;
}
