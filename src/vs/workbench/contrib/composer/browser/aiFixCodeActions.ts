/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * IDE-CODE (DEV-GAPS-83, agent-fix-with-agent-error): Cursor's AI fix
 * code-action contribution, ported at the same layer Cursor uses.
 *
 * QA step 1 — evidence, self-verified 2026-10-20 on Cursor 3.25.9
 * `out/vs/workbench/workbench.glass.main.js`:
 *
 * - Contribution `vZs`, ID `workbench.contrib.aiFixCodeActions`
 *   (byte ~42717352), registers:
 *   1. command `editor.action.fixInAgent` (`j6b`, byte 42716351) whose
 *      handler calls the composer service's
 *      `fixLinterErrorWithAI({ errorMessage, editorUri, range, addToCurrent: true })`
 *      from the command arguments `(uriString, message, range)`;
 *   2. a CodeActionProvider for `*` (`RJc`, same region) — see
 *      common/fixWithAgent.ts for the verbatim filter/action shape
 *      (title "Fix in Agent", QuickFix kind, Error markers only).
 * - The companion cursor-on-lint contribution `lKi`, ID
 *   `editor.contrib.composerCursorOnLint` (byte ~39780586), maintains the
 *   `composer.isCursorOnLint` context key from the active editor's cursor
 *   position using the binary's `Axb` marker picker.
 *
 * Fork wiring: the composer runtime lives in the ide-agent extension, so —
 * following the fork's established delegate pattern (composerActions.ts →
 * `ide.*` commands) — the `editor.action.fixInAgent` handler forwards to
 * `ide.fixWithAgent`, whose extension handler performs the
 * fixLinterErrorWithAI equivalent (verbatim prompt, ±context range,
 * generating-dedupe, addToCurrent semantics) against the live composer.
 *
 * HONEST-DIVERGENCE: in Cursor, `fixLinterErrorWithAI` PRE-FILLS the
 * composer input (`updateComposer` + `fireShouldForceText`) and only
 * submits when the caller passes `autoSubmit` (none of the three entry
 * points do). The fork's extension composer API is submit-based
 * (`ComposerDataService.submit`, the same path `ide.investigateError` /
 * `fixWithAI` already use), so the fork submits the verbatim prompt
 * instead of pre-filling it.
 */

import { Disposable } from '../../../../base/common/lifecycle.js';
import { ICodeEditor } from '../../../../editor/browser/editorBrowser.js';
import { ICodeEditorService } from '../../../../editor/browser/services/codeEditorService.js';
import { Range } from '../../../../editor/common/core/range.js';
import { CodeAction, CodeActionContext, CodeActionList } from '../../../../editor/common/languages.js';
import { ITextModel } from '../../../../editor/common/model.js';
import { ILanguageFeaturesService } from '../../../../editor/common/services/languageFeatures.js';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import { CommandsRegistry } from '../../../../platform/commands/common/commands.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IContextKey, IContextKeyService, RawContextKey } from '../../../../platform/contextkey/common/contextkey.js';
import { IMarkerService } from '../../../../platform/markers/common/markers.js';
import { CodeActionKind } from '../../../../editor/contrib/codeAction/common/types.js';
import {
	AI_FIX_CODE_ACTIONS_CONTRIBUTION_ID,
	CURSOR_ON_LINT_CONTEXT_KEY,
	FIX_IN_AGENT_ACTION_TITLE,
	FIX_IN_AGENT_COMMAND_ID,
	IFixRange,
	markerAtPosition,
	selectErrorMarkersForFix,
} from '../common/fixWithAgent.js';

/** Fork-side wire id: core `editor.action.fixInAgent` -> extension composer runtime. */
export const IDE_FIX_WITH_AGENT_COMMAND_ID = 'ide.fixWithAgent';

const cursorOnLintContext = new RawContextKey<boolean>(CURSOR_ON_LINT_CONTEXT_KEY, false);

function toFixRange(range: { startLineNumber: number; startColumn: number; endLineNumber: number; endColumn: number }): IFixRange {
	return {
		startLineNumber: range.startLineNumber,
		startColumn: range.startColumn,
		endLineNumber: range.endLineNumber,
		endColumn: range.endColumn
	};
}

/**
 * Port of the binary's `RJc` provider: QuickFix code actions titled
 * "Fix in Agent" for Error markers intersecting the requested range.
 */
export class AiFixCodeActionProvider {
	constructor(private readonly _markerService: IMarkerService) { }

	provideCodeActions(model: ITextModel, range: Range, context: CodeActionContext, _token: CancellationToken): CodeActionList | undefined {
		// Binary: `if (n.only !== QuickFix.value && n.only !== undefined) return;`
		if (context.only !== CodeActionKind.QuickFix.value && context.only !== undefined) {
			return undefined;
		}
		const candidates = this._markerService.read({ resource: model.uri }).map(marker => ({
			severity: marker.severity as number,
			message: marker.message,
			resource: marker.resource.toString(),
			startLineNumber: marker.startLineNumber,
			startColumn: marker.startColumn,
			endLineNumber: marker.endLineNumber,
			endColumn: marker.endColumn,
			marker
		}));
		const selected = selectErrorMarkersForFix(candidates, toFixRange(range));
		if (!selected.length) {
			return undefined;
		}
		const actions: CodeAction[] = selected.map(({ marker }) => {
			const markerRange = new Range(marker.startLineNumber, marker.startColumn, marker.endLineNumber, marker.endColumn);
			return {
				title: FIX_IN_AGENT_ACTION_TITLE,
				kind: CodeActionKind.QuickFix.value,
				diagnostics: [marker],
				command: {
					id: FIX_IN_AGENT_COMMAND_ID,
					title: FIX_IN_AGENT_ACTION_TITLE,
					// Binary arguments: [uri.toString(), message, range]
					arguments: [model.uri.toString(), marker.message, markerRange]
				}
			};
		});
		return { actions, dispose: () => { } };
	}
}

/**
 * Port of the binary's `vZs` contribution (plus the `lKi` cursor-on-lint
 * tracker that sits next to it in the bundle and feeds the
 * `composer.fixerrormessage` precondition).
 */
export class AiFixCodeActionsContribution extends Disposable {
	static readonly ID = AI_FIX_CODE_ACTIONS_CONTRIBUTION_ID;

	private readonly _cursorOnLintKey: IContextKey<boolean>;

	constructor(
		@IMarkerService markerService: IMarkerService,
		@ILanguageFeaturesService languageFeaturesService: ILanguageFeaturesService,
		@ICommandService commandService: ICommandService,
		@IContextKeyService contextKeyService: IContextKeyService,
		@ICodeEditorService codeEditorService: ICodeEditorService,
	) {
		super();
		this._cursorOnLintKey = cursorOnLintContext.bindTo(contextKeyService);

		// Binary vZs: `registerCommand(j6b, (accessor, uri, message, range) =>
		//   composerService.fixLinterErrorWithAI({ errorMessage: message,
		//   editorUri: uri, range, addToCurrent: true }))`.
		// An optional 4th argument (addToCurrent) is accepted for the marker
		// hover button, whose Ctrl/Cmd+click means "fix in NEW chat"
		// (binary Mhb onclick); the CodeAction path never passes it.
		this._register(CommandsRegistry.registerCommand(FIX_IN_AGENT_COMMAND_ID, async (_accessor, uriString?: unknown, message?: unknown, range?: unknown, addToCurrent?: unknown) => {
			if (typeof uriString !== 'string' || typeof message !== 'string' || !range || typeof range !== 'object') {
				return;
			}
			const r = range as IFixRange;
			await commandService.executeCommand(IDE_FIX_WITH_AGENT_COMMAND_ID, uriString, message, {
				startLineNumber: r.startLineNumber,
				startColumn: r.startColumn,
				endLineNumber: r.endLineNumber,
				endColumn: r.endColumn
			}, addToCurrent === false ? false : true);
		}));

		// Binary vZs: `codeActionProvider.register("*", RJc instance)`.
		const provider = new AiFixCodeActionProvider(markerService);
		this._register(languageFeaturesService.codeActionProvider.register('*', provider));

		// Binary lKi: track the active editor's cursor position + marker
		// changes and set `composer.isCursorOnLint` when `Axb` finds a
		// ranked marker at the cursor. ICodeEditorService has no
		// active-editor-change event, so cursor/model listeners are bound
		// per code editor (on add + for editors that already exist) and
		// only react when that editor is the active one — the same net
		// effect as the binary binding lKi to its editor instance.
		this._register(markerService.onMarkerChanged(() => this.updateCursorOnLint(markerService, codeEditorService)));
		const bindEditor = (editor: ICodeEditor) => {
			this._register(editor.onDidChangeCursorPosition(() => {
				if (codeEditorService.getActiveCodeEditor() === editor) {
					this.updateCursorOnLint(markerService, codeEditorService);
				}
			}));
			this._register(editor.onDidChangeModel(() => {
				if (codeEditorService.getActiveCodeEditor() === editor) {
					this.updateCursorOnLint(markerService, codeEditorService);
				}
			}));
		};
		for (const editor of codeEditorService.listCodeEditors()) {
			bindEditor(editor);
		}
		this._register(codeEditorService.onCodeEditorAdd(bindEditor));
		this.updateCursorOnLint(markerService, codeEditorService);
	}

	private updateCursorOnLint(markerService: IMarkerService, codeEditorService: ICodeEditorService): void {
		const editor = codeEditorService.getActiveCodeEditor();
		const model = editor?.getModel();
		const position = editor?.getPosition();
		if (!editor || !model || !position) {
			this._cursorOnLintKey.set(false);
			return;
		}
		const markers = markerService.read({ resource: model.uri }).map(m => ({
			severity: m.severity as number,
			message: m.message,
			resource: m.resource.toString(),
			startLineNumber: m.startLineNumber,
			startColumn: m.startColumn,
			endLineNumber: m.endLineNumber,
			endColumn: m.endColumn
		}));
		this._cursorOnLintKey.set(markerAtPosition(markers, { lineNumber: position.lineNumber, column: position.column }) !== undefined);
	}
}
