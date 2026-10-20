/**
 * Unit tests for the Cursor-parity worktree sibling settings (DEV-GAPS-41):
 *
 * Spec (verbatim, REA 2026-10-19
 * `harvest-cursor-worktree-textmate-2026-10-19.md`):
 *   - `cursor.worktreeCleanupIntervalHours` (default 6) — interval that runs
 *     the cleanup pass (lease-coordinated periodic cleanup, oldest-first,
 *     protected-worktree deferral).
 *   - `cursor.worktreesGlobalMaxSizeGb` (default 50, 0 = disabled) — when
 *     the total size of managed worktrees exceeds the limit, the oldest are
 *     removed first until the total is back under it.
 *
 * Mirrored here as `ide.worktreeCleanupIntervalHours` (default 6) and
 * `ide.worktreesGlobalMaxSizeGb` (default 50, 0 = disabled), both machine
 * scope. Both policies share one oldest-first eviction engine with the
 * existing `ide.worktreeMaxCount` cap; the scheduler runs the combined
 * pass every N hours.
 *
 * node:test, zero extra deps. The `vscode` module is stubbed via
 * ./vscode-stub (imported FIRST) with configurable overrides
 * (__setConfig/__clearConfig). The managed root is redirected with the
 * IDE_CODE_WORKTREES_ROOT env override so tests never touch the real home.
 * Real `git` is spawned (no mocks) — honest integration tests.
 *
 * Run after `tsc`:  node --test out/services/test/run-worktree-gaps41-tests.js
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
  DEFAULT_WORKTREE_CLEANUP_INTERVAL_HOURS,
  DEFAULT_WORKTREES_GLOBAL_MAX_SIZE_GB,
  WORKTREE_CLEANUP_INTERVAL_HOURS_SETTING,
  WORKTREES_GLOBAL_MAX_SIZE_GB_SETTING,
  WorktreeService,
  WorktreeCleanupScheduler,
  directorySizeBytes,
  getWorktreeCleanupIntervalHours,
  getWorktreesGlobalMaxSizeGb,
  managedWorktreesRoot,
  type WorktreeCleanupResult,
} from "../worktreeService";

const svc = new WorktreeService();
const GIB = 1024 * 1024 * 1024;

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

/**
 * Create a worktree for `branch` with a committed payload file of
 * `payloadBytes` (committed so the worktree is NOT dirty — committed blobs
 * live in the main repo's .git, the worktree dir holds ~payloadBytes).
 */
async function createSizedWorktree(
  repoRoot: string,
  branch: string,
  payloadBytes: number,
): Promise<string> {
  const dir = svc.resolveWorktreePath(repoRoot, branch);
  await svc.create(repoRoot, dir, branch);
  fs.writeFileSync(path.join(dir, "payload.bin"), "x".repeat(payloadBytes));
  git(dir, ["add", "payload.bin"]);
  git(dir, ["commit", "-m", `payload ${payloadBytes}B`]);
  return dir;
}

describe("worktree sibling settings (Cursor parity: cleanup interval + global max size)", () => {
  beforeEach(() => {
    __clearConfig();
  });

  afterEach(() => {
    __clearConfig();
    delete process.env["IDE_CODE_WORKTREES_ROOT"];
  });

  it("setting keys and defaults match the REA spec verbatim", () => {
    assert.strictEqual(WORKTREE_CLEANUP_INTERVAL_HOURS_SETTING, "worktreeCleanupIntervalHours");
    assert.strictEqual(DEFAULT_WORKTREE_CLEANUP_INTERVAL_HOURS, 6);
    assert.strictEqual(WORKTREES_GLOBAL_MAX_SIZE_GB_SETTING, "worktreesGlobalMaxSizeGb");
    assert.strictEqual(DEFAULT_WORKTREES_GLOBAL_MAX_SIZE_GB, 50);
  });

  it("getWorktreeCleanupIntervalHours() defaults to 6, floors, rejects invalid", () => {
    assert.strictEqual(getWorktreeCleanupIntervalHours(), 6); // unset
    __setConfig("ide", "worktreeCleanupIntervalHours", 0);
    assert.strictEqual(getWorktreeCleanupIntervalHours(), 6);
    __setConfig("ide", "worktreeCleanupIntervalHours", -3);
    assert.strictEqual(getWorktreeCleanupIntervalHours(), 6);
    __setConfig("ide", "worktreeCleanupIntervalHours", 2.9);
    assert.strictEqual(getWorktreeCleanupIntervalHours(), 2);
    __setConfig("ide", "worktreeCleanupIntervalHours", "often");
    assert.strictEqual(getWorktreeCleanupIntervalHours(), 6);
  });

  it("getWorktreeCleanupIntervalHours() honors a valid override", () => {
    __setConfig("ide", "worktreeCleanupIntervalHours", 12);
    assert.strictEqual(getWorktreeCleanupIntervalHours(), 12);
  });

  it("getWorktreesGlobalMaxSizeGb(): 0 = disabled (Cursor parity), negatives fall back to 50", () => {
    assert.strictEqual(getWorktreesGlobalMaxSizeGb(), 50); // unset
    __setConfig("ide", "worktreesGlobalMaxSizeGb", 0);
    assert.strictEqual(getWorktreesGlobalMaxSizeGb(), 0, "0 must mean disabled, not fall back");
    __setConfig("ide", "worktreesGlobalMaxSizeGb", -1);
    assert.strictEqual(getWorktreesGlobalMaxSizeGb(), 50);
    __setConfig("ide", "worktreesGlobalMaxSizeGb", "unlimited");
    assert.strictEqual(getWorktreesGlobalMaxSizeGb(), 50);
  });

  it("getWorktreesGlobalMaxSizeGb() honors overrides, including fractional GB", () => {
    __setConfig("ide", "worktreesGlobalMaxSizeGb", 100);
    assert.strictEqual(getWorktreesGlobalMaxSizeGb(), 100);
    __setConfig("ide", "worktreesGlobalMaxSizeGb", 0.5);
    assert.strictEqual(getWorktreesGlobalMaxSizeGb(), 0.5);
  });

  it("directorySizeBytes() sums file sizes, ignores symlinks, never throws on missing dirs", () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "wtsize-"));
    try {
      fs.writeFileSync(path.join(base, "a.bin"), "x".repeat(100));
      fs.mkdirSync(path.join(base, "sub"));
      fs.writeFileSync(path.join(base, "sub", "b.bin"), "y".repeat(250));
      const got = directorySizeBytes(base);
      assert.ok(got >= 350 && got < 350 + 4096, `expected ~350 bytes, got ${got}`);
      // Symlink to a file must not be double-counted.
      fs.symlinkSync(path.join(base, "a.bin"), path.join(base, "link.bin"));
      assert.strictEqual(directorySizeBytes(base), got);
      // Missing dir → 0, never throws.
      assert.strictEqual(directorySizeBytes(path.join(base, "nope")), 0);
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
  });

  it("size eviction: oldest worktrees removed first until total is under the limit", async () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "wtsize-"));
    const wtRoot = path.join(base, "worktrees");
    process.env["IDE_CODE_WORKTREES_ROOT"] = wtRoot;
    const repoRoot = path.join(base, "repo");
    initRepo(repoRoot);
    __setConfig("ide", "worktreeMaxCount", 25); // keep the count cap out of the way
    try {
      const d1 = await createSizedWorktree(repoRoot, "size-b1", 4000);
      await sleep(30);
      const d2 = await createSizedWorktree(repoRoot, "size-b2", 4000);
      await sleep(30);
      const d3 = await createSizedWorktree(repoRoot, "size-b3", 4000);
      await sleep(30);
      const sizeD1 = directorySizeBytes(d1);
      const total = directorySizeBytes(d1) + directorySizeBytes(d2) + directorySizeBytes(d3);
      // Limit chosen so exactly the oldest must go: total - sizeD1 <= limit < total.
      // The +100B margin keeps the inequality robust against float round-trip.
      __setConfig("ide", "worktreesGlobalMaxSizeGb", (total - sizeD1 + 100) / GIB);
      const res = await svc.enforceWorktreesGlobalMaxSize();
      assert.ok(res.removed.includes(d1), `oldest must be evicted first, removed=${res.removed}`);
      assert.ok(fs.existsSync(d2), "second worktree kept");
      assert.ok(fs.existsSync(d3), "newest worktree kept");
      assert.ok(!fs.existsSync(d1), "evicted worktree dir is gone");
      assert.deepStrictEqual(res.deferred, []);
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
  });

  it("size eviction is a no-op when under the limit", async () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "wtsize-"));
    const wtRoot = path.join(base, "worktrees");
    process.env["IDE_CODE_WORKTREES_ROOT"] = wtRoot;
    const repoRoot = path.join(base, "repo");
    initRepo(repoRoot);
    try {
      const d1 = await createSizedWorktree(repoRoot, "noop-b1", 500);
      const res = await svc.enforceWorktreesGlobalMaxSize(); // default 50 GB
      assert.deepStrictEqual(res.removed, []);
      assert.deepStrictEqual(res.deferred, []);
      assert.ok(fs.existsSync(d1));
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
  });

  it("0 = disabled: no size eviction no matter how large the total", async () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "wtsize-"));
    const wtRoot = path.join(base, "worktrees");
    process.env["IDE_CODE_WORKTREES_ROOT"] = wtRoot;
    const repoRoot = path.join(base, "repo");
    initRepo(repoRoot);
    __setConfig("ide", "worktreesGlobalMaxSizeGb", 0);
    __setConfig("ide", "worktreeMaxCount", 25);
    try {
      const d1 = await createSizedWorktree(repoRoot, "dis-b1", 2000);
      const d2 = await createSizedWorktree(repoRoot, "dis-b2", 2000);
      const res = await svc.enforceWorktreesGlobalMaxSize();
      assert.deepStrictEqual(res.removed, []);
      assert.ok(fs.existsSync(d1) && fs.existsSync(d2), "nothing evicted when disabled");
      // The combined pass also reports the limit as disabled.
      const pass = await svc.runWorktreeCleanupPass();
      assert.strictEqual(pass.sizeLimitEnabled, false);
      assert.strictEqual(pass.totalSizeBytes, 0);
      assert.deepStrictEqual(pass.removed, []);
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
  });

  it("dirty worktrees are deferred by size eviction too (never force-removed)", async () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "wtsize-"));
    const wtRoot = path.join(base, "worktrees");
    process.env["IDE_CODE_WORKTREES_ROOT"] = wtRoot;
    const repoRoot = path.join(base, "repo");
    initRepo(repoRoot);
    __setConfig("ide", "worktreeMaxCount", 25);
    try {
      const d1 = await createSizedWorktree(repoRoot, "prot-b1", 4000);
      await sleep(30);
      const d2 = await createSizedWorktree(repoRoot, "prot-b2", 4000);
      await sleep(30);
      // Make the OLDEST dirty (uncommitted changes) — it must be deferred,
      // so the next-oldest clean worktree is evicted instead.
      fs.writeFileSync(path.join(d1, "uncommitted.txt"), "work in progress");
      const total = directorySizeBytes(d1) + directorySizeBytes(d2);
      __setConfig("ide", "worktreesGlobalMaxSizeGb", 1 / GIB); // ~1 byte: force eviction pressure
      assert.ok(total > 1, "sanity: total exceeds the 1-byte limit");
      const res = await svc.enforceWorktreesGlobalMaxSize();
      assert.ok(fs.existsSync(d1), "dirty oldest worktree must be deferred (kept)");
      assert.ok(res.deferred.includes(d1), `dirty worktree must be in deferred, got ${res.deferred}`);
      assert.ok(!fs.existsSync(d2), "next-oldest clean worktree evicted instead");
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
  });

  it("create() runs the combined pass: size eviction fires after create, just-created kept", async () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "wtsize-"));
    const wtRoot = path.join(base, "worktrees");
    process.env["IDE_CODE_WORKTREES_ROOT"] = wtRoot;
    const repoRoot = path.join(base, "repo");
    initRepo(repoRoot);
    __setConfig("ide", "worktreeMaxCount", 25);
    try {
      const d1 = await createSizedWorktree(repoRoot, "combo-b1", 4000);
      await sleep(30);
      // Limit below one worktree's size: after the next create, the oldest
      // (d1) must go, the just-created one must stay.
      __setConfig("ide", "worktreesGlobalMaxSizeGb", (directorySizeBytes(d1) - 1) / GIB);
      const d2 = await createSizedWorktree(repoRoot, "combo-b2", 4000);
      assert.ok(!fs.existsSync(d1), "oldest evicted by the post-create size pass");
      assert.ok(fs.existsSync(d2), "just-created worktree is never an eviction candidate");
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
  });

  it("runWorktreeCleanupPass() enforces count first, then size (combined)", async () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "wtsize-"));
    const wtRoot = path.join(base, "worktrees");
    process.env["IDE_CODE_WORKTREES_ROOT"] = wtRoot;
    const repoRoot = path.join(base, "repo");
    initRepo(repoRoot);
    __setConfig("ide", "worktreeMaxCount", 2);
    __setConfig("ide", "worktreesGlobalMaxSizeGb", 50); // size cap out of the way
    try {
      const d1 = await createSizedWorktree(repoRoot, "pass-b1", 500);
      await sleep(30);
      const d2 = await createSizedWorktree(repoRoot, "pass-b2", 500);
      await sleep(30);
      // create() already enforces; force a third dir past the cap manually.
      const d3dir = svc.resolveWorktreePath(repoRoot, "pass-b3");
      git(repoRoot, ["worktree", "add", d3dir, "-b", "pass-b3"]);
      const res = await svc.runWorktreeCleanupPass();
      assert.ok(res.removed.includes(d1), `count pass must evict oldest, removed=${res.removed}`);
      assert.ok(fs.existsSync(d2) && fs.existsSync(d3dir));
      assert.strictEqual(res.sizeLimitEnabled, true);
      assert.ok(res.totalSizeBytes > 0, "totalSizeBytes reported when enabled");
      assert.deepStrictEqual(res.sizeRemoved, []);
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
  });
});

describe("WorktreeCleanupScheduler", () => {
  beforeEach(() => {
    __clearConfig();
  });

  afterEach(() => {
    __clearConfig();
    delete process.env["IDE_CODE_WORKTREES_ROOT"];
  });

  it("interval is 6h by default and follows the setting", () => {
    class Probe extends WorktreeCleanupScheduler {
      public probeMs(): number {
        return this.cleanupIntervalMs();
      }
      protected override cleanupIntervalMs(): number {
        return super.cleanupIntervalMs();
      }
    }
    const s = new Probe();
    try {
      assert.strictEqual(s.probeMs(), 6 * 60 * 60 * 1000);
      __setConfig("ide", "worktreeCleanupIntervalHours", 2);
      assert.strictEqual(s.probeMs(), 2 * 60 * 60 * 1000);
    } finally {
      s.dispose();
    }
  });

  it("runs the combined cleanup pass on the timer and stops after dispose()", async () => {
    let passCalls = 0;
    class FakeService extends WorktreeService {
      override async runWorktreeCleanupPass(_keepDir?: string): Promise<WorktreeCleanupResult> {
        passCalls++;
        return {
          removed: [],
          deferred: [],
          sizeRemoved: [],
          sizeDeferred: [],
          sizeLimitEnabled: true,
          totalSizeBytes: 0,
        };
      }
    }
    class FastScheduler extends WorktreeCleanupScheduler {
      protected override cleanupIntervalMs(): number {
        return 20;
      }
    }
    const s = new FastScheduler(new FakeService());
    try {
      await sleep(120);
      assert.ok(passCalls >= 2, `expected repeated passes, got ${passCalls}`);
      const before = passCalls;
      s.dispose();
      await sleep(80);
      assert.strictEqual(passCalls, before, "no passes after dispose()");
    } finally {
      s.dispose();
    }
  });

  it("runOnce() performs a real combined pass and never throws on an empty root", async () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "wtsched-"));
    process.env["IDE_CODE_WORKTREES_ROOT"] = path.join(base, "worktrees");
    const s = new WorktreeCleanupScheduler();
    try {
      const res = await s.runOnce();
      assert.deepStrictEqual(res.removed, []);
      assert.deepStrictEqual(res.deferred, []);
      assert.strictEqual(res.sizeLimitEnabled, true);
    } finally {
      s.dispose();
      fs.rmSync(base, { recursive: true, force: true });
    }
  });
});
