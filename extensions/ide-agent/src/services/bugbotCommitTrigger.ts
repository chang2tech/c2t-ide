/**
 * Bugbot auto-review on commit — the commit trigger.
 *
 * Binary evidence (Cursor 3.25.9):
 * - `extensions/cursor-commits/dist/main.js`, `shouldRunBugbot` predicate +
 *   per-repository watcher (verbatim logic, thresholds and log strings
 *   reproduced below; `t.commands.executeCommand("cursor.runEditorBugbot",
 *   n.rootUri, n.state.HEAD?.commit)` dispatch).
 * - `out/vs/workbench/workbench.glass.main.js` byte 41777801:
 *   `us.registerCommand("cursor.runEditorBugbot", async(t,e,n)=>{...
 *   p=Lh(u,"autoRunBugbotOnCommit")??!1;
 *   if(d.checkFeatureGate("bugbot_autorun_killswitch",{disableExposureLog:!1})||!p)return;
 *   ... h.trackEvent("bug_bot.run_ide_bug_finder",{entrypoint:"auto-run-on-commit"}),
 *   await E3n(g,{where:{location:"repo",rootUri:e,source:{kind:"branch",headRef:n}},inBackgroundSubsidized:!0})`.
 *
 * PLACEMENT (matches Cursor): this lives in the extension host, like
 * Cursor's `cursor-commits` extension (activation `onStartupFinished`,
 * `extensionDependencies: ["vscode.git"]`). It is NOT workbench core — the
 * binary trigger is an extension (`cursor-commits`), and the command it
 * dispatches is registered by the ide-agent extension in this fork (the
 * fork's counterpart of Cursor's workbench-core `us.registerCommand`).
 *
 * Verbatim mechanism:
 * - Every repository's `state.onDidChange` is observed; changes are
 *   DEBOUNCED 5s (`5e3`). If `state.rebaseCommit` is set, `lastRebaseAt` is
 *   recorded and a run within 10s after it is skipped.
 * - `shouldRunBugbot` requires ALL of: HEAD exists; branch name unchanged
 *   (no checkout); commit SHA changed; not within 10s of a rebase; the new
 *   commit is not a merge commit; the commit was authored "by me" within the
 *   last 30s (`git var GIT_COMMITTER_IDENT` + `git check-mailmap` equal to
 *   `${authorName} <${authorEmail}>`); the commit has NOT been pushed yet
 *   (`git merge-base --is-ancestor HEAD @{u}` exits non-zero).
 * - On success: `commands.executeCommand("cursor.runEditorBugbot",
 *   repo.rootUri, repo.state.HEAD?.commit)` — the gate (storage key +
 *   killswitch) is re-checked inside the command handler, exactly as in the
 *   binary.
 * - After every debounce (run or not): best-effort
 *   `scm.gitCommitWasRun(rootFsPath)` in try/catch (binary: `t.scm`,
 *   error string "Failed to notify git commit" verbatim).
 *
 * The `developer.aiCodeTracking.scoreCommitInternal` call that shares the
 * binary debounce callback is a SEPARATE feature (commit scoring) and is not
 * dispatched here — the fork's `commitScoreWatcher.ts` covers it.
 *
 * HONEST-DIVERGENCE (git execution): the binary uses the Cursor-internal
 * `gitApi.rawGit.exec`. The public vscode.git API has no rawGit, so this
 * module shells out to `git` via `child_process.execFile` with the fork's
 * `withSafeGitArgs` sanitization (same pattern as `commitScoreWatcher.ts`).
 */

import * as child_process from "child_process";
import * as vscode from "vscode";
import { withSafeGitArgs } from "./gitExec";
import { BUGBOT_RUN_EDITOR_REVIEW_COMMAND_ID } from "./bugbotReviewService";

/** Binary-verbatim debounce: `s=setTimeout(...,5e3)`. */
export const BUGBOT_COMMIT_DEBOUNCE_MS = 5_000;
/** Binary-verbatim rebase quiet window: `Math.abs(Date.now()-s)<1e4`. */
export const BUGBOT_REBASE_QUIET_MS = 10_000;
/** Binary-verbatim "authored by me recently" window: `<3e4`. */
export const BUGBOT_RECENT_COMMIT_MS = 30_000;

/** Minimal git runner surface (injectable for tests). */
export interface BugbotGitRunner {
  exec(
    cwd: string,
    args: string[],
  ): Promise<{ stdout: string; exitCode: number }>;
}

/** Minimal logger surface (injectable for tests). */
export interface BugbotCommitLog {
  debug(message: string): void;
  trace(message: string): void;
  info(message: string): void;
  error(message: string, err?: unknown): void;
}

/** Snapshot of `repository.state.HEAD` used for change detection. */
export interface BugbotHeadSnapshot {
  name?: string;
  commit?: string;
}

/**
 * Structural subset of the vscode.git `Repository` API used here.
 * `getCommit` and `rebaseCommit` exist on the real API
 * (`extensions/git/src/api/git.d.ts`).
 */
export interface BugbotRepoLike {
  rootUri: { fsPath: string };
  state: {
    HEAD?: { name?: string; commit?: string } | undefined;
    rebaseCommit?: unknown;
    onDidChange: (listener: () => void) => vscode.Disposable;
  };
  getCommit(
    ref: string,
  ): Promise<{
    parents: string[];
    authorName?: string;
    authorEmail?: string;
    commitDate?: Date;
  }>;
}

export interface ShouldRunBugbotOptions {
  git: BugbotGitRunner;
  repo: BugbotRepoLike;
  /** Previous HEAD snapshot (the binary guards the call with `void 0!==m`). */
  lastHead: BugbotHeadSnapshot;
  /** Epoch ms of the last observed rebase, if any. */
  lastRebaseAtMs?: number;
  nowMs: number;
  log: BugbotCommitLog;
}

/**
 * Verbatim port of Cursor's `shouldRunBugbot(e, n, a, s)` from
 * `extensions/cursor-commits/dist/main.js` (3.25.9). All log strings and
 * thresholds are byte-verbatim, including the `shouldRunBugBot` (capital B)
 * typo in the "not authored by me recently" debug line.
 */
export async function shouldRunBugbot(
  opts: ShouldRunBugbotOptions,
): Promise<boolean> {
  const { git, repo, lastHead, lastRebaseAtMs, nowMs, log } = opts;
  const root = repo.rootUri.fsPath;
  const head = repo.state.HEAD;
  // Binary: evaluated unconditionally, before the undefined check.
  log.debug(
    `shouldRunBugbot: head = ${head?.name}, lastHead = ${lastHead?.name}, lastRebaseAt = ${lastRebaseAtMs}`,
  );
  if (head === undefined) {
    log.debug("shouldRunBugbot: no head state");
    return false;
  }
  if (head.name !== lastHead.name) {
    log.debug("shouldRunBugbot: checkout changed");
    return false;
  }
  if (head.commit === undefined || head.commit === lastHead.commit) {
    log.debug("shouldRunBugbot: commit is the same");
    return false;
  }
  if (
    lastRebaseAtMs !== undefined &&
    Math.abs(nowMs - lastRebaseAtMs) < BUGBOT_REBASE_QUIET_MS
  ) {
    log.debug("shouldRunBugbot: just finished rebasing");
    return false;
  }
  let commit: {
    parents: string[];
    authorName?: string;
    authorEmail?: string;
    commitDate?: Date;
  };
  try {
    // `head.commit` is defined here (checked above).
    commit = await repo.getCommit(head.commit as string);
  } catch {
    log.debug("shouldRunBugbot: failed to get commit");
    return false;
  }
  if (commit.parents.length > 1) {
    log.debug("shouldRunBugbot: merge commit");
    return false;
  }
  let isMineRecent = false;
  try {
    const committerIdent = (
      await git.exec(root, ["var", "GIT_COMMITTER_IDENT"])
    ).stdout.trim();
    const mailmap = (
      await git.exec(root, ["check-mailmap", committerIdent])
    ).stdout.trim();
    const expected = `${commit.authorName} <${commit.authorEmail}>`;
    log.trace(`shouldRunBugbot: committer_ident = '${committerIdent}'`);
    log.trace(`shouldRunBugbot: mailmap = '${mailmap}'`);
    log.trace(`shouldRunBugbot: expected_committer_email = '${expected}'`);
    if (
      mailmap === expected &&
      commit.commitDate !== undefined &&
      Math.abs(nowMs - commit.commitDate.getTime()) < BUGBOT_RECENT_COMMIT_MS
    ) {
      isMineRecent = true;
    }
  } catch {
    // Binary: empty catch — any git failure means "not mine".
  }
  if (!isMineRecent) {
    log.debug("shouldRunBugBot: not authored by me recently");
    return false;
  }
  try {
    const res = await git.exec(root, [
      "merge-base",
      "--is-ancestor",
      "HEAD",
      "@{u}",
    ]);
    if (res.exitCode === 0) {
      log.debug("shouldRun: commit has been pushed");
      return false;
    }
  } catch {
    // Binary: empty catch — treat as not pushed.
  }
  log.info("shouldRun: OK! Running local Agent Review on commit...");
  return true;
}

/** Production git runner: `git` via execFile with safe args. */
export function createBugbotGitRunner(): BugbotGitRunner {
  return {
    exec: (cwd: string, args: string[]) =>
      new Promise((resolve) => {
        child_process.execFile(
          "git",
          withSafeGitArgs(args),
          { cwd, maxBuffer: 4 * 1024 * 1024, timeout: 15_000 },
          (err, stdout) => {
            resolve({
              stdout: typeof stdout === "string" ? stdout : "",
              exitCode: err ? 1 : 0,
            });
          },
        );
      }),
  };
}

export interface BugbotGitApiLike {
  repositories?: BugbotRepoLike[];
  onDidOpenRepository?: (
    listener: (repo: BugbotRepoLike) => void,
  ) => vscode.Disposable;
  onDidCloseRepository?: (
    listener: (repo: BugbotRepoLike) => void,
  ) => vscode.Disposable;
}

export interface BugbotCommitWatcherDeps {
  getGitApi: () => BugbotGitApiLike | undefined;
  git: BugbotGitRunner;
  executeCommand: (command: string, ...args: unknown[]) => unknown;
  /**
   * Best-effort `scm.gitCommitWasRun(rootFsPath)` notification (binary:
   * `t.scm.gitCommitWasRun(...)` in try/catch). Production implementation
   * guards the Cursor-internal API's absence on the public vscode API.
   */
  notifyGitCommitWasRun: (rootFsPath: string) => void;
  now: () => number;
  log: BugbotCommitLog;
  setTimeoutFn?: (fn: () => void, ms: number) => unknown;
  clearTimeoutFn?: (handle: unknown) => void;
}

interface WatchedRepoEntry {
  root: string;
  repo: BugbotRepoLike;
  lastHead: BugbotHeadSnapshot | undefined;
  lastRebaseAtMs: number | undefined;
  timer: unknown;
  onDidChange: vscode.Disposable;
  dispose: () => void;
}

function snapshotHead(repo: BugbotRepoLike): BugbotHeadSnapshot | undefined {
  try {
    const head = repo.state.HEAD;
    if (!head) {
      return undefined;
    }
    return { name: head.name, commit: head.commit };
  } catch {
    return undefined;
  }
}

/**
 * Watch all open git repositories; after a 5s debounce, run
 * `shouldRunBugbot` and dispatch `cursor.runEditorBugbot` on success.
 * Mirrors the binary's `cB(e, n)` watcher setup (per-repo subscribe,
 * `onDidOpenRepository`/`onDidCloseRepository` handling). Never throws into
 * the extension host.
 */
export function watchBugbotCommits(
  deps: BugbotCommitWatcherDeps,
): vscode.Disposable {
  const disposables: vscode.Disposable[] = [];
  const watched = new Map<string, WatchedRepoEntry>();
  const setTimeoutFn =
    deps.setTimeoutFn ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
  const clearTimeoutFn =
    deps.clearTimeoutFn ?? ((handle: unknown) => clearTimeout(handle as never));

  const checkRepo = (entry: WatchedRepoEntry): void => {
    entry.timer = undefined;
    void (async () => {
      try {
        let should = false;
        // Binary: `void 0!==m&&(a=await shouldRunBugbot(e,n,m,o))`.
        if (entry.lastHead !== undefined) {
          should = await shouldRunBugbot({
            git: deps.git,
            repo: entry.repo,
            lastHead: entry.lastHead,
            lastRebaseAtMs: entry.lastRebaseAtMs,
            nowMs: deps.now(),
            log: deps.log,
          });
        }
        if (should) {
          // Binary-verbatim dispatch (rootUri, HEAD commit).
          let headCommit: string | undefined;
          try {
            headCommit = entry.repo.state.HEAD?.commit;
          } catch {
            headCommit = undefined;
          }
          await deps.executeCommand(
            BUGBOT_RUN_EDITOR_REVIEW_COMMAND_ID,
            entry.repo.rootUri,
            headCommit,
          );
        }
      } catch (err) {
        // The trigger must never break the extension host or the commit flow.
        deps.log.error("[bugbot] commit trigger check failed", err);
      }
      try {
        deps.notifyGitCommitWasRun(entry.root);
      } catch (err) {
        // Binary-verbatim error string.
        deps.log.error("Failed to notify git commit", err);
      }
      // Binary: `m=n.state.HEAD` — refresh the baseline every debounce.
      entry.lastHead = snapshotHead(entry.repo);
    })();
  };

  const watchRepo = (repo: BugbotRepoLike): void => {
    let root: string | undefined;
    try {
      root = repo.rootUri?.fsPath;
    } catch {
      root = undefined;
    }
    if (!root || watched.has(root)) {
      return;
    }
    const entry: WatchedRepoEntry = {
      root,
      repo,
      lastHead: snapshotHead(repo),
      lastRebaseAtMs: undefined,
      timer: undefined,
      onDidChange: { dispose: () => undefined },
      dispose: () => {
        if (entry.timer !== undefined) {
          try {
            clearTimeoutFn(entry.timer);
          } catch {
            /* ignore */
          }
          entry.timer = undefined;
        }
        try {
          entry.onDidChange.dispose();
        } catch {
          /* ignore */
        }
      },
    };
    try {
      entry.onDidChange = repo.state.onDidChange(() => {
        // Restart the debounce on every state change.
        if (entry.timer !== undefined) {
          try {
            clearTimeoutFn(entry.timer);
          } catch {
            /* ignore */
          }
          entry.timer = undefined;
        }
        try {
          // Binary: `void 0!==n.state.rebaseCommit&&(o=Date.now())`.
          if (repo.state.rebaseCommit !== undefined) {
            entry.lastRebaseAtMs = deps.now();
          }
        } catch {
          /* ignore */
        }
        entry.timer = setTimeoutFn(
          () => checkRepo(entry),
          BUGBOT_COMMIT_DEBOUNCE_MS,
        );
      });
    } catch {
      // Repository without observable state — keep the initial snapshot only.
    }
    watched.set(root, entry);
    disposables.push({ dispose: () => entry.dispose() });
  };

  const unwatchRepo = (repo: BugbotRepoLike): void => {
    let root: string | undefined;
    try {
      root = repo.rootUri?.fsPath;
    } catch {
      root = undefined;
    }
    if (!root) {
      return;
    }
    const entry = watched.get(root);
    if (entry) {
      entry.dispose();
      watched.delete(root);
    }
  };

  try {
    const api = deps.getGitApi();
    if (api && Array.isArray(api.repositories)) {
      for (const repo of api.repositories) {
        watchRepo(repo);
      }
      if (typeof api.onDidOpenRepository === "function") {
        disposables.push(api.onDidOpenRepository((repo) => watchRepo(repo)));
      }
      if (typeof api.onDidCloseRepository === "function") {
        disposables.push(api.onDidCloseRepository((repo) => unwatchRepo(repo)));
      }
    }
  } catch {
    // No git extension (or its API changed shape) — no-op.
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
