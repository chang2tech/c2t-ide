/**
 * enginePath resolver tests (node:test, vscode stubbed).
 *
 * Pins the D2 resolution contract of services/enginePath.ts
 * (spec engine-packaging-spec-v1 §5 + the alpha.40 compile-path (B)
 * binary branch):
 *   setting > bundled (binary OR tree layout, detected on disk) > dev
 *   fallback, where the dev fallback is allowed ONLY when no bundled
 *   directory exists on disk — a bundled dir with neither layout marker
 *   is "bundled incomplete" (source "none"), never a silent fall-through
 *   to the dev checkout.
 * Also pins bunPath resolution (bundled bin/bun > PATH, tree only) and
 * the BRANCH-B spawn-cwd rule (bundled → <globalStorage>/engine-runtime,
 * both layouts).
 *
 * Run after `tsc`:  node --test out/services/test/run-engine-path-tests.js
 * (auto-discovered by scripts/run-all-tests.js)
 */
import { describe, it } from "node:test";
import * as assert from "node:assert";
import * as path from "path";
import "./vscode-stub";
import {
  BUNDLED_BINARY_FILE,
  BUNDLED_BUN_RELATIVE,
  ENGINE_CLI_ENTRY_REL,
  bundledBinaryPath,
  bundledEnginePath,
  bundledIncompleteDiagnostic,
  defaultEnginePath,
  detectEngineLayout,
  resolveBunPath,
  resolveEngineCwd,
  resolveEnginePath,
} from "../enginePath";

const APP_ROOT = path.join(path.sep, "fake", "resources", "app");
const BUNDLED = bundledEnginePath(APP_ROOT);
const BUNDLED_ENTRY = path.join(BUNDLED, ENGINE_CLI_ENTRY_REL);
const BUNDLED_BINARY = bundledBinaryPath(BUNDLED);
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

  it("bundled TREE engine with serve entry resolves as bundled/tree", () => {
    const resolved = resolveEnginePath("", {
      appRoot: APP_ROOT,
      exists: existsSet(BUNDLED, BUNDLED_ENTRY),
    });
    assert.strictEqual(resolved.source, "bundled");
    assert.strictEqual(resolved.layout, "tree");
    assert.strictEqual(resolved.enginePath, BUNDLED);
  });

  it("bundled BINARY engine (compile path B) resolves as bundled/binary", () => {
    const resolved = resolveEnginePath("", {
      appRoot: APP_ROOT,
      exists: existsSet(BUNDLED, BUNDLED_BINARY),
    });
    assert.strictEqual(resolved.source, "bundled");
    assert.strictEqual(resolved.layout, "binary");
    assert.strictEqual(resolved.enginePath, BUNDLED);
  });

  it("binary marker wins when BOTH layouts are present on disk", () => {
    const resolved = resolveEnginePath("", {
      appRoot: APP_ROOT,
      exists: existsSet(BUNDLED, BUNDLED_BINARY, BUNDLED_ENTRY),
    });
    assert.strictEqual(resolved.layout, "binary");
  });

  it("bundled dir without any marker is bundled-incomplete — NO dev fall-through", () => {
    const resolved = resolveEnginePath("", {
      appRoot: APP_ROOT,
      exists: existsSet(BUNDLED),
    });
    assert.strictEqual(resolved.source, "none");
    assert.strictEqual(resolved.enginePath, "");
    assert.strictEqual(resolved.bundledBroken, BUNDLED);
    assert.match(bundledIncompleteDiagnostic(BUNDLED), /Bundled engine is incomplete/);
  });

  it("no bundled dir on disk falls back to the dev checkout (tree)", () => {
    const resolved = resolveEnginePath("", {
      appRoot: APP_ROOT,
      exists: existsSet(),
    });
    assert.strictEqual(resolved.source, "dev");
    assert.strictEqual(resolved.layout, "tree");
    assert.strictEqual(resolved.enginePath, defaultEnginePath());
  });

  it("empty appRoot (web / stub env) falls back to dev", () => {
    const resolved = resolveEnginePath("", { appRoot: "", exists: existsSet() });
    assert.strictEqual(resolved.source, "dev");
  });

  it("whitespace-only setting is treated as unset", () => {
    const resolved = resolveEnginePath("   ", {
      appRoot: APP_ROOT,
      exists: existsSet(BUNDLED, BUNDLED_BINARY),
    });
    assert.strictEqual(resolved.source, "bundled");
    assert.strictEqual(resolved.layout, "binary");
  });

  it("setting pointing at a binary-layout root reports layout binary", () => {
    const custom = path.join(path.sep, "custom", "engine");
    const resolved = resolveEnginePath(custom, {
      appRoot: APP_ROOT,
      exists: existsSet(path.join(custom, BUNDLED_BINARY_FILE)),
    });
    assert.strictEqual(resolved.source, "setting");
    assert.strictEqual(resolved.layout, "binary");
  });

  it("setting pointing at a marker-less root keeps the legacy tree layout (adapter throws Invalid enginePath)", () => {
    const resolved = resolveEnginePath("/bogus/engine", {
      appRoot: APP_ROOT,
      exists: existsSet(),
    });
    assert.strictEqual(resolved.source, "setting");
    assert.strictEqual(resolved.layout, "tree");
  });
});

describe("detectEngineLayout", () => {
  it("binary file only → binary; entry only → tree; neither → undefined", () => {
    assert.strictEqual(detectEngineLayout(BUNDLED, existsSet(BUNDLED_BINARY)), "binary");
    assert.strictEqual(detectEngineLayout(BUNDLED, existsSet(BUNDLED_ENTRY)), "tree");
    assert.strictEqual(detectEngineLayout(BUNDLED, existsSet()), undefined);
    assert.strictEqual(detectEngineLayout("", existsSet(BUNDLED_BINARY)), undefined);
  });
});

describe("resolveBunPath", () => {
  it("bundled tree engine prefers its own bin/bun", () => {
    const resolved = { enginePath: BUNDLED, source: "bundled" as const, layout: "tree" as const };
    assert.strictEqual(resolveBunPath(resolved, existsSet(BUNDLED_BUN)), BUNDLED_BUN);
  });

  it("bundled tree engine without bin/bun falls back to PATH and reports it", () => {
    const resolved = { enginePath: BUNDLED, source: "bundled" as const, layout: "tree" as const };
    let reported: string | undefined;
    const bun = resolveBunPath(resolved, existsSet(), (c) => (reported = c));
    assert.strictEqual(bun, "bun");
    assert.strictEqual(reported, BUNDLED_BUN);
  });

  it("bundled BINARY engine without bin/bun does NOT report a missing bun (bun is never spawned)", () => {
    const resolved = { enginePath: BUNDLED, source: "bundled" as const, layout: "binary" as const };
    let reported: string | undefined;
    const bun = resolveBunPath(resolved, existsSet(), (c) => (reported = c));
    assert.strictEqual(bun, "bun");
    assert.strictEqual(reported, undefined);
  });

  it("dev checkout carrying its own bun uses it; otherwise PATH", () => {
    const dev = defaultEnginePath();
    const resolved = { enginePath: dev, source: "dev" as const, layout: "tree" as const };
    const ownBun = path.join(dev, BUNDLED_BUN_RELATIVE);
    assert.strictEqual(resolveBunPath(resolved, existsSet(ownBun)), ownBun);
    assert.strictEqual(resolveBunPath(resolved, existsSet()), "bun");
  });
});

describe("resolveEngineCwd (BRANCH B / D5)", () => {
  it("bundled engine (both layouts) spawns from <globalStorage>/engine-runtime", () => {
    for (const layout of ["tree", "binary"] as const) {
      const resolved = { enginePath: BUNDLED, source: "bundled" as const, layout };
      assert.strictEqual(
        resolveEngineCwd(resolved, path.join(path.sep, "ud", "globalStorage")),
        path.join(path.sep, "ud", "globalStorage", "engine-runtime"),
      );
    }
  });

  it("dev/setting engines keep cwd = enginePath (undefined override)", () => {
    assert.strictEqual(
      resolveEngineCwd({ enginePath: "/x", source: "dev", layout: "tree" }, "/ud/globalStorage"),
      undefined,
    );
    assert.strictEqual(
      resolveEngineCwd({ enginePath: "/x", source: "setting", layout: "binary" }, "/ud/globalStorage"),
      undefined,
    );
  });
});
