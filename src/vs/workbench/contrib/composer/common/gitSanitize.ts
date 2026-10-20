/**
 * gitSanitize — workbench-side git argv sanitizer (DEV-GAPS-14 `ext-git-sanitize`).
 *
 * Evidence (Cursor, DIG-AST-EXT 2026-10-19 on `cursor-agent-host/dist/main.js`,
 * Cursor 3.25.6): "Before running git commands, strips user@ credentials
 * from URLs; forces safe.bareRepository=explicit, core.fsmonitor=false,
 * core.hooksPath=/dev/null, core.attributesFile=/dev/null".
 *
 * This is the workbench-runtime twin of
 * `extensions/ide-agent/src/services/gitExec.ts` (the extension host cannot
 * import workbench modules and vice versa). Keep the two in sync:
 * the four `-c` configs below must stay VERBATIM.
 */

/**
 * The four safe `-c` configs, VERBATIM per Cursor evidence (DIG-AST-EXT
 * 2026-10-19). Do not reformat: `safe.bareRepository=explicit`,
 * `core.fsmonitor=false`, `core.hooksPath=/dev/null`,
 * `core.attributesFile=/dev/null`.
 */
export const GIT_SAFE_CONFIG_ARGS: readonly string[] = [
	'-c',
	'safe.bareRepository=explicit',
	'-c',
	'core.fsmonitor=false',
	'-c',
	'core.hooksPath=/dev/null',
	'-c',
	'core.attributesFile=/dev/null',
];

/**
 * Strip `userinfo@` credentials from a `scheme://` URL argument.
 * `https://user:pass@host/repo.git` -> `https://host/repo.git`.
 * Non-URL args (flags, revs, paths, scp-like `git@host:path`) pass through
 * unchanged. SCP-like syntax is intentionally untouched: there `git` is the
 * SSH login user, not a credential (OUR interpretation — the evidence only
 * says "strips user@ credentials from URLs").
 */
export function stripGitUrlCredentials(arg: string): string {
	return arg.replace(/^([a-zA-Z][a-zA-Z0-9+.-]*:\/\/)([^/@]*@)(.*)$/, '$1$3');
}

/**
 * Sanitize every argv entry (strip URL credentials) and prepend the forced
 * safe `-c` config args. Prepending at index 0 keeps the `-c` flags ahead of
 * the subcommand even when the caller passes its own global options (e.g.
 * `-C <dir>`), because git global options must precede the subcommand.
 */
export function withSafeGitArgs(args: readonly string[]): string[] {
	const sanitized = args.map(stripGitUrlCredentials);
	return [...GIT_SAFE_CONFIG_ARGS, ...sanitized];
}
