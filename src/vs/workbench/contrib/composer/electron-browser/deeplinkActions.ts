/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// IDE-CODE (DEV-GAPS-64): registers the workbench-core command
// `deeplink.command.create` — the workbench-side half of Cursor's one-click
// command deeplink (`cursor://anysphere.cursor-deeplink/command?name=X&text=Y`).
//
// In Cursor this command is registered in workbench core and called from the
// `cursor-deeplink` extension via
// `commands.executeCommand("deeplink.command.create", {name, content,
// correlationId})` (binary `extensions/cursor-deeplink/dist/main.js`
// @ 430024; registration @ workbench.desktop.main.js 29972167).
//
// The command id is kept VERBATIM (not renamed to `ide.*`): it is the
// extension↔workbench wire id defined by the binary. Service wiring:
//   existence check / dir creation / file write → node:fs/promises
//     (electron-browser modules may use node builtins; the target dirs are
//     exactly the ones the fork's SlashCommandService scans)
//   confirm dialog → IDialogService.prompt (Cursor's pretty-dialog service
//     does not exist in this fork; same title/message/buttons are used)
//   notifications → INotificationService
//   telemetry → ITelemetryService.publicLog with the binary-verbatim names
//   workspace folder → IWorkspaceContextService, home → os.homedir()

import * as os from 'node:os';
import * as path from 'node:path';
import { promises as fs } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { CommandsRegistry } from '../../../../platform/commands/common/commands.js';
import { IDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { INotificationService, Severity } from '../../../../platform/notification/common/notification.js';
import { ITelemetryService } from '../../../../platform/telemetry/common/telemetry.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import {
	DEEPLINK_COMMAND_CREATE_ID,
	IDeeplinkCommandCreateArgs,
	IDeeplinkCommandCreateEnv,
	runDeeplinkCommandCreate,
} from './deeplinkCommandCreate.js';
import {
	DEEPLINK_RULE_CREATE_ID,
	IDeeplinkRuleCreateArgs,
	IDeeplinkRuleCreateEnv,
	runDeeplinkRuleCreate,
} from './deeplinkRuleCreate.js';

async function pathExists(fsPath: string): Promise<boolean> {
	try {
		await fs.stat(fsPath);
		return true;
	} catch {
		return false;
	}
}

CommandsRegistry.registerCommand(DEEPLINK_COMMAND_CREATE_ID, async (accessor, rawArgs: IDeeplinkCommandCreateArgs) => {
	const dialogService = accessor.get(IDialogService);
	const notificationService = accessor.get(INotificationService);
	const telemetryService = accessor.get(ITelemetryService);
	const workspaceContextService = accessor.get(IWorkspaceContextService);

	const folder = workspaceContextService.getWorkspace().folders[0];

	const env: IDeeplinkCommandCreateEnv = {
		userHome: os.homedir(),
		workspaceFolder: folder ? { name: folder.name, fsPath: folder.uri.fsPath } : undefined,
		fileExists: pathExists,
		ensureFolder: (dir) => fs.mkdir(dir, { recursive: true }),
		writeFileUtf8: (fsPath, content) => fs.writeFile(fsPath, content, 'utf8'),
		// The fork's SlashCommandService scans the commands dirs with live
		// watching; a written file is picked up without an explicit refresh,
		// so the created-count is derived from a rescan-equivalent here.
		countCommands: async () => {
			let total = 0;
			const dirs: string[] = [path.join(os.homedir(), '.cursor', 'commands')];
			if (folder) {
				dirs.push(path.join(folder.uri.fsPath, '.cursor', 'commands'));
			}
			for (const dir of dirs) {
				try {
					const entries = await fs.readdir(dir, { withFileTypes: true });
					total += entries.filter((e) => e.isFile() && /\.(md|txt)$/i.test(e.name)).length;
				} catch {
					// missing dir — fine
				}
			}
			return total;
		},
		confirmCreate: async (choice) => {
			const buttons: { label: string; run: () => 'install-project' | 'install-home' }[] = [
				{ label: choice.primaryButton.label, run: () => choice.primaryButton.id },
			];
			if (choice.extraButton) {
				const extraLabel: string = choice.extraButton.label;
				const extraId: 'install-home' = choice.extraButton.id;
				buttons.push({ label: extraLabel, run: () => extraId });
			}
			const result = await dialogService.prompt<'install-project' | 'install-home'>({
				type: Severity.Warning,
				message: choice.title,
				detail: `${choice.message}\n\n${choice.content}\n\nReview this command content carefully before proceeding`,
				buttons,
				cancelButton: choice.cancelLabel,
			});
			return result?.result;
		},
		info: (message) => notificationService.info(message),
		error: (message) => notificationService.error(message),
		trackEvent: (name, data) => telemetryService.publicLog(name, data),
		newCorrelationId: () => randomUUID(),
	};

	await runDeeplinkCommandCreate(env, rawArgs, path);
});

// IDE-CODE (W67D): registers the workbench-core command
// `deeplink.rule.create` — the workbench-side half of Cursor's one-click
// rule deeplink (`cursor://anysphere.cursor-deeplink/rule?name=X&text=Y`).
// In Cursor this command is registered in workbench core (M2S, binary
// `workbench.desktop.main.js` @ 29974087) and called from the
// `cursor-deeplink` extension via `commands.executeCommand(
// "deeplink.rule.create", {name, content, correlationId})`
// (binary `extensions/cursor-deeplink/dist/main.js` @ 430085). The command
// id is kept VERBATIM: it is the extension↔workbench wire id defined by
// the binary. File writes target the `.cursor/rules` directories the
// fork's ProjectRulesService discovers (project rules refresh via its
// file watchers); see deeplinkRuleCreate.ts for the binary spec and the
// documented divergences.
CommandsRegistry.registerCommand(DEEPLINK_RULE_CREATE_ID, async (accessor, rawArgs: IDeeplinkRuleCreateArgs) => {
	const dialogService = accessor.get(IDialogService);
	const notificationService = accessor.get(INotificationService);
	const telemetryService = accessor.get(ITelemetryService);
	const workspaceContextService = accessor.get(IWorkspaceContextService);

	const folder = workspaceContextService.getWorkspace().folders[0];

	const env: IDeeplinkRuleCreateEnv = {
		userHome: os.homedir(),
		workspaceFolder: folder ? { name: folder.name, fsPath: folder.uri.fsPath } : undefined,
		fileExists: pathExists,
		ensureFolder: (dir) => fs.mkdir(dir, { recursive: true }),
		writeFileUtf8: (fsPath, content) => fs.writeFile(fsPath, content, 'utf8'),
		confirmCreate: async (choice) => {
			const buttons: { label: string; run: () => 'install-project' | 'install-home' }[] = [
				{ label: choice.primaryButton.label, run: () => choice.primaryButton.id },
			];
			if (choice.extraButton) {
				const extraLabel: string = choice.extraButton.label;
				const extraId: 'install-home' = choice.extraButton.id;
				buttons.push({ label: extraLabel, run: () => extraId });
			}
			const result = await dialogService.prompt<'install-project' | 'install-home'>({
				type: Severity.Warning,
				message: choice.title,
				detail: `${choice.message}\n\n${choice.content}\n\nReview this rule content carefully before proceeding`,
				buttons,
				cancelButton: choice.cancelLabel,
			});
			return result?.result;
		},
		info: (message) => notificationService.info(message),
		error: (message) => notificationService.error(message),
		trackEvent: (name, data) => telemetryService.publicLog(name, data),
		newCorrelationId: () => randomUUID(),
	};

	await runDeeplinkRuleCreate(env, rawArgs, path);
});
