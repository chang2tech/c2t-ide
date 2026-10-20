/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { KeyCode, KeyMod } from '../../../../../base/common/keyCodes.js';
import { type ContextKeyExpression } from '../../../../../platform/contextkey/common/contextkey.js';
import { ICommandService } from '../../../../../platform/commands/common/commands.js';
import { ServiceIdentifier, ServicesAccessor } from '../../../../../platform/instantiation/common/instantiation.js';
import { ComposerAcceptComposerStepAction } from '../../browser/composerAcceptStepAction.js';

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
//   Fork map: `workbench.panel.aichat.view` -> the fork's chat panel views
//   `composer.chat` / `ideAgent.chatView`.
// - run: delegates to the extension runtime `ide.acceptComposerStep`
//   (binary run(): non-empty pending-decision group -> accept() every item
//   unconditionally; else composerNotificationService.acceptNotification()).

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
function contextWith(values: Record<string, unknown>): { getValue<T>(key: string): T | undefined } {
	return {
		getValue: <T>(key: string) => (key in values ? values[key] as T : undefined),
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
		const title = action.desc.title;
		assert.strictEqual(typeof title === 'string' ? title : title.value, 'Accept pending agent pane action');
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

	test('when-clauses: binary surface condition && !composerSubmitOnCmdEnterEnabled vs && composerSubmitOnCmdEnterEnabled', () => {
		const action = new ComposerAcceptComposerStepAction();
		const kbs = keybindingsOf(action);
		const acceptWhen = kbs[0]!.when;
		const acceptAltWhen = kbs[1]!.when;
		if (!acceptWhen || !acceptAltWhen) {
			throw new Error('Both bindings must have a when-clause');
		}

		// Binary surface port: composerFocused OR focusedView =~
		// /^(composer.chat|ideAgent.chatView)/ (fork map of the binary's
		// /^workbench.panel.aichat.view/).
		const viaComposerFocusedOff = contextWith({ composerFocused: true, 'composerSubmitOnCmdEnterEnabled': false });
		const viaComposerFocusedOn = contextWith({ composerFocused: true, 'composerSubmitOnCmdEnterEnabled': true });
		const coreViewOff = contextWith({ focusedView: 'composer.chat', 'composerSubmitOnCmdEnterEnabled': false });
		const coreViewOn = contextWith({ focusedView: 'composer.chat', 'composerSubmitOnCmdEnterEnabled': true });
		const extViewOff = contextWith({ focusedView: 'ideAgent.chatView', 'composerSubmitOnCmdEnterEnabled': false });
		const extViewOn = contextWith({ focusedView: 'ideAgent.chatView', 'composerSubmitOnCmdEnterEnabled': true });
		const elsewhere = contextWith({ focusedView: 'explorer', 'composerSubmitOnCmdEnterEnabled': false });
		const keyUnset = contextWith({ focusedView: 'composer.chat' }); // binary default: key defaults false

		// CtrlCmd+Enter: live on the chat surface only while the
		// submit-on-cmd-enter setting is OFF (or unset = default false).
		assert.strictEqual(acceptWhen.evaluate(viaComposerFocusedOff), true);
		assert.strictEqual(acceptWhen.evaluate(coreViewOff), true);
		assert.strictEqual(acceptWhen.evaluate(extViewOff), true);
		assert.strictEqual(acceptWhen.evaluate(keyUnset), true);
		assert.strictEqual(acceptWhen.evaluate(viaComposerFocusedOn), false);
		assert.strictEqual(acceptWhen.evaluate(coreViewOn), false);
		assert.strictEqual(acceptWhen.evaluate(elsewhere), false);

		// CtrlCmd+Alt+Enter: live on the chat surface only while the
		// submit-on-cmd-enter setting is ON.
		assert.strictEqual(acceptAltWhen.evaluate(viaComposerFocusedOn), true);
		assert.strictEqual(acceptAltWhen.evaluate(coreViewOn), true);
		assert.strictEqual(acceptAltWhen.evaluate(extViewOn), true);
		assert.strictEqual(acceptAltWhen.evaluate(viaComposerFocusedOff), false);
		assert.strictEqual(acceptAltWhen.evaluate(coreViewOff), false);
		assert.strictEqual(acceptAltWhen.evaluate(elsewhere), false);
	});

	test('when-clauses are the binary port: composerFocused term + mapped aichat.view regex, no divergent terms', () => {
		const action = new ComposerAcceptComposerStepAction();
		const kbs = keybindingsOf(action);
		for (const kb of kbs) {
			const serialized = kb.when?.serialize() ?? '';
			// The binary's own focus term, kept verbatim.
			assert.ok(serialized.includes('composerFocused'), `when must reference composerFocused: ${serialized}`);
			// Fork map of the binary's /^workbench.panel.aichat.view/ (serialized
			// with the regex's escaped dots).
			assert.ok(serialized.includes('composer\\.chat'), `when must map the aichat.view regex (composer.chat): ${serialized}`);
			assert.ok(serialized.includes('ideAgent\\.chatView'), `when must map the aichat.view regex (ideAgent.chatView): ${serialized}`);
			assert.ok(serialized.includes('composerSubmitOnCmdEnterEnabled'), `when must gate on composerSubmitOnCmdEnterEnabled: ${serialized}`);
			// The old divergent port used resourceScheme == 'ide-chat' — gone.
			assert.ok(!serialized.includes('ide-chat'), `when must not use the divergent resourceScheme term: ${serialized}`);
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
});
