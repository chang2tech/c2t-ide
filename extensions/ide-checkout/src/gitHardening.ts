/**
 * gitHardening — hardened git invocation layer for the `ide-checkout`
 * extension (DEV-GAPS-33 `git-hardening-layer`).
 *
 * Evidence (Cursor, decompiled `cursor-checkout` v0.0.1, Cursor 3.25.9 —
 * `~/workspace/ide-code-mission/docs/rea/harvest-cursor-checkout-2026-10-19.md`):
 * "all git spawns go through it":
 *  - arg sanitization: denies `-c/-C/--git-dir/--work-tree/--namespace/
 *    --super-prefix/--config-env/--attr-source` in user-controlled args;
 *    forces `--no-ext-diff --no-textconv` onto diff/show/blame/log/whatchanged.
 *  - URL scrubbing: strips credentials/userinfo from git args in logs
 *    (regex on `https?://\S+`, trims trailing `)"'<>,.;:\]}`).
 *  - env lockdown: `GIT_CONFIG_COUNT` merge injects
 *    `safe.bareRepository=explicit`, `core.fsmonitor=false`,
 *    `core.hooksPath=/dev/null` (block unless repo allows hooks),
 *    `core.attributesFile=/dev/null`; `GIT_PAGER=cat`;
 *    `LC_ALL/LANG=en_US.UTF-8`; VSCODE_GIT_COMMAND passthrough;
 *    `--no-optional-locks status --porcelain`.
 *  - fetch uses `--no-write-fetch-head` when git >= 2.29 (version probe
 *    cached).
 *  - `workingTreeIsDirty` streams `status --porcelain` and kills git
 *    (SIGTERM) on first byte of stdout — early-exit perf optimization.
 *  - max buffer 64 MiB; detached-child protection for spawned git.
 *  - branch-name normalization strips `refs/heads/`, `heads/`, `remotes/`,
 *    `origin/` prefixes; rejects names starting with `-`; rejects detached
 *    HEAD for push flows.
 *
 * Structure/behavior only; no proprietary code reproduced. This is the
 * checkout family's own hardening module — the extension host cannot import
 * the workbench-side `gitSanitize.ts` twin, and this layer additionally
 * covers arg denial, env lockdown, early-exit streaming, and branch-name
 * normalization, which the twins do not.
 */

/** Max buffer for git child output: 64 MiB (verbatim from evidence). */
export const GIT_MAX_BUFFER_BYTES = 64 * 1024 * 1024;

/** Default timeout for a single git invocation. */
export const GIT_TIMEOUT_MS = 60_000;

/** Warm-prefetch cache TTL: 30 s (verbatim from evidence). */
export const WARM_CACHE_TTL_MS = 30_000;

/**
 * User-controlled args must never contain these — they let a caller escape
 * the repo, inject config, or redirect git's filesystem view. Verbatim deny
 * list from the evidence.
 */
const DENIED_GIT_ARGS = new Set([
	'-c',
	'-C',
	'--git-dir',
	'--work-tree',
	'--namespace',
	'--super-prefix',
	'--config-env',
	'--attr-source',
]);

/**
 * Throws when any user-controlled arg is on the deny list. Compares the
 * arg name before `=` so `--git-dir=/x` is caught too.
 */
export function assertSafeGitArgs(args: readonly string[]): void {
	for (const arg of args) {
		const name = arg.includes('=') ? arg.slice(0, arg.indexOf('=')) : arg;
		if (DENIED_GIT_ARGS.has(name)) {
			throw new Error(`[ide-checkout] Denied git argument: ${arg}`);
		}
	}
}

/**
 * Subcommands onto which `--no-ext-diff --no-textconv` is forced (verbatim
 * from evidence): diff, show, blame, log, whatchanged.
 */
const NO_EXT_DIFF_SUBCOMMANDS = new Set(['diff', 'show', 'blame', 'log', 'whatchanged']);

/**
 * Inserts `--no-ext-diff --no-textconv` right after the subcommand when the
 * subcommand is one of the forced set; otherwise returns the args unchanged.
 * Deterministic output: no external diff drivers, no textconv filters.
 */
export function withForcedNoExtDiff(args: readonly string[]): string[] {
	const [subcommand, ...rest] = args;
	if (subcommand !== undefined && NO_EXT_DIFF_SUBCOMMANDS.has(subcommand)) {
		return [subcommand, '--no-ext-diff', '--no-textconv', ...rest];
	}
	return [...args];
}

/**
 * Scrubs a git arg for logging: strips credentials/userinfo from
 * `http(s)://` URLs (regex on `https?://\S+`), trimming trailing
 * `)"'<>,.;:\]}` punctuation first so `(<url>).` in prose doesn't leak a
 * truncated-but-still-secret userinfo. Non-URL args pass through unchanged.
 */
export function scrubGitArgForLog(arg: string): string {
	return arg.replace(/https?:\/\/\S+/g, (url) => {
		const trimmed = url.replace(/[)"'<>,.;:\]}]+$/, '');
		const trailing = url.slice(trimmed.length);
		const scrubbed = trimmed.replace(/^([a-zA-Z][a-zA-Z0-9+.-]*:\/\/)([^/@]*@)/, '$1');
		return scrubbed + trailing;
	});
}

/** Scrubs every arg of an argv array for logging. */
export function scrubGitArgsForLog(args: readonly string[]): string[] {
	return args.map(scrubGitArgForLog);
}

/**
 * The four safe configs injected via `GIT_CONFIG_COUNT` merge (verbatim
 * from evidence). Do not reformat.
 */
const SAFE_GIT_CONFIG_PAIRS: ReadonlyArray<readonly [string, string]> = [
	['safe.bareRepository', 'explicit'],
	['core.fsmonitor', 'false'],
	['core.hooksPath', '/dev/null'],
	['core.attributesFile', '/dev/null'],
];

/**
 * Builds the locked-down environment for git spawns: `GIT_CONFIG_COUNT`
 * merge injects the four safe configs; `GIT_PAGER=cat` (no interactive
 * pager); `LC_ALL`/`LANG=en_US.UTF-8` (deterministic, parseable output);
 * `VSCODE_GIT_COMMAND` passes through untouched when present.
 */
export function buildHardenedGitEnv(extra?: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = { ...process.env };
	if (extra) {
		for (const [key, value] of Object.entries(extra)) {
			if (value !== undefined) {
				env[key] = value;
			}
		}
	}
	env['GIT_CONFIG_COUNT'] = String(SAFE_GIT_CONFIG_PAIRS.length);
	SAFE_GIT_CONFIG_PAIRS.forEach(([key, value], index) => {
		env[`GIT_CONFIG_KEY_${index}`] = key;
		env[`GIT_CONFIG_VALUE_${index}`] = value;
	});
	env['GIT_PAGER'] = 'cat';
	env['LC_ALL'] = 'en_US.UTF-8';
	env['LANG'] = 'en_US.UTF-8';
	return env;
}

/**
 * Branch-name normalization (verbatim from evidence): strips `refs/heads/`,
 * `heads/`, `remotes/`, `origin/` prefixes (repeatedly, so compound forms
 * like `remotes/origin/<b>` fully normalize). Returns the normalized name.
 */
export function normalizeBranchName(name: string): string {
	let normalized = name.trim();
	const prefixes = ['refs/heads/', 'refs/remotes/', 'heads/', 'remotes/', 'origin/'];
	let stripped = true;
	while (stripped) {
		stripped = false;
		for (const prefix of prefixes) {
			if (normalized.startsWith(prefix)) {
				normalized = normalized.slice(prefix.length);
				stripped = true;
				break;
			}
		}
	}
	return normalized;
}

/**
 * Validates a branch name for checkout flows (verbatim from evidence):
 * rejects empty names and names starting with `-` (option injection).
 */
export function assertValidBranchName(name: string): void {
	if (!name) {
		throw new Error('[ide-checkout] Branch name must not be empty.');
	}
	if (name.startsWith('-')) {
		throw new Error(`[ide-checkout] Invalid branch name: ${JSON.stringify(name)}`);
	}
}

/**
 * Whether the probed git version supports `--no-write-fetch-head`
 * (git >= 2.29, verbatim from evidence). Parses `git --version` output
 * like `git version 2.43.0`.
 */
export function supportsNoWriteFetchHead(gitVersionOutput: string): boolean {
	const match = /git version (\d+)\.(\d+)/.exec(gitVersionOutput);
	if (!match) {
		return false;
	}
	const major = Number(match[1]);
	const minor = Number(match[2]);
	return major > 2 || (major === 2 && minor >= 29);
}

/**
 * Friendly non-fast-forward push error (verbatim from evidence):
 * `Your branch "<b>" is behind <remote>. Pull the latest changes, then try
 * moving to cloud again.` — confirms the feature name "moving to cloud".
 */
export function nonFastForwardErrorMessage(branch: string, remote: string): string {
	return `Your branch "${branch}" is behind ${remote}. Pull the latest changes, then try moving to cloud again.`;
}

/**
 * Detects a non-fast-forward rejection in git push stderr.
 */
export function isNonFastForwardPushError(stderr: string): boolean {
	return /non-fast-forward|rejected.*fetch first|behind.*remote/i.test(stderr);
}
