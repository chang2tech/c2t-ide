/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { ServiceIdentifier, ServicesAccessor } from '../../../../../platform/instantiation/common/instantiation.js';
import { IEditorService } from '../../../../services/editor/common/editorService.js';
import { INotificationService } from '../../../../../platform/notification/common/notification.js';
import { ICommandService } from '../../../../../platform/commands/common/commands.js';
import { ComposerChatEditorInput } from '../../browser/composerEditorInput.js';
import { ComposerResumeCurrentChatAction } from '../../browser/composerActions.js';

// DEV-GAPS-56 (`agent-resume-chat`): Cursor 3.25.9 parity for
// `composer.resumeCurrentChat` (workbench.glass.main.js @39846912, class CAb,
// REA spec `rea-spec-accept-resume-2026-10-20.md`):
// - descriptor: id `composer.resumeCurrentChat`, title "Resume Current Chat",
//   NO f1, NO keybinding, NO precondition, NO menu, NO category. Ht (@2274492)
//   gates palette registration on truthy f1, so the command is PALETTE-HIDDEN
//   (the run-34 audit's `f1:!0` claim is BÁC BỎ by binary evidence). The fork
//   mirrors this with explicit f1:false (its registerAction2 gates the
//   CommandPalette entry on truthy f1 too).
// - run (binary): selectedComposerId falsy -> SILENT return (no warning);
//   handle not loaded -> warn "Cannot resume: composer not loaded";
//   else chatService.resumeChat(handle, { isAutoResume: args?.isAutoResume === true });
//   catch -> warn(err.message) / "Cannot resume".
// - fork mapping: selection/loaded-handle = the active OPEN composer chat
//   editor (resolveRenameChatTabId / findOpenComposerChatInput); the
//   resumeChat runtime is the ide-agent extension's `ide.resumeCurrentChat`
//   (ComposerDataService.resumeChat throws verbatim "Cannot resume: chat not
//   found" — surfaced through the core catch, exactly like the binary).

/** Fake composer editor input without a real webview (no disposables). */
function fakeChatInput(tabId: string): ComposerChatEditorInput {
	const input = Object.create(ComposerChatEditorInput.prototype) as ComposerChatEditorInput;
	(input as unknown as Record<string, unknown>)['tabId'] = tabId;
	return input;
}

function stubEditorService(activeEditor: unknown, editors: unknown[]) {
	return { activeEditor, editors } as unknown as IEditorService;
}

function stubNotificationService() {
	const warnings: string[] = [];
	const service = {
		warn: (message: string) => { warnings.push(message); },
	} as unknown as INotificationService;
	return { warnings, service };
}

interface StubCommandService {
	calls: Array<{ id: string; args: unknown[] }>;
	throwNext: unknown;
	service: ICommandService;
}

function stubCommandService(): StubCommandService {
	const calls: Array<{ id: string; args: unknown[] }> = [];
	const state = { throwNext: undefined as unknown };
	const service = {
		executeCommand: async (id: string, ...args: unknown[]): Promise<unknown> => {
			calls.push({ id, args });
			if (state.throwNext !== undefined) {
				const err = state.throwNext;
				state.throwNext = undefined;
				throw err;
			}
			return undefined;
		},
	} as unknown as ICommandService;
	return {
		calls,
		get throwNext() { return state.throwNext; },
		set throwNext(v: unknown) { state.throwNext = v; },
		service,
	};
}

function accessorFor(stubs: Map<ServiceIdentifier<unknown>, unknown>): ServicesAccessor {
	return { get: <T>(id: ServiceIdentifier<T>): T => stubs.get(id) as T };
}

function runStubs(opts: {
	activeTabId?: string;
	/** Open chat editors (defaults to the active one when activeTabId is set). */
	openTabIds?: string[];
	command?: StubCommandService;
}) {
	const open = (opts.openTabIds ?? (opts.activeTabId ? [opts.activeTabId] : []))
		.map(id => fakeChatInput(id));
	const activeEditor = opts.activeTabId
		? (open.find(i => i.tabId === opts.activeTabId) ?? fakeChatInput(opts.activeTabId))
		: undefined;
	const editorService = stubEditorService(activeEditor, open);
	const notificationService = stubNotificationService();
	const commandService = opts.command ?? stubCommandService();
	const stubs = new Map<ServiceIdentifier<unknown>, unknown>([
		[IEditorService as ServiceIdentifier<unknown>, editorService],
		[INotificationService as ServiceIdentifier<unknown>, notificationService.service],
		[ICommandService as ServiceIdentifier<unknown>, commandService.service],
	]);
	return { editorService, notificationService, commandService, accessor: accessorFor(stubs) };
}

suite('ComposerResumeCurrentChatAction (agent-resume-chat, Cursor 3.25.9 parity)', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('descriptor matches the binary: id, title, palette-HIDDEN (f1:false), no keybinding/menu/category', () => {
		const action = new ComposerResumeCurrentChatAction();
		assert.strictEqual(ComposerResumeCurrentChatAction.ID, 'composer.resumeCurrentChat');
		assert.strictEqual(action.desc.id, 'composer.resumeCurrentChat');
		assert.strictEqual(action.desc.title.value, 'Resume Current Chat');
		// Binary class CAb passes {id,title} ONLY — no f1, so Ht's truthy-f1
		// gate keeps it out of the palette. The fork says it explicitly.
		assert.strictEqual(action.desc.f1, false);
		assert.strictEqual((action.desc as { keybinding?: unknown }).keybinding, undefined);
		assert.strictEqual((action.desc as { category?: unknown }).category, undefined);
		assert.strictEqual((action.desc as { menu?: unknown }).menu, undefined);
	});

	test('run: no selected composer -> SILENT return (no warning, no runtime call)', async () => {
		const s = runStubs({}); // no active editor at all
		const action = new ComposerResumeCurrentChatAction();
		await action.run(s.accessor);

		assert.deepStrictEqual(s.notificationService.warnings, []);
		assert.strictEqual(s.commandService.calls.length, 0);
	});

	test('run: active editor is not a chat editor -> SILENT return', async () => {
		const editorService = stubEditorService({ label: 'some.ts' }, []);
		const notificationService = stubNotificationService();
		const commandService = stubCommandService();
		const stubs = new Map<ServiceIdentifier<unknown>, unknown>([
			[IEditorService as ServiceIdentifier<unknown>, editorService],
			[INotificationService as ServiceIdentifier<unknown>, notificationService.service],
			[ICommandService as ServiceIdentifier<unknown>, commandService.service],
		]);
		const action = new ComposerResumeCurrentChatAction();
		await action.run(accessorFor(stubs));

		assert.deepStrictEqual(notificationService.warnings, []);
		assert.strictEqual(commandService.calls.length, 0);
	});

	test('run: selected composer not loaded -> warn "Cannot resume: composer not loaded"', async () => {
		// Active chat editor, but its input is not in the open editors list
		// (getHandleIfLoaded miss).
		const s = runStubs({ activeTabId: 'tab-1', openTabIds: [] });
		const action = new ComposerResumeCurrentChatAction();
		await action.run(s.accessor);

		assert.deepStrictEqual(s.notificationService.warnings, ['Cannot resume: composer not loaded']);
		assert.strictEqual(s.commandService.calls.length, 0);
	});

	test('run: delegates to the extension runtime with isAutoResume coercion', async () => {
		const action = new ComposerResumeCurrentChatAction();

		// No args -> isAutoResume:false.
		let s = runStubs({ activeTabId: 'tab-1' });
		await action.run(s.accessor);
		assert.strictEqual(s.commandService.calls.length, 1);
		assert.strictEqual(s.commandService.calls[0]!.id, 'ide.resumeCurrentChat');
		assert.deepStrictEqual(s.commandService.calls[0]!.args, [{ isAutoResume: false }]);
		assert.deepStrictEqual(s.notificationService.warnings, []);

		// args?.isAutoResume === true passes through verbatim.
		s = runStubs({ activeTabId: 'tab-1' });
		await action.run(s.accessor, { isAutoResume: true });
		assert.deepStrictEqual(s.commandService.calls[0]!.args, [{ isAutoResume: true }]);

		// Truthy-but-not-true values coerce to false (binary === true check).
		for (const truthy of [1, 'yes', {}]) {
			s = runStubs({ activeTabId: 'tab-1' });
			await action.run(s.accessor, { isAutoResume: truthy });
			assert.deepStrictEqual(s.commandService.calls[0]!.args, [{ isAutoResume: false }], `arg=${String(truthy)}`);
		}
	});

	test('run: runtime Error -> warn(err.message) (e.g. "Cannot resume: chat not found")', async () => {
		const command = stubCommandService();
		command.throwNext = new Error('Cannot resume: chat not found');
		const s = runStubs({ activeTabId: 'tab-1', command });
		const action = new ComposerResumeCurrentChatAction();
		await action.run(s.accessor);

		assert.deepStrictEqual(s.notificationService.warnings, ['Cannot resume: chat not found']);
		assert.strictEqual(s.commandService.calls.length, 1);
	});

	test('run: non-Error runtime throw -> warn "Cannot resume"', async () => {
		const command = stubCommandService();
		command.throwNext = 'boom';
		const s = runStubs({ activeTabId: 'tab-1', command });
		const action = new ComposerResumeCurrentChatAction();
		await action.run(s.accessor);

		assert.deepStrictEqual(s.notificationService.warnings, ['Cannot resume']);
	});
});
