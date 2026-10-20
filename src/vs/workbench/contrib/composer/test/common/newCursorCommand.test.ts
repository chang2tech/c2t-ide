/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * DEV-GAPS-109 — `cursor-commands` creation commands, pure-logic tests
 * (node:test).
 *
 * Every expectation is pinned to self-verified binary evidence from the
 * reference bundle (QA 2-step rule, step 1), Cursor 3.25.9
 * `out/vs/workbench/workbench.desktop.main.js`:
 * - helper `IMm` @34619208; project id @34620186, user id @34620395,
 *   both `category: File, f1:!0` (palette-visible), no when/keybinding/menu
 * - input strings + validation messages from out/nls.messages.json
 *   indices 7699–7706 (module
 *   `vs/workbench/contrib/mdceditor/browser/mdceditor.contribution`)
 * - name pattern /^[a-z0-9-]+$/ @34619668; template literal @34619889
 */
import { describe, it } from 'node:test';
import assert from 'node:assert';
import {
	COMMAND_EXISTS_MESSAGE,
	COMMAND_NAME_INPUT_TITLE,
	COMMAND_NAME_PLACEHOLDER,
	COMMAND_NAME_PROMPT,
	CURSOR_COMMAND_NAME_PATTERN,
	EMPTY_COMMAND_NAME_MESSAGE,
	INVALID_COMMAND_NAME_MESSAGE,
	INewCursorCommandEnv,
	NEW_PROJECT_CURSOR_COMMAND_ID,
	NEW_PROJECT_CURSOR_COMMAND_TITLE,
	NEW_USER_CURSOR_COMMAND_ID,
	NEW_USER_CURSOR_COMMAND_TITLE,
	buildCursorCommandFileContent,
	cursorCommandTargetDir,
	runNewCursorCommand,
	validateCursorCommandName,
} from '../../common/newCursorCommand.js';

const posixJoin = { join: (...parts: string[]) => parts.join('/') };

interface FakeEnv extends INewCursorCommandEnv {
	files: Map<string, string>;
	dirs: Set<string>;
	promptCalls: number;
	opened: string[];
	scriptedName: string | undefined;
}

function makeEnv(overrides: Partial<FakeEnv> = {}): FakeEnv {
	const env: FakeEnv = {
		userHome: '/home/tester',
		workspaceFolderFsPath: '/ws/project',
		files: new Map<string, string>(),
		dirs: new Set<string>(),
		promptCalls: 0,
		opened: [],
		scriptedName: 'my-command',
		fileExists: async (p: string) => env.files.has(p) || env.dirs.has(p),
		ensureFolder: async (p: string) => { env.dirs.add(p); },
		writeFileUtf8: async (p: string, content: string) => { env.files.set(p, content); },
		promptForName: async validate => {
			env.promptCalls++;
			if (env.scriptedName !== undefined) {
				// The real input box never resolves a name its
				// validateInput rejects; emulate that contract.
				const message = await validate(env.scriptedName);
				assert.strictEqual(message, null, `scripted name should validate, got: ${message}`);
			}
			return env.scriptedName;
		},
		openFile: async (p: string) => { env.opened.push(p); },
		...overrides,
	};
	return env;
}

describe('newCursorCommand: ids + titles (binary verbatim)', () => {
	it('uses the binary-verbatim command ids', () => {
		assert.strictEqual(NEW_PROJECT_CURSOR_COMMAND_ID, 'workbench.action.newProjectCursorCommand');
		assert.strictEqual(NEW_USER_CURSOR_COMMAND_ID, 'workbench.action.newUserCursorCommand');
	});

	it('uses the binary-verbatim titles', () => {
		assert.strictEqual(NEW_PROJECT_CURSOR_COMMAND_TITLE, 'New Project Cursor Command');
		assert.strictEqual(NEW_USER_CURSOR_COMMAND_TITLE, 'New User Cursor Command');
	});
});

describe('newCursorCommand: input box strings (nls 7699-7704 verbatim)', () => {
	it('matches the binary input title/placeholder/prompt', () => {
		assert.strictEqual(COMMAND_NAME_INPUT_TITLE, 'Enter Command Name');
		assert.strictEqual(COMMAND_NAME_PLACEHOLDER, 'e.g., my-custom-command');
		assert.strictEqual(COMMAND_NAME_PROMPT, 'Please enter a name for the new command');
	});

	it('matches the binary validation messages', () => {
		assert.strictEqual(EMPTY_COMMAND_NAME_MESSAGE, 'Command name cannot be empty');
		assert.strictEqual(INVALID_COMMAND_NAME_MESSAGE, 'Command name can only contain lowercase letters, numbers, and hyphens');
		assert.strictEqual(COMMAND_EXISTS_MESSAGE, 'A command with this name already exists');
	});
});

describe('newCursorCommand: validateCursorCommandName (binary validateInput)', () => {
	it('rejects an empty/undefined name first', async () => {
		assert.strictEqual(await validateCursorCommandName('', async () => false), EMPTY_COMMAND_NAME_MESSAGE);
		assert.strictEqual(await validateCursorCommandName(undefined, async () => false), EMPTY_COMMAND_NAME_MESSAGE);
	});

	it('rejects names outside /^[a-z0-9-]+$/ without consulting existence', async () => {
		let existsConsulted = false;
		const exists = async () => { existsConsulted = true; return true; };
		for (const bad of ['My-Command', 'my_command', 'my.command', 'my command', 'café', '-ok but space']) {
			assert.strictEqual(await validateCursorCommandName(bad, exists), INVALID_COMMAND_NAME_MESSAGE, bad);
		}
		assert.strictEqual(existsConsulted, false);
	});

	it('accepts lowercase letters, digits and hyphens (leading hyphen included — binary regex quirk)', async () => {
		assert.ok(CURSOR_COMMAND_NAME_PATTERN.test('-leading-hyphen'));
		for (const good of ['a', 'my-command', 'cmd-2', '123']) {
			assert.strictEqual(await validateCursorCommandName(good, async () => false), null, good);
		}
	});

	it('reports an existing file with the verbatim message', async () => {
		assert.strictEqual(await validateCursorCommandName('taken', async () => true), COMMAND_EXISTS_MESSAGE);
	});
});

describe('newCursorCommand: buildCursorCommandFileContent (binary template verbatim)', () => {
	it('matches the template literal character for character', () => {
		assert.strictEqual(
			buildCursorCommandFileContent('my-command'),
			'# my-command\n\nWrite your command content here.\n\nThis command will be available in chat with /my-command\n',
		);
	});
});

describe('newCursorCommand: cursorCommandTargetDir', () => {
	it('targets <userHome>/.cursor/commands for user commands', () => {
		assert.strictEqual(
			cursorCommandTargetDir({ userHome: '/home/tester', workspaceFolderFsPath: '/ws/project' }, true, posixJoin),
			'/home/tester/.cursor/commands',
		);
	});

	it('targets <folders[0]>/.cursor/commands for project commands', () => {
		assert.strictEqual(
			cursorCommandTargetDir({ userHome: '/home/tester', workspaceFolderFsPath: '/ws/project' }, false, posixJoin),
			'/ws/project/.cursor/commands',
		);
	});
});

describe('newCursorCommand: runNewCursorCommand (binary IMm flow)', () => {
	it('project: creates the dir when missing, writes the template, opens the file', async () => {
		const env = makeEnv();
		const outcome = await runNewCursorCommand(env, false, posixJoin);
		assert.deepStrictEqual(outcome, { status: 'created', fsPath: '/ws/project/.cursor/commands/my-command.md', name: 'my-command' });
		assert.ok(env.dirs.has('/ws/project/.cursor/commands'));
		assert.strictEqual(env.files.get('/ws/project/.cursor/commands/my-command.md'), buildCursorCommandFileContent('my-command'));
		assert.deepStrictEqual(env.opened, ['/ws/project/.cursor/commands/my-command.md']);
	});

	it('user: writes under the user home even with a workspace open', async () => {
		const env = makeEnv();
		const outcome = await runNewCursorCommand(env, true, posixJoin);
		assert.deepStrictEqual(outcome, { status: 'created', fsPath: '/home/tester/.cursor/commands/my-command.md', name: 'my-command' });
		assert.deepStrictEqual(env.opened, ['/home/tester/.cursor/commands/my-command.md']);
	});

	it('project without a workspace: silent no-workspace, prompt never shown (binary returns before input)', async () => {
		const env = makeEnv({ workspaceFolderFsPath: undefined });
		const outcome = await runNewCursorCommand(env, false, posixJoin);
		assert.deepStrictEqual(outcome, { status: 'no-workspace' });
		assert.strictEqual(env.promptCalls, 0);
		assert.strictEqual(env.files.size, 0);
	});

	it('user without a workspace: still creates under the user home', async () => {
		const env = makeEnv({ workspaceFolderFsPath: undefined });
		const outcome = await runNewCursorCommand(env, true, posixJoin);
		assert.strictEqual(outcome.status, 'created');
	});

	it('cancelled prompt: nothing is written or opened', async () => {
		const env = makeEnv({ scriptedName: undefined });
		const outcome = await runNewCursorCommand(env, false, posixJoin);
		assert.deepStrictEqual(outcome, { status: 'cancelled' });
		assert.strictEqual(env.files.size, 0);
		assert.deepStrictEqual(env.opened, []);
	});

	it('does not recreate the commands dir when it already exists', async () => {
		const env = makeEnv();
		env.dirs.add('/ws/project/.cursor/commands');
		let ensureCalls = 0;
		env.ensureFolder = async () => { ensureCalls++; };
		const outcome = await runNewCursorCommand(env, false, posixJoin);
		assert.strictEqual(outcome.status, 'created');
		assert.strictEqual(ensureCalls, 0);
	});

	it('validation inside the flow sees the target dir of the chosen scope', async () => {
		const env = makeEnv();
		env.files.set('/home/tester/.cursor/commands/my-command.md', 'existing');
		// Script a prompt that surfaces the validator result for the user scope.
		env.promptForName = async validate => {
			assert.strictEqual(await validate('my-command'), COMMAND_EXISTS_MESSAGE);
			assert.strictEqual(await validate('other-name'), null);
			return undefined;
		};
		const outcome = await runNewCursorCommand(env, true, posixJoin);
		assert.deepStrictEqual(outcome, { status: 'cancelled' });
		// The pre-existing file is untouched (writeFile is only reached with a validated name).
		assert.strictEqual(env.files.get('/home/tester/.cursor/commands/my-command.md'), 'existing');
	});
});
