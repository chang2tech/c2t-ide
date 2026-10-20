/**
 * Unit tests for DEV-GAPS-14 `ext-git-sanitize`.
 *
 * Evidence (Cursor, DIG-AST-EXT 2026-10-19 on `cursor-agent-host/dist/main.js`,
 * Cursor 3.25.6): "Before running git commands, strips user@ credentials
 * from URLs; forces safe.bareRepository=explicit, core.fsmonitor=false,
 * core.hooksPath=/dev/null, core.attributesFile=/dev/null".
 *
 * Assertions:
 *  - a URL arg containing `user@` / `user:pass@` is stripped BEFORE exec
 *    (the argv handed to the spawner contains no credential);
 *  - every git argv contains the four `-c` flags VERBATIM, before the
 *    subcommand;
 *  - non-URL args (flags, revs, paths, scp-like `git@host:path`) are
 *    untouched.
 *
 * node:test, zero extra deps. The `vscode` module is stubbed via
 * ./vscode-stub (imported FIRST). No real git is spawned — the spawner is
 * swapped for a recording fake.
 *
 * Run after `tsc`:  node --test out/services/test/run-git-exec-tests.js
 */
import "./vscode-stub";
import { describe, it, beforeEach, afterEach } from "node:test";
import * as assert from "node:assert";
import {
  GIT_SAFE_CONFIG_ARGS,
  stripGitUrlCredentials,
  withSafeGitArgs,
  gitExecFile,
  __setGitSpawnerForTests,
  __resetGitSpawnerForTests,
} from "../gitExec";

const VERBATIM_SAFE_ARGS = [
  "-c",
  "safe.bareRepository=explicit",
  "-c",
  "core.fsmonitor=false",
  "-c",
  "core.hooksPath=/dev/null",
  "-c",
  "core.attributesFile=/dev/null",
];

interface RecordedSpawn {
  file: string;
  args: string[];
  opts: { cwd: string; timeout: number; maxBuffer: number };
}

let recorded: RecordedSpawn[];

beforeEach(() => {
  recorded = [];
  __setGitSpawnerForTests(async (file, args, opts) => {
    recorded.push({ file, args, opts });
    return { stdout: "ok", stderr: "" };
  });
});

afterEach(() => {
  __resetGitSpawnerForTests();
});

describe("stripGitUrlCredentials", () => {
  it("strips user@ from an https URL", () => {
    assert.strictEqual(
      stripGitUrlCredentials("https://alice@github.com/org/repo.git"),
      "https://github.com/org/repo.git",
    );
  });

  it("strips user:pass@ from an https URL", () => {
    assert.strictEqual(
      stripGitUrlCredentials("https://alice:s3cret@github.com/org/repo.git"),
      "https://github.com/org/repo.git",
    );
  });

  it("strips :pass@ (empty user) from a URL", () => {
    assert.strictEqual(
      stripGitUrlCredentials("https://:token123@host/x.git"),
      "https://host/x.git",
    );
  });

  it("leaves URLs without userinfo untouched", () => {
    assert.strictEqual(
      stripGitUrlCredentials("https://github.com/org/repo.git"),
      "https://github.com/org/repo.git",
    );
  });

  it("leaves scp-like git@host:path untouched (git is the SSH user, not a credential)", () => {
    assert.strictEqual(
      stripGitUrlCredentials("git@github.com:org/repo.git"),
      "git@github.com:org/repo.git",
    );
  });

  it("leaves flags, revs and paths untouched", () => {
    assert.strictEqual(stripGitUrlCredentials("--no-color"), "--no-color");
    assert.strictEqual(stripGitUrlCredentials("HEAD"), "HEAD");
    assert.strictEqual(stripGitUrlCredentials("refs/heads/main"), "refs/heads/main");
    assert.strictEqual(stripGitUrlCredentials("/tmp/worktrees/x"), "/tmp/worktrees/x");
    assert.strictEqual(stripGitUrlCredentials("main...HEAD"), "main...HEAD");
  });
});

describe("withSafeGitArgs", () => {
  it("forces the four -c flags VERBATIM before the subcommand", () => {
    const out = withSafeGitArgs(["rev-parse", "--show-toplevel"]);
    assert.deepStrictEqual(out.slice(0, 8), VERBATIM_SAFE_ARGS);
    assert.deepStrictEqual(out.slice(8), ["rev-parse", "--show-toplevel"]);
  });

  it("GIT_SAFE_CONFIG_ARGS itself is the verbatim four pairs", () => {
    assert.deepStrictEqual([...GIT_SAFE_CONFIG_ARGS], VERBATIM_SAFE_ARGS);
  });

  it("sanitizes URL args while injecting the flags", () => {
    const out = withSafeGitArgs(["clone", "https://bob:pw@host/r.git", "/tmp/r"]);
    assert.deepStrictEqual(out.slice(0, 8), VERBATIM_SAFE_ARGS);
    assert.ok(out.includes("https://host/r.git"), "sanitized URL present");
    assert.ok(!out.some((a) => a.includes("bob")), "no credential in argv");
  });
});

describe("gitExecFile", () => {
  it("spawns `git` (never a shell string) with cwd", async () => {
    await gitExecFile("/repo", ["status", "--porcelain"]);
    assert.strictEqual(recorded.length, 1);
    assert.strictEqual(recorded[0]!.file, "git");
    assert.strictEqual(recorded[0]!.opts.cwd, "/repo");
  });

  it("argv contains no credential when the URL has user@", async () => {
    await gitExecFile("/repo", ["clone", "https://alice:s3cret@github.com/org/repo.git"]);
    const argv = recorded[0]!.args;
    assert.ok(!argv.some((a) => a.includes("alice") || a.includes("s3cret")), `argv leaked credential: ${argv.join(" ")}`);
    assert.ok(argv.includes("https://github.com/org/repo.git"));
  });

  it("argv always contains the four -c flags verbatim", async () => {
    await gitExecFile("/repo", ["worktree", "list", "--porcelain"]);
    const argv = recorded[0]!.args;
    for (const expected of VERBATIM_SAFE_ARGS) {
      assert.ok(argv.includes(expected), `missing verbatim flag ${expected}`);
    }
    // flags precede the subcommand
    assert.ok(argv.indexOf("worktree") > argv.indexOf("core.hooksPath=/dev/null"));
  });

  it("returns stdout from the spawner", async () => {
    const { stdout } = await gitExecFile("/repo", ["rev-parse", "HEAD"]);
    assert.strictEqual(stdout, "ok");
  });
});
