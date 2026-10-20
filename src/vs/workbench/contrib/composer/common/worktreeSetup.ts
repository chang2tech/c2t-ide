/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// IDE-CODE (GAPS-132 `worktrees-json-config`): pure, node-free port of
// Cursor 3.25.9's worktree-setup spec handling (`workbench.glass.main.js`,
// re-verified from the binary; full notes in ide-code-mission
// `docs/rea/work-notes-gaps132.md`):
// - Runtime `eiy(...)` at glass@46710083 reads
//   `<worktreePath>/.cursor/worktrees.json` first, then
//   `<rootWorkspacePath>/.cursor/worktrees.json`.
// - Schema at glass@43381934 (`vscode://schemas/cursor/worktrees`,
//   `additionalProperties:!1`): only `setup-worktree` (generic fallback),
//   `setup-worktree-unix`, `setup-worktree-windows`; each value is an array
//   of shell commands OR a string path to a script file relative to the
//   JSON file.
// - OS-specific key wins over the generic one, by TARGET OS.
// - Command lists are flattened by `p4x` (strings kept, arrays recursed,
//   other values dropped), trimmed, empty-filtered, then combined into ONE
//   script string by builders `c4x` (unix commands), `u4x` (windows
//   commands), `d4x` (unix script file), `h4x` (windows script file) —
//   mirrored verbatim below.
// - Timeout `Edu = 300*1e3` ms; captured output keeps only the last 2048
//   chars (`qZg = 2048`, glass@25950961); the runner never throws.
//
// The actual execution (fs + child_process) lives in
// `../electron-browser/worktreeSetupRunner.ts`; this module stays node-free
// so browser/common code and unit tests can use the pure logic.

/** Timeout for the whole setup run: `var Edu=300*1e3`. */
export const WORKTREE_SETUP_TIMEOUT_MS = 300 * 1000;

/** Only the last 2048 chars of combined output are kept (`qZg=2048`). */
export const WORKTREE_SETUP_OUTPUT_TAIL_CHARS = 2048;

/** Result shape returned by Cursor's runner — it never throws. */
export interface WorktreeSetupResult {
	hadScript: boolean;
	scriptFailed: boolean;
	scriptError?: string;
	scriptOutput?: string;
}

/**
 * `p4x` verbatim: flatten a config value into a command list — strings are
 * kept, arrays are recursed into, everything else is dropped.
 */
export function flattenSetupCommands(value: unknown): string[] {
	const out: string[] = [];
	const walk = (v: unknown): void => {
		if (typeof v === 'string') {
			out.push(v);
			return;
		}
		if (Array.isArray(v)) {
			for (const item of v) {
				walk(item);
			}
		}
	};
	walk(value);
	return out;
}

export interface SelectedSetupSpec {
	/** The config key that won selection, if any. */
	key?: string;
	/** Command list form (already flattened, not yet trimmed). */
	commands?: string[];
	/** Script-file form (raw string value from the config). */
	scriptValue?: string;
}

/**
 * Key selection exactly as the binary: OS-specific key wins when it is
 * `!== undefined`, otherwise the generic `setup-worktree`. A string value
 * is a script file; any other defined value is flattened into commands.
 */
export function selectSetupSpec(config: Record<string, unknown>, isWindows: boolean): SelectedSetupSpec {
	let value: unknown;
	let key: string | undefined;
	if (isWindows) {
		if (config['setup-worktree-windows'] !== undefined) {
			value = config['setup-worktree-windows'];
			key = 'setup-worktree-windows';
		} else if (config['setup-worktree'] !== undefined) {
			value = config['setup-worktree'];
			key = 'setup-worktree';
		}
	} else {
		if (config['setup-worktree-unix'] !== undefined) {
			value = config['setup-worktree-unix'];
			key = 'setup-worktree-unix';
		} else if (config['setup-worktree'] !== undefined) {
			value = config['setup-worktree'];
			key = 'setup-worktree';
		}
	}
	if (key === undefined) {
		return {};
	}
	if (typeof value === 'string') {
		return { key, scriptValue: value };
	}
	if (value !== undefined) {
		return { key, commands: flattenSetupCommands(value) };
	}
	return { key };
}

/** Absolute-path test from the binary: Windows drive/UNC, Unix leading `/`. */
export function isAbsoluteSetupScriptPath(p: string, isTargetWindows: boolean): boolean {
	return isTargetWindows ? /^[a-zA-Z]:[\\/]/.test(p) || p.startsWith('\\\\') : p.startsWith('/');
}

/** `FWn`: single-quote escaping for the Unix script builders. */
export function escapeSetupSingleQuotes(t: string): string {
	return t.replace(/'/g, "'\\''");
}

/** `BWn`: backtick/quote escaping for the Windows script builders. */
export function escapeSetupWindows(t: string): string {
	return t.replace(/`/g, '``').replace(/"/g, '`"');
}

/**
 * `c4x` verbatim: combined Unix script for a command list. Commands are
 * chained with `&&` (a failing command stops the chain), each wrapped in
 * `[worktree-setup] [i] $ …` / `[worktree-setup] [i] done` log lines. The
 * script cds into the worktree, exports `ROOT_WORKTREE_PATH`, and sets
 * `$1` = worktreePath via `set --`.
 */
export function buildUnixCommandsScript(worktreePath: string, rootWorkspacePath: string, commands: string[]): string {
	const r = escapeSetupSingleQuotes(worktreePath);
	const s = escapeSetupSingleQuotes(rootWorkspacePath);
	const o = commands
		.map((a, l) => {
			const c = escapeSetupSingleQuotes(a);
			return `printf '%s\\n' '[worktree-setup] [${l}] $ ${c}' && ${a} && printf '%s\\n' '[worktree-setup] [${l}] done'`;
		})
		.join(' && ');
	return `cd '${r}' || { printf '%s\\n' '[worktree-setup] ERROR: Failed to cd to worktree directory'; exit 1; } && export ROOT_WORKTREE_PATH='${s}' && set -- '${r}' && printf '%s\\n' '[worktree-setup] Working directory: '$(pwd) && ${o}`;
}

/** `u4x` verbatim: combined Windows (PowerShell) script for a command list. */
export function buildWindowsCommandsScript(worktreePath: string, rootWorkspacePath: string, commands: string[]): string {
	const r = escapeSetupWindows(worktreePath);
	const s = escapeSetupWindows(rootWorkspacePath);
	const o = commands
		.map((a, l) => {
			const c = escapeSetupWindows(a);
			return `Write-Host "[worktree-setup] [${l}] $ ${c}"; ${a}; if ($LASTEXITCODE -ne $null -and $LASTEXITCODE -ne 0) { Write-Host "[worktree-setup] [${l}] failed with exit code $LASTEXITCODE"; exit $LASTEXITCODE } else { Write-Host "[worktree-setup] [${l}] done" }`;
		})
		.join('; ');
	return `$ErrorActionPreference = 'Stop'; Set-Location -LiteralPath "${r}"; $env:ROOT_WORKTREE_PATH = "${s}"; Write-Host '[worktree-setup] Working directory: ' (Get-Location); ${o}`;
}

/** `d4x` verbatim: Unix script-file invocation (`bash '<script>' '<worktree>'`). */
export function buildUnixScriptFileScript(worktreePath: string, rootWorkspacePath: string, scriptPath: string): string {
	const r = escapeSetupSingleQuotes(worktreePath);
	const s = escapeSetupSingleQuotes(rootWorkspacePath);
	const o = escapeSetupSingleQuotes(scriptPath);
	return `cd '${r}' || { printf '%s\\n' '[worktree-setup] ERROR: Failed to cd to worktree directory'; exit 1; } && export ROOT_WORKTREE_PATH='${s}' && printf '%s\\n' '[worktree-setup] Executing setup script: ${o}' && bash '${o}' '${r}'`;
}

/** `h4x` verbatim: Windows script-file invocation (`& "<script>" "<worktree>"`). */
export function buildWindowsScriptFileScript(worktreePath: string, rootWorkspacePath: string, scriptPath: string): string {
	const r = escapeSetupWindows(worktreePath);
	const s = escapeSetupWindows(rootWorkspacePath);
	const o = escapeSetupWindows(scriptPath);
	return `$ErrorActionPreference = 'Stop'; Set-Location -LiteralPath "${r}"; $env:ROOT_WORKTREE_PATH = "${s}"; & "${o}" "${r}"`;
}
