/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { KeyCode, KeyMod } from '../../../../../base/common/keyCodes.js';
import { Codicon } from '../../../../../base/common/codicons.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { ContextKeyValue, IContext } from '../../../../../platform/contextkey/common/contextkey.js';
import { MenuId } from '../../../../../platform/actions/common/actions.js';
import { ICommandService } from '../../../../../platform/commands/common/commands.js';
import { KeybindingWeight } from '../../../../../platform/keybinding/common/keybindingsRegistry.js';
import { ServicesAccessor } from '../../../../../platform/instantiation/common/instantiation.js';
import {
	NewAgentAction,
	NewAgentFromKeyboardAction,
	NewAgentKeepPaneFromKeyboardAction,
	NewAgentWithModelAction,
	NewAgentWithContextAction,
	NewProjectSubagentAction,
	sanitizeNewAgentArgs,
} from '../../browser/newAgentActions.js';

// WORKER-GAPS-22A (agent-new-agent-command-family): Cursor 3.25.9 parity,
// workbench.glass.main.js. Byte offsets verified by direct reads:
// - newAgent                @45354742: title "New Agent", icon "agent",
//   glassCategory "Agent", f1:!0, keybindingCommandId "glass.newAgentFromKeyboard"
// - newAgentFromKeyboard    @45356179: title "New Agent", icon "agent", f1:!1,
//   Ctrl+N @250, no when, MenubarFileMenu 1_new order 0
// - newAgentKeepPaneFromKeyboard @45356565: title "New Agent (preserve editor
//   panel)", icon "agent", f1:!1, Ctrl+Alt+N @250, no when
// - newAgentWithModel       @45358929: title "New Agent with Model", icon
//   "sparkle", glassCategory "Agent", no f1 (palette-visible), no keybinding,
//   run(modelId) no-ops unless modelId is a non-empty string
// - newAgentWithContext     @45477543: title "New Agent with Context", icon
//   "sparkle", f1:!1, hidden:!0, Ctrl+Shift+L / Ctrl+Shift+I @1602,
//   when = File | Terminal | ((Diff | Pr) + diff-line-selection)
// - newProjectSubagent      @45345682: title "New Agent", icon "plus",
//   glassCategory "Agent", f1:!1, CtrlCmd|KeyT @200 (fork choice — binary
//   weight not decoded), when = !terminalFocusInAny (binary JDi && !GMe &&
//   !focusInAny; JDi/GMe omitted as documented divergence)

function context(values: Record<string, ContextKeyValue>): IContext {
	return { getValue: <T extends ContextKeyValue>(key: string) => values[key] as T | undefined };
}

interface RecordedCall { id: string; args: unknown[]; }

function accessorWithRecording(recorded: RecordedCall[]): ServicesAccessor {
	const get = <T>(serviceId: unknown): T => {
		if (serviceId === ICommandService) {
			return {
				executeCommand: (id: string, ...args: unknown[]) => {
					recorded.push({ id, args });
					return Promise.resolve(undefined);
				},
			} as unknown as T;
		}
		throw new Error(`unexpected service requested in test: ${String(serviceId)}`);
	};
	return { get };
}

function titleValue(action: { desc: { title: unknown } }): string {
	const title = action.desc.title;
	return typeof title === 'string' ? title : (title as { value: string }).value;
}

function categoryValue(action: { desc: { category?: unknown } }): string | undefined {
	const category = action.desc.category;
	if (category === undefined) {
		return undefined;
	}
	return typeof category === 'string' ? category : (category as { value: string }).value;
}

function singleKeybinding(action: { desc: { keybinding: unknown } }) {
	const kb = action.desc.keybinding;
	assert.ok(kb && !Array.isArray(kb), 'expected a single keybinding rule');
	return kb as { primary: number; secondary?: number[]; weight?: number; when?: { evaluate(c: IContext): boolean } };
}

suite('New Agent command family (Cursor 3.25.9 parity)', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('command ids are the binary-verbatim glass ids', () => {
		assert.strictEqual(NewAgentAction.ID, 'glass.newAgent');
		assert.strictEqual(NewAgentFromKeyboardAction.ID, 'glass.newAgentFromKeyboard');
		assert.strictEqual(NewAgentKeepPaneFromKeyboardAction.ID, 'glass.newAgentKeepPaneFromKeyboard');
		assert.strictEqual(NewAgentWithModelAction.ID, 'glass.newAgentWithModel');
		assert.strictEqual(NewAgentWithContextAction.ID, 'glass.newAgentWithContext');
		// WORKER-GAPS-40B: glass.newProjectSubagent @45345682
		assert.strictEqual(NewProjectSubagentAction.ID, 'glass.newProjectSubagent');
	});

	test('titles, icons, and f1 flags match the binary', () => {
		const cases = [
			{ action: new NewAgentAction(), title: 'New Agent', icon: Codicon.agent, f1: true },
			{ action: new NewAgentFromKeyboardAction(), title: 'New Agent', icon: Codicon.agent, f1: false },
			{ action: new NewAgentKeepPaneFromKeyboardAction(), title: 'New Agent (preserve editor panel)', icon: Codicon.agent, f1: false },
			{ action: new NewAgentWithModelAction(), title: 'New Agent with Model', icon: Codicon.sparkle, f1: true },
			{ action: new NewAgentWithContextAction(), title: 'New Agent with Context', icon: Codicon.sparkle, f1: false },
			// WORKER-GAPS-56A (QA W42F): binary-verbatim title "New Agent",
			// icon "plus", glassCategory "Agent", f1:!1 (palette-hidden)
			// (workbench.glass.main.js 3.25.9 @45345682 — the earlier
			// "icon not in recovered evidence" claim was FALSE).
			{ action: new NewProjectSubagentAction(), title: 'New Agent', icon: Codicon.plus, f1: false },
		] as const;
		for (const c of cases) {
			assert.strictEqual(c.action.desc.id, (c.action.constructor as { ID: string }).ID);
			assert.strictEqual(titleValue(c.action), c.title, `${c.action.desc.id} title`);
			assert.strictEqual(c.action.desc.icon, c.icon, `${c.action.desc.id} icon`);
			assert.strictEqual(c.action.desc.f1, c.f1, `${c.action.desc.id} f1`);
		}
	});

	test('palette categories are the binary-verbatim glassCategory "Agent"', () => {
		assert.strictEqual(categoryValue(new NewAgentAction()), 'Agent');
		assert.strictEqual(categoryValue(new NewAgentWithModelAction()), 'Agent');
		// WORKER-GAPS-56A (QA W42F): binary glassCategory "Agent" @45345682.
		assert.strictEqual(categoryValue(new NewProjectSubagentAction()), 'Agent');
	});

	test('newAgentFromKeyboard: Ctrl+N @250, no when, File-menu entry above New Text File', () => {
		const action = new NewAgentFromKeyboardAction();
		const kb = singleKeybinding(action);
		// binary: weight yk=250, primary CtrlCmd|KeyN, NO when clause
		assert.strictEqual(kb.weight, KeybindingWeight.SessionsContrib);
		assert.strictEqual(kb.weight, 250);
		assert.strictEqual(kb.primary, KeyMod.CtrlCmd | KeyCode.KeyN);
		assert.strictEqual(kb.when, undefined);
		// binary: menu {column: MenubarFileMenu, group:"1_new", order:0}
		const menu = action.desc.menu;
		assert.ok(menu && !Array.isArray(menu), 'expected a single menu item');
		assert.strictEqual(menu.id, MenuId.MenubarFileMenu);
		assert.strictEqual(menu.group, '1_new');
		assert.strictEqual(menu.order, 0);
	});

	test('newAgentKeepPaneFromKeyboard: Ctrl+Alt+N @250, no when, palette-hidden', () => {
		const action = new NewAgentKeepPaneFromKeyboardAction();
		const kb = singleKeybinding(action);
		assert.strictEqual(kb.weight, 250);
		assert.strictEqual(kb.primary, KeyMod.CtrlCmd | KeyMod.Alt | KeyCode.KeyN);
		assert.strictEqual(kb.when, undefined);
		assert.strictEqual(action.desc.menu, undefined, 'no menu items (binary has none)');
	});

	test('newAgentWithModel: no keybinding (binary registers none)', () => {
		const action = new NewAgentWithModelAction();
		assert.strictEqual(action.desc.keybinding, undefined);
	});

	test('newAgentWithContext: Ctrl+Shift+L / Ctrl+Shift+I @1602 with the tab-kind when-clause', () => {
		const action = new NewAgentWithContextAction();
		const kb = singleKeybinding(action);
		// binary: weight 1602, primary CtrlCmd|Shift|L, secondary [CtrlCmd|Shift|I]
		assert.strictEqual(kb.weight, 1602);
		assert.strictEqual(kb.primary, KeyMod.CtrlCmd | KeyMod.Shift | KeyCode.KeyL);
		assert.deepStrictEqual(kb.secondary, [KeyMod.CtrlCmd | KeyMod.Shift | KeyCode.KeyI]);
		assert.ok(kb.when, 'when clause is defined');

		// binary: cf (glassActiveTabKind) == File -> editor text focus
		assert.strictEqual(kb.when!.evaluate(context({ editorTextFocus: true })), true);
		// binary: cf == Terminal -> terminal focus
		assert.strictEqual(kb.when!.evaluate(context({ terminalFocus: true })), true);
		// binary: (cf == Diff || cf == Pr) && glassDiffLineSelectionActive ->
		// inDiffEditor && editorHasSelection (documented honest divergence;
		// QA-CATCH: the context-key STRINGS are 'inDiffEditor' /
		// 'editorHasSelection' — the fork's exports are
		// EditorContextKeys.inDiffEditor / .hasNonEmptySelection)
		assert.strictEqual(
			kb.when!.evaluate(context({ inDiffEditor: true, editorHasSelection: true })), true,
			'diff editor with an active selection'
		);
		assert.strictEqual(
			kb.when!.evaluate(context({ inDiffEditor: true, editorHasSelection: false })), false,
			'diff editor WITHOUT a selection does not fire'
		);
		// nowhere relevant focused -> does not fire (Ctrl+Shift+L falls
		// through to other bindings; Ctrl+Shift+I keeps DevTools)
		assert.strictEqual(kb.when!.evaluate(context({})), false);
	});

	test('sanitizeNewAgentArgs: binary arg shapes', () => {
		assert.strictEqual(sanitizeNewAgentArgs(undefined), undefined);
		assert.strictEqual(sanitizeNewAgentArgs('nope'), undefined);
		assert.strictEqual(sanitizeNewAgentArgs({ unknownKey: 1 }), undefined);
		assert.deepStrictEqual(
			sanitizeNewAgentArgs({ source: 'command_palette' }),
			{ source: 'command_palette' }
		);
		// binary cloudRepoUrls branch: non-string/blank entries filtered
		assert.deepStrictEqual(
			sanitizeNewAgentArgs({ cloudRepoUrls: ['https://a', 42, '  ', 'https://b'] }),
			{ cloudRepoUrls: ['https://a', 'https://b'] }
		);
		assert.strictEqual(sanitizeNewAgentArgs({ cloudRepoUrls: [] }), undefined);
		assert.deepStrictEqual(
			sanitizeNewAgentArgs({ folderUri: 'file:///tmp/x' }),
			{ folderUri: 'file:///tmp/x' }
		);
		assert.deepStrictEqual(
			sanitizeNewAgentArgs({ source: 'keyboard_shortcut', keybinding: 'Ctrl+Alt+N', shouldOpenEditorPanel: true }),
			{ source: 'keyboard_shortcut', keybinding: 'Ctrl+Alt+N', shouldOpenEditorPanel: true }
		);
	});

	test('run(): newAgent delegates to ide.newAgent with the palette source by default', async () => {
		const recorded: RecordedCall[] = [];
		await new NewAgentAction().run(accessorWithRecording(recorded));
		assert.strictEqual(recorded.length, 1);
		assert.strictEqual(recorded[0].id, 'ide.newAgent');
		// binary: source defaults to "command_palette"
		assert.deepStrictEqual(recorded[0].args, [{ source: 'command_palette' }]);
	});

	test('run(): newAgent forwards cloudRepoUrls / folderUri branches verbatim', async () => {
		const recorded: RecordedCall[] = [];
		await new NewAgentAction().run(
			accessorWithRecording(recorded),
			{ cloudRepoUrls: ['https://github.com/a/b'] }
		);
		assert.deepStrictEqual(recorded[0].args, [{ cloudRepoUrls: ['https://github.com/a/b'] }]);

		recorded.length = 0;
		await new NewAgentAction().run(
			accessorWithRecording(recorded),
			{ folderUri: 'file:///tmp/x', source: 'cli' }
		);
		assert.deepStrictEqual(recorded[0].args, [{ folderUri: 'file:///tmp/x', source: 'cli' }]);
	});

	test('run(): keyboard variants forward the binary telemetry payloads', async () => {
		const recorded: RecordedCall[] = [];
		await new NewAgentFromKeyboardAction().run(accessorWithRecording(recorded));
		assert.deepStrictEqual(recorded[0].args, [{ source: 'keyboard_shortcut', keybinding: 'Ctrl+N' }]);

		recorded.length = 0;
		await new NewAgentKeepPaneFromKeyboardAction().run(accessorWithRecording(recorded));
		assert.deepStrictEqual(recorded[0].args, [{
			source: 'keyboard_shortcut',
			keybinding: 'Ctrl+Alt+N',
			shouldOpenEditorPanel: true,
		}]);
	});

	test('run(): newAgentWithModel no-ops on blank modelId, delegates otherwise', async () => {
		const recorded: RecordedCall[] = [];
		const action = new NewAgentWithModelAction();
		// binary-verbatim guard: non-string / blank -> no-op
		await action.run(accessorWithRecording(recorded), undefined);
		await action.run(accessorWithRecording(recorded), 42);
		await action.run(accessorWithRecording(recorded), '   ');
		assert.strictEqual(recorded.length, 0, 'blank modelId must not delegate');

		await action.run(accessorWithRecording(recorded), 'anthropic/claude-opus-4-5');
		assert.strictEqual(recorded.length, 1);
		assert.strictEqual(recorded[0].id, 'ide.newAgentWithModel');
		assert.deepStrictEqual(recorded[0].args, ['anthropic/claude-opus-4-5']);
	});

	test('run(): newAgentWithContext creates the agent via ide.addToChat {newChat:true}', async () => {
		const recorded: RecordedCall[] = [];
		await new NewAgentWithContextAction().run(accessorWithRecording(recorded));
		assert.strictEqual(recorded.length, 1);
		assert.strictEqual(recorded[0].id, 'ide.addToChat');
		// the extension's real implementation: fresh agent tab + current
		// context attached (binary newAgentWithContextRequested analog)
		assert.deepStrictEqual(recorded[0].args, [{ newChat: true }]);
	});

	test('newProjectSubagent: Ctrl+T @200, when = !terminalFocusInAny (binary JDi && !GMe && !focusInAny port)', () => {
		const action = new NewProjectSubagentAction();
		const kb = singleKeybinding(action);
		// binary: primary CtrlCmd|KeyT. Weight 200 (WorkbenchContrib) is the
		// deliberate fork choice — keeps the browser's Ctrl+T=new-tab @250
		// deterministic (binary weight was not recovered).
		assert.strictEqual(kb.weight, KeybindingWeight.WorkbenchContrib);
		assert.strictEqual(kb.primary, KeyMod.CtrlCmd | KeyCode.KeyT);
		assert.ok(kb.when, 'when clause is defined');
		// binary `focusInAny` = the 'terminalFocusInAny' key (verbatim port):
		// fires outside the terminal...
		assert.strictEqual(kb.when!.evaluate(context({ terminalFocusInAny: false })), true);
		assert.strictEqual(kb.when!.evaluate(context({})), true);
		// ...but never while the terminal has focus.
		assert.strictEqual(kb.when!.evaluate(context({ terminalFocusInAny: true })), false);
		// HONEST-DIVERGENCE (documented in the action): JDi (agent-workspace
		// scope, always true in the fork's single window type) and GMe
		// (undecodable) are not separate terms.
	});

	test('run(): newProjectSubagent delegates to ide.newProjectSubagent with the binary telemetry payload', async () => {
		const recorded: RecordedCall[] = [];
		await new NewProjectSubagentAction().run(accessorWithRecording(recorded));
		assert.strictEqual(recorded.length, 1);
		assert.strictEqual(recorded[0].id, 'ide.newProjectSubagent');
		// binary: trackEvent(...,{source:"keyboard_shortcut",keybinding:"Ctrl+T"})
		assert.deepStrictEqual(recorded[0].args, [{ source: 'keyboard_shortcut', keybinding: 'Ctrl+T' }]);
	});
});
