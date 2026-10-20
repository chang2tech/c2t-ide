/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { describe, it, before } from 'node:test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
	KNOWN_EVENTS,
	HookEventName,
	getHookMatcherValue,
	isKnownEvent,
} from '../../common/hooks/hookTypes.js';
import {
	HOOK_EVENT_SPECS,
	assertSpecsComplete,
	buildSessionEndExtras,
	buildPreCompactExtras,
	buildSessionStartExtras,
} from '../../common/hooks/hookEventSpecs.js';
import { HookService } from '../../electron-browser/hooks/hookService.js';

/**
 * DEV-GAPS-34 (hooks-21-events): the 21 hook events, verbatim from
 * cursor.com/docs/hooks (fetched 2026-10-20) — 18 agent hooks, 2 tab
 * hooks, 1 app-lifecycle hook. node:test, zero extra deps.
 *
 * Run after targeted tsc, e.g.:
 *   node out-test/vs/workbench/contrib/composer/test/common/hooksEvents.test.js
 */

const DOCS_21_VERBATIM: HookEventName[] = [
	// Agent hooks (18), in docs order
	'sessionStart',
	'sessionEnd',
	'preToolUse',
	'postToolUse',
	'postToolUseFailure',
	'subagentStart',
	'subagentStop',
	'beforeShellExecution',
	'afterShellExecution',
	'beforeMCPExecution',
	'afterMCPExecution',
	'beforeReadFile',
	'afterFileEdit',
	'beforeSubmitPrompt',
	'preCompact',
	'stop',
	'afterAgentResponse',
	'afterAgentThought',
	// Tab hooks (2)
	'beforeTabFileRead',
	'afterTabFileEdit',
	// App lifecycle (1)
	'workspaceOpen',
];

describe('hooks-21-events: registry', () => {
	it('KNOWN_EVENTS is exactly the 21 verbatim docs events, in docs order', () => {
		assert.deepStrictEqual([...KNOWN_EVENTS], DOCS_21_VERBATIM);
	});

	it('isKnownEvent accepts all 21 and rejects invented names', () => {
		for (const name of DOCS_21_VERBATIM) {
			assert.ok(isKnownEvent(name), name);
		}
		assert.ok(!isKnownEvent('frobnicate'));
		assert.ok(!isKnownEvent('SessionStart')); // case matters — verbatim
	});
});

describe('hooks-21-events: event definitions', () => {
	it('HOOK_EVENT_SPECS covers exactly the 21 known events', () => {
		assertSpecsComplete();
		for (const name of KNOWN_EVENTS) {
			const s = HOOK_EVENT_SPECS[name];
			assert.ok(s, name);
			assert.strictEqual(s.name, name);
			assert.ok(s.docsTrigger.length > 0, `${name}: docsTrigger`);
			assert.ok(s.triggerSite.length > 0, `${name}: triggerSite`);
		}
	});

	it('category split is 18 agent / 2 tab / 1 app', () => {
		const cats = KNOWN_EVENTS.map((n) => HOOK_EVENT_SPECS[n].category);
		assert.strictEqual(cats.filter((c) => c === 'agent').length, 18);
		assert.strictEqual(cats.filter((c) => c === 'tab').length, 2);
		assert.strictEqual(cats.filter((c) => c === 'app').length, 1);
	});
});

describe('hooks-21-events: docs matcher table', () => {
	it('constant matchers are tested verbatim per the docs', () => {
		const p: Record<string, unknown> = {};
		assert.strictEqual(getHookMatcherValue('beforeReadFile', p), 'Read');
		assert.strictEqual(getHookMatcherValue('afterFileEdit', p), 'Write');
		assert.strictEqual(getHookMatcherValue('beforeTabFileRead', p), 'TabRead');
		assert.strictEqual(getHookMatcherValue('afterTabFileEdit', p), 'TabWrite');
		assert.strictEqual(getHookMatcherValue('beforeSubmitPrompt', p), 'UserPromptSubmit');
		assert.strictEqual(getHookMatcherValue('stop', p), 'Stop');
		assert.strictEqual(getHookMatcherValue('afterAgentResponse', p), 'AgentResponse');
		assert.strictEqual(getHookMatcherValue('afterAgentThought', p), 'AgentThought');
	});

	it('field matchers read the documented payload field', () => {
		assert.strictEqual(getHookMatcherValue('preToolUse', { tool: 'Shell' }), 'Shell');
		assert.strictEqual(getHookMatcherValue('postToolUse', { tool: 'MCP:linear' }), 'MCP:linear');
		assert.strictEqual(getHookMatcherValue('postToolUseFailure', { tool: 'Read' }), 'Read');
		assert.strictEqual(getHookMatcherValue('subagentStart', { subagentType: 'explore' }), 'explore');
		assert.strictEqual(getHookMatcherValue('beforeShellExecution', { command: 'rm -rf /' }), 'rm -rf /');
		assert.strictEqual(getHookMatcherValue('afterShellExecution', { command: 'ls' }), 'ls');
	});

	it('events without a documented matcher resolve to undefined (run-always)', () => {
		const p: Record<string, unknown> = {};
		assert.strictEqual(getHookMatcherValue('sessionStart', p), undefined);
		assert.strictEqual(getHookMatcherValue('sessionEnd', p), undefined);
		assert.strictEqual(getHookMatcherValue('preCompact', p), undefined);
		assert.strictEqual(getHookMatcherValue('beforeMCPExecution', p), undefined);
		assert.strictEqual(getHookMatcherValue('afterMCPExecution', p), undefined);
		assert.strictEqual(getHookMatcherValue('workspaceOpen', p), undefined);
		// field matcher with a missing field is also run-always
		assert.strictEqual(getHookMatcherValue('preToolUse', p), undefined);
	});
});

describe('hooks-21-events: payload builders', () => {
	it('buildSessionEndExtras carries the docs sessionEnd fields', () => {
		const e = buildSessionEndExtras({
			sessionId: 'composer-1',
			reason: 'user_close',
			durationMs: 1234,
			finalStatus: 'closed',
		});
		assert.strictEqual(e['session_id'], 'composer-1');
		assert.strictEqual(e['reason'], 'user_close');
		assert.strictEqual(e['duration_ms'], 1234);
		assert.strictEqual(e['is_background_agent'], false);
		assert.strictEqual(e['final_status'], 'closed');
		assert.ok(!('error_message' in e), 'error_message omitted when absent');
		const withErr = buildSessionEndExtras({
			sessionId: 'c', reason: 'error', durationMs: 1, finalStatus: 'error', errorMessage: 'boom',
		});
		assert.strictEqual(withErr['error_message'], 'boom');
	});

	it('buildPreCompactExtras emits only known fields — never fabricates numbers', () => {
		const e = buildPreCompactExtras({ trigger: 'auto', isFirstCompaction: true });
		assert.strictEqual(e['trigger'], 'auto');
		assert.strictEqual(e['is_first_compaction'], true);
		assert.ok(!('context_tokens' in e), 'unknown numbers are omitted, not invented');
		const full = buildPreCompactExtras({
			trigger: 'manual', isFirstCompaction: false, contextUsagePercent: 71,
			contextTokens: 1000, contextWindowSize: 200000, messageCount: 12, messagesToCompact: 4,
		});
		assert.strictEqual(full['context_usage_percent'], 71);
		assert.strictEqual(full['messages_to_compact'], 4);
	});

	it('buildSessionStartExtras carries the docs sessionStart fields', () => {
		const e = buildSessionStartExtras({ sessionId: 's-1', composerMode: 'agent' });
		assert.strictEqual(e['session_id'], 's-1');
		assert.strictEqual(e['is_background_agent'], false);
		assert.strictEqual(e['composer_mode'], 'agent');
	});
});

describe('hooks-21-events: every event is registered and fires', () => {
	let dir: string;
	let svc: HookService;

	before(() => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hooks21-'));
		const hooks: Record<string, unknown[]> = {};
		for (const event of KNOWN_EVENTS) {
			hooks[event] = [{ command: 'cat' }]; // cat echoes the stdin JSON payload
		}
		fs.mkdirSync(path.join(dir, '.ide-code'), { recursive: true });
		fs.writeFileSync(
			path.join(dir, '.ide-code', 'hooks.json'),
			JSON.stringify({ version: 1, hooks }),
		);
		svc = new HookService({
			workspaceRoots: [dir],
			appVersion: '0.0.0-test',
			log: () => {},
		});
		assert.strictEqual(svc.getLoadedHookCount(), 21, 'all 21 events registered from hooks.json');
	});

	for (const event of KNOWN_EVENTS) {
		it(`${event}: registered and fires with hook_event_name in the payload`, async () => {
			assert.ok(svc.hasHooks(event), `${event} registered`);
			const r = await svc.runHooks(event, { probe: 'hooks21' });
			assert.ok(r.outcomes.length > 0, `${event}: hook executed`);
			const stdout = r.outcomes[0]!.stdout;
			assert.ok(
				stdout.includes(`"hook_event_name":"${event}"`),
				`${event}: payload carries hook_event_name`,
			);
			const logged = svc.getExecutionLog().some((e) => e.event === event);
			assert.ok(logged, `${event}: execution log records the firing`);
		});
	}

	it('refuses to invent a 22nd event', async () => {
		await assert.rejects(() => svc.runHooks('frobnicate' as HookEventName));
	});
});

describe('hooks-21-events: blocking semantics', () => {
	it('beforeTabFileRead deny blocks (docs permission hook)', async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hooks21-block-'));
		fs.mkdirSync(path.join(dir, '.ide-code'), { recursive: true });
		fs.writeFileSync(
			path.join(dir, '.ide-code', 'hooks.json'),
			JSON.stringify({
				version: 1,
				hooks: { beforeTabFileRead: [{ command: 'exit 2' }] },
			}),
		);
		const svc = new HookService({ workspaceRoots: [dir], appVersion: '0.0.0-test', log: () => {} });
		const r = await svc.runHooks('beforeTabFileRead', { file: '/x.ts' });
		assert.strictEqual(r.blocked, true, 'exit 2 on beforeTabFileRead blocks the tab read');
	});

	it('constant matcher filters: beforeReadFile matcher "Write" never fires', async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hooks21-matcher-'));
		fs.mkdirSync(path.join(dir, '.ide-code'), { recursive: true });
		fs.writeFileSync(
			path.join(dir, '.ide-code', 'hooks.json'),
			JSON.stringify({
				version: 1,
				hooks: {
					beforeReadFile: [
						{ command: 'echo should-not-run', matcher: 'Write' },
						{ command: 'echo should-run', matcher: 'Read' },
					],
				},
			}),
		);
		const svc = new HookService({ workspaceRoots: [dir], appVersion: '0.0.0-test', log: () => {} });
		const r = await svc.runHooks('beforeReadFile', { file: '/x.ts' });
		assert.strictEqual(r.outcomes.length, 1, 'only the Read-matcher hook ran');
		assert.ok(r.outcomes[0]!.stdout.includes('should-run'));
	});
});
