/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { Emitter } from '../../../../../base/common/event.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import Severity from '../../../../../base/common/severity.js';
import { EditorOption } from '../../../../../editor/common/config/editorOptions.js';
import { Range } from '../../../../../editor/common/core/range.js';
import type { ICodeEditor } from '../../../../../editor/browser/editorBrowser.js';
import { INotificationService } from '../../../../../platform/notification/common/notification.js';
import { ICommandService } from '../../../../../platform/commands/common/commands.js';
import { IInlineEditService, type IInlineEditSuppressionInfo } from '../../common/inlineEditService.js';
import { InlineDiffSuppressionNotification } from '../../browser/inlineDiffSuppressionNotification.js';
import { InlineDiffPartialWidget } from '../../browser/inlineDiffPartialWidget.js';
import { InlineDiffDeletedCodeMargin } from '../../browser/inlineDiffDeletedCodeMargin.js';

// DEV-GAPS-53 — browser tests for the inline-diff group:
// - inline-diff-suppression-warning: contribution id
//   `workbench.contrib.composer.inlineDiffSuppressionNotification` shows the
//   "too many changes" warning with never-show-again
//   `inlineDiff.tooManyChangesWarning`.
// - inline-diff-partial-accept-reject companion UI (`inlineDiffPartialWidget`):
//   one per-hunk view zone with Accept/Reject controls.
// - inline-diff-deleted-code-margin: scroll-aware margin showing deleted
//   code, visible-line clamping top/bottom.

interface RecordedPrompt {
	severity: Severity;
	message: string;
	options?: { neverShowAgain?: { id: string } };
}

function fakeNotificationService(recorded: RecordedPrompt[]) {
	return {
		prompt: (severity: Severity, message: string, _choices: unknown[], options?: RecordedPrompt['options']) => {
			recorded.push({ severity, message: String(message), options });
			return { close: () => { } };
		},
	};
}

function fakeCommandService() {
	return { executeCommand: async () => undefined };
}

function fakeInlineEditService() {
	const emitter = new Emitter<IInlineEditSuppressionInfo>();
	return {
		onDidSuppressDiffDecorations: emitter.event,
		fire(info: IInlineEditSuppressionInfo) { emitter.fire(info); },
		dispose: () => emitter.dispose(),
	};
}

interface RecordedZone { id: string; afterLineNumber: number; domNode: HTMLElement; removed: boolean; }

function fakeEditorForZones() {
	const zones = new Map<string, RecordedZone>();
	let nextId = 1;
	const editor = {
		changeViewZones(callback: (accessor: unknown) => void) {
			callback({
				addZone: (zone: { afterLineNumber: number; domNode: HTMLElement }) => {
					const id = `zone-${nextId++}`;
					zones.set(id, { id, afterLineNumber: zone.afterLineNumber, domNode: zone.domNode, removed: false });
					return id;
				},
				removeZone: (id: string) => {
					zones.get(id)!.removed = true;
				},
			});
		},
		_zones: zones,
	} as unknown as ICodeEditor & { _zones: Map<string, RecordedZone> };
	return editor;
}

function fakeEditorForMargin(visibleStart: number, visibleEnd: number) {
	const domNode = document.createElement('div');
	document.body.appendChild(domNode);
	const editor = {
		getDomNode: () => domNode,
		onDidScrollChange: () => ({ dispose: () => { } }),
		getVisibleRanges: () => [new Range(visibleStart, 1, visibleEnd, 1)],
		getModel: () => null,
		getOption: (opt: EditorOption) => opt === EditorOption.lineHeight ? 18 : undefined,
		getTopForLineNumber: (lineNumber: number) => (lineNumber - 1) * 18,
		getScrollTop: () => 0,
		_domNode: domNode,
	} as unknown as ICodeEditor & { _domNode: HTMLElement };
	return editor;
}

suite('inline-diff group DEV-GAPS-53 (browser)', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('suppression notification id is binary-verbatim', () => {
		assert.strictEqual(
			InlineDiffSuppressionNotification.ID,
			'workbench.contrib.composer.inlineDiffSuppressionNotification',
		);
	});

	test('suppression fires a Warning prompt with the never-show-again tooManyChangesWarning id', () => {
		const recorded: RecordedPrompt[] = [];
		const service = fakeInlineEditService();
		const contribution = new InlineDiffSuppressionNotification(
			fakeNotificationService(recorded) as unknown as INotificationService,
			fakeCommandService() as unknown as ICommandService,
			service as unknown as IInlineEditService,
		);
		try {
			assert.strictEqual(recorded.length, 0);
			service.fire({ changeCount: 150, maxDecorations: 100, generationUUID: 'uuid-1' });
			assert.strictEqual(recorded.length, 1);
			assert.strictEqual(recorded[0]!.severity, Severity.Warning);
			assert.ok(recorded[0]!.message.includes('150'), 'message names the change count');
			assert.strictEqual(recorded[0]!.options?.neverShowAgain?.id, 'inlineDiff.tooManyChangesWarning');
		} finally {
			contribution.dispose();
			service.dispose();
		}
	});

	test('partial widget adds one view zone above the hunk with working Accept/Reject', () => {
		const editor = fakeEditorForZones();
		let accepted = 0;
		let rejected = 0;
		const widget = new InlineDiffPartialWidget(editor, {
			hunkIndex: 0,
			pendingCount: 2,
			hunkStartLineNumber: 10,
			onAccept: () => { accepted++; },
			onReject: () => { rejected++; },
		});
		try {
			const zones = [...editor._zones.values()];
			assert.strictEqual(zones.length, 1);
			assert.strictEqual(zones[0]!.afterLineNumber, 9, 'zone sits above the hunk start line');
			const label = zones[0]!.domNode.querySelector('.inline-diff-partial-widget-label');
			assert.strictEqual(label?.textContent, 'Change 1 of 2');
			const buttons = zones[0]!.domNode.querySelectorAll('button');
			assert.strictEqual(buttons.length, 2);
			(buttons[0] as HTMLButtonElement).click();
			(buttons[1] as HTMLButtonElement).click();
			assert.strictEqual(accepted, 1);
			assert.strictEqual(rejected, 1);
		} finally {
			widget.dispose();
		}
		const zones = [...editor._zones.values()];
		assert.strictEqual(zones[0]!.removed, true, 'dispose removes the view zone');
	});

	test('partial widget clamps afterLineNumber for a hunk starting at line 1', () => {
		const editor = fakeEditorForZones();
		const widget = new InlineDiffPartialWidget(editor, {
			hunkIndex: 0,
			pendingCount: 1,
			hunkStartLineNumber: 1,
			onAccept: () => { },
			onReject: () => { },
		});
		try {
			const zones = [...editor._zones.values()];
			assert.ok(zones[0]!.afterLineNumber >= 1);
		} finally {
			widget.dispose();
		}
	});

	test('deleted-code margin shows only deleted lines anchored in the viewport', () => {
		const editor = fakeEditorForMargin(10, 15);
		const margin = new InlineDiffDeletedCodeMargin(editor);
		try {
			margin.setDeletedLines([
				{ anchorLineNumber: 5, text: 'above', hunkIndex: 0 },
				{ anchorLineNumber: 12, text: 'visible', hunkIndex: 1 },
				{ anchorLineNumber: 20, text: 'below', hunkIndex: 2 },
			]);
			const container = editor._domNode.querySelector('.inline-diff-deleted-code-margin') as HTMLElement;
			assert.ok(container, 'margin container is attached');
			assert.notStrictEqual(container.style.display, 'none');
			const codes = [...container.querySelectorAll('.inline-diff-deleted-code-margin-code')]
				.map(el => el.textContent);
			assert.deepStrictEqual(codes, ['visible']);
			const more = [...container.querySelectorAll('.inline-diff-deleted-code-margin-more')]
				.map(el => el.textContent);
			assert.ok(more.some(t => t?.includes('1 more deleted line') && t.includes('above')));
			assert.ok(more.some(t => t?.includes('1 more deleted line') && t.includes('below')));
		} finally {
			margin.dispose();
			editor._domNode.remove();
		}
	});

	test('deleted-code margin hides when cleared', () => {
		const editor = fakeEditorForMargin(1, 100);
		const margin = new InlineDiffDeletedCodeMargin(editor);
		try {
			margin.setDeletedLines([{ anchorLineNumber: 5, text: 'x', hunkIndex: 0 }]);
			margin.clear();
			const container = editor._domNode.querySelector('.inline-diff-deleted-code-margin') as HTMLElement;
			assert.strictEqual(container.style.display, 'none');
		} finally {
			margin.dispose();
			editor._domNode.remove();
		}
	});
});
