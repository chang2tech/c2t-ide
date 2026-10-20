/**
 * Manifest validation for the `ide-worktree-textmate` built-in extension
 * (DEV-GAPS-37B, gap `worktree-textmate-syntax-isolation`).
 *
 * Spec (verbatim structure, harvest-cursor-worktree-textmate-2026-10-19.md):
 * Cursor ships `cursor-worktree-textmate` ("Worktree TextMate Syntax",
 * publisher everysphere, v0.0.1, extensionKind ui, engines ^1.80.0) which
 * registers 28 shadow language IDs (worktree-<lang>) whose filenamePatterns
 * match ONLY files under the worktrees dirs (Cursor: ".cursor/worktrees").
 * syntaxes/*.tmLanguage.json files is a tiny 2-line include shim delegating
 * to the base TextMate scope (worktree-hcl reuses the terraform shim). All
 * 28 IDs get `[worktree-<lang>]: { "editor.semanticHighlighting.enabled": false }`.
 * Opening an agent-worktree file must NOT activate the real language
 * extensions — so no language server spins up for worktree files.
 *
 * Our mirror: `ide-worktree-textmate` with patterns scoped to the
 * brand-mirrored managed root (".ide-code/worktrees") plus the legacy
 * sibling layout ("*-worktrees", graceful coverage).
 *
 * Run: node --test test/validate.js  (no build step needed)
 */
const { describe, it } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const EXT = __dirname + "/..";
const pkg = JSON.parse(fs.readFileSync(path.join(EXT, "package.json"), "utf8"));

// language id -> expected base scope include (from the REA harvest shim table)
const EXPECTED_SCOPES = {
  "worktree-c": "source.c",
  "worktree-cpp": "source.cpp",
  "worktree-css": "source.css",
  "worktree-go": "source.go",
  "worktree-html": "text.html.derivative", // NOTE: derivative, not text.html.basic
  "worktree-java": "source.java",
  "worktree-javascript": "source.js",
  "worktree-javascriptreact": "source.jsx",
  "worktree-json": "source.json",
  "worktree-php": "source.php",
  "worktree-protobuf": "source.proto",
  "worktree-python": "source.python",
  "worktree-ruby": "source.ruby",
  "worktree-rust": "source.rust",
  "worktree-shellscript": "source.shell",
  "worktree-sql": "source.sql",
  "worktree-swift": "source.swift",
  "worktree-typescript": "source.ts",
  "worktree-typescriptreact": "source.tsx",
  "worktree-yaml": "source.yaml",
  "worktree-terraform": "source.hcl.terraform",
  "worktree-terraform-vars": "source.hcl.terraform",
  "worktree-hcl": "source.hcl.terraform", // reuses the terraform shim
  "worktree-terraform-stack": "source.hcl",
  "worktree-terraform-deploy": "source.hcl",
  "worktree-terraform-test": "source.hcl",
  "worktree-terraform-mock": "source.hcl",
  "worktree-terraform-search": "source.hcl",
};

describe("ide-worktree-textmate manifest (Cursor parity)", () => {
  it("registers exactly the 28 Cursor shadow language IDs", () => {
    const langs = pkg.contributes.languages;
    const ids = langs.map((l) => l.id).sort();
    assert.deepStrictEqual(ids, Object.keys(EXPECTED_SCOPES).sort());
  });

  it("filenamePatterns match ONLY worktree dirs (managed + legacy sibling)", () => {
    for (const lang of pkg.contributes.languages) {
      assert.ok(
        Array.isArray(lang.filenamePatterns) && lang.filenamePatterns.length > 0,
        `${lang.id}: needs filenamePatterns`,
      );
      for (const p of lang.filenamePatterns) {
        assert.ok(
          p.startsWith("**/.ide-code/worktrees/") || p.startsWith("**/*-worktrees/"),
          `${lang.id}: pattern must be scoped to a worktree dir, got ${p}`,
        );
      }
    }
    // Multi-pattern spot checks (from the harvest: cpp .cpp/.h/.hpp,
    // shellscript .sh/.bash, yaml .yaml/.yml).
    const byId = Object.fromEntries(pkg.contributes.languages.map((l) => [l.id, l]));
    for (const sfx of [".cpp", ".h", ".hpp"]) {
      assert.ok(byId["worktree-cpp"].filenamePatterns.some((p) => p.endsWith(sfx)), `missing ${sfx}`);
    }
    for (const sfx of [".sh", ".bash"]) {
      assert.ok(byId["worktree-shellscript"].filenamePatterns.some((p) => p.endsWith(sfx)), `missing ${sfx}`);
    }
    for (const sfx of [".yaml", ".yml"]) {
      assert.ok(byId["worktree-yaml"].filenamePatterns.some((p) => p.endsWith(sfx)), `missing ${sfx}`);
    }
    // Terraform family spot checks.
    assert.ok(byId["worktree-terraform-stack"].filenamePatterns.some((p) => p.endsWith(".tfstack.hcl")));
    assert.ok(byId["worktree-terraform-search"].filenamePatterns.some((p) => p.endsWith(".tfquery.hcl")));
  });

  it("has 27 grammar files; worktree-hcl reuses the terraform shim", () => {
    const files = fs.readdirSync(path.join(EXT, "syntaxes"));
    assert.strictEqual(files.length, 27, `expected 27 grammar files, got ${files.length}`);
    const grammars = pkg.contributes.grammars;
    assert.strictEqual(grammars.length, 28);
    const hcl = grammars.find((g) => g.language === "worktree-hcl");
    assert.strictEqual(hcl.path, "./syntaxes/worktree-terraform.tmLanguage.json");
    // Every referenced grammar file exists on disk.
    for (const g of grammars) {
      assert.ok(
        fs.existsSync(path.join(EXT, g.path.replace(/^\.\//, ""))),
        `missing grammar file: ${g.path}`,
      );
    }
  });

  it("each shim is a 2-line-style include delegating to the REA base scope", () => {
    for (const g of pkg.contributes.grammars) {
      const shim = JSON.parse(fs.readFileSync(path.join(EXT, g.path.replace(/^\.\//, "")), "utf8"));
      // worktree-hcl reuses the terraform shim (Cursor parity: its scopeName
      // is source.worktree-terraform, per the harvest).
      const expectedScopeName = g.language === "worktree-hcl" ? "source.worktree-terraform" : `source.${g.language}`;
      assert.strictEqual(shim.scopeName, expectedScopeName, `${g.language}: scopeName`);
      const includes = shim.patterns.map((p) => p.include);
      assert.strictEqual(includes.length, 1, `${g.language}: shim must include exactly one scope`);
      assert.strictEqual(
        includes[0],
        EXPECTED_SCOPES[g.language],
        `${g.language}: expected ${EXPECTED_SCOPES[g.language]}, got ${includes[0]}`,
      );
    }
  });

  it("all 28 IDs disable semantic highlighting (no LSP-driven coloring)", () => {
    const defaults = pkg.contributes.configurationDefaults;
    for (const id of Object.keys(EXPECTED_SCOPES)) {
      assert.deepStrictEqual(
        defaults[`[${id}]`],
        { "editor.semanticHighlighting.enabled": false },
        `${id}: configurationDefaults`,
      );
    }
  });

  it("identity mirrors Cursor's extension (ui-only, engines ^1.80.0)", () => {
    assert.strictEqual(pkg.name, "ide-worktree-textmate");
    assert.strictEqual(pkg.displayName, "Worktree TextMate Syntax");
    assert.ok(
      pkg.description.includes("TextMate") && pkg.description.includes("without activating language servers"),
      "description must state the no-LSP purpose",
    );
    assert.deepStrictEqual(pkg.extensionKind, ["ui"]);
    assert.strictEqual(pkg.engines.vscode, "^1.80.0");
    assert.ok(pkg.categories.includes("Programming Languages"));
  });
});
