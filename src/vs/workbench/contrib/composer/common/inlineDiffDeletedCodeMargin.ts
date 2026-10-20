/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// IDE-CODE: deleted-code margin layout (Cursor `inlineDiffDeletedCodeMargin` parity).
//
// Binary evidence (Cursor 3.25.9, out/vs/workbench/workbench.glass.main.js,
// `inlineDiffDeletedCodeMargin.js`): a dedicated class renders the inline
// diff's deleted code in a scroll-aware margin (not just struck-through
// text). It computes the visible deleted-line counts above and below the
// viewport (`_visibleLineCountTop`, `_visibleLineCountBottom`), each clamped
// by the line count.
//
// This module is pure (no workbench/DOM imports) so the visible-line
// clamping is unit-testable without the editor. The DOM class lives in
// `browser/inlineDiffDeletedCodeMargin.ts`.

/**
 * One deleted line of the pending inline diff, anchored to the merged
 * preview text (the document the editor shows while the preview is open).
 */
export interface IInlineDiffDeletedLine {
	/**
	 * 1-based line number in the merged preview text this deleted line is
	 * anchored to (the first line of its hunk's merged range).
	 */
	readonly anchorLineNumber: number;
	/** The deleted line's original text. */
	readonly text: string;
	/** Index of the hunk this deleted line belongs to. */
	readonly hunkIndex: number;
}

/** One row the margin renders. */
export interface IDeletedMarginRow {
	readonly anchorLineNumber: number;
	readonly text: string;
	readonly hunkIndex: number;
}

/**
 * Result of {@link computeDeletedMarginLayout}.
 *
 * `visibleLineCountTop` / `visibleLineCountBottom` mirror Cursor's
 * `_visibleLineCountTop` / `_visibleLineCountBottom`: the number of deleted
 * lines anchored above / below the visible viewport, each clamped by the
 * total deleted-line count (never negative, never more than the lines on
 * that side).
 */
export interface IDeletedMarginLayout {
	readonly rows: IDeletedMarginRow[];
	readonly visibleLineCountTop: number;
	readonly visibleLineCountBottom: number;
	readonly totalLineCount: number;
}

/**
 * Compute which deleted lines are visible for the current viewport.
 *
 * @param deletedLines all deleted lines of the pending inline diff, ordered
 *        by anchor line.
 * @param visibleStartLineNumber 1-based first visible line of the editor.
 * @param visibleEndLineNumber 1-based last visible line of the editor.
 */
export function computeDeletedMarginLayout(
	deletedLines: readonly IInlineDiffDeletedLine[],
	visibleStartLineNumber: number,
	visibleEndLineNumber: number,
): IDeletedMarginLayout {
	const rows: IDeletedMarginRow[] = [];
	let above = 0;
	let below = 0;
	for (const line of deletedLines) {
		if (line.anchorLineNumber < visibleStartLineNumber) {
			above++;
		} else if (line.anchorLineNumber > visibleEndLineNumber) {
			below++;
		} else {
			rows.push({
				anchorLineNumber: line.anchorLineNumber,
				text: line.text,
				hunkIndex: line.hunkIndex,
			});
		}
	}
	const totalLineCount = deletedLines.length;
	// Clamp by the line count (Cursor's clamping): each side count is
	// bounded by [0, totalLineCount].
	const clamp = (n: number) => Math.min(Math.max(n, 0), totalLineCount);
	return {
		rows,
		visibleLineCountTop: clamp(above),
		visibleLineCountBottom: clamp(below),
		totalLineCount,
	};
}
