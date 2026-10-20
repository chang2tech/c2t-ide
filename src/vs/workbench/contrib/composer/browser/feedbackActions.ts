/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// IDE-CODE: Cursor feedback-command parity (feature matrix: report-issue-feedback).
//
// Binary registration (Cursor 3.25.9, workbench.glass.main.js — W77D, 2026-10-20,
// independently dissected for DEV-GAPS-77):
//   Nni="aiFeedback.action.open"                                   // @1138493
//   var s9b=class cbu extends ln{constructor(){super({
//     id:Nni,
//     title:{value:cbu.LABEL,original:cbu.LABEL,mnemonicTitle:D(5306,null)},
//     f1:!0,
//     menu:{id:Nt.MenubarHelpMenu,group:"3_feedback",order:3},
//     keybinding:{primary:Xl(wf,dt.CtrlCmd|Xe.KeyG),
//                  mac:{primary:Xl(ag,dt.CtrlCmd|Xe.KeyG)},weight:200}})}
//   run(e,...n){e.get(aKi).openPopup()}};s9b.LABEL="Report Issue";  // @43205691-43205964
//
// CORRECTION to the old matrix claim: the entry said `cursor.giveFeedback` was
// titled "Report Issue". The binary refutes this — `cursor.giveFeedback` is a
// SEPARATE sibling registration (class ubu @43205800): title "Give Feedback",
// f1:!0, Help menu group "3_feedback" order 4, with the SAME run body
// (e.get(aKi).openPopup()). The fork's `ide.giveFeedback` ("Give Feedback",
// extensions/ide-agent) is the analog of THAT sibling; this file ports the
// "Report Issue" sibling.
//
// Keybinding note (faithful quirk): the binary keeps stock
// `workbench.action.gotoLine` ("Go to Line/Column...") on CtrlCmd+G weight 200
// with no when-clause (class Cgy @42768373) ALONGSIDE this command's
// CtrlCmd+G weight 200, no when-clause. In VS Code's KeybindingResolver the
// two tie on weight and the alphabetically-later command
// ("workbench.action.gotoLine" > "aiFeedback.action.open") wins the chord on
// Win/Linux; on mac the chords differ (Cmd+G vs Ctrl+G) so Report Issue wins
// there. This port registers the identical descriptor, so the tie-break
// behaves exactly like Cursor's by construction.
//
// HONEST-DIVERGENCES:
// - run body: Cursor opens the aiFeedback popup service (`aKi.openPopup()`).
//   The fork has no core feedback-popup service; the fork's feedback surface
//   is the extension's `ide.giveFeedback` flow (feedback input persisted to
//   ~/.ide-code/feedback/). Like Cursor's two commands, both entries open the
//   SAME surface.
// - mnemonicTitle: the binary carries nls D(5306); the fork uses the stock
//   "Report &&Issue" mnemonic convention.

import { Action2, MenuId, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { localize, localize2 } from '../../../../nls.js';
import { KeyCode, KeyMod } from '../../../../base/common/keyCodes.js';
import { KeybindingWeight } from '../../../../platform/keybinding/common/keybindingsRegistry.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';

/** Binary-verbatim command id (`Nni="aiFeedback.action.open"`, 3.25.9 @1138493). */
export const REPORT_ISSUE_COMMAND_ID = 'aiFeedback.action.open';

/** Binary-verbatim title (`s9b.LABEL="Report Issue"`, 3.25.9 @43205964). */
export const REPORT_ISSUE_TITLE = 'Report Issue';

/**
 * Cursor parity: `aiFeedback.action.open` ("Report Issue").
 * Palette-visible (f1:!0), Help menu group "3_feedback" order 3,
 * CtrlCmd+G (mac: Cmd+G) weight 200, no when-clause — all binary-verbatim.
 */
export class ReportIssueAction extends Action2 {

	static readonly ID = REPORT_ISSUE_COMMAND_ID;

	constructor() {
		super({
			id: ReportIssueAction.ID,
			title: {
				...localize2('ideReportIssue', REPORT_ISSUE_TITLE),
				// Binary carries mnemonicTitle D(5306) alongside the title.
				mnemonicTitle: localize({ key: 'miReportIssue', comment: ['&& denotes a mnemonic'] }, 'Report &&Issue'),
			},
			f1: true,
			menu: {
				id: MenuId.MenubarHelpMenu,
				group: '3_feedback',
				order: 3,
			},
			keybinding: {
				weight: KeybindingWeight.WorkbenchContrib, // binary: weight 200
				primary: KeyMod.CtrlCmd | KeyCode.KeyG,
				mac: { primary: KeyMod.CtrlCmd | KeyCode.KeyG },
			},
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		// Binary: e.get(aKi).openPopup() — the aiFeedback popup. The fork has
		// no core feedback-popup service; delegate to the fork's feedback
		// surface (the same surface Cursor's sibling `cursor.giveFeedback`
		// opens, and the same one this command's sibling opens in Cursor).
		await accessor.get(ICommandService).executeCommand('ide.giveFeedback');
	}
}

export function registerFeedbackActions(): void {
	registerAction2(ReportIssueAction);
}
