/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { MenuId } from '../../../../../platform/actions/common/actions.js';
import { KeyCode, KeyMod } from '../../../../../base/common/keyCodes.js';
import { KeybindingWeight } from '../../../../../platform/keybinding/common/keybindingsRegistry.js';
import { ICommandService } from '../../../../../platform/commands/common/commands.js';
import { ServiceIdentifier, ServicesAccessor } from '../../../../../platform/instantiation/common/instantiation.js';
import {
	REPORT_ISSUE_COMMAND_ID,
	REPORT_ISSUE_TITLE,
	ReportIssueAction,
} from '../../browser/feedbackActions.js';

// DEV-GAPS-77 (W77D) — `report-issue-feedback`: Cursor 3.25.9 parity for
// `aiFeedback.action.open` ("Report Issue").
//
// Binary truth (workbench.glass.main.js, 3.25.9 — independently dissected):
// - id: `Nni="aiFeedback.action.open"` @1138493
// - class cbu @43205691: title "Report Issue" (LABEL @43205964), f1:!0,
//   Help menu {group:"3_feedback",order:3}, keybinding CtrlCmd+G
//   (mac: CtrlCmd+G) weight 200, NO when-clause, NO category.
// - run: `e.get(aKi).openPopup()` — the aiFeedback feedback popup.
//
// CORRECTION: the old matrix claim ("cursor.giveFeedback titled 'Report
// Issue'") is refuted — `cursor.giveFeedback` is a separate sibling
// (class ubu @43205800) titled "Give Feedback" (Help menu order 4) with the
// same run body. The fork's `ide.giveFeedback` is that sibling's analog.
//
// These tests cover:
//  A. the registration descriptor is binary-verbatim (id/title/f1/menu/
//     keybinding weight/chords, no when, no category);
//  B. run() delegates to the fork's feedback surface (`ide.giveFeedback` —
//     the same surface Cursor's sibling opens; HONEST-DIVERGENCE: Cursor
//     opens the core aiFeedback popup `aKi.openPopup()`, which has no fork
//     analog).

function accessorFor(stubs: Map<ServiceIdentifier<unknown>, unknown>): ServicesAccessor {
	return { get: <T>(id: ServiceIdentifier<T>): T => stubs.get(id) as T };
}

suite('gaps77: ReportIssueAction (aiFeedback.action.open parity)', () => {

	test('descriptor is binary-verbatim: id/title/f1/menu/keybinding', () => {
		const action = new ReportIssueAction();

		// id: Nni="aiFeedback.action.open" @1138493
		assert.strictEqual(action.desc.id, 'aiFeedback.action.open');
		assert.strictEqual(REPORT_ISSUE_COMMAND_ID, 'aiFeedback.action.open');

		// title: s9b.LABEL="Report Issue" @43205964
		const title = action.desc.title;
		assert.strictEqual(typeof title === 'object' && title.value, 'Report Issue');
		assert.strictEqual(REPORT_ISSUE_TITLE, 'Report Issue');

		// f1:!0 — palette-visible
		assert.strictEqual(action.desc.f1, true);

		// menu: {id:MenubarHelpMenu, group:"3_feedback", order:3}
		const menuRaw = action.desc.menu;
		assert.ok(menuRaw, 'expected a Help menu entry');
		const menu = Array.isArray(menuRaw) ? menuRaw[0] : menuRaw;
		assert.strictEqual(menu.id, MenuId.MenubarHelpMenu);
		assert.strictEqual(menu.group, '3_feedback');
		assert.strictEqual(menu.order, 3);

		// keybinding: CtrlCmd+G (mac: Cmd+G), weight 200, NO when-clause
		const kbRaw = action.desc.keybinding;
		assert.ok(kbRaw, 'expected a keybinding');
		const kb = Array.isArray(kbRaw) ? kbRaw[0] : kbRaw;
		assert.strictEqual(kb.weight, KeybindingWeight.WorkbenchContrib);
		assert.strictEqual(kb.weight, 200);
		assert.strictEqual(kb.primary, KeyMod.CtrlCmd | KeyCode.KeyG);
		assert.deepStrictEqual(kb.mac, { primary: KeyMod.CtrlCmd | KeyCode.KeyG });
		assert.strictEqual(kb.when, undefined);

		// no category in the binary registration
		assert.strictEqual(action.desc.category, undefined);
	});

	test('run() opens the fork feedback surface (ide.giveFeedback)', async () => {
		const calls: Array<{ id: string; args: unknown[] }> = [];
		const commandService = {
			executeCommand: async (id: string, ...args: unknown[]): Promise<unknown> => {
				calls.push({ id, args });
				return undefined;
			},
		} as unknown as ICommandService;
		const accessor = accessorFor(new Map([[ICommandService, commandService]]));

		await new ReportIssueAction().run(accessor);

		assert.deepStrictEqual(calls, [{ id: 'ide.giveFeedback', args: [] }]);
	});
});
