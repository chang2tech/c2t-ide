/**
 * globalIgnore tests (node:test, zero extra deps).
 *
 * Covers ext-global-ignore (P1) in the legacy extension path:
 *  - the config key is the evidenced `ide.general.globalCursorIgnoreList`
 *    mirror (regression guard — DEV-GAPS-14 briefly read a fabricated
 *    `ide.indexing.globalIgnore` key; that key must not come back),
 *  - pattern matching semantics (matchBase globs, `**`, blank skipping),
 *  - `filterGloballyIgnored` dropping retrieval hits,
 *  - `readGlobalIgnorePatterns` reading the live setting (via a `vscode`
 *    stub — the real module is host-provided and unavailable under plain
 *    node), including non-string filtering and throw-safety.
 *
 * Run after `tsc`:  node out/services/globalIgnore.test.js
 */
import { describe, it } from "node:test";
import * as assert from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// --- `vscode` stub: the SUT imports `vscode` at module top for
// `readGlobalIgnorePatterns`. Redirect the bare specifier to a temp stub
// whose getConfiguration implementation the tests control. ---
const stubDir = fs.mkdtempSync(path.join(os.tmpdir(), "globalIgnore-vscode-stub-"));
const stubPath = path.join(stubDir, "vscode-stub.cjs");
fs.writeFileSync(
  stubPath,
  [
    "let getImpl = (_section) => ({ get: (_key, dflt) => dflt });",
    "module.exports = {",
    "  workspace: { getConfiguration: (section) => getImpl(section) },",
    "  __setGetConfiguration: (fn) => { getImpl = fn; },",
    "};",
    "",
  ].join("\n"),
);
// eslint-disable-next-line @typescript-eslint/no-require-imports
const Module = require("module") as unknown as {
  _resolveFilename(request: string, ...args: unknown[]): string;
};
const origResolve = Module._resolveFilename.bind(Module);
Module._resolveFilename = (request: string, ...args: unknown[]) =>
  request === "vscode" ? stubPath : origResolve(request, ...args);

import {
  GLOBAL_IGNORE_CONFIG_KEY,
  GLOBAL_IGNORE_CONFIG_SECTION,
  filterGloballyIgnored,
  isIgnoredByGlobalPatterns,
  readGlobalIgnorePatterns,
  toWorkspaceRelative,
} from "./globalIgnore";

const stub = require(stubPath) as {
  __setGetConfiguration: (
    fn: (section: string) => { get: (key: string, dflt: unknown) => unknown },
  ) => void;
};

describe("globalIgnore config key", () => {
  it("reads the evidenced mirror key, not the fabricated one", () => {
    assert.strictEqual(GLOBAL_IGNORE_CONFIG_SECTION, "ide.general");
    assert.strictEqual(GLOBAL_IGNORE_CONFIG_KEY, "globalCursorIgnoreList");
  });

  it("readGlobalIgnorePatterns returns the configured patterns", () => {
    stub.__setGetConfiguration((section) => ({
      get: (key: string, dflt: unknown) =>
        section === "ide.general" && key === "globalCursorIgnoreList" ? ["*.secret", "vendor/**"] : dflt,
    }));
    assert.deepStrictEqual(readGlobalIgnorePatterns(), ["*.secret", "vendor/**"]);
  });

  it("readGlobalIgnorePatterns filters non-strings and survives throws", () => {
    stub.__setGetConfiguration(() => ({
      get: () => ["ok.ts", 42, null, { x: 1 }] as unknown,
    }));
    assert.deepStrictEqual(readGlobalIgnorePatterns(), ["ok.ts"]);
    stub.__setGetConfiguration(() => {
      throw new Error("host unavailable");
    });
    assert.deepStrictEqual(readGlobalIgnorePatterns(), []);
  });
});

describe("isIgnoredByGlobalPatterns", () => {
  it("matches basenames at any depth (matchBase)", () => {
    assert.strictEqual(isIgnoredByGlobalPatterns("sub/dir/key.secret", ["*.secret"]), true);
    assert.strictEqual(isIgnoredByGlobalPatterns("key.secret", ["*.secret"]), true);
    assert.strictEqual(isIgnoredByGlobalPatterns("sub/key.txt", ["*.secret"]), false);
  });

  it("supports ** directory globs", () => {
    assert.strictEqual(isIgnoredByGlobalPatterns("vendor/lib/a.ts", ["vendor/**"]), true);
    assert.strictEqual(isIgnoredByGlobalPatterns("src/vendor/a.ts", ["vendor/**"]), false);
    assert.strictEqual(isIgnoredByGlobalPatterns("a/b/build.log", ["**/build.log"]), true);
  });

  it("ignores blank patterns and returns false when empty", () => {
    assert.strictEqual(isIgnoredByGlobalPatterns("a.ts", []), false);
    assert.strictEqual(isIgnoredByGlobalPatterns("a.ts", ["", "   "]), false);
  });
});

describe("toWorkspaceRelative", () => {
  it("relativizes absolute paths and normalizes separators", () => {
    const root = path.resolve("ws-test-root");
    assert.strictEqual(
      toWorkspaceRelative(root, path.join(root, "sub", "a.ts")),
      "sub/a.ts",
    );
    assert.strictEqual(toWorkspaceRelative(root, "already/rel.ts"), "already/rel.ts");
  });
});

describe("filterGloballyIgnored", () => {
  const root = path.resolve("ws-test-root");
  const hits = [
    { path: "src/keep.ts" },
    { path: "vendor/lib.ts" },
    { path: "sub/key.secret" },
  ];

  it("drops hits matching the patterns", () => {
    const kept = filterGloballyIgnored(root, hits, (h) => h.path, ["*.secret", "vendor/**"]);
    assert.deepStrictEqual(
      kept.map((h) => h.path),
      ["src/keep.ts"],
    );
  });

  it("returns a copy untouched when no patterns are configured", () => {
    const kept = filterGloballyIgnored(root, hits, (h) => h.path, []);
    assert.deepStrictEqual(
      kept.map((h) => h.path),
      ["src/keep.ts", "vendor/lib.ts", "sub/key.secret"],
    );
    assert.notStrictEqual(kept, hits);
  });

  it("normalizes absolute hit paths against the workspace root", () => {
    const abs = [{ path: path.join(root, "vendor", "lib.ts") }, { path: path.join(root, "src", "keep.ts") }];
    const kept = filterGloballyIgnored(root, abs, (h) => h.path, ["vendor/**"]);
    assert.deepStrictEqual(
      kept.map((h) => h.path),
      [path.join(root, "src", "keep.ts")],
    );
  });
});
