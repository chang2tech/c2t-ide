/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * DEV-GAPS-83 — `agent-fix-with-agent-error` pure-logic tests.
 *
 * Every expectation is pinned to self-verified binary evidence from
 * Cursor 3.25.9 `out/vs/workbench/workbench.glass.main.js`:
 * - `j6b = "editor.action.fixInAgent"` @byte 42716351
 * - CodeActionProvider `RJc` @byte ~42717352 (title "Fix in Agent",
 *   QuickFix kind, Error markers only, intersecting-or-touching ranges)
 * - `fixLinterErrorWithAI` prompt + context widening @byte ~40267498
 * - marker-hover button label/hint/title (factory `Mhb`) @byte ~36258759
 *   and its call site in `_renderMarkerHover` @byte ~36261109
 * - cursor-on-lint severity ranks (`SiI`) + picker (`Axb`) @byte ~39780586
 */
import { describe, it } from 'node:test';
import assert from 'node:assert';
import {
	FIX_IN_AGENT_ACTION_TITLE,
	FIX_IN_AGENT_COMMAND_ID,
	FIX_WITH_AGENT_HOVER_LABEL,
	buildFixLinterPrompt,
	cursorOnLintSeverityRank,
	fixButtonsHint,
	fixButtonTitle,
	fixContextRange,
	fixWithAgentHoverLabel,
	markerAtPosition,
	rangesIntersectOrTouch,
	selectErrorMarkersForFix,
} from '../../common/fixWithAgent.js';

describe('fixWithAgent (DEV-GAPS-83, Cursor 3.25.9 parity)', () => {
	it('verbatim ids and titles', () => {
		assert.equal(FIX_IN_AGENT_COMMAND_ID, 'editor.action.fixInAgent');
		assert.equal(FIX_IN_AGENT_ACTION_TITLE, 'Fix in Agent');
		assert.equal(FIX_WITH_AGENT_HOVER_LABEL, 'Fix with Agent');
	});

	it('prompt is byte-identical to fixLinterErrorWithAI', () => {
		assert.equal(
			buildFixLinterPrompt('Cannot find name \'foo\'.'),
			'For the code present, we get this error:\n```\nCannot find name \'foo\'.\n```\nFix it, verify, and then give a concise explanation.'
		);
	});

	it('hover label appends the dynamic keybinding label only when present', () => {
		assert.equal(fixWithAgentHoverLabel('Ctrl+Shift+D'), 'Fix with Agent (Ctrl+Shift+D)');
		assert.equal(fixWithAgentHoverLabel(undefined), 'Fix with Agent');
		assert.equal(fixWithAgentHoverLabel(''), 'Fix with Agent');
	});

	it('hint and button title use the platform modifier verbatim', () => {
		assert.equal(fixButtonsHint(true), '⌘+click to open in new tab');
		assert.equal(fixButtonsHint(false), 'Ctrl+click to open in new tab');
		assert.equal(fixButtonTitle(true), 'Cmd+click to fix in new chat');
		assert.equal(fixButtonTitle(false), 'Ctrl+click to fix in new chat');
	});

	it('range intersection includes touching ranges', () => {
		const range = { startLineNumber: 5, startColumn: 3, endLineNumber: 5, endColumn: 20 };
		assert.equal(rangesIntersectOrTouch(range, { startLineNumber: 5, startColumn: 20, endLineNumber: 6, endColumn: 1 }), true);
		assert.equal(rangesIntersectOrTouch(range, { startLineNumber: 5, startColumn: 21, endLineNumber: 6, endColumn: 1 }), false);
		assert.equal(rangesIntersectOrTouch(range, { startLineNumber: 4, startColumn: 1, endLineNumber: 5, endColumn: 3 }), true);
		assert.equal(rangesIntersectOrTouch(range, { startLineNumber: 6, startColumn: 1, endLineNumber: 6, endColumn: 9 }), false);
	});

	it('selectErrorMarkersForFix keeps only Error markers in range', () => {
		const range = { startLineNumber: 5, startColumn: 3, endLineNumber: 5, endColumn: 20 };
		const markers = [
			{ severity: 8, message: 'err', resource: 'file:///a', ...range },
			{ severity: 4, message: 'warn', resource: 'file:///a', ...range },
			{ severity: 8, message: 'far', resource: 'file:///a', startLineNumber: 50, startColumn: 1, endLineNumber: 50, endColumn: 9 },
		];
		const selected = selectErrorMarkersForFix(markers, range);
		assert.equal(selected.length, 1);
		assert.equal(selected[0].message, 'err');
	});

	it('fixContextRange widens -1/+2 clamped, full width', () => {
		const ctx = fixContextRange(
			{ startLineNumber: 5, startColumn: 3, endLineNumber: 5, endColumn: 20 },
			100,
			line => line * 10
		);
		assert.deepEqual(ctx, { startLineNumber: 4, startColumn: 1, endLineNumber: 7, endColumn: 70 });
		const clamped = fixContextRange(
			{ startLineNumber: 1, startColumn: 1, endLineNumber: 100, endColumn: 5 },
			100,
			() => 42
		);
		assert.deepEqual(clamped, { startLineNumber: 1, startColumn: 1, endLineNumber: 100, endColumn: 42 });
	});

	it('cursor-on-lint ranks Error above Warning; other severities do not count', () => {
		assert.equal(cursorOnLintSeverityRank(8), 0);
		assert.equal(cursorOnLintSeverityRank(4), 1);
		assert.equal(cursorOnLintSeverityRank(2), undefined);
		assert.equal(cursorOnLintSeverityRank(1), undefined);
	});

	it('markerAtPosition picks the lowest-rank marker containing the position', () => {
		const markers = [
			{ severity: 4, message: 'warn', resource: 'file:///a', startLineNumber: 5, startColumn: 1, endLineNumber: 5, endColumn: 30 },
			{ severity: 8, message: 'err', resource: 'file:///a', startLineNumber: 5, startColumn: 10, endLineNumber: 5, endColumn: 12 },
			{ severity: 8, message: 'elsewhere', resource: 'file:///a', startLineNumber: 9, startColumn: 1, endLineNumber: 9, endColumn: 5 },
		];
		assert.equal(markerAtPosition(markers, { lineNumber: 5, column: 11 })?.message, 'err');
		assert.equal(markerAtPosition(markers, { lineNumber: 5, column: 20 })?.message, 'warn');
		assert.equal(markerAtPosition(markers, { lineNumber: 3, column: 1 }), undefined);
	});
});
