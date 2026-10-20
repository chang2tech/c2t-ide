/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { KeyCode, KeyMod } from '../../../../../base/common/keyCodes.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { ContextKeyValue, IContext } from '../../../../../platform/contextkey/common/contextkey.js';
import { KeybindingWeight } from '../../../../../platform/keybinding/common/keybindingsRegistry.js';
import { ComposerContextKeys } from '../../common/composerContextKeys.js';
import { GlassEnterEditorPanelFullscreenAction, GlassExitEditorPanelFullscreenAction } from '../../browser/composerActions.js';

function context(values: Record<string, ContextKeyValue>): IContext {
	return { getValue: <T extends ContextKeyValue>(key: string) => values[key] as T | undefined };
}

function fullscreenContext(available: boolean, visible: boolean, fullscreen: boolean): IContext {
	return context({
		[ComposerContextKeys.glassEditorPanelFullscreenAvailable.key]: available,
		[ComposerContextKeys.glassEditorPanelVisible.key]: visible,
		[ComposerContextKeys.glassEditorPanelFullscreen.key]: fullscreen,
	});
}

// Cursor 3.25.9 parity (workbench.glass.main.js, rea audit run 27):
// - `glass.enterEditorPanelFullscreen` — "Enter Full Screen", CtrlCmd+Shift+M,
//   weight gp=250 (verbatim `,gp=250`), keybindingCategory EDITOR_PANEL
//   (Cursor-only concept; VS Code's IKeybindingRule has no such field),
//   when Wlu = ft.and(glassEditorPanelFullscreenAvailable,
//                     glassEditorPanelFullscreen.negate()),
//   availableWhen Wlu, f1:{when:Wlu},
//   run: setEditorPanelFullscreen(true, {entrypoint:"command"}).
// - `glass.exitEditorPanelFullscreen` — "Exit Full Screen", same chord, weight
//   gp=250, keybindingCategory EDITOR_PANEL,
//   when Glu = ft.and(glassEditorPanelVisible, glassEditorPanelFullscreen),
//   availableWhen Glu, f1:{when:Glu},
//   run: setEditorPanelFullscreen(false, {entrypoint:"command"}).
// - SEPARATE surface (kept distinct): "Toggle Fullscreen" (TILE fullscreen,
//   id `_$l`) on CtrlCmd+Shift+KeyM at weight 1602 — NOT ported here.
suite('Composer fullscreen actions (Cursor 3.25.9 parity)', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('command ids are the binary-verbatim glass ids', () => {
		assert.strictEqual(GlassEnterEditorPanelFullscreenAction.ID, 'glass.enterEditorPanelFullscreen');
		assert.strictEqual(GlassExitEditorPanelFullscreenAction.ID, 'glass.exitEditorPanelFullscreen');
		const enter = new GlassEnterEditorPanelFullscreenAction();
		const exit = new GlassExitEditorPanelFullscreenAction();
		assert.strictEqual(enter.desc.id, 'glass.enterEditorPanelFullscreen');
		assert.strictEqual(exit.desc.id, 'glass.exitEditorPanelFullscreen');
	});

	test('availability/fullscreen/visible keys are the binary-verbatim context key names', () => {
		// binary: YDi=new pn("glassEditorPanelFullscreenAvailable",!1);
		// VXt = glassEditorPanelFullscreen; u7 = glassEditorPanelVisible
		assert.strictEqual(ComposerContextKeys.glassEditorPanelFullscreenAvailable.key, 'glassEditorPanelFullscreenAvailable');
		assert.strictEqual(ComposerContextKeys.glassEditorPanelFullscreen.key, 'glassEditorPanelFullscreen');
		assert.strictEqual(ComposerContextKeys.glassEditorPanelVisible.key, 'glassEditorPanelVisible');
	});

	test('enter/exit share the binary chord at the binary weight (250)', () => {
		const enter = new GlassEnterEditorPanelFullscreenAction();
		const exit = new GlassExitEditorPanelFullscreenAction();
		const enterKb = Array.isArray(enter.desc.keybinding) ? enter.desc.keybinding[0] : enter.desc.keybinding;
		const exitKb = Array.isArray(exit.desc.keybinding) ? exit.desc.keybinding[0] : exit.desc.keybinding;

		// binary: keybinding:{weight:gp,...} with gp=250 === KeybindingWeight.SessionsContrib
		assert.strictEqual(enterKb?.weight, KeybindingWeight.SessionsContrib);
		assert.strictEqual(exitKb?.weight, KeybindingWeight.SessionsContrib);
		assert.strictEqual(KeybindingWeight.SessionsContrib, 250);

		// binary: primary: dt.CtrlCmd|dt.Shift|Xe.KeyM
		assert.strictEqual(enterKb?.primary, KeyMod.CtrlCmd | KeyMod.Shift | KeyCode.KeyM);
		assert.strictEqual(exitKb?.primary, KeyMod.CtrlCmd | KeyMod.Shift | KeyCode.KeyM);
	});

	test('enter when + conditional f1 match binary Wlu', () => {
		const action = new GlassEnterEditorPanelFullscreenAction();
		assert.strictEqual(action.desc.f1, true);
		const kb = Array.isArray(action.desc.keybinding) ? action.desc.keybinding[0] : action.desc.keybinding;
		assert.ok(kb?.when, 'keybinding when is defined');
		const whenStr = kb.when!.serialize();
		assert.ok(whenStr.includes('glassEditorPanelFullscreenAvailable'), `enter when must reference the verbatim availability key: "${whenStr}"`);
		assert.ok(whenStr.includes('glassEditorPanelFullscreen'), `enter when must reference the verbatim fullscreen key: "${whenStr}"`);

		// Wlu = glassEditorPanelFullscreenAvailable && !glassEditorPanelFullscreen
		assert.strictEqual(kb.when!.evaluate(fullscreenContext(true, true, false)), true, 'fires when available and not fullscreen');
		assert.strictEqual(kb.when!.evaluate(fullscreenContext(false, true, false)), false, 'blocked when unavailable');
		assert.strictEqual(kb.when!.evaluate(fullscreenContext(true, true, true)), false, 'blocked when already fullscreen');

		// conditional f1 port: VS Code maps the CommandPalette item `when` to
		// `command.precondition`, so binary f1:{when:Wlu} === precondition
		// (NOT an unconditional f1:true).
		assert.ok(action.desc.precondition, 'precondition carries the conditional-f1');
		const preStr = action.desc.precondition!.serialize();
		assert.ok(preStr.includes('glassEditorPanelFullscreenAvailable'), `enter precondition must reference the verbatim availability key: "${preStr}"`);
		assert.strictEqual(action.desc.precondition!.evaluate(fullscreenContext(true, true, false)), true, 'palette-visible when available and not fullscreen');
		assert.strictEqual(action.desc.precondition!.evaluate(fullscreenContext(false, true, false)), false, 'palette-hidden when unavailable');
		assert.strictEqual(action.desc.precondition!.evaluate(fullscreenContext(true, true, true)), false, 'palette-hidden when already fullscreen');
	});

	test('exit when + conditional f1 match binary Glu', () => {
		const action = new GlassExitEditorPanelFullscreenAction();
		assert.strictEqual(action.desc.f1, true);
		const kb = Array.isArray(action.desc.keybinding) ? action.desc.keybinding[0] : action.desc.keybinding;
		assert.ok(kb?.when, 'keybinding when is defined');
		const whenStr = kb.when!.serialize();
		assert.ok(whenStr.includes('glassEditorPanelVisible'), `exit when must reference the verbatim visible key: "${whenStr}"`);
		assert.ok(whenStr.includes('glassEditorPanelFullscreen'), `exit when must reference the verbatim fullscreen key: "${whenStr}"`);
		assert.ok(!whenStr.includes('glassEditorPanelFullscreenAvailable'), `exit when must NOT reference the availability key: "${whenStr}"`);

		// Glu = glassEditorPanelVisible && glassEditorPanelFullscreen
		assert.strictEqual(kb.when!.evaluate(fullscreenContext(true, true, true)), true, 'fires when visible and fullscreen');
		assert.strictEqual(kb.when!.evaluate(fullscreenContext(true, true, false)), false, 'blocked when not fullscreen');
		assert.strictEqual(kb.when!.evaluate(fullscreenContext(true, false, true)), false, 'blocked when panel not visible');

		// conditional f1 port: binary f1:{when:Glu} === precondition
		assert.ok(action.desc.precondition, 'precondition carries the conditional-f1');
		assert.strictEqual(action.desc.precondition!.evaluate(fullscreenContext(true, true, true)), true, 'palette-visible when visible and fullscreen');
		assert.strictEqual(action.desc.precondition!.evaluate(fullscreenContext(true, true, false)), false, 'palette-hidden when not fullscreen');
		assert.strictEqual(action.desc.precondition!.evaluate(fullscreenContext(true, false, true)), false, 'palette-hidden when panel not visible');
	});

	test('enter/exit when clauses are mutually exclusive', () => {
		const enter = new GlassEnterEditorPanelFullscreenAction();
		const exit = new GlassExitEditorPanelFullscreenAction();
		const enterKb = Array.isArray(enter.desc.keybinding) ? enter.desc.keybinding[0] : enter.desc.keybinding;
		const exitKb = Array.isArray(exit.desc.keybinding) ? exit.desc.keybinding[0] : exit.desc.keybinding;
		for (const available of [true, false]) {
			for (const visible of [true, false]) {
				for (const fullscreen of [true, false]) {
					const ctx = fullscreenContext(available, visible, fullscreen);
					const enterFires = enterKb!.when!.evaluate(ctx);
					const exitFires = exitKb!.when!.evaluate(ctx);
					assert.ok(!(enterFires && exitFires), `both fire when available=${available} visible=${visible} fullscreen=${fullscreen}`);
				}
			}
		}
	});

	test('palette titles match the binary', () => {
		const enter = new GlassEnterEditorPanelFullscreenAction();
		const exit = new GlassExitEditorPanelFullscreenAction();
		assert.strictEqual(enter.desc.title.value, 'Enter Full Screen');
		assert.strictEqual(exit.desc.title.value, 'Exit Full Screen');
	});
});
