/**
 * GAPS-11B (agent-git-branch-reminder) tests (node:test, no vscode needed).
 *
 * Guards the BINARY-VERIFIED Cursor behavior
 * (extensions/cursor-agent-exec/dist/main.js 3.25.6, function `zre` +
 * call site; REA doc docs/rea/deepdig-runtime-agent-loop-2026-10-19.md §2
 * step 10): at pre-turn turn-build time the previously tracked git repo
 * branches are diffed against the current repos; on change a
 * `<system_reminder>` block is injected into the turn's USER CONTENT.
 *
 * - diffTrackedBranches: mirrors Cursor's inner diff exactly (prev empty →
 *   no changes; new/removed repos → no changes; same branch → no changes;
 *   changed branch → {repoPath, from, to}).
 * - buildBranchChangeReminder: pins the VERBATIM binary strings for the
 *   basic and enhanced variants (incl. the ancestor sentence + closing
 *   line selection of the enhanced variant).
 * - readTrackedBranches / checkPreviousBranchIsAncestor: pure against an
 *   injected GitRunner (no real git spawned).
 * - TrackedGitRepoState.checkForReminder: first call seeds the baseline
 *   silently (no reminder on the first turn, like Cursor); a later branch
 *   change yields the reminder; unchanged → "".
 *
 * Run after `tsc`:  node out/services/test/run-git-branch-tracker-tests.js
 */
import { describe, it } from "node:test";
import * as assert from "node:assert";
import {
  diffTrackedBranches,
  buildBranchChangeReminder,
  readTrackedBranches,
  checkPreviousBranchIsAncestor,
  TrackedGitRepoState,
  type BranchChange,
  type GitRunner,
  type TrackedRepoBranch,
} from "../gitBranchTracker";

describe("diffTrackedBranches — Cursor's inner diff", () => {
  const prev: TrackedRepoBranch[] = [
    { repoPath: "/ws/a", branchName: "main" },
    { repoPath: "/ws/b", branchName: "feature/x" },
  ];

  it("empty previous snapshot → no changes (first turn never reminds)", () => {
    assert.deepStrictEqual(
      diffTrackedBranches([], [{ repoPath: "/ws/a", branchName: "main" }]),
      [],
    );
  });

  it("empty current snapshot → no changes", () => {
    assert.deepStrictEqual(diffTrackedBranches(prev, []), []);
  });

  it("unchanged branches → no changes", () => {
    assert.deepStrictEqual(diffTrackedBranches(prev, [...prev]), []);
  });

  it("changed branch → {repoPath, from, to}", () => {
    assert.deepStrictEqual(
      diffTrackedBranches(prev, [
        { repoPath: "/ws/a", branchName: "feature/y" },
        { repoPath: "/ws/b", branchName: "feature/x" },
      ]),
      [{ repoPath: "/ws/a", from: "main", to: "feature/y" }],
    );
  });

  it("new repo in current (absent from prev) → no change entry", () => {
    assert.deepStrictEqual(
      diffTrackedBranches(prev, [...prev, { repoPath: "/ws/c", branchName: "main" }]),
      [],
    );
  });

  it("repo removed from current → no change entry", () => {
    assert.deepStrictEqual(
      diffTrackedBranches(prev, [{ repoPath: "/ws/a", branchName: "main" }]),
      [],
    );
  });
});

describe("buildBranchChangeReminder — verbatim binary strings", () => {
  const changes: BranchChange[] = [{ repoPath: "/ws/a", from: "main", to: "feature/y" }];

  it("no changes → empty string", () => {
    assert.strictEqual(buildBranchChangeReminder([], false), "");
    assert.strictEqual(buildBranchChangeReminder([], true), "");
  });

  it("basic variant — verbatim wording", () => {
    const r = buildBranchChangeReminder(changes, false);
    assert.ok(r.startsWith("<system_reminder>\n"), r);
    assert.ok(r.endsWith("</system_reminder>"), r);
    assert.ok(r.includes("The active branch changed since the last turn:\n"), r);
    assert.ok(r.includes("/ws/a changed from main to feature/y.\n"), r);
    assert.ok(
      r.includes(
        "Assume these branch changes were intentional and use the new branch state as the current working context.\n",
      ),
      r,
    );
  });

  it("enhanced variant — verbatim wording, non-ancestor closing", () => {
    const r = buildBranchChangeReminder(changes, true, () => false);
    assert.ok(r.startsWith("<system_reminder>\n"), r);
    assert.ok(r.includes("The active git branch changed since the last turn:\n"), r);
    assert.ok(r.includes('/ws/a: changed from "main" to "feature/y".\n'), r);
    assert.ok(!r.includes("is an ancestor of the current HEAD"), r);
    assert.ok(r.includes("Use the current branch as the working context.\n"), r);
  });

  it("enhanced variant — ancestor sentence + prior-edits closing", () => {
    const r = buildBranchChangeReminder(changes, true, () => true);
    assert.ok(
      r.includes(
        '/ws/a: changed from "main" to "feature/y". The previous branch is an ancestor of the current HEAD.\n',
      ),
      r,
    );
    assert.ok(r.includes("Prior edits should be present on the current branch.\n"), r);
  });

  it("multiple changes — one line each", () => {
    const r = buildBranchChangeReminder(
      [
        { repoPath: "/ws/a", from: "main", to: "f1" },
        { repoPath: "/ws/b", from: "x", to: "y" },
      ],
      false,
    );
    assert.ok(r.includes("/ws/a changed from main to f1.\n"), r);
    assert.ok(r.includes("/ws/b changed from x to y.\n"), r);
  });
});

describe("readTrackedBranches — injected GitRunner", () => {
  const fakeRunner: GitRunner = async (cwd, args) => {
    if (args[0] === "rev-parse" && args[1] === "--show-toplevel") {
      if (cwd === "/ws/a") return "/ws/a\n";
      throw new Error("not a repo");
    }
    if (args[0] === "rev-parse" && args[1] === "--abbrev-ref" && args[2] === "HEAD") {
      return "feature/z\n";
    }
    throw new Error("unexpected");
  };

  it("resolves toplevel + branch; skips non-repos", async () => {
    const out = await readTrackedBranches(["/ws/a", "/ws/nope"], fakeRunner);
    assert.deepStrictEqual(out, [{ repoPath: "/ws/a", branchName: "feature/z" }]);
  });
});

describe("checkPreviousBranchIsAncestor — injected GitRunner", () => {
  it("exit 0 → true", async () => {
    const ok = await checkPreviousBranchIsAncestor("/ws/a", "main", "f", async () => "");
    assert.strictEqual(ok, true);
  });

  it("any error → false", async () => {
    const bad: GitRunner = async () => {
      throw new Error("exit 1");
    };
    assert.strictEqual(await checkPreviousBranchIsAncestor("/ws/a", "main", "f", bad), false);
  });
});

describe("TrackedGitRepoState.checkForReminder — pre-turn step", () => {
  it("first call seeds the baseline silently (no reminder on first turn)", async () => {
    const state = new TrackedGitRepoState(async () => [
      { repoPath: "/ws/a", branchName: "main" },
    ]);
    assert.strictEqual(await state.checkForReminder(false), "");
  });

  it("branch change on a later turn → reminder, baseline advances", async () => {
    let current: TrackedRepoBranch[] = [{ repoPath: "/ws/a", branchName: "main" }];
    const state = new TrackedGitRepoState(async () => current);
    assert.strictEqual(await state.checkForReminder(false), "");
    current = [{ repoPath: "/ws/a", branchName: "feature/y" }];
    const r = await state.checkForReminder(false);
    assert.ok(r.includes("/ws/a changed from main to feature/y."), r);
    // Baseline advanced: same state again → quiet.
    assert.strictEqual(await state.checkForReminder(false), "");
  });

  it("unchanged → empty", async () => {
    const state = new TrackedGitRepoState(async () => [
      { repoPath: "/ws/a", branchName: "main" },
    ]);
    await state.checkForReminder(true);
    assert.strictEqual(await state.checkForReminder(true), "");
  });

  it("enhanced flag flows through to the wording", async () => {
    let current: TrackedRepoBranch[] = [{ repoPath: "/ws/a", branchName: "main" }];
    const state = new TrackedGitRepoState(
      async () => current,
      async () => true,
    );
    await state.checkForReminder(true);
    current = [{ repoPath: "/ws/a", branchName: "feature/y" }];
    const r = await state.checkForReminder(true);
    assert.ok(r.includes("The active git branch changed since the last turn:"), r);
    assert.ok(r.includes("is an ancestor of the current HEAD"), r);
  });
});
