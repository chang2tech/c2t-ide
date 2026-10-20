/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { URI } from '../../../../base/common/uri.js';
import type { EnvVarEnvironment } from '../../../../platform/mcp/common/envVarResolution.js';
import type { McpServerLaunch } from './mcpTypes.js';

/**
 * Cursor-style MCP configuration variables (cursor.com/docs, "MCP" section).
 *
 * REA evidence (verbatim): "Variables: `${env:NAME}`, `${userHome}`,
 * `${workspaceFolder}`, `${workspaceFolderBasename}`, `${pathSeparator}`,
 * `${/}` — resolved in: command, args, env, url, headers"
 * (docs/rea/deep-docs-all.md, docs sweep 2026-10-18). The documented
 * `mcp.json` example also uses variables in `envFile`
 * (`"envFile": "${workspaceFolder}/.env"`), so `envFile` is resolved too.
 *
 * This is deliberately separate from the Copilot runtime `${VAR}` /
 * `${VAR:-default}` expansion in `envVarResolution.ts`, which intentionally
 * leaves `${env:X}`-style references untouched. References this module does
 * not recognize (e.g. `${input:foo}`, `${VAR}`) are left verbatim so the
 * upstream resolvers keep handling them.
 *
 * Feature: `mcp-variables` (P2).
 */

export interface ICursorMcpVariableContext {
	/** Host environment for `${env:NAME}`. */
	readonly env: EnvVarEnvironment;
	/** Resolved value for `${userHome}`. When undefined the reference is left verbatim. */
	readonly userHome: string | undefined;
	/** Resolved value for `${workspaceFolder}` / `${workspaceFolderBasename}`. When undefined the references are left verbatim. */
	readonly workspaceFolder: string | undefined;
	/** Resolved value for `${pathSeparator}` / `${/}` (e.g. `/` or `\`). */
	readonly pathSeparator: string;
	/**
	 * Whether `${env:NAME}` lookup is case-insensitive (Windows `process.env`
	 * semantics). Defaults to `false`.
	 */
	readonly caseInsensitive?: boolean;
}

/**
 * Numeric mirrors of {@link McpServerTransportType} (a `const enum`, so it
 * cannot be imported by value here without pulling `mcpTypes.ts` into this
 * pure module's runtime graph). Kept in sync manually: Stdio = 1, HTTP = 2.
 */
const MCP_TRANSPORT_STDIO = 1;
const MCP_TRANSPORT_HTTP = 2;

const cursorVariablePattern = /\$\{(env:[A-Za-z_][A-Za-z0-9_]*|workspaceFolderBasename|workspaceFolder|userHome|pathSeparator|\/)\}/;
const cursorVariablePatternGlobal = /\$\{(env:[A-Za-z_][A-Za-z0-9_]*|workspaceFolderBasename|workspaceFolder|userHome|pathSeparator|\/)\}/g;

/** Whether `value` contains at least one Cursor-style MCP variable reference. */
export function hasCursorMcpVariables(value: string): boolean {
	return cursorVariablePattern.test(value);
}

function lookupEnv(context: ICursorMcpVariableContext, name: string): string | undefined {
	if (!context.caseInsensitive) {
		return context.env[name];
	}
	const lower = name.toLowerCase();
	for (const key of Object.keys(context.env)) {
		if (key.toLowerCase() === lower) {
			return context.env[key];
		}
	}
	return undefined;
}

function workspaceFolderBasename(workspaceFolder: string): string {
	const segments = workspaceFolder.split(/[\\/]/).filter(s => s.length > 0);
	return segments.length > 0 ? segments[segments.length - 1] : workspaceFolder;
}

/**
 * Resolves Cursor-style MCP variables in a single string. Unrecognized
 * references and references that cannot be resolved (unset env var, unknown
 * workspace folder) are left verbatim.
 */
export function resolveCursorMcpVariables(value: string, context: ICursorMcpVariableContext): string {
	if (!hasCursorMcpVariables(value)) {
		return value;
	}
	return value.replace(cursorVariablePatternGlobal, (match, name: string) => {
		if (name.startsWith('env:')) {
			const resolved = lookupEnv(context, name.slice('env:'.length));
			return resolved === undefined ? match : resolved;
		}
		switch (name) {
			case 'userHome':
				return context.userHome ?? match;
			case 'workspaceFolder':
				return context.workspaceFolder ?? match;
			case 'workspaceFolderBasename':
				return context.workspaceFolder !== undefined ? workspaceFolderBasename(context.workspaceFolder) : match;
			case 'pathSeparator':
			case '/':
				return context.pathSeparator;
			default:
				return match;
		}
	});
}

/** Whether a launch contains any Cursor-style variable reference in the fields Cursor resolves. */
export function hasCursorMcpVariablesInLaunch(launch: McpServerLaunch): boolean {
	const check = (value: string) => hasCursorMcpVariables(value);
	if (launch.type === MCP_TRANSPORT_STDIO) {
		return check(launch.command)
			|| launch.args.some(check)
			|| Object.values(launch.env).some(value => typeof value === 'string' && check(value))
			|| (launch.envFile !== undefined && check(launch.envFile));
	}
	if (launch.type === MCP_TRANSPORT_HTTP) {
		return check(launch.uri.toString(true)) || launch.headers.some(([, value]) => check(value));
	}
	return false;
}

/**
 * Resolves Cursor-style MCP variables across the launch fields Cursor
 * documents: `command`, `args`, `env`, `envFile` (stdio) and `url`,
 * `headers` (HTTP). Header names and env var names are never rewritten.
 */
export function resolveCursorMcpVariablesInLaunch(launch: McpServerLaunch, context: ICursorMcpVariableContext): McpServerLaunch {
	if (!hasCursorMcpVariablesInLaunch(launch)) {
		return launch;
	}
	const resolve = (value: string) => resolveCursorMcpVariables(value, context);
	if (launch.type === MCP_TRANSPORT_STDIO) {
		const env: Record<string, string | number | null> = {};
		for (const [key, value] of Object.entries(launch.env)) {
			env[key] = typeof value === 'string' ? resolve(value) : value;
		}
		return {
			...launch,
			command: resolve(launch.command),
			args: launch.args.map(resolve),
			env,
			envFile: launch.envFile !== undefined ? resolve(launch.envFile) : launch.envFile,
		};
	}
	if (launch.type === MCP_TRANSPORT_HTTP) {
		return {
			...launch,
			uri: URI.parse(resolve(launch.uri.toString(true))),
			headers: launch.headers.map(([name, value]) => [name, resolve(value)] as [string, string]),
		};
	}
	return launch;
}
