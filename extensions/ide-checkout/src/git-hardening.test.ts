/**
 * git-hardening-layer tests (node:test, zero extra deps).
 *
 * Verifies the hardened git invocation layer against the verbatim evidence
 * (decompiled `cursor-checkout` v0.0.1, Cursor 3.25.9):
 *  - arg deny list: -c/-C/--git-dir/--work-tree/--namespace/--super-prefix/
 *    --config-env/--attr-source
 *  - forced --no-ext-diff --no-textconv on diff/show/blame/log/whatchanged
 *  - URL credential scrubbing in logs (https?://\S+, trailing punctuation trim)
 *  - env lockdown via GIT_CONFIG_COUNT (the four safe configs verbatim),
 *    GIT_PAGER=cat, LC_ALL/LANG=en_US.UTF-8
 *  - branch-name normalization + leading-dash rejection
 *  - --no-write-fetch-head gating on git >= 2.29
 *  - verbatim non-fast-forward "moving to cloud" message
 *
 * Run after `tsc`:  node out/git-hardening.test.js
 */
import { describe, it } from "node:test";
import * as assert from "node:assert";
import {
  GIT_MAX_BUFFER_BYTES,
  WARM_CACHE_TTL_MS,
  assertSafeGitArgs,
  assertValidBranchName,
  buildHardenedGitEnv,
  isNonFastForwardPushError,
  nonFastForwardErrorMessage,
  normalizeBranchName,
  scrubGitArgForLog,
  supportsNoWriteFetchHead,
  withForcedNoExtDiff,
} from "./gitHardening.js";

describe("git-hardening-layer", () => {
  it("denies dangerous global args in user-controlled argv", () => {
    for (const denied of [
      "-c",
      "-C",
      "--git-dir",
      "--work-tree",
      "--namespace",
      "--super-prefix",
      "--config-env",
      "--attr-source",
      "--git-dir=/tmp/evil",
      "--work-tree=/",
    ]) {
      assert.throws(
        () => assertSafeGitArgs(["fetch", denied]),
        /Denied git argument/,
        `expected ${denied} to be denied`
      );
    }
  });

  it("allows ordinary args", () => {
    assert.doesNotThrow(() =>
      assertSafeGitArgs(["fetch", "origin", "+refs/heads/a:refs/remotes/origin/a"])
    );
    assert.doesNotThrow(() =>
      assertSafeGitArgs(["--no-optional-locks", "status", "--porcelain"])
    );
  });

  it("forces --no-ext-diff --no-textconv onto diff/show/blame/log/whatchanged", () => {
    for (const sub of ["diff", "show", "blame", "log", "whatchanged"]) {
      assert.deepStrictEqual(withForcedNoExtDiff([sub, "--stat"]), [
        sub,
        "--no-ext-diff",
        "--no-textconv",
        "--stat",
      ]);
    }
  });

  it("leaves other subcommands untouched", () => {
    assert.deepStrictEqual(withForcedNoExtDiff(["fetch", "origin"]), ["fetch", "origin"]);
    assert.deepStrictEqual(withForcedNoExtDiff(["checkout", "-b", "x"]), ["checkout", "-b", "x"]);
  });

  it("strips credentials/userinfo from URLs in log lines", () => {
    assert.strictEqual(
      scrubGitArgForLog("https://user:pass@github.com/org/repo.git"),
      "https://github.com/org/repo.git"
    );
    assert.strictEqual(
      scrubGitArgForLog("https://user@github.com/org/repo.git"),
      "https://github.com/org/repo.git"
    );
  });

  it("trims trailing punctuation after scrubbing", () => {
    assert.strictEqual(
      scrubGitArgForLog('fetching (https://tok@host/x.git).'),
      "fetching (https://host/x.git)."
    );
  });

  it("leaves non-URL args unchanged", () => {
    assert.strictEqual(scrubGitArgForLog("--no-optional-locks"), "--no-optional-locks");
    // scp-like syntax is NOT a scheme:// URL: untouched (matches the twin
    // modules' documented interpretation).
    assert.strictEqual(scrubGitArgForLog("git@github.com:org/repo.git"), "git@github.com:org/repo.git");
  });

  it("locks down the env via GIT_CONFIG_COUNT with the four safe configs", () => {
    const env = buildHardenedGitEnv();
    assert.strictEqual(env["GIT_CONFIG_COUNT"], "4");
    assert.strictEqual(env["GIT_CONFIG_KEY_0"], "safe.bareRepository");
    assert.strictEqual(env["GIT_CONFIG_VALUE_0"], "explicit");
    assert.strictEqual(env["GIT_CONFIG_KEY_1"], "core.fsmonitor");
    assert.strictEqual(env["GIT_CONFIG_VALUE_1"], "false");
    assert.strictEqual(env["GIT_CONFIG_KEY_2"], "core.hooksPath");
    assert.strictEqual(env["GIT_CONFIG_VALUE_2"], "/dev/null");
    assert.strictEqual(env["GIT_CONFIG_KEY_3"], "core.attributesFile");
    assert.strictEqual(env["GIT_CONFIG_VALUE_3"], "/dev/null");
    assert.strictEqual(env["GIT_PAGER"], "cat");
    assert.strictEqual(env["LC_ALL"], "en_US.UTF-8");
    assert.strictEqual(env["LANG"], "en_US.UTF-8");
  });

  it("merges extra env (e.g. GIT_INDEX_FILE) over the hardened env", () => {
    const env = buildHardenedGitEnv({ GIT_INDEX_FILE: "/tmp/idx" });
    assert.strictEqual(env["GIT_INDEX_FILE"], "/tmp/idx");
    assert.strictEqual(env["GIT_CONFIG_COUNT"], "4");
  });

  it("normalizes branch names by stripping known prefixes", () => {
    assert.strictEqual(normalizeBranchName("refs/heads/main"), "main");
    assert.strictEqual(normalizeBranchName("heads/main"), "main");
    assert.strictEqual(normalizeBranchName("remotes/origin/main"), "main");
    assert.strictEqual(normalizeBranchName("origin/main"), "main");
    assert.strictEqual(normalizeBranchName("main"), "main");
  });

  it("rejects empty and leading-dash branch names", () => {
    assert.throws(() => assertValidBranchName(""), /must not be empty/);
    assert.throws(() => assertValidBranchName("-b"), /Invalid branch name/);
    assert.doesNotThrow(() => assertValidBranchName("feature/x"));
  });

  it("gates --no-write-fetch-head on git >= 2.29", () => {
    assert.strictEqual(supportsNoWriteFetchHead("git version 2.28.0"), false);
    assert.strictEqual(supportsNoWriteFetchHead("git version 2.29.0"), true);
    assert.strictEqual(supportsNoWriteFetchHead("git version 2.43.0"), true);
    assert.strictEqual(supportsNoWriteFetchHead("git version 3.0.0"), true);
    assert.strictEqual(supportsNoWriteFetchHead("not git"), false);
  });

  it("emits the verbatim non-fast-forward message", () => {
    assert.strictEqual(
      nonFastForwardErrorMessage("my-branch", "origin"),
      'Your branch "my-branch" is behind origin. Pull the latest changes, then try moving to cloud again.'
    );
  });

  it("detects non-fast-forward push rejections", () => {
    assert.strictEqual(
      isNonFastForwardPushError("! [rejected] main -> main (non-fast-forward)"),
      true
    );
    assert.strictEqual(isNonFastForwardPushError("Everything up-to-date"), false);
  });

  it("pins the 64 MiB buffer cap and 30 s warm TTL", () => {
    assert.strictEqual(GIT_MAX_BUFFER_BYTES, 64 * 1024 * 1024);
    assert.strictEqual(WARM_CACHE_TTL_MS, 30_000);
  });
});
