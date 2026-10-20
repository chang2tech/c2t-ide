/**
 * Unit tests for the Cursor-parity worktree location
 * (DEV-GAPS-10, audit finding `multitask-worktree-location`, QA-3 2026-10-19).
 *
 * Managed worktrees live HOME-RELATIVE under `~/.ide-code/worktrees`
 * (Cursor evidence: cursor-agent-host "…Cursor-managed worktrees in
 * ~/.cursor/worktrees"; binary 3.25.9 `worktrees.ts` `fLo=".cursor/worktrees"`).
 * Legacy sibling `<repo>-worktrees/<slug>` locations must be handled
 * gracefully: detected, warning logged, never auto-migrated, no crash.
 *
 * node:test, zero extra deps. The `vscode` module is stubbed via
 * ./vscode-stub (imported FIRST). No git is spawned — `resolveWorktreePath`
 * only checks directory existence via fs.existsSync in a throwaway /tmp dir.
 *
 * Run after `tsc`:  node --test out/services/test/run-worktree-service-tests.js
 */
import "./vscode-stub";
import { describe, it } from "node:test";
import * as assert from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  IDE_CODE_HOME_DIR,
  WorktreeService,
  legacyWorktreePath,
  managedWorktreesRoot,
  slugifyWorktreeBranch,
} from "../worktreeService";

const svc = new WorktreeService();

describe("worktree location (Cursor parity: ~/.ide-code/worktrees)", () => {
  it("managedWorktreesRoot is home-relative .ide-code/worktrees", () => {
    assert.strictEqual(managedWorktreesRoot(), path.join(os.homedir(), ".ide-code", "worktrees"));
    assert.strictEqual(IDE_CODE_HOME_DIR, ".ide-code");
  });

  it("defaultWorktreePath is ~/.ide-code/worktrees/<repo>/<slug>", () => {
    const repoRoot = path.join(os.homedir(), "projects", "my-repo");
    const p = svc.defaultWorktreePath(repoRoot, "feature/login");
    assert.strictEqual(p, path.join(os.homedir(), ".ide-code", "worktrees", "my-repo", "feature-login"));
    // Same repo name in different parent dirs still collides-safe? No — but
    // path must at least be absolute and home-relative (not a sibling).
    assert.ok(path.isAbsolute(p));
    assert.ok(p.startsWith(os.homedir() + path.sep));
    assert.ok(!p.includes("my-repo-worktrees"), "must NOT use the legacy sibling layout");
  });

  it("slugifyWorktreeBranch is filesystem-safe", () => {
    assert.strictEqual(slugifyWorktreeBranch("feature/login"), "feature-login");
    assert.strictEqual(slugifyWorktreeBranch("fix: bug & stuff!"), "fix__bug___stuff_");
    assert.ok(/^[a-zA-Z0-9._-]+$/.test(slugifyWorktreeBranch("a/b:c d")));
  });

  it("legacyWorktreePath is the old sibling <repo>-worktrees/<slug>", () => {
    assert.strictEqual(
      legacyWorktreePath("/home/u/projects/my-repo", "feature/login"),
      path.join("/home/u/projects", "my-repo-worktrees", "feature-login"),
    );
  });

  it("resolveWorktreePath → new location when no legacy dir exists", () => {
    const repoRoot = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "wt-")), "repo");
    assert.strictEqual(svc.resolveWorktreePath(repoRoot, "feature/x"), svc.defaultWorktreePath(repoRoot, "feature/x"));
  });

  it("resolveWorktreePath → legacy location (with warning) when legacy dir exists", () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "wt-"));
    const repoRoot = path.join(base, "repo");
    const legacy = legacyWorktreePath(repoRoot, "feature/x");
    fs.mkdirSync(legacy, { recursive: true });

    const warnings: string[] = [];
    const origWarn = console.warn;
    console.warn = (msg: string) => warnings.push(msg);
    try {
      const resolved = svc.resolveWorktreePath(repoRoot, "feature/x");
      assert.strictEqual(resolved, legacy, "legacy worktree must be kept in use, not migrated");
    } finally {
      console.warn = origWarn;
    }
    assert.ok(warnings.length > 0, "a deprecation warning must be logged");
    assert.ok(warnings[0].includes("legacy"), `warning mentions legacy: ${warnings[0]}`);
    assert.ok(warnings[0].includes("NOT auto-migrated"), `warning states no auto-migration: ${warnings[0]}`);
    // Graceful: legacy dir is untouched (not moved, not deleted).
    assert.ok(fs.existsSync(legacy), "legacy dir must not be deleted or moved");
  });
});
