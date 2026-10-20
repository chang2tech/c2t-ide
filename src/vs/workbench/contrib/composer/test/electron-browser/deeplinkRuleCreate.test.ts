/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
	DEEPLINK_RULE_CREATE_ID,
	IDeeplinkRuleCreateEnv,
	deeplinkRuleFileContent,
	deeplinkRuleFilePath,
	runDeeplinkRuleCreate,
} from '../../electron-browser/deeplinkRuleCreate.js';

/**
 * W67D — `deeplink.rule.create` handler tests (matrix feature
 * `deeplink-create-rule`, Cursor 3.25.9 binary: `workbench.desktop.main.js`
 * handler M2S @ 29972223, rules service @ 31043881+).
 *
 * Runs the REAL flow against a REAL temp dir (home + workspace rules dirs);
 * only the UI/telemetry surface is stubbed, since the workbench is not
 * available in unit tests.
 *
 * Binary-verbatim strings asserted here:
 *  - titles "Create Custom Rule" / "Override Custom Rule"
 *  - `This will create a new rule "<name>"` / override wording
 *  - buttons `Add to <folder>` / "Add to Home", cancel "Decline"
 *  - file body `---\nalwaysApply: true\n---\n\n<content.trimEnd()>\n`
 *  - notify `Rule '<name>' created successfully in home|project rules
 *    directory: <fsPath>`
 *  - error `Failed to create rule: <message>`
 */

interface StubEnv extends IDeeplinkRuleCreateEnv {
	infos: string[];
	errors: string[];
	events: { name: string; data: Record<string, unknown> }[];
	choice: 'install-project' | 'install-home' | undefined;
	lastConfirm?: Parameters<IDeeplinkRuleCreateEnv['confirmCreate']>[0];
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

suite('W67D deeplink.rule.create', () => {
	let tmp: string;
	setup(() => {
		tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'deeplink-rule-'));
	});
	teardown(() => {
		fs.rmSync(tmp, { recursive: true, force: true });
	});

	test('command id is the binary-verbatim wire id', () => {
		assert.strictEqual(DEEPLINK_RULE_CREATE_ID, 'deeplink.rule.create');
	});

	test('target paths read/write the .cursor/rules layout with .mdc files', () => {
		const env = createStubEnv(tmp, true);
		assert.strictEqual(
			deeplinkRuleFilePath(env, 'style-guide', true, path),
			path.join(tmp, 'home', '.cursor', 'rules', 'style-guide.mdc'),
		);
		assert.strictEqual(
			deeplinkRuleFilePath(env, 'style-guide', false, path),
			path.join(tmp, 'project', '.cursor', 'rules', 'style-guide.mdc'),
		);
	});

	test('frontmatter body matches the binary createRule format verbatim', () => {
		assert.strictEqual(
			deeplinkRuleFileContent('Always indent.\n\n'),
			'---\nalwaysApply: true\n---\n\nAlways indent.\n',
		);
	});

	test('create in home: dialog wording, frontmatter file, info notify, events', async () => {
		const env = createStubEnv(tmp, true);
		env.choice = 'install-home';
		const outcome = await runDeeplinkRuleCreate(env, { name: 'style-guide', content: 'Always use 2-space indent.', correlationId: 'cid-1' }, path);
		assert.strictEqual(outcome.status, 'created');
		if (outcome.status !== 'created') {
			return;
		}
		assert.strictEqual(outcome.location, 'home');
		assert.strictEqual(
			fs.readFileSync(outcome.fsPath, 'utf8'),
			'---\nalwaysApply: true\n---\n\nAlways use 2-space indent.\n',
		);
		// dialog: create wording + buttons
		assert.strictEqual(env.lastConfirm?.title, 'Create Custom Rule');
		assert.strictEqual(env.lastConfirm?.message, 'This will create a new rule "style-guide"');
		assert.strictEqual(env.lastConfirm?.primaryButton.label, 'Add to myproj');
		assert.strictEqual(env.lastConfirm?.extraButton?.label, 'Add to Home');
		assert.strictEqual(env.lastConfirm?.cancelLabel, 'Decline');
		// notify verbatim
		assert.deepStrictEqual(env.infos, [`Rule 'style-guide' created successfully in home rules directory: ${outcome.fsPath}`]);
		// event sequence + payloads (NO "created" event — verified M2S has none)
		assert.deepStrictEqual(env.events.map((e) => e.name), ['deeplink.opened', 'deeplink.accepted']);
		assert.strictEqual(env.events[0].data.type, 'rule');
		assert.strictEqual(env.events[0].data.ruleName, 'style-guide');
		assert.strictEqual(env.events[0].data.ruleLength, 'Always use 2-space indent.'.length);
		assert.strictEqual(env.events[1].data.location, 'home');
	});

	test('create in project: writes to <folder>/.cursor/rules, location "project"', async () => {
		const env = createStubEnv(tmp, true);
		env.choice = 'install-project';
		const outcome = await runDeeplinkRuleCreate(env, { name: 'gen', content: 'Generate things' }, path);
		assert.strictEqual(outcome.status, 'created');
		if (outcome.status !== 'created') {
			return;
		}
		assert.strictEqual(outcome.fsPath, path.join(tmp, 'project', '.cursor', 'rules', 'gen.mdc'));
		assert.deepStrictEqual(env.infos, [`Rule 'gen' created successfully in project rules directory: ${outcome.fsPath}`]);
	});

	test('existing rule → Override wording (detected in home or project)', async () => {
		const env = createStubEnv(tmp, true);
		const existing = deeplinkRuleFilePath(env, 'style-guide', true, path);
		await fs.promises.mkdir(path.dirname(existing), { recursive: true });
		await fs.promises.writeFile(existing, 'old content', 'utf8');
		env.choice = 'install-home';
		const outcome = await runDeeplinkRuleCreate(env, { name: 'style-guide', content: 'new content' }, path);
		assert.strictEqual(outcome.status, 'created');
		assert.strictEqual(env.lastConfirm?.title, 'Override Custom Rule');
		assert.strictEqual(env.lastConfirm?.message, 'This will override the existing rule "style-guide"');
		assert.strictEqual(
			fs.readFileSync(existing, 'utf8'),
			'---\nalwaysApply: true\n---\n\nnew content\n',
		);
	});

	test('decline: no file written, declined event, no notifications', async () => {
		const env = createStubEnv(tmp, true);
		env.choice = undefined;
		const outcome = await runDeeplinkRuleCreate(env, { name: 'style-guide', content: 'x' }, path);
		assert.strictEqual(outcome.status, 'declined');
		assert.deepStrictEqual(env.events.map((e) => e.name), ['deeplink.opened', 'deeplink.declined']);
		assert.deepStrictEqual(env.infos, []);
		assert.strictEqual(fs.existsSync(path.join(tmp, 'home', '.cursor', 'rules', 'style-guide.mdc')), false);
	});

	test('no workspace: primary button is "Add to Home", no extra button', async () => {
		const env = createStubEnv(tmp, false);
		env.choice = 'install-home';
		const outcome = await runDeeplinkRuleCreate(env, { name: 'solo', content: 'x' }, path);
		assert.strictEqual(outcome.status, 'created');
		assert.strictEqual(env.lastConfirm?.primaryButton.label, 'Add to Home');
		assert.strictEqual(env.lastConfirm?.extraButton, undefined);
	});

	test('write failure: deeplink.error event + verbatim error notification', async () => {
		const env = createStubEnv(tmp, true);
		env.choice = 'install-home';
		env.writeFileUtf8 = async () => { throw new Error('disk full'); };
		const outcome = await runDeeplinkRuleCreate(env, { name: 'style-guide', content: 'x' }, path);
		assert.strictEqual(outcome.status, 'failed');
		const last = env.events[env.events.length - 1];
		assert.strictEqual(last.name, 'deeplink.error');
		assert.strictEqual(last.data.errorType, 'file_system_error');
		assert.deepStrictEqual(env.errors, ['Failed to create rule: disk full']);
	});
});
