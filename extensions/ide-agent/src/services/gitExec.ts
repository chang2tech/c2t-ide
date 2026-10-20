/**
 * gitExec — centralized git invocation wrapper (DEV-GAPS-14 `ext-git-sanitize`).
 *
 * Evidence (Cursor, DIG-AST-EXT 2026-10-19 on `cursor-agent-host/dist/main.js`,
 * Cursor 3.25.6): "Before running git commands, strips user@ credentials
 * from URLs; forces safe.bareRepository=explicit, core.fsmonitor=false,
 * core.hooksPath=/dev/null, core.attributesFile=/dev/null".
 *
 * Every git invocation from the ide-agent extension MUST go through
 * `gitExecFile` (or apply `withSafeGitArgs` to its argv) so that:
 *
 *  1. Credentials embedded as `user@` / `user:pass@` userinfo in URLs never
 *     reach the child-process argv (no leak into process lists, logs, or
 *     error messages). The userinfo is stripped from the URL handed to git;
 *     authentication — when needed — must come from a credential helper or
 *     the environment, NEVER from argv. This is documented behavior, not a
 *     silent fallback: callers needing authenticated remotes should configure
 *     `credential.helper` / `GIT_ASKPASS` instead of embedding credentials.
 *
 *  2. The four safe `-c` configs below are forced VERBATIM on EVERY git
 *     invocation, placed before the subcommand. Rationale (matching Cursor):
 *       - `safe.bareRepository=explicit`: never implicitly treat the cwd as a
 *         bare repo (prevents operating on the wrong repo).
 *       - `core.fsmonitor=false`: deterministic file status; no Watchman /
 *         fsmonitor daemon dependency.
 *       - `core.hooksPath=/dev/null`: no repo hooks execute as a side effect
 *         of IDE-driven git commands.
 *       - `core.attributesFile=/dev/null`: ignore repo .gitattributes so
 *         output (diffs, filters) is deterministic.
 *
 * SCOPE NOTE (honest): userinfo is stripped only from `scheme://` URLs
 * (e.g. `https://user:pass@host/x` -> `https://host/x`). SCP-like syntax
 * (`git@github.com:org/repo.git`) is left untouched — there `git` is the SSH
 * login user, not a credential, and stripping it would break SSH auth. The
 * evidence only says "strips user@ credentials from URLs"; the scp-like
 * carve-out is OUR interpretation, documented here.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export const GIT_TIMEOUT_MS = 30_000;
export const GIT_MAX_BUFFER = 4 * 1024 * 1024;

/**
 * The four safe `-c` configs, VERBATIM per Cursor evidence (DIG-AST-EXT
 * 2026-10-19). Do not reformat: `safe.bareRepository=explicit`,
 * `core.fsmonitor=false`, `core.hooksPath=/dev/null`,
 * `core.attributesFile=/dev/null`.
 */
export const GIT_SAFE_CONFIG_ARGS: readonly string[] = [
  "-c",
  "safe.bareRepository=explicit",
  "-c",
  "core.fsmonitor=false",
  "-c",
  "core.hooksPath=/dev/null",
  "-c",
  "core.attributesFile=/dev/null",
];

/**
 * Strip `userinfo@` credentials from a `scheme://` URL argument.
 * `https://user:pass@host/repo.git` -> `https://host/repo.git`.
 * Non-URL args (flags, revs, paths, scp-like `git@host:path`) pass through
 * unchanged.
 */
export function stripGitUrlCredentials(arg: string): string {
  // ^(scheme://)(userinfo@)(rest)$ — userinfo is `[^/@]*` so the `@` matched
  // is the LAST one before the host (covers `user@`, `user:pass@`, `:pass@`).
  return arg.replace(/^([a-zA-Z][a-zA-Z0-9+.-]*:\/\/)([^/@]*@)(.*)$/, "$1$3");
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

export interface GitExecOptions {
  timeoutMs?: number;
  maxBuffer?: number;
}

/** Process-spawn seam, injectable for tests (default: real `git` spawn). */
export type GitSpawner = (
  file: string,
  args: string[],
  opts: { cwd: string; timeout: number; maxBuffer: number },
) => Promise<{ stdout: string; stderr: string }>;

async function defaultSpawner(
  file: string,
  args: string[],
  opts: { cwd: string; timeout: number; maxBuffer: number },
): Promise<{ stdout: string; stderr: string }> {
  const { stdout, stderr } = await execFileAsync(file, args, opts);
  return { stdout: stdout ?? "", stderr: stderr ?? "" };
}

let spawner: GitSpawner = defaultSpawner;

/** Test seam: swap the process spawner for a fake. Not for production use. */
export function __setGitSpawnerForTests(next: GitSpawner): void {
  spawner = next;
}

/** Test seam: restore the real `git` spawner. */
export function __resetGitSpawnerForTests(): void {
  spawner = defaultSpawner;
}

/**
 * Run `git` with an argument array (never a shell string — no injection).
 * The argv is sanitized (URL credentials stripped) and the four safe `-c`
 * configs are forced before the subcommand. Returns stdout/stderr; rejects
 * on non-zero exit like execFile.
 */
export async function gitExecFile(
  cwd: string,
  args: readonly string[],
  opts: GitExecOptions = {},
): Promise<{ stdout: string; stderr: string }> {
  const finalArgs = withSafeGitArgs(args);
  return spawner("git", finalArgs, {
    cwd,
    timeout: opts.timeoutMs ?? GIT_TIMEOUT_MS,
    maxBuffer: opts.maxBuffer ?? GIT_MAX_BUFFER,
  });
}
