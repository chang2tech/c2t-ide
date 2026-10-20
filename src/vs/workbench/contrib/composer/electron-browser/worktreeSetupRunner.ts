/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// IDE-CODE (GAPS-132 `worktrees-json-config`): desktop runner for the
// `.cursor/worktrees.json` worktree setup — the node side of Cursor's `eiy`
// (workbench.glass.main.js @46710083). Pure spec handling (key selection,
// script builders, constants) lives in `../common/worktreeSetup.ts`.
//
// Semantics mirrored from the binary:
// - Config lookup: `<worktree>/.cursor/worktrees.json` first, then
//   `<rootWorkspace>/.cursor/worktrees.json`; neither → skip, no error.
// - Read/parse failure → `{hadScript:false, scriptFailed:false}` (no block).
// - The combined script runs in a shell session with cwd = the new
//   worktree, non-interactive; stdout+stderr are accumulated keeping only
//   the last 2048 chars; timeout 300s cancels the session and fails with
//   `Worktree setup script timed out after 300s`.
// - NEVER throws: failures return `{hadScript:true, scriptFailed:true,
//   scriptError, scriptOutput}` and the caller continues creating the agent
//   (binary: "Worktree setup script failed (continuing with agent
//   creation)", glass@46755597).
//
// Divergence (honest): Cursor executes through its shellExecService
// session (user/remote shell profile — exact shell binary UNKNOWN from the
// binary). Here we spawn `bash -c` (fallback `sh -c`) on Unix and
// `powershell.exe -Command` on Windows, matching the generated script
// syntax. Remote-OS targeting is not applicable to this local service —
// the local platform decides, like the binary's `!u && La` fallback.

import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawn } from 'node:child_process';
import { isWindows } from '../../../../base/common/platform.js';
import {
	WORKTREE_SETUP_OUTPUT_TAIL_CHARS,
	WORKTREE_SETUP_TIMEOUT_MS,
	buildUnixCommandsScript,
	buildUnixScriptFileScript,
	buildWindowsCommandsScript,
	buildWindowsScriptFileScript,
	isAbsoluteSetupScriptPath,
	selectSetupSpec,
	type WorktreeSetupResult,
} from '../common/worktreeSetup.js';

export interface IWorktreeSetupLog {
	info(message: string, ...args: unknown[]): void;
	error(message: string, ...args: unknown[]): void;
}

const consoleLog: IWorktreeSetupLog = {
	info: (m, ...a) => console.log(m, ...a),
	error: (m, ...a) => console.error(m, ...a),
};

/** Resolve a script-file value against the selected config file's directory. */
function resolveSetupScriptPath(scriptValue: string, configFilePath: string, targetWindows: boolean): string {
	if (isAbsoluteSetupScriptPath(scriptValue, targetWindows)) {
		return scriptValue;
	}
	return path.resolve(path.dirname(configFilePath), scriptValue);
}

/**
 * Run the `.cursor/worktrees.json` setup for a freshly created worktree.
 * Never throws.
 */
export async function runWorktreeSetup(
	worktreePath: string,
	rootWorkspacePath: string,
	log: IWorktreeSetupLog = consoleLog,
	timeoutMs: number = WORKTREE_SETUP_TIMEOUT_MS,
): Promise<WorktreeSetupResult> {
	const targetWindows = isWindows;
	const worktreeConfigFile = path.join(worktreePath, '.cursor', 'worktrees.json');
	const rootConfigFile = path.join(rootWorkspacePath, '.cursor', 'worktrees.json');
	log.info('[worktree-setup] checking config', {
		worktreePath,
		rootWorkspacePath,
		worktreeConfigFile,
		rootConfigFile,
		isTargetWindows: targetWindows,
	});

	let commands: string[] | undefined;
	let scriptPath: string | undefined;
	try {
		let configFile: string | undefined;
		if (fs.existsSync(worktreeConfigFile)) {
			configFile = worktreeConfigFile;
		} else if (fs.existsSync(rootConfigFile)) {
			configFile = rootConfigFile;
		}
		if (!configFile) {
			log.info('[worktree-setup] no config file found in worktree or root, skipping');
			return { hadScript: false, scriptFailed: false };
		}
		const parsed = JSON.parse(fs.readFileSync(configFile, 'utf8')) as Record<string, unknown>;
		const spec = selectSetupSpec(parsed, targetWindows);
		if (spec.scriptValue !== undefined) {
			scriptPath = resolveSetupScriptPath(spec.scriptValue, configFile, targetWindows);
		} else if (spec.commands !== undefined) {
			commands = spec.commands;
		}
		log.info('[worktree-setup] selected setup spec', {
			key: spec.key,
			hasCommands: !!(commands && commands.length > 0),
			hasScript: !!scriptPath,
			configPath: configFile,
		});
	} catch (err) {
		log.error('[worktree-setup] failed reading config:', err);
		return { hadScript: false, scriptFailed: false };
	}

	if ((!commands || commands.length === 0) && !scriptPath) {
		log.info('[worktree-setup] no setup spec found (commands or script), skipping');
		return { hadScript: false, scriptFailed: false };
	}

	let script: string | undefined;
	if (commands && commands.length > 0) {
		const trimmed = commands.map(c => c.trim()).filter(c => !!c);
		if (trimmed.length === 0) {
			log.info('[worktree-setup] no commands to execute after filtering, skipping');
			return { hadScript: false, scriptFailed: false };
		}
		script = targetWindows
			? buildWindowsCommandsScript(worktreePath, rootWorkspacePath, trimmed)
			: buildUnixCommandsScript(worktreePath, rootWorkspacePath, trimmed);
		log.info(`[worktree-setup] executing combined ${targetWindows ? 'Windows' : 'UNIX'} script`, { worktreePath, scriptLength: script.length });
	} else if (scriptPath) {
		script = targetWindows
			? buildWindowsScriptFileScript(worktreePath, rootWorkspacePath, scriptPath)
			: buildUnixScriptFileScript(worktreePath, rootWorkspacePath, scriptPath);
		log.info(`[worktree-setup] executing ${targetWindows ? 'Windows' : 'UNIX'} setup script file`, { worktreePath, scriptLength: script.length, scriptPath });
	}
	if (!script) {
		log.info('[worktree-setup] nothing to execute after normalization, skipping');
		return { hadScript: false, scriptFailed: false };
	}

	let output = '';
	try {
		const startedAt = Date.now();
		const code = await new Promise<number | null>((resolve, reject) => {
			const command = targetWindows ? 'powershell.exe' : fs.existsSync('/bin/bash') ? '/bin/bash' : '/bin/sh';
			const args = targetWindows ? ['-NoProfile', '-Command', script as string] : ['-c', script as string];
			const child = spawn(command, args, { cwd: worktreePath, env: process.env });
			const timer = setTimeout(() => {
				log.error('[worktree-setup] setup script timed out; cancelling session', { timeoutMs });
				try {
					child.kill('SIGTERM');
				} catch (cancelErr) {
					log.error('[worktree-setup] failed cancelling timed-out session:', cancelErr);
				}
				reject(new Error(`Worktree setup script timed out after ${timeoutMs / 1000}s`));
			}, timeoutMs);
			child.stdout?.on('data', (d: Buffer) => {
				output = (output + d.toString()).slice(-WORKTREE_SETUP_OUTPUT_TAIL_CHARS);
			});
			child.stderr?.on('data', (d: Buffer) => {
				output = (output + d.toString()).slice(-WORKTREE_SETUP_OUTPUT_TAIL_CHARS);
			});
			child.on('error', () => {
				clearTimeout(timer);
				resolve(null);
			});
			child.on('close', (c) => {
				clearTimeout(timer);
				resolve(c);
			});
		});
		log.info('[worktree-setup] setup script finished', { durationMs: Date.now() - startedAt, exitCode: code, timedOut: false });
		if (code === null) {
			const msg = 'Worktree setup script terminated without an exit code (possibly killed by a signal)';
			log.error('[worktree-setup] ' + msg);
			return { hadScript: true, scriptFailed: true, scriptError: msg, scriptOutput: output || undefined };
		}
		if (code !== 0) {
			const msg = `Worktree setup script failed with exit code ${code}`;
			log.error('[worktree-setup] ' + msg);
			return { hadScript: true, scriptFailed: true, scriptError: msg, scriptOutput: output || undefined };
		}
		return { hadScript: true, scriptFailed: false };
	} catch (err) {
		log.error('[worktree-setup] failed executing setup script:', err);
		return {
			hadScript: true,
			scriptFailed: true,
			scriptError: err instanceof Error ? err.message : String(err),
			scriptOutput: output || undefined,
		};
	}
}
