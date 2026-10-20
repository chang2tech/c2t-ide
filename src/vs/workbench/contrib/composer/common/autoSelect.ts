/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// IDE-CODE: port of Cursor 3.25.9's `autoSelectService` (`heuristicSelect`),
// used by `StartEditPrompt.run` (Cmd+K) to expand an empty selection on a
// non-empty line into a sensible edit range.
//
// Binary evidence (byte offsets in the 3.25.9 bundles, verified by GAPS-172):
//   glass   workbench.glass.main.js:   token `Qn("autoSelectService")` @40724282,
//           types `["line","group","folding"]` @40724307, `heuristicSelect`
//           definition @40724602, sole caller in StartEditPrompt @40734485.
//   desktop workbench.desktop.main.js: token @32220787, types @32220812,
//           definition @32221107, caller @32230995.
// The scoring table, range construction, dedupe and rationalize steps below
// are transcribed verbatim from that definition (minified names expanded).
// The service is pure logic over a text model, so it lives in `common/` —
// the same layer pattern as the other Cmd+K helpers
// (`common/inlineEditPromptBar.ts`, `common/inlineDiffPartial.ts`) — and the
// electron-browser/browser inline-edit services consume it when capturing
// the Cmd+K target. Cursor keeps the service in workbench core; there is no
// separate DI registration in the fork (documented divergence: the fork calls
// these functions directly from `captureTarget`, the point in the fork's
// flow that corresponds to StartEditPrompt's selection normalization).

/** Structural subset of `ITextModel` the binary's autoSelectService reads. */
export interface IAutoSelectModel {
	readonly uri: { readonly fsPath: string };
	getLineCount(): number;
	getLineContent(lineNumber: number): string;
	getLineLength(lineNumber: number): number;
	getLineMaxColumn(lineNumber: number): number;
	getLineFirstNonWhitespaceColumn(lineNumber: number): number;
}

/** Plain range shape (structurally `IRange`). */
export interface IAutoSelectRange {
	readonly startLineNumber: number;
	readonly startColumn: number;
	readonly endLineNumber: number;
	readonly endColumn: number;
}

/** Cursor position shape (structurally `IPosition`). */
export interface IAutoSelectPosition {
	readonly lineNumber: number;
	readonly column: number;
}

export type AutoSelectSuggestionType = 'line' | 'group' | 'folding';

/** One scored candidate, exactly the binary's return element shape. */
export interface IAutoSelectSuggestion {
	readonly score: number;
	readonly type: AutoSelectSuggestionType;
	readonly initialSelectionRange: IAutoSelectRange;
	readonly rangeDecorationId: string;
}

export interface IAutoSelectOptions {
	/** Binary default: `true`. */
	readonly shouldDedupe?: boolean;
	/** Binary default: `[]` (all three types considered). */
	readonly skipSuggestionTypes?: readonly AutoSelectSuggestionType[];
	/**
	 * Folding region containing the cursor line, resolved by the caller from
	 * the editor's folding model. The binary resolves it via
	 * `vH.get(editor).getFoldingModel()` → `getRegionAtLine(lineNumber)`.
	 * `undefined` = no folding model available (binary `break`s out of the
	 * folding case and falls back to the single-line range); `null` = model
	 * present but no region at the line (binary returns the single-line
	 * range un-rationalized — same coordinates for in-bounds lines).
	 */
	readonly foldingRegion?: { readonly startLineNumber: number; readonly endLineNumber: number } | null;
}

/** Binary `xcI` — candidate types, in construction order. */
export const AUTO_SELECT_SUGGESTION_TYPES: readonly AutoSelectSuggestionType[] = ['line', 'group', 'folding'];

/** Binary `getLineIndentAt`: `model ? model.getLineFirstNonWhitespaceColumn(line) : 0`. */
export function getLineIndentAt(model: IAutoSelectModel | undefined, lineNumber: number): number {
	return model ? model.getLineFirstNonWhitespaceColumn(lineNumber) : 0;
}

/** Binary `rationalizeRange`: clamp the range into the model's bounds. */
export function rationalizeRange(model: IAutoSelectModel, range: IAutoSelectRange): IAutoSelectRange {
	const startLineNumber = Math.max(1, range.startLineNumber);
	const endLineNumber = Math.min(model.getLineCount(), range.endLineNumber);
	return {
		startLineNumber,
		startColumn: Math.max(1, range.startColumn),
		endLineNumber,
		endColumn: Math.min(model.getLineMaxColumn(endLineNumber), range.endColumn),
	};
}

/** Binary `findSuggestionRangeOfType` for one candidate type. */
export function findSuggestionRangeOfType(
	model: IAutoSelectModel,
	position: IAutoSelectPosition,
	type: AutoSelectSuggestionType,
	foldingRegion?: { readonly startLineNumber: number; readonly endLineNumber: number } | null,
): IAutoSelectRange {
	const i = position.lineNumber;
	switch (type) {
		case 'line':
			return rationalizeRange(model, { startLineNumber: i, startColumn: 1, endLineNumber: i, endColumn: model.getLineLength(i) });
		case 'group': {
			let s = i;
			let o = i;
			const a = getLineIndentAt(model, i);
			for (let l = i - 1; l > 0 && !(getLineIndentAt(model, l) < a || model.getLineContent(l).trim() === ''); l--) {
				s = l;
			}
			for (let l = i + 1; l <= model.getLineCount() && !(getLineIndentAt(model, l) < a || model.getLineContent(l).trim() === ''); l++) {
				o = l;
			}
			return rationalizeRange(model, { startLineNumber: s, startColumn: 1, endLineNumber: o, endColumn: model.getLineMaxColumn(o) });
		}
		case 'folding': {
			if (foldingRegion === undefined) {
				break;
			}
			let s = i;
			let o = i;
			if (foldingRegion) {
				s = Math.max(1, foldingRegion.startLineNumber);
				const d = getLineIndentAt(model, s);
				const h = getLineIndentAt(model, Math.min(model.getLineCount(), foldingRegion.endLineNumber));
				o = Math.min(model.getLineCount(), d >= h ? foldingRegion.endLineNumber : foldingRegion.endLineNumber + 1);
			}
			return { startLineNumber: s, startColumn: 1, endLineNumber: o, endColumn: model.getLineMaxColumn(o) };
		}
	}
	return rationalizeRange(model, { startLineNumber: i, startColumn: 1, endLineNumber: i, endColumn: model.getLineMaxColumn(i) });
}

/** Binary `calculateScore` — the verbatim scoring table. */
export function calculateScore(model: IAutoSelectModel | undefined, candidate: { readonly type: AutoSelectSuggestionType; readonly range: IAutoSelectRange; readonly base: IAutoSelectPosition }): number {
	let n = 0;
	if (!model) {
		return 0;
	}
	const r = candidate.base.lineNumber;
	const s = model.getLineContent(r);
	const o = r > 1 && model.getLineContent(r - 1).trim() === '';
	const a = r < model.getLineCount() && model.getLineContent(r + 1).trim() === '';
	const l = getLineIndentAt(model, r);
	const c = getLineIndentAt(model, candidate.range.endLineNumber);
	const u = getLineIndentAt(model, candidate.range.startLineNumber);
	const d = r > 1 ? getLineIndentAt(model, r - 1) : 0;
	const h = r < model.getLineCount() ? getLineIndentAt(model, r + 1) : 0;
	switch (candidate.type) {
		case 'group':
			if (o) { n += 10; }
			if (c === u) { n += 10; } else { n -= 15; }
			if (!o && d !== l) { n += 5; }
			if (!o && !a) { n += 3; }
			if (a && !o && d === l) { n += 10; }
			if (u !== l || c !== l) { n -= 15; }
			if (l === u && r !== candidate.range.startLineNumber) { n -= 10; }
			if (c < u) { n -= 10; }
			break;
		case 'line':
			if (o && a) { n += 18; }
			if (model.uri.fsPath.endsWith('.rs') && s.trim().startsWith('#')) { n += 15; }
			break;
		case 'folding':
			n += 10;
			if (o) { n += 10; }
			if (c === u) { n += 10; }
			if (!o && !a) { n += 5; }
			if (u !== l) { n -= 10; }
			if (c !== l) { n -= 5; }
			if (r > candidate.range.startLineNumber) { n -= 10; }
			break;
		default:
			return 0;
	}
	return n;
}

/** Binary `dedupeSelections`: drop later candidates whose range repeats an earlier one. */
export function dedupeSelections<T extends { readonly range: IAutoSelectRange }>(selections: readonly (T | undefined | null)[]): T[] {
	const seen = new Set<string>();
	return selections.filter((entry): entry is T => {
		if (!entry) {
			return false;
		}
		const key = `${entry.range.startLineNumber},${entry.range.startColumn},${entry.range.endLineNumber},${entry.range.endColumn}`;
		return seen.has(key) ? false : (seen.add(key), true);
	});
}

/**
 * Binary `autoSelectService.heuristicSelect(editor, position, options)`:
 * build one candidate per (non-skipped) type, score each, sort by score
 * descending, optionally dedupe identical ranges, and map to the public
 * suggestion shape. With a model present this never returns an empty array
 * (every type yields a range), matching the binary.
 */
export async function heuristicSelect(
	model: IAutoSelectModel,
	position: IAutoSelectPosition,
	options?: IAutoSelectOptions,
): Promise<IAutoSelectSuggestion[]> {
	const shouldDedupe = options?.shouldDedupe ?? true;
	const skip = options?.skipSuggestionTypes ?? [];
	const types = AUTO_SELECT_SUGGESTION_TYPES.filter(t => !skip.includes(t));
	const candidates = types.map(type => ({
		type,
		range: findSuggestionRangeOfType(model, position, type, options?.foldingRegion),
		base: position,
	}));
	const scored = candidates
		.map(candidate => ({ ...candidate, score: calculateScore(model, candidate) }))
		.sort((x, y) => y.score - x.score);
	return (shouldDedupe ? dedupeSelections(scored) : scored).map(candidate => ({
		score: candidate.score,
		type: candidate.type,
		initialSelectionRange: candidate.range,
		rangeDecorationId: '',
	}));
}

/**
 * StartEditPrompt's handling of an EMPTY target range `M` (glass
 * @40733337+ — `M = n?.overrideRange ?? selection`, then the same
 * empty-selection flow applies to whichever range won): on a NON-EMPTY
 * anchor line the range expands to `heuristicSelect`'s top suggestion
 * and the target stops being an insert; on an EMPTY anchor line (or,
 * defensively, when no suggestion exists) it stays a zero-width insert
 * at the anchor.
 *
 * This is the exact decision `captureTarget` (electron-browser
 * inline-edit service) makes for an empty explicit/override range —
 * e.g. the `cmdK.resolveConflictInCmdK` range `(n,1,n,1)` when
 * startLine === endLine — extracted as a pure helper by GAPS-189 so the
 * case carries a regression lock (QA-185 round 24 point 5: previously
 * code + comment only, no test). `resolveOptions` is invoked LAZILY,
 * only when the anchor line is non-empty — matching the caller, which
 * resolves the editor's folding region only on the heuristic path.
 */
export interface IEmptySelectionResolution {
	/** The resolved target range (the heuristic winner, or zero-width at the anchor). */
	readonly range: IAutoSelectRange;
	/** True when the target remains a zero-width insert at the anchor. */
	readonly insertMode: boolean;
}

export async function resolveEmptySelectionTarget(
	model: IAutoSelectModel,
	anchor: IAutoSelectPosition,
	resolveOptions?: () => Promise<IAutoSelectOptions | undefined>,
): Promise<IEmptySelectionResolution> {
	const zeroWidth: IAutoSelectRange = {
		startLineNumber: anchor.lineNumber,
		startColumn: anchor.column,
		endLineNumber: anchor.lineNumber,
		endColumn: anchor.column,
	};
	if (model.getLineContent(anchor.lineNumber).trim() === '') {
		return { range: zeroWidth, insertMode: true };
	}
	const suggestions = await heuristicSelect(model, anchor, resolveOptions ? await resolveOptions() : undefined);
	if (suggestions.length > 0) {
		return { range: suggestions[0]!.initialSelectionRange, insertMode: false };
	}
	// Unreachable with a live model (every candidate type yields a
	// range); the binary's fallback inserts a newline and targets the
	// next line. Keep the zero-width insert rather than inventing an
	// edit the user did not ask for.
	return { range: zeroWidth, insertMode: true };
}

/**
 * StartEditPrompt's column-1 trim (glass @40733372, desktop @32229876,
 * verbatim): a non-empty, multi-line selection ending at column 1 drops its
 * last line — the new end is `(endLineNumber - 1, getLineMaxColumn(endLineNumber - 1))`,
 * the start is untouched. Returns the input unchanged when the trim does not
 * apply. (The binary tests emptiness on the selection itself; the structural
 * range check `start==end position` is the same predicate for a Range.)
 */
export function trimSelectionEndingAtColumn1<T extends IAutoSelectRange>(model: IAutoSelectModel, selection: T & { readonly isEmpty?: boolean | (() => boolean) }): IAutoSelectRange {
	const isEmpty = typeof selection.isEmpty === 'function'
		? selection.isEmpty()
		: selection.isEmpty ?? (selection.startLineNumber === selection.endLineNumber && selection.startColumn === selection.endColumn);
	if (!isEmpty && selection.startLineNumber !== selection.endLineNumber && selection.endColumn === 1) {
		return {
			startLineNumber: selection.startLineNumber,
			startColumn: selection.startColumn,
			endLineNumber: selection.endLineNumber - 1,
			endColumn: model.getLineMaxColumn(selection.endLineNumber - 1),
		};
	}
	return selection;
}
