/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// IDE-CODE: Slack integration connect action — Cursor parity (feature
// `slack-integration-connect`, P2; logic + verbatim evidence in
// common/slackIntegration.ts).
//
// Registers `cursor.connectSlack` ("Connect Slack"), hidden from the command
// palette exactly like the Cursor binary (f1:false — verbatim "not in command
// palette"). The handler opens the IDE integrations settings surface; see the
// HONEST-DIVERGENCE note in common/slackIntegration.ts for why no OAuth
// exchange is claimed.

import { localize2 } from '../../../../nls.js';
import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { ComposerActionCategory } from './composerActions.js';
import { CONNECT_SLACK_COMMAND_ID, CONNECT_SLACK_COMMAND_TITLE, CONNECT_SLACK_IN_COMMAND_PALETTE, openIntegrationsSettings } from '../common/slackIntegration.js';

export class ConnectSlackAction extends Action2 {

	static readonly ID = CONNECT_SLACK_COMMAND_ID;

	constructor() {
		super({
			id: ConnectSlackAction.ID,
			// Verbatim binary title.
			title: localize2('cursor.connectSlack', CONNECT_SLACK_COMMAND_TITLE),
			category: ComposerActionCategory,
			// Verbatim binary evidence: "not in command palette".
			f1: CONNECT_SLACK_IN_COMMAND_PALETTE,
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		await openIntegrationsSettings(accessor.get(ICommandService));
	}
}

/** Registers the `cursor.connectSlack` command (called from composer.contribution.ts). */
export function registerSlackIntegrationActions(): void {
	registerAction2(ConnectSlackAction);
}
