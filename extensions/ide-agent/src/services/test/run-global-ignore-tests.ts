/**
 * Unit tests for DEV-GAPS-14 `ext-global-ignore`.
 *
 * Evidence (Cursor, DIG-AST-EXT 2026-10-19): "Global ignore list setting
 * applied to Cursor indexing/retrieval, separate from .cursorignore".
 *
 * Assertions:
 *  - glob `*.secret` excludes `notes.secret` (and `sub/dir/a.secret`,
 *    gitignore-style matchBase) from indexing candidates, while `notes.txt`
 *    survives;
 *  - double-star `dist` patterns work; empty pattern lists are a zero-cost
 *    no-op;
 *  - `filterGloballyIgnored` handles absolute and workspace-relative paths;
 *  - `readGlobalIgnorePatterns` falls back to [] when config is unavailable.
 *
 * node:test, zero extra deps. The `vscode` module is stubbed via
 * ./vscode-stub (imported FIRST): its getConfiguration always returns the
 * default, so config-dependent paths are exercised through the pure,
 * pattern-taking core.
 *
 * Run after `tsc`:  node --test out/services/test/run-global-ignore-tests.js
 */
import "./vscode-stub";
import { describe, it } from "node:test";
import * as assert from "node:assert";
import * as path from "node:path";
import {
  GLOBAL_IGNORE_CONFIG_KEY,
  GLOBAL_IGNORE_CONFIG_SECTION,
  filterGloballyIgnored,
  isIgnoredByGlobalPatterns,
  readGlobalIgnorePatterns,
  toWorkspaceRelative,
} from "../globalIgnore";

const ROOT = path.sep === "\\" ? "C:\\ws\\proj" : "/ws/proj";

describe("isIgnoredByGlobalPatterns", () => {
  it("*.secret excludes a top-level .secret file", () => {
    assert.strictEqual(isIgnoredByGlobalPatterns("notes.secret", ["*.secret"]), true);
  });

  it("*.secret excludes a nested .secret file (gitignore matchBase)", () => {
    assert.strictEqual(isIgnoredByGlobalPatterns("sub/dir/a.secret", ["*.secret"]), true);
  });

  it("*.secret keeps a non-matching file", () => {
    assert.strictEqual(isIgnoredByGlobalPatterns("notes.txt", ["*.secret"]), false);
  });

  it("**/dist/** excludes everything under dist", () => {
    assert.strictEqual(isIgnoredByGlobalPatterns("dist/bundle.js", ["**/dist/**"]), true);
    assert.strictEqual(isIgnoredByGlobalPatterns("src/index.ts", ["**/dist/**"]), false);
  });

  it("empty patterns never ignore", () => {
    assert.strictEqual(isIgnoredByGlobalPatterns("anything.secret", []), false);
  });

  it("blank patterns are skipped", () => {
    assert.strictEqual(isIgnoredByGlobalPatterns("notes.txt", ["", "   "]), false);
  });
});

describe("toWorkspaceRelative", () => {
  it("keeps workspace-relative paths as-is", () => {
    assert.strictEqual(toWorkspaceRelative(ROOT, "src/a.ts"), "src/a.ts");
  });

  it("relativizes absolute paths against the root", () => {
    const abs = path.join(ROOT, "src", "a.ts");
    assert.strictEqual(toWorkspaceRelative(ROOT, abs), "src/a.ts");
  });
});

describe("filterGloballyIgnored", () => {
  const items = [
    { path: "notes.secret" },
    { path: "sub/dir/a.secret" },
    { path: "notes.txt" },
    { path: "src/index.ts" },
  ];

  it("*.secret removes secret files from indexing candidates", () => {
    const out = filterGloballyIgnored(ROOT, items, (i) => i.path, ["*.secret"]);
    assert.deepStrictEqual(
      out.map((i) => i.path),
      ["notes.txt", "src/index.ts"],
    );
  });

  it("no patterns → zero-cost passthrough (same items)", () => {
    const out = filterGloballyIgnored(ROOT, items, (i) => i.path, []);
    assert.deepStrictEqual(out, items);
  });

  it("handles absolute hit paths", () => {
    const absItems = [{ path: path.join(ROOT, "notes.secret") }, { path: path.join(ROOT, "ok.ts") }];
    const out = filterGloballyIgnored(ROOT, absItems, (i) => i.path, ["*.secret"]);
    assert.deepStrictEqual(out.map((i) => i.path), [path.join(ROOT, "ok.ts")]);
  });
});

describe("config surface", () => {
  it("setting section/key are the documented ones", () => {
    // WORKER-GAPS-22E (2026-10-20): the old `ide.indexing.globalIgnore` key
    // was fabricated (DEV-GAPS-14). REA evidence (DIG-AST-EXT 2026-10-19, AST
    // extraction of the cursor-agent-host bundle) identifies Cursor's real
    // setting as `cursor.general.globalCursorIgnoreList` — "Global ignore
    // list setting applied to Cursor indexing/retrieval, separate from
    // .cursorignore" — so the fork reads `ide.general.globalCursorIgnoreList`.
    assert.strictEqual(GLOBAL_IGNORE_CONFIG_SECTION, "ide.general");
    assert.strictEqual(GLOBAL_IGNORE_CONFIG_KEY, "globalCursorIgnoreList");
  });

  it("readGlobalIgnorePatterns falls back to [] under the stub", () => {
    assert.deepStrictEqual(readGlobalIgnorePatterns(), []);
  });
});
