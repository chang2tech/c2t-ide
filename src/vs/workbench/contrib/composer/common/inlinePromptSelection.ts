/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// IDE-CODE: Migrated from extensions/ide-agent/src/services/inlinePromptSelection.ts (CAT-B, vscode→DI)
//
// vscode API → core mapping used here (per docs/rea/ext-api-audit-2026-10-19.md §3):
//   window.activeTextEditor              → IEditorService.activeTextEditorControl (+ isCodeEditor)
//   window.showInformationMessage        → INotificationService.info
//   vscode.Range / vscode.Uri            → core Range (vs/editor/common/core/range),
//                                          URI (vs/base/common/uri)
//   TextDocument.version                 → ITextModel.getVersionId()
//
// The module-level functions of the original became the singleton DI service
// below: the pending selection is per-window state, so one service instance
// owns it. Consumers (InlineEditService, the `composer.addSelectionToInlinePrompt`
// command handler) resolve it through IInlinePromptSelectionService.

import { URI } from '../../../../base/common/uri.js';
import { Range } from '../../../../editor/common/core/range.js';
import { ICodeEditor, isCodeEditor } from '../../../../editor/browser/editorBrowser.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IEditorService } from '../../../../workbench/services/editor/common/editorService.js';

export const IInlinePromptSelectionService = createDecorator<IInlinePromptSelectionService>('composerInlinePromptSelectionService');

export interface PendingSelection {
	uri: URI;
	range: Range;
	/** Document version at capture time — stale-edit guard. */
	version: number;
}

export interface IInlinePromptSelectionService {
	readonly _serviceBrand: undefined;

	/**
	 * Capture the active editor's current selection as the pending
	 * inline-prompt target. Returns false (and tells the user) when there is
	 * nothing to attach.
	 */
	attachPendingSelection(): boolean;

	/** Consume (and clear) the pending selection, if any. */
	takePendingSelection(): PendingSelection | undefined;
}

export class InlinePromptSelectionService implements IInlinePromptSelectionService {

	declare readonly _serviceBrand: undefined;

	private pending: PendingSelection | undefined;

	constructor(
		@IEditorService private readonly editorService: IEditorService,
		@INotificationService private readonly notificationService: INotificationService,
	) { }

	attachPendingSelection(): boolean {
		const control = this.editorService.activeTextEditorControl;
		const editor: ICodeEditor | undefined = control && isCodeEditor(control) ? control : undefined;
		const model = editor?.getModel() ?? null;
		const selection = editor?.getSelection() ?? null;
		if (!editor || !model || !selection || selection.isEmpty() || model.isDisposed()) {
			this.notificationService.info('IDE Agent: select code in the editor first.');
			return false;
		}
		this.pending = {
			uri: model.uri,
			range: new Range(selection.startLineNumber, selection.startColumn, selection.endLineNumber, selection.endColumn),
			version: model.getVersionId(),
		};
		return true;
	}

	takePendingSelection(): PendingSelection | undefined {
		const p = this.pending;
		this.pending = undefined;
		return p;
	}
}
