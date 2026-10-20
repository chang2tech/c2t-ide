/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// IDE-CODE: DEV-GAPS-18-W4 — `agent-worktree-chat-actions`.
//
// Binary evidence (Cursor 3.25.9, workbench.glass.main.js, chat-tab overflow
// menu builder `sSv`, gated on the chat tab's `gitWorktree.worktreePath`):
//   Cf({id:"composer.copyWorktreePath",label:"Copy worktree path",...clipboardService.writeText(d)})
//   Cf({id:"composer.openTerminalInWorktree",label:"Open terminal in worktree",...executeCommand(d,i)})
//   Cf({id:"composer.openNewWindowInWorktree",label:"Open new window in worktree",...hostService.openWindow([{folderUri:st.file(d)}],{forceNewWindow:!0})})
// The fork keeps Cursor's ids VERBATIM (the composer namespace is already
// `composer.*`) and the labels VERBATIM. Run() behaviors (clipboard write,
// terminal newWithCwd, openWindow folderUri+forceNewWindow) are covered by
// the node harness at ~/workspace/gaps-18w4-tests/worktree-chat-actions.test.mjs.

import assert from 'assert';
import { Emitter } from '../../../../../base/common/event.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { ComposerContextKeys } from '../../common/composerContextKeys.js';
import { ComposerChatEditorInput } from '../../browser/composerEditorInput.js';
import {
	ComposerCopyWorktreePathAction,
	ComposerOpenNewWindowInWorktreeAction,
	ComposerOpenTerminalInWorktreeAction,
	resolveActiveChatWorktreePath,
} from '../../browser/composerWorktreeActions.js';
import type { IEditorService } from '../../../services/editor/common/editorService.js';
import type { IWebviewService } from '../../webview/browser/webview.js';
import type { IThemeService } from '../../../../../platform/theme/common/themeService.js';

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

function chatInput(worktreePath?: string): ComposerChatEditorInput {
	const input = new ComposerChatEditorInput('tab-1', fakeWebviewService, fakeThemeService);
	input.setWorktreePath(worktreePath);
	return input;
}

suite('Composer worktree chat-tab overflow actions (Cursor 3.25.9 parity)', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('registration: Cursor-verbatim ids, verbatim labels, menu-only (f1:false)', () => {
		type ActionClass = { new(): { desc: { id: string; title: { value: string }; f1?: boolean } }; ID: string };
		const expectations: Array<[ActionClass, string, string]> = [
			[ComposerCopyWorktreePathAction as unknown as ActionClass, 'composer.copyWorktreePath', 'Copy worktree path'],
			[ComposerOpenTerminalInWorktreeAction as unknown as ActionClass, 'composer.openTerminalInWorktree', 'Open terminal in worktree'],
			[ComposerOpenNewWindowInWorktreeAction as unknown as ActionClass, 'composer.openNewWindowInWorktree', 'Open new window in worktree'],
		];
		for (const [Ctor, id, label] of expectations) {
			const action = new Ctor();
			assert.strictEqual(action.desc.id, id, `id must be the verbatim Cursor id ${id}`);
			assert.strictEqual(Ctor.ID, id, 'static ID matches');
			assert.strictEqual(action.desc.title.value, label, `label must be verbatim "${label}"`);
			assert.strictEqual(action.desc.f1, false, `${id} is menu-only like the sibling overflow items`);
		}
	});

	test('context key composer.chatHasWorktree is defined, default false', () => {
		assert.strictEqual(ComposerContextKeys.chatHasWorktree.key, 'composer.chatHasWorktree');
		assert.strictEqual(ComposerContextKeys.chatHasWorktree.defaultValue, false);
	});

	test('chat tab worktree model (Cursor gitWorktree.worktreePath analog)', () => {
		const input = chatInput();
		try {
			assert.strictEqual(input.worktreePath, undefined, 'starts unattached');
			let fired = 0;
			input.onDidChangeWorktreePath(() => { fired++; });
			input.setWorktreePath('/repo-worktrees/feature-x');
			assert.strictEqual(input.worktreePath, '/repo-worktrees/feature-x');
			assert.strictEqual(fired, 1, 'change event fires once');
			input.setWorktreePath('/repo-worktrees/feature-x');
			assert.strictEqual(fired, 1, 'no event when the value is unchanged');
			input.setWorktreePath(undefined);
			assert.strictEqual(input.worktreePath, undefined, 'detach works');
			assert.strictEqual(fired, 2, 'change event fires on detach');
		} finally {
			input.dispose();
		}
	});

	test('resolveActiveChatWorktreePath reads the active chat tab', () => {
		const withWorktree = chatInput('/wt/a');
		const withoutWorktree = chatInput(undefined);
		try {
			const editorService = (activeEditor: unknown) => ({ activeEditor } as IEditorService);
			assert.strictEqual(resolveActiveChatWorktreePath(editorService(withWorktree)), '/wt/a');
			assert.strictEqual(resolveActiveChatWorktreePath(editorService(withoutWorktree)), undefined);
			assert.strictEqual(resolveActiveChatWorktreePath(editorService({ notAChatInput: true })), undefined);
			assert.strictEqual(resolveActiveChatWorktreePath(editorService(undefined)), undefined);
		} finally {
			withWorktree.dispose();
			withoutWorktree.dispose();
		}
	});
});
