/**
 * checkout-provider protocol tests (node:test, zero extra deps).
 *
 * Verifies the `CheckoutProvider` implementation against the verbatim
 * evidence (decompiled `cursor-checkout` v0.0.1, Cursor 3.25.9):
 *  - checkout-provider-protocol: checkoutBranch(delegate, branchName, options,
 *    token) — delegate-first verbatim shape; dirty → delegate.resolveConflict();
 *    localOnly; commitSha → checkoutFetchedCommit; fetch-then-checkout;
 *    final `merge --ff-only --quiet origin/<b>`), ensureCurrentBranchPushed,
 *    hasDirtyWorkingTree
 *  - checkout-conflict-resolution: stash → `git stash --include-untracked`;
 *    commit → `git add -A` + `git commit -m "checkpoint before checking out
 *    <branch>"`; discard → `git reset --quiet --hard HEAD` + `git clean
 *    --quiet -fd`; dismissed/'abort' → throws `Aborting checkout` (verbatim)
 *  - snapshot-push-cloud-branch: temp-index commit-tree flow, default
 *    messages, `cursor/` prefix, `cloud-agent-<ts>-<rand>` naming, optional
 *    stash after push, temp index cleanup
 *  - branch-warm-prefetch: `+refs/heads/<b>:refs/remotes/origin/<b>`,
 *    30 s `recentlyWarmedBranches` cache, --no-write-fetch-head gating
 *
 * A fake `IGitRunner` records every invocation and serves scripted results.
 *
 * Run after `tsc`:  node out/checkout-provider.test.js
 */
import { describe, it, beforeEach } from "node:test";
import * as assert from "node:assert";
import {
  CheckoutProviderImpl,
  type GitRunOptions,
  type GitRunResult,
  type ICancellation,
  type ICheckoutConflictDelegate,
  type IGitRunner,
} from "./checkoutProvider.js";

const CWD = "/repo";

function ok(stdout = ""): GitRunResult {
  return { stdout, stderr: "", exitCode: 0 };
}
function fail(stderr: string, exitCode = 1): GitRunResult {
  return { stdout: "", stderr, exitCode };
}

class FakeGit implements IGitRunner {
  calls: Array<{ args: string[]; opts: GitRunOptions }> = [];
  streamingCalls: Array<{ args: string[]; opts: GitRunOptions }> = [];
  handlers: Array<{ match: (args: string[]) => boolean; result: GitRunResult }> = [];
  streamingResult = false;
  version = "git version 2.43.0";

  on(match: (args: string[]) => boolean, result: GitRunResult): this {
    this.handlers.push({ match, result });
    return this;
  }

  async run(args: readonly string[], opts: GitRunOptions): Promise<GitRunResult> {
    const list = [...args];
    this.calls.push({ args: list, opts });
    for (const h of this.handlers) {
      if (h.match(list)) {
        return h.result;
      }
    }
    return ok();
  }

  async runStreamingEarlyExit(
    args: readonly string[],
    opts: GitRunOptions
  ): Promise<boolean> {
    this.streamingCalls.push({ args: [...args], opts });
    return this.streamingResult;
  }

  async getGitVersion(): Promise<string> {
    return this.version;
  }

  argLists(): string[][] {
    return this.calls.map((c) => c.args);
  }

  hasCall(...expected: string[]): boolean {
    return this.argLists().some(
      (a) => a.length === expected.length && a.every((x, i) => x === expected[i])
    );
  }
}

const startsWith =
  (...prefix: string[]) =>
  (args: string[]) =>
    prefix.every((p, i) => args[i] === p);

function testToken(): ICancellation {
  return {
    isCancellationRequested: false,
    onCancellationRequested: () => ({ dispose() {} }),
  } as unknown as ICancellation;
}

function conflictChoice(
  choice: "stash" | "commit" | "discard" | "abort" | undefined
): ICheckoutConflictDelegate {
  return {
    resolveConflict: async () => choice,
    onNoConflictDetected: () => {},
  };
}

describe("checkout-provider-protocol", () => {
  let git: FakeGit;
  let now: number;
  let unlinked: string[];

  beforeEach(() => {
    git = new FakeGit();
    now = 1_000_000;
    unlinked = [];
  });

  const makeProvider = () =>
    new CheckoutProviderImpl(git, {
      now: () => now,
      unlink: async (p: string) => {
        unlinked.push(p);
      },
      randomSuffix: () => "rand",
    });

  // Verbatim protocol shape: checkoutBranch(delegate, branchName, options, token).
  const checkoutAs = (choice: "stash" | "commit" | "discard" | "abort" | undefined) => ({
    p: makeProvider(),
    d: conflictChoice(choice),
  });

  describe("branch-warm-prefetch", () => {
    it("fetches +refs/heads/<b>:refs/remotes/origin/<b> with --no-write-fetch-head on modern git", async () => {
      const { p, d } = checkoutAs(undefined);
      await p.warmCheckoutBranch("feature", testToken(), CWD);
      assert.ok(
        git.hasCall(
          "fetch",
          "--no-write-fetch-head",
          "origin",
          "+refs/heads/feature:refs/remotes/origin/feature"
        ),
        `calls: ${JSON.stringify(git.argLists())}`
      );
    });

    it("omits --no-write-fetch-head on git < 2.29", async () => {
      git.version = "git version 2.28.0";
      const { p, d } = checkoutAs(undefined);
      await p.warmCheckoutBranch("feature", testToken(), CWD);
      assert.ok(
        git.hasCall("fetch", "origin", "+refs/heads/feature:refs/remotes/origin/feature")
      );
      assert.ok(
        !git.argLists().some((a) => a.includes("--no-write-fetch-head"))
      );
    });

    it("skips the fetch when warmed in the last 30 s, refetches after", async () => {
      const { p, d } = checkoutAs(undefined);
      await p.warmCheckoutBranch("feature", testToken(), CWD);
      await p.warmCheckoutBranch("feature", testToken(), CWD);
      assert.strictEqual(
        git.argLists().filter((a) => a[0] === "fetch").length,
        1
      );
      now += 31_000;
      await p.warmCheckoutBranch("feature", testToken(), CWD);
      assert.strictEqual(
        git.argLists().filter((a) => a[0] === "fetch").length,
        2
      );
    });

    it("rejects leading-dash branch names", async () => {
      const { p, d } = checkoutAs(undefined);
      await assert.rejects(
        () => p.warmCheckoutBranch("-b", testToken(), CWD),
        /Invalid branch name/
      );
    });
  });

  describe("checkoutBranch", () => {
    it("localOnly: verifies refs/heads/<b> then plain checkout", async () => {
      git.on(startsWith("show-ref"), ok("abc refs/heads/b\n"));
      const { p, d } = checkoutAs(undefined);
      await p.checkoutBranch(d, "b", { localOnly: true }, testToken(), CWD);
      assert.ok(git.hasCall("show-ref", "--verify", "--quiet", "refs/heads/b"));
      assert.ok(git.hasCall("checkout", "b"));
    });

    it("localOnly: throws when the local branch is missing", async () => {
      git.on(startsWith("show-ref"), fail("", 1));
      const { p, d } = checkoutAs(undefined);
      await assert.rejects(
        () => p.checkoutBranch(d, "nope", { localOnly: true }, testToken(), CWD),
        /Local branch not found/
      );
    });

    it("dirty tree + stash choice → git stash --include-untracked", async () => {
      git.streamingResult = true;
      git.on(startsWith("show-ref"), ok());
      const { p, d } = checkoutAs("stash");
      await p.checkoutBranch(d, "b", {}, testToken(), CWD);
      const lists = git.argLists();
      const stashIdx = lists.findIndex((a) => a[0] === "stash");
      const checkoutIdx = lists.findIndex((a) => a[0] === "checkout");
      assert.ok(stashIdx >= 0 && checkoutIdx > stashIdx, "stash must precede checkout");
      assert.ok(git.hasCall("stash", "--include-untracked"));
    });

    it("dirty tree + commit choice → add -A + checkpoint commit", async () => {
      git.streamingResult = true;
      git.on(startsWith("show-ref"), ok());
      const { p, d } = checkoutAs("commit");
      await p.checkoutBranch(d, "b", {}, testToken(), CWD);
      assert.ok(git.hasCall("add", "-A"));
      assert.ok(git.hasCall("commit", "-m", "checkpoint before checking out b"));
    });

    it("dirty tree + discard choice → reset --hard + clean -fd", async () => {
      git.streamingResult = true;
      git.on(startsWith("show-ref"), ok());
      const { p, d } = checkoutAs("discard");
      await p.checkoutBranch(d, "b", {}, testToken(), CWD);
      assert.ok(git.hasCall("reset", "--quiet", "--hard", "HEAD"));
      assert.ok(git.hasCall("clean", "--quiet", "-fd"));
    });

    it("dirty tree + dismissed prompt → 'Aborting checkout' (verbatim)", async () => {
      git.streamingResult = true;
      const { p, d } = checkoutAs(undefined);
      await assert.rejects(
        () => p.checkoutBranch(d, "b", {}, testToken(), CWD),
        (err: unknown) => err instanceof Error && err.message === "Aborting checkout"
      );
    });

    it("dirty tree + 'abort' choice → 'Aborting checkout' (verbatim)", async () => {
      git.streamingResult = true;
      const { p, d } = checkoutAs("abort");
      await assert.rejects(
        () => p.checkoutBranch(d, "b", {}, testToken(), CWD),
        (err: unknown) => err instanceof Error && err.message === "Aborting checkout"
      );
    });

    it("commitSha with same local SHA → checkout -B", async () => {
      const sha = "abc123";
      git.on(startsWith("ls-remote"), ok(`${sha}\trefs/heads/b\n`));
      git.on(startsWith("rev-parse", "--verify"), ok(`${sha}\n`));
      const { p, d } = checkoutAs(undefined);
      await p.checkoutBranch(d, "b", { commitSha: sha }, testToken(), CWD);
      assert.ok(git.hasCall("checkout", "-B", "b", sha));
    });

    it("commitSha that is an ancestor → detach at SHA", async () => {
      const sha = "abc123";
      git.on(startsWith("ls-remote"), ok(`${sha}\trefs/heads/b\n`));
      git.on(startsWith("rev-parse", "--verify"), ok("def456\n"));
      git.on(startsWith("merge-base"), ok());
      const { p, d } = checkoutAs(undefined);
      await p.checkoutBranch(d, "b", { commitSha: sha }, testToken(), CWD);
      assert.ok(git.hasCall("checkout", "--detach", sha));
    });

    it("commitSha unrelated to local branch → checkout -b <b> <sha>", async () => {
      const sha = "abc123";
      git.on(startsWith("ls-remote"), ok(`${sha}\trefs/heads/b\n`));
      git.on(startsWith("rev-parse", "--verify"), ok("def456\n"));
      git.on(startsWith("merge-base"), fail("", 1));
      const { p, d } = checkoutAs(undefined);
      await p.checkoutBranch(d, "b", { commitSha: sha }, testToken(), CWD);
      assert.ok(git.hasCall("checkout", "-b", "b", sha));
    });

    it("remote branch → checkout -b <b> origin/<b> then merge --ff-only --quiet", async () => {
      git.on(startsWith("show-ref"), fail("", 1)); // no local branch
      git.on(startsWith("ls-remote", "--heads"), ok("abc\trefs/heads/b\n"));
      const { p, d } = checkoutAs(undefined);
      await p.checkoutBranch(d, "b", {}, testToken(), CWD);
      assert.ok(git.hasCall("checkout", "-b", "b", "origin/b"));
      assert.ok(git.hasCall("merge", "--ff-only", "--quiet", "origin/b"));
    });

    it("local branch → plain checkout (no -b)", async () => {
      git.on(startsWith("show-ref"), ok());
      const { p, d } = checkoutAs(undefined);
      await p.checkoutBranch(d, "b", {}, testToken(), CWD);
      assert.ok(git.hasCall("checkout", "b"));
      assert.ok(!git.hasCall("checkout", "-b", "b", "origin/b"));
      assert.ok(git.hasCall("merge", "--ff-only", "--quiet", "origin/b"));
    });

    it("throws Remote branch not found on origin when neither exists", async () => {
      git.on(startsWith("show-ref"), fail("", 1));
      git.on(startsWith("ls-remote", "--heads"), ok(""));
      const { p, d } = checkoutAs(undefined);
      await assert.rejects(
        () => p.checkoutBranch(d, "ghost", {}, testToken(), CWD),
        /Remote branch not found on origin: ghost/
      );
    });

    it("normalizes refs/heads/ prefixes", async () => {
      git.on(startsWith("show-ref"), ok());
      const { p, d } = checkoutAs(undefined);
      await p.checkoutBranch(d, "refs/heads/b", { localOnly: true }, testToken(), CWD);
      assert.ok(git.hasCall("show-ref", "--verify", "--quiet", "refs/heads/b"));
    });
  });

  describe("ensureCurrentBranchPushed", () => {
    it("pushes HEAD:refs/heads/<branch>", async () => {
      git.on(startsWith("rev-parse", "--abbrev-ref"), ok("main\n"));
      const { p, d } = checkoutAs(undefined);
      await p.ensureCurrentBranchPushed({}, testToken());
      assert.ok(git.hasCall("push", "origin", "HEAD:refs/heads/main"));
    });

    it("adds --force-with-lease when forcePush", async () => {
      const { p, d } = checkoutAs(undefined);
      await p.ensureCurrentBranchPushed({ branchName: "b", forcePush: true }, testToken());
      assert.ok(git.hasCall("push", "--force-with-lease", "origin", "HEAD:refs/heads/b"));
    });

    it("rejects detached HEAD for push flows", async () => {
      git.on(startsWith("rev-parse", "--abbrev-ref"), ok("HEAD\n"));
      const { p, d } = checkoutAs(undefined);
      await assert.rejects(
        () => p.ensureCurrentBranchPushed({}, testToken()),
        /detached/
      );
    });

    it("maps non-fast-forward to the friendly moving-to-cloud message", async () => {
      git.on(startsWith("rev-parse", "--abbrev-ref"), ok("main\n"));
      git.on(
        startsWith("push"),
        fail("! [rejected] main -> main (non-fast-forward)")
      );
      const { p, d } = checkoutAs(undefined);
      await assert.rejects(
        () => p.ensureCurrentBranchPushed({}, testToken()),
        /Your branch "main" is behind origin\. Pull the latest changes, then try moving to cloud again\./
      );
    });
  });

  describe("snapshot-push-cloud-branch", () => {
    beforeEach(() => {
      git.on(startsWith("rev-parse", "--abbrev-ref"), ok("feature\n"));
      git.on(startsWith("write-tree"), ok("tree123\n"));
      git.on(startsWith("commit-tree"), ok("commit456\n"));
    });

    it("snapshots via a temp index without touching the working tree", async () => {
      const { p, d } = checkoutAs(undefined);
      const pushed = await p.snapshotAndPushCurrentBranch({}, testToken());
      assert.match(pushed, /^cursor\/cloud-agent-1000000-rand$/);

      const lists = git.argLists();
      const seq = ["read-tree", "add", "write-tree", "commit-tree", "update-ref", "push"];
      let lastIdx = -1;
      for (const sub of seq) {
        const idx = lists.findIndex((a, i) => i > lastIdx && a[0] === sub);
        assert.ok(idx > lastIdx, `${sub} must follow the snapshot sequence`);
        lastIdx = idx;
      }

      assert.ok(git.hasCall("read-tree", "HEAD"));
      assert.ok(git.hasCall("add", "-A", "."));
      assert.ok(
        git.hasCall(
          "commit-tree",
          "tree123",
          "-p",
          "HEAD",
          "-m",
          "Cursor: Apply local changes for cloud agent"
        )
      );
      assert.ok(git.hasCall("update-ref", `refs/heads/${pushed}`, "commit456"));
      assert.ok(git.hasCall("push", "--set-upstream", "origin", pushed));

      // GIT_INDEX_FILE is set on the index-building commands...
      const indexCall = git.calls.find((c) => c.args[0] === "read-tree");
      assert.ok(indexCall?.opts.env?.["GIT_INDEX_FILE"]);
      assert.match(
        String(indexCall?.opts.env?.["GIT_INDEX_FILE"]),
        /cursor-index-feature-\d+-rand$/
      );
      // ...but not on the push.
      const pushCall = git.calls.find((c) => c.args[0] === "push");
      assert.strictEqual(pushCall?.opts.env?.["GIT_INDEX_FILE"], undefined);

      // Temp index is cleaned up.
      assert.strictEqual(unlinked.length, 1);
      assert.match(unlinked[0] ?? "", /cursor-index-feature-\d+-rand$/);
    });

    it("uses a custom branch prefix", async () => {
      const { p, d } = checkoutAs(undefined);
      const pushed = await p.snapshotAndPushCurrentBranch(
        { branchPrefix: "cloud/" },
        testToken()
      );
      assert.match(pushed, /^cloud\/cloud-agent-1000000-rand$/);
    });

    it("stashes local changes after push when requested, with default message", async () => {
      const { p, d } = checkoutAs(undefined);
      await p.snapshotAndPushCurrentBranch(
        { stashLocalChangesAfterPush: true },
        testToken()
      );
      assert.ok(
        git.hasCall(
          "stash",
          "push",
          "--include-untracked",
          "-m",
          "Cursor: moved local changes to cloud agent"
        )
      );
    });

    it("does not stash when not requested", async () => {
      const { p, d } = checkoutAs(undefined);
      await p.snapshotAndPushCurrentBranch({}, testToken());
      assert.ok(!git.argLists().some((a) => a[0] === "stash"));
    });
  });

  describe("hasDirtyWorkingTree", () => {
    it("streams status --porcelain with early exit", async () => {
      git.streamingResult = true;
      const { p, d } = checkoutAs(undefined);
      assert.strictEqual(await p.hasDirtyWorkingTree(testToken(), CWD), true);
      assert.deepStrictEqual(git.streamingCalls[0]?.args, [
        "--no-optional-locks",
        "status",
        "--porcelain",
      ]);
      git.streamingResult = false;
      assert.strictEqual(await p.hasDirtyWorkingTree(testToken(), CWD), false);
    });
  });
});
