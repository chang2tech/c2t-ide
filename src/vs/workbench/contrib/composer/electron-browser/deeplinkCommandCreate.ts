/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// IDE-CODE (DEV-GAPS-64): handler for the internal workbench command
// `deeplink.command.create` — the confirm-and-write step of Cursor's
// one-click command deeplink (`cursor://anysphere.cursor-deeplink/command?
// name=X&text=Y`, matrix feature `deeplink-create-command`).
//
// Binary evidence [BIN] (Cursor 3.25.9):
//   - Extension dispatch: `extensions/cursor-deeplink/dist/main.js` @ 430024
//     — after parse/validation, `commands.executeCommand(
//     "deeplink.command.create", { name, content,
//     correlationId: crypto.randomUUID() })`.
//   - Workbench handler (R2S): `out/vs/workbench/workbench.desktop.main.js`,
//     `registerCommand("deeplink.command.create", R2S)` @ 29972167. The
//     handler: tracks `deeplink.opened`; checks whether the command already
//     exists in the project/home commands dirs; shows a confirmation dialog
//     (title "Create Custom Command" / "Override Custom Command"; lines
//     `This will create a new command "<name>"` / `This will override the
//     existing command "<name>"`, the content itself, and the callout
//     "Review this command content carefully before proceeding"); buttons
//     primary `Add to <workspace folder name>` (id "install-project") or
//     "Add to Home" (id "install-home"), extra "Add to Home" (secondary),
//     cancel "Decline". Cancel → `deeplink.declined`. Accept →
//     `deeplink.accepted` { location: "home" | "project" }, then
//     `createCommand`, then `cursor_command.created` { totalCommandCount },
//     then an Info notification `Command '<name>' created successfully in
//     <location> commands directory: <fsPath>`. Write failure →
//     `deeplink.error` { errorType: "file_system_error" } + an error
//     notification `Failed to create command: <message>`.
//   - Storage service: `getCommandTargetDirectory` @ 39604532 —
//     home → `<userHome>/.cursor/commands`, project →
//     `<workspace.folders[0]>/.cursor/commands` (throws
//     "No workspace folder available for project commands");
//     `getCommandUri` @ 39604860 — `<dir>/<name>.md`;
//     `createCommand` @ 39604963 — create the dir if missing, write the file
//     as UTF-8, refresh the command list.
//
// Layer note (HARD RULE — same layer/mechanism as Cursor): the handler lives
// in workbench core next to the composer, registered via CommandsRegistry;
// the file write targets the same directories the fork's SlashCommandService
// watches, so a created command appears in the `/` menu immediately (the
// binary's explicit `refresh()` maps to the fork's live file watching).
//
// Deliberate adaptations (documented, not forgotten):
//   - Cursor's pretty-dialog service (openDialog with dialogClass/width
//     hints) does not exist in this fork; the confirmation uses the core
//     IDialogService.prompt modal with the same title, message lines and
//     buttons. The visual chrome (520px pretty dialog) is NOT replicated.
//   - Telemetry goes through ITelemetryService.publicLog with the
//     binary-verbatim event names and payloads.
//
// This module is node-safe (no vs/platform imports) so the flow is
// unit-testable end-to-end against a real temp dir; the thin service wiring
// lives in deeplinkActions.ts.

/** The workbench command id — [BIN] verbatim. */
export const DEEPLINK_COMMAND_CREATE_ID = 'deeplink.command.create';

/** Argument object passed by the deeplink extension — [BIN] verbatim shape. */
export interface IDeeplinkCommandCreateArgs {
	name: string;
	content: string;
	correlationId?: string;
}

/** Everything the handler needs from the workbench, injected for tests. */
export interface IDeeplinkCommandCreateEnv {
	/** userHome path (binary: pathService.userHome). */
	userHome: string;
	/** folders[0] of the workspace, when one is open (binary: contextService.getWorkspace().folders[0]). */
	workspaceFolder?: { name: string; fsPath: string };
	fileExists(fsPath: string): Promise<boolean>;
	ensureFolder(fsPath: string): Promise<void>;
	writeFileUtf8(fsPath: string, content: string): Promise<void>;
	/** Number of commands currently known (binary: getCommands().length). */
	countCommands(): Promise<number>;
	/**
	 * Show the confirmation dialog. Returns the chosen location, or
	 * undefined when the user declined/cancelled.
	 */
	confirmCreate(choice: {
		title: string;
		message: string;
		content: string;
		primaryButton: { id: 'install-project' | 'install-home'; label: string };
		extraButton?: { id: 'install-home'; label: 'Add to Home' };
		cancelLabel: 'Decline';
	}): Promise<'install-project' | 'install-home' | undefined>;
	info(message: string): void;
	error(message: string): void;
	trackEvent(name: string, data: Record<string, unknown>): void;
	newCorrelationId(): string;
}

export type DeeplinkCommandCreateOutcome =
	| { status: 'created'; fsPath: string; location: 'home' | 'project' }
	| { status: 'declined' }
	| { status: 'failed'; error: string };

/** Minimal path plumbing, injected so tests control the separators. */
export interface IDeeplinkPathLike {
	join(...parts: string[]): string;
}

/** [BIN] getCommandTargetDirectory: `<userHome>/.cursor/commands` | `<folders[0]>/.cursor/commands`. */
export function deeplinkCommandTargetDir(env: Pick<IDeeplinkCommandCreateEnv, 'userHome' | 'workspaceFolder'>, toHome: boolean, p: IDeeplinkPathLike): string {
	if (toHome) {
		return p.join(env.userHome, '.cursor', 'commands');
	}
	if (!env.workspaceFolder) {
		throw new Error('No workspace folder available for project commands');
	}
	return p.join(env.workspaceFolder.fsPath, '.cursor', 'commands');
}

/** [BIN] getCommandUri: `<dir>/<name>.md`. */
export function deeplinkCommandFilePath(env: Pick<IDeeplinkCommandCreateEnv, 'userHome' | 'workspaceFolder'>, name: string, toHome: boolean, p: IDeeplinkPathLike): string {
	return p.join(deeplinkCommandTargetDir(env, toHome, p), `${name}.md`);
}

/**
 * The full [BIN] handler flow (R2S): opened event → existence check →
 * confirm dialog → accepted event → create → created event → notify.
 * `sep`/`join` are injected so the module stays platform-agnostic in tests.
 */
export async function runDeeplinkCommandCreate(
	env: IDeeplinkCommandCreateEnv,
	args: IDeeplinkCommandCreateArgs,
	p: IDeeplinkPathLike,
): Promise<DeeplinkCommandCreateOutcome> {
	const name = args.name;
	const content = args.content;
	const correlationId = args.correlationId ?? env.newCorrelationId();

	env.trackEvent('deeplink.opened', {
		type: 'command',
		correlationId,
		commandName: name,
		commandLength: content.length,
	});

	const hasWorkspace = !!env.workspaceFolder;
	let existsInProject = false;
	let existsInHome = false;
	try {
		existsInHome = await env.fileExists(deeplinkCommandFilePath(env, name, true, p));
		if (hasWorkspace) {
			existsInProject = await env.fileExists(deeplinkCommandFilePath(env, name, false, p));
		}
	} catch {
		// [BIN] existence failures are swallowed; both flags stay false.
	}
	const exists = existsInProject || existsInHome;

	const choice = await env.confirmCreate({
		title: exists ? 'Override Custom Command' : 'Create Custom Command',
		message: exists
			? `This will override the existing command "${name}"`
			: `This will create a new command "${name}"`,
		content,
		primaryButton: hasWorkspace
			? { id: 'install-project', label: `Add to ${env.workspaceFolder!.name}` }
			: { id: 'install-home', label: 'Add to Home' },
		extraButton: hasWorkspace ? { id: 'install-home', label: 'Add to Home' } : undefined,
		cancelLabel: 'Decline',
	});

	if (choice === undefined) {
		env.trackEvent('deeplink.declined', {
			type: 'command',
			correlationId,
			commandName: name,
		});
		return { status: 'declined' };
	}

	const toHome = choice === 'install-home';
	const location: 'home' | 'project' = toHome ? 'home' : 'project';
	env.trackEvent('deeplink.accepted', {
		type: 'command',
		correlationId,
		commandName: name,
		commandLength: content.length,
		location,
	});

	try {
		// [BIN] createCommand: create the target dir only when missing.
		const dir = deeplinkCommandTargetDir(env, toHome, p);
		if (!(await env.fileExists(dir))) {
			await env.ensureFolder(dir);
		}
		const fsPath = deeplinkCommandFilePath(env, name, toHome, p);
		await env.writeFileUtf8(fsPath, content);
		const totalCommandCount = await env.countCommands();
		env.trackEvent('cursor_command.created', {
			commandName: name,
			totalCommandCount,
		});
		env.info(`Command '${name}' created successfully in ${location} commands directory: ${fsPath}`);
		return { status: 'created', fsPath, location };
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		env.trackEvent('deeplink.error', {
			type: 'command',
			correlationId,
			errorType: 'file_system_error',
			errorMessage: message,
			commandName: name,
		});
		env.error(`Failed to create command: ${message}`);
		return { status: 'failed', error: message };
	}
}
