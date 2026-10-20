/**
 * Unit tests for the Cursor-parity `worktree-max-count` gap (DEV-GAPS-37B).
 *
 * Spec (verbatim, REA 2026-10-19): setting `cursor.worktreeMaxCount`
 * (default 25) — settings-tab label "Max Worktrees": "Maximum number of
 * Cursor-managed worktrees to retain across all workspaces. Older worktrees
 * are removed first." (detail-settings-2026-10-19.md:182;
 * deep-docs-all.md:124 "default 25 per machine").
 *
 * Mirrored here as `ide.worktreeMaxCount` (default 25, machine scope).
 * Enforcement is machine-wide over the managed root: after each
 * `WorktreeService.create()`, the OLDEST managed worktrees beyond the cap
 * are removed first; git-locked, dirty (uncommitted changes) and prunable
 * worktrees are DEFERRED (skipped, never force-removed) — mirroring
 * Cursor's "protected-worktree deferral"
 * (harvest-cursor-worktree-textmate-2026-10-19.md).
 *
 * node:test, zero extra deps. The `vscode` module is stubbed via
 * ./vscode-stub (imported FIRST) with GAPS-37B configurable overrides
 * (__setConfig/__clearConfig). The managed root is redirected with the
 * IDE_CODE_WORKTREES_ROOT env override so tests never touch the real home.
 * Real `git` is spawned (no mocks) — these are honest integration tests.
 *
 * Run after `tsc`:  node --test out/services/test/run-worktree-max-count-tests.js
 */
import "./vscode-stub";
import { __setConfig, __clearConfig } from "./vscode-stub";
import { describe, it, beforeEach, afterEach } from "node:test";
import * as assert from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import {
  DEFAULT_WORKTREE_MAX_COUNT,
  WORKTREE_MAX_COUNT_SETTING,
  WorktreeService,
  getWorktreeMaxCount,
  managedWorktreesRoot,
} from "../worktreeService";

const svc = new WorktreeService();

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

function initRepo(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
  git(dir, ["init", "-b", "main"]);
  git(dir, ["config", "user.email", "test@example.com"]);
  git(dir, ["config", "user.name", "Test"]);
  git(dir, ["commit", "--allow-empty", "-m", "init"]);
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** All managed worktree dirs currently under the (overridden) managed root. */
function managedDirs(): string[] {
  const root = managedWorktreesRoot();
  const out: string[] = [];
  for (const repo of fs.readdirSync(root)) {
    for (const slug of fs.readdirSync(path.join(root, repo))) {
      out.push(path.join(root, repo, slug));
    }
  }
  return out;
}

describe("worktree-max-count setting (Cursor parity: cursor.worktreeMaxCount)", () => {
  beforeEach(() => {
    __clearConfig();
  });

  afterEach(() => {
    __clearConfig();
    delete process.env["IDE_CODE_WORKTREES_ROOT"];
  });

  it(`setting key is "${WORKTREE_MAX_COUNT_SETTING}", default is ${DEFAULT_WORKTREE_MAX_COUNT}`, () => {
    assert.strictEqual(WORKTREE_MAX_COUNT_SETTING, "worktreeMaxCount");
    assert.strictEqual(DEFAULT_WORKTREE_MAX_COUNT, 25);
  });

  it("getWorktreeMaxCount() falls back to 25 for invalid values", () => {
    assert.strictEqual(getWorktreeMaxCount(), 25); // unset
    __setConfig("ide", "worktreeMaxCount", 0);
    assert.strictEqual(getWorktreeMaxCount(), 25);
    __setConfig("ide", "worktreeMaxCount", -5);
    assert.strictEqual(getWorktreeMaxCount(), 25);
    __setConfig("ide", "worktreeMaxCount", 2.7);
    assert.strictEqual(getWorktreeMaxCount(), 2);
    __setConfig("ide", "worktreeMaxCount", "many");
    assert.strictEqual(getWorktreeMaxCount(), 25);
  });

  it("getWorktreeMaxCount() honors a valid override", () => {
    __setConfig("ide", "worktreeMaxCount", 3);
    assert.strictEqual(getWorktreeMaxCount(), 3);
  });

  it("create() enforces the cap: oldest managed worktrees are removed first", async () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "wtcap-"));
    const wtRoot = path.join(base, "worktrees");
    process.env["IDE_CODE_WORKTREES_ROOT"] = wtRoot;
    const repoRoot = path.join(base, "repo");
    initRepo(repoRoot);
    __setConfig("ide", "worktreeMaxCount", 3);
    try {
      for (let i = 1; i <= 4; i++) {
        const branch = `cap-b${i}`;
        await svc.create(repoRoot, svc.resolveWorktreePath(repoRoot, branch), branch);
        await sleep(30);
      }
      const dirs = managedDirs();
      assert.strictEqual(dirs.length, 3, `expected 3 managed worktrees, got ${dirs.length}: ${dirs}`);
      const names = dirs.map((d) => path.basename(d));
      assert.ok(!names.includes("cap-b1"), `oldest (cap-b1) must be evicted first, got ${names}`);
      assert.deepStrictEqual(names.sort(), ["cap-b2", "cap-b3", "cap-b4"]);
      // The evicted worktree is also gone from git's worktree list.
      const linked = (await svc.list(repoRoot)).filter((w) => !w.isMain);
      assert.strictEqual(linked.length, 3);
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
  });

  it("dirty worktrees are deferred, not force-removed", async () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "wtcap-"));
    const wtRoot = path.join(base, "worktrees");
    process.env["IDE_CODE_WORKTREES_ROOT"] = wtRoot;
    const repoRoot = path.join(base, "repo");
    initRepo(repoRoot);
    __setConfig("ide", "worktreeMaxCount", 2);
    try {
      const d1 = svc.resolveWorktreePath(repoRoot, "dirty-b1");
      const d2 = svc.resolveWorktreePath(repoRoot, "dirty-b2");
      await svc.create(repoRoot, d1, "dirty-b1");
      await sleep(30);
      await svc.create(repoRoot, d2, "dirty-b2");
      await sleep(30);
      // Make b2 dirty (uncommitted changes).
      fs.writeFileSync(path.join(d2, "uncommitted.txt"), "work in progress");
      // Create b3: excess=1 → oldest is b1 (clean) → evicted. b2 kept.
      const d3 = svc.resolveWorktreePath(repoRoot, "dirty-b3");
      await svc.create(repoRoot, d3, "dirty-b3");
      await sleep(30);
      assert.ok(!fs.existsSync(d1), "oldest clean worktree must be evicted");
      assert.ok(fs.existsSync(d2), "dirty worktree must be deferred (kept)");
      // Create b4: candidates oldest-first: b2 (dirty → deferred), b3 (clean) → evicted.
      const d4 = svc.resolveWorktreePath(repoRoot, "dirty-b4");
      await svc.create(repoRoot, d4, "dirty-b4");
      assert.ok(fs.existsSync(d2), "dirty worktree still deferred after second pass");
      assert.ok(!fs.existsSync(d3), "next-oldest clean worktree evicted");
      assert.ok(fs.existsSync(d4), "just-created worktree is never a candidate");
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
  });

  it("git-locked worktrees are deferred", async () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "wtcap-"));
    const wtRoot = path.join(base, "worktrees");
    process.env["IDE_CODE_WORKTREES_ROOT"] = wtRoot;
    const repoRoot = path.join(base, "repo");
    initRepo(repoRoot);
    __setConfig("ide", "worktreeMaxCount", 1);
    try {
      const d1 = svc.resolveWorktreePath(repoRoot, "lock-b1");
      await svc.create(repoRoot, d1, "lock-b1");
      await sleep(30);
      git(repoRoot, ["worktree", "lock", d1]);
      const d2 = svc.resolveWorktreePath(repoRoot, "lock-b2");
      await svc.create(repoRoot, d2, "lock-b2");
      assert.ok(fs.existsSync(d1), "locked worktree must be deferred (kept)");
      assert.ok(fs.existsSync(d2), "just-created worktree kept");
    } finally {
      try {
        git(repoRoot, ["worktree", "unlock", path.join(wtRoot, "repo", "lock-b1")]);
      } catch {
        /* best effort */
      }
      fs.rmSync(base, { recursive: true, force: true });
    }
  });

  it("enforceWorktreeMaxCount() is a no-op when under the cap", async () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "wtcap-"));
    const wtRoot = path.join(base, "worktrees");
    process.env["IDE_CODE_WORKTREES_ROOT"] = wtRoot;
    const repoRoot = path.join(base, "repo");
    initRepo(repoRoot);
    __setConfig("ide", "worktreeMaxCount", 25);
    try {
      await svc.create(repoRoot, svc.resolveWorktreePath(repoRoot, "noop-b1"), "noop-b1");
      const res = await svc.enforceWorktreeMaxCount();
      assert.deepStrictEqual(res.removed, []);
      assert.deepStrictEqual(res.deferred, []);
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
  });
});
