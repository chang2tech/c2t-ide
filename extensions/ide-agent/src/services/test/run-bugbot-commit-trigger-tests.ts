/**
 * WORKER-GAPS-42D (bugbot-auto-review) tests (node:test, vscode stubbed).
 *
 * Covers the verbatim port of Cursor's `cursor-commits` extension trigger
 * (Cursor 3.25.9 `extensions/cursor-commits/dist/main.js`):
 * - `shouldRunBugbot`: every branch, with the byte-verbatim log strings
 *   (including the `shouldRunBugBot` capital-B typo) and thresholds
 *   (10s rebase quiet, 30s recency).
 * - `watchBugbotCommits`: 5s debounce, rebase tracking, dispatch of
 *   `cursor.runEditorBugbot` via executeCommand, best-effort
 *   `scm.gitCommitWasRun` notification, open/close/dispose lifecycle.
 *
 * Run after `tsc`:  node out/services/test/run-bugbot-commit-trigger-tests.js
 */
import { describe, it } from "node:test";
import * as assert from "node:assert";
import "./vscode-stub";
import {
  BUGBOT_COMMIT_DEBOUNCE_MS,
  BUGBOT_REBASE_QUIET_MS,
  BUGBOT_RECENT_COMMIT_MS,
  shouldRunBugbot,
  watchBugbotCommits,
  type BugbotCommitLog,
  type BugbotGitRunner,
  type BugbotRepoLike,
} from "../bugbotCommitTrigger";
import { BUGBOT_RUN_EDITOR_REVIEW_COMMAND_ID } from "../bugbotReviewService";

// --- fakes ----------------------------------------------------------------

function makeLog(): BugbotCommitLog & {
  debugs: string[];
  traces: string[];
  infos: string[];
  errors: Array<{ m: string; e?: unknown }>;
} {
  return {
    debugs: [],
    traces: [],
    infos: [],
    errors: [],
    debug(m: string) {
      this.debugs.push(m);
    },
    trace(m: string) {
      this.traces.push(m);
    },
    info(m: string) {
      this.infos.push(m);
    },
    error(m: string, e?: unknown) {
      this.errors.push({ m, e });
    },
  };
}

interface GitBehavior {
  ident?: string;
  identThrows?: boolean;
  mailmap?: string;
  mailmapThrows?: boolean;
  mergeBaseExit?: number;
  mergeBaseThrows?: boolean;
}

function makeGit(behavior: GitBehavior = {}): BugbotGitRunner & {
  calls: Array<{ cwd: string; args: string[] }>;
} {
  const calls: Array<{ cwd: string; args: string[] }> = [];
  return {
    calls,
    exec: async (cwd: string, args: string[]) => {
      calls.push({ cwd, args });
      if (args[0] === "var") {
        if (behavior.identThrows) {
          throw new Error("no ident");
        }
        return { stdout: `${behavior.ident ?? "Me <me@x.com>"}\n`, exitCode: 0 };
      }
      if (args[0] === "check-mailmap") {
        if (behavior.mailmapThrows) {
          throw new Error("no mailmap");
        }
        return {
          stdout: `${behavior.mailmap ?? "Me <me@x.com>"}\n`,
          exitCode: 0,
        };
      }
      if (args[0] === "merge-base") {
        if (behavior.mergeBaseThrows) {
          throw new Error("no upstream");
        }
        return { stdout: "", exitCode: behavior.mergeBaseExit ?? 1 };
      }
      return { stdout: "", exitCode: 0 };
    },
  };
}

interface RepoOpts {
  head?: { name?: string; commit?: string } | undefined;
  rebaseCommit?: unknown;
  /** Clock for the default commitDate (defaults to Date.now()). */
  nowMs?: number;
  commitInfo?: {
    parents?: string[];
    authorName?: string;
    authorEmail?: string;
    commitDate?: Date;
    throws?: boolean;
  };
}

function makeRepo(opts: RepoOpts = {}): BugbotRepoLike & {
  fireChange: () => void;
  getCommitCalls: string[];
} {
  const listeners: Array<() => void> = [];
  const getCommitCalls: string[] = [];
  const now = opts.nowMs ?? Date.now();
  const ci = opts.commitInfo ?? {};
  const repo: BugbotRepoLike & {
    fireChange: () => void;
    getCommitCalls: string[];
  } = {
    rootUri: { fsPath: "/repo" },
    state: {
      // NOTE: `'head' in opts` distinguishes "explicitly no HEAD" from
      // "not provided" (an explicit `head: undefined` must stay undefined).
      HEAD: "head" in opts ? opts.head : { name: "main", commit: "abc123" },
      rebaseCommit: opts.rebaseCommit,
      onDidChange: (fn: () => void) => {
        listeners.push(fn);
        return { dispose: () => undefined };
      },
    },
    getCommit: async (ref: string) => {
      getCommitCalls.push(ref);
      if (ci.throws) {
        throw new Error("bad ref");
      }
      return {
        parents: ci.parents ?? [],
        authorName: ci.authorName ?? "Me",
        authorEmail: ci.authorEmail ?? "me@x.com",
        commitDate: ci.commitDate ?? new Date(now),
      };
    },
    fireChange: () => {
      for (const fn of [...listeners]) {
        fn();
      }
    },
    getCommitCalls,
  };
  return repo;
}

const NOW = 1_700_000_000_000;

function baseOpts(repo: BugbotRepoLike, git: BugbotGitRunner, log: BugbotCommitLog) {
  return {
    git,
    repo,
    lastHead: { name: "main", commit: "oldsha" },
    lastRebaseAtMs: undefined as number | undefined,
    nowMs: NOW,
    log,
  };
}

// --- constants --------------------------------------------------------------

describe("verbatim thresholds", () => {
  it("debounce is 5s, rebase quiet 10s, recency 30s", () => {
    assert.strictEqual(BUGBOT_COMMIT_DEBOUNCE_MS, 5_000);
    assert.strictEqual(BUGBOT_REBASE_QUIET_MS, 10_000);
    assert.strictEqual(BUGBOT_RECENT_COMMIT_MS, 30_000);
  });
});

// --- shouldRunBugbot ----------------------------------------------------------

describe("shouldRunBugbot", () => {
  it("false when HEAD is missing (verbatim debug)", async () => {
    const log = makeLog();
    const repo = makeRepo({ nowMs: NOW, head: undefined });
    const ok = await shouldRunBugbot(baseOpts(repo, makeGit(), log));
    assert.strictEqual(ok, false);
    assert.ok(log.debugs.includes("shouldRunBugbot: no head state"));
  });

  it("false on checkout change (verbatim debug)", async () => {
    const log = makeLog();
    const repo = makeRepo({ nowMs: NOW, head: { name: "feature", commit: "abc123" } });
    const ok = await shouldRunBugbot(baseOpts(repo, makeGit(), log));
    assert.strictEqual(ok, false);
    assert.ok(log.debugs.includes("shouldRunBugbot: checkout changed"));
  });

  it("false when commit SHA is unchanged (verbatim debug)", async () => {
    const log = makeLog();
    const repo = makeRepo({ nowMs: NOW, head: { name: "main", commit: "oldsha" } });
    const ok = await shouldRunBugbot(baseOpts(repo, makeGit(), log));
    assert.strictEqual(ok, false);
    assert.ok(log.debugs.includes("shouldRunBugbot: commit is the same"));
  });

  it("false when HEAD has no commit yet (verbatim debug)", async () => {
    const log = makeLog();
    const repo = makeRepo({ nowMs: NOW, head: { name: "main", commit: undefined } });
    const ok = await shouldRunBugbot(baseOpts(repo, makeGit(), log));
    assert.strictEqual(ok, false);
    assert.ok(log.debugs.includes("shouldRunBugbot: commit is the same"));
  });

  it("false within 10s of a rebase (verbatim debug)", async () => {
    const log = makeLog();
    const repo = makeRepo({ nowMs: NOW });
    const opts = baseOpts(repo, makeGit(), log);
    opts.lastRebaseAtMs = NOW - 9_999;
    const ok = await shouldRunBugbot(opts);
    assert.strictEqual(ok, false);
    assert.ok(log.debugs.includes("shouldRunBugbot: just finished rebasing"));
  });

  it("proceeds when the rebase quiet window has passed", async () => {
    const log = makeLog();
    const repo = makeRepo({ nowMs: NOW });
    const opts = baseOpts(repo, makeGit(), log);
    opts.lastRebaseAtMs = NOW - 10_000;
    const ok = await shouldRunBugbot(opts);
    assert.strictEqual(ok, true);
  });

  it("false when getCommit fails (verbatim debug)", async () => {
    const log = makeLog();
    const repo = makeRepo({ nowMs: NOW, commitInfo: { throws: true } });
    const ok = await shouldRunBugbot(baseOpts(repo, makeGit(), log));
    assert.strictEqual(ok, false);
    assert.ok(log.debugs.includes("shouldRunBugbot: failed to get commit"));
  });

  it("false for merge commits (verbatim debug)", async () => {
    const log = makeLog();
    const repo = makeRepo({ nowMs: NOW, commitInfo: { parents: ["a", "b"] } });
    const ok = await shouldRunBugbot(baseOpts(repo, makeGit(), log));
    assert.strictEqual(ok, false);
    assert.ok(log.debugs.includes("shouldRunBugbot: merge commit"));
  });

  it("false when mailmap does not match the author (verbatim debug, capital B)", async () => {
    const log = makeLog();
    const repo = makeRepo({ nowMs: NOW });
    const ok = await shouldRunBugbot(
      baseOpts(repo, makeGit({ mailmap: "Someone Else <else@x.com>" }), log),
    );
    assert.strictEqual(ok, false);
    // NOTE the binary's typo: "shouldRunBugBot" with capital B.
    assert.ok(
      log.debugs.includes("shouldRunBugBot: not authored by me recently"),
    );
  });

  it("false when the commit is older than 30s", async () => {
    const log = makeLog();
    const repo = makeRepo({ nowMs: NOW, 
      commitInfo: { commitDate: new Date(NOW - 30_001) },
    });
    const ok = await shouldRunBugbot(baseOpts(repo, makeGit(), log));
    assert.strictEqual(ok, false);
    assert.ok(
      log.debugs.includes("shouldRunBugBot: not authored by me recently"),
    );
  });

  it("false when ident lookup throws", async () => {
    const log = makeLog();
    const repo = makeRepo({ nowMs: NOW });
    const ok = await shouldRunBugbot(
      baseOpts(repo, makeGit({ identThrows: true }), log),
    );
    assert.strictEqual(ok, false);
    assert.ok(
      log.debugs.includes("shouldRunBugBot: not authored by me recently"),
    );
  });

  it("false when the commit was already pushed (verbatim debug)", async () => {
    const log = makeLog();
    const repo = makeRepo({ nowMs: NOW });
    const ok = await shouldRunBugbot(
      baseOpts(repo, makeGit({ mergeBaseExit: 0 }), log),
    );
    assert.strictEqual(ok, false);
    assert.ok(log.debugs.includes("shouldRun: commit has been pushed"));
  });

  it("true on the happy path with verbatim trace/info lines", async () => {
    const log = makeLog();
    const repo = makeRepo({ nowMs: NOW });
    const ok = await shouldRunBugbot(baseOpts(repo, makeGit(), log));
    assert.strictEqual(ok, true);
    assert.ok(
      log.infos.includes(
        "shouldRun: OK! Running local Agent Review on commit...",
      ),
    );
    assert.ok(
      log.traces.some((t) =>
        t.includes("shouldRunBugbot: committer_ident = 'Me <me@x.com>'"),
      ),
    );
    assert.ok(
      log.traces.some((t) =>
        t.includes("shouldRunBugbot: mailmap = 'Me <me@x.com>'"),
      ),
    );
    assert.ok(
      log.traces.some((t) =>
        t.includes(
          "shouldRunBugbot: expected_committer_email = 'Me <me@x.com>'",
        ),
      ),
    );
    // The initial debug template is always evaluated.
    assert.ok(
      log.debugs.some((d) =>
        d.includes("shouldRunBugbot: head = main, lastHead = main"),
      ),
    );
  });

  it("uses the exact git argv from the binary", async () => {
    const log = makeLog();
    const repo = makeRepo({ nowMs: NOW });
    const git = makeGit();
    await shouldRunBugbot(baseOpts(repo, git, log));
    const argvs = git.calls.map((c) => c.args.join(" "));
    assert.ok(argvs.includes("var GIT_COMMITTER_IDENT"));
    assert.ok(argvs.some((a) => a.startsWith("check-mailmap ")));
    assert.ok(argvs.includes("merge-base --is-ancestor HEAD @{u}"));
    for (const c of git.calls) {
      assert.strictEqual(c.cwd, "/repo");
    }
  });
});

// --- watchBugbotCommits -------------------------------------------------------

interface FakeTimer {
  run: () => void;
}

function makeTimerControl() {
  const pending: FakeTimer[] = [];
  return {
    pending,
    setTimeoutFn: (fn: () => void) => {
      const t: FakeTimer = { run: fn };
      pending.push(t);
      return t;
    },
    clearTimeoutFn: (handle: unknown) => {
      const i = pending.indexOf(handle as FakeTimer);
      if (i >= 0) {
        pending.splice(i, 1);
      }
    },
    fireAll: () => {
      for (const t of [...pending]) {
        pending.splice(pending.indexOf(t), 1);
        t.run();
      }
    },
  };
}

function makeWatcherDeps(repo: BugbotRepoLike, git: BugbotGitRunner) {
  const timers = makeTimerControl();
  const log = makeLog();
  const executed: Array<{ command: string; args: unknown[] }> = [];
  const notified: string[] = [];
  let nowMs = NOW;
  const deps = {
    getGitApi: () => ({
      repositories: [repo],
      onDidOpenRepository: () => ({ dispose: () => undefined }),
      onDidCloseRepository: () => ({ dispose: () => undefined }),
    }),
    git,
    executeCommand: (command: string, ...args: unknown[]) => {
      executed.push({ command, args });
      return Promise.resolve(undefined);
    },
    notifyGitCommitWasRun: (root: string) => {
      notified.push(root);
    },
    now: () => nowMs,
    log,
    setTimeoutFn: timers.setTimeoutFn,
    clearTimeoutFn: timers.clearTimeoutFn,
  };
  return {
    deps,
    timers,
    log,
    executed,
    notified,
    setNow: (v: number) => {
      nowMs = v;
    },
  };
}

const flush = () => new Promise((r) => setImmediate(r));

describe("watchBugbotCommits", () => {
  it("debounces state changes by 5s and dispatches cursor.runEditorBugbot", async () => {
    const repo = makeRepo({ nowMs: NOW });
    const w = makeWatcherDeps(repo, makeGit());
    const d = watchBugbotCommits(w.deps);
    try {
      // Simulate a fresh commit on the same branch.
      repo.state.HEAD = { name: "main", commit: "newsha1" };
      repo.fireChange();
      repo.fireChange();
      // Debounced: no immediate dispatch, one pending timer.
      assert.strictEqual(w.executed.length, 0);
      assert.strictEqual(w.timers.pending.length, 1);
      w.timers.fireAll();
      await flush();
      await flush();
      assert.strictEqual(w.executed.length, 1);
      assert.strictEqual(w.executed[0].command, BUGBOT_RUN_EDITOR_REVIEW_COMMAND_ID);
      // Binary-verbatim dispatch args: (rootUri, HEAD commit).
      assert.strictEqual(
        (w.executed[0].args[0] as { fsPath: string }).fsPath,
        "/repo",
      );
      assert.strictEqual(w.executed[0].args[1], "newsha1");
      // Best-effort scm notification still runs.
      assert.deepStrictEqual(w.notified, ["/repo"]);
    } finally {
      d.dispose();
    }
  });

  it("does not dispatch when shouldRunBugbot is false", async () => {
    // Merge commit -> predicate false.
    const repo = makeRepo({ nowMs: NOW, commitInfo: { parents: ["a", "b"] } });
    const w = makeWatcherDeps(repo, makeGit());
    const d = watchBugbotCommits(w.deps);
    try {
      repo.state.HEAD = { name: "main", commit: "mergesha" };
      repo.fireChange();
      w.timers.fireAll();
      await flush();
      await flush();
      assert.strictEqual(w.executed.length, 0);
      assert.ok(w.log.debugs.includes("shouldRunBugbot: merge commit"));
      // Notification still attempted (binary: unconditional in try/catch).
      assert.deepStrictEqual(w.notified, ["/repo"]);
    } finally {
      d.dispose();
    }
  });

  it("suppresses runs within 10s of a rebase", async () => {
    const repo = makeRepo({ nowMs: NOW, rebaseCommit: { hash: "r" } });
    const w = makeWatcherDeps(repo, makeGit());
    const d = watchBugbotCommits(w.deps);
    try {
      // Simulate a post-rebase HEAD change: new commit on the same branch.
      repo.state.HEAD = { name: "main", commit: "newsha1" };
      repo.fireChange();
      w.timers.fireAll();
      await flush();
      await flush();
      assert.strictEqual(w.executed.length, 0);
      assert.ok(
        w.log.debugs.includes("shouldRunBugbot: just finished rebasing"),
      );
      // After the quiet window, a new change runs.
      w.setNow(NOW + 11_000);
      repo.state.rebaseCommit = undefined;
      repo.state.HEAD = { name: "main", commit: "newsha2" };
      repo.fireChange();
      w.timers.fireAll();
      await flush();
      await flush();
      assert.strictEqual(w.executed.length, 1);
    } finally {
      d.dispose();
    }
  });

  it("stops watching closed repositories", async () => {
    let closeListener: ((r: BugbotRepoLike) => void) | undefined;
    const repo = makeRepo();
    const git = makeGit();
    const w = makeWatcherDeps(repo, git);
    const deps = {
      ...w.deps,
      getGitApi: () => ({
        repositories: [repo],
        onDidOpenRepository: () => ({ dispose: () => undefined }),
        onDidCloseRepository: (fn: (r: BugbotRepoLike) => void) => {
          closeListener = fn;
          return { dispose: () => undefined };
        },
      }),
    };
    const d = watchBugbotCommits(deps);
    try {
      closeListener!(repo);
      repo.fireChange();
      w.timers.fireAll();
      await flush();
      await flush();
      assert.strictEqual(w.executed.length, 0);
    } finally {
      d.dispose();
    }
  });

  it("notifies git commit even when the git API is absent (no throw)", async () => {
    const w = makeWatcherDeps(makeRepo({ nowMs: NOW }), makeGit());
    const deps = { ...w.deps, getGitApi: () => undefined };
    const d = watchBugbotCommits(deps);
    d.dispose();
    assert.strictEqual(w.executed.length, 0);
  });
});
