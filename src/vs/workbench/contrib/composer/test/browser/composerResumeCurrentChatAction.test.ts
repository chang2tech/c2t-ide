/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { Emitter } from '../../../../../base/common/event.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { ICommandService } from '../../../../../platform/commands/common/commands.js';
import { INotificationService } from '../../../../../platform/notification/common/notification.js';
import { ServiceIdentifier, ServicesAccessor } from '../../../../../platform/instantiation/common/instantiation.js';
import { IEditorService } from '../../../../services/editor/common/editorService.js';
import type { IThemeService } from '../../../../../platform/theme/common/themeService.js';
import type { IWebviewService } from '../../../webview/browser/webview.js';
import { ComposerChatEditorInput } from '../../browser/composerEditorInput.js';
import { ComposerResumeCurrentChatAction } from '../../browser/composerActions.js';

// DEV-GAPS-56 (`agent-resume-chat`): Cursor 3.25.9 parity for
// `composer.resumeCurrentChat` (workbench.glass.main.js, class CAb
// @39846912, verified verbatim):
// - descriptor: id `composer.resumeCurrentChat`, title "Resume Current
//   Chat", and — unlike its neighbours — NO f1 field, NO category and NO
//   keybinding in the binary registration. The registration helper Ht
//   (@2274492) gates palette registration on truthy f1, so the command is
//   palette-HIDDEN; the fork mirrors this with an explicit f1:false (its
//   registerAction2 gates the palette entry the same way).
// - run: the RAW selectedComposerId -> getHandleIfLoaded (missing handle
//   -> notification warn "Cannot resume: composer not loaded") ->
//   chatService.resumeChat(handle, { isAutoResume: e?.isAutoResume ===
//   true }), failures caught and warned (err.message or "Cannot
//   resume"); NO selection returns SILENTLY. The fork resolves the
//   selection/loaded guards in core (active/open chat editor) and
//   delegates the resume itself to the extension runtime
//   `ide.resumeCurrentChat`.
//
// W69C (2026-10-20): this file previously described an earlier, simpler
// delegation-only implementation (f1 undefined, no editor guards) and no
// longer matched the shipped action; rewritten against the current
// core-guard port while closing the queue entry.
//
// W75B-R (2026-10-20): dedupe — the legacy duplicate
// composerResumeChatAction.test.ts (same suite name) was removed after
// porting its unique coverage here: active-editor-not-a-chat-editor silent
// return, non-Error runtime throw -> warn "Cannot resume", the descriptor
// `menu` assertion, and the no-args / extra-truthy isAutoResume coercions.

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
	warnings: string[];
	accessor: ServicesAccessor;
}

function harness(editorService: unknown, executeImpl?: (id: string, ...args: unknown[]) => Promise<unknown>): Harness {
	const calls: Array<{ id: string; args: unknown[] }> = [];
	const warnings: string[] = [];
	const commandService = {
		executeCommand: async (id: string, ...args: unknown[]): Promise<unknown> => {
			calls.push({ id, args });
			return executeImpl ? executeImpl(id, ...args) : undefined;
		},
	} as unknown as ICommandService;
	const notificationService = {
		warn: (message: string) => { warnings.push(message); },
	} as unknown as INotificationService;
	const stubs = new Map<ServiceIdentifier<unknown>, unknown>([
		[ICommandService as ServiceIdentifier<unknown>, commandService],
		[INotificationService as ServiceIdentifier<unknown>, notificationService],
		[IEditorService as ServiceIdentifier<unknown>, editorService],
	]);
	return { calls, warnings, accessor: accessorFor(stubs) };
}

suite('ComposerResumeCurrentChatAction (agent-resume-chat, Cursor 3.25.9 parity)', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('descriptor matches the binary: id, title, palette-hidden, no category/keybinding', () => {
		const action = new ComposerResumeCurrentChatAction();
		assert.strictEqual(ComposerResumeCurrentChatAction.ID, 'composer.resumeCurrentChat');
		assert.strictEqual(action.desc.id, 'composer.resumeCurrentChat');
		assert.strictEqual(action.desc.title.value, 'Resume Current Chat');
		// Binary omits f1 entirely (palette-hidden via Ht gating); the fork
		// spells the same outcome as an explicit f1:false.
		assert.strictEqual(action.desc.f1, false);
		assert.strictEqual(action.desc.category, undefined);
		assert.strictEqual(action.desc.keybinding, undefined);
		// Ported from the deduped legacy file: the binary descriptor also
		// carries no menu entry.
		assert.strictEqual((action.desc as { menu?: unknown }).menu, undefined);
	});

	test('run: no selected composer -> silent return (no delegation, no warning)', async () => {
		const h = harness({ activeEditor: undefined, editors: [] } as unknown as IEditorService);
		await new ComposerResumeCurrentChatAction().run(h.accessor);
		assert.strictEqual(h.calls.length, 0);
		assert.deepStrictEqual(h.warnings, []);
	});

	// Ported from the deduped legacy file (composerResumeChatAction.test.ts):
	// distinct from the no-selection case above — an editor IS active, it is
	// just not a composer chat editor, so resolveRenameChatTabId yields no
	// tab id and run returns silently.
	test('run: active editor is not a chat editor -> silent return (no delegation, no warning)', async () => {
		const h = harness({ activeEditor: { label: 'some.ts' }, editors: [] } as unknown as IEditorService);
		await new ComposerResumeCurrentChatAction().run(h.accessor);
		assert.strictEqual(h.calls.length, 0);
		assert.deepStrictEqual(h.warnings, []);
	});

	test('run: selected composer not loaded -> verbatim warning, no delegation', async () => {
		const input = new ComposerChatEditorInput('tab-1', fakeWebviewService, fakeThemeService);
		try {
			const h = harness({ activeEditor: input, editors: [] } as unknown as IEditorService);
			await new ComposerResumeCurrentChatAction().run(h.accessor);
			assert.strictEqual(h.calls.length, 0);
			assert.deepStrictEqual(h.warnings, ['Cannot resume: composer not loaded']);
		} finally {
			input.dispose();
		}
	});

	test('run: loaded composer -> delegates with {isAutoResume} coerced === true', async () => {
		const input = new ComposerChatEditorInput('tab-1', fakeWebviewService, fakeThemeService);
		try {
			const h = harness({ activeEditor: input, editors: [input] } as unknown as IEditorService);
			await new ComposerResumeCurrentChatAction().run(h.accessor, { isAutoResume: true });
			assert.strictEqual(h.calls.length, 1);
			assert.strictEqual(h.calls[0]!.id, 'ide.resumeCurrentChat');
			assert.deepStrictEqual(h.calls[0]!.args, [{ isAutoResume: true }]);

			const h2 = harness({ activeEditor: input, editors: [input] } as unknown as IEditorService);
			await new ComposerResumeCurrentChatAction().run(h2.accessor, { isAutoResume: 'yes' });
			assert.deepStrictEqual(h2.calls[0]!.args, [{ isAutoResume: false }]);

			// Ported from the deduped legacy file: no args at all ->
			// isAutoResume:false, and other truthy-but-not-true values
			// (1, {}) coerce to false the same way.
			const h3 = harness({ activeEditor: input, editors: [input] } as unknown as IEditorService);
			await new ComposerResumeCurrentChatAction().run(h3.accessor);
			assert.deepStrictEqual(h3.calls[0]!.args, [{ isAutoResume: false }]);
			assert.deepStrictEqual(h3.warnings, []);
			for (const truthy of [1, {}]) {
				const hx = harness({ activeEditor: input, editors: [input] } as unknown as IEditorService);
				await new ComposerResumeCurrentChatAction().run(hx.accessor, { isAutoResume: truthy });
				assert.deepStrictEqual(hx.calls[0]!.args, [{ isAutoResume: false }], `arg=${String(truthy)}`);
			}
		} finally {
			input.dispose();
		}
	});

	test('run: runtime failure -> warned with err.message (binary catch mapping)', async () => {
		const input = new ComposerChatEditorInput('tab-1', fakeWebviewService, fakeThemeService);
		try {
			const h = harness(
				{ activeEditor: input, editors: [input] } as unknown as IEditorService,
				async () => { throw new Error('Cannot resume: chat not found'); },
			);
			await new ComposerResumeCurrentChatAction().run(h.accessor);
			assert.deepStrictEqual(h.warnings, ['Cannot resume: chat not found']);
		} finally {
			input.dispose();
		}
	});

	// Ported from the deduped legacy file (composerResumeChatAction.test.ts):
	// the binary catch is `err instanceof Error ? err.message : "Cannot
	// resume"`, so a non-Error throw (here the string 'boom', thrown via the
	// harness executeImpl in place of the legacy stub's throwNext) warns the
	// generic message, not the thrown value.
	test('run: non-Error runtime throw -> warned "Cannot resume"', async () => {
		const input = new ComposerChatEditorInput('tab-1', fakeWebviewService, fakeThemeService);
		try {
			const h = harness(
				{ activeEditor: input, editors: [input] } as unknown as IEditorService,
				async () => { throw 'boom'; },
			);
			await new ComposerResumeCurrentChatAction().run(h.accessor);
			assert.strictEqual(h.calls.length, 1);
			assert.deepStrictEqual(h.warnings, ['Cannot resume']);
		} finally {
			input.dispose();
		}
	});
});
