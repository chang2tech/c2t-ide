/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../base/test/common/utils.js';
import product from '../../../platform/product/common/product.js';
import {
	AmbiguousThreadRefError,
	DESKTOP_BRIDGE_PROTOCOL_VERSION,
	buildDesktopBridgeUsage,
	cliArgvTail,
	formatBridgeError,
	formatThreadTable,
	isDesktopSubcommand,
	normalizeThreadRef,
	parseDesktopArgs,
	resolveThreadRef,
	sendToFirstAvailable,
	sendToThread,
	stripAnsiAndControls,
	threadToJson,
	UnknownThreadRefError,
	validateDiscoveryRecord,
	validateSendResult,
	validateThread,
	validateThreadsResponse,
	IDesktopBridgeInstance,
	IDesktopBridgeThread,
} from '../../node/cliDesktopBridge.js';

function makeInstance(label = 'IDE Code 1.0.0'): IDesktopBridgeInstance {
	return {
		label,
		discovery: {
			protocolVersion: DESKTOP_BRIDGE_PROTOCOL_VERSION,
			pid: process.pid,
			socketPath: '/tmp/bridge.sock',
			token: 'a'.repeat(64),
			appName: 'IDE Code',
			appVersion: '1.0.0',
			userDataDir: '/tmp/user-data',
			createdAt: 1,
		},
	};
}

function makeThread(instance: IDesktopBridgeInstance, overrides: Partial<IDesktopBridgeThread> = {}): IDesktopBridgeThread {
	return {
		id: 'thread-1',
		title: 'First thread',
		source: 'local',
		status: 'idle',
		lastUpdatedAt: 100,
		windowId: 1,
		instance,
		...overrides,
	};
}

suite('cliDesktopBridge', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	suite('usage', () => {
		test('usage text matches Cursor layout with this product name', () => {
			const usage = buildDesktopBridgeUsage();
			assert.ok(usage.startsWith(`Usage: ${product.applicationName} desktop <command>`));
			assert.ok(usage.includes(`Interact with chat threads in a running ${product.nameShort} desktop app.`));
			assert.ok(usage.includes('  ls                                List threads live in running desktop instances'));
			assert.ok(usage.includes('  send <thread> [text...]           Send a message to a live desktop thread'));
			assert.ok(usage.includes('  --force                           (send) Submit immediately, interrupting a running turn'));
			assert.ok(usage.includes(`<thread> is a thread id from \`${product.applicationName} desktop ls\`, or a unique prefix of one.`));
		});
	});

	suite('argv routing', () => {
		test('isDesktopSubcommand finds the first non-option argument', () => {
			assert.strictEqual(isDesktopSubcommand(['node', 'cli.js', 'desktop', 'ls'], false), true);
			assert.strictEqual(isDesktopSubcommand(['node', 'cli.js', '--verbose', 'desktop', 'ls'], false), true);
			assert.strictEqual(isDesktopSubcommand(['node', 'cli.js', 'somefile.ts'], false), false);
			assert.strictEqual(isDesktopSubcommand(['node', 'cli.js', '--help'], false), false);
			assert.strictEqual(isDesktopSubcommand(['node', 'cli.js'], false), false);
		});

		test('cliArgvTail strips the app location under VSCODE_DEV', () => {
			assert.deepStrictEqual(cliArgvTail(['node', 'cli.js', '.', 'desktop', 'ls'], true), ['desktop', 'ls']);
			assert.deepStrictEqual(cliArgvTail(['node', 'cli.js', 'desktop', 'ls'], false), ['desktop', 'ls']);
			assert.strictEqual(isDesktopSubcommand(['node', 'cli.js', '.', 'desktop', 'ls'], true), true);
		});
	});

	suite('parseDesktopArgs', () => {
		test('parses ls with --json', () => {
			assert.deepStrictEqual(parseDesktopArgs(['ls', '--json']), {
				command: 'ls', rest: [], json: true, force: false, stdin: false, help: false,
			});
		});

		test('parses send ref + text with --force/--stdin', () => {
			const parsed = parseDesktopArgs(['send', 'abc123', 'hello', 'world', '--force']);
			assert.strictEqual(parsed.command, 'send');
			assert.deepStrictEqual(parsed.rest, ['abc123', 'hello', 'world']);
			assert.strictEqual(parsed.force, true);
			assert.strictEqual(parsed.stdin, false);
		});

		test('-h and --help set help; unknown options are ignored', () => {
			assert.strictEqual(parseDesktopArgs(['--help']).help, true);
			assert.strictEqual(parseDesktopArgs(['-h']).help, true);
			const parsed = parseDesktopArgs(['--bogus', 'ls']);
			assert.strictEqual(parsed.command, 'ls');
		});

		test('no subcommand yields undefined command', () => {
			assert.strictEqual(parseDesktopArgs([]).command, undefined);
		});
	});

	suite('validateDiscoveryRecord', () => {
		const valid = {
			protocolVersion: 1,
			pid: 1234,
			socketPath: '/tmp/bridge.sock',
			token: '0123456789abcdef'.repeat(4),
			appName: 'IDE Code',
			appVersion: '1.0.0',
			userDataDir: '/tmp/user-data',
			createdAt: 42,
		};

		test('accepts a valid record', () => {
			assert.deepStrictEqual(validateDiscoveryRecord(valid), valid);
		});

		test('rejects bad token, pid, protocol and empty strings', () => {
			assert.strictEqual(validateDiscoveryRecord({ ...valid, token: 'zz'.repeat(32) }), undefined);
			assert.strictEqual(validateDiscoveryRecord({ ...valid, token: 'ab' }), undefined);
			assert.strictEqual(validateDiscoveryRecord({ ...valid, pid: 0 }), undefined);
			assert.strictEqual(validateDiscoveryRecord({ ...valid, pid: 1.5 }), undefined);
			assert.strictEqual(validateDiscoveryRecord({ ...valid, socketPath: '' }), undefined);
			assert.strictEqual(validateDiscoveryRecord({ ...valid, createdAt: -1 }), undefined);
			assert.strictEqual(validateDiscoveryRecord(null), undefined);
			assert.strictEqual(validateDiscoveryRecord('nope'), undefined);
			assert.strictEqual(validateDiscoveryRecord([valid]), undefined);
		});
	});

	suite('validateThread / validateThreadsResponse', () => {
		test('accepts valid threads incl. string windowId (ide-agent server parity)', () => {
			const thread = validateThread({ id: 't1', title: 'Hi', source: 'local', status: 'running', lastUpdatedAt: 5, windowId: 'main' });
			assert.deepStrictEqual(thread, { id: 't1', title: 'Hi', source: 'local', status: 'running', lastUpdatedAt: 5, windowId: 'main' });
		});

		test('rejects unknown source/status and one bad thread voids the list', () => {
			assert.strictEqual(validateThread({ id: 't1', title: 'Hi', source: 'bogus', status: 'idle', lastUpdatedAt: 5, windowId: 1 }), undefined);
			assert.strictEqual(validateThread({ id: 't1', title: 'Hi', source: 'local', status: 'bogus', lastUpdatedAt: 5, windowId: 1 }), undefined);
			assert.strictEqual(validateThreadsResponse({ threads: [{ id: 't1', title: 'Hi', source: 'local', status: 'idle', lastUpdatedAt: 5, windowId: 1 }, { bad: true }] }), undefined);
			assert.strictEqual(validateThreadsResponse({ threads: 'nope' }), undefined);
			assert.strictEqual(validateThreadsResponse({}), undefined);
		});
	});

	suite('validateSendResult', () => {
		test('validates each status shape', () => {
			assert.deepStrictEqual(
				validateSendResult({ status: 'submitted', threadId: 't1', windowId: 3, threadTitle: 'Hi' }),
				{ status: 'submitted', threadId: 't1', windowId: 3, threadTitle: 'Hi' });
			assert.deepStrictEqual(validateSendResult({ status: 'unknown-thread' }), { status: 'unknown-thread' });
			assert.deepStrictEqual(validateSendResult({ status: 'timeout' }), { status: 'timeout' });
			assert.deepStrictEqual(validateSendResult({ status: 'not-sendable', reason: 'readonly' }), { status: 'not-sendable', reason: 'readonly' });
			assert.deepStrictEqual(validateSendResult({ status: 'error', message: 'boom' }), { status: 'error', message: 'boom' });
			assert.strictEqual(validateSendResult({ status: 'submitted', threadId: 't1' }), undefined);
			assert.strictEqual(validateSendResult({ status: 'mystery' }), undefined);
			assert.strictEqual(validateSendResult(null), undefined);
		});
	});

	suite('resolveThreadRef', () => {
		const instance = makeInstance();
		const listOf = (threads: IDesktopBridgeThread[]) => async () => threads;

		test('exact match picks the most recently updated thread', async () => {
			const older = makeThread(instance, { id: 'dup', lastUpdatedAt: 10 });
			const newer = makeThread(instance, { id: 'dup', lastUpdatedAt: 99 });
			const resolved = await resolveThreadRef([instance], 'dup', listOf([older, newer]));
			assert.strictEqual(resolved[0], newer);
		});

		test('unique prefix match', async () => {
			const thread = makeThread(instance, { id: 'abcdef-123' });
			const resolved = await resolveThreadRef([instance], 'abcd', listOf([thread]));
			assert.strictEqual(resolved[0], thread);
		});

		test('ambiguous prefix throws with candidates', async () => {
			const a = makeThread(instance, { id: 'ab-1', title: 'One' });
			const b = makeThread(instance, { id: 'ab-2', title: 'Two' });
			await assert.rejects(
				() => resolveThreadRef([instance], 'ab', listOf([a, b])),
				(err: unknown) => err instanceof AmbiguousThreadRefError
					&& formatBridgeError(err) === 'thread ref "ab" is ambiguous: ab-1 "One", ab-2 "Two"');
		});

		test('unknown ref throws UnknownThreadRefError, formatted by formatBridgeError', async () => {
			await assert.rejects(
				() => resolveThreadRef([instance], 'nope', listOf([])),
				(err: unknown) => err instanceof UnknownThreadRefError
					&& formatBridgeError(err) === 'thread ref "nope" was not found');
		});

		test('UUID-shaped ref yields a pseudo-thread per instance', async () => {
			const uuid = '123e4567-e89b-12d3-a456-426614174000';
			const resolved = await resolveThreadRef([instance], uuid.toUpperCase(), listOf([]));
			assert.strictEqual(resolved.length, 1);
			assert.strictEqual(resolved[0].id, uuid);
			assert.strictEqual(resolved[0].source, 'local');
			assert.strictEqual(resolved[0].status, 'idle');
		});

		test('normalizeThreadRef lowercases only UUID-shaped refs', () => {
			assert.strictEqual(normalizeThreadRef('  ABCDEF01-2345-6789-ABCD-EF0123456789 '), 'abcdef01-2345-6789-abcd-ef0123456789');
			assert.strictEqual(normalizeThreadRef('  AbC '), 'AbC');
		});
	});

	suite('sendToFirstAvailable', () => {
		test('submitted wins and stops iteration', async () => {
			const instance = makeInstance();
			const a = makeThread(instance, { id: 'a' });
			const b = makeThread(instance, { id: 'b' });
			const calls: string[] = [];
			const { thread, response } = await sendToFirstAvailable([a, b], 'hi', { force: false }, async (t) => {
				calls.push(t.id);
				return { status: 'submitted', threadId: t.id, windowId: 1, threadTitle: 'T' };
			});
			assert.strictEqual(thread, a);
			assert.strictEqual(response.status, 'submitted');
			assert.deepStrictEqual(calls, ['a']);
		});

		test('keeps the most severe outcome across candidates', async () => {
			const instance = makeInstance();
			const a = makeThread(instance, { id: 'a' });
			const b = makeThread(instance, { id: 'b' });
			const { thread, response } = await sendToFirstAvailable([a, b], 'hi', { force: false }, async (t) => {
				return t.id === 'a' ? { status: 'unknown-thread' } : { status: 'not-sendable', reason: 'locked' };
			});
			assert.strictEqual(thread, b);
			assert.strictEqual(response.status, 'not-sendable');
		});
	});

	suite('sendToThread', () => {
		const instance = makeInstance();
		const thread = makeThread(instance);

		test('sends a sendMessage payload and validates the result', async () => {
			let payload: unknown;
			const result = await sendToThread(thread, 'hello', { force: true }, async (_instance, body) => {
				payload = body;
				return { statusCode: 200, body: { status: 'submitted', threadId: 'thread-1', windowId: 'main', threadTitle: 'First thread' } };
			});
			assert.deepStrictEqual(payload, { type: 'sendMessage', threadId: 'thread-1', text: 'hello', force: true });
			assert.strictEqual(result.status, 'submitted');
		});

		test('non-200 with an error result is surfaced, other non-200 throws HTTP error', async () => {
			const surfaced = await sendToThread(thread, 'hi', { force: false }, async () => {
				return { statusCode: 500, body: { status: 'error', message: 'server boom' } };
			});
			assert.deepStrictEqual(surfaced, { status: 'error', message: 'server boom' });

			await assert.rejects(
				() => sendToThread(thread, 'hi', { force: false }, async () => {
					return { statusCode: 503, body: { error: 'down' } };
				}),
				/IDE Code 1\.0\.0 desktop bridge returned HTTP 503: down/);
		});

		test('invalid 200 body throws "invalid send result"', async () => {
			await assert.rejects(
				() => sendToThread(thread, 'hi', { force: false }, async () => {
					return { statusCode: 200, body: { nope: true } };
				}),
				/desktop bridge returned an invalid send result/);
		});
	});

	suite('presentation', () => {
		test('stripAnsiAndControls removes escapes and control chars', () => {
			assert.strictEqual(stripAnsiAndControls('\x1B[31mred\x1B[0m text\t'), 'red text');
		});

		test('formatThreadTable aligns columns and falls back to (untitled)', () => {
			const instance = makeInstance();
			const table = formatThreadTable([
				makeThread(instance, { id: 'id-1', title: '' }),
				makeThread(instance, { id: 'longer-id', title: 'Hello' }),
			]);
			const lines = table.split('\n');
			assert.strictEqual(lines[0], 'THREAD ID  TITLE       SOURCE  STATUS  WHERE');
			assert.ok(lines[1].includes('(untitled)'));
			assert.ok(lines[2].includes('Hello'));
		});

		test('threadToJson replaces the instance object with its summary', () => {
			const instance = makeInstance();
			const json = threadToJson(makeThread(instance));
			assert.deepStrictEqual(json.instance, {
				label: 'IDE Code 1.0.0',
				appName: 'IDE Code',
				appVersion: '1.0.0',
				userDataDir: '/tmp/user-data',
			});
			assert.strictEqual(json.id, 'thread-1');
		});
	});
});
