/**
 * DEV-GAPS-65 `worktree-lsp-opt-in` tests.
 *
 * Spec (verbatim strings, harvest-cursor-worktree-textmate-2026-10-19.md +
 * detail-settings-2026-10-19.md §12, Cursor 3.25.9):
 *   - Setting id `lsp-worktrees-enabled` (glass settings, `indexing` tab)
 *   - Label: "Enable LSPs for Worktrees"
 *   - Description: "Enable language server by default to provide code
 *     intelligence in agent worktree workspaces"
 *   - Aliases: `language server`, `worktree`
 *   - Default behavior is TextMate-only isolation (28 shadow language ids,
 *     DEV-GAPS-37B); the setting flips worktree files to their real
 *     language ids so language servers activate.
 *
 * Run (after `tsc -p ./`): node --test test/lsp-opt-in.test.js
 */
const { describe, it } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const EXT = path.resolve(__dirname, "..");
const pkg = JSON.parse(fs.readFileSync(path.join(EXT, "package.json"), "utf8"));
const {
  CURSOR_LSP_WORKTREES_SETTING_ID,
  LSP_WORKTREES_ENABLED_ALIASES,
  LSP_WORKTREES_ENABLED_CONFIG_KEY,
  LSP_WORKTREES_ENABLED_DESCRIPTION,
  LSP_WORKTREES_ENABLED_LABEL,
  WORKTREE_SHADOW_LANGUAGE_IDS,
  isWorktreeShadowLanguageId,
  realLanguageIdForShadow,
  resolveRealLanguageId,
} = require("../out/languageMap.js");

describe("verbatim setting strings (Cursor 3.25.9)", () => {
  it("binary setting id / label / description / aliases are kept verbatim", () => {
    assert.strictEqual(CURSOR_LSP_WORKTREES_SETTING_ID, "lsp-worktrees-enabled");
    assert.strictEqual(LSP_WORKTREES_ENABLED_LABEL, "Enable LSPs for Worktrees");
    assert.strictEqual(
      LSP_WORKTREES_ENABLED_DESCRIPTION,
      "Enable language server by default to provide code intelligence in agent worktree workspaces",
    );
    assert.deepStrictEqual([...LSP_WORKTREES_ENABLED_ALIASES], ["language server", "worktree"]);
    assert.strictEqual(LSP_WORKTREES_ENABLED_CONFIG_KEY, "ide.worktree.lspWorktreesEnabled");
  });

  it("package.json contributes the setting with the verbatim surface text", () => {
    const config = pkg.contributes.configuration;
    assert.ok(config, "configuration contribution must exist");
    const prop = config.properties["ide.worktree.lspWorktreesEnabled"];
    assert.ok(prop, "ide.worktree.lspWorktreesEnabled must be contributed");
    assert.strictEqual(prop.title, "Enable LSPs for Worktrees");
    assert.strictEqual(
      prop.markdownDescription,
      "Enable language server by default to provide code intelligence in agent worktree workspaces",
    );
    assert.deepStrictEqual(prop.tags, ["language server", "worktree"]);
    assert.strictEqual(prop.type, "boolean");
    // Out-of-box behavior in Cursor is TextMate-only isolation → default off.
    assert.strictEqual(prop.default, false);
  });

  it("extension now has a real activation entry for the toggle", () => {
    assert.strictEqual(pkg.main, "./out/extension.js");
    assert.deepStrictEqual(pkg.activationEvents, ["onStartupFinished"]);
  });
});

describe("shadow → real language mapping", () => {
  it("covers exactly the 28 shadow ids registered in package.json (drift guard)", () => {
    const contributed = pkg.contributes.languages.map((l) => l.id).sort();
    assert.deepStrictEqual([...WORKTREE_SHADOW_LANGUAGE_IDS].sort(), contributed);
    assert.strictEqual(WORKTREE_SHADOW_LANGUAGE_IDS.length, 28);
  });

  it("strips the worktree- prefix for known shadow ids only", () => {
    assert.strictEqual(realLanguageIdForShadow("worktree-typescript"), "typescript");
    assert.strictEqual(realLanguageIdForShadow("worktree-python"), "python");
    assert.strictEqual(realLanguageIdForShadow("worktree-terraform-vars"), "terraform-vars");
    assert.strictEqual(realLanguageIdForShadow("worktree-hcl"), "hcl");
    assert.strictEqual(realLanguageIdForShadow("typescript"), undefined);
    assert.strictEqual(realLanguageIdForShadow("worktree-not-a-language"), undefined);
    assert.strictEqual(isWorktreeShadowLanguageId("worktree-rust"), true);
    assert.strictEqual(isWorktreeShadowLanguageId("rust"), false);
  });

  it("resolves only when the real language is registered", () => {
    const available = ["typescript", "python", "json"];
    assert.strictEqual(resolveRealLanguageId("worktree-typescript", available), "typescript");
    assert.strictEqual(resolveRealLanguageId("worktree-rust", available), undefined);
    assert.strictEqual(resolveRealLanguageId("worktree-terraform", available), undefined);
    assert.strictEqual(
      resolveRealLanguageId("worktree-terraform", [...available, "terraform"]),
      "terraform",
    );
    assert.strictEqual(resolveRealLanguageId("json", available), undefined);
  });
});
