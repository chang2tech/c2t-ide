/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// IDE-CODE: `ide.ndjsonIngest.*` core commands — the workbench-core analogs
// of the `cursor.ndjsonIngest.*` commands contributed by Cursor's
// `cursor-ndjson-ingest` extension (GAPS-46B, 2026-10-20; `.start` completed
// by GAPS-161, 2026-10-20; binary evidence in debugIngestCommands.ts).
//
// Layer: Cursor contributes these from its extension (`contributes.commands`
// + activationEvents onCommand:start/reassignPort). In this fork the
// extension layer was migrated into workbench-core (CAT-B), so the analog
// registers via `registerAction2` in this desktop-only (electron-browser/)
// module — the same precedent as F7's `glassWindowActions.ts`. Desktop-only
// is correct: the ingest server binds a localhost TCP port (node http).
//
// The module owns one lazy DebugServerService — the analog of the binary's
// module-level server handle `p` (one ingest server per window, like the
// extension's singleton). The per-tab debug-turn servers owned by
// ComposerDataService are untouched; these commands are the manual
// start/stop/inspect surface, like the extension's palette commands.

import { localize2 } from '../../../../nls.js';
import { Action } from '../../../../base/common/actions.js';
import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IClipboardService } from '../../../../platform/clipboard/common/clipboardService.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { INotificationService, Severity } from '../../../../platform/notification/common/notification.js';
import { DebugServerService } from './debugServerService.js';
import {
	IDebugIngestCommandDeps,
	IDebugIngestCommandUi,
	NDJSON_INGEST_COMMAND_IDS,
	copyDebugIngestCurl,
	reassignDebugIngestPort,
	showDebugIngestStatus,
	startDebugIngestServer,
	stopDebugIngestServer,
} from './debugIngestCommands.js';

let sharedServer: DebugServerService | undefined;

/** The window-wide ingest server these commands act on (binary's module-level `p`). */
export function getDebugIngestServer(): DebugServerService {
	if (!sharedServer) {
		sharedServer = new DebugServerService();
	}
	return sharedServer;
}

function createDeps(accessor: ServicesAccessor): IDebugIngestCommandDeps {
	const notificationService = accessor.get(INotificationService);
	const clipboardService = accessor.get(IClipboardService);
	const configurationService = accessor.get(IConfigurationService);
	const commandService = accessor.get(ICommandService);

	const ui: IDebugIngestCommandUi = {
		showInformationMessage: (message) => {
			notificationService.info(message);
		},
		showWarningMessage: (message) => {
			notificationService.warn(message);
		},
		showErrorMessage: (message, actions) => {
			// Binary's j(): error message with a "Change Port" button.
			notificationService.notify({
				severity: Severity.Error,
				message,
				actions: {
					primary: (actions ?? []).map(
						(a) =>
							new Action(
								`${NDJSON_INGEST_COMMAND_IDS.reassignPort}.changePort`,
								a.label,
								undefined,
								true,
								() => {
									a.run();
								},
							),
					),
				},
			});
		},
		clipboardWriteText: (text) => clipboardService.writeText(text),
		// Binary's j(): the "Change Port" button runs
		// `workbench.action.openWorkspaceSettings` with the port key
		// (binary-verbatim @~5670 of cursor-ndjson-ingest/dist/main.js).
		openSettings: (query) =>
			commandService.executeCommand('workbench.action.openWorkspaceSettings', query),
	};

	return {
		server: getDebugIngestServer(),
		// Fork analog of the binary's `vscode.workspace.getConfiguration("ndjson").get("port", 0)`.
		getConfiguredPort: () => configurationService.getValue<number>('ide.debug.ndjsonPort') ?? 0,
		ui,
	};
}

class StartDebugIngestServerAction extends Action2 {
	static readonly ID = NDJSON_INGEST_COMMAND_IDS.start;

	constructor() {
		super({
			id: StartDebugIngestServerAction.ID,
			title: localize2('composer.debugIngest.start', 'NDJSON Ingest: Start Server'),
			f1: true,
			metadata: {
				description:
					'Start the Debug-mode NDJSON log ingest server (analog of Cursor\'s cursor.ndjsonIngest.start). Returns {externalUrl, logPath} on success, an error string on failure, like the binary.',
			},
		});
	}

	async run(accessor: ServicesAccessor, arg?: unknown): Promise<unknown> {
		// The binary's command returns its result to programmatic callers
		// (Cursor core's debugServerService.getConfig consumes it), so the
		// handler's value is returned instead of being swallowed.
		return startDebugIngestServer(createDeps(accessor), arg as Parameters<typeof startDebugIngestServer>[1]);
	}
}

class StopDebugIngestServerAction extends Action2 {
	static readonly ID = NDJSON_INGEST_COMMAND_IDS.stop;

	constructor() {
		super({
			id: StopDebugIngestServerAction.ID,
			title: localize2('composer.debugIngest.stop', 'NDJSON Ingest: Stop Server'),
			f1: true,
			metadata: {
				description:
					'Stop the Debug-mode NDJSON log ingest server (analog of Cursor\'s cursor.ndjsonIngest.stop).',
			},
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		await stopDebugIngestServer(createDeps(accessor));
	}
}

class CopyDebugIngestCurlAction extends Action2 {
	static readonly ID = NDJSON_INGEST_COMMAND_IDS.copyCurl;

	constructor() {
		super({
			id: CopyDebugIngestCurlAction.ID,
			title: localize2('composer.debugIngest.copyCurl', 'NDJSON Ingest: Copy curl command'),
			f1: true,
			metadata: {
				description:
					'Copy a ready-made curl command for the running NDJSON ingest server to the clipboard (analog of Cursor\'s cursor.ndjsonIngest.copyCurl).',
			},
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		await copyDebugIngestCurl(createDeps(accessor));
	}
}

class ReassignDebugIngestPortAction extends Action2 {
	static readonly ID = NDJSON_INGEST_COMMAND_IDS.reassignPort;

	constructor() {
		super({
			id: ReassignDebugIngestPortAction.ID,
			title: localize2('composer.debugIngest.reassignPort', 'NDJSON Ingest: Reassign port and restart server'),
			f1: true,
			metadata: {
				description:
					'Reassign the NDJSON ingest server to a fresh auto-allocated port and restart it (analog of Cursor\'s cursor.ndjsonIngest.reassignPort).',
			},
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		await reassignDebugIngestPort(createDeps(accessor));
	}
}

class ShowDebugIngestStatusAction extends Action2 {
	static readonly ID = NDJSON_INGEST_COMMAND_IDS.showStatus;

	constructor() {
		super({
			id: ShowDebugIngestStatusAction.ID,
			title: localize2('composer.debugIngest.showStatus', 'NDJSON Ingest: Show server info'),
			f1: true,
			metadata: {
				description:
					'Show the NDJSON ingest server URL, or that the server is not running (analog of Cursor\'s cursor.ndjsonIngest.showStatus).',
			},
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		showDebugIngestStatus(createDeps(accessor));
	}
}

registerAction2(StartDebugIngestServerAction);
registerAction2(StopDebugIngestServerAction);
registerAction2(CopyDebugIngestCurlAction);
registerAction2(ReassignDebugIngestPortAction);
registerAction2(ShowDebugIngestStatusAction);
