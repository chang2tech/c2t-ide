/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import {
	findClosestPendingHunk,
	mergePartialHunks,
	PARTIAL_ACCEPT_TELEMETRY_EVENT,
	PARTIAL_REJECT_TELEMETRY_EVENT,
	PARTIAL_ACCEPT_UNDO_LABEL,
	PARTIAL_ACCEPT_UNDO_CODE,
	PARTIAL_REJECT_UNDO_LABEL,
	PARTIAL_REJECT_UNDO_CODE,
	type IPartialDiffHunk,
	type IPartialHunkRange,
	type PartialHunkState,
} from '../../common/inlineDiffPartial.js';

/**
 * WORKER-GAPS-34D — core partial accept/reject (feature-matrix
 * `inline-diff-partial-accept-reject`). Unit tests for the Cursor-verbatim
 * algorithms in `common/inlineDiffPartial.ts`:
 *
 * - `findClosestPendingHunk` ports Cursor 3.25.9's
 *   `EPe.findClosestChangeIndex(position)` (workbench.glass.main.js):
 *   relative line = position.lineNumber - diffStartLine + 1, nearest change
 *   by min(|addedRange.endExclusive-1 - e|, |addedRange.start - e|),
 *   resolved changes excluded, ties keep the earliest. The ranges are the
 *   per-hunk spans in the CURRENT merged text (Cursor recomputes its change
 *   ranges after every partial op).
 * - `mergePartialHunks` is the applied-preview-model counterpart of Cursor's
 *   baseline folding (Cursor's preview is decoration-only; ours is applied
 *   to the document, so a partial reject rewrites the region). It also
 *   returns each hunk's span in the merged text so decorations stay aligned
 *   after rejects shift lines.
 * - the telemetry event names and undo labels/codes are asserted VERBATIM
 *   against the binary strings — a rename breaks parity silently.
 */

suite('inlineDiffPartial', () => {
	// Two hunks in a 10-line file. Hunk 0 replaces lines 2-3 (1-based) with
	// two new lines; hunk 1 deletes line 6 (pure deletion). Ranges are the
	// merged-text spans with everything pending (= proposed coordinates).
	const hunks: IPartialDiffHunk[] = [
		{ origStart: 1, origEnd: 3, newStart: 1, newEnd: 3 },
		{ origStart: 5, origEnd: 6, newStart: 5, newEnd: 5 },
	];
	const ranges: IPartialHunkRange[] = [
		{ start: 1, end: 3 },
		{ start: 5, end: 5 },
	];
	const allPending: PartialHunkState[] = ['pending', 'pending'];

	suite('findClosestPendingHunk', () => {
		test('picks the hunk containing the cursor line', () => {
			// baseLine 1: hunk 0 covers merged lines 2-3 (1-based).
			assert.strictEqual(findClosestPendingHunk(ranges, allPending, 1, 2), 0);
			assert.strictEqual(findClosestPendingHunk(ranges, allPending, 1, 3), 0);
		});

		test('picks the nearest hunk when the cursor is between hunks', () => {
			// Merged line 4 sits between hunk 0 (ends line 3) and hunk 1
			// (anchors at line 6): |3-4|=1 vs |6-4|=2 → hunk 0.
			assert.strictEqual(findClosestPendingHunk(ranges, allPending, 1, 4), 0);
			// Merged line 5: |3-5|=2 vs |6-5|=1 → hunk 1.
			assert.strictEqual(findClosestPendingHunk(ranges, allPending, 1, 5), 1);
		});

		test('pure-deletion hunk anchors at its position (Cursor empty-range semantics)', () => {
			assert.strictEqual(findClosestPendingHunk(ranges, allPending, 1, 6), 1);
			assert.strictEqual(findClosestPendingHunk(ranges, allPending, 1, 10), 1);
		});

		test('skips resolved hunks — Cursor filters them out of `changes`', () => {
			const states: PartialHunkState[] = ['accepted', 'pending'];
			// Cursor is on hunk 0's line, but hunk 0 is resolved → hunk 1 wins.
			assert.strictEqual(findClosestPendingHunk(ranges, states, 1, 2), 1);
		});

		test('ties keep the earliest hunk (Cursor uses strict <)', () => {
			const twin: IPartialHunkRange[] = [
				{ start: 0, end: 1 },
				{ start: 2, end: 3 },
			];
			// Line 2 (1-based) is equidistant: |1-2|=1 vs |3-2|=1 → hunk 0.
			assert.strictEqual(
				findClosestPendingHunk(twin, ['pending', 'pending'], 1, 2),
				0,
			);
		});

		test('returns -1 when nothing is pending', () => {
			assert.strictEqual(
				findClosestPendingHunk(ranges, ['accepted', 'rejected'], 1, 2),
				-1,
			);
			assert.strictEqual(findClosestPendingHunk([], [], 1, 1), -1);
		});

		test('respects a non-1 base line (diff starts mid-file)', () => {
			// Diff starts at file line 10: hunk 0 covers file lines 11-12.
			assert.strictEqual(findClosestPendingHunk(ranges, allPending, 10, 11), 0);
			assert.strictEqual(findClosestPendingHunk(ranges, allPending, 10, 2), 0);
		});
	});

	suite('mergePartialHunks', () => {
		const orig = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j'];
		const proposed = ['a', 'B1', 'B2', 'd', 'e', 'g', 'h', 'i', 'j'];
		// hunk 0: b,c → B1,B2 ; hunk 1: f deleted.
		const lines = (states: PartialHunkState[]) =>
			mergePartialHunks(orig, proposed, hunks, states).lines;

		test('all pending/accepted yields the proposed text', () => {
			assert.deepStrictEqual(lines(['pending', 'pending']), proposed);
			assert.deepStrictEqual(lines(['accepted', 'accepted']), proposed);
		});

		test('rejecting one hunk restores its original lines only', () => {
			assert.deepStrictEqual(
				lines(['rejected', 'pending']),
				['a', 'b', 'c', 'd', 'e', 'g', 'h', 'i', 'j'],
			);
			assert.deepStrictEqual(
				lines(['pending', 'rejected']),
				// Rejecting the deletion hunk restores 'f'.
				['a', 'B1', 'B2', 'd', 'e', 'f', 'g', 'h', 'i', 'j'],
			);
		});

		test('mixed states merge independently', () => {
			assert.deepStrictEqual(
				lines(['accepted', 'rejected']),
				['a', 'B1', 'B2', 'd', 'e', 'f', 'g', 'h', 'i', 'j'],
			);
			assert.deepStrictEqual(lines(['rejected', 'rejected']), orig);
		});

		test('pure insertion and pure deletion hunks', () => {
			const ins: IPartialDiffHunk[] = [{ origStart: 1, origEnd: 1, newStart: 1, newEnd: 3 }];
			assert.deepStrictEqual(
				mergePartialHunks(['a', 'b'], ['a', 'x', 'y', 'b'], ins, ['pending']).lines,
				['a', 'x', 'y', 'b'],
			);
			assert.deepStrictEqual(
				mergePartialHunks(['a', 'b'], ['a', 'x', 'y', 'b'], ins, ['rejected']).lines,
				['a', 'b'],
			);
		});

		test('hunkRanges track merged-text spans after a reject shifts lines', () => {
			const merged = mergePartialHunks(orig, proposed, hunks, ['pending', 'rejected']);
			// Rejecting the deletion of 'f' inserts one line back at merged
			// offset 5, so hunk 0 keeps span [1,3) and hunk 1 spans [5,6).
			assert.deepStrictEqual(merged.hunkRanges, [
				{ start: 1, end: 3 },
				{ start: 5, end: 6 },
			]);
			// Rejecting hunk 0 instead: its span becomes the 2 original lines;
			// hunk 1 stays pending so 'f' remains deleted.
			const merged2 = mergePartialHunks(orig, proposed, hunks, ['rejected', 'pending']);
			assert.deepStrictEqual(merged2.hunkRanges, [
				{ start: 1, end: 3 },
				{ start: 5, end: 5 },
			]);
			assert.deepStrictEqual(
				merged2.lines,
				['a', 'b', 'c', 'd', 'e', 'g', 'h', 'i', 'j'],
			);
		});

		test('throws on hunk/state length mismatch', () => {
			assert.throws(
				() => mergePartialHunks(orig, proposed, hunks, ['pending']),
				/got 2 hunks but 1 states/,
			);
		});
	});

	suite('binary-verbatim strings', () => {
		test('telemetry event names match the Cursor 3.25.9 binary', () => {
			assert.strictEqual(PARTIAL_ACCEPT_TELEMETRY_EVENT, 'inlineDiffAcceptPartial');
			assert.strictEqual(PARTIAL_REJECT_TELEMETRY_EVENT, 'inlineDiffRejectPartial');
		});

		test('undo labels/codes match the Cursor 3.25.9 binary (service level)', () => {
			assert.strictEqual(PARTIAL_ACCEPT_UNDO_LABEL, 'Undo Accept Partial Diff');
			assert.strictEqual(PARTIAL_ACCEPT_UNDO_CODE, 'undo-accept-partial-diff');
			assert.strictEqual(PARTIAL_REJECT_UNDO_LABEL, 'Undo Reject Partial Diff');
			assert.strictEqual(PARTIAL_REJECT_UNDO_CODE, 'undo-reject-partial-diff');
		});
	});
});
