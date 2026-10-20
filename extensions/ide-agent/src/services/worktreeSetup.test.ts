/**
 * worktreeSetup tests (node:test, zero extra deps) — GAPS-132, ran by GAPS-132.
 *
 * Covers the Cursor 3.25.9 `worktrees-json-config` port
 * (services/worktreeSetup.ts; binary evidence in ide-code-mission
 * docs/rea/work-notes-gaps132.md):
 *  - pure: flattenSetupCommands (`p4x`), selectSetupSpec key precedence,
 *    script-path resolution, script builders `c4x`/`u4x`/`d4x`/`h4x` verbatim
 *  - runner (real bash execution): no-config skip, root fallback, worktree
 *    config precedence, ROOT_WORKTREE_PATH / $1, && short-circuit on failure,
 *    script-file form, bad JSON, timeout, 2048-char output tail
 *
 * Temp dirs: under $GAPS132_SCRATCH when set (mission scratch), else
 * os.tmpdir(); always cleaned up.
 *
 * Run after `tsc`:  node --test out/services/worktreeSetup.test.js
 */
import { describe, it } from "node:test";
import * as assert from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  WORKTREE_SETUP_OUTPUT_TAIL_CHARS,
  WORKTREE_SETUP_TIMEOUT_MS,
  buildUnixCommandsScript,
  buildUnixScriptFileScript,
  buildWindowsCommandsScript,
  buildWindowsScriptFileScript,
  escapeSetupSingleQuotes,
  escapeSetupWindows,
  flattenSetupCommands,
  isAbsoluteSetupScriptPath,
  resolveSetupScriptPath,
  runWorktreeSetup,
  selectSetupSpec,
} from "./worktreeSetup";

const quietLog = { info: () => undefined, error: () => undefined };

function makeTempDir(prefix: string): string {
  const base = process.env["GAPS132_SCRATCH"] ?? os.tmpdir();
  fs.mkdirSync(base, { recursive: true });
  return fs.mkdtempSync(path.join(base, prefix));
}

function writeConfig(dir: string, content: string): void {
  const cursorDir = path.join(dir, ".cursor");
  fs.mkdirSync(cursorDir, { recursive: true });
  fs.writeFileSync(path.join(cursorDir, "worktrees.json"), content);
}

describe("worktreeSetup pure helpers (Cursor p4x / key selection / builders)", () => {
  it("constants match the binary: timeout 300s, output tail 2048", () => {
    assert.strictEqual(WORKTREE_SETUP_TIMEOUT_MS, 300000);
    assert.strictEqual(WORKTREE_SETUP_OUTPUT_TAIL_CHARS, 2048);
  });

  it("flattenSetupCommands keeps strings, recurses arrays, drops everything else (p4x)", () => {
    assert.deepStrictEqual(flattenSetupCommands("npm ci"), ["npm ci"]);
    assert.deepStrictEqual(flattenSetupCommands(["a", ["b", ["c"]], "d"]), ["a", "b", "c", "d"]);
    assert.deepStrictEqual(flattenSetupCommands(["a", 42, null, { x: 1 }, true, "b"]), ["a", "b"]);
    assert.deepStrictEqual(flattenSetupCommands(42), []);
    assert.deepStrictEqual(flattenSetupCommands(undefined), []);
  });

  it("selectSetupSpec: unix key beats generic on unix, generic is the fallback", () => {
    const cfg = { "setup-worktree": ["generic"], "setup-worktree-unix": ["unix"] };
    assert.deepStrictEqual(selectSetupSpec(cfg, false), { key: "setup-worktree-unix", commands: ["unix"] });
    assert.deepStrictEqual(selectSetupSpec({ "setup-worktree": ["generic"] }, false), {
      key: "setup-worktree",
      commands: ["generic"],
    });
  });

  it("selectSetupSpec: windows key beats generic on windows; unix key ignored on windows", () => {
    const cfg = { "setup-worktree": ["generic"], "setup-worktree-windows": ["win"], "setup-worktree-unix": ["unix"] };
    assert.deepStrictEqual(selectSetupSpec(cfg, true), { key: "setup-worktree-windows", commands: ["win"] });
    assert.deepStrictEqual(selectSetupSpec({ "setup-worktree-unix": ["unix"] }, true), {});
  });

  it("selectSetupSpec: string value is a script file, not commands", () => {
    assert.deepStrictEqual(selectSetupSpec({ "setup-worktree-unix": "./setup.sh" }, false), {
      key: "setup-worktree-unix",
      scriptValue: "./setup.sh",
    });
    assert.deepStrictEqual(selectSetupSpec({}, false), {});
  });

  it("isAbsoluteSetupScriptPath matches the binary tests per-OS", () => {
    assert.strictEqual(isAbsoluteSetupScriptPath("/x/y.sh", false), true);
    assert.strictEqual(isAbsoluteSetupScriptPath("rel/y.sh", false), false);
    assert.strictEqual(isAbsoluteSetupScriptPath("C:\\x\\y.ps1", true), true);
    assert.strictEqual(isAbsoluteSetupScriptPath("C:/x/y.ps1", true), true);
    assert.strictEqual(isAbsoluteSetupScriptPath("\\\\server\\share\\y.ps1", true), true);
    assert.strictEqual(isAbsoluteSetupScriptPath("rel\\y.ps1", true), false);
  });

  it("resolveSetupScriptPath resolves relative to the config file's directory", () => {
    assert.strictEqual(
      resolveSetupScriptPath("setup.sh", "/repo/.cursor/worktrees.json", false),
      path.resolve("/repo/.cursor", "setup.sh"),
    );
    assert.strictEqual(resolveSetupScriptPath("/abs/setup.sh", "/repo/.cursor/worktrees.json", false), "/abs/setup.sh");
  });

  it("escaping matches FWn / BWn", () => {
    assert.strictEqual(escapeSetupSingleQuotes("a'b"), "a'\\''b");
    assert.strictEqual(escapeSetupWindows('a`b"c'), 'a``b`"c');
  });

  it("buildUnixCommandsScript is the verbatim c4x template", () => {
    const got = buildUnixCommandsScript({ worktreePath: "/wt", rootWorkspacePath: "/root", commands: ["npm ci"] });
    const expected =
      "cd '/wt' || { printf '%s\\n' '[worktree-setup] ERROR: Failed to cd to worktree directory'; exit 1; } && " +
      "export ROOT_WORKTREE_PATH='/root' && set -- '/wt' && printf '%s\\n' '[worktree-setup] Working directory: '$(pwd) && " +
      "printf '%s\\n' '[worktree-setup] [0] $ npm ci' && npm ci && printf '%s\\n' '[worktree-setup] [0] done'";
    assert.strictEqual(got, expected);
  });

  it("buildWindowsCommandsScript is the verbatim u4x template", () => {
    const got = buildWindowsCommandsScript({ worktreePath: "C:\\wt", rootWorkspacePath: "C:\\root", commands: ["npm ci"] });
    const expected =
      `$ErrorActionPreference = 'Stop'; Set-Location -LiteralPath "C:\\wt"; $env:ROOT_WORKTREE_PATH = "C:\\root"; ` +
      `Write-Host '[worktree-setup] Working directory: ' (Get-Location); ` +
      `Write-Host "[worktree-setup] [0] $ npm ci"; npm ci; if ($LASTEXITCODE -ne $null -and $LASTEXITCODE -ne 0) { Write-Host "[worktree-setup] [0] failed with exit code $LASTEXITCODE"; exit $LASTEXITCODE } else { Write-Host "[worktree-setup] [0] done" }`;
    assert.strictEqual(got, expected);
  });

  it("buildUnixScriptFileScript is the verbatim d4x template (bash '<script>' '<wt>')", () => {
    const got = buildUnixScriptFileScript({ worktreePath: "/wt", rootWorkspacePath: "/root", scriptPath: "/root/.cursor/setup.sh" });
    const expected =
      "cd '/wt' || { printf '%s\\n' '[worktree-setup] ERROR: Failed to cd to worktree directory'; exit 1; } && " +
      "export ROOT_WORKTREE_PATH='/root' && printf '%s\\n' '[worktree-setup] Executing setup script: /root/.cursor/setup.sh' && " +
      "bash '/root/.cursor/setup.sh' '/wt'";
    assert.strictEqual(got, expected);
  });

  it("buildWindowsScriptFileScript is the verbatim h4x template", () => {
    const got = buildWindowsScriptFileScript({ worktreePath: "C:\\wt", rootWorkspacePath: "C:\\root", scriptPath: "C:\\root\\.cursor\\setup.ps1" });
    const expected =
      `$ErrorActionPreference = 'Stop'; Set-Location -LiteralPath "C:\\wt"; $env:ROOT_WORKTREE_PATH = "C:\\root"; & "C:\\root\\.cursor\\setup.ps1" "C:\\wt"`;
    assert.strictEqual(got, expected);
  });
});

describe("runWorktreeSetup (real execution, unix)", () => {
  it("no config anywhere → skip, no failure", async () => {
    const base = makeTempDir("gaps132-noconfig-");
    try {
      const wt = path.join(base, "wt");
      fs.mkdirSync(wt, { recursive: true });
      const res = await runWorktreeSetup({ worktreePath: wt, rootWorkspacePath: base, log: quietLog });
      assert.deepStrictEqual(res, { hadScript: false, scriptFailed: false });
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
  });

  it("root fallback: commands run in the worktree with ROOT_WORKTREE_PATH and $1 set", async () => {
    const base = makeTempDir("gaps132-root-");
    try {
      const wt = path.join(base, "wt");
      fs.mkdirSync(wt, { recursive: true });
      writeConfig(
        base,
        JSON.stringify({
          "setup-worktree": ["touch marker.txt", "printf '%s' \"$ROOT_WORKTREE_PATH\" > rootpath.txt", "printf '%s' \"$1\" > arg1.txt"],
        }),
      );
      const res = await runWorktreeSetup({ worktreePath: wt, rootWorkspacePath: base, log: quietLog });
      assert.deepStrictEqual(res, { hadScript: true, scriptFailed: false });
      assert.ok(fs.existsSync(path.join(wt, "marker.txt")), "marker must be created inside the worktree");
      assert.strictEqual(fs.readFileSync(path.join(wt, "rootpath.txt"), "utf8"), base);
      assert.strictEqual(fs.readFileSync(path.join(wt, "arg1.txt"), "utf8"), wt);
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
  });

  it("worktree config wins over root config", async () => {
    const base = makeTempDir("gaps132-precedence-");
    try {
      const wt = path.join(base, "wt");
      fs.mkdirSync(wt, { recursive: true });
      writeConfig(base, JSON.stringify({ "setup-worktree": ["exit 3"] }));
      writeConfig(wt, JSON.stringify({ "setup-worktree": ["touch from-worktree.txt"] }));
      const res = await runWorktreeSetup({ worktreePath: wt, rootWorkspacePath: base, log: quietLog });
      assert.deepStrictEqual(res, { hadScript: true, scriptFailed: false });
      assert.ok(fs.existsSync(path.join(wt, "from-worktree.txt")));
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
  });

  it("failing command short-circuits the chain (&& semantics) and reports exit code, never throws", async () => {
    const base = makeTempDir("gaps132-fail-");
    try {
      const wt = path.join(base, "wt");
      fs.mkdirSync(wt, { recursive: true });
      writeConfig(base, JSON.stringify({ "setup-worktree-unix": ["exit 7", "touch should-not-exist.txt"] }));
      const res = await runWorktreeSetup({ worktreePath: wt, rootWorkspacePath: base, log: quietLog });
      assert.strictEqual(res.hadScript, true);
      assert.strictEqual(res.scriptFailed, true);
      assert.strictEqual(res.scriptError, "Worktree setup script failed with exit code 7");
      assert.ok(!fs.existsSync(path.join(wt, "should-not-exist.txt")), "second command must not run after a failure");
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
  });

  it("script-file form: relative path resolves against the config dir, script receives worktree as $1", async () => {
    const base = makeTempDir("gaps132-scriptfile-");
    try {
      const wt = path.join(base, "wt");
      fs.mkdirSync(wt, { recursive: true });
      const cursorDir = path.join(base, ".cursor");
      fs.mkdirSync(cursorDir, { recursive: true });
      fs.writeFileSync(path.join(cursorDir, "setup.sh"), "#!/bin/bash\nprintf '%s' \"$1\" > script-arg.txt\ntouch script-ran.txt\n");
      writeConfig(base, JSON.stringify({ "setup-worktree": "./setup.sh" }));
      const res = await runWorktreeSetup({ worktreePath: wt, rootWorkspacePath: base, log: quietLog });
      assert.deepStrictEqual(res, { hadScript: true, scriptFailed: false });
      assert.ok(fs.existsSync(path.join(wt, "script-ran.txt")));
      assert.strictEqual(fs.readFileSync(path.join(wt, "script-arg.txt"), "utf8"), wt);
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
  });

  it("invalid JSON → {hadScript:false, scriptFailed:false} (binary catch semantics)", async () => {
    const base = makeTempDir("gaps132-badjson-");
    try {
      const wt = path.join(base, "wt");
      fs.mkdirSync(wt, { recursive: true });
      writeConfig(base, "{ not json");
      const res = await runWorktreeSetup({ worktreePath: wt, rootWorkspacePath: base, log: quietLog });
      assert.deepStrictEqual(res, { hadScript: false, scriptFailed: false });
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
  });

  it("timeout cancels the run and reports the binary's message shape", async () => {
    const base = makeTempDir("gaps132-timeout-");
    try {
      const wt = path.join(base, "wt");
      fs.mkdirSync(wt, { recursive: true });
      writeConfig(base, JSON.stringify({ "setup-worktree": ["sleep 5"] }));
      const res = await runWorktreeSetup({ worktreePath: wt, rootWorkspacePath: base, log: quietLog, timeoutMs: 300 });
      assert.strictEqual(res.hadScript, true);
      assert.strictEqual(res.scriptFailed, true);
      assert.strictEqual(res.scriptError, "Worktree setup script timed out after 0.3s");
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
  });

  it("output is truncated to the last 2048 chars", async () => {
    const base = makeTempDir("gaps132-tail-");
    try {
      const wt = path.join(base, "wt");
      fs.mkdirSync(wt, { recursive: true });
      writeConfig(base, JSON.stringify({ "setup-worktree": ["printf 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa%.0s' $(seq 1 60)", "exit 1"] }));
      const res = await runWorktreeSetup({ worktreePath: wt, rootWorkspacePath: base, log: quietLog });
      assert.strictEqual(res.scriptFailed, true);
      assert.ok(res.scriptOutput !== undefined);
      assert.ok(res.scriptOutput.length <= WORKTREE_SETUP_OUTPUT_TAIL_CHARS, `tail must be <= 2048, got ${res.scriptOutput.length}`);
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
  });
});
