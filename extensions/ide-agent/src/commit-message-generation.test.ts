/**
 * DEV-GAPS-54 `ai-commit-message-generation` tests (Cursor parity).
 *
 * Spec (feature-matrix.json, Cursor 3.25.6 cursor-always-local evidence):
 *   "command cursor.generateGitCommitMessage (Generate Commit Message, f1
 *   palette, sparkle icon); menus.scm/inputBox when scmProvider==git;
 *   runCommand(GetCurrentIndexAndRecentCommits,{rawUris,rootPath}) ->
 *   {diffs, previousCommitMessages};
 *   generateCommitMessage({diffs, previousCommitMessages, explicitContext})
 *   -> input.setValue(message)"
 *
 * Covers:
 *  1. pure helpers (prompt building, message cleaning, log parsing);
 *  2. package.json: command w/ sparkle icon, scm/inputBox menu for git
 *     repos, commandPalette hide of the extension alias (the core
 *     `composer.generateGitCommitMessage` Action2 owns the palette slot —
 *     palette-dedupe invariant);
 *  3. core Action2: verbatim "Generate Commit Message" title, f1:true,
 *     delegation to `ide.generateGitCommitMessage`.
 *
 * node:test, zero extra deps. Run after `tsc`: node out/commit-message-generation.test.js
 */
import { describe, it } from "node:test";
import * as assert from "node:assert";
import * as fs from "fs";
import * as path from "path";

import {
  buildCommitMessagePrompt,
  cleanCommitMessage,
  parseRecentCommitMessages,
  COMMIT_MESSAGE_MAX_DIFF_CHARS,
  COMMIT_MESSAGE_RECENT_COUNT,
} from "./commit-message";

// Compiled to out/commit-message-generation.test.js, so the extension root
// is one level up.
const EXT_ROOT = path.resolve(__dirname, "..");
const REPO_ROOT = path.resolve(EXT_ROOT, "..", "..");
const PACKAGE_JSON = path.join(EXT_ROOT, "package.json");
const COMPOSER_ACTIONS = path.join(
  REPO_ROOT,
  "src/vs/workbench/contrib/composer/browser/composerActions.ts",
);

describe("buildCommitMessagePrompt (explicit context)", () => {
  it("embeds diff, stat, source note and previous commit messages", () => {
    const prompt = buildCommitMessagePrompt({
      diff: "diff --git a/foo.ts b/foo.ts\n+const x = 1;",
      stat: " foo.ts | 1 +",
      previousCommitMessages: ["feat: add login", "fix: typo"],
      source: "staged",
    });
    assert.ok(prompt.includes("STAGED"), "must say the change set is staged");
    assert.ok(prompt.includes("diff --git a/foo.ts"), "must embed the diff");
    assert.ok(prompt.includes("foo.ts | 1 +"), "must embed the stat");
    assert.ok(prompt.includes("feat: add login"), "must embed style context");
    assert.ok(prompt.includes("72 characters or fewer"), "must carry the subject rule");
    assert.ok(prompt.includes("output ONLY the message text"), "must forbid fences/explanation");
  });

  it("working-tree source says the changes are unstaged", () => {
    const prompt = buildCommitMessagePrompt({
      diff: "+line",
      stat: "1 +",
      previousCommitMessages: [],
      source: "working-tree",
    });
    assert.ok(prompt.includes("UNSTAGED"), "must say the change set is unstaged");
    assert.ok(prompt.includes("Generate the message anyway"), "must still ask for a message");
  });

  it("truncates diffs beyond the char cap", () => {
    const huge = "x".repeat(COMMIT_MESSAGE_MAX_DIFF_CHARS + 100);
    const prompt = buildCommitMessagePrompt({
      diff: huge,
      stat: "s",
      previousCommitMessages: [],
      source: "staged",
    });
    assert.ok(prompt.includes("…[truncated]"), "must mark truncation");
    assert.ok(prompt.length < huge.length + 1000, "prompt must not embed the whole diff");
  });

  it("omits the style section when there are no previous commits", () => {
    const prompt = buildCommitMessagePrompt({
      diff: "d",
      stat: "s",
      previousCommitMessages: [],
      source: "staged",
    });
    assert.ok(!prompt.includes("Recent commit messages"), "no style section without history");
  });
});

describe("cleanCommitMessage", () => {
  it("strips markdown fences", () => {
    assert.strictEqual(
      cleanCommitMessage("```\nfeat: add thing\n```"),
      "feat: add thing",
    );
  });

  it("takes the first non-empty line and trims", () => {
    assert.strictEqual(
      cleanCommitMessage("  \nfix: crash on start\n\nDetails here"),
      "fix: crash on start",
    );
  });

  it("strips surrounding quotes", () => {
    assert.strictEqual(cleanCommitMessage('"feat: quoted"'), "feat: quoted");
  });

  it("returns empty string for empty output", () => {
    assert.strictEqual(cleanCommitMessage("   \n"), "");
  });
});

describe("parseRecentCommitMessages", () => {
  it("splits lines, drops blanks, caps at the recent count", () => {
    const log = ["feat: a", "", "fix: b", "   "].join("\n");
    assert.deepStrictEqual(parseRecentCommitMessages(log), ["feat: a", "fix: b"]);
    const many = Array.from({ length: COMMIT_MESSAGE_RECENT_COUNT + 5 }, (_, i) => `c${i}`).join("\n");
    assert.strictEqual(parseRecentCommitMessages(many).length, COMMIT_MESSAGE_RECENT_COUNT);
  });
});

describe("package.json contributions (palette + SCM input box)", () => {
  const pkg = JSON.parse(fs.readFileSync(PACKAGE_JSON, "utf8"));

  it("registers the command with the verbatim title and sparkle icon", () => {
    const cmd = (pkg.contributes.commands as Array<Record<string, string>>).find(
      (c) => c.command === "ide.generateGitCommitMessage",
    );
    assert.ok(cmd, "ide.generateGitCommitMessage must be in contributes.commands");
    assert.strictEqual(cmd.title, "Generate Commit Message", "Cursor's verbatim title");
    assert.strictEqual(cmd.icon, "$(sparkle)", "Cursor's sparkle icon");
  });

  it("shows the command in the SCM input-box menu for git repos", () => {
    const menu = pkg.contributes.menus?.["scm/inputBox"] as
      | Array<{ command: string; when?: string }>
      | undefined;
    assert.ok(menu, "menus.scm/inputBox must exist");
    const entry = menu.find((m) => m.command === "ide.generateGitCommitMessage");
    assert.ok(entry, "scm/inputBox must contain ide.generateGitCommitMessage");
    assert.strictEqual(entry.when, "scmProvider == git", "Cursor's when clause verbatim");
  });

  it("hides the extension alias from the command palette (core owns the slot)", () => {
    const hidden = (pkg.contributes.menus.commandPalette as Array<{ command: string; when?: string }>)
      .filter((m) => m.command === "ide.generateGitCommitMessage")
      .every((m) => m.when === "false" || m.when === "never");
    assert.ok(hidden, "palette-dedupe invariant: only composer.generateGitCommitMessage is palette-visible");
  });
});

describe("core ComposerGenerateGitCommitMessageAction", () => {
  const src = fs.readFileSync(COMPOSER_ACTIONS, "utf8");
  const block = src.slice(src.indexOf("class ComposerGenerateGitCommitMessageAction"));

  it("has Cursor's verbatim title and is palette-visible (f1:true)", () => {
    assert.ok(
      /title:\s*localize2\('composer\.generateGitCommitMessage',\s*'Generate Commit Message'\)/.test(block),
      "title must be Cursor's verbatim 'Generate Commit Message'",
    );
    assert.ok(/f1:\s*true/.test(block.slice(0, 1200)), "must be f1 palette visible");
  });

  it("delegates to the extension runtime", () => {
    assert.ok(
      block.includes("executeCommand('ide.generateGitCommitMessage'"),
      "core action must delegate to ide.generateGitCommitMessage",
    );
  });
});
