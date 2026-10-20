/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// IDE-CODE: per-hunk accept/reject widget for Cmd+K inline diffs (Cursor parity).
//
// Binary evidence (Cursor 3.25.9, workbench.glass.main.js — see also
// dig-continuous-inline-edit-2026-10-19.md §3.3/§5):
// - `inlineDiffPartialWidget` (companion UI of the partial accept/reject
//   mechanism); `inlineDiffController.showDiff()` gives every diff
//   `zoneWidgets` and `partialWidgets` (id = diffId + "-partial" + index) —
//   every individual hunk/change gets its own accept/reject controls, not
//   just the accept-all/reject-all commands.
// - Commands `editor.action.inlineDiffs.acceptPartialEdit` /
//   `rejectPartialEdit` resolve the hunk nearest the cursor; the widget
//   pins the same operations to the hunk visually.
//
// The widget is a Monaco view zone anchored above its hunk (the layer Cursor
// uses for inline-diff UI). It is created/disposed by the core
// `InlineEditService` in `renderHunkDecorations()` — one widget per pending
// hunk — and hidden when performance protection suppresses the diff.

import { Disposable } from '../../../../base/common/lifecycle.js';
import { addDisposableListener } from '../../../../base/browser/dom.js';
import type { ICodeEditor } from '../../../../editor/browser/editorBrowser.js';
// Styles for the widget (shared inline-diff stylesheet).
import './media/inlineEditPromptBar.css';

/** CSS class of the widget (Cursor's `inlineDiffPartialWidget`, kebab-cased). */
export const PARTIAL_WIDGET_CLASS = 'inline-diff-partial-widget';

export interface IInlineDiffPartialWidgetOptions {
	/** 0-based index of this hunk among the diff's hunks. */
	readonly hunkIndex: number;
	/** Number of hunks still pending (for the "change i of n" label). */
	readonly pendingCount: number;
	/** 1-based line number of the hunk's first line in the merged preview. */
	readonly hunkStartLineNumber: number;
	readonly onAccept: () => void;
	readonly onReject: () => void;
}

/**
 * One per-hunk accept/reject control, rendered as a view zone above the hunk.
 * Cursor's `inlineDiffPartialWidget` analog (id = diffId + "-partial" + index).
 */
export class InlineDiffPartialWidget extends Disposable {
	private zoneId: string | undefined;

	constructor(
		private readonly editor: ICodeEditor,
		private readonly options: IInlineDiffPartialWidgetOptions,
	) {
		super();
		this.render();
	}

	override dispose(): void {
		this.removeZone();
		super.dispose();
	}

	private render(): void {
		const { hunkIndex, pendingCount, hunkStartLineNumber, onAccept, onReject } = this.options;

		const domNode = document.createElement('div');
		domNode.className = PARTIAL_WIDGET_CLASS;

		const label = document.createElement('span');
		label.className = 'inline-diff-partial-widget-label';
		label.textContent = `Change ${hunkIndex + 1} of ${pendingCount}`;
		domNode.appendChild(label);

		const acceptBtn = document.createElement('button');
		acceptBtn.className = 'inline-diff-partial-widget-button inline-diff-partial-widget-accept';
		acceptBtn.textContent = '✓ Accept';
		acceptBtn.title = 'Accept this change (editor.action.inlineDiffs.acceptPartialEdit)';
		this._register(addDisposableListener(acceptBtn, 'click', () => onAccept()));
		domNode.appendChild(acceptBtn);

		const rejectBtn = document.createElement('button');
		rejectBtn.className = 'inline-diff-partial-widget-button inline-diff-partial-widget-reject';
		rejectBtn.textContent = '✕ Reject';
		rejectBtn.title = 'Reject this change (editor.action.inlineDiffs.rejectPartialEdit)';
		this._register(addDisposableListener(rejectBtn, 'click', () => onReject()));
		domNode.appendChild(rejectBtn);

		// View zones render AFTER afterLineNumber; clamp to >= 1 so a hunk
		// starting at line 1 does not produce an invalid zone.
		const afterLineNumber = Math.max(1, hunkStartLineNumber - 1);
		try {
			this.editor.changeViewZones(accessor => {
				this.zoneId = accessor.addZone({
					afterLineNumber,
					heightInPx: 30,
					domNode,
				});
			});
		} catch {
			/* the editor may already be gone (undo/redo re-render race) */
		}
	}

	private removeZone(): void {
		const zoneId = this.zoneId;
		this.zoneId = undefined;
		if (zoneId === undefined) {
			return;
		}
		try {
			this.editor.changeViewZones(accessor => accessor.removeZone(zoneId));
		} catch {
			/* the editor may already be gone */
		}
	}
}
