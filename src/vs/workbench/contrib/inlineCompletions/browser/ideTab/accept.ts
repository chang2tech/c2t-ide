/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// IDE-CODE: Tab accept flows — rewritten from
// extensions/ide-agent/src/tab/accept.ts for the workbench core.
// Interface mapping:
//   vscode.TextEditor        → ICodeEditor (vs/editor/browser/editorBrowser)
//   vscode.Uri               → URI (vs/base/common/uri)
//   vscode.Range/Selection   → core Range/Selection (vs/editor/common/core)
//   commands.executeCommand('editor.action.inlineSuggest.commit')
//                            → injected commitInlineSuggestion() (ICommandService
//                              in tabContribution.ts)
//   workspace.asRelativePath → injected asRelativePath() (IWorkspaceContextService
//                              in tabContribution.ts)
//   editor.edit(eb => ...)   → ICodeEditor.executeEdits
//   HookService (extension)  → structural TabAgentHooks (duck-typed; the hooks
//                              workbench contrib provides the real one)

/**
 * Accept flows — port of Cursor's accept paths:
 *  - Full accept: Tab → `editor.action.inlineSuggest.commit`
 *    (`cursor.acceptcppsuggestion` programmatic), fate ACCEPT.
 *  - Partial (word) accept: Ctrl+Right convention (`cursor.acceptcppsuggestionpartial`,
 *    `acceptNextWordSuggestion`), `onlyAcceptFirstWord` semantics: apply the next
 *    word, keep the remainder as ghost text. Fate PARTIAL_ACCEPT.
 *  - Peek (`cursor.peekcppsuggestion`): partial accept + save pre-state for revert.
 *  - Revert (`cursor.revertcppsuggestion` → `revertSuggestion()`): restore the
 *    saved pre-state, fate REJECT.
 *
 * Every accept (full or partial) goes through the telemetry
 * `storeGeneratedContent(..., {source: TAB})` and resets the cleared-suggestion
 * throttle counter.
 */

import { URI } from '../../../../../base/common/uri.js';
import { Position } from '../../../../../editor/common/core/position.js';
import { Range } from '../../../../../editor/common/core/range.js';
import { Selection } from '../../../../../editor/common/core/selection.js';
import { EditOperation } from '../../../../../editor/common/core/editOperation.js';
import { ICodeEditor } from '../../../../../editor/browser/editorBrowser.js';
import { acceptNextWord } from './wordAccept.js';
import { NextActionEffect, resolveNextAction } from './nextEdit.js';
import { offsetToPosition, TabSession } from './session.js';
import { ClearedSuggestionTracker, FateTracker, TabTelemetry } from './telemetry.js';
import { TabFate } from './types.js';

/** Minimal structural shape of the agent-hooks service (duck-typed). */
export interface TabAgentHookResult {
	blocked?: boolean;
	[key: string]: unknown;
}

/** DEV-HOOKS: Cursor-style agent hooks for beforeTabFileRead/afterTabFileEdit. */
export interface TabAgentHooks {
	hasHooks(name: string): boolean;
	runHooks(name: string, payload: Record<string, unknown>): Promise<TabAgentHookResult>;
}

export interface AcceptDeps {
	session: TabSession;
	editor: ICodeEditor;
	fate: FateTracker;
	cleared: ClearedSuggestionTracker;
	telemetry: TabTelemetry;
	/** Set while we apply our own edits so type-away detection ignores them. */
	setOwnEdit(active: boolean): void;
	/** DEV-HOOKS: optional agent hooks for afterTabFileEdit. */
	agentHooks?: TabAgentHooks;
	/**
	 * DD-SB-5: aiCodeTracking `tab.accept` hook — called with the accepted text
	 * (full or partial portion) so the tracking service can count lines and
	 * record attribution. Optional; accepts must never break when unwired.
	 */
	onAiAccept?: (info: { text: string; uri: URI }) => void;
	/**
	 * Core replacement for
	 * `vscode.commands.executeCommand('editor.action.inlineSuggest.commit')`.
	 * Wired by tabContribution.ts to ICommandService.
	 */
	commitInlineSuggestion(): Promise<unknown>;
	/**
	 * Core replacement for `vscode.workspace.asRelativePath`.
	 * Wired by tabContribution.ts to IWorkspaceContextService + extUri.
	 */
	asRelativePath(uri: URI): string;
}

/** DEV-GAPS-34 (hooks-21-events): docs payload for afterTabFileEdit —
 * "Includes detailed edit information: `range`, `old_line`, and `new_line`
 * for precise edit tracking" (cursor.com/docs/hooks). Coordinates are
 * 0-based (LSP-style), converted from the editor's 1-based Positions. */
export interface TabHookEditRange {
	start: { line: number; character: number };
	end: { line: number; character: number };
}

/** DEV-HOOKS: fire afterTabFileEdit (informational, fire-and-forget). */
function fireAfterTabFileEdit(
	deps: AcceptDeps,
	acceptedText: string,
	edit?: { range: TabHookEditRange; oldText: string },
): void {
	const svc = deps.agentHooks;
	if (!svc?.hasHooks('afterTabFileEdit')) {
		return;
	}
	const model = deps.editor.getModel();
	const extras: Record<string, unknown> = {
		file: model?.uri.fsPath ?? '',
		languageId: model?.getLanguageId() ?? '',
		acceptedChars: acceptedText.length,
	};
	if (edit) {
		extras['range'] = edit.range;
		extras['old_line'] = edit.oldText;
		extras['new_line'] = acceptedText;
	}
	void svc
		.runHooks('afterTabFileEdit', extras)
		.catch(() => { });
}

function fileParts(deps: AcceptDeps, uri: URI): { fileName: string; fileExtension: string; relPath: string } {
	const fsPath = uri.fsPath;
	const fileName = fsPath.split(/[\\/]/).pop() ?? '';
	const dot = fileName.lastIndexOf('.');
	return {
		fileName,
		fileExtension: dot >= 0 ? fileName.slice(dot + 1) : '',
		relPath: deps.asRelativePath(uri),
	};
}

function trackAccept(deps: AcceptDeps, fate: TabFate, originalText: string, replacementText: string): void {
	const s = deps.session.current;
	if (!s) return;
	const { fileName, fileExtension, relPath } = fileParts(deps, s.uri);
	deps.fate.record(s.requestId, fate, fileExtension);
	deps.telemetry.storeGeneratedContent({
		requestId: s.requestId,
		relPath,
		fileName,
		fileExtension,
		originalText,
		replacementText,
		source: 'TAB',
		fate,
	});
	deps.telemetry.recordSessionEvent(fate === 'ACCEPT' ? 'acceptTab' : 'acceptTabPartial', {
		requestId: s.requestId,
		fate,
		fileExtension,
		modelId: s.modelId,
		modelVersion: s.modelVersion,
	});
	deps.cleared.resetOnAccept();
	// DD-SB-5: feed the aiCodeTracking `tab.accept` analog (lines + attribution).
	// Never let stats break the accept flow.
	try {
		deps.onAiAccept?.({ text: replacementText, uri: s.uri });
	} catch {
		/* stats are best-effort */
	}
}

/** Full accept via the stock inline-suggest commit. Returns the next-edit effect. */
export async function acceptFullSuggestion(deps: AcceptDeps): Promise<NextActionEffect> {
	const s = deps.session.current;
	if (!s) return { kind: 'none' };
	await deps.commitInlineSuggestion();
	const effect = resolveNextAction(s.nextAction);
	trackAccept(deps, 'ACCEPT', '', s.fullText);
	// DEV-GAPS-34: the suggestion is inserted at the cursor (zero-width
	// range) — old_line is empty, new_line is the full suggestion text.
	const start = s.insertPosition;
	const end = offsetToPosition(start, s.fullText);
	fireAfterTabFileEdit(deps, s.fullText, {
		range: {
			start: { line: start.lineNumber - 1, character: start.column - 1 },
			end: { line: end.lineNumber - 1, character: end.column - 1 },
		},
		oldText: '',
	});
	deps.session.clear();
	return effect;
}

/**
 * Partial accept: apply exactly the next word of the suggestion, keep the
 * remainder. Returns the next-edit effect (applied when fully consumed).
 */
export async function acceptPartialSuggestion(deps: AcceptDeps): Promise<NextActionEffect> {
	const { session, editor } = deps;
	const s = session.current;
	if (!s) return { kind: 'none' };

	const step = acceptNextWord(s.fullText, s.appliedLength);
	if (step.applied.length === 0) {
		session.clear();
		return { kind: 'none' };
	}

	const start: Position = s.insertPosition;
	const end = offsetToPosition(start, s.fullText.slice(0, s.appliedLength));
	const newText = s.fullText.slice(0, step.newOffset);
	// DEV-GAPS-34: capture the replaced text BEFORE the edit for the
	// afterTabFileEdit `old_line` payload field.
	const editRange = new Range(start.lineNumber, start.column, end.lineNumber, end.column);
	const oldText = editor.getModel()?.getValueInRange(editRange) ?? '';

	deps.setOwnEdit(true);
	try {
		editor.executeEdits('ideTab.partialAccept', [
			EditOperation.replace(
				editRange,
				newText,
			),
		]);
	} finally {
		deps.setOwnEdit(false);
	}

	const fullyConsumed = step.fullyConsumed;
	s.appliedLength = step.newOffset;
	s.partialRemainder = !fullyConsumed;

	trackAccept(deps, 'PARTIAL_ACCEPT', '', newText);
	fireAfterTabFileEdit(deps, newText, {
		range: {
			start: { line: start.lineNumber - 1, character: start.column - 1 },
			end: { line: end.lineNumber - 1, character: end.column - 1 },
		},
		oldText,
	});

	if (fullyConsumed) {
		const effect = resolveNextAction(s.nextAction);
		session.clear();
		return effect;
	}
	// Remainder stays: the inline completions controller keeps rendering the
	// leftover ghost text until the next trigger replaces it.
	return { kind: 'none' };
}

/** Peek = partial accept with the pre-state saved so revert can restore it. */
export async function peekSuggestion(deps: AcceptDeps): Promise<NextActionEffect> {
	const s = deps.session.current;
	if (!s) return { kind: 'none' };
	if (!s.savedPreState) {
		// P2 (XQA-06): save the actually-applied prefix, not ''. If the user
		// typed over part of the suggestion before peeking (appliedLength > 0),
		// revert must restore their typed text instead of wiping it.
		const active = deps.editor.getPosition();
		s.savedPreState = {
			text: s.fullText.slice(0, s.appliedLength),
			position: active ?? s.insertPosition,
		};
	}
	return acceptPartialSuggestion(deps);
}

/** Revert a peeked suggestion: restore pre-state, fate REJECT. */
export async function revertSuggestion(deps: AcceptDeps): Promise<void> {
	const { session, editor } = deps;
	const s = session.current;
	if (!s || !s.savedPreState) return;

	const start: Position = s.insertPosition;
	const end = offsetToPosition(start, s.fullText.slice(0, s.appliedLength));
	const saved = s.savedPreState;

	deps.setOwnEdit(true);
	try {
		editor.executeEdits('ideTab.revertPeek', [
			EditOperation.replace(
				new Range(start.lineNumber, start.column, end.lineNumber, end.column),
				saved.text,
			),
		]);
		const p = saved.position;
		editor.setSelection(new Selection(p.lineNumber, p.column, p.lineNumber, p.column));
	} finally {
		deps.setOwnEdit(false);
	}

	const { fileExtension } = fileParts(deps, s.uri);
	deps.fate.record(s.requestId, 'REJECT', fileExtension);
	deps.telemetry.recordSessionEvent('rejectTab', { requestId: s.requestId, via: 'revert' });
	session.clear();
}
