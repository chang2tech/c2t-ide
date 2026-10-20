/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// IDE-CODE: Migrated — vscode API → DI (2026-10-19).
//
// vscode API → core mapping used here:
//   vscode.workspace.workspaceFolders                 → IWorkspaceContextService.getWorkspace().folders
//   vscode.commands.executeCommand("vscode.openFolder", uri, true)
//       → IHostService.openWindow([{ folderUri }], { forceNewWindow: true })
//
// NOTE: this service shells out to `git` via node:child_process, so it only
// runs on desktop (node) targets — same constraint as the original extension
// code. It lives in electron-browser/ (not common/) because common/ must stay
// node-free for the browser build; the `Worktree` contract it returns lives in
// ../common/worktreeService.ts.

import * as path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { URI } from '../../../../base/common/uri.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { IHostService } from '../../../services/host/browser/host.js';
import type { IOpenWindowOptions } from '../../../../platform/window/common/window.js';
import type { Worktree } from '../common/worktreeService.js';
import { withSafeGitArgs } from '../common/gitSanitize.js';
import { runWorktreeSetup } from './worktreeSetupRunner.js';

const execFileAsync = promisify(execFile);

const GIT_TIMEOUT_MS = 30_000;

/**
 * Run git with an argument array (never a shell string — no injection).
 * DEV-GAPS-14 `ext-git-sanitize`: URL credentials are stripped and the four
 * safe `-c` configs are forced before the subcommand (verbatim per Cursor
 * evidence, DIG-AST-EXT 2026-10-19).
 */
async function git(cwd: string, args: string[]): Promise<string> {
	const { stdout } = await execFileAsync('git', withSafeGitArgs(args), { cwd, timeout: GIT_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024 });
	return stdout;
}

/**
 * WorktreeService — git worktree management backing the /worktree slash
 * command (mirrors Cursor's /worktree, /apply-worktree, /delete-worktree).
 *
 * Worktrees give each agent run an isolated checkout so parallel work never
 * clobbers the main working tree. Layout matches the Cursor convention of a
 * sibling `<repo>-worktrees/` directory.
 */
export class WorktreeService {
	constructor(
		private readonly workspaceContextService: IWorkspaceContextService,
		private readonly hostService: IHostService,
	) { }

	/** Repo root for the first workspace folder, or undefined. */
	async getRepoRoot(): Promise<string | undefined> {
		const folder = this.workspaceContextService.getWorkspace().folders[0];
		if (!folder) {
			return undefined;
		}
		try {
			const top = await git(folder.uri.fsPath, ['rev-parse', '--show-toplevel']);
			return top.trim();
		} catch {
			return undefined;
		}
	}

	/** Parse `git worktree list --porcelain`. */
	async list(repoRoot: string): Promise<Worktree[]> {
		const raw = await git(repoRoot, ['worktree', 'list', '--porcelain']);
		const out: Worktree[] = [];
		let cur: Partial<Worktree> & { path?: string } = {};
		const flush = (): void => {
			if (cur.path) {
				out.push({
					path: cur.path,
					head: cur.head ?? '',
					branch: cur.branch,
					bare: cur.bare ?? false,
					detached: cur.detached ?? false,
					locked: cur.locked ?? false,
					prunable: cur.prunable ?? false,
					isMain: out.length === 0,
				});
			}
			cur = {};
		};
		for (const line of raw.split('\n')) {
			if (line === '') {
				flush();
				continue;
			}
			const [key, ...rest] = line.split(' ');
			const value = rest.join(' ');
			switch (key) {
				case 'worktree': cur.path = value; break;
				case 'HEAD': cur.head = value; break;
				case 'branch': cur.branch = value.replace(/^refs\/heads\//, ''); break;
				case 'bare': cur.bare = true; break;
				case 'detached': cur.detached = true; break;
				case 'locked': cur.locked = true; break;
				case 'prunable': cur.prunable = true; break;
			}
		}
		flush();
		return out;
	}

	/** Default new-worktree location: sibling `<repo>-worktrees/<slug>`. */
	defaultWorktreePath(repoRoot: string, branch: string): string {
		const repoName = path.basename(repoRoot);
		const slug = branch.replace(/\//g, '-').replace(/[^a-zA-Z0-9._-]/g, '_');
		return path.join(path.dirname(repoRoot), `${repoName}-worktrees`, slug);
	}

	/**
	 * Validate a user-supplied branch name for `git worktree add -b`.
	 * Returns an error message, or undefined when valid.
	 */
	validateBranchName(name: string): string | undefined {
		const trimmed = name.trim();
		if (!trimmed) {
			return 'Branch name cannot be empty.';
		}
		if (trimmed.length > 100) {
			return 'Branch name is too long (max 100 chars).';
		}
		// git check-ref-format rules, conservative subset.
		if (!/^[a-zA-Z0-9._/-]+$/.test(trimmed)) {
			return 'Use only letters, numbers, \'.\', \'_\', \'/\' and \'-\'.';
		}
		if (trimmed.includes('..') || trimmed.startsWith('/') || trimmed.endsWith('/') || trimmed.endsWith('.lock')) {
			return 'Invalid branch name.';
		}
		return undefined;
	}

	/**
	 * Create a worktree at `dir`. If `branch` already exists it is checked out;
	 * otherwise it is created from `baseRef` (default: current HEAD).
	 */
	async create(repoRoot: string, dir: string, branch: string, baseRef?: string): Promise<Worktree> {
		if (!path.isAbsolute(dir)) {
			throw new Error('Worktree path must be absolute.');
		}
		let branchExists = false;
		try {
			await git(repoRoot, ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`]);
			branchExists = true;
		} catch {
			branchExists = false;
		}
		if (branchExists) {
			await git(repoRoot, ['worktree', 'add', dir, branch]);
		} else if (baseRef) {
			await git(repoRoot, ['worktree', 'add', '-b', branch, dir, baseRef]);
		} else {
			await git(repoRoot, ['worktree', 'add', '-b', branch, dir]);
		}
		const all = await this.list(repoRoot);
		const created = all.find((w) => w.path === path.resolve(dir));
		if (!created) {
			throw new Error('Worktree created but not found in `git worktree list`.');
		}
		// IDE-CODE (GAPS-132 `worktrees-json-config`): Cursor runs the
		// `.cursor/worktrees.json` setup right after creating an agent
		// worktree, before the agent starts (glass `eiy` @46710083, called
		// at @46755597). The runner never throws and a failed script does
		// NOT block creation — Cursor logs "Worktree setup script failed
		// (continuing with agent creation)" and proceeds; mirrored here.
		const setup = await runWorktreeSetup(created.path, repoRoot).catch(() => undefined);
		if (setup?.scriptFailed) {
			console.warn(`[worktree-setup] Worktree setup script failed (continuing with agent creation): ${setup.scriptError ?? 'unknown error'}`);
		}
		return created;
	}

	/**
	 * Remove a worktree. Refuses when dirty unless `force` is set; can also
	 * delete the branch when `deleteBranch` is true.
	 */
	async remove(repoRoot: string, worktreePath: string, opts?: { force?: boolean; deleteBranch?: boolean }): Promise<void> {
		const args = ['worktree', 'remove'];
		if (opts?.force) {
			args.push('--force');
		}
		args.push(worktreePath);
		await git(repoRoot, args);
		const branch = (await this.resolveBranch(repoRoot, worktreePath)) ?? undefined;
		if (opts?.deleteBranch && branch) {
			await git(repoRoot, ['branch', '-D', branch]);
		}
	}

	private async resolveBranch(repoRoot: string, worktreePath: string): Promise<string | undefined> {
		// Look up the branch from the worktree list before removal.
		const all = await this.list(repoRoot);
		return all.find((w) => w.path === worktreePath)?.branch;
	}

	/** Clean up stale administrative metadata for deleted worktree dirs. */
	async prune(repoRoot: string): Promise<void> {
		await git(repoRoot, ['worktree', 'prune']);
	}

	/** Open the worktree folder in a new IDE window. */
	openInNewWindow(worktreePath: string): void {
		const options: IOpenWindowOptions = { forceNewWindow: true };
		void this.hostService.openWindow([{ folderUri: URI.file(worktreePath) }], options);
	}
}
