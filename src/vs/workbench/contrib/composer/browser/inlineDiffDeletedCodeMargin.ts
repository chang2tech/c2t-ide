/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// IDE-CODE: deleted-code margin for Cmd+K inline diffs (Cursor parity).
//
// Binary evidence (Cursor 3.25.9, out/vs/workbench/workbench.glass.main.js,
// `inlineDiffDeletedCodeMargin.js`): a dedicated class displays the inline
// diff's deleted code in a scroll-aware margin (not just struck-through
// text). It computes the visible deleted-line counts above and below the
// viewport (`_visibleLineCountTop`, `_visibleLineCountBottom`), each clamped
// by the line count.
//
// What the fork had before: stock VS Code's
// `editor/browser/widget/diffEditor/components/diffEditorViewZones/inlineDiffDeletedCodeMargin.ts`
// (`InlineDiffDeletedCodeMargin`) — that one is bound to the SIDE-BY-SIDE
// DiffEditorWidget (10 constructor params incl. `DiffEditorWidget` and
// `DetailedLineRangeMapping`); it is NOT the inline-edit inline-diff margin.
// This class is the inline-diff (Cmd+K) surface, driven by the core
// `InlineEditService` preview session.
//
// HONEST DIVERGENCE: Cursor's class extends its internal margin base class;
// the fork extends `Disposable` and docks the margin as an absolutely
// positioned panel inside the editor DOM (re-rendered on scroll, hence
// scroll-aware), because the stock editor exposes no pluggable left-margin
// column for inline diffs. The visible-line clamping semantics are verbatim
// (see `common/inlineDiffDeletedCodeMargin.ts`).

import { Disposable } from '../../../../base/common/lifecycle.js';
import { addDisposableListener } from '../../../../base/browser/dom.js';
import { EditorOption } from '../../../../editor/common/config/editorOptions.js';
import type { ICodeEditor } from '../../../../editor/browser/editorBrowser.js';
import {
	computeDeletedMarginLayout,
	type IInlineDiffDeletedLine,
} from '../common/inlineDiffDeletedCodeMargin.js';
// Styles for the margin (shared inline-diff stylesheet).
import './media/inlineEditPromptBar.css';

/** CSS class of the margin container (Cursor's `.inline-diff-*` family). */
export const DELETED_CODE_MARGIN_CLASS = 'inline-diff-deleted-code-margin';

/**
 * Scroll-aware margin showing the pending inline diff's deleted code.
 *
 * Owned by the core `InlineEditService` (one instance per session editor):
 * `setDeletedLines()` on every decoration render, `clear()` when the
 * session ends. Rows are only rendered for deleted lines anchored inside
 * the current viewport; the counts above/below (`_visibleLineCountTop` /
 * `_visibleLineCountBottom`, clamped by the line count) surface as
 * "N more deleted lines" indicators.
 */
export class InlineDiffDeletedCodeMargin extends Disposable {
	private readonly container: HTMLElement;
	private readonly header: HTMLElement;
	private readonly body: HTMLElement;

	private deletedLines: IInlineDiffDeletedLine[] = [];

	/** Cursor's `_visibleLineCountTop` (clamped by the line count). */
	private _visibleLineCountTop = 0;
	/** Cursor's `_visibleLineCountBottom` (clamped by the line count). */
	private _visibleLineCountBottom = 0;

	constructor(private readonly editor: ICodeEditor) {
		super();

		this.container = document.createElement('div');
		this.container.className = DELETED_CODE_MARGIN_CLASS;
		this.container.style.display = 'none';

		this.header = document.createElement('div');
		this.header.className = 'inline-diff-deleted-code-margin-header';
		this.container.appendChild(this.header);

		this.body = document.createElement('div');
		this.body.className = 'inline-diff-deleted-code-margin-body';
		this.container.appendChild(this.body);

		editor.getDomNode()?.appendChild(this.container);

		// Scroll-aware: recompute the visible subset on every scroll.
		this._register(editor.onDidScrollChange(() => this.render()));
		this._register(addDisposableListener(this.container, 'wheel', (e: WheelEvent) => {
			// Let the margin's own list scroll without moving the editor.
			e.stopPropagation();
		}, true));
	}

	/** Replace the deleted lines shown by the margin (re-renders). */
	setDeletedLines(lines: IInlineDiffDeletedLine[]): void {
		this.deletedLines = lines.slice();
		this.render();
	}

	/** Hide the margin and drop its lines. */
	clear(): void {
		this.deletedLines = [];
		this._visibleLineCountTop = 0;
		this._visibleLineCountBottom = 0;
		this.container.style.display = 'none';
	}

	override dispose(): void {
		this.container.remove();
		super.dispose();
	}

	private render(): void {
		if (this.deletedLines.length === 0 || this.editor.getModel()?.isDisposed()) {
			this.container.style.display = 'none';
			return;
		}
		const visibleRanges = this.editor.getVisibleRanges();
		if (visibleRanges.length === 0) {
			this.container.style.display = 'none';
			return;
		}
		const visibleStart = visibleRanges[0]!.startLineNumber;
		const visibleEnd = visibleRanges[visibleRanges.length - 1]!.endLineNumber;
		const layout = computeDeletedMarginLayout(this.deletedLines, visibleStart, visibleEnd);
		this._visibleLineCountTop = layout.visibleLineCountTop;
		this._visibleLineCountBottom = layout.visibleLineCountBottom;

		if (layout.rows.length === 0) {
			this.container.style.display = 'none';
			return;
		}

		this.header.textContent = `Deleted code — ${layout.totalLineCount} line${layout.totalLineCount === 1 ? '' : 's'}`;
		this.body.textContent = '';

		if (this._visibleLineCountTop > 0) {
			this.body.appendChild(this.moreIndicator('up', this._visibleLineCountTop));
		}
		let lastHunk = -1;
		for (const row of layout.rows) {
			if (row.hunkIndex !== lastHunk) {
				lastHunk = row.hunkIndex;
				const sep = document.createElement('div');
				sep.className = 'inline-diff-deleted-code-margin-hunk';
				sep.textContent = `change ${row.hunkIndex + 1}`;
				this.body.appendChild(sep);
			}
			const el = document.createElement('div');
			el.className = 'inline-diff-deleted-code-margin-row';
			const no = document.createElement('span');
			no.className = 'inline-diff-deleted-code-margin-lineno';
			no.textContent = String(row.anchorLineNumber);
			const code = document.createElement('span');
			code.className = 'inline-diff-deleted-code-margin-code';
			code.textContent = row.text;
			el.appendChild(no);
			el.appendChild(code);
			this.body.appendChild(el);
		}
		if (this._visibleLineCountBottom > 0) {
			this.body.appendChild(this.moreIndicator('down', this._visibleLineCountBottom));
		}

		// Vertically align the panel with the first visible row's anchor line.
		const lineHeight = this.editor.getOption(EditorOption.lineHeight);
		const firstAnchor = layout.rows[0]!.anchorLineNumber;
		const top = Math.max(0, this.editor.getTopForLineNumber(firstAnchor) - this.editor.getScrollTop());
		const maxTop = Math.max(0, (this.editor.getDomNode()?.clientHeight ?? 0) - lineHeight * 3);
		this.container.style.top = `${Math.min(top, maxTop)}px`;
		this.container.style.display = 'block';
	}

	private moreIndicator(direction: 'up' | 'down', count: number): HTMLElement {
		const el = document.createElement('div');
		el.className = 'inline-diff-deleted-code-margin-more';
		el.textContent = direction === 'up'
			? `↑ ${count} more deleted line${count === 1 ? '' : 's'} above`
			: `↓ ${count} more deleted line${count === 1 ? '' : 's'} below`;
		return el;
	}
}
