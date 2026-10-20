/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { ICommandService } from '../../../../../platform/commands/common/commands.js';
import { ILogService, NullLogService } from '../../../../../platform/log/common/log.js';
import { ServicesAccessor } from '../../../../../platform/instantiation/common/instantiation.js';
import { IEditorService } from '../../../../services/editor/common/editorService.js';
import {
	AipopupFocusEditAction,
	AipopupNextPromptBarAction,
} from '../../browser/composerActions.js';
import {
	IInlineEditPromptBar,
	IPromptBarRef,
} from '../../common/inlineEditPromptBar.js';

// WORKER W60C — `cmdk-next-prompt-bar` / `aipopup.action.focusEdit` action
// tests (Cursor 3.25.9 parity, workbench.glass.main.js):
//   Jqc.ID="aipopup.action.nextPromptBar", Jqc.LABEL="Next Prompt Bar",
//   f1:!0 — run: sort getPromptBars() by createdAt, take the entry after
//   the current id (wrapping to the first), executeCommand
//   "aipopup.action.focusEdit" with its id; else focus the active code
//   editor (when it has a model).
//   Zqc.ID="aipopup.action.focusEdit", Zqc.LABEL="Focus Edit", f1:!0 —
//   run: active-editor/model guards ("No model found, cannot edit."
//   console.error), then getPromptBar(n) → focus.
// No keybinding for either command exists in the shipped bundles.
// (The createdAt cycling truth table itself is covered by
// test/common/inlineEditNextPromptBar.test.ts.)

interface RecordedCommandCall { id: string; args: unknown[]; }

function titleValue(action: { desc: { title: unknown } }): string {
	const title = action.desc.title;
	return typeof title === 'string' ? title : (title as { value: string }).value;
}

function fakeCodeEditor(hasModel: boolean, focused: boolean[]): unknown {
	return {
		getModel: () => (hasModel ? ({} as unknown) : null),
		changeViewZones: () => undefined,
		hasModel: () => hasModel,
		focus: () => { focused.push(true); },
	};
}

function accessorWith(deps: {
	promptBar: Partial<IInlineEditPromptBar>;
	commands: RecordedCommandCall[];
	activeControl: unknown;
	logErrors?: string[];
}): ServicesAccessor {
	const get = <T>(serviceId: unknown): T => {
		if (serviceId === IInlineEditPromptBar) {
			return deps.promptBar as T;
		}
		if (serviceId === ICommandService) {
			return {
				executeCommand: (id: string, ...args: unknown[]) => {
					deps.commands.push({ id, args });
					return Promise.resolve(undefined);
				},
			} as unknown as T;
		}
		if (serviceId === IEditorService) {
			return { activeTextEditorControl: deps.activeControl } as unknown as T;
		}
		if (serviceId === ILogService) {
			return {
				...new NullLogService(),
				error: (message: string) => { deps.logErrors?.push(message); },
			} as unknown as T;
		}
		throw new Error(`unexpected service requested in test: ${String(serviceId)}`);
	};
	return { get };
}

const BAR_A: IPromptBarRef = { id: 'bar-a', createdAt: 100 };
const BAR_B: IPromptBarRef = { id: 'bar-b', createdAt: 200 };

suite('aipopup Next Prompt Bar / Focus Edit (Cursor 3.25.9 parity)', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('ids, titles and f1 flags are binary-verbatim', () => {
		const next = new AipopupNextPromptBarAction();
		assert.strictEqual(next.desc.id, 'aipopup.action.nextPromptBar');
		assert.strictEqual(titleValue(next), 'Next Prompt Bar');
		assert.strictEqual(next.desc.f1, true);
		// The binary registrations carry NO category (glass @40741636,
		// desktop @32238118) — W66C removed the fork-invented "Composer" one.
		assert.strictEqual(next.desc.category, undefined);
		// The shipped bundles register NO keybinding for nextPromptBar.
		assert.strictEqual(next.desc.keybinding, undefined);

		const focusEdit = new AipopupFocusEditAction();
		assert.strictEqual(focusEdit.desc.id, 'aipopup.action.focusEdit');
		assert.strictEqual(titleValue(focusEdit), 'Focus Edit');
		assert.strictEqual(focusEdit.desc.f1, true);
		// No category in the binary either (glass @40740291, desktop @32236800).
		assert.strictEqual(focusEdit.desc.category, undefined);
		assert.strictEqual(focusEdit.desc.keybinding, undefined);
	});

	test('run cycles to the next bar via aipopup.action.focusEdit', async () => {
		const commands: RecordedCommandCall[] = [];
		const accessor = accessorWith({
			promptBar: {
				getPromptBars: () => [BAR_A, BAR_B],
				getFocusedPromptBarId: () => 'bar-a',
			},
			commands,
			activeControl: undefined,
		});
		await new AipopupNextPromptBarAction().run(accessor);
		assert.deepStrictEqual(commands, [{ id: 'aipopup.action.focusEdit', args: ['bar-b'] }]);
	});

	test('run wraps from the newest bar to the oldest', async () => {
		const commands: RecordedCommandCall[] = [];
		const accessor = accessorWith({
			promptBar: {
				getPromptBars: () => [BAR_A, BAR_B],
				getFocusedPromptBarId: () => 'bar-b',
			},
			commands,
			activeControl: undefined,
		});
		await new AipopupNextPromptBarAction().run(accessor);
		assert.deepStrictEqual(commands, [{ id: 'aipopup.action.focusEdit', args: ['bar-a'] }]);
	});

	test('an explicit current-bar argument wins over focus detection', async () => {
		const commands: RecordedCommandCall[] = [];
		const accessor = accessorWith({
			promptBar: {
				getPromptBars: () => [BAR_A, BAR_B],
				getFocusedPromptBarId: () => { throw new Error('must not be called'); },
			},
			commands,
			activeControl: undefined,
		});
		await new AipopupNextPromptBarAction().run(accessor, 'bar-a');
		assert.deepStrictEqual(commands, [{ id: 'aipopup.action.focusEdit', args: ['bar-b'] }]);
	});

	test('single focused bar → no executeCommand; the active editor is focused (binary else-branch)', async () => {
		const commands: RecordedCommandCall[] = [];
		const focused: boolean[] = [];
		const accessor = accessorWith({
			promptBar: {
				getPromptBars: () => [BAR_A],
				getFocusedPromptBarId: () => 'bar-a',
			},
			commands,
			activeControl: fakeCodeEditor(true, focused),
		});
		await new AipopupNextPromptBarAction().run(accessor);
		assert.deepStrictEqual(commands, []);
		assert.deepStrictEqual(focused, [true]);
	});

	test('focusEdit delegates to the prompt-bar service with the bar id', async () => {
		const focusedIds: string[] = [];
		const accessor = accessorWith({
			promptBar: {
				focusPromptBar: (id: string) => { focusedIds.push(id); return Promise.resolve(); },
			},
			commands: [],
			activeControl: fakeCodeEditor(true, []),
		});
		await new AipopupFocusEditAction().run(accessor, 'bar-b');
		assert.deepStrictEqual(focusedIds, ['bar-b']);
	});

	test('focusEdit without a bar id is a no-op (binary: getPromptBar → !c → return)', async () => {
		const focusedIds: string[] = [];
		const accessor = accessorWith({
			promptBar: {
				focusPromptBar: (id: string) => { focusedIds.push(id); return Promise.resolve(); },
			},
			commands: [],
			activeControl: fakeCodeEditor(true, []),
		});
		await new AipopupFocusEditAction().run(accessor);
		assert.deepStrictEqual(focusedIds, []);
	});

	test('focusEdit with no active editor / no model bails like the binary', async () => {
		const focusedIds: string[] = [];
		const logErrors: string[] = [];
		// No active editor at all.
		await new AipopupFocusEditAction().run(accessorWith({
			promptBar: { focusPromptBar: (id: string) => { focusedIds.push(id); return Promise.resolve(); } },
			commands: [],
			activeControl: undefined,
			logErrors,
		}), 'bar-a');
		assert.deepStrictEqual(focusedIds, []);
		// Active editor without a model → verbatim binary error string.
		await new AipopupFocusEditAction().run(accessorWith({
			promptBar: { focusPromptBar: (id: string) => { focusedIds.push(id); return Promise.resolve(); } },
			commands: [],
			activeControl: fakeCodeEditor(false, []),
			logErrors,
		}), 'bar-a');
		assert.deepStrictEqual(focusedIds, []);
		assert.deepStrictEqual(logErrors, ['No model found, cannot edit.']);
	});
});
