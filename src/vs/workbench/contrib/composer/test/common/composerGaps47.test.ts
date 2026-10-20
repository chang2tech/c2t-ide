/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import {
	CONNECT_SLACK_COMMAND_ID,
	CONNECT_SLACK_COMMAND_TITLE,
	CONNECT_SLACK_IN_COMMAND_PALETTE,
	INTEGRATIONS_SETTINGS_QUERY,
	OPEN_SETTINGS_COMMAND_ID,
	openIntegrationsSettings,
} from '../../common/slackIntegration.js';
import {
	REMOVE_VIM_MODE_COMMAND_ID,
	REMOVE_VIM_MODE_COMMAND_TITLE,
	REMOVE_VIM_MODE_IN_COMMAND_PALETTE,
	VIM_MODE_CATEGORY,
	findVimEmulationExtensions,
	isVimEmulationExtension,
	IVimExtensionCandidate,
} from '../../common/vimMode.js';

/**
 * DEV-GAPS-47 — two P2 integration/editor features, each evidence-backed.
 *
 * 1. `slack-integration-connect`: feature-matrix.json evidence quote (verbatim):
 *    `Command cursor.connectSlack titled "Connect Slack" (not in command palette).`
 *    Expected behavior (verbatim): "User can connect a Slack workspace from
 *    within the IDE." The OAuth handshake has no binary evidence and is NOT
 *    implemented (see common/slackIntegration.ts HONEST-DIVERGENCE).
 *
 * 2. `vim-mode-toggle`: feature-matrix.json evidence quote (verbatim):
 *    `Command cursor.removevim titled "Cursor Vim: Remove Vim Mode"; related
 *    command editor.cpp.disableenabled.`
 *    QA note: `editor.cpp.disableenabled` is a scanner misassociation (cpp =
 *    Cursor Tab, docs/rea/deep-tab.md) and is deliberately NOT part of this
 *    feature; no "enable" command has evidence and is excluded per the QA
 *    2-step rule.
 */

function vimCandidate(id: string, displayName?: string): IVimExtensionCandidate {
	return { identifier: { id }, manifest: displayName === undefined ? undefined : { displayName } };
}

suite('slack-integration-connect (GAPS-47)', () => {

	suite('verbatim binary surface', () => {
		test('command id is cursor.connectSlack', () => {
			assert.strictEqual(CONNECT_SLACK_COMMAND_ID, 'cursor.connectSlack');
		});

		test('command title is "Connect Slack"', () => {
			assert.strictEqual(CONNECT_SLACK_COMMAND_TITLE, 'Connect Slack');
		});

		test('command is NOT in the command palette (verbatim: "not in command palette")', () => {
			assert.strictEqual(CONNECT_SLACK_IN_COMMAND_PALETTE, false);
		});
	});

	suite('connect flow — opens the integrations settings surface', () => {
		test('executes workbench.action.openSettings with query "integrations"', async () => {
			const calls: { id: string; args: unknown[] }[] = [];
			const commandService = {
				executeCommand: async (id: string, ...args: unknown[]) => {
					calls.push({ id, args });
					return undefined;
				},
			};
			await openIntegrationsSettings(commandService);
			assert.strictEqual(calls.length, 1);
			assert.strictEqual(calls[0].id, OPEN_SETTINGS_COMMAND_ID);
			assert.strictEqual(calls[0].id, 'workbench.action.openSettings');
			assert.deepStrictEqual(calls[0].args, [{ query: INTEGRATIONS_SETTINGS_QUERY }]);
			assert.strictEqual(INTEGRATIONS_SETTINGS_QUERY, 'integrations');
		});
	});
});

suite('vim-mode-toggle (GAPS-47)', () => {

	suite('verbatim binary surface', () => {
		test('command id is cursor.removevim', () => {
			assert.strictEqual(REMOVE_VIM_MODE_COMMAND_ID, 'cursor.removevim');
		});

		test('command title is "Cursor Vim: Remove Vim Mode"', () => {
			assert.strictEqual(REMOVE_VIM_MODE_COMMAND_TITLE, 'Cursor Vim: Remove Vim Mode');
		});

		test('command IS in the command palette (verbatim: "palette command (f1:true)")', () => {
			assert.strictEqual(REMOVE_VIM_MODE_IN_COMMAND_PALETTE, true);
		});

		test('category is the "Cursor Vim" grouping implied by the title', () => {
			assert.strictEqual(VIM_MODE_CATEGORY, 'Cursor Vim');
		});
	});

	suite('isVimEmulationExtension — vim token matcher', () => {
		test('matches vscodevim.vim by id', () => {
			assert.strictEqual(isVimEmulationExtension(vimCandidate('vscodevim.vim', 'Vim')), true);
		});

		test('matches a bundled "Cursor Vim" id case-insensitively', () => {
			assert.strictEqual(isVimEmulationExtension(vimCandidate('cursor.vim')), true);
			assert.strictEqual(isVimEmulationExtension(vimCandidate('publisher.VIM')), true);
		});

		test('matches by display name ("Vim Emulation")', () => {
			assert.strictEqual(isVimEmulationExtension(vimCandidate('publisher.something', 'Vim Emulation')), true);
		});

		test('does not match neovim / revims / unrelated extensions', () => {
			assert.strictEqual(isVimEmulationExtension(vimCandidate('asvetliakov.vscode-neovim', 'NeoVim')), false);
			assert.strictEqual(isVimEmulationExtension(vimCandidate('publisher.revims', 'reVims')), false);
			assert.strictEqual(isVimEmulationExtension(vimCandidate('editorconfig.editorconfig', 'EditorConfig')), false);
		});

		test('handles missing manifest / empty id without throwing', () => {
			assert.strictEqual(isVimEmulationExtension({ identifier: { id: '' } }), false);
		});
	});

	suite('findVimEmulationExtensions — removal candidate list', () => {
		test('filters a mixed installed list down to vim extensions only', () => {
			const installed = [
				vimCandidate('vscodevim.vim', 'Vim'),
				vimCandidate('esbenp.prettier-vscode', 'Prettier'),
				vimCandidate('publisher.vscode-theme', 'Vim Theme'),
			];
			const found = findVimEmulationExtensions(installed);
			assert.deepStrictEqual(found.map(e => e.identifier.id), ['vscodevim.vim', 'publisher.vscode-theme']);
		});

		test('empty installed list → empty result', () => {
			assert.deepStrictEqual(findVimEmulationExtensions([]), []);
		});

		test('no vim extensions installed → empty result', () => {
			assert.deepStrictEqual(findVimEmulationExtensions([vimCandidate('esbenp.prettier-vscode', 'Prettier')]), []);
		});
	});
});
