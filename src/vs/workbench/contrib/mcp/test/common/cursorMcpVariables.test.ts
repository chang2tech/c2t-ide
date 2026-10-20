/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { hasCursorMcpVariables, hasCursorMcpVariablesInLaunch, ICursorMcpVariableContext, resolveCursorMcpVariables, resolveCursorMcpVariablesInLaunch } from '../../common/cursorMcpVariables.js';
import type { McpServerLaunch, McpServerTransportHTTP, McpServerTransportStdio, McpServerTransportType } from '../../common/mcpTypes.js';

suite('MCP - Cursor variables (mcp-variables)', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	const stdioType = 1 as McpServerTransportType.Stdio;
	const httpType = 2 as McpServerTransportType.HTTP;

	function context(overrides: Partial<ICursorMcpVariableContext> = {}): ICursorMcpVariableContext {
		return {
			env: { API_KEY: 'secret', EMPTY: '' },
			userHome: '/home/test',
			workspaceFolder: '/home/test/project',
			pathSeparator: '/',
			...overrides,
		};
	}

	function stdio(overrides: Partial<McpServerTransportStdio>): McpServerTransportStdio {
		return { type: stdioType, command: 'node', args: [], env: {}, envFile: undefined, cwd: undefined, sandbox: undefined, ...overrides };
	}

	function http(url: string, headers: [string, string][] = []): McpServerTransportHTTP {
		return { type: httpType, uri: URI.parse(url), headers };
	}

	test('hasCursorMcpVariables detects the documented forms', () => {
		assert.ok(hasCursorMcpVariables('${env:API_KEY}'));
		assert.ok(hasCursorMcpVariables('prefix ${userHome}/x'));
		assert.ok(hasCursorMcpVariables('${workspaceFolder} ${workspaceFolderBasename} ${pathSeparator} ${/}'));
		assert.ok(!hasCursorMcpVariables('${VAR}'));
		assert.ok(!hasCursorMcpVariables('${VAR:-default}'));
		assert.ok(!hasCursorMcpVariables('${input:foo}'));
		assert.ok(!hasCursorMcpVariables('no variables here'));
	});

	test('resolves ${env:NAME} from the host environment', () => {
		assert.strictEqual(resolveCursorMcpVariables('Bearer ${env:API_KEY}', context()), 'Bearer secret');
		// empty string is a real value, not "unset"
		assert.strictEqual(resolveCursorMcpVariables('[${env:EMPTY}]', context()), '[]');
		// unset variables stay verbatim
		assert.strictEqual(resolveCursorMcpVariables('${env:MISSING}', context()), '${env:MISSING}');
	});

	test('resolves ${userHome}, ${workspaceFolder}, ${workspaceFolderBasename}', () => {
		const ctx = context();
		assert.strictEqual(resolveCursorMcpVariables('${userHome}/.config', ctx), '/home/test/.config');
		assert.strictEqual(resolveCursorMcpVariables('${workspaceFolder}/.env', ctx), '/home/test/project/.env');
		assert.strictEqual(resolveCursorMcpVariables('${workspaceFolderBasename}', ctx), 'project');
		assert.strictEqual(resolveCursorMcpVariables('${workspaceFolderBasename}', context({ workspaceFolder: 'C:\\work\\myproj', pathSeparator: '\\' })), 'myproj');
	});

	test('resolves ${pathSeparator} and ${/}', () => {
		assert.strictEqual(resolveCursorMcpVariables('a${pathSeparator}b', context()), 'a/b');
		assert.strictEqual(resolveCursorMcpVariables('a${/}b', context()), 'a/b');
		assert.strictEqual(resolveCursorMcpVariables('a${/}b', context({ pathSeparator: '\\' })), 'a\\b');
	});

	test('leaves unresolvable and foreign references verbatim', () => {
		// unknown workspace folder
		assert.strictEqual(resolveCursorMcpVariables('${workspaceFolder}/x', context({ workspaceFolder: undefined })), '${workspaceFolder}/x');
		// upstream Copilot-runtime and input references are not ours to resolve
		assert.strictEqual(resolveCursorMcpVariables('${VAR} ${input:foo} ${VAR:-d}', context()), '${VAR} ${input:foo} ${VAR:-d}');
	});

	test('case-insensitive env lookup on Windows semantics', () => {
		const ctx = context({ caseInsensitive: true });
		assert.strictEqual(resolveCursorMcpVariables('${env:api_key}', ctx), 'secret');
	});

	test('resolveCursorMcpVariablesInLaunch resolves stdio fields per spec', () => {
		const launch = stdio({
			command: '${env:HOME}/bin/run',
			args: ['--dir', '${workspaceFolder}'],
			env: { API_KEY: '${env:API_KEY}', STATIC: 'x', COUNT: 3, NOTHING: null },
			envFile: '${workspaceFolder}/.env',
		});
		const ctx = context({ env: { ...context().env, HOME: '/home/test' } });
		const result = resolveCursorMcpVariablesInLaunch(launch, ctx) as McpServerTransportStdio;
		assert.strictEqual(result.command, '/home/test/bin/run');
		assert.deepStrictEqual(result.args, ['--dir', '/home/test/project']);
		assert.deepStrictEqual(result.env, { API_KEY: 'secret', STATIC: 'x', COUNT: 3, NOTHING: null });
		assert.strictEqual(result.envFile, '/home/test/project/.env');
	});

	test('resolveCursorMcpVariablesInLaunch resolves url and header values', () => {
		const launch = http('https://example.com/${env:API_KEY}/mcp', [['Authorization', 'Bearer ${env:API_KEY}'], ['X-Static', 'x']]);
		const result = resolveCursorMcpVariablesInLaunch(launch, context()) as McpServerTransportHTTP;
		assert.strictEqual(result.uri.toString(true), 'https://example.com/secret/mcp');
		assert.deepStrictEqual(result.headers, [['Authorization', 'Bearer secret'], ['X-Static', 'x']]);
	});

	test('hasCursorMcpVariablesInLaunch detects references across fields', () => {
		assert.ok(!hasCursorMcpVariablesInLaunch(stdio({})));
		assert.ok(hasCursorMcpVariablesInLaunch(stdio({ command: '${env:X}' })));
		assert.ok(hasCursorMcpVariablesInLaunch(stdio({ args: ['${userHome}'] })));
		assert.ok(hasCursorMcpVariablesInLaunch(stdio({ env: { K: '${/}' } })));
		assert.ok(hasCursorMcpVariablesInLaunch(stdio({ envFile: '${workspaceFolder}/.env' })));
		assert.ok(hasCursorMcpVariablesInLaunch(http('https://h/${env:X}/mcp')));
		assert.ok(hasCursorMcpVariablesInLaunch(http('https://h/mcp', [['A', '${env:X}']])));
	});

	test('launch without variables is returned unchanged (same reference)', () => {
		const launch: McpServerLaunch = stdio({ command: 'node' });
		assert.strictEqual(resolveCursorMcpVariablesInLaunch(launch, context()), launch);
	});
});
