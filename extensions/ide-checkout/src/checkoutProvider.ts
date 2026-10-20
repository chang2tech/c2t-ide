/**
 * checkoutProvider — `CheckoutProvider` implementation for the
 * `ide-checkout` extension (DEV-GAPS-33, protocol-shape fix DEV-GAPS-42A/F1-1).
 *
 * Feature set (all verbatim from the decompiled `cursor-checkout` v0.0.1,
 * Cursor 3.25.9 — `~/workspace/ide-code-mission/docs/rea/harvest-cursor-checkout-2026-10-19.md`
 * and `resources/app/extensions/cursor-checkout/dist/main.js`,
 * structure/behavior only):
 *
 *  - `checkout-provider-protocol` — the provider protocol registered with the
 *    workbench via `vscode.cursor.registerCheckoutProvider(provider)`.
 *    **Protocol shape (verbatim):**
 *    `checkoutBranch(delegate, branchName, { commitSha?, localOnly? }, token)`
 *    — the conflict delegate comes FIRST. The delegate is built by the
 *    extHost (`{ resolveConflict: () => $resolveCheckoutConflict(id),
 *    onNoConflictDetected: () => $notifyCheckoutNoConflict(id) }`); calling
 *    `delegate.resolveConflict()` RPCs back to the main thread, where
 *    workbench core shows the stash/commit/discard/cancel QuickPick
 *    (`src/vs/workbench/contrib/checkout/`). The extension renders NO UI
 *    itself.
 *  - `checkout-conflict-resolution` — dirty-tree conflict resolution during
 *    checkout/migration (stash / commit / discard).
 *  - `snapshot-push-cloud-branch` — snapshot the dirty tree and push it to a
 *    new cloud branch ("move to cloud") without touching the working tree.
 *  - `branch-warm-prefetch` — pre-fetch `+refs/heads/<b>:refs/remotes/origin/<b>`
 *    with a 30 s warm cache (`recentlyWarmedBranches`).
 *  - `git-hardening-layer` — every git spawn goes through
 *    `gitHardening.ts` (arg denial, forced flags, URL scrubbing, env
 *    lockdown, early-exit dirty check, 64 MiB buffer, branch-name
 *    normalization).
 *
 * The provider takes an `IGitRunner` so unit tests can inject a fake; the
 * extension wires the real node implementation.
 */

import * as os from 'node:os';
import * as path from 'node:path';
import type * as vscode from 'vscode';
import {
	assertSafeGitArgs,
	assertValidBranchName,
	isNonFastForwardPushError,
	nonFastForwardErrorMessage,
	normalizeBranchName,
	supportsNoWriteFetchHead,
	withForcedNoExtDiff,
	WARM_CACHE_TTL_MS,
} from './gitHardening.js';

export type CheckoutConflictResolution = 'stash' | 'commit' | 'discard';

/**
 * The conflict delegate handed to `checkoutBranch` as its first argument
 * (verbatim protocol shape). Implemented by the extHost; `resolveConflict()`
 * RPCs back to the main thread where workbench core shows the QuickPick.
 */
export interface ICheckoutConflictDelegate {
	resolveConflict(): Promise<CheckoutConflictResolution | 'abort' | undefined>;
	onNoConflictDetected(): void;
}

export interface CheckoutBranchOptions {
	readonly commitSha?: string;
	readonly localOnly?: boolean;
}

export interface EnsureBranchPushedOptions {
	readonly cwd?: string;
	readonly remoteName?: string;
	readonly branchName?: string;
	readonly forcePush?: boolean;
}

export interface SnapshotPushOptions {
	readonly cwd?: string;
	readonly remoteName?: string;
	readonly commitMessage?: string;
	readonly branchPrefix?: string;
	readonly stashLocalChangesAfterPush?: boolean;
	readonly stashMessage?: string;
}

export interface GitRunOptions {
	readonly cwd: string;
	/** Extra env vars merged over the hardened env (e.g. GIT_INDEX_FILE). */
	readonly env?: NodeJS.ProcessEnv;
	readonly timeoutMs?: number;
	/** AbortSignal cancels the spawn (SIGTERM). */
	readonly signal?: AbortSignal;
	/** When true, stdin is inherited as /dev/null-safe (no prompt). */
	readonly noPrompt?: boolean;
}

export interface GitRunResult {
	readonly stdout: string;
	readonly stderr: string;
	readonly exitCode: number;
}

/**
 * Hardened git runner. Implementations must apply `gitHardening.ts`:
 * deny-listed args rejected, forced flags inserted, env locked down,
 * 64 MiB buffer cap, detached-child protection.
 */
export interface IGitRunner {
	/** Runs git and collects output. Rejects on spawn failure; resolves with exitCode otherwise. */
	run(args: readonly string[], options: GitRunOptions): Promise<GitRunResult>;
	/**
	 * Streaming early-exit dirty check: resolves `true` on the first byte of
	 * stdout (and SIGTERMs git), `false` when git exits with no output.
	 * Used for `hasDirtyWorkingTree`.
	 */
	runStreamingEarlyExit(args: readonly string[], options: GitRunOptions): Promise<boolean>;
	/** Cached `git --version` probe, e.g. `git version 2.43.0`. */
	getGitVersion(): Promise<string>;
}

const DEFAULT_REMOTE = 'origin';
const DEFAULT_SNAPSHOT_MESSAGE = 'Cursor: Apply local changes for cloud agent';
const DEFAULT_STASH_MESSAGE = 'Cursor: moved local changes to cloud agent';
const DEFAULT_BRANCH_PREFIX = 'cursor/';

/** Minimal vscode API surface the provider needs (kept narrow for tests). */
export interface ICancellation {
	readonly isCancellationRequested: boolean;
	readonly onCancellationRequested: vscode.Event<unknown>;
}

function toAbortSignal(token: ICancellation): AbortSignal | undefined {
	if (token.isCancellationRequested) {
		return AbortSignal.abort();
	}
	const controller = new AbortController();
	const listener = token.onCancellationRequested(() => controller.abort());
	// `vscode.Event` disposables don't need explicit cleanup here; the
	// controller is scoped to a single git invocation.
	void listener;
	return controller.signal;
}

function throwIfCancelled(token: ICancellation): void {
	if (token.isCancellationRequested) {
		throw new Error('[ide-checkout] Checkout operation was cancelled.');
	}
}

export interface CheckoutProviderDeps {
	readonly now?: () => number;
	readonly unlink?: (filePath: string) => Promise<void>;
	readonly randomSuffix?: () => string;
}

export class CheckoutProviderImpl implements vscode.cursor.CheckoutProvider {
	/** `recentlyWarmedBranches` — verbatim name from the evidence. */
	private readonly recentlyWarmedBranches = new Map<string, number>();
	private _noWriteFetchHead: boolean | undefined;

	constructor(
		private readonly git: IGitRunner,
		private readonly deps: CheckoutProviderDeps = {},
	) { }

	private now(): number {
		return this.deps.now ? this.deps.now() : Date.now();
	}

	// ------------------------------------------------------------------ //
	// checkout-provider-protocol: checkoutBranch
	// ------------------------------------------------------------------ //

	/**
	 * Full branch-checkout flow (verbatim from evidence).
	 *
	 * Protocol shape (verbatim): `checkoutBranch(delegate, branchName,
	 * { commitSha?, localOnly? }, token)` — delegate first. On a dirty tree
	 * the provider calls `delegate.resolveConflict()` (the core QuickPick via
	 * RPC) and applies: stash / commit / discard; anything else (including
	 * `'abort'`/dismissed) throws `Aborting checkout` — the exact message
	 * Cursor's core matches to categorize user-abort.
	 *
	 * 1. Dirty tree → `delegate.resolveConflict()` (stash / commit / discard).
	 * 2. `localOnly` → verify `refs/heads/<b>` exists, plain checkout.
	 * 3. `commitSha` fetchable from origin → `checkoutFetchedCommit`
	 *    (same SHA → FF `-B`; ancestor → detach at SHA; else `-b <b> <sha>`).
	 * 4. Otherwise fetch (skipped when warmed in the last 30 s), then local
	 *    branch → `checkout`; remote branch → `-b <b> origin/<b>`; else throw
	 *    `Remote branch not found on origin: <b>`.
	 * 5. Finally `git merge --ff-only --quiet origin/<b>`.
	 */
	async checkoutBranch(delegate: ICheckoutConflictDelegate, branchName: string, options: CheckoutBranchOptions, token: ICancellation, cwd?: string): Promise<void> {
		const branch = normalizeBranchName(branchName);
		assertValidBranchName(branch);
		const repoCwd = cwd ?? process.cwd();
		const opts = (extra?: GitRunOptions): GitRunOptions => ({
			cwd: repoCwd,
			signal: toAbortSignal(token),
			...extra,
		});

		if (await this.hasDirtyWorkingTree(token, repoCwd)) {
			const choice = await delegate.resolveConflict();
			throwIfCancelled(token);
			if (choice === 'stash') {
				// stash → `git stash --include-untracked` (verbatim)
				await this.git.run(withForcedNoExtDiff(['stash', '--include-untracked']), opts());
			} else if (choice === 'commit') {
				// commit → `git add -A` + `git commit -m "checkpoint before checking out <branch>"` (verbatim)
				await this.git.run(['add', '-A'], opts());
				await this.git.run(['commit', '-m', `checkpoint before checking out ${branch}`], opts());
			} else if (choice === 'discard') {
				// discard → `git reset --quiet --hard HEAD` + `git clean --quiet -fd` (verbatim)
				await this.git.run(['reset', '--quiet', '--hard', 'HEAD'], opts());
				await this.git.run(['clean', '--quiet', '-fd'], opts());
			} else {
				// 'abort', dismissed, or anything else → `Aborting checkout`
				// (verbatim message; core matches it to categorize user-abort).
				throw new Error('Aborting checkout');
			}
		}
		throwIfCancelled(token);

		if (options.localOnly) {
			// localOnly: true → verify `refs/heads/<b>` exists, plain checkout.
			if (!await this.localBranchExists(branch, repoCwd, token)) {
				throw new Error(`[ide-checkout] Local branch not found: ${branch}`);
			}
			await this.git.run(['checkout', branch], opts());
			return;
		}

		if (options.commitSha) {
			const sha = options.commitSha;
			if (await this.commitFetchableFromOrigin(sha, repoCwd, token)) {
				await this.checkoutFetchedCommit(branch, sha, repoCwd, token);
				return;
			}
		}

		// Fetch the branch (skipped if warmed in the last 30 s).
		await this.warmCheckoutBranch(branch, token, repoCwd);
		throwIfCancelled(token);

		if (await this.localBranchExists(branch, repoCwd, token)) {
			await this.git.run(['checkout', branch], opts());
		} else if (await this.remoteBranchExists(branch, repoCwd, token)) {
			await this.git.run(['checkout', '-b', branch, `${DEFAULT_REMOTE}/${branch}`], opts());
		} else {
			throw new Error(`[ide-checkout] Remote branch not found on origin: ${branch}`);
		}

		// Finally `git merge --ff-only --quiet origin/<b>` to fast-forward (verbatim).
		await this.git.run(['merge', '--ff-only', '--quiet', `${DEFAULT_REMOTE}/${branch}`], opts());
	}

	/**
	 * `checkoutFetchedCommit`: same SHA as the local branch → FF `-B`;
	 * ancestor → detach at SHA; else create `-b <b> <sha>` (verbatim).
	 */
	private async checkoutFetchedCommit(branch: string, sha: string, cwd: string, token: ICancellation): Promise<void> {
		const opts = (): GitRunOptions => ({ cwd, signal: toAbortSignal(token) });
		const localSha = await this.localBranchSha(branch, cwd, token);
		if (localSha === sha) {
			await this.git.run(['checkout', '-B', branch, sha], opts());
			return;
		}
		if (localSha && await this.isAncestor(sha, localSha, cwd, token)) {
			await this.git.run(['checkout', '--detach', sha], opts());
			return;
		}
		await this.git.run(['checkout', '-b', branch, sha], opts());
	}

	// ------------------------------------------------------------------ //
	// branch-warm-prefetch: warmCheckoutBranch
	// ------------------------------------------------------------------ //

	/**
	 * Pre-fetch `+refs/heads/<b>:refs/remotes/origin/<b>` (verbatim). Skips
	 * the fetch when the branch was warmed in the last 30 s
	 * (`recentlyWarmedBranches` map, verbatim name).
	 */
	async warmCheckoutBranch(branchName: string, token: ICancellation, cwd?: string): Promise<void> {
		const branch = normalizeBranchName(branchName);
		assertValidBranchName(branch);
		const repoCwd = cwd ?? process.cwd();
		const warmedAt = this.recentlyWarmedBranches.get(branch);
		if (warmedAt !== undefined && this.now() - warmedAt < WARM_CACHE_TTL_MS) {
			return;
		}
		throwIfCancelled(token);
		const fetchArgs: string[] = ['fetch', DEFAULT_REMOTE, `+refs/heads/${branch}:refs/remotes/${DEFAULT_REMOTE}/${branch}`];
		if (await this.fetchSupportsNoWriteFetchHead()) {
			fetchArgs.splice(1, 0, '--no-write-fetch-head');
		}
		await this.git.run(fetchArgs, { cwd: repoCwd, signal: toAbortSignal(token) });
		this.recentlyWarmedBranches.set(branch, this.now());
	}

	private async fetchSupportsNoWriteFetchHead(): Promise<boolean> {
		if (this._noWriteFetchHead === undefined) {
			try {
				this._noWriteFetchHead = supportsNoWriteFetchHead(await this.git.getGitVersion());
			} catch {
				this._noWriteFetchHead = false;
			}
		}
		return this._noWriteFetchHead;
	}

	// ------------------------------------------------------------------ //
	// checkout-provider-protocol: ensureCurrentBranchPushed
	// ------------------------------------------------------------------ //

	/**
	 * Push `HEAD:refs/heads/<branch>` (verbatim); optional
	 * `--force-with-lease`. Non-fast-forward rejection throws the friendly
	 * "moving to cloud" message (verbatim from evidence).
	 */
	async ensureCurrentBranchPushed(options: EnsureBranchPushedOptions, token: ICancellation): Promise<void> {
		const cwd = options.cwd ?? process.cwd();
		const remote = options.remoteName ?? DEFAULT_REMOTE;
		let branch = options.branchName ? normalizeBranchName(options.branchName) : undefined;
		if (branch) {
			assertValidBranchName(branch);
		} else {
			branch = await this.currentBranchName(cwd, token);
			if (!branch) {
				// Rejects detached HEAD for push flows (verbatim from evidence).
				throw new Error('[ide-checkout] Cannot push: HEAD is detached.');
			}
		}
		throwIfCancelled(token);
		const args = ['push'];
		if (options.forcePush) {
			args.push('--force-with-lease');
		}
		args.push(remote, `HEAD:refs/heads/${branch}`);
		const result = await this.git.run(args, { cwd, signal: toAbortSignal(token) });
		if (result.exitCode !== 0) {
			if (isNonFastForwardPushError(result.stderr)) {
				throw new Error(`[ide-checkout] ${nonFastForwardErrorMessage(branch, remote)}`);
			}
			throw new Error(`[ide-checkout] Failed to push ${branch} to ${remote}: ${result.stderr.trim() || `exit code ${result.exitCode}`}`);
		}
	}

	// ------------------------------------------------------------------ //
	// snapshot-push-cloud-branch: snapshotAndPushCurrentBranch
	// ------------------------------------------------------------------ //

	/**
	 * The "move to cloud" primitive (verbatim from evidence). Snapshots the
	 * dirty working tree **without touching the user's working tree**:
	 * 1. temp index `GIT_INDEX_FILE=<tmpdir>/cursor-index-<branch>-<pid>-<rand>`;
	 * 2. `read-tree HEAD` → `add -A .` → `write-tree` → `commit-tree -p HEAD -m
	 *    "Cursor: Apply local changes for cloud agent"` (default message);
	 * 3. `update-ref refs/heads/<d>` where `<d> = <branchPrefix>cloud-agent-<timestamp>-<rand>`
	 *    (default prefix `cursor/`);
	 * 4. `push --set-upstream <remote> <d>`;
	 * 5. optional `stashLocalChangesAfterPush` → `stash push --include-untracked -m
	 *    "Cursor: moved local changes to cloud agent"`.
	 *
	 * Resolves with the pushed branch name `<d>`.
	 */
	async snapshotAndPushCurrentBranch(options: SnapshotPushOptions, token: ICancellation): Promise<string> {
		const cwd = options.cwd ?? process.cwd();
		const remote = options.remoteName ?? DEFAULT_REMOTE;
		const prefix = options.branchPrefix ?? DEFAULT_BRANCH_PREFIX;
		const commitMessage = options.commitMessage ?? DEFAULT_SNAPSHOT_MESSAGE;
		const sourceBranch = await this.currentBranchName(cwd, token);
		if (!sourceBranch) {
			throw new Error('[ide-checkout] Cannot snapshot: HEAD is detached.');
		}
		throwIfCancelled(token);

		const rand = this.deps.randomSuffix ? this.deps.randomSuffix() : Math.random().toString(36).slice(2, 10);
		const indexFile = path.join(os.tmpdir(), `cursor-index-${sourceBranch}-${process.pid}-${rand}`);
		const indexEnv = { GIT_INDEX_FILE: indexFile };
		const indexOpts = (): GitRunOptions => ({ cwd, env: indexEnv, signal: toAbortSignal(token) });

		try {
			await this.git.run(['read-tree', 'HEAD'], indexOpts());
			throwIfCancelled(token);
			await this.git.run(['add', '-A', '.'], indexOpts());
			throwIfCancelled(token);
			const writeTree = await this.git.run(['write-tree'], indexOpts());
			if (writeTree.exitCode !== 0) {
				throw new Error(`[ide-checkout] Snapshot failed (write-tree): ${writeTree.stderr.trim()}`);
			}
			const treeSha = writeTree.stdout.trim().split('\n')[0] ?? '';
			throwIfCancelled(token);
			const commitTree = await this.git.run(['commit-tree', treeSha, '-p', 'HEAD', '-m', commitMessage], indexOpts());
			if (commitTree.exitCode !== 0) {
				throw new Error(`[ide-checkout] Snapshot failed (commit-tree): ${commitTree.stderr.trim()}`);
			}
			const commitSha = commitTree.stdout.trim().split('\n')[0] ?? '';
			throwIfCancelled(token);

			const cloudBranch = `${prefix}cloud-agent-${this.now()}-${rand}`;
			await this.git.run(['update-ref', `refs/heads/${cloudBranch}`, commitSha], { cwd, signal: toAbortSignal(token) });
			throwIfCancelled(token);

			const push = await this.git.run(['push', '--set-upstream', remote, cloudBranch], { cwd, signal: toAbortSignal(token) });
			if (push.exitCode !== 0) {
				if (isNonFastForwardPushError(push.stderr)) {
					throw new Error(`[ide-checkout] ${nonFastForwardErrorMessage(cloudBranch, remote)}`);
				}
				throw new Error(`[ide-checkout] Failed to push ${cloudBranch} to ${remote}: ${push.stderr.trim() || `exit code ${push.exitCode}`}`);
			}

			if (options.stashLocalChangesAfterPush) {
				throwIfCancelled(token);
				await this.git.run(
					['stash', 'push', '--include-untracked', '-m', options.stashMessage ?? DEFAULT_STASH_MESSAGE],
					{ cwd, signal: toAbortSignal(token) },
				);
			}

			return cloudBranch;
		} finally {
			try {
				if (this.deps.unlink) {
					await this.deps.unlink(indexFile);
				} else {
					const { promises: fs } = await import('node:fs');
					await fs.unlink(indexFile);
				}
			} catch {
				// Best-effort temp index cleanup; never fails the operation.
			}
		}
	}

	// ------------------------------------------------------------------ //
	// checkout-provider-protocol: hasDirtyWorkingTree
	// ------------------------------------------------------------------ //

	/**
	 * Streaming dirty check (verbatim from evidence): streams
	 * `status --porcelain` and resolves on the first byte of stdout (the
	 * runner SIGTERMs git); `false` when git exits clean. Abort-aware.
	 */
	async hasDirtyWorkingTree(token: ICancellation, cwd?: string): Promise<boolean> {
		const repoCwd = cwd ?? process.cwd();
		return this.git.runStreamingEarlyExit(
			['--no-optional-locks', 'status', '--porcelain'],
			{ cwd: repoCwd, signal: toAbortSignal(token) },
		);
	}

	// ------------------------------------------------------------------ //
	// internal git helpers
	// ------------------------------------------------------------------ //

	private async localBranchExists(branch: string, cwd: string, token: ICancellation): Promise<boolean> {
		const result = await this.git.run(
			['show-ref', '--verify', '--quiet', `refs/heads/${branch}`],
			{ cwd, signal: toAbortSignal(token) },
		);
		return result.exitCode === 0;
	}

	private async localBranchSha(branch: string, cwd: string, token: ICancellation): Promise<string | undefined> {
		const result = await this.git.run(
			['rev-parse', '--verify', `refs/heads/${branch}`],
			{ cwd, signal: toAbortSignal(token) },
		);
		if (result.exitCode !== 0) {
			return undefined;
		}
		return result.stdout.trim().split('\n')[0];
	}

	private async remoteBranchExists(branch: string, cwd: string, token: ICancellation): Promise<boolean> {
		const result = await this.git.run(
			['ls-remote', '--heads', DEFAULT_REMOTE, branch],
			{ cwd, signal: toAbortSignal(token) },
		);
		return result.exitCode === 0 && result.stdout.trim().length > 0;
	}

	private async commitFetchableFromOrigin(sha: string, cwd: string, token: ICancellation): Promise<boolean> {
		const result = await this.git.run(
			['ls-remote', DEFAULT_REMOTE, sha],
			{ cwd, signal: toAbortSignal(token) },
		);
		return result.exitCode === 0 && result.stdout.includes(sha);
	}

	private async isAncestor(sha: string, descendant: string, cwd: string, token: ICancellation): Promise<boolean> {
		const result = await this.git.run(
			['merge-base', '--is-ancestor', sha, descendant],
			{ cwd, signal: toAbortSignal(token) },
		);
		return result.exitCode === 0;
	}

	private async currentBranchName(cwd: string, token: ICancellation): Promise<string | undefined> {
		const result = await this.git.run(
			['rev-parse', '--abbrev-ref', 'HEAD'],
			{ cwd, signal: toAbortSignal(token) },
		);
		if (result.exitCode !== 0) {
			return undefined;
		}
		const name = result.stdout.trim();
		return name === 'HEAD' ? undefined : name;
	}
}

/** Validates user-controlled args before they reach the runner. */
export function hardenedArgs(args: readonly string[]): string[] {
	assertSafeGitArgs(args);
	return withForcedNoExtDiff(args);
}
