/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// IDE-CODE (W67D): handler for the internal workbench command
// `deeplink.rule.create` — the confirm-and-write step of Cursor's
// one-click rule deeplink (`cursor://anysphere.cursor-deeplink/rule?
// name=X&text=Y`, matrix feature `deeplink-create-rule`).
//
// Binary evidence [BIN] (Cursor 3.25.9):
//   - Extension dispatch: `extensions/cursor-deeplink/dist/main.js` route
//     `Zs` @ 430085 — after parse/validation,
//     `commands.executeCommand("deeplink.rule.create", { name, content,
//     correlationId: crypto.randomUUID() })`.
//   - Workbench handler (M2S): `out/vs/workbench/workbench.desktop.main.js`,
//     `registerCommand("deeplink.rule.create", M2S)` @ 29974087 (fn body
//     @ 29972223). The handler: tracks `deeplink.opened` { type: "rule" };
//     checks whether the rule already exists via the rules service's
//     `getRuleUri(name, isGlobal)` (home first in the array, project
//     unshifted when a workspace is open; ANY failure is swallowed and
//     both flags stay false); shows a confirmation dialog (title
//     "Create Custom Rule" / "Override Custom Rule"; lines
//     `This will create a new rule "<name>"` / `This will override the
//     existing rule "<name>"`, the content itself, and the callout
//     "Review this rule content carefully before proceeding"); buttons
//     primary `Add to <workspace folder name>` (id "install-project") or
//     "Add to Home" (id "install-home"), extra "Add to Home" (secondary,
//     only with a workspace), cancel "Decline". Cancel →
//     `deeplink.declined`. Accept → `deeplink.accepted` { location:
//     "home" | "project" }, then `createRule(name, content, toHome)`, then
//     an Info notification `Rule '<name>' created successfully in
//     <location> rules directory: <fsPath>`. Write failure →
//     `deeplink.error` { errorType: "file_system_error", errorMessage,
//     ruleName } + an error notification `Failed to create rule: <message>`.
//     NOTE: unlike `/command`, the rule flow tracks NO "created" event
//     after a successful write — verified in the M2S body.
//   - Rules service (BR): `getRuleTargetDirectory` @ 31043881 —
//     home → `<userHome>/.cursor/rules`, project →
//     `<workspace.folders[0]>/.cursor/rules` (throws
//     "No workspace folder available for project rules");
//     `getRuleUri` @ 31044197 — `<dir>/<name>.mdc`;
//     `createRule` @ 31044289 — create the dir if missing, write the file
//     as UTF-8 with frontmatter `---\nalwaysApply: true\n---\n\n` +
//     `content.trimEnd()` + `\n` (deeplink passes no options, so
//     `alwaysApply` defaults to true and no `globs` line is emitted),
//     then refresh the rules list.
//
// Layer note (HARD RULE — same layer/mechanism as Cursor): the handler
// lives in workbench core next to the composer, registered via
// CommandsRegistry — exactly where the binary registers it — and writes
// `.mdc` files into the same `.cursor/rules` directories the fork's
// ProjectRulesService discovers, so a created rule is picked up by the
// existing rules pipeline.
//
// Deliberate adaptations (documented, not forgotten):
//   - Cursor's pretty-dialog service (openDialog with dialogClass/width
//     hints) does not exist in this fork; the confirmation uses the core
//     IDialogService.prompt modal with the same title, message lines and
//     buttons. The visual chrome (520px pretty dialog) is NOT replicated.
//     (Same adaptation as `deeplink.command.create`.)
//   - The binary's `createRule` calls the rules service's `refresh()`
//     after writing. The fork's ProjectRulesService watches workspace
//     folders recursively and reloads `.cursor/rules/**/*.mdc` on change,
//     so PROJECT rules are refreshed automatically. HOME rules
//     (`<userHome>/.cursor/rules`) are written to the binary-verbatim
//     path but are NOT scanned by the fork's ProjectRulesService (it only
//     discovers workspace-folder rules) — a pre-existing fork gap, not
//     introduced here.
//   - Telemetry goes through ITelemetryService.publicLog with the
//     binary-verbatim event names and payloads.
//
// This module is node-safe (no vs/platform imports) so the flow is
// unit-testable end-to-end against a real temp dir; the thin service
// wiring lives in deeplinkActions.ts.

/** The workbench command id — [BIN] verbatim. */
export const DEEPLINK_RULE_CREATE_ID = 'deeplink.rule.create';

/** Argument object passed by the deeplink extension — [BIN] verbatim shape. */
export interface IDeeplinkRuleCreateArgs {
	name: string;
	content: string;
	correlationId?: string;
}

/** Everything the handler needs from the workbench, injected for tests. */
export interface IDeeplinkRuleCreateEnv {
	/** userHome path (binary: pathService.userHome). */
	userHome: string;
	/** folders[0] of the workspace, when one is open (binary: contextService.getWorkspace().folders[0]). */
	workspaceFolder?: { name: string; fsPath: string };
	fileExists(fsPath: string): Promise<boolean>;
	ensureFolder(fsPath: string): Promise<void>;
	writeFileUtf8(fsPath: string, content: string): Promise<void>;
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

export type DeeplinkRuleCreateOutcome =
	| { status: 'created'; fsPath: string; location: 'home' | 'project' }
	| { status: 'declined' }
	| { status: 'failed'; error: string };

/** Minimal path plumbing, injected so tests control the separators. */
export interface IDeeplinkRulePathLike {
	join(...parts: string[]): string;
}

/** [BIN] getRuleTargetDirectory: `<userHome>/.cursor/rules` | `<folders[0]>/.cursor/rules`. */
export function deeplinkRuleTargetDir(env: Pick<IDeeplinkRuleCreateEnv, 'userHome' | 'workspaceFolder'>, toHome: boolean, p: IDeeplinkRulePathLike): string {
	if (toHome) {
		return p.join(env.userHome, '.cursor', 'rules');
	}
	if (!env.workspaceFolder) {
		throw new Error('No workspace folder available for project rules');
	}
	return p.join(env.workspaceFolder.fsPath, '.cursor', 'rules');
}

/** [BIN] getRuleUri: `<dir>/<name>.mdc`. */
export function deeplinkRuleFilePath(env: Pick<IDeeplinkRuleCreateEnv, 'userHome' | 'workspaceFolder'>, name: string, toHome: boolean, p: IDeeplinkRulePathLike): string {
	return p.join(deeplinkRuleTargetDir(env, toHome, p), `${name}.mdc`);
}

/**
 * [BIN] createRule file body: frontmatter `---\nalwaysApply: true\n---\n\n`
 * (deeplink passes no options → alwaysApply defaults true, no globs line)
 * followed by the content, trailing-trimmed, plus a final newline.
 */
export function deeplinkRuleFileContent(content: string): string {
	return `---\nalwaysApply: true\n---\n\n${content.trimEnd()}\n`;
}

/**
 * The full [BIN] handler flow (M2S): opened event → existence check →
 * confirm dialog → accepted event → create → notify.
 * `sep`/`join` are injected so the module stays platform-agnostic in tests.
 */
export async function runDeeplinkRuleCreate(
	env: IDeeplinkRuleCreateEnv,
	args: IDeeplinkRuleCreateArgs,
	p: IDeeplinkRulePathLike,
): Promise<DeeplinkRuleCreateOutcome> {
	const name = args.name;
	const content = args.content;
	const correlationId = args.correlationId ?? env.newCorrelationId();

	env.trackEvent('deeplink.opened', {
		type: 'rule',
		correlationId,
		ruleName: name,
		ruleLength: content.length,
	});

	const hasWorkspace = !!env.workspaceFolder;
	let existsInProject = false;
	let existsInHome = false;
	try {
		existsInHome = await env.fileExists(deeplinkRuleFilePath(env, name, true, p));
		if (hasWorkspace) {
			existsInProject = await env.fileExists(deeplinkRuleFilePath(env, name, false, p));
		}
	} catch {
		// [BIN] existence failures are swallowed; both flags stay false.
	}
	const exists = existsInProject || existsInHome;

	const choice = await env.confirmCreate({
		title: exists ? 'Override Custom Rule' : 'Create Custom Rule',
		message: exists
			? `This will override the existing rule "${name}"`
			: `This will create a new rule "${name}"`,
		content,
		primaryButton: hasWorkspace
			? { id: 'install-project', label: `Add to ${env.workspaceFolder!.name}` }
			: { id: 'install-home', label: 'Add to Home' },
		extraButton: hasWorkspace ? { id: 'install-home', label: 'Add to Home' } : undefined,
		cancelLabel: 'Decline',
	});

	if (choice === undefined) {
		env.trackEvent('deeplink.declined', {
			type: 'rule',
			correlationId,
			ruleName: name,
		});
		return { status: 'declined' };
	}

	const toHome = choice === 'install-home';
	const location: 'home' | 'project' = toHome ? 'home' : 'project';
	env.trackEvent('deeplink.accepted', {
		type: 'rule',
		correlationId,
		ruleName: name,
		ruleLength: content.length,
		location,
	});

	try {
		// [BIN] createRule: create the target dir only when missing.
		const dir = deeplinkRuleTargetDir(env, toHome, p);
		if (!(await env.fileExists(dir))) {
			await env.ensureFolder(dir);
		}
		const fsPath = deeplinkRuleFilePath(env, name, toHome, p);
		await env.writeFileUtf8(fsPath, deeplinkRuleFileContent(content));
		env.info(`Rule '${name}' created successfully in ${location} rules directory: ${fsPath}`);
		return { status: 'created', fsPath, location };
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		env.trackEvent('deeplink.error', {
			type: 'rule',
			correlationId,
			errorType: 'file_system_error',
			errorMessage: message,
			ruleName: name,
		});
		env.error(`Failed to create rule: ${message}`);
		return { status: 'failed', error: message };
	}
}
