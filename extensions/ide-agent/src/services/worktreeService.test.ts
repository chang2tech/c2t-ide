/**
 * worktreeService tests (node:test, zero extra deps).
 *
 * Covers the P3 `multitask-worktree-location` fix (Cursor 3.25.9 parity).
 * Binary evidence: Cursor 3.25.9 `worktrees.ts` has `fLo = ".cursor/worktrees"`,
 * and cursor-agent-host says verbatim: "This applies especially to
 * Cursor-managed worktrees in ~/.cursor/worktrees." — i.e. Cursor keeps its
 * agent worktrees HOME-RELATIVE under ~/.cursor/worktrees. Our brand-mirrored
 * location is `~/.ide-code/worktrees/<repo-name>/<slug>`.
 *
 * Runtime assertions (the "vscode" module is stubbed — the service only
 * touches vscode in getRepoRoot/openWorktreeInWindow, never in the path
 * helpers under test):
 *  - managedWorktreesRoot() is home-relative and exactly ~/.ide-code/worktrees
 *  - defaultWorktreePath() nests <repo-name>/<slug> under that root
 *  - resolveWorktreePath() uses the home-relative default for new worktrees
 *  - resolveWorktreePath() keeps using an existing legacy sibling
 *    <repo>-worktrees/<slug> gracefully (warning logged, never auto-migrated)
 *
 * Run after `tsc`:  node out/services/worktreeService.test.js
 */
import { describe, it } from "node:test";
import * as assert from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/* The ide-agent sources import the "vscode" module, which does not exist
   outside the extension host. Stub it at the require level before loading
   the service — the path helpers never touch it at runtime. */
const Module = require("module") as { _load: (...args: unknown[]) => unknown };
const origLoad = (Module._load as (...args: unknown[]) => unknown).bind(Module);
(Module as unknown as { _load: (...args: unknown[]) => unknown })._load = function (
  request: unknown,
  ...rest: unknown[]
) {
  if (request === "vscode") {
    return {};
  }
  return origLoad(request, ...rest);
};

// eslint-disable-next-line @typescript-eslint/no-var-requires
const {
  IDE_CODE_HOME_DIR,
  WorktreeService,
  legacyWorktreePath,
  managedWorktreesRoot,
} = require("./worktreeService") as typeof import("./worktreeService");

describe("worktree location (Cursor parity: ~/.cursor/worktrees)", () => {
  it("IDE_CODE_HOME_DIR is the brand-mirrored .ide-code", () => {
    assert.strictEqual(IDE_CODE_HOME_DIR, ".ide-code");
  });

  it("managedWorktreesRoot() is home-relative: ~/.ide-code/worktrees", () => {
    const root = managedWorktreesRoot();
    assert.strictEqual(root, path.join(os.homedir(), ".ide-code", "worktrees"));
    // Home-relative, never repo-relative or cwd-relative.
    assert.ok(root.startsWith(os.homedir() + path.sep), `expected under home, got ${root}`);
    assert.ok(!root.includes(path.join("..", "..")), `must not be relative: ${root}`);
  });

  it("defaultWorktreePath() nests <repo-name>/<slug> under the home-relative root", () => {
    const svc = new WorktreeService();
    const repoRoot = path.join(os.tmpdir(), "ide-code-wt-repo");
    const got = svc.defaultWorktreePath(repoRoot, "feature/my-branch");
    assert.strictEqual(
      got,
      path.join(os.homedir(), ".ide-code", "worktrees", "ide-code-wt-repo", "feature-my-branch"),
    );
  });

  it("resolveWorktreePath() uses the home-relative default when no legacy worktree exists", () => {
    const svc = new WorktreeService();
    const repoRoot = path.join(os.tmpdir(), `ide-code-wt-new-${Date.now()}`);
    fs.mkdirSync(repoRoot, { recursive: true });
    try {
      assert.strictEqual(
        svc.resolveWorktreePath(repoRoot, "feature/new-work"),
        path.join(
          os.homedir(),
          ".ide-code",
          "worktrees",
          path.basename(repoRoot),
          "feature-new-work",
        ),
      );
    } finally {
      fs.rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it("resolveWorktreePath() keeps an existing legacy sibling <repo>-worktrees/<slug> in use", () => {
    const svc = new WorktreeService();
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "ide-code-wt-legacy-"));
    const repoRoot = path.join(base, "myrepo");
    const legacy = legacyWorktreePath(repoRoot, "feature/old-work");
    fs.mkdirSync(legacy, { recursive: true });
    try {
      // Graceful: legacy location detected and kept in use, never auto-migrated.
      assert.strictEqual(svc.resolveWorktreePath(repoRoot, "feature/old-work"), legacy);
      assert.ok(
        legacy.startsWith(path.join(base, "myrepo-worktrees")),
        `legacy must be a sibling dir, got ${legacy}`,
      );
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
  });

  it("legacyWorktreePath() is sibling-based and differs from the new home-relative default", () => {
    const svc = new WorktreeService();
    const repoRoot = path.join(os.tmpdir(), "ide-code-wt-repo");
    const legacy = legacyWorktreePath(repoRoot, "feature/x");
    const fresh = svc.defaultWorktreePath(repoRoot, "feature/x");
    assert.notStrictEqual(legacy, fresh);
    assert.ok(!legacy.startsWith(os.homedir()), `legacy must not be home-relative: ${legacy}`);
    assert.ok(fresh.startsWith(os.homedir()), `default must be home-relative: ${fresh}`);
  });
});
