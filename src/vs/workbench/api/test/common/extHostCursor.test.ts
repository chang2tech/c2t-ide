/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { Emitter, Event } from '../../../../base/common/event.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import type * as vscode from 'vscode';
import { ExtHostConfigProvider, IExtHostConfiguration } from '../../common/extHostConfiguration.js';
import { IExtHostMpcService } from '../../common/extHostMcp.js';
import { ExtHostCursor, ExtHostCursorPrivacyMode, IAgentHostProvider } from '../../common/extHostCursor.js';

/**
 * Mirrors the real extHost split: `IExtHostConfiguration` resolves config
 * only through the barrier-backed {@link ExtHostConfigProvider}; tests get an
 * already-initialized provider so one microtask flush wires everything up.
 */
class FakeConfigProvider {
	private readonly _onDidChange = new Emitter<vscode.ConfigurationChangeEvent>();
	readonly onDidChangeConfiguration: Event<vscode.ConfigurationChangeEvent> = this._onDidChange.event;

	constructor(private readonly _values: Record<string, unknown> = {}) { }

	getConfiguration(_section?: string): vscode.WorkspaceConfiguration {
		const values = this._values;
		return {
			get: <T>(key: string, defaultValue?: T): T | undefined => {
				const v = values[key];
				return (v !== undefined ? v : defaultValue) as T | undefined;
			},
			has: (key: string) => values[key] !== undefined,
			update: async () => { },
			inspect: () => undefined,
		} as unknown as vscode.WorkspaceConfiguration;
	}

	setValue(key: string, value: unknown): void {
		this._values[key] = value;
		this._onDidChange.fire({ affectsConfiguration: (section: string) => section === `ide.agent.${key}` } as vscode.ConfigurationChangeEvent);
	}
}

class FakeConfig {
	readonly provider: FakeConfigProvider;

	constructor(values: Record<string, unknown> = {}) {
		this.provider = new FakeConfigProvider(values);
	}

	getConfigProvider(): Promise<ExtHostConfigProvider> {
		return Promise.resolve(this.provider as unknown as ExtHostConfigProvider);
	}

	setValue(key: string, value: unknown): void {
		this.provider.setValue(key, value);
	}
}

class FakeMcpService {
	constructor(public mcpServerDefinitions: vscode.McpServerDefinition[] = []) { }
}

async function createCursor(configValues: Record<string, unknown> = {}, mcpDefs: vscode.McpServerDefinition[] = []) {
	const config = new FakeConfig(configValues);
	const mcp = new FakeMcpService(mcpDefs);
	const cursor = new ExtHostCursor(
		config as unknown as IExtHostConfiguration,
		mcp as unknown as IExtHostMpcService,
	);
	// Let the constructor's getConfigProvider().then() run so change
	// listeners are registered before the test body executes.
	await Promise.resolve();
	return { cursor, config, mcp };
}

suite('ExtHostCursor (cursor.* API surface)', async () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('registerAgentHostProvider stores provider; dispose unregisters', async () => {
		const { cursor } = await createCursor();
		const provider: IAgentHostProvider = { clientInstanceId: 'test-1', loop: 'test-loop' };
		const d = cursor.registerAgentHostProvider(provider);
		// re-registering replaces the previous provider (Cursor slot semantics)
		const provider2: IAgentHostProvider = { clientInstanceId: 'test-2' };
		const d2 = cursor.registerAgentHostProvider(provider2);
		d.dispose(); // disposing the stale registration must not clear provider2
		d2.dispose();
		cursor.dispose();
	});

	test('acquireAgentHostRuntime throws when none registered, returns runtime after register', async () => {
		const { cursor } = await createCursor();
		assert.throws(() => cursor.acquireAgentHostRuntime(), /No agent host runtime/);
		const runtime = { turnRuntime: 'turn-1' };
		const d = cursor.registerAgentHostRuntime(runtime);
		assert.strictEqual(cursor.acquireAgentHostRuntime(), runtime);
		d.dispose();
		assert.throws(() => cursor.acquireAgentHostRuntime(), /No agent host runtime/);
		cursor.dispose();
	});

	test('checkFeatureGate reads local ide.agent.featureGates; unknown gates are false', async () => {
		const { cursor } = await createCursor({ featureGates: { 'my-gate': true, 'off-gate': false } });
		assert.strictEqual(await cursor.checkFeatureGate('my-gate'), true);
		assert.strictEqual(await cursor.checkFeatureGate('off-gate'), false);
		assert.strictEqual(await cursor.checkFeatureGate('unknown-gate'), false);
		cursor.dispose();
	});

	test('onDidChangeGates fires when featureGates config changes', async () => {
		const { cursor, config } = await createCursor();
		let fired = 0;
		const d = cursor.onDidChangeGates(() => fired++);
		config.setValue('featureGates', { 'g': true });
		assert.strictEqual(fired, 1);
		config.setValue('dynamicConfig', { 'k': 1 });
		assert.strictEqual(fired, 2);
		d.dispose();
		cursor.dispose();
	});

	test('getDynamicConfigValue reads local ide.agent.dynamicConfig; unknown keys are undefined', async () => {
		const { cursor } = await createCursor({ dynamicConfig: { 'retry_interceptor_config': { maxRetries: 3 } } });
		assert.deepStrictEqual(await cursor.getDynamicConfigValue('retry_interceptor_config'), { maxRetries: 3 });
		assert.strictEqual(await cursor.getDynamicConfigValue('missing-key'), undefined);
		cursor.dispose();
	});

	test('getMcpSnapshots derives snapshots from registered MCP server definitions', async () => {
		const defs = [
			{ label: 'alpha' },
			{ label: 'beta' },
		] as vscode.McpServerDefinition[];
		const { cursor } = await createCursor({}, defs);
		const snapshots = await cursor.getMcpSnapshots({ serializable: true });
		assert.strictEqual(snapshots.length, 2);
		assert.strictEqual(snapshots[0].serverId, 'alpha');
		assert.strictEqual(snapshots[0].serverName, 'alpha');
		assert.strictEqual(snapshots[0].serverIdentifier, 'alpha');
		cursor.dispose();
	});

	test('getMcpSnapshots returns empty array when no servers registered', async () => {
		const { cursor } = await createCursor();
		assert.deepStrictEqual(await cursor.getMcpSnapshots(), []);
		cursor.dispose();
	});

	test('callMcpLeaseTool never fakes success: resolves isError=true (UNKNOWN)', async () => {
		const defs = [{ label: 'alpha' }] as vscode.McpServerDefinition[];
		const { cursor } = await createCursor({}, defs);
		const result = await cursor.callMcpLeaseTool('alpha', 'some-tool', { a: 1 });
		assert.strictEqual(result.isError, true);
		assert.ok(result.content.length > 0);
		assert.ok(result.content[0].text!.includes('not implemented'));
		// unknown server is also reported honestly
		const result2 = await cursor.callMcpLeaseTool('nope', 'some-tool', {});
		assert.strictEqual(result2.isError, true);
		assert.ok(result2.content[0].text!.includes('unknown server'));
		cursor.dispose();
	});

	test('getPrivacyModeEnum defaults to NoStorage; honors ide.agent.privacyMode', async () => {
		const { cursor } = await createCursor();
		assert.strictEqual(cursor.getPrivacyModeEnum(), ExtHostCursorPrivacyMode.NoStorage);

		const { cursor: c2 } = await createCursor({ privacyMode: 'NO_TRAINING' });
		assert.strictEqual(c2.getPrivacyModeEnum(), ExtHostCursorPrivacyMode.NoTraining);
		c2.dispose();

		const { cursor: c3 } = await createCursor({ privacyMode: 'bogus-value' });
		assert.strictEqual(c3.getPrivacyModeEnum(), ExtHostCursorPrivacyMode.NoStorage);
		c3.dispose();

		cursor.dispose();
	});

	test('privacy mode enum values are verbatim from Cursor aiserver.v1.PrivacyMode', async () => {
		assert.strictEqual(ExtHostCursorPrivacyMode.Unspecified, 0);
		assert.strictEqual(ExtHostCursorPrivacyMode.NoStorage, 1);
		assert.strictEqual(ExtHostCursorPrivacyMode.NoTraining, 2);
		assert.strictEqual(ExtHostCursorPrivacyMode.UsageDataTrainingAllowed, 3);
		assert.strictEqual(ExtHostCursorPrivacyMode.UsageCodebaseTrainingAllowed, 4);
	});

	test('isLocalMode reflects ide.agent.localMode setting', async () => {
		const { cursor } = await createCursor();
		assert.strictEqual(cursor.isLocalMode, false);
		cursor.dispose();

		const { cursor: c2 } = await createCursor({ localMode: true });
		assert.strictEqual(c2.isLocalMode, true);
		c2.dispose();
	});

	test('mcp.registerServer registers, lists, and unregisters on dispose', async () => {
		const { cursor } = await createCursor();
		let events = 0;
		const listener = cursor.onDidChangeRegisteredServers(() => events++);

		const d = cursor.registerServer({ name: 'tools', command: 'npx', args: ['my-mcp-server'] });
		assert.strictEqual(events, 1);
		const servers = cursor.getRegisteredServers();
		assert.strictEqual(servers.length, 1);
		assert.strictEqual(servers[0].name, 'tools');
		assert.strictEqual(servers[0].command, 'npx');

		d.dispose();
		assert.strictEqual(events, 2);
		assert.strictEqual(cursor.getRegisteredServers().length, 0);

		listener.dispose();
		cursor.dispose();
	});

	test('mcp.registerServer registers remote (url) servers', async () => {
		const { cursor } = await createCursor();
		const d = cursor.registerServer({ name: 'gh', url: 'https://api.githubcopilot.com/mcp/', headers: { Authorization: 'Bearer x' } });
		assert.strictEqual(cursor.getRegisteredServers().length, 1);
		d.dispose();
		cursor.dispose();
	});

	test('mcp.registerServer validates input', async () => {
		const { cursor } = await createCursor();
		assert.throws(() => cursor.registerServer({ name: '', command: 'x' }), /non-empty string/);
		assert.throws(() => cursor.registerServer({ name: 'a' }), /exactly one of/);
		assert.throws(() => cursor.registerServer({ name: 'a', command: 'x', url: 'https://h' }), /exactly one of/);
		assert.strictEqual(cursor.getRegisteredServers().length, 0);
		cursor.dispose();
	});

	test('mcp.registerServer re-registering the same name replaces (last wins)', async () => {
		const { cursor } = await createCursor();
		const d1 = cursor.registerServer({ name: 'tools', command: 'a' });
		const d2 = cursor.registerServer({ name: 'tools', command: 'b' });
		const servers = cursor.getRegisteredServers();
		assert.strictEqual(servers.length, 1);
		assert.strictEqual(servers[0].command, 'b');
		d1.dispose(); // stale registration must not remove the newer one
		assert.strictEqual(cursor.getRegisteredServers().length, 1);
		d2.dispose();
		assert.strictEqual(cursor.getRegisteredServers().length, 0);
		cursor.dispose();
	});

	test('checkFeatureGate accepts the binary options shape {disableExposureLog:true}', async () => {
		const { cursor } = await createCursor({ featureGates: { 'cursor_blame': true } });
		// Observed call shape: checkFeatureGate("cursor_blame", {disableExposureLog:!1})
		assert.strictEqual(await cursor.checkFeatureGate('cursor_blame', { disableExposureLog: true }), true);
		assert.strictEqual(await cursor.checkFeatureGate('missing', { disableExposureLog: true }), false);
		cursor.dispose();
	});

	test('privacy egress: disclosure table is the verbatim 18-key canonical list', async () => {
		const { cursor } = await createCursor();
		const disclosures = cursor.getFeatureEgressDisclosures();
		const expectedKeys = [
			'chat-auto-title', 'commit-message', 'branch-name',
			'conversation-classification', 'transcript-overview', 'agent-review',
			'codebase-indexing', 'prompt-quality-upload', 'share-conversation',
			'knowledge-base', 'web-fetch', 'image-generation', 'video-generation',
			'x-search', 'scm-integration', 'online-metrics', 'codebase-telemetry',
			'github-context',
		];
		assert.deepStrictEqual(disclosures.map(d => d.key), expectedKeys);

		for (const d of disclosures) {
			assert.ok(d.why.length > 0, `why text missing for ${d.key}`);
			assert.ok(d.rpcs.length > 0, `RPCs missing for ${d.key}`);
			assert.ok(cursor.hasFeatureEgressGate(d.key), `hasFeatureEgressGate false for ${d.key}`);
		}

		// Spot-check verbatim pairs (harvest-cursor-commits-2026-10-19.md §7)
		const byKey = new Map(disclosures.map(d => [d.key, d]));
		assert.ok(byKey.get('chat-auto-title')!.why.includes('Sends the first user message to Cursor'));
		assert.deepStrictEqual(byKey.get('chat-auto-title')!.rpcs, ['aiserver.v1.AiService/NameTab']);
		assert.ok(byKey.get('commit-message')!.why.includes('Sends the staged diff to Cursor'));
		assert.deepStrictEqual(byKey.get('commit-message')!.rpcs, ['aiserver.v1.AiService/WriteGitCommitMessage']);
		assert.ok(byKey.get('codebase-indexing')!.why.includes('Uploads file contents and paths'));
		assert.ok(byKey.get('codebase-indexing')!.rpcs.some(r => r.includes('FastRepoInitHandshakeV2')));
		assert.ok(byKey.get('codebase-indexing')!.rpcs.some(r => r.includes('EnsureIndexCreated')));
		assert.ok(byKey.get('online-metrics')!.why.includes('uploads each file\'s path and diff'));
		assert.deepStrictEqual(byKey.get('online-metrics')!.rpcs, ['aiserver.v1.OnlineMetricsService/ReportAgentSnapshot']);
		assert.ok(byKey.get('github-context')!.why.includes('all GitHub egress stays off until it is decided'));
		assert.deepStrictEqual(byKey.get('github-context')!.rpcs, ['BackgroundComposerService/MakeGithubRequest']);
		assert.ok(byKey.get('web-fetch')!.why.includes('private-inference tool client refuses it'));
		assert.ok(byKey.get('scm-integration')!.why.includes('Pull-request metadata, diffs, checks, comments'));
		cursor.dispose();
	});

	test('privacy egress: all gated features blocked by default (NoStorage)', async () => {
		const { cursor } = await createCursor();
		assert.strictEqual(cursor.getPrivacyModeEnum(), ExtHostCursorPrivacyMode.NoStorage);
		for (const d of cursor.getFeatureEgressDisclosures()) {
			assert.strictEqual(cursor.isFeatureEgressAllowed(d.key), false, `egress allowed for ${d.key} under NoStorage`);
		}
		cursor.dispose();
	});

	test('privacy egress: NoTraining also gates egress; Unspecified is safe-default gated', async () => {
		const { cursor: c1 } = await createCursor({ privacyMode: 'NO_TRAINING' });
		assert.strictEqual(c1.isFeatureEgressAllowed('codebase-indexing'), false);
		assert.strictEqual(c1.isFeatureEgressAllowed('chat-auto-title'), false);
		c1.dispose();

		const { cursor: c2 } = await createCursor({ privacyMode: 'UNSPECIFIED' });
		assert.strictEqual(c2.isFeatureEgressAllowed('codebase-indexing'), false);
		c2.dispose();
	});

	test('privacy egress: open when the mode explicitly allows training/usage', async () => {
		const { cursor: c1 } = await createCursor({ privacyMode: 'USAGE_DATA_TRAINING_ALLOWED' });
		assert.strictEqual(c1.isFeatureEgressAllowed('codebase-indexing'), true);
		assert.strictEqual(c1.isFeatureEgressAllowed('commit-message'), true);
		// github-context still off: "stays off until it is decided"
		assert.strictEqual(c1.isFeatureEgressAllowed('github-context'), false);
		c1.dispose();

		const { cursor: c2 } = await createCursor({ privacyMode: 'USAGE_CODEBASE_TRAINING_ALLOWED' });
		assert.strictEqual(c2.isFeatureEgressAllowed('online-metrics'), true);
		c2.dispose();
	});

	test('privacy egress: github-context stays off until decided via ide.agent.egressAllowedFeatures', async () => {
		const { cursor } = await createCursor({ privacyMode: 'USAGE_DATA_TRAINING_ALLOWED' });
		assert.strictEqual(cursor.isFeatureEgressAllowed('github-context'), false);

		const { cursor: c2, config } = await createCursor({ privacyMode: 'USAGE_DATA_TRAINING_ALLOWED' });
		config.setValue('egressAllowedFeatures', ['github-context']);
		assert.strictEqual(c2.isFeatureEgressAllowed('github-context'), true);
		c2.dispose();

		// the explicit decision does NOT override privacy mode being on
		const { cursor: c3, config: config3 } = await createCursor({ privacyMode: 'NO_STORAGE' });
		config3.setValue('egressAllowedFeatures', ['github-context']);
		assert.strictEqual(c3.isFeatureEgressAllowed('github-context'), false);
		assert.strictEqual(c3.isFeatureEgressAllowed('commit-message'), false);
		c3.dispose();

		cursor.dispose();
	});

	test('privacy egress: unlisted feature keys are not gated', async () => {
		const { cursor } = await createCursor(); // NoStorage default
		assert.strictEqual(cursor.hasFeatureEgressGate('not-a-real-feature'), false);
		assert.strictEqual(cursor.isFeatureEgressAllowed('not-a-real-feature'), true);
		cursor.dispose();
	});

	test('onDidChangePrivacyModeEnum fires only when the resolved enum changes', async () => {
		const { cursor, config } = await createCursor();
		let fired = 0;
		const d = cursor.onDidChangePrivacyModeEnum(() => fired++);

		config.setValue('privacyMode', 'NO_TRAINING'); // NoStorage -> NoTraining
		assert.strictEqual(fired, 1);
		config.setValue('privacyMode', 'NO_TRAINING'); // same enum: no fire
		assert.strictEqual(fired, 1);
		config.setValue('privacyMode', 'USAGE_DATA_TRAINING_ALLOWED'); // -> open
		assert.strictEqual(fired, 2);
		assert.strictEqual(cursor.isFeatureEgressAllowed('codebase-indexing'), true);

		config.setValue('featureGates', { 'g': true }); // unrelated: no fire
		assert.strictEqual(fired, 2);

		d.dispose();
		cursor.dispose();
	});
});
