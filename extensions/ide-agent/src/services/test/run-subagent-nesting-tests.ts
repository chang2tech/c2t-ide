/**
 * DEV-GAPS-40 (subagent-nested) tests (node:test, zero extra deps).
 *
 * Locks in Cursor nested-subagent parity
 * (spec verbatim — docs/rea/deep-docs-all.md §"Subagents — new details",
 * sourced from cursor.com/docs Subagents, read directly, HIGH confidence):
 *   - "Nested: main → subagent → sub-subagent allowed (2.5+), one level"
 *
 * The engine enforces the cap itself (packages/core/src/tool/plugin/
 * subagent.ts walks the parentID chain and fails the spawn when
 * `depth >= (experimental.subagent_depth ?? 1)`); Cursor's "one nested
 * level" is `subagent_depth = 2` in engine terms (main at depth 0 may
 * spawn, a subagent at depth 1 may spawn one sub-subagent, a sub-subagent
 * at depth 2 may not spawn further). The engine default (1) is stricter
 * than Cursor, so IDE-launched engines get the Cursor-parity default
 * injected via OPENCODE_CONFIG_CONTENT — but ONLY as a default: any
 * explicit user configuration (config file or env) wins.
 *
 * Covers:
 *  - the depth constant (2) and the injected config content;
 *  - explicit-setting detection in raw config text (JSONC-tolerant,
 *    fail-safe);
 *  - config-file path enumeration (global + workspace + OPENCODE_CONFIG);
 *  - readConfigTexts skipping missing files;
 *  - resolveSubagentDepthConfigContent: inject when unset, skip when the
 *    env var or any config text already sets the key;
 *  - wiring: the extension's engine spawn passes the decision into the
 *    sidecar env (source-text assertion, same pattern as
 *    run-subagent-preview-tests.ts).
 *
 * Run after `tsc`:  node --test out/services/test/run-subagent-nesting-tests.js
 */
import { describe, it } from "node:test";
import * as assert from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  CURSOR_SUBAGENT_NESTING_DEPTH,
  ENGINE_CONFIG_FILE_NAMES,
  NESTING_DEFAULT_CONFIG_CONTENT,
  configTextSetsSubagentDepth,
  engineConfigFilePaths,
  readConfigTexts,
  resolveSubagentDepthConfigContent,
} from "../subagentNesting";

// Compiled to out/services/test/, so the extension root is ../../..
const EXT_ROOT = path.resolve(__dirname, "..", "..", "..");
const ADAPTER_TS = path.join(EXT_ROOT, "src", "services", "ideCodeEngineAdapter.ts");

describe("nesting depth constant (Cursor one-level spec)", () => {
  it("is 2: main → subagent → sub-subagent; the sub-subagent may not spawn", () => {
    assert.equal(CURSOR_SUBAGENT_NESTING_DEPTH, 2);
  });

  it("the injected config content sets experimental.subagent_depth = 2", () => {
    const parsed = JSON.parse(NESTING_DEFAULT_CONFIG_CONTENT);
    assert.deepEqual(parsed, { experimental: { subagent_depth: 2 } });
  });

  it("uses the engine's real config file names", () => {
    assert.deepEqual([...ENGINE_CONFIG_FILE_NAMES], ["opencode.json", "opencode.jsonc"]);
  });
});

describe("configTextSetsSubagentDepth (explicit-setting detection)", () => {
  it("detects the key in JSON", () => {
    assert.equal(
      configTextSetsSubagentDepth('{ "experimental": { "subagent_depth": 1 } }'),
      true,
    );
  });

  it("detects the key in JSONC with comments and odd spacing", () => {
    assert.equal(
      configTextSetsSubagentDepth('{\n  // my nesting\n  "subagent_depth" :0\n}'),
      true,
    );
  });

  it("is fail-safe on commented-out keys (skips injection)", () => {
    assert.equal(
      configTextSetsSubagentDepth('// "subagent_depth": 3\n{}'),
      true,
    );
  });

  it("returns false when the key is absent", () => {
    assert.equal(configTextSetsSubagentDepth('{ "theme": "dark" }'), false);
    assert.equal(configTextSetsSubagentDepth(""), false);
  });

  it("does not match a similarly-named key", () => {
    assert.equal(configTextSetsSubagentDepth('{ "subagent_depth_limit": 2 }'), false);
  });
});

describe("engineConfigFilePaths", () => {
  it("covers global + workspace roots + explicit OPENCODE_CONFIG", () => {
    const paths = engineConfigFilePaths({
      globalConfigDir: "/home/u/.config/opencode",
      workspaceRoots: ["/ws/a", "/ws/b"],
      explicitConfigPath: "/etc/opencode.json",
    });
    assert.ok(paths.includes("/home/u/.config/opencode/opencode.json"));
    assert.ok(paths.includes("/home/u/.config/opencode/opencode.jsonc"));
    assert.ok(paths.includes("/ws/a/opencode.json"));
    assert.ok(paths.includes("/ws/b/opencode.jsonc"));
    assert.ok(paths.includes("/etc/opencode.json"));
    assert.equal(paths.length, 2 + 4 + 1);
  });

  it("omits the explicit path when OPENCODE_CONFIG is unset", () => {
    const paths = engineConfigFilePaths({
      globalConfigDir: "/g",
      workspaceRoots: [],
    });
    assert.equal(paths.length, 2);
  });
});

describe("readConfigTexts", () => {
  it("reads existing files and skips missing ones", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nesting-test-"));
    try {
      const present = path.join(dir, "opencode.json");
      fs.writeFileSync(present, '{ "theme": "dark" }', "utf8");
      const texts = readConfigTexts([present, path.join(dir, "nope.json")]);
      assert.deepEqual(texts, ['{ "theme": "dark" }']);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("resolveSubagentDepthConfigContent (default, never override)", () => {
  it("injects the Cursor-parity default when nothing sets the key", () => {
    assert.equal(
      resolveSubagentDepthConfigContent({
        existingEnvContent: undefined,
        userConfigTexts: ['{ "theme": "dark" }'],
      }),
      NESTING_DEFAULT_CONFIG_CONTENT,
    );
  });

  it("injects when there are no config texts at all", () => {
    assert.equal(
      resolveSubagentDepthConfigContent({ userConfigTexts: [] }),
      NESTING_DEFAULT_CONFIG_CONTENT,
    );
  });

  it("skips when OPENCODE_CONFIG_CONTENT is already set in the env", () => {
    assert.equal(
      resolveSubagentDepthConfigContent({
        existingEnvContent: '{"experimental":{"subagent_depth":5}}',
        userConfigTexts: [],
      }),
      undefined,
    );
  });

  it("skips when any user config text sets the key (user config wins)", () => {
    assert.equal(
      resolveSubagentDepthConfigContent({
        userConfigTexts: [
          '{ "theme": "dark" }',
          '{ "experimental": { "subagent_depth": 3 } }',
        ],
      }),
      undefined,
    );
  });
});

describe("spawn wiring (extension engine adapter)", () => {
  it("passes the nesting decision into the sidecar env via OPENCODE_CONFIG_CONTENT", () => {
    const src = fs.readFileSync(ADAPTER_TS, "utf8");
    assert.ok(
      src.includes("resolveSubagentDepthConfigContent"),
      "adapter must consult the nesting decision",
    );
    assert.ok(
      src.includes("spawnEnv.OPENCODE_CONFIG_CONTENT = nestingContent") ||
        src.includes("OPENCODE_CONFIG_CONTENT = nestingContent"),
      "adapter must inject OPENCODE_CONFIG_CONTENT into the spawn env",
    );
    assert.ok(
      src.includes('existingEnvContent: process.env.OPENCODE_CONFIG_CONTENT'),
      "adapter must not override an explicit env config",
    );
  });
});
