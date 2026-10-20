/**
 * nodeGitRunner — real `IGitRunner` backed by `node:child_process`.
 *
 * Applies the git-hardening-layer (gitHardening.ts) to every spawn:
 *  - user-controlled args are deny-list checked (`assertSafeGitArgs`);
 *  - forced `--no-ext-diff --no-textconv` on diff/show/blame/log/whatchanged;
 *  - locked-down env via `GIT_CONFIG_COUNT` merge (`buildHardenedGitEnv`);
 *  - 64 MiB output buffer cap (`GIT_MAX_BUFFER_BYTES`);
 *  - detached-child protection: the child is spawned detached and the whole
 *    process group is signalled on timeout/cancel so stray grandchildren die;
 *  - stdin is `/dev/null` (ignore) so git never prompts;
 *  - `--no-optional-locks` is used by the caller for status (see provider).
 *
 * The streaming early-exit path SIGTERMs git on the first stdout byte —
 * the verbatim `workingTreeIsDirty` optimization from the evidence.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import {
	assertSafeGitArgs,
	buildHardenedGitEnv,
	GIT_MAX_BUFFER_BYTES,
	GIT_TIMEOUT_MS,
	scrubGitArgsForLog,
	withForcedNoExtDiff,
} from './gitHardening.js';
import type { GitRunOptions, GitRunResult, IGitRunner } from './checkoutProvider.js';

function killProcessTree(child: ChildProcess, signal: NodeJS.Signals = 'SIGTERM'): void {
	try {
		if (child.pid !== undefined) {
			// Detached-child protection: signal the whole process group so
			// grandchildren (credential helpers, filters) die with git.
			process.kill(-child.pid, signal);
			return;
		}
	} catch {
		// Fall through to direct kill.
	}
	try {
		child.kill(signal);
	} catch {
		// Already exited.
	}
}

export class NodeGitRunner implements IGitRunner {
	private _gitVersion: Promise<string> | undefined;

	constructor(private readonly gitPath: string = 'git') { }

	async getGitVersion(): Promise<string> {
		if (!this._gitVersion) {
			this._gitVersion = this.run(['--version'], { cwd: process.cwd() })
				.then((r) => r.stdout.trim() || r.stderr.trim())
				.catch(() => '');
		}
		return this._gitVersion;
	}

	async run(args: readonly string[], options: GitRunOptions): Promise<GitRunResult> {
		assertSafeGitArgs(args);
		const finalArgs = withForcedNoExtDiff(args);
		const env = buildHardenedGitEnv(options.env);
		const timeoutMs = options.timeoutMs ?? GIT_TIMEOUT_MS;

		return new Promise<GitRunResult>((resolve, reject) => {
			let child: ChildProcess;
			try {
				child = spawn(this.gitPath, finalArgs, {
					cwd: options.cwd,
					env,
					stdio: ['ignore', 'pipe', 'pipe'],
					// Detached so we can signal the whole process group.
					detached: process.platform !== 'win32',
					windowsHide: true,
				});
			} catch (error) {
				reject(error instanceof Error ? error : new Error(String(error)));
				return;
			}

			let stdout = '';
			let stderr = '';
			let stdoutBytes = 0;
			let stderrBytes = 0;
			let settled = false;

			const timer = setTimeout(() => {
				if (!settled) {
					settled = true;
					killProcessTree(child, 'SIGKILL');
					reject(new Error(`[ide-checkout] git timed out after ${timeoutMs}ms: ${scrubGitArgsForLog(finalArgs).join(' ')}`));
				}
			}, timeoutMs);
			timer.unref?.();

			const onAbort = () => {
				if (!settled) {
					settled = true;
					clearTimeout(timer);
					killProcessTree(child, 'SIGTERM');
					reject(new Error('[ide-checkout] git operation was cancelled.'));
				}
			};
			options.signal?.addEventListener('abort', onAbort, { once: true });

			child.stdout?.on('data', (chunk: Buffer) => {
				stdoutBytes += chunk.length;
				if (stdoutBytes <= GIT_MAX_BUFFER_BYTES) {
					stdout += chunk.toString('utf8');
				}
			});
			child.stderr?.on('data', (chunk: Buffer) => {
				stderrBytes += chunk.length;
				if (stderrBytes <= GIT_MAX_BUFFER_BYTES) {
					stderr += chunk.toString('utf8');
				}
			});
			child.on('error', (error) => {
				if (!settled) {
					settled = true;
					clearTimeout(timer);
					options.signal?.removeEventListener('abort', onAbort);
					reject(error);
				}
			});
			child.on('close', (code, signal) => {
				if (!settled) {
					settled = true;
					clearTimeout(timer);
					options.signal?.removeEventListener('abort', onAbort);
					resolve({
						stdout,
						stderr,
						exitCode: code ?? (signal ? 128 : 1),
					});
				}
			});
		});
	}

	async runStreamingEarlyExit(args: readonly string[], options: GitRunOptions): Promise<boolean> {
		assertSafeGitArgs(args);
		const finalArgs = withForcedNoExtDiff(args);
		const env = buildHardenedGitEnv(options.env);
		const timeoutMs = options.timeoutMs ?? GIT_TIMEOUT_MS;

		return new Promise<boolean>((resolve, reject) => {
			let child: ChildProcess;
			try {
				child = spawn(this.gitPath, finalArgs, {
					cwd: options.cwd,
					env,
					stdio: ['ignore', 'pipe', 'pipe'],
					detached: process.platform !== 'win32',
					windowsHide: true,
				});
			} catch (error) {
				reject(error instanceof Error ? error : new Error(String(error)));
				return;
			}

			let settled = false;
			const timer = setTimeout(() => {
				if (!settled) {
					settled = true;
					killProcessTree(child, 'SIGKILL');
					reject(new Error(`[ide-checkout] git timed out after ${timeoutMs}ms: ${scrubGitArgsForLog(finalArgs).join(' ')}`));
				}
			}, timeoutMs);
			timer.unref?.();

			const settle = (dirty: boolean) => {
				if (!settled) {
					settled = true;
					clearTimeout(timer);
					options.signal?.removeEventListener('abort', onAbort);
					killProcessTree(child, 'SIGTERM');
					resolve(dirty);
				}
			};
			const onAbort = () => {
				if (!settled) {
					settled = true;
					clearTimeout(timer);
					killProcessTree(child, 'SIGTERM');
					reject(new Error('[ide-checkout] git operation was cancelled.'));
				}
			};
			options.signal?.addEventListener('abort', onAbort, { once: true });

			// Early-exit perf optimization (verbatim from evidence): kill git
			// (SIGTERM) on the first byte of stdout.
			child.stdout?.on('data', (chunk: Buffer) => {
				if (chunk.length > 0) {
					settle(true);
				}
			});
			child.stderr?.resume();
			child.on('error', (error) => {
				if (!settled) {
					settled = true;
					clearTimeout(timer);
					options.signal?.removeEventListener('abort', onAbort);
					reject(error);
				}
			});
			child.on('close', () => settle(false));
		});
	}
}
