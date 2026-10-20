/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { URI } from '../../../../../base/common/uri.js';
import { Range } from '../../../../../editor/common/core/range.js';
import { KeyCode, KeyMod } from '../../../../../base/common/keyCodes.js';
import { ICodeEditor } from '../../../../../editor/browser/editorBrowser.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { ContextKeyValue, IContext } from '../../../../../platform/contextkey/common/contextkey.js';
import { ICommandService } from '../../../../../platform/commands/common/commands.js';
import { IEditorService } from '../../../../services/editor/common/editorService.js';
import { ServicesAccessor } from '../../../../../platform/instantiation/common/instantiation.js';
import { IInlineEditService } from '../../common/inlineEditService.js';
import {
	IInlineEditPromptBar,
	IPromptBarRef,
} from '../../common/inlineEditPromptBar.js';
import {
	AipopupModalGenerateAction,
	ComposerAddSelectionToInlinePromptAction,
} from '../../browser/composerActions.js';

// GAPS-171 — `aipopup.action.modal.generate` (STILL-OPEN #26 remainder).
//
// Binary evidence (Cursor 3.25.9, re-sliced by GAPS-171 from BOTH bundles):
// - glass class `goo` super @40731968: id `vtt` =
//   "aipopup.action.modal.generate" (const @1136848), title
//   `Y2b="Open Edit (Command K)"` (@40718363), f1:!0, NO category,
//   precondition `arf.negate()` (`arf=new pn("composerBarIsVisible",!1)`
//   @17969685), keybinding [{when: editorFocus, primary:
//   CtrlCmd|Shift|KeyK, weight: 1401, args:{invocationType:"toggle"}},
//   {when: editorFocus || editcontextbarcursor, primary: CtrlCmd|KeyK,
//   weight: 1401, args:{invocationType:"new"}}]
//   (`tPb=CtrlCmd|Shift|KeyK` @40731457, `nPb=new pn("editorFocus",!0)`
//   @40731489, `pil=new pn("editcontextbarcursor",!1)` @18093186).
// - desktop class `SLr` @32228473 identical.
// - The binary has NO `composer.addSelectionToInlinePrompt` id (0 hits in
//   both bundles): the fork's former Ctrl+Shift+K chord for that command
//   was reassigned to modal.generate's toggle rule.

function context(values: Record<string, ContextKeyValue>): IContext {
	return { getValue: <T extends ContextKeyValue>(key: string) => values[key] as T | undefined };
}

interface RecordedCommand { id: string; args: unknown[]; }

class FakePromptBarService {
	bars: IPromptBarRef[] = [];
	getPromptBars(): readonly IPromptBarRef[] { return this.bars; }
}

function makeEditor(overrides: Partial<{
	hasModel: boolean;
	selection: Range | null;
}> = {}): ICodeEditor {
	const model = {
		uri: URI.parse('file:///src/app.ts'),
		getValueInRange: () => 'const x = 1;',
		getLanguageIdAtPosition: () => 'typescript',
	};
	return {
		getModel: () => (overrides.hasModel === false ? null : model),
		hasModel: () => overrides.hasModel !== false,
		getSelection: () => overrides.selection === null ? null : (overrides.selection ?? new Range(3, 5, 3, 5)),
		changeViewZones: () => { /* guard stub for asCodeEditorFromAction */ },
		focus: () => { /* noop */ },
	} as unknown as ICodeEditor;
}

function accessorFor(opts: {
	service: FakePromptBarService;
	editor?: ICodeEditor;
	commands: RecordedCommand[];
	core?: { openPrompt: () => Promise<void> };
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
			if (id === IInlineEditService) {
				// Production semantics: get returns undefined for an
				// unregistered service — the web/aux fallback path.
				return opts.core;
			}
			throw new Error('unexpected service');
		},
	} as unknown as ServicesAccessor;
}

function titleValue(action: { desc: { title: unknown } }): string {
	const title = action.desc.title;
	return typeof title === 'string' ? title : (title as { value: string }).value;
}

suite('aipopup.action.modal.generate (Cursor 3.25.9 parity, GAPS-171)', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('id, title, f1 and category match the binary', () => {
		const action = new AipopupModalGenerateAction();
		assert.strictEqual(AipopupModalGenerateAction.ID, 'aipopup.action.modal.generate');
		assert.strictEqual(action.desc.id, 'aipopup.action.modal.generate');
		assert.strictEqual(titleValue(action), 'Open Edit (Command K)');
		assert.strictEqual(action.desc.f1, true);
		assert.strictEqual(action.desc.category, undefined, 'binary registers no category');
	});

	test('precondition is !composerBarIsVisible (binary arf.negate())', () => {
		const action = new AipopupModalGenerateAction();
		assert.ok(action.desc.precondition, 'precondition defined');
		assert.strictEqual(action.desc.precondition!.evaluate(context({})), true);
		assert.strictEqual(action.desc.precondition!.evaluate(context({ composerBarIsVisible: false })), true);
		assert.strictEqual(action.desc.precondition!.evaluate(context({ composerBarIsVisible: true })), false);
	});

	test('keybindings: toggle Shift+K and new Ctrl+K, both weight 1401 with binary args/when', () => {
		const action = new AipopupModalGenerateAction();
		const kbRaw = action.desc.keybinding;
		assert.ok(Array.isArray(kbRaw), 'expected an array of keybinding rules');
		const kb = (Array.isArray(kbRaw) ? kbRaw : []) as unknown as {
			primary: number; weight?: number; args?: unknown;
			when?: { evaluate(c: IContext): boolean };
		}[];
		assert.strictEqual(kb.length, 2);
		const [toggle, create] = kb;
		// Rule 1 — toggle: CtrlCmd+Shift+K, when editorFocus.
		assert.strictEqual(toggle.weight, 1401);
		assert.strictEqual(toggle.primary, KeyMod.CtrlCmd | KeyMod.Shift | KeyCode.KeyK);
		assert.deepStrictEqual(toggle.args, { invocationType: 'toggle' });
		assert.strictEqual(toggle.when!.evaluate(context({ editorFocus: true })), true);
		assert.strictEqual(toggle.when!.evaluate(context({})), false);
		// Rule 2 — new: CtrlCmd+K, when editorFocus || editcontextbarcursor.
		assert.strictEqual(create.weight, 1401);
		assert.strictEqual(create.primary, KeyMod.CtrlCmd | KeyCode.KeyK);
		assert.deepStrictEqual(create.args, { invocationType: 'new' });
		assert.strictEqual(create.when!.evaluate(context({ editorFocus: true })), true);
		assert.strictEqual(create.when!.evaluate(context({ editcontextbarcursor: true })), true);
		assert.strictEqual(create.when!.evaluate(context({})), false);
	});

	test('composer.addSelectionToInlinePrompt keeps its command but lost the Shift+K chord (binary reassignment)', () => {
		const action = new ComposerAddSelectionToInlinePromptAction();
		assert.strictEqual(ComposerAddSelectionToInlinePromptAction.ID, 'composer.addSelectionToInlinePrompt');
		assert.strictEqual(titleValue(action), 'Add Selection to Inline Prompt');
		assert.strictEqual(action.desc.f1, true, 'palette entry kept');
		assert.strictEqual(action.desc.keybinding, undefined, 'chord moved to aipopup.action.modal.generate (toggle, w1401)');
	});

	test('run(): no active editor / no model → silent no-op (binary guards)', async () => {
		const commands: RecordedCommand[] = [];
		const service = new FakePromptBarService();
		await new AipopupModalGenerateAction().run(accessorFor({ service, commands }));
		await new AipopupModalGenerateAction().run(accessorFor({ service, editor: makeEditor({ hasModel: false }), commands }));
		assert.deepStrictEqual(commands, []);
	});

	test('run(): bar on the active uri + empty selection → focusEdit(barId)', async () => {
		const commands: RecordedCommand[] = [];
		const service = new FakePromptBarService();
		service.bars = [{ id: 'bar-1', createdAt: 100, uri: 'file:///src/app.ts' }];
		await new AipopupModalGenerateAction().run(
			accessorFor({ service, editor: makeEditor(), commands }),
			{ invocationType: 'new' },
		);
		assert.deepStrictEqual(commands, [{ id: 'aipopup.action.focusEdit', args: ['bar-1'] }]);
	});

	test('run(): bar on the active uri + non-empty selection → insertEditSelection(barId), even for toggle', async () => {
		const commands: RecordedCommand[] = [];
		const service = new FakePromptBarService();
		service.bars = [{ id: 'bar-1', createdAt: 100, uri: 'file:///src/app.ts' }];
		await new AipopupModalGenerateAction().run(
			accessorFor({ service, editor: makeEditor({ selection: new Range(3, 5, 3, 15) }), commands }),
			{ invocationType: 'toggle' },
		);
		assert.deepStrictEqual(commands, [{ id: 'aipopup.action.insertEditSelection', args: ['bar-1'] }]);
	});

	test('run(): toggle + promptBarId with no same-uri bar → nextPromptBar(promptBarId)', async () => {
		const commands: RecordedCommand[] = [];
		const service = new FakePromptBarService();
		service.bars = [{ id: 'bar-b', createdAt: 100, uri: 'file:///src/other.ts' }];
		await new AipopupModalGenerateAction().run(
			accessorFor({ service, editor: makeEditor(), commands }),
			{ invocationType: 'toggle', promptBarId: 'bar-b' },
		);
		assert.deepStrictEqual(commands, [{ id: 'aipopup.action.nextPromptBar', args: ['bar-b'] }]);
	});

	test('run(): create path delegates to the core inline-edit service', async () => {
		const commands: RecordedCommand[] = [];
		const service = new FakePromptBarService();
		let openPromptCalls = 0;
		const core = { openPrompt: async () => { openPromptCalls++; } };
		await new AipopupModalGenerateAction().run(
			accessorFor({ service, editor: makeEditor(), commands, core }),
			{ invocationType: 'toggle' },
		);
		assert.strictEqual(openPromptCalls, 1);
		assert.deepStrictEqual(commands, [], 'no command delegation on the live path');
	});

	test('run(): create path without the core service falls back to ide.openInlinePrompt', async () => {
		const commands: RecordedCommand[] = [];
		const service = new FakePromptBarService();
		await new AipopupModalGenerateAction().run(
			accessorFor({ service, editor: makeEditor(), commands }),
			{ invocationType: 'new' },
		);
		assert.deepStrictEqual(commands, [{ id: 'ide.openInlinePrompt', args: [] }]);
	});
});
