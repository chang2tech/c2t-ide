/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { ServiceIdentifier, ServicesAccessor } from '../../../../../platform/instantiation/common/instantiation.js';
import { IEditorService } from '../../../../services/editor/common/editorService.js';
import { IQuickInputService, IInputOptions } from '../../../../../platform/quickinput/common/quickInput.js';
import { ILogService } from '../../../../../platform/log/common/log.js';
import { ComposerChatEditorInput } from '../../browser/composerEditorInput.js';
import {
	ComposerRenameChatAction,
	findOpenComposerChatInput,
	resolveRenameChatTabId,
} from '../../browser/composerActions.js';

// WORKER-GAPS-32D (`agent-chat-rename`): Cursor 3.25.6 + 3.25.9 parity for
// `composer.renameChat` (workbench.glass.main.js, static literal extraction,
// verified verbatim in both versions):
// - descriptor: id `composer.renameChat`, title "Rename Chat", f1:false
//   (Cursor: `category: Cursor`, not in the palette).
// - id resolution (Cursor's `MiI`): string arg -> verbatim; `composer`-scheme
//   URI arg -> its path verbatim (no path validation; a foreign scheme falls
//   through to the active editor). Warn "No chat tab selected to rename."
//   when nothing resolves.
// - prompt: quick input `{prompt:"Enter new chat name",
//   placeHolder:"Chat name", value:currentName, ignoreFocusLost:true}`,
//   trimmed; no-op when empty or unchanged.
// - apply: rename the composer (fork: `ComposerChatEditorInput.setTitle()`).

/** Fake composer editor input without a real webview (no disposables). */
function fakeChatInput(tabId: string, title: string): ComposerChatEditorInput {
	const input = Object.create(ComposerChatEditorInput.prototype) as ComposerChatEditorInput;
	(input as unknown as Record<string, unknown>)['tabId'] = tabId;
	(input as unknown as Record<string, unknown>)['_title'] = title;
	(input as unknown as Record<string, unknown>)['_webview'] = { setTitle(_t: string) { /* captured via getName */ } };
	(input as unknown as Record<string, unknown>)['_onDidChangeLabel'] = { fire() { /* no-op */ } };
	return input;
}

interface StubQuickInput {
	calls: IInputOptions[];
	scripted: string | undefined;
	service: IQuickInputService;
}

function stubQuickInput(scripted: string | undefined): StubQuickInput {
	const calls: IInputOptions[] = [];
	const service = {
		input: async (options?: IInputOptions): Promise<string | undefined> => {
			calls.push(options ?? {});
			return scripted;
		},
	} as unknown as IQuickInputService;
	return { calls, scripted, service };
}

function stubLogService() {
	const warnings: string[] = [];
	const service = {
		warn: (message: string) => { warnings.push(message); },
	} as unknown as ILogService;
	return { warnings, service };
}

function stubEditorService(activeEditor: unknown, editors: unknown[]) {
	return { activeEditor, editors } as unknown as IEditorService;
}

function accessorFor(stubs: Map<ServiceIdentifier<unknown>, unknown>): ServicesAccessor {
	return { get: <T>(id: ServiceIdentifier<T>): T => stubs.get(id) as T };
}

function runStubs(opts: {
	tabId?: string;
	activeTitle?: string;
	openTitles?: Array<[string, string]>;
	quickInputValue: string | undefined;
}) {
	const inputs = (opts.openTitles ?? [[opts.tabId ?? 'tab-1', opts.activeTitle ?? 'Old name']])
		.map(([id, title]) => fakeChatInput(id, title));
	const activeEditor = opts.tabId === undefined && !opts.openTitles ? undefined
		: (inputs.find(i => i.tabId === (opts.tabId ?? 'tab-1')) ?? inputs[0]);
	const editorService = stubEditorService(activeEditor, inputs);
	const quickInput = stubQuickInput(opts.quickInputValue);
	const log = stubLogService();
	const stubs = new Map<ServiceIdentifier<unknown>, unknown>([
		[IEditorService as ServiceIdentifier<unknown>, editorService],
		[IQuickInputService as ServiceIdentifier<unknown>, quickInput.service],
		[ILogService as ServiceIdentifier<unknown>, log.service],
	]);
	return { inputs, editorService, quickInput, log, accessor: accessorFor(stubs) };
}

suite('ComposerRenameChatAction (agent-chat-rename, Cursor 3.25.6/3.25.9 parity)', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('descriptor matches the binary: id, title, f1:false', () => {
		const action = new ComposerRenameChatAction();
		assert.strictEqual(ComposerRenameChatAction.ID, 'composer.renameChat');
		assert.strictEqual(action.desc.id, 'composer.renameChat');
		assert.strictEqual(action.desc.title.value, 'Rename Chat');
		assert.strictEqual(action.desc.f1, false);
	});

	test('resolveRenameChatTabId: string arg wins verbatim', () => {
		const editors = stubEditorService(undefined, []);
		assert.strictEqual(resolveRenameChatTabId(editors, 'tab-42'), 'tab-42');
	});

	test('resolveRenameChatTabId: ide-chat URI arg yields the tab id', () => {
		const editors = stubEditorService(undefined, []);
		const uri = URI.from({ scheme: 'ide-chat', path: '/tab-7' });
		assert.strictEqual(resolveRenameChatTabId(editors, uri), 'tab-7');
	});

	test('resolveRenameChatTabId: ide-chat URI with untranslatable path returns the path verbatim (binary `return t.path`)', () => {
		// Binary 3.25.6 (`ONS` @~29911960) / 3.25.9 (`i2S` @~29918155):
		// `if (isUri(t) && t.scheme === composerScheme) return t.path;` — NO
		// path validation. The fork once fell through to the active editor
		// here, renaming the wrong tab.
		const input = fakeChatInput('tab-9', 'Active');
		const editors = stubEditorService(input, [input]);
		assert.strictEqual(resolveRenameChatTabId(editors, URI.from({ scheme: 'ide-chat', path: '/../..' })), '/../..');
		assert.strictEqual(resolveRenameChatTabId(editors, URI.from({ scheme: 'ide-chat', path: '/.' })), '/.');
		// An empty path is falsy like the binary's `t.path`, so `run` warns.
		assert.strictEqual(resolveRenameChatTabId(editors, URI.from({ scheme: 'ide-chat' })), '');
	});

	test('resolveRenameChatTabId: foreign URI falls through to the active chat editor', () => {
		const input = fakeChatInput('tab-3', 'Active');
		const editors = stubEditorService(input, [input]);
		const foreign = URI.from({ scheme: 'file', path: '/x/y.ts' });
		assert.strictEqual(resolveRenameChatTabId(editors, foreign), 'tab-3');
	});

	test('resolveRenameChatTabId: active composer editor without args', () => {
		const input = fakeChatInput('tab-5', 'Active');
		const editors = stubEditorService(input, [input]);
		assert.strictEqual(resolveRenameChatTabId(editors, undefined), 'tab-5');
	});

	test('resolveRenameChatTabId: empty string resolves verbatim (binary: no length check)', () => {
		const editors = stubEditorService(undefined, []);
		assert.strictEqual(resolveRenameChatTabId(editors, undefined), undefined);
		// Cursor 3.25.6/3.25.9 return the string arg verbatim — `run` then hits
		// `if (!tabId)` and warns, instead of falling through to the active tab.
		assert.strictEqual(resolveRenameChatTabId(editors, ''), '');
	});

	test('findOpenComposerChatInput: finds by tab id, skips foreign editors', () => {
		const a = fakeChatInput('tab-1', 'A');
		const b = fakeChatInput('tab-2', 'B');
		const editors = stubEditorService(a, [a, { label: 'not a chat input' }, b]);
		assert.strictEqual(findOpenComposerChatInput(editors, 'tab-2'), b);
		assert.strictEqual(findOpenComposerChatInput(editors, 'tab-9'), undefined);
	});

	test('run: prompts with the binary-verbatim options and renames (trimmed)', async () => {
		const s = runStubs({ tabId: 'tab-1', activeTitle: 'Old name', quickInputValue: '  New name  ' });
		const action = new ComposerRenameChatAction();
		await action.run(s.accessor, 'tab-1');

		assert.strictEqual(s.quickInput.calls.length, 1);
		const opts = s.quickInput.calls[0]!;
		assert.strictEqual(opts.prompt, 'Enter new chat name');
		assert.strictEqual(opts.placeHolder, 'Chat name');
		assert.strictEqual(opts.value, 'Old name');
		assert.strictEqual(opts.ignoreFocusLost, true);

		assert.strictEqual(s.inputs[0]!.getName(), 'New name');
		assert.strictEqual(s.log.warnings.length, 0);
	});

	test('run: targets the tab named by an ide-chat URI arg (not the active one)', async () => {
		const s = runStubs({
			openTitles: [['tab-1', 'First'], ['tab-2', 'Second']],
			quickInputValue: 'Renamed second',
		});
		const action = new ComposerRenameChatAction();
		await action.run(s.accessor, URI.from({ scheme: 'ide-chat', path: '/tab-2' }));

		assert.strictEqual(s.inputs[0]!.getName(), 'First');
		assert.strictEqual(s.inputs[1]!.getName(), 'Renamed second');
	});

	test('run: ide-chat URI with bad path prompts (no warn) but renames nothing (binary-verbatim)', async () => {
		// Binary: `t.path` ('/../..') is truthy, so the flow proceeds to the
		// prompt instead of warning; no composer matches it, so nothing renames
		// (and crucially the ACTIVE tab is not renamed — the pre-fix fall-through).
		const s = runStubs({ tabId: 'tab-1', activeTitle: 'Keep me', quickInputValue: 'Some name' });
		const action = new ComposerRenameChatAction();
		await action.run(s.accessor, URI.from({ scheme: 'ide-chat', path: '/../..' }));

		assert.strictEqual(s.log.warnings.length, 0);
		assert.strictEqual(s.quickInput.calls.length, 1);
		assert.strictEqual(s.quickInput.calls[0]!.value, '');
		assert.strictEqual(s.inputs[0]!.getName(), 'Keep me');
	});

	test('run: ide-chat URI with empty path warns like an empty string arg', async () => {
		const s = runStubs({ tabId: 'tab-1', activeTitle: 'Keep me', quickInputValue: 'Renamed by accident' });
		const action = new ComposerRenameChatAction();
		await action.run(s.accessor, URI.from({ scheme: 'ide-chat' }));

		assert.deepStrictEqual(s.log.warnings, ['No chat tab selected to rename.']);
		assert.strictEqual(s.quickInput.calls.length, 0);
		assert.strictEqual(s.inputs[0]!.getName(), 'Keep me');
	});

	test('run: no-op when the name is unchanged', async () => {
		const s = runStubs({ tabId: 'tab-1', activeTitle: 'Same', quickInputValue: 'Same' });
		const action = new ComposerRenameChatAction();
		await action.run(s.accessor, 'tab-1');
		assert.strictEqual(s.inputs[0]!.getName(), 'Same');
		assert.strictEqual(s.quickInput.calls.length, 1);
	});

	test('run: no-op on empty input and on cancel', async () => {
		for (const scripted of ['', '   ', undefined]) {
			const s = runStubs({ tabId: 'tab-1', activeTitle: 'Keep', quickInputValue: scripted });
			const action = new ComposerRenameChatAction();
			await action.run(s.accessor, 'tab-1');
			assert.strictEqual(s.inputs[0]!.getName(), 'Keep', `scripted=${String(scripted)}`);
		}
	});

	test('run: warns (binary-verbatim) and never prompts when no tab resolves', async () => {
		const quickInput = stubQuickInput('Whatever');
		const log = stubLogService();
		const editorService = stubEditorService(undefined, []);
		const stubs = new Map<ServiceIdentifier<unknown>, unknown>([
			[IEditorService as ServiceIdentifier<unknown>, editorService],
			[IQuickInputService as ServiceIdentifier<unknown>, quickInput.service],
			[ILogService as ServiceIdentifier<unknown>, log.service],
		]);
		const action = new ComposerRenameChatAction();
		await action.run(accessorFor(stubs));

		assert.deepStrictEqual(log.warnings, ['No chat tab selected to rename.']);
		assert.strictEqual(quickInput.calls.length, 0);
	});

	test('run: empty-string arg warns instead of renaming the active tab (binary-verbatim)', async () => {
		// Regression: the fork once treated '' like "no arg" and fell through to
		// the active editor, renaming the wrong tab. The binary returns '' verbatim,
		// so `!tabId` warns and returns without prompting.
		const s = runStubs({ tabId: 'tab-1', activeTitle: 'Keep me', quickInputValue: 'Renamed by accident' });
		const action = new ComposerRenameChatAction();
		await action.run(s.accessor, '');

		assert.deepStrictEqual(s.log.warnings, ['No chat tab selected to rename.']);
		assert.strictEqual(s.quickInput.calls.length, 0);
		assert.strictEqual(s.inputs[0]!.getName(), 'Keep me');
	});
});
