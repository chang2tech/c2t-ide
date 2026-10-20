/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// IDE-CODE: core partial accept/reject for Cmd+K inline diffs (Cursor parity).
//
// Binary evidence (Cursor 3.25.9, out/vs/workbench/workbench.glass.main.js):
//   - `InlineDiffService.acceptPartialDiff(diffId, position)` /
//     `rejectPartialDiff(diffId, position)` — service-level entry points.
//   - `EPe.findClosestChangeIndex(position)`: `e = position.lineNumber -
//     diffStartLineNumber + 1`; picks the change minimizing
//     `min(|addedRange.endLineNumberExclusive-1 - e|, |addedRange.startLineNumber - e|)`.
//   - telemetry `inlineDiffAcceptPartial` / `inlineDiffRejectPartial`, each
//     carrying the diff's `generationUUID`.
//   - undo elements "Undo Accept Partial Diff"/"undo-accept-partial-diff" and
//     "Undo Reject Partial Diff"/"undo-reject-partial-diff" (service level,
//     pushed with `breakConsolidation: true`).
//   - `onDidAcceptPartialDiff` / `onDidRejectPartialDiff` events with
//     `{inlineDiff, requestId, file, previousContent, updatedContent,
//       source, range, diffInfo, isDone, change: {accepted, rejected}}`.
//   - when the last change resolves (`isDone`), the diff is removed with
//     `{closePromptBar: true, ...}`.
//
// This module is pure logic (no workbench imports) so the Cursor-verbatim
// algorithms are unit-testable without the editor. The stateful service that
// consumes it lives in `electron-browser/inlineEditService.ts`.

/**
 * One contiguous changed region between the original and proposed text.
 * Coordinates match the core `DiffHunk` (0-based, end-exclusive).
 */
export interface IPartialDiffHunk {
	readonly origStart: number;
	readonly origEnd: number;
	readonly newStart: number;
	readonly newEnd: number;
}

/** Per-change fate. Cursor keeps only unresolved changes in `this.changes`; we keep all hunks with a state. */
export type PartialHunkState = 'pending' | 'accepted' | 'rejected';

/** Telemetry event names, verbatim from the Cursor 3.25.9 binary. */
export const PARTIAL_ACCEPT_TELEMETRY_EVENT = 'inlineDiffAcceptPartial';
export const PARTIAL_REJECT_TELEMETRY_EVENT = 'inlineDiffRejectPartial';

/** Undo element label/code, verbatim from the Cursor 3.25.9 binary (service level). */
export const PARTIAL_ACCEPT_UNDO_LABEL = 'Undo Accept Partial Diff';
export const PARTIAL_ACCEPT_UNDO_CODE = 'undo-accept-partial-diff';
export const PARTIAL_REJECT_UNDO_LABEL = 'Undo Reject Partial Diff';
export const PARTIAL_REJECT_UNDO_CODE = 'undo-reject-partial-diff';

/** 0-based `[start, end)` line span of one hunk's content in merged text. */
export interface IPartialHunkRange {
	readonly start: number;
	readonly end: number;
}

/**
 * Cursor's `EPe.findClosestChangeIndex(position)`: the pending change nearest
 * the cursor. Only `pending` hunks are candidates (Cursor filters resolved
 * changes out of `this.changes`, so the search never sees them). Ties keep
 * the earliest hunk (Cursor uses strict `<`). Returns -1 when nothing is
 * pending.
 *
 * @param hunkRanges per-hunk spans in the CURRENT merged text (Cursor's
 *   `addedRange`, recomputed after every partial op).
 * @param baseLine 1-based line where the merged text starts (Cursor's
 *   `inlineDiff.currentRange.startLineNumber`).
 */
export function findClosestPendingHunk(
	hunkRanges: readonly IPartialHunkRange[],
	states: readonly PartialHunkState[],
	baseLine: number,
	lineNumber: number,
): number {
	// Cursor: `e = position.lineNumber - diffStartLineNumber + 1` (1-based
	// relative). `rel` below is the 0-based equivalent.
	const rel = lineNumber - baseLine;
	let best = -1;
	let bestDist = Number.POSITIVE_INFINITY;
	for (let i = 0; i < hunkRanges.length; i++) {
		if (states[i] !== 'pending') {
			continue;
		}
		const r = hunkRanges[i]!;
		// Cursor: min(|addedRange.endLineNumberExclusive-1 - e|,
		//            |addedRange.startLineNumber - e|).
		// In 0-based merged-text coordinates: |end-1 - rel| and |start - rel|.
		// Pure-deletion hunks have an empty span and anchor at their position,
		// exactly like Cursor's empty addedRange.
		const dist = Math.min(Math.abs(r.end - 1 - rel), Math.abs(r.start - rel));
		if (dist < bestDist) {
			bestDist = dist;
			best = i;
		}
	}
	return best;
}

/** Result of {@link mergePartialHunks}. */
export interface IMergedPartialHunks {
	/** The merged text, one entry per line. */
	readonly lines: string[];
	/** Per-hunk `[start, end)` spans in `lines` (same order as the hunks). */
	readonly hunkRanges: IPartialHunkRange[];
}

/**
 * Merge original/proposed lines honoring per-hunk states. `pending` and
 * `accepted` hunks contribute proposed lines; `rejected` hunks contribute
 * original lines.
 *
 * HONEST DIVERGENCE from Cursor's `EPe`: Cursor never applies the preview to
 * the document — the preview is decoration-only, and a partial accept folds
 * the change into its internal `originalTextLines` baseline. Our preview IS
 * applied to the document, so a partial reject must rewrite the affected
 * region; this merge computes exactly that text. The observable result is
 * the same: accepted changes keep proposed text, rejected changes show
 * original text.
 */
export function mergePartialHunks(
	origLines: readonly string[],
	newLines: readonly string[],
	hunks: readonly IPartialDiffHunk[],
	states: readonly PartialHunkState[],
): IMergedPartialHunks {
	if (hunks.length !== states.length) {
		throw new Error(`mergePartialHunks: got ${hunks.length} hunks but ${states.length} states`);
	}
	const lines: string[] = [];
	const hunkRanges: IPartialHunkRange[] = [];
	let o = 0;
	for (let i = 0; i < hunks.length; i++) {
		const h = hunks[i]!;
		// Equal prefix between the previous hunk and this one — identical in
		// both texts by construction of the line diff.
		while (o < h.origStart) {
			lines.push(origLines[o++]!);
		}
		const start = lines.length;
		const takeNew = states[i] !== 'rejected';
		const src = takeNew ? newLines : origLines;
		const from = takeNew ? h.newStart : h.origStart;
		const to = takeNew ? h.newEnd : h.origEnd;
		for (let k = from; k < to; k++) {
			lines.push(src[k]!);
		}
		hunkRanges.push({ start, end: lines.length });
		o = h.origEnd;
	}
	while (o < origLines.length) {
		lines.push(origLines[o++]!);
	}
	return { lines, hunkRanges };
}
