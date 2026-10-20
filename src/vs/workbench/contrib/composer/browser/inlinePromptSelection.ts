/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// IDE-CODE: Migrated — vscode API → DI (2026-10-19).
//
// vscode API → core mapping used here:
//   vscode.window.activeTextEditor       → IEditorService.activeTextEditorControl
//                                          (guarded by isCodeEditor)
//   vscode.window.showInformationMessage → INotificationService.info
//   vscode.Uri / vscode.Range           → URI (vs/base/common/uri) / Range (vs/editor/common/core/range)
//
// Design change: the original kept module-level mutable state with free
// functions attachPendingSelection()/takePendingSelection(). The migration
// turns it into an injectable service class; InlineEditService (same batch)
// takes it as a constructor dependency. PendingSelection.uri is now a core URI.

/**
 * inlinePromptSelection — pending-selection store for the Cursor K-08 parity
 * command (`ide.addSelectionToInlinePrompt` — "Add selection to Cmd+K";
 * its former Ctrl/Cmd+Shift+K chord was reassigned to
 * `aipopup.action.modal.generate` by GAPS-171 per the 3.25.9 binary).
 *
 * Cursor lets you attach the current editor selection to the Cmd+K input and
 * then open the prompt later; the attached selection wins over the live cursor
 * selection. `InlineEditService.openPrompt()` consumes the pending selection
 * via `takePendingSelection()` (see the KEYBOARD-PARITY hook there).
 */

import { URI } from '../../../../base/common/uri.js';
import { Range } from '../../../../editor/common/core/range.js';
import { isCodeEditor } from '../../../../editor/browser/editorBrowser.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';

export interface IPendingSelection {
	uri: URI;
	range: Range;
	/** Document version at capture time — stale-edit guard. */
	version: number;
}

export class InlinePromptSelectionService {
	private pending: IPendingSelection | undefined;

	constructor(
		private readonly editorService: IEditorService,
		private readonly notificationService: INotificationService,
	) { }

	/**
	 * Capture the active editor's current selection as the pending inline-prompt
	 * target. Returns false (and tells the user) when there is nothing to attach.
	 */
	attachPendingSelection(): boolean {
		const control = this.editorService.activeTextEditorControl;
		if (!control || !isCodeEditor(control)) {
			this.notificationService.info('IDE Agent: select code in the editor first.');
			return false;
		}
		const model = control.getModel();
		const selection = control.getSelection();
		if (!model || !selection || selection.isEmpty() || model.isDisposed()) {
			this.notificationService.info('IDE Agent: select code in the editor first.');
			return false;
		}
		this.pending = {
			uri: model.uri,
			range: new Range(
				selection.startLineNumber,
				selection.startColumn,
				selection.endLineNumber,
				selection.endColumn,
			),
			version: model.getVersionId(),
		};
		return true;
	}

	/** Consume (and clear) the pending selection, if any. */
	takePendingSelection(): IPendingSelection | undefined {
		const p = this.pending;
		this.pending = undefined;
		return p;
	}
}
