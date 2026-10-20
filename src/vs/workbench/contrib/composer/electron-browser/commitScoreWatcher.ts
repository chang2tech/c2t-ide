/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// IDE-CODE: Migrated from extensions/ide-agent/src/services/commitScoreWatcher.ts (CAT-B, vscode→DI)
//
// vscode API → core mapping used here (per docs/rea/ext-api-audit-2026-10-19.md §3):
//   extensions.getExtension("vscode.git")?.exports?.getAPI(1)
//       → ISCMService (vs/workbench/contrib/scm/common/scm) for the repository
//         list + add/remove events. The git extension's `repository.state`
//         (HEAD commit + onDidChange) has NO core equivalent, so the HEAD
//         trigger is reimplemented on primitives that do exist:
//           - repo roots come from ISCMRepository.provider.rootUri
//           - "something changed" comes from ISCMProvider.onDidChangeResources
//             (debounced 1s — commits change SCM resources, like the git
//             extension's state.onDidChange did)
//           - the HEAD SHA itself comes from `git rev-parse HEAD` through the
//             existing GitRunner abstraction (the file already shelled out to
//             git for scoring — no new dependency)
//   vscode.Disposable → IDisposable (vs/base/common/lifecycle)
//   vscode.Uri        → URI (vs/base/common/uri)
//
// Honest scope is unchanged: only commits created AFTER watching starts are
// scored (last-seen HEAD captured at startup); merge/oversized/empty commits
// are skipped by scoreCommit(); scoring never throws into the caller.
//
// NOTE: ISCMService is provider-agnostic — non-git SCM providers also appear
// in `repositories`. A repo whose root has no `.git` simply yields no HEAD
// (`git rev-parse` fails) and is skipped silently, same as before.
//
// PARITY EVIDENCE STATUS (rule: ~/AGENTS.md "KHÔNG BỊA ĐẶT", 2026-10-19):
//   UNKNOWN: the two "Cursor parity" markers below have NO REA/binary/docs
//     evidence — inherited from the original source. The ISCM-based trigger
//     is OUR reimplementation choice (documented above), not a verified
//     Cursor approach.

import * as child_process from 'child_process';
import { DisposableStore, IDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { ISCMRepository, ISCMService } from '../../../../workbench/contrib/scm/common/scm.js';
import {
	AiCodeTrackingService,
	GitRunner,
	scoreCommit,
} from '../common/aiCodeTracking.js';
import { withSafeGitArgs } from '../common/gitSanitize.js';

const spawnGitRunner: GitRunner = {
	run: (args: string[], cwd: string): Promise<{ stdout: string; code: number }> =>
		new Promise((resolve) => {
			child_process.execFile(
				'git',
				// DEV-GAPS-14 `ext-git-sanitize`: URL credentials stripped,
				// safe `-c` configs forced before the subcommand (verbatim
				// per Cursor evidence).
				withSafeGitArgs(args),
				{ cwd, maxBuffer: 32 * 1024 * 1024, timeout: 30_000 },
				(err, stdout) => {
					resolve({ stdout: typeof stdout === 'string' ? stdout : '', code: err ? 1 : 0 });
				},
			);
		}),
};

interface WatchedRepo {
	root: string;
	lastHead: string | undefined;
}

/** Debounce for SCM resource-change bursts (a commit fires several). */
const HEAD_RECHECK_DEBOUNCE_MS = 1000;

async function readHead(git: GitRunner, root: string): Promise<string | undefined> {
	try {
		const { stdout, code } = await git.run(['rev-parse', 'HEAD'], root);
		if (code !== 0) {
			return undefined;
		}
		const head = stdout.trim();
		return head.length > 0 ? head : undefined;
	} catch {
		return undefined;
	}
}

/**
 * Start watching all open repositories. Safe to call when no SCM provider is
 * registered — resolves silently. Everything is disposable through the
 * returned object; scoring never throws into the caller.
 */
export async function watchCommitsForScoring(
	store: AiCodeTrackingService,
	scmService: ISCMService,
	git: GitRunner = spawnGitRunner,
): Promise<IDisposable> {
	const disposables = new DisposableStore();
	const watched = new Map<string, WatchedRepo>();

	const scoreNewHead = (root: string): void => {
		const entry = watched.get(root);
		if (!entry) {
			return;
		}
		void (async () => {
			try {
				const head = await readHead(git, root);
				if (!head || head === entry.lastHead) {
					return;
				}
				entry.lastHead = head;
				// Branch name is best-effort (the original read it from the
				// git extension's state; here a cheap rev-parse keeps the
				// scoreCommit payload equivalent).
				let branchName: string | undefined;
				try {
					const { stdout, code } = await git.run(['rev-parse', '--abbrev-ref', 'HEAD'], root);
					if (code === 0 && stdout.trim()) {
						branchName = stdout.trim();
					}
				} catch {
					/* branch name is informational only */
				}
				const repoName = root.split(/[\\/]/).pop() || undefined;
				const outcome = await scoreCommit(
					{ repoPath: root, commitHash: head, repoName, branchName },
					store,
					git,
				);
				if (outcome.kind === 'scored') {
					store.recordScoredCommit(outcome.commit);
				}
				// Skipped commits (merge/oversized/empty) leave the previous
				// scored-commit item in place. (UNKNOWN: "Cursor parity" — no evidence.)
			} catch {
				// Scoring must never break the caller.
			}
		})();
	};

	const watchRepo = (repo: ISCMRepository): void => {
		const root = repo.provider.rootUri?.fsPath;
		if (!root || watched.has(root)) {
			return;
		}
		const entry: WatchedRepo = { root, lastHead: undefined };
		watched.set(root, entry);
		// Capture the last-seen HEAD at startup so pre-existing history is
		// never scored. (UNKNOWN: "Cursor parity" — no evidence; aiCodeTrackingStartTime
// is OUR tracking service.)
		void readHead(git, root).then((head) => { entry.lastHead = head; });
		// The git extension's repository.state.onDidChange has no core
		// equivalent; ISCMProvider.onDidChangeResources fires whenever the
		// provider's resources change — a commit always does. Debounced, then
		// the HEAD SHA is re-read through git and scored when it moved.
		let timer: ReturnType<typeof setTimeout> | undefined;
		const listener = repo.provider.onDidChangeResources(() => {
			if (timer !== undefined) {
				clearTimeout(timer);
			}
			timer = setTimeout(() => {
				timer = undefined;
				scoreNewHead(root);
			}, HEAD_RECHECK_DEBOUNCE_MS);
		});
		disposables.add(toDisposable(() => {
			if (timer !== undefined) {
				clearTimeout(timer);
			}
			listener.dispose();
			watched.delete(root);
		}));
	};

	try {
		for (const repo of scmService.repositories) {
			watchRepo(repo);
		}
		disposables.add(scmService.onDidAddRepository((repo) => watchRepo(repo)));
		disposables.add(scmService.onDidRemoveRepository((repo) => {
			const root = repo.provider.rootUri?.fsPath;
			if (root) {
				watched.delete(root);
			}
		}));
	} catch {
		// No SCM providers (or the service is unavailable) — stats items
		// still work; nothing is watched.
	}

	return disposables;
}
