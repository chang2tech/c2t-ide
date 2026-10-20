/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * IDE-CODE (DEV-GAPS-109, cursor-commands): pure logic behind Cursor's
 * `workbench.action.newProjectCursorCommand` /
 * `workbench.action.newUserCursorCommand` — the two File-category commands
 * that create a new custom command file under `.cursor/commands`.
 * Kept free of any vscode dependency so it can be unit-tested with plain
 * node (same pattern as deeplinkCommandCreate.ts / createRuleFromSelection.ts).
 *
 * Cursor evidence — self-verified 2026-10-20 against the reference binary
 * (QA 2-step rule, step 1), Cursor 3.25.9
 * `out/vs/workbench/workbench.desktop.main.js` (40,751,572 bytes):
 *
 * - Shared helper `async function IMm` @34619208; the two Action2 classes
 *   follow it: project id literal @34620186
 *   (`{id:"workbench.action.newProjectCursorCommand",
 *     title:{value:k(7705,null),original:"New Project Cursor Command"},
 *     category:Yn.File, f1:!0}`, run → `IMm(!1, accessor)`),
 *   user id literal @34620395 (title k(7706) "New User Cursor Command",
 *   run → `IMm(!0, accessor)`). `f1:!0` = palette-visible for both.
 *   No when-clause, no keybinding, no menu contribution exist in the
 *   binary (each id occurs exactly 3 times: the analytics map
 *   @32082632/@32082695 → group "cursor_commands", the Action2
 *   registration, and the Customize-editor caller @37886406/@37886178).
 * - The nls keys of every string below live in
 *   `vs/workbench/contrib/mdceditor/browser/mdceditor.contribution`
 *   (out/nls.keys.json) — i.e. Cursor registers these actions in
 *   workbench core, next to `workbench.action.newCursorRule` @34619061.
 *   This fork has no `mdceditor` contrib, so the fork equivalent lives in
 *   contrib/composer (the fork's Cursor-parity home) — same workbench-core
 *   layer, different subfolder.
 * - Glass bundle check: `workbench.glass.main.js` carries the identical
 *   helper (`async function s3b` @41469733, ids @41470711).
 *
 * Recovered IMm flow (paraphrase of the minified source, strings verbatim):
 *   if (isUser) dir = joinPath(await pathService.userHome({preferLocal:true}), ".cursor", "commands")
 *   else { ws = workspaceContextService.getWorkspace();
 *          if (!ws.folders.length) return;                       // silent
 *          dir = joinPath(ws.folders[0].uri, ".cursor", "commands") }
 *   name = await quickInputService.input({ title, placeHolder, prompt, validateInput });
 *   if (!name) return;
 *   validateInput(v): if (!v) return EMPTY;                        // k(7702)
 *                     if (!/^[a-z0-9-]+$/.test(v)) return INVALID; // k(7703)
 *                     return (await fileService.exists(joinPath(dir, `${v}.md`)))
 *                       ? EXISTS : null;                           // k(7704)
 *   await fileService.exists(dir) || await fileService.createFolder(dir);
 *   file = joinPath(dir, `${name}.md`);
 *   await fileService.writeFile(file, VSBuffer.fromString(template(name)));
 *   if (environmentService.isGlass) {
 *     await commandService.executeCommand("glass.openFileInStableTab", { uri: file.toJSON() }); return;
 *   }
 *   await editorService.openEditor({ resource: file });
 *
 * HONEST DIVERGENCES (fork):
 * - The fork has no glass surface and no `glass.openFileInStableTab`
 *   command (0 hits in the tree), so only the binary's non-glass branch
 *   (`editorService.openEditor({ resource })`, not pinned) is implemented.
 * - The binary resolves paths as URIs (joinPath on URI). The pure flow
 *   below works on fsPath strings with an injected join (the established
 *   deeplinkCommandCreate.ts pattern in this contrib); the browser wiring
 *   adapts the workbench services to it. Observable behavior is identical
 *   for the local workspaces this product targets.
 */

/** Command id, verbatim from the binary (3.25.9 @34620186). */
export const NEW_PROJECT_CURSOR_COMMAND_ID = 'workbench.action.newProjectCursorCommand';

/** Command id, verbatim from the binary (3.25.9 @34620395). */
export const NEW_USER_CURSOR_COMMAND_ID = 'workbench.action.newUserCursorCommand';

/** Command title, verbatim from the binary (nls 7705, `original`). */
export const NEW_PROJECT_CURSOR_COMMAND_TITLE = 'New Project Cursor Command';

/** Command title, verbatim from the binary (nls 7706, `original`). */
export const NEW_USER_CURSOR_COMMAND_TITLE = 'New User Cursor Command';

/** Input-box title, verbatim from the binary (nls 7699, key `newCommandName`). */
export const COMMAND_NAME_INPUT_TITLE = 'Enter Command Name';

/** Input-box placeHolder, verbatim from the binary (nls 7700, key `commandNamePlaceholder`). */
export const COMMAND_NAME_PLACEHOLDER = 'e.g., my-custom-command';

/** Input-box prompt, verbatim from the binary (nls 7701, key `commandNamePrompt`). */
export const COMMAND_NAME_PROMPT = 'Please enter a name for the new command';

/** Validation message for an empty name, verbatim (nls 7702, key `emptyCommandName`). */
export const EMPTY_COMMAND_NAME_MESSAGE = 'Command name cannot be empty';

/** Validation message for a name outside /^[a-z0-9-]+$/, verbatim (nls 7703, key `invalidCommandName`). */
export const INVALID_COMMAND_NAME_MESSAGE = 'Command name can only contain lowercase letters, numbers, and hyphens';

/** Validation message when `<name>.md` already exists, verbatim (nls 7704, key `commandExists`). */
export const COMMAND_EXISTS_MESSAGE = 'A command with this name already exists';

/** Name pattern, verbatim from the binary (@34619668): lowercase letters, digits, hyphens only. */
export const CURSOR_COMMAND_NAME_PATTERN = /^[a-z0-9-]+$/;

/**
 * Content of the created command file — verbatim port of the binary's
 * template literal (@34619889 region):
 *   `# ${name}\n\nWrite your command content here.\n\nThis command will be available in chat with /${name}\n`
 */
export function buildCursorCommandFileContent(name: string): string {
	return `# ${name}\n\nWrite your command content here.\n\nThis command will be available in chat with /${name}\n`;
}

/**
 * The binary's validateInput, step for step (order matters: empty →
 * pattern → already-exists). `fileExistsForName` maps a candidate name to
 * the existence of `<dir>/<name>.md`. Returns the verbatim message or null.
 */
export async function validateCursorCommandName(
	name: string | undefined,
	fileExistsForName: (name: string) => Promise<boolean>,
): Promise<string | null> {
	if (!name) {
		return EMPTY_COMMAND_NAME_MESSAGE;
	}
	if (!CURSOR_COMMAND_NAME_PATTERN.test(name)) {
		return INVALID_COMMAND_NAME_MESSAGE;
	}
	return (await fileExistsForName(name)) ? COMMAND_EXISTS_MESSAGE : null;
}

/** Minimal path plumbing, injected so tests control the separators. */
export interface INewCursorCommandPathLike {
	join(...parts: string[]): string;
}

/** Everything the creation flow needs from the workbench, injected for tests. */
export interface INewCursorCommandEnv {
	/** userHome fsPath (binary: pathService.userHome({ preferLocal: true })). */
	userHome: string;
	/** folders[0] fsPath of the workspace, when one is open (binary: getWorkspace().folders[0]). */
	workspaceFolderFsPath?: string;
	fileExists(fsPath: string): Promise<boolean>;
	ensureFolder(fsPath: string): Promise<void>;
	writeFileUtf8(fsPath: string, content: string): Promise<void>;
	/**
	 * Show the name input box (binary: quickInputService.input with the
	 * verbatim title/placeHolder/prompt above). `validate` is the binary's
	 * validateInput. Resolves undefined when the user cancels.
	 */
	promptForName(validate: (name: string) => Promise<string | null>): Promise<string | undefined>;
	/** Open the created file in an editor (binary: editorService.openEditor({ resource })). */
	openFile(fsPath: string): Promise<void>;
}

export type NewCursorCommandOutcome =
	| { status: 'created'; fsPath: string; name: string }
	| { status: 'cancelled' }
	| { status: 'no-workspace' };

/** [BIN] target dir: `<userHome>/.cursor/commands` | `<folders[0]>/.cursor/commands`. */
export function cursorCommandTargetDir(
	env: Pick<INewCursorCommandEnv, 'userHome' | 'workspaceFolderFsPath'>,
	isUser: boolean,
	p: INewCursorCommandPathLike,
): string {
	if (isUser) {
		return p.join(env.userHome, '.cursor', 'commands');
	}
	if (!env.workspaceFolderFsPath) {
		throw new Error('No workspace folder available for project commands');
	}
	return p.join(env.workspaceFolderFsPath, '.cursor', 'commands');
}

/**
 * The full [BIN] IMm flow: resolve dir (silent return with no workspace
 * for the project variant) → prompt with validation → create dir only
 * when missing → write the verbatim template → open the file.
 */
export async function runNewCursorCommand(
	env: INewCursorCommandEnv,
	isUser: boolean,
	p: INewCursorCommandPathLike,
): Promise<NewCursorCommandOutcome> {
	let dir: string;
	if (isUser) {
		dir = cursorCommandTargetDir(env, true, p);
	} else {
		// Binary: `if (!ws.folders.length) return;` — silent, before any prompt.
		if (!env.workspaceFolderFsPath) {
			return { status: 'no-workspace' };
		}
		dir = cursorCommandTargetDir(env, false, p);
	}

	const name = await env.promptForName(
		async candidate => validateCursorCommandName(candidate, async n => env.fileExists(p.join(dir, `${n}.md`))),
	);
	if (!name) {
		return { status: 'cancelled' };
	}

	// Binary: `await fileService.exists(dir) || await fileService.createFolder(dir)`.
	if (!(await env.fileExists(dir))) {
		await env.ensureFolder(dir);
	}
	const fsPath = p.join(dir, `${name}.md`);
	await env.writeFileUtf8(fsPath, buildCursorCommandFileContent(name));
	await env.openFile(fsPath);
	return { status: 'created', fsPath, name };
}
