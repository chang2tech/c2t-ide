/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * IDE-CODE (DEV-GAPS-83, agent-fix-with-agent-error): pure logic for
 * Cursor's diagnostic "Fix with Agent" flow.
 *
 * QA step 1 — evidence, self-verified 2026-10-20 on the reference binary
 * Cursor 3.25.9 `out/vs/workbench/workbench.glass.main.js`:
 *
 * - Code-action contribution `vZs` (ID `workbench.contrib.aiFixCodeActions`,
 *   byte ~42717352) registers command `j6b = "editor.action.fixInAgent"`
 *   (byte 42716351) and a CodeActionProvider for `*` (`RJc`). The provider
 *   returns nothing unless `context.only` is the QuickFix kind or
 *   undefined; it filters the model's markers to `severity === Error` whose
 *   range intersects or touches the requested range, and emits actions
 *   `{ title: "Fix in Agent", kind: QuickFix, diagnostics: [marker],
 *      command: { id: "editor.action.fixInAgent", title: "Fix in Agent",
 *                 arguments: [uriString, markerMessage, markerRange] } }`.
 *   NOTE the verbatim asymmetry: the CodeAction is titled "Fix in Agent",
 *   the marker-hover button is titled "Fix with Agent".
 * - The command handler calls
 *   `fixLinterErrorWithAI({ errorMessage, editorUri, range, addToCurrent: true })`.
 * - `fixLinterErrorWithAI` (byte ~40267498) builds the prompt VERBATIM as
 *   {@link buildFixLinterPrompt}, widens the range to
 *   `[max(1, start-1) .. min(lineCount, end+2)]` for the attached code
 *   selection, and returns early when the last human bubble already has
 *   exactly that prompt text and the composer status is "generating".
 * - The marker hover button (see browser/markerHoverParticipant.ts in
 *   editor/contrib/hover) is labelled `"Fix with Agent"` plus, when the
 *   `composer.fixerrormessage` command has a keybinding, `" (" + label + ")"`
 *   — the dynamic keybinding label.
 *
 * This module is the pure, VS Code-type-light core of that behavior; the
 * workbench wiring lives in browser/aiFixCodeActions.ts and the composer
 * runtime half in the ide-agent extension (`ide.fixWithAgent`).
 */

/** Verbatim binary command id (`j6b`). */
export const FIX_IN_AGENT_COMMAND_ID = 'editor.action.fixInAgent';

/** Verbatim CodeAction title (binary `RJc`). NOT "Fix with Agent". */
export const FIX_IN_AGENT_ACTION_TITLE = 'Fix in Agent';

/** Verbatim marker-hover button label (binary `Mhb` call in `_renderMarkerHover`). */
export const FIX_WITH_AGENT_HOVER_LABEL = 'Fix with Agent';

/** Verbatim secondary hover button label (only rendered when a cloud-agent bcId exists). */
export const FIX_IN_CLOUD_AGENT_HOVER_LABEL = 'Fix in Cloud Agent';

/**
 * Verbatim binary id of the "Investigate Error in Chat" command whose
 * keybinding decorates the hover button label. HONEST-DIVERGENCE: the fork
 * registers that command as `composer.investigateError` (pre-existing
 * migration decision, docs/rea/contributes-migration-map.md), so the hover
 * participant looks up the fork id; the chord (CtrlCmd+Shift+D) is the same.
 */
export const INVESTIGATE_ERROR_COMMAND_ID_BINARY = 'composer.fixerrormessage';
export const INVESTIGATE_ERROR_COMMAND_ID_FORK = 'composer.investigateError';

/** Verbatim workbench contribution id (`vZs.ID`). */
export const AI_FIX_CODE_ACTIONS_CONTRIBUTION_ID = 'workbench.contrib.aiFixCodeActions';

/** Verbatim context key (`xxb`) set by Cursor's cursor-on-lint contribution. */
export const CURSOR_ON_LINT_CONTEXT_KEY = 'composer.isCursorOnLint';

/** Verbatim contribution id of Cursor's cursor-on-lint tracker (`lKi.ID`). */
export const CURSOR_ON_LINT_CONTRIBUTION_ID = 'editor.contrib.composerCursorOnLint';

/** Verbatim analytics event fired by the hover button (binary `Mhb` onclick). */
export const FIX_HOVER_TELEMETRY_EVENT = 'hover_bar.submit_fix';

/** Verbatim public log capture fired by the hover button (binary `Mhb` onclick). */
export const FIX_HOVER_LOG_MESSAGE = 'Submitted Fix With Agent';

/**
 * The prompt Cursor's `fixLinterErrorWithAI` puts into the composer,
 * VERBATIM (binary byte ~40267498):
 *   `For the code present, we get this error:\n\`\`\`\n${errorMessage}\n\`\`\`\nFix it, verify, and then give a concise explanation.`
 */
export function buildFixLinterPrompt(errorMessage: string): string {
	return `For the code present, we get this error:\n\`\`\`\n${errorMessage}\n\`\`\`\nFix it, verify, and then give a concise explanation.`;
}

/**
 * Hover button label with the dynamic keybinding suffix (binary:
 * `"Fix with Agent" + (p ? ` (${p.getLabel()})` : "")`).
 */
export function fixWithAgentHoverLabel(keybindingLabel: string | undefined): string {
	return FIX_WITH_AGENT_HOVER_LABEL + (keybindingLabel ? ` (${keybindingLabel})` : '');
}

/**
 * Hover hint line under the fix buttons (binary: textContent of
 * `div.fix-buttons-hint`): `${mac ? "⌘" : "Ctrl"}+click to open in new tab`.
 */
export function fixButtonsHint(isMacintosh: boolean): string {
	return `${isMacintosh ? '⌘' : 'Ctrl'}+click to open in new tab`;
}

/**
 * Title tooltip of the primary fix button (binary `Mhb`, when the caller
 * passes the title flag): `${mac ? "Cmd" : "Ctrl"}+click to fix in new chat`.
 */
export function fixButtonTitle(isMacintosh: boolean): string {
	return `${isMacintosh ? 'Cmd' : 'Ctrl'}+click to fix in new chat`;
}

/** Minimal range shape (1-based lines/columns, like VS Code's IRange). */
export interface IFixRange {
	readonly startLineNumber: number;
	readonly startColumn: number;
	readonly endLineNumber: number;
	readonly endColumn: number;
}

/** Minimal marker shape the code-action filter needs. */
export interface IFixMarkerLike extends IFixRange {
	readonly severity: number;
	readonly message: string;
	readonly resource: string;
	readonly source?: string;
	readonly code?: string | { value: string; target: string };
}

/** MarkerSeverity.Error value (platform/markers), kept numeric for purity. */
export const MARKER_SEVERITY_ERROR = 8;

/**
 * Binary `RJc.provideCodeActions` filter: only Error-severity markers whose
 * range intersects or touches the requested range. Range intersection is
 * implemented on plain line/column tuples (touching counts, matching
 * `Range.areIntersectingOrTouching`).
 */
export function rangesIntersectOrTouch(a: IFixRange, b: IFixRange): boolean {
	const aAfterB = a.startLineNumber > b.endLineNumber
		|| (a.startLineNumber === b.endLineNumber && a.startColumn > b.endColumn);
	const bAfterA = b.startLineNumber > a.endLineNumber
		|| (b.startLineNumber === a.endLineNumber && b.startColumn > a.endColumn);
	return !aAfterB && !bAfterA;
}

export function selectErrorMarkersForFix<T extends IFixMarkerLike>(markers: readonly T[], range: IFixRange): T[] {
	return markers.filter(m => m.severity === MARKER_SEVERITY_ERROR && rangesIntersectOrTouch(m, range));
}

/**
 * The code-selection range Cursor attaches for a fix (binary
 * `fixLinterErrorWithAI`): from line `max(1, start-1)` column 1 to line
 * `min(lineCount, end+2)` at that line's max column.
 */
export function fixContextRange(range: IFixRange, lineCount: number, maxColumnOfLine: (lineNumber: number) => number): IFixRange {
	const startLineNumber = Math.max(1, range.startLineNumber - 1);
	const endLineNumber = Math.min(lineCount, range.endLineNumber + 2);
	return {
		startLineNumber,
		startColumn: 1,
		endLineNumber,
		endColumn: maxColumnOfLine(endLineNumber)
	};
}

/**
 * Severity ranking of Cursor's cursor-on-lint tracker (binary `SiI` map):
 * Error -> 0, Warning -> 1, AI -> 2; anything else does not count as
 * "cursor on lint". Values are MarkerSeverity numbers.
 */
export function cursorOnLintSeverityRank(severity: number): number | undefined {
	switch (severity) {
		case 8: return 0; // MarkerSeverity.Error
		case 4: return 1; // MarkerSeverity.Warning
		// Binary also ranks a Cursor-only `MarkerSeverity.AI` member at 2.
		// HONEST-DIVERGENCE: stock VS Code's MarkerSeverity has no AI member
		// and its numeric value is not recoverable from the bundle snippet,
		// so AI-severity markers do not set the key in the fork (UNKNOWN).
		default: return undefined;
	}
}

/**
 * Binary `Axb`: the highest-priority (lowest rank) marker at the cursor
 * position, or undefined. Used by the cursor-on-lint contribution to set
 * `composer.isCursorOnLint`.
 */
export function markerAtPosition<T extends IFixMarkerLike>(markers: readonly T[], position: { lineNumber: number; column: number }): T | undefined {
	let best: T | undefined;
	let bestRank = Number.POSITIVE_INFINITY;
	for (const marker of markers) {
		const rank = cursorOnLintSeverityRank(marker.severity);
		if (rank === undefined || rank >= bestRank) {
			continue;
		}
		const afterStart = position.lineNumber > marker.startLineNumber
			|| (position.lineNumber === marker.startLineNumber && position.column >= marker.startColumn);
		const beforeEnd = position.lineNumber < marker.endLineNumber
			|| (position.lineNumber === marker.endLineNumber && position.column <= marker.endColumn);
		if (afterStart && beforeEnd) {
			best = marker;
			bestRank = rank;
		}
	}
	return best;
}
