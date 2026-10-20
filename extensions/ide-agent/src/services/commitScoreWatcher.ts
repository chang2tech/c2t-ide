/**
 * Commit-score hook — the client side of Cursor's `checkAndScoreCommitIfNeeded`
 * pipeline (DD-SB-6, DIG-STATUSBAR-AI §2).
 *
 * Watches every open git repository for HEAD changes (via the built-in git
 * extension's public API: `repository.state.onDidChange`). When a NEW commit
 * appears on HEAD, it is scored with `scoreCommit()` (merge/oversized/empty
 * commits are skipped, Cursor parity) and the result feeds
 * `AiCodeTrackingService.recordScoredCommit`, which drives the
 * `aiCodeTracking.stats.recentCommit` status-bar item.
 *
 * Only commits created AFTER activation are scored: the last-seen HEAD is
 * captured at startup, so pre-existing history is never scored. (Cursor
 * instead honors `aiCodeTrackingStartTime`; the effect is the same — no
 * backfill of old history.)
 *
 * Honest scope: AI attribution is the local content-match heuristic from
 * `aiCodeTracking.ts` (module header note 3). Cursor scores server-side with
 * exact generation provenance; ours can only match commit lines against
 * content this client generated and the user accepted today.
 */

import * as child_process from 'child_process';
import * as vscode from 'vscode';
import {
  AiCodeTrackingService,
  GitRunner,
  scoreCommit,
} from './aiCodeTracking';
import { withSafeGitArgs } from './gitExec';

const spawnGitRunner: GitRunner = {
  run: (args: string[], cwd: string): Promise<{ stdout: string; code: number }> =>
    new Promise((resolve) => {
      child_process.execFile(
        'git',
        // DEV-GAPS-14 `ext-git-sanitize`: URL credentials stripped, safe `-c`
        // configs forced before the subcommand (verbatim per Cursor evidence).
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
  onDidChange: vscode.Disposable;
}

function repoRootOf(repo: { rootUri?: vscode.Uri }): string | undefined {
  try {
    return repo.rootUri?.fsPath;
  } catch {
    return undefined;
  }
}

/**
 * Start watching all open repositories. Safe to call when the git extension
 * is absent/disabled — resolves silently. Everything is disposable through
 * the returned object; scoring never throws into the extension host.
 */
export async function watchCommitsForScoring(
  store: AiCodeTrackingService,
  git: GitRunner = spawnGitRunner,
): Promise<vscode.Disposable> {
  const disposables: vscode.Disposable[] = [];
  const watched = new Map<string, WatchedRepo>();

  const scoreNewHead = (root: string, repo: { state: { HEAD?: { commit?: string; name?: string } | undefined } }): void => {
    const head = repo.state.HEAD?.commit;
    const entry = watched.get(root);
    if (!entry) return;
    if (!head || head === entry.lastHead) return;
    entry.lastHead = head;
    const branchName = repo.state.HEAD?.name;
    const repoName = root.split(/[\\/]/).pop() || undefined;
    void (async () => {
      try {
        const outcome = await scoreCommit(
          { repoPath: root, commitHash: head, repoName, branchName },
          store,
          git,
        );
        if (outcome.kind === 'scored') {
          store.recordScoredCommit(outcome.commit);
        }
        // Skipped commits (merge/oversized/empty) leave the previous
        // scored-commit item in place — Cursor parity.
      } catch {
        // Scoring must never break the extension host.
      }
    })();
  };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const watchRepo = (repo: any): void => {
    const root = repoRootOf(repo);
    if (!root || watched.has(root)) return;
    let head: string | undefined;
    try {
      head = repo.state?.HEAD?.commit;
    } catch {
      head = undefined;
    }
    const entry: WatchedRepo = { root, lastHead: head, onDidChange: { dispose: () => undefined } };
    watched.set(root, entry);
    try {
      entry.onDidChange = repo.state.onDidChange(() => scoreNewHead(root, repo));
    } catch {
      // Repository without observable state — keep the initial snapshot only.
    }
    disposables.push(entry.onDidChange);
  };

  try {
    const gitExt = vscode.extensions.getExtension('vscode.git');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const api = gitExt?.exports as any;
    const getApi = typeof api?.getAPI === 'function' ? api.getAPI(1) : undefined;
    if (getApi && Array.isArray(getApi.repositories)) {
      for (const repo of getApi.repositories) watchRepo(repo);
      try {
        disposables.push(
          getApi.onDidOpenRepository((repo: unknown) => watchRepo(repo)),
          getApi.onDidCloseRepository((repo: unknown) => {
            const root = repoRootOf(repo as { rootUri?: vscode.Uri });
            if (root) {
              const entry = watched.get(root);
              if (entry) {
                entry.onDidChange.dispose();
                watched.delete(root);
              }
            }
          }),
        );
      } catch {
        /* older git API without open/close events — initial set is enough */
      }
    }
  } catch {
    // No git extension (or its API changed shape) — stats items still work.
  }

  return {
    dispose: () => {
      for (const d of disposables) {
        try {
          d.dispose();
        } catch {
          /* ignore */
        }
      }
      watched.clear();
    },
  };
}
