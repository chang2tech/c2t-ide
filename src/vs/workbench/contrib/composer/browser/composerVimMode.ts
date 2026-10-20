/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// IDE-CODE: Vim mode toggle action — Cursor parity (feature `vim-mode-toggle`,
// P2; logic + verbatim evidence in common/vimMode.ts).
//
// Registers `cursor.removevim` ("Cursor Vim: Remove Vim Mode") in the command
// palette (f1:true — verbatim binary evidence). The handler uninstalls the
// installed Vim-emulation extension(s); see the QA NOTE and
// HONEST-DIVERGENCE in common/vimMode.ts (notably: `editor.cpp.disableenabled`
// is Cursor Tab wire, not vim, and no "enable" command has evidence).

import { localize, localize2 } from '../../../../nls.js';
import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { IExtensionManagementService } from '../../../../platform/extensionManagement/common/extensionManagement.js';
import { ExtensionType } from '../../../../platform/extensions/common/extensions.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { findVimEmulationExtensions, REMOVE_VIM_MODE_COMMAND_ID, REMOVE_VIM_MODE_COMMAND_TITLE, REMOVE_VIM_MODE_IN_COMMAND_PALETTE, VIM_MODE_CATEGORY } from '../common/vimMode.js';

export class RemoveVimModeAction extends Action2 {

	static readonly ID = REMOVE_VIM_MODE_COMMAND_ID;

	constructor() {
		super({
			id: RemoveVimModeAction.ID,
			// Verbatim binary title.
			title: localize2('cursor.removevim', REMOVE_VIM_MODE_COMMAND_TITLE),
			// Implied by the title's "Cursor Vim:" prefix (UNKNOWN: the binary
			// only shows the category key `vim_mode`).
			category: localize2('cursor.vimModeCategory', VIM_MODE_CATEGORY),
			// Verbatim binary evidence: palette command (f1:true).
			f1: REMOVE_VIM_MODE_IN_COMMAND_PALETTE,
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		const extensionManagementService = accessor.get(IExtensionManagementService);
		const notificationService = accessor.get(INotificationService);

		const installed = await extensionManagementService.getInstalled(ExtensionType.User);
		const vimExtensions = findVimEmulationExtensions(installed);
		if (vimExtensions.length === 0) {
			notificationService.info(localize('composer.removeVimMode.none', 'Vim mode is not installed.'));
			return;
		}

		for (const extension of vimExtensions) {
			await extensionManagementService.uninstall(extension);
		}
		notificationService.info(localize('composer.removeVimMode.removed', 'Vim mode has been removed.'));
	}
}

/** Registers the `cursor.removevim` command (called from composer.contribution.ts). */
export function registerVimModeActions(): void {
	registerAction2(RemoveVimModeAction);
}
