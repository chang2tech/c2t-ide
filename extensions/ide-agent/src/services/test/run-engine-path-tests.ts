/**
 * enginePath resolver tests (node:test, vscode stubbed).
 *
 * Pins the D2 resolution contract of services/enginePath.ts
 * (spec engine-packaging-spec-v1 §5):
 *   setting > bundled (serve entry must exist) > dev fallback, where the
 *   dev fallback is allowed ONLY when no bundled directory exists on
 *   disk — a bundled dir without its entry is "bundled incomplete"
 *   (source "none"), never a silent fall-through to the dev checkout.
 * Also pins bunPath resolution (bundled bin/bun > PATH) and the
 * BRANCH-B spawn-cwd rule (bundled → <globalStorage>/engine-runtime).
 *
 * Run after `tsc`:  node out/services/test/run-engine-path-tests.js
 * (auto-discovered by scripts/run-all-tests.js)
 */
import { describe, it } from "node:test";
import * as assert from "node:assert";
import * as path from "path";
import "./vscode-stub";
import {
  BUNDLED_BUN_RELATIVE,
  ENGINE_CLI_ENTRY_REL,
  bundledEnginePath,
  bundledIncompleteDiagnostic,
  defaultEnginePath,
  resolveBunPath,
  resolveEngineCwd,
  resolveEnginePath,
} from "../enginePath";

const APP_ROOT = path.join(path.sep, "fake", "resources", "app");
const BUNDLED = bundledEnginePath(APP_ROOT);
const BUNDLED_ENTRY = path.join(BUNDLED, ENGINE_CLI_ENTRY_REL);
const BUNDLED_BUN = path.join(BUNDLED, BUNDLED_BUN_RELATIVE);

function existsSet(...paths: string[]): (p: string) => boolean {
  const set = new Set(paths);
  return (p) => set.has(p);
}

describe("resolveEnginePath (D2)", () => {
  it("setting wins over a present bundled engine", () => {
    const resolved = resolveEnginePath("/custom/engine", {
      appRoot: APP_ROOT,
      exists: existsSet(BUNDLED, BUNDLED_ENTRY),
    });
    assert.strictEqual(resolved.source, "setting");
    assert.strictEqual(resolved.enginePath, "/custom/engine");
  });

  it("bundled engine with serve entry resolves as bundled", () => {
    const resolved = resolveEnginePath("", {
      appRoot: APP_ROOT,
      exists: existsSet(BUNDLED, BUNDLED_ENTRY),
    });
    assert.strictEqual(resolved.source, "bundled");
    assert.strictEqual(resolved.enginePath, BUNDLED);
  });

  it("bundled dir without entry is bundled-incomplete — NO dev fall-through", () => {
    const resolved = resolveEnginePath("", {
      appRoot: APP_ROOT,
      exists: existsSet(BUNDLED),
    });
    assert.strictEqual(resolved.source, "none");
    assert.strictEqual(resolved.enginePath, "");
    assert.strictEqual(resolved.bundledBroken, BUNDLED);
    assert.match(bundledIncompleteDiagnostic(BUNDLED), /Bundled engine is incomplete/);
  });

  it("no bundled dir on disk falls back to the dev checkout", () => {
    const resolved = resolveEnginePath("", {
      appRoot: APP_ROOT,
      exists: existsSet(),
    });
    assert.strictEqual(resolved.source, "dev");
    assert.strictEqual(resolved.enginePath, defaultEnginePath());
  });

  it("empty appRoot (web / stub env) falls back to dev", () => {
    const resolved = resolveEnginePath("", { appRoot: "", exists: existsSet() });
    assert.strictEqual(resolved.source, "dev");
  });

  it("whitespace-only setting is treated as unset", () => {
    const resolved = resolveEnginePath("   ", {
      appRoot: APP_ROOT,
      exists: existsSet(BUNDLED, BUNDLED_ENTRY),
    });
    assert.strictEqual(resolved.source, "bundled");
  });
});

describe("resolveBunPath", () => {
  it("bundled engine prefers its own bin/bun", () => {
    const resolved = { enginePath: BUNDLED, source: "bundled" as const };
    assert.strictEqual(resolveBunPath(resolved, existsSet(BUNDLED_BUN)), BUNDLED_BUN);
  });

  it("bundled engine without bin/bun falls back to PATH and reports it", () => {
    const resolved = { enginePath: BUNDLED, source: "bundled" as const };
    let reported: string | undefined;
    const bun = resolveBunPath(resolved, existsSet(), (c) => (reported = c));
    assert.strictEqual(bun, "bun");
    assert.strictEqual(reported, BUNDLED_BUN);
  });

  it("dev checkout carrying its own bun uses it; otherwise PATH", () => {
    const dev = defaultEnginePath();
    const resolved = { enginePath: dev, source: "dev" as const };
    const ownBun = path.join(dev, BUNDLED_BUN_RELATIVE);
    assert.strictEqual(resolveBunPath(resolved, existsSet(ownBun)), ownBun);
    assert.strictEqual(resolveBunPath(resolved, existsSet()), "bun");
  });
});

describe("resolveEngineCwd (BRANCH B)", () => {
  it("bundled engine spawns from <globalStorage>/engine-runtime", () => {
    const resolved = { enginePath: BUNDLED, source: "bundled" as const };
    assert.strictEqual(
      resolveEngineCwd(resolved, path.join(path.sep, "ud", "globalStorage")),
      path.join(path.sep, "ud", "globalStorage", "engine-runtime"),
    );
  });

  it("dev/setting engines keep cwd = enginePath (undefined override)", () => {
    assert.strictEqual(
      resolveEngineCwd({ enginePath: "/x", source: "dev" }, "/ud/globalStorage"),
      undefined,
    );
    assert.strictEqual(
      resolveEngineCwd({ enginePath: "/x", source: "setting" }, "/ud/globalStorage"),
      undefined,
    );
  });
});
