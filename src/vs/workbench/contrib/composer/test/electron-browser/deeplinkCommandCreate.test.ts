/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
	DEEPLINK_COMMAND_CREATE_ID,
	IDeeplinkCommandCreateEnv,
	deeplinkCommandFilePath,
	runDeeplinkCommandCreate,
} from '../../electron-browser/deeplinkCommandCreate.js';

/**
 * DEV-GAPS-64 — `deeplink.command.create` handler tests (matrix feature
 * `deeplink-create-command`, Cursor 3.25.9 binary:
 * `workbench.desktop.main.js` handler @ 29972167, storage @ 39604532+).
 *
 * Runs the REAL flow against a REAL temp dir (home + workspace commands
 * dirs); only the UI/telemetry surface is stubbed, since the workbench is
 * not available in unit tests.
 *
 * Binary-verbatim strings asserted here:
 *  - titles "Create Custom Command" / "Override Custom Command"
 *  - `This will create a new command "<name>"` / override wording
 *  - buttons `Add to <folder>` / "Add to Home", cancel "Decline"
 *  - notify `Command '<name>' created successfully in home|project commands
 *    directory: <fsPath>`
 *  - error `Failed to create command: <message>`
 */

interface StubEnv extends IDeeplinkCommandCreateEnv {
	infos: string[];
	errors: string[];
	events: { name: string; data: Record<string, unknown> }[];
	choice: 'install-project' | 'install-home' | undefined;
	lastConfirm?: Parameters<IDeeplinkCommandCreateEnv['confirmCreate']>[0];
}

function createStubEnv(root: string, withWorkspace: boolean): StubEnv {
	const home = path.join(root, 'home');
	const project = path.join(root, 'project');
	const env: StubEnv = {
		infos: [],
		errors: [],
		events: [],
		choice: undefined,
		userHome: home,
		workspaceFolder: withWorkspace ? { name: 'myproj', fsPath: project } : undefined,
		fileExists: async (p) => fs.existsSync(p),
		ensureFolder: async (p) => { await fs.promises.mkdir(p, { recursive: true }); },
		writeFileUtf8: async (p, content) => { await fs.promises.writeFile(p, content, 'utf8'); },
		countCommands: async () => {
			let total = 0;
			for (const dir of [path.join(home, '.cursor', 'commands'), path.join(project, '.cursor', 'commands')]) {
				try {
					total += (await fs.promises.readdir(dir)).filter((f) => /\.(md|txt)$/i.test(f)).length;
				} catch { /* missing dir */ }
			}
			return total;
		},
		confirmCreate: async (choice) => {
			env.lastConfirm = choice;
			return env.choice;
		},
		info: (m) => env.infos.push(m),
		error: (m) => env.errors.push(m),
		trackEvent: (name, data) => env.events.push({ name, data }),
		newCorrelationId: () => 'test-correlation-id',
	};
	return env;
}

suite('DEV-GAPS-64 deeplink.command.create', () => {
	let tmp: string;
	setup(() => {
		tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'deeplink-create-'));
	});
	teardown(() => {
		fs.rmSync(tmp, { recursive: true, force: true });
	});

	test('command id is the binary-verbatim wire id', () => {
		assert.strictEqual(DEEPLINK_COMMAND_CREATE_ID, 'deeplink.command.create');
	});

	test('target paths read/write the .cursor/commands layout', () => {
		const env = createStubEnv(tmp, true);
		assert.strictEqual(
			deeplinkCommandFilePath(env, 'deploy', true, path),
			path.join(tmp, 'home', '.cursor', 'commands', 'deploy.md'),
		);
		assert.strictEqual(
			deeplinkCommandFilePath(env, 'deploy', false, path),
			path.join(tmp, 'project', '.cursor', 'commands', 'deploy.md'),
		);
	});

	test('create in home: dialog wording, file written verbatim, info notify, events', async () => {
		const env = createStubEnv(tmp, true);
		env.choice = 'install-home';
		const outcome = await runDeeplinkCommandCreate(env, { name: 'deploy', content: 'Run the deploy script', correlationId: 'cid-1' }, path);
		assert.strictEqual(outcome.status, 'created');
		if (outcome.status !== 'created') {
			return;
		}
		assert.strictEqual(outcome.location, 'home');
		assert.strictEqual(fs.readFileSync(outcome.fsPath, 'utf8'), 'Run the deploy script');
		// dialog: create wording + buttons
		assert.strictEqual(env.lastConfirm?.title, 'Create Custom Command');
		assert.strictEqual(env.lastConfirm?.message, 'This will create a new command "deploy"');
		assert.strictEqual(env.lastConfirm?.primaryButton.label, 'Add to myproj');
		assert.strictEqual(env.lastConfirm?.extraButton?.label, 'Add to Home');
		assert.strictEqual(env.lastConfirm?.cancelLabel, 'Decline');
		// notify verbatim
		assert.deepStrictEqual(env.infos, [`Command 'deploy' created successfully in home commands directory: ${outcome.fsPath}`]);
		// event sequence + payloads
		assert.deepStrictEqual(env.events.map((e) => e.name), ['deeplink.opened', 'deeplink.accepted', 'cursor_command.created']);
		assert.strictEqual(env.events[0].data.commandLength, 'Run the deploy script'.length);
		assert.strictEqual(env.events[1].data.location, 'home');
		assert.strictEqual(env.events[2].data.totalCommandCount, 1);
	});

	test('create in project: writes to <folder>/.cursor/commands, location "project"', async () => {
		const env = createStubEnv(tmp, true);
		env.choice = 'install-project';
		const outcome = await runDeeplinkCommandCreate(env, { name: 'gen', content: 'Generate things' }, path);
		assert.strictEqual(outcome.status, 'created');
		if (outcome.status !== 'created') {
			return;
		}
		assert.strictEqual(outcome.fsPath, path.join(tmp, 'project', '.cursor', 'commands', 'gen.md'));
		assert.strictEqual(fs.readFileSync(outcome.fsPath, 'utf8'), 'Generate things');
		assert.deepStrictEqual(env.infos, [`Command 'gen' created successfully in project commands directory: ${outcome.fsPath}`]);
	});

	test('existing command → Override wording', async () => {
		const env = createStubEnv(tmp, true);
		const existing = deeplinkCommandFilePath(env, 'deploy', true, path);
		await fs.promises.mkdir(path.dirname(existing), { recursive: true });
		await fs.promises.writeFile(existing, 'old content', 'utf8');
		env.choice = 'install-home';
		const outcome = await runDeeplinkCommandCreate(env, { name: 'deploy', content: 'new content' }, path);
		assert.strictEqual(outcome.status, 'created');
		assert.strictEqual(env.lastConfirm?.title, 'Override Custom Command');
		assert.strictEqual(env.lastConfirm?.message, 'This will override the existing command "deploy"');
		assert.strictEqual(fs.readFileSync(existing, 'utf8'), 'new content');
	});

	test('decline: no file written, declined event, no notifications', async () => {
		const env = createStubEnv(tmp, true);
		env.choice = undefined;
		const outcome = await runDeeplinkCommandCreate(env, { name: 'deploy', content: 'x' }, path);
		assert.strictEqual(outcome.status, 'declined');
		assert.deepStrictEqual(env.events.map((e) => e.name), ['deeplink.opened', 'deeplink.declined']);
		assert.deepStrictEqual(env.infos, []);
		assert.strictEqual(fs.existsSync(path.join(tmp, 'home', '.cursor', 'commands', 'deploy.md')), false);
	});

	test('no workspace: primary button is "Add to Home", no extra button', async () => {
		const env = createStubEnv(tmp, false);
		env.choice = 'install-home';
		const outcome = await runDeeplinkCommandCreate(env, { name: 'solo', content: 'x' }, path);
		assert.strictEqual(outcome.status, 'created');
		assert.strictEqual(env.lastConfirm?.primaryButton.label, 'Add to Home');
		assert.strictEqual(env.lastConfirm?.extraButton, undefined);
	});

	test('write failure: deeplink.error event + verbatim error notification', async () => {
		const env = createStubEnv(tmp, true);
		env.choice = 'install-home';
		env.writeFileUtf8 = async () => { throw new Error('disk full'); };
		const outcome = await runDeeplinkCommandCreate(env, { name: 'deploy', content: 'x' }, path);
		assert.strictEqual(outcome.status, 'failed');
		const last = env.events[env.events.length - 1];
		assert.strictEqual(last.name, 'deeplink.error');
		assert.strictEqual(last.data.errorType, 'file_system_error');
		assert.deepStrictEqual(env.errors, ['Failed to create command: disk full']);
	});
});
