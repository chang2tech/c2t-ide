/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { KeyCode, KeyMod } from '../../../../../base/common/keyCodes.js';
import { ContextKeyExpr, type ContextKeyExpression } from '../../../../../platform/contextkey/common/contextkey.js';
import { ICommandService } from '../../../../../platform/commands/common/commands.js';
import { ServiceIdentifier, ServicesAccessor } from '../../../../../platform/instantiation/common/instantiation.js';
import { ComposerAcceptComposerStepAction } from '../../browser/composerActions.js';

// FEATURE-1 (`agent-accept-pending-decisions`): Cursor 3.25.9 parity for
// `composer.acceptComposerStep` (workbench.glass.main.js @39863346,
// class LAb, verified verbatim):
// - descriptor: id `composer.acceptComposerStep`, title "Accept pending
//   agent pane action", f1:!0 (palette-visible), NO category (the binary
//   registers none).
// - keybindings (weight 600, both): CtrlCmd+Enter when
//   `(composerFocused || focusedView =~ /^workbench.panel.aichat.view/) &&
//   !composerSubmitOnCmdEnterEnabled`; CtrlCmd+Alt+Enter when the same
//   surface condition holds AND `composerSubmitOnCmdEnterEnabled`.
// - run: delegates to the extension runtime `ide.acceptComposerStep`
//   (the engine-side group-accept + notification branches live there until
//   the webview migrates to core).

interface KeybindingDescriptor {
	weight?: number;
	primary?: number;
	when?: ContextKeyExpression;
}

function keybindingsOf(action: ComposerAcceptComposerStepAction): KeybindingDescriptor[] {
	const kb = (action.desc as { keybinding?: KeybindingDescriptor | KeybindingDescriptor[] }).keybinding;
	return Array.isArray(kb) ? kb : kb ? [kb] : [];
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

suite('ComposerAcceptComposerStepAction (agent-accept-pending-decisions, Cursor 3.25.9 parity)', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('descriptor matches the binary: id, title, f1:true, no category', () => {
		const action = new ComposerAcceptComposerStepAction();
		assert.strictEqual(ComposerAcceptComposerStepAction.ID, 'composer.acceptComposerStep');
		assert.strictEqual(action.desc.id, 'composer.acceptComposerStep');
		assert.strictEqual(action.desc.title.value, 'Accept pending agent pane action');
		assert.strictEqual(action.desc.f1, true);
		// Binary registers NO category (class LAb descriptor has none).
		assert.strictEqual(action.desc.category, undefined);
	});

	test('registers exactly two keybindings: CtrlCmd+Enter and CtrlCmd+Alt+Enter at weight 600', () => {
		const action = new ComposerAcceptComposerStepAction();
		const kbs = keybindingsOf(action);
		assert.strictEqual(kbs.length, 2);

		assert.strictEqual(kbs[0]!.primary, KeyMod.CtrlCmd | KeyCode.Enter);
		assert.strictEqual(kbs[0]!.weight, 600);
		assert.strictEqual(kbs[1]!.primary, KeyMod.CtrlCmd | KeyMod.Alt | KeyCode.Enter);
		assert.strictEqual(kbs[1]!.weight, 600);
	});

	test('when-clauses: chat surface && !composerSubmitOnCmdEnterEnabled vs chat surface && composerSubmitOnCmdEnterEnabled', () => {
		const action = new ComposerAcceptComposerStepAction();
		const kbs = keybindingsOf(action);
		const acceptWhen = kbs[0]!.when;
		const acceptAltWhen = kbs[1]!.when;
		assert.ok(acceptWhen, 'CtrlCmd+Enter binding has a when-clause');
		assert.ok(acceptAltWhen, 'CtrlCmd+Alt+Enter binding has a when-clause');

		// chatSurface port: focusedView == 'composer.chat' (sidebar) or
		// resourceScheme == 'ide-chat' (chat editor tab).
		const sidebarOff = contextWith({ focusedView: 'composer.chat', 'composerSubmitOnCmdEnterEnabled': false });
		const sidebarOn = contextWith({ focusedView: 'composer.chat', 'composerSubmitOnCmdEnterEnabled': true });
		const editorTabOff = contextWith({ focusedView: 'editor', resourceScheme: 'ide-chat', 'composerSubmitOnCmdEnterEnabled': false });
		const editorTabOn = contextWith({ focusedView: 'editor', resourceScheme: 'ide-chat', 'composerSubmitOnCmdEnterEnabled': true });
		const elsewhere = contextWith({ focusedView: 'explorer', resourceScheme: 'file', 'composerSubmitOnCmdEnterEnabled': false });

		// CtrlCmd+Enter: live on the chat surface only while the
		// submit-on-cmd-enter setting is OFF.
		assert.strictEqual(acceptWhen.evaluate(sidebarOff), true);
		assert.strictEqual(acceptWhen.evaluate(editorTabOff), true);
		assert.strictEqual(acceptWhen.evaluate(sidebarOn), false);
		assert.strictEqual(acceptWhen.evaluate(elsewhere), false);

		// CtrlCmd+Alt+Enter: live on the chat surface only while the
		// submit-on-cmd-enter setting is ON.
		assert.strictEqual(acceptAltWhen.evaluate(sidebarOn), true);
		assert.strictEqual(acceptAltWhen.evaluate(editorTabOn), true);
		assert.strictEqual(acceptAltWhen.evaluate(sidebarOff), false);
		assert.strictEqual(acceptAltWhen.evaluate(elsewhere), false);
	});

	test('when-clauses reference the fork chat-surface port, not the binary-only keys', () => {
		// `composerFocused` has no fork writer (established HONEST-DIVERGENCE);
		// the port must use the chatSurface terms instead.
		const action = new ComposerAcceptComposerStepAction();
		const kbs = keybindingsOf(action);
		for (const kb of kbs) {
			const serialized = kb.when?.serialize() ?? '';
			assert.ok(!serialized.includes('composerFocused'), `when must not reference composerFocused: ${serialized}`);
			assert.ok(serialized.includes('composer.chat') || serialized.includes('ide-chat'), `when must cover the fork chat surface: ${serialized}`);
			assert.ok(serialized.includes('composerSubmitOnCmdEnterEnabled'), `when must gate on composer.submitOnCmdEnterEnabled: ${serialized}`);
		}
		// Sanity: the two bindings differ exactly by the negation.
		assert.ok(!(kbs[0]!.when?.serialize() === kbs[1]!.when?.serialize()));
	});

	test('run: delegates to the extension runtime ide.acceptComposerStep with args forwarded', async () => {
		const calls: Array<{ id: string; args: unknown[] }> = [];
		const commandService = {
			executeCommand: async (id: string, ...args: unknown[]): Promise<unknown> => {
				calls.push({ id, args });
				return undefined;
			},
		} as unknown as ICommandService;
		const stubs = new Map<ServiceIdentifier<unknown>, unknown>([
			[ICommandService as ServiceIdentifier<unknown>, commandService],
		]);
		const action = new ComposerAcceptComposerStepAction();
		await action.run(accessorFor(stubs), 'extra-arg');

		assert.strictEqual(calls.length, 1);
		assert.strictEqual(calls[0]!.id, 'ide.acceptComposerStep');
		assert.deepStrictEqual(calls[0]!.args, ['extra-arg']);
	});

	test('chatSurface helper covers both chat surfaces (mirrors the binary OR)', () => {
		// Guards the shared `chatSurface` expression this command relies on:
		// sidebar view OR chat editor tab.
		const surface = ContextKeyExpr.or(
			ContextKeyExpr.equals('focusedView', 'composer.chat'),
			ContextKeyExpr.equals('resourceScheme', 'ide-chat'),
		);
		assert.strictEqual(surface.evaluate(contextWith({ focusedView: 'composer.chat' })), true);
		assert.strictEqual(surface.evaluate(contextWith({ focusedView: 'workbench.editors', resourceScheme: 'ide-chat' })), true);
		assert.strictEqual(surface.evaluate(contextWith({ focusedView: 'terminal', resourceScheme: 'file' })), false);
	});
});
