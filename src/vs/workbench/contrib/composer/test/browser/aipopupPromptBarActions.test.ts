/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { URI } from '../../../../../base/common/uri.js';
import { Range } from '../../../../../editor/common/core/range.js';
import { ICodeEditor } from '../../../../../editor/browser/editorBrowser.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { ICommandService } from '../../../../../platform/commands/common/commands.js';
import { IEditorService } from '../../../../services/editor/common/editorService.js';
import { ServicesAccessor } from '../../../../../platform/instantiation/common/instantiation.js';
import { ILogService } from '../../../../../platform/log/common/log.js';
import {
	IInlineEditPromptBar,
	IPromptBarDataSelection,
	IPromptBarRef,
} from '../../common/inlineEditPromptBar.js';
import {
	AipopupCloseActiveEditorPromptBarsAction,
	AipopupClosePromptBarAction,
	AipopupFocusEditAction,
	AipopupInsertEditSelectionAction,
	AipopupNextPromptBarAction,
	CmdkTogglePromptBarModelAction,
} from '../../browser/composerActions.js';

// DEV-GAPS-68 / WORKER W60C — `aipopup.*` prompt-bar action tests
// (feature_ids `cmdk-next-prompt-bar`, `cmdk-insert-edit-selection`).
//
// Binary evidence (Cursor 3.25.9 workbench.glass.main.js, offsets verified
// by direct reads):
// - `aipopup.action.nextPromptBar` (class Jqc @40742061 area): ID d4o,
//   LABEL "Next Prompt Bar", f1:!0, registered via `Ht(jcI)`; run sorts
//   getPromptBars() by createdAt, picks the next bar, and executes
//   `aipopup.action.focusEdit` with its id — else it focuses the active
//   editor (only when it has a model). NO keybinding anywhere.
// - `aipopup.action.focusEdit` (Zqc): LABEL "Focus Edit", f1:!0. NO keybinding.
// - `aipopup.action.insertEditSelection` (class Xfy @40742061): ezc id,
//   title {value:"Insert Edit Selection"}, f1:!0, NO keybinding; run guards
//   `!editor` → `!editor.hasModel()` (console.error "No model found, cannot
//   edit.") → `!selection` (console.error "No selection found, cannot
//   edit."), builds the item with `Mfh` and then:
//   `(r.appendDataSelection(n,c), !r.getPromptBar(n)) ||
//   o.executeCommand("aipopup.action.focusEdit", n)`.

interface RecordedCommand { id: string; args: unknown[]; }

class FakePromptBarService {
	bars: IPromptBarRef[] = [];
	focusedId: string | undefined;
	appended: { barId: string; selection: IPromptBarDataSelection }[] = [];
	focusedBars: string[] = [];

	getPromptBars(): readonly IPromptBarRef[] { return this.bars; }
	getFocusedPromptBarId(): string | undefined { return this.focusedId; }
	appendDataSelection(barId: string, selection: IPromptBarDataSelection): boolean {
		if (!this.bars.some((b) => b.id === barId)) {
			return false;
		}
		this.appended.push({ barId, selection });
		return true;
	}
	async focusPromptBar(id: string): Promise<void> { this.focusedBars.push(id); }
}

function makeEditor(overrides: Partial<{
	hasModel: boolean;
	selectionText: string;
	selection: Range | null;
}> = {}): { editor: ICodeEditor; state: { focusCalls: number } } {
	const state = { focusCalls: 0 };
	const model = {
		uri: URI.parse('file:///src/app.ts'),
		getValueInRange: () => overrides.selectionText ?? 'const x = 1;',
		getLanguageIdAtPosition: () => 'typescript',
	};
	const editor = {
		getModel: () => (overrides.hasModel === false ? null : model),
		hasModel: () => overrides.hasModel !== false,
		getSelection: () => overrides.selection === null ? null : (overrides.selection ?? new Range(3, 5, 3, 15)),
		changeViewZones: () => { /* guard stub for asCodeEditorFromAction */ },
		focus: () => { state.focusCalls++; },
	} as unknown as ICodeEditor;
	return { editor, state };
}

function accessorFor(opts: {
	service: FakePromptBarService;
	editor?: ICodeEditor;
	commands: RecordedCommand[];
	logErrors: string[];
}): ServicesAccessor {
	return {
		get: (id: unknown) => {
			if (id === IInlineEditPromptBar) {
				return opts.service;
			}
			if (id === IEditorService) {
				return { activeTextEditorControl: opts.editor };
			}
			if (id === ICommandService) {
				return {
					executeCommand: async (commandId: string, ...args: unknown[]) => {
						opts.commands.push({ id: commandId, args });
					},
				};
			}
			if (id === ILogService) {
				return { error: (message: string) => { opts.logErrors.push(message); } };
			}
			throw new Error('unexpected service');
		},
	} as unknown as ServicesAccessor;
}

suite('aipopup prompt-bar actions (Cursor 3.25.9 parity)', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('registration: verbatim ids, titles, f1:!0, no keybindings', () => {
		const next = new AipopupNextPromptBarAction();
		assert.strictEqual(next.desc.id, 'aipopup.action.nextPromptBar');
		assert.strictEqual(next.desc.title.value, 'Next Prompt Bar');
		assert.strictEqual(next.desc.f1, true);
		assert.strictEqual(next.desc.keybinding, undefined);

		const focus = new AipopupFocusEditAction();
		assert.strictEqual(focus.desc.id, 'aipopup.action.focusEdit');
		assert.strictEqual(focus.desc.title.value, 'Focus Edit');
		assert.strictEqual(focus.desc.f1, true);
		assert.strictEqual(focus.desc.keybinding, undefined);

		const insert = new AipopupInsertEditSelectionAction();
		assert.strictEqual(insert.desc.id, 'aipopup.action.insertEditSelection');
		assert.strictEqual(insert.desc.title.value, 'Insert Edit Selection');
		assert.strictEqual(insert.desc.f1, true);
		assert.strictEqual(insert.desc.keybinding, undefined);
	});

	test('registration: no category on remaining prompt-bar actions (W69B)', () => {
		// W69B follow-up of W66C: the binary registrations carry NO
		// `category` for any of these (Cursor 3.25.9 AND 3.25.6, glass +
		// desktop, verified by direct reads of the registration objects):
		const close = new AipopupClosePromptBarAction();
		assert.strictEqual(close.desc.id, 'aipopup.action.closePromptBar');
		assert.strictEqual(close.desc.title.value, 'Close Prompt Bar');
		// 3.25.9 glass class Qfy super @40742729, desktop ktg @32239238
		// (re-sliced by W73C): {id, title, precondition, keybinding} only
		// — no category, and NO `f1` field at all (glass and desktop
		// agree), so `desc.f1` must be absent, not true.
		assert.strictEqual(close.desc.category, undefined);
		assert.strictEqual(close.desc.f1, undefined);

		const closeAll = new AipopupCloseActiveEditorPromptBarsAction();
		assert.strictEqual(closeAll.desc.id, 'workbench.action.closeActiveEditorPromptBars');
		assert.strictEqual(closeAll.desc.title.value, 'Close Active Editor Prompt Bars');
		// The binary's tier-2 Esc is `workbench.action.closeActiveEditorPromptBars`
		// (3.25.9 glass super @40751517, `.ID` @40752018; desktop super
		// @32248026, `.ID` @32248527; re-sliced by W73C): {id, title,
		// f1:!1, keybinding:[...]} only — no category, f1 = false
		// (hidden from the Command Palette; glass and desktop agree).
		assert.strictEqual(closeAll.desc.category, undefined);
		assert.strictEqual(closeAll.desc.f1, false);

		const toggleModel = new CmdkTogglePromptBarModelAction();
		assert.strictEqual(toggleModel.desc.id, 'cmdk.togglePromptBarModel');
		assert.strictEqual(toggleModel.desc.title.value, 'Open model toggle');
		// 3.25.9 glass class hzc super @40750368, desktop @32246877:
		// {id, title, f1:!1, keybinding:[...]} only — no category.
		assert.strictEqual(toggleModel.desc.category, undefined);

		// W66C/W64C removals still hold.
		assert.strictEqual(new AipopupNextPromptBarAction().desc.category, undefined);
		assert.strictEqual(new AipopupFocusEditAction().desc.category, undefined);
		assert.strictEqual(new AipopupInsertEditSelectionAction().desc.category, undefined);
	});

	test('nextPromptBar: cycles to the next bar via focusEdit (binary run body)', async () => {
		const service = new FakePromptBarService();
		service.bars = [
			{ id: 'bar-a', createdAt: 100 },
			{ id: 'bar-b', createdAt: 200 },
		];
		service.focusedId = 'bar-a';
		const commands: RecordedCommand[] = [];
		const { editor } = makeEditor();
		await new AipopupNextPromptBarAction().run(accessorFor({ service, editor, commands, logErrors: [] }));
		assert.deepStrictEqual(commands, [{ id: 'aipopup.action.focusEdit', args: ['bar-b'] }]);
	});

	test('nextPromptBar: explicit current id wraps around to the oldest bar', async () => {
		const service = new FakePromptBarService();
		service.bars = [
			{ id: 'bar-a', createdAt: 100 },
			{ id: 'bar-b', createdAt: 200 },
		];
		const commands: RecordedCommand[] = [];
		const { editor } = makeEditor();
		await new AipopupNextPromptBarAction().run(accessorFor({ service, editor, commands, logErrors: [] }), 'bar-b');
		assert.deepStrictEqual(commands, [{ id: 'aipopup.action.focusEdit', args: ['bar-a'] }]);
	});

	test('nextPromptBar: single focused bar → else-branch focuses the editor', async () => {
		const service = new FakePromptBarService();
		service.bars = [{ id: 'bar-a', createdAt: 100 }];
		service.focusedId = 'bar-a';
		const commands: RecordedCommand[] = [];
		const { editor, state } = makeEditor();
		await new AipopupNextPromptBarAction().run(accessorFor({ service, editor, commands, logErrors: [] }));
		assert.deepStrictEqual(commands, []);
		assert.strictEqual(state.focusCalls, 1);
	});

	test('focusEdit: delegates to the prompt-bar service with the bar id', async () => {
		const service = new FakePromptBarService();
		const commands: RecordedCommand[] = [];
		const { editor } = makeEditor();
		await new AipopupFocusEditAction().run(accessorFor({ service, editor, commands, logErrors: [] }), 'bar-a');
		assert.deepStrictEqual(service.focusedBars, ['bar-a']);
	});

	test('focusEdit: no model → logs "No model found, cannot edit." and stops', async () => {
		const service = new FakePromptBarService();
		const commands: RecordedCommand[] = [];
		const logErrors: string[] = [];
		const { editor } = makeEditor({ hasModel: false });
		await new AipopupFocusEditAction().run(accessorFor({ service, editor, commands, logErrors }), 'bar-a');
		assert.deepStrictEqual(service.focusedBars, []);
		assert.deepStrictEqual(logErrors, ['No model found, cannot edit.']);
	});

	test('insertEditSelection: appends the Mfh item, then focuses the bar', async () => {
		const service = new FakePromptBarService();
		service.bars = [{ id: 'bar-a', createdAt: 100, uri: 'file:///src/app.ts' }];
		const commands: RecordedCommand[] = [];
		const { editor } = makeEditor({ selectionText: '    const x = 1;' });
		await new AipopupInsertEditSelectionAction().run(accessorFor({ service, editor, commands, logErrors: [] }), 'bar-a');
		assert.strictEqual(service.appended.length, 1);
		assert.strictEqual(service.appended[0].barId, 'bar-a');
		// Mfh item: dedented + fenced with the model language id.
		assert.strictEqual(service.appended[0].selection.text, '```typescript\nconst x = 1;\n```');
		assert.strictEqual(service.appended[0].selection.rawText, '    const x = 1;');
		assert.deepStrictEqual(service.appended[0].selection.range, {
			selectionStartLineNumber: 3,
			selectionStartColumn: 5,
			positionLineNumber: 3,
			positionColumn: 15,
		});
		assert.deepStrictEqual(commands, [{ id: 'aipopup.action.focusEdit', args: ['bar-a'] }]);
	});

	test('insertEditSelection: no arg → newest bar for the active document uri', async () => {
		const service = new FakePromptBarService();
		service.bars = [
			{ id: 'bar-old', createdAt: 100, uri: 'file:///src/app.ts' },
			{ id: 'bar-new', createdAt: 200, uri: 'file:///src/app.ts' },
			{ id: 'bar-other', createdAt: 300, uri: 'file:///src/other.ts' },
		];
		const commands: RecordedCommand[] = [];
		const { editor } = makeEditor();
		await new AipopupInsertEditSelectionAction().run(accessorFor({ service, editor, commands, logErrors: [] }));
		assert.strictEqual(service.appended.length, 1);
		assert.strictEqual(service.appended[0].barId, 'bar-new');
		assert.deepStrictEqual(commands, [{ id: 'aipopup.action.focusEdit', args: ['bar-new'] }]);
	});

	test('insertEditSelection: no open bar → silent no-op (binary)', async () => {
		const service = new FakePromptBarService();
		const commands: RecordedCommand[] = [];
		const { editor } = makeEditor();
		await new AipopupInsertEditSelectionAction().run(accessorFor({ service, editor, commands, logErrors: [] }));
		assert.deepStrictEqual(service.appended, []);
		assert.deepStrictEqual(commands, []);
	});

	test('insertEditSelection: no editor → returns immediately (binary)', async () => {
		const service = new FakePromptBarService();
		const commands: RecordedCommand[] = [];
		await new AipopupInsertEditSelectionAction().run(accessorFor({ service, editor: undefined, commands, logErrors: [] }));
		assert.deepStrictEqual(service.appended, []);
		assert.deepStrictEqual(commands, []);
	});

	test('insertEditSelection: no model → error path, nothing appended', async () => {
		const service = new FakePromptBarService();
		service.bars = [{ id: 'bar-a', createdAt: 100, uri: 'file:///src/app.ts' }];
		const commands: RecordedCommand[] = [];
		const { editor } = makeEditor({ hasModel: false });
		await new AipopupInsertEditSelectionAction().run(accessorFor({ service, editor, commands, logErrors: [] }), 'bar-a');
		assert.deepStrictEqual(service.appended, []);
		assert.deepStrictEqual(commands, []);
	});
});
