/**
 * buildTabCompletionPrompt pure-function tests (node:test).
 *
 * Pins the exact prompt shape sent to the engine's session.generate endpoint
 * for Tab completions: instruction header, <CURSOR> marker placement, and
 * optional language/file context. A regression here silently changes what the
 * model sees on every keystroke.
 *
 * Run after `tsc`:  node out/services/test/run-tabcomplete-tests.js
 */
import "./vscode-stub";
import { describe, it } from "node:test";
import * as assert from "node:assert";
import { buildTabCompletionPrompt } from "../ideCodeEngineAdapter";

describe("buildTabCompletionPrompt", () => {
  it("places the <CURSOR> marker exactly between prefix and suffix", () => {
    const p = buildTabCompletionPrompt("const x = ", ";\n", { languageId: "typescript", fileName: "a.ts" });
    assert.ok(p.endsWith("const x = <CURSOR>;\n"), `marker placement wrong:\n${p}`);
  });

  it("instructs the model to output only the completion", () => {
    const p = buildTabCompletionPrompt("a", "b");
    assert.ok(p.includes("Output ONLY the completion text"), "missing output-only instruction");
    assert.ok(p.includes("no markdown fences"), "missing no-fences instruction");
  });

  it("includes language and file context when provided", () => {
    const p = buildTabCompletionPrompt("a", "b", { languageId: "python", fileName: "main.py" });
    assert.ok(p.includes("Language: python"), "missing language line");
    assert.ok(p.includes("File: main.py"), "missing file line");
  });

  it("omits context lines when absent", () => {
    const p = buildTabCompletionPrompt("a", "b");
    assert.ok(!p.includes("Language:"), "unexpected language line");
    assert.ok(!p.includes("File:"), "unexpected file line");
  });

  it("keeps prefix/suffix verbatim", () => {
    const prefix = "function f() {\n  return `tpl ${x}`;";
    const suffix = "\n}\n// done";
    const p = buildTabCompletionPrompt(prefix, suffix);
    assert.ok(p.includes(`${prefix}<CURSOR>${suffix}`), "context not verbatim");
  });
});
