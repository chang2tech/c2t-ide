/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { Emitter } from '../../../../../base/common/event.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { KeyCode, KeyMod } from '../../../../../base/common/keyCodes.js';
import type { ContextKeyExpression } from '../../../../../platform/contextkey/common/contextkey.js';
import { ICommandService } from '../../../../../platform/commands/common/commands.js';
import { ServiceIdentifier, ServicesAccessor } from '../../../../../platform/instantiation/common/instantiation.js';
import { IEditorService } from '../../../../services/editor/common/editorService.js';
import type { IThemeService } from '../../../../../platform/theme/common/themeService.js';
import type { IWebviewService } from '../../../webview/browser/webview.js';
import { ComposerChatEditorInput } from '../../browser/composerEditorInput.js';
import { CursorOpenBranchMenuAction } from '../../browser/composerActions.js';

// W69C (`changes-tab-base-branch-menu`): Cursor 3.25.9 parity for
// `cursor.openBranchMenu` (workbench.glass.main.js, id
// ZXl="cursor.openBranchMenu" @27418487, class JXl @27418510, re-verified
// verbatim by W69C):
// - descriptor: id `cursor.openBranchMenu`, title "Open Branch Menu",
//   f1:!0 (palette-visible), NO category, NO menu, NO precondition.
// - keybinding: CtrlCmd+Quote at weight 600, when
//   `ft.has("composerFocused")` — the fork ports composerFocused as its
//   established `chatSurface` expression (focusedView == 'composer.chat'
//   OR resourceScheme == 'ide-chat'). The audit queue's run-34 entry
//   omitted this keybinding; the binary registration carries it verbatim.
// - run: raw selectedComposerId -> getComposerDataIfLoaded ->
//   composerService.isComposerConversationEmpty ->
//   composerEventService.fireDidRequestOpenBranchMenu({composerId});
//   EVERY guard failure is a silent no-op (no warning, unlike
//   composer.resumeCurrentChat). The fork resolves the selection/loaded
//   guards in core (active/open chat editor) and delegates the
//   conversation-empty guard + the event fire to the extension runtime
//   `ide.openBranchMenu`.

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

interface KeybindingDescriptor {
	weight?: number;
	primary?: number;
	when?: ContextKeyExpression;
}

function keybindingOf(action: CursorOpenBranchMenuAction): KeybindingDescriptor | undefined {
	const kb = (action.desc as { keybinding?: KeybindingDescriptor | KeybindingDescriptor[] }).keybinding;
	return Array.isArray(kb) ? kb[0] : kb;
}

/** Minimal IContext for evaluating when-clauses: key -> value. */
function contextWith(values: Record<string, unknown>) {
	return {
		getValue: (key: string) => (key in values ? values[key] : undefined),
	};
}

function accessorFor(stubs: Map<ServiceIdentifier<unknown>, unknown>): ServicesAccessor {
	return { get: <T>(id: ServiceIdentifier<T>): T => stubs.get(id) as T };
}

suite('CursorOpenBranchMenuAction (changes-tab-base-branch-menu, Cursor 3.25.9 parity)', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('descriptor matches the binary: id, title, f1:true, no category', () => {
		const action = new CursorOpenBranchMenuAction();
		assert.strictEqual(CursorOpenBranchMenuAction.ID, 'cursor.openBranchMenu');
		assert.strictEqual(action.desc.id, 'cursor.openBranchMenu');
		assert.strictEqual(action.desc.title.value, 'Open Branch Menu');
		assert.strictEqual(action.desc.f1, true);
		// Binary registers NO category (class JXl descriptor has none).
		assert.strictEqual(action.desc.category, undefined);
	});

	test('keybinding matches the binary: CtrlCmd+Quote at weight 600 on the chat surface', () => {
		const action = new CursorOpenBranchMenuAction();
		const kb = keybindingOf(action);
		assert.ok(kb, 'a keybinding is registered');
		assert.strictEqual(kb.primary, KeyMod.CtrlCmd | KeyCode.Quote);
		assert.strictEqual(kb.weight, 600);
		assert.ok(kb.when, 'keybinding has a when-clause');
		// chatSurface port of the binary's `composerFocused`: sidebar view
		// OR chat editor tab; nowhere else.
		assert.strictEqual(kb.when.evaluate(contextWith({ focusedView: 'composer.chat' })), true);
		assert.strictEqual(kb.when.evaluate(contextWith({ focusedView: 'workbench.editors', resourceScheme: 'ide-chat' })), true);
		assert.strictEqual(kb.when.evaluate(contextWith({ focusedView: 'terminal', resourceScheme: 'file' })), false);
		const serialized = kb.when.serialize();
		assert.ok(!serialized.includes('composerFocused'), `when must not reference the fork-unwritten composerFocused: ${serialized}`);
	});

	test('run: no selected composer -> silent no-op (no delegation, no throw)', async () => {
		const calls: Array<{ id: string; args: unknown[] }> = [];
		const commandService = {
			executeCommand: async (id: string, ...args: unknown[]): Promise<unknown> => {
				calls.push({ id, args });
				return undefined;
			},
		} as unknown as ICommandService;
		const editorService = {
			activeEditor: undefined,
			editors: [],
		} as unknown as IEditorService;
		const stubs = new Map<ServiceIdentifier<unknown>, unknown>([
			[ICommandService as ServiceIdentifier<unknown>, commandService],
			[IEditorService as ServiceIdentifier<unknown>, editorService],
		]);
		await new CursorOpenBranchMenuAction().run(accessorFor(stubs));
		assert.strictEqual(calls.length, 0);
	});

	test('run: selected composer not loaded (no open editor) -> silent no-op', async () => {
		const calls: Array<{ id: string; args: unknown[] }> = [];
		const commandService = {
			executeCommand: async (id: string, ...args: unknown[]): Promise<unknown> => {
				calls.push({ id, args });
				return undefined;
			},
		} as unknown as ICommandService;
		// Active editor is a chat input, but the open-editors list does not
		// contain it: getComposerDataIfLoaded(s) fails in binary terms.
		const input = new ComposerChatEditorInput('tab-1', fakeWebviewService, fakeThemeService);
		try {
			const editorService = {
				activeEditor: input,
				editors: [],
			} as unknown as IEditorService;
			const stubs = new Map<ServiceIdentifier<unknown>, unknown>([
				[ICommandService as ServiceIdentifier<unknown>, commandService],
				[IEditorService as ServiceIdentifier<unknown>, editorService],
			]);
			await new CursorOpenBranchMenuAction().run(accessorFor(stubs));
			assert.strictEqual(calls.length, 0);
		} finally {
			input.dispose();
		}
	});

	test('run: loaded selected composer -> delegates {composerId} to ide.openBranchMenu', async () => {
		const calls: Array<{ id: string; args: unknown[] }> = [];
		const commandService = {
			executeCommand: async (id: string, ...args: unknown[]): Promise<unknown> => {
				calls.push({ id, args });
				return undefined;
			},
		} as unknown as ICommandService;
		const input = new ComposerChatEditorInput('tab-1', fakeWebviewService, fakeThemeService);
		try {
			const editorService = {
				activeEditor: input,
				editors: [input],
			} as unknown as IEditorService;
			const stubs = new Map<ServiceIdentifier<unknown>, unknown>([
				[ICommandService as ServiceIdentifier<unknown>, commandService],
				[IEditorService as ServiceIdentifier<unknown>, editorService],
			]);
			await new CursorOpenBranchMenuAction().run(accessorFor(stubs));
			assert.strictEqual(calls.length, 1);
			assert.strictEqual(calls[0]!.id, 'ide.openBranchMenu');
			assert.deepStrictEqual(calls[0]!.args, [{ composerId: 'tab-1' }]);
		} finally {
			input.dispose();
		}
	});
});
