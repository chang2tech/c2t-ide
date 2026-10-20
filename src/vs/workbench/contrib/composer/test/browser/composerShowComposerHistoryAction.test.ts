/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { Codicon } from '../../../../../base/common/codicons.js';
import { Emitter } from '../../../../../base/common/event.js';
import { KeyCode, KeyMod } from '../../../../../base/common/keyCodes.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { ICommandService } from '../../../../../platform/commands/common/commands.js';
import { INotificationService } from '../../../../../platform/notification/common/notification.js';
import { ServiceIdentifier, ServicesAccessor } from '../../../../../platform/instantiation/common/instantiation.js';
import { IEditorService } from '../../../../services/editor/common/editorService.js';
import type { IThemeService } from '../../../../../platform/theme/common/themeService.js';
import type { IWebviewService } from '../../../webview/browser/webview.js';
import { ComposerChatEditorInput } from '../../browser/composerEditorInput.js';
import { ComposerShowComposerHistoryAction, ComposerShowComposerHistoryEditorAction } from '../../browser/composerActions.js';

// DEV-GAPS-106B (`chat-history-command-palette`): Cursor 3.25.9 parity
// for `composer.showComposerHistory` + `composer.showComposerHistoryEditor`
// (workbench.desktop.main.js, re-extracted verbatim by DEV-GAPS-106B):
// - Constants (@14000834): EYs="Show Chat History",
//   IYs="Show Chat History (Editor)", xq="composer.showComposerHistory",
//   zkt="composer.showComposerHistoryEditor".
// - Pane (class Rgm @29919589): {id:xq, title:EYs, f1:!0,
//   icon:historyTwo, menu:{ViewTitle, group:"navigation", order:2,
//   when: composer pane view && unified sidebar hidden},
//   keybinding:{primary:CtrlCmd|Alt|Quote, weight:500}}; NO category.
//   Run: string arg -> `view` context key -> selectedComposerId ->
//   getComposerHandleById -> composerService.showComposerHistory; none ->
//   info "No active composer found. Start a new chat to view history."
// - Editor (class Mgm @29920334): {id:zkt, title:IYs, f1:!0,
//   icon:historyTwo} — NO keybinding/menu/category in the Action2 (the
//   EditorTitle entry is a separate appendMenuItem titled
//   "Show Chat History", group "navigation", order 2). Run: arg /
//   {path} arg -> active composer editor -> selectedComposerId ->
//   showComposerHistoryEditor; NO info fallback (silent).
// The fork resolves the selection in core (established mapping) and
// delegates to the ide-agent runtime (`ide.showComposerHistory` /
// `ide.showComposerHistoryEditor`), which owns the chat data and
// presents the history menu; the runtime returns false only when no
// composer exists at all, which is exactly the binary's info branch.

const fakeWebviewService = {
	createWebviewOverlay: () => ({
		dispose() { },
		claim() { },
		setTitle() { },
		onDidDispose: new Emitter<void>().event,
	}),
} as unknown as IWebviewService;

const fakeThemeService = {
	onDidColorThemeChange: () => ({ dispose() { } }),
} as unknown as IThemeService;

function accessorFor(stubs: Map<ServiceIdentifier<unknown>, unknown>): ServicesAccessor {
	return { get: <T>(id: ServiceIdentifier<T>): T => stubs.get(id) as T };
}

interface Harness {
	calls: Array<{ id: string; args: unknown[] }>;
	infos: string[];
	accessor: ServicesAccessor;
}

function harness(editorService: unknown, executeImpl?: (id: string, ...args: unknown[]) => Promise<unknown>): Harness {
	const calls: Array<{ id: string; args: unknown[] }> = [];
	const infos: string[] = [];
	const commandService = {
		executeCommand: async (id: string, ...args: unknown[]): Promise<unknown> => {
			calls.push({ id, args });
			return executeImpl ? executeImpl(id, ...args) : true;
		},
	} as unknown as ICommandService;
	const notificationService = {
		info: (message: string) => { infos.push(message); },
	} as unknown as INotificationService;
	const stubs = new Map<ServiceIdentifier<unknown>, unknown>([
		[ICommandService as ServiceIdentifier<unknown>, commandService],
		[INotificationService as ServiceIdentifier<unknown>, notificationService],
		[IEditorService as ServiceIdentifier<unknown>, editorService],
	]);
	return { calls, infos, accessor: accessorFor(stubs) };
}

interface KeybindingDescriptor {
	weight?: number;
	primary?: number;
	when?: unknown;
}

function keybindingOf(action: ComposerShowComposerHistoryAction): KeybindingDescriptor | undefined {
	const kb = (action.desc as { keybinding?: KeybindingDescriptor | KeybindingDescriptor[] }).keybinding;
	return Array.isArray(kb) ? kb[0] : kb;
}

suite('ComposerShowComposerHistoryAction (chat-history-command-palette, Cursor 3.25.9 parity)', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('pane descriptor matches the binary: id, title, f1:true, icon, no category', () => {
		const action = new ComposerShowComposerHistoryAction();
		assert.strictEqual(ComposerShowComposerHistoryAction.ID, 'composer.showComposerHistory');
		assert.strictEqual(action.desc.id, 'composer.showComposerHistory');
		assert.strictEqual(action.desc.title.value, 'Show Chat History');
		assert.strictEqual(action.desc.f1, true);
		assert.strictEqual(action.desc.category, undefined);
		assert.strictEqual(action.desc.icon, Codicon.history);
	});

	test('pane keybinding matches the binary: CtrlCmd+Alt+Quote at weight 500, no when', () => {
		const kb = keybindingOf(new ComposerShowComposerHistoryAction());
		assert.ok(kb, 'a keybinding is registered');
		assert.strictEqual(kb.primary, KeyMod.CtrlCmd | KeyMod.Alt | KeyCode.Quote);
		assert.strictEqual(kb.weight, 500);
		assert.strictEqual(kb.when, undefined);
	});

	test('pane run: string arg is the composer id verbatim', async () => {
		const h = harness({ activeEditor: undefined, editors: [] } as unknown as IEditorService);
		await new ComposerShowComposerHistoryAction().run(h.accessor, 'tab-9');
		assert.strictEqual(h.calls.length, 1);
		assert.strictEqual(h.calls[0]!.id, 'ide.showComposerHistory');
		assert.deepStrictEqual(h.calls[0]!.args, [{ composerId: 'tab-9' }]);
		assert.deepStrictEqual(h.infos, []);
	});

	test('pane run: active composer chat editor resolves the selected composer', async () => {
		const input = new ComposerChatEditorInput('tab-1', fakeWebviewService, fakeThemeService);
		try {
			const h = harness({ activeEditor: input, editors: [input] } as unknown as IEditorService);
			await new ComposerShowComposerHistoryAction().run(h.accessor);
			assert.deepStrictEqual(h.calls[0]!.args, [{ composerId: 'tab-1' }]);
			assert.deepStrictEqual(h.infos, []);
		} finally {
			input.dispose();
		}
	});

	test('pane run: nothing resolvable in core -> delegates undefined (runtime selected fallback), no info when found', async () => {
		const h = harness({ activeEditor: undefined, editors: [] } as unknown as IEditorService);
		await new ComposerShowComposerHistoryAction().run(h.accessor);
		assert.strictEqual(h.calls.length, 1);
		assert.deepStrictEqual(h.calls[0]!.args, [{ composerId: undefined }]);
		assert.deepStrictEqual(h.infos, []);
	});

	test('pane run: runtime reports no composer -> verbatim info', async () => {
		const h = harness(
			{ activeEditor: undefined, editors: [] } as unknown as IEditorService,
			async () => false,
		);
		await new ComposerShowComposerHistoryAction().run(h.accessor);
		assert.deepStrictEqual(h.infos, ['No active composer found. Start a new chat to view history.']);
	});
});

suite('ComposerShowComposerHistoryEditorAction (chat-history-command-palette, Cursor 3.25.9 parity)', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('editor descriptor matches the binary: id, "(Editor)" title, f1:true, icon, no keybinding/category', () => {
		const action = new ComposerShowComposerHistoryEditorAction();
		assert.strictEqual(ComposerShowComposerHistoryEditorAction.ID, 'composer.showComposerHistoryEditor');
		assert.strictEqual(action.desc.id, 'composer.showComposerHistoryEditor');
		assert.strictEqual(action.desc.title.value, 'Show Chat History (Editor)');
		assert.strictEqual(action.desc.f1, true);
		assert.strictEqual(action.desc.category, undefined);
		assert.strictEqual(action.desc.icon, Codicon.history);
		assert.strictEqual(action.desc.keybinding, undefined);
	});

	test('editor run: {path} arg wins over the active editor (binary order)', async () => {
		const input = new ComposerChatEditorInput('tab-1', fakeWebviewService, fakeThemeService);
		try {
			const h = harness({ activeEditor: input, editors: [input] } as unknown as IEditorService);
			await new ComposerShowComposerHistoryEditorAction().run(h.accessor, { path: '/tab-7' });
			assert.strictEqual(h.calls.length, 1);
			assert.strictEqual(h.calls[0]!.id, 'ide.showComposerHistoryEditor');
			assert.deepStrictEqual(h.calls[0]!.args, [{ composerId: 'tab-7' }]);
		} finally {
			input.dispose();
		}
	});

	test('editor run: untranslatable {path} -> silent no-op (binary handle-miss branch)', async () => {
		const h = harness({ activeEditor: undefined, editors: [] } as unknown as IEditorService);
		await new ComposerShowComposerHistoryEditorAction().run(h.accessor, { path: '/../../etc' });
		assert.strictEqual(h.calls.length, 0);
		assert.deepStrictEqual(h.infos, []);
	});

	test('editor run: active composer editor -> its id; no info even when runtime reports none', async () => {
		const input = new ComposerChatEditorInput('tab-3', fakeWebviewService, fakeThemeService);
		try {
			const h = harness(
				{ activeEditor: input, editors: [input] } as unknown as IEditorService,
				async () => false,
			);
			await new ComposerShowComposerHistoryEditorAction().run(h.accessor);
			assert.deepStrictEqual(h.calls[0]!.args, [{ composerId: 'tab-3' }]);
			// The binary editor variant has NO info fallback.
			assert.deepStrictEqual(h.infos, []);
		} finally {
			input.dispose();
		}
	});
});
