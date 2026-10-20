/**
 * cycleModelParameter tests (node:test, zero extra deps).
 *
 * Covers the P3 `cycle-model-parameter-minors` fix + DEV-GAPS-29
 * (Cursor 3.25.9 parity) for the workbench action
 * `composer.cycleModelParameter` (ComposerCycleModelParameterAction in
 * src/vs/workbench/contrib/composer/browser/composerActions.ts).
 *
 * Binary registration (workbench.glass.main.js @45366468, adversarially
 * re-verified 2026-10-20 by WORKER-GAPS-16C — the earlier weight-201 /
 * win-secondary / composerFocused claims were REFUTED):
 *  - f1:!1 — hidden from the command palette, reachable only via keybinding
 *  - primary:0 (no generic chord)
 *  - mac: CtrlCmd+Shift+/, win: CtrlCmd+Alt+/ (NO secondary chord),
 *    linux: CtrlCmd+Shift+/
 *  - weight 251 (= yk+1, yk=250 single keybinding def)
 *  - when `!terminalFocusInAny && !editorTextFocus` (the binary does NOT use
 *    composerFocused here)
 *
 * DEV-GAPS-29: the run mechanism — the binary's `isCycleableByHotkey &&
 * count > 1` lookup over model.parameterDefinitions — is implemented in the
 * ide-agent extension (services/modelParameterService.ts +
 * cycleFocusedModelParameter in extension.ts), covered by
 * modelParameterService.test.ts.
 *
 * The action lives in the workbench core (not loadable in node without the
 * full workbench), so these assertions are source-level — the same approach
 * as agents-window.test.ts.
 *
 * Run after `tsc`:  node out/services/cycleModelParameter.test.js
 */
import { describe, it } from "node:test";
import * as assert from "node:assert";
import * as fs from "node:fs";
import * as path from "node:path";

// Compiled to out/services/cycleModelParameter.test.js:
// EXT_ROOT = <repo>/extensions/ide-agent ; REPO_ROOT = <repo>.
const EXT_ROOT = path.resolve(__dirname, "..", "..");
const REPO_ROOT = path.resolve(EXT_ROOT, "..", "..");
const COMPOSER_ACTIONS_TS = path.join(
  REPO_ROOT,
  "src",
  "vs",
  "workbench",
  "contrib",
  "composer",
  "browser",
  "composerActions.ts",
);

function cycleModelParameterBlock(): string {
  const src = fs.readFileSync(COMPOSER_ACTIONS_TS, "utf8");
  const start = src.indexOf("export class ComposerCycleModelParameterAction");
  assert.ok(start >= 0, "ComposerCycleModelParameterAction not found in composerActions.ts");
  const next = src.indexOf("export class", start + 1);
  // Include the JSDoc above the class — it carries the binary evidence.
  const docStart = src.lastIndexOf("/**", start);
  const from = docStart >= 0 && src.slice(docStart, start).trimStart().startsWith("/**") ? docStart : start;
  return src.slice(from, next < 0 ? undefined : next);
}

describe("composer.cycleModelParameter (Cursor 3.25.9 binary)", () => {
  it("is hidden from the command palette: f1: false (binary f1:!1)", () => {
    const block = cycleModelParameterBlock();
    assert.ok(/f1:\s*false/.test(block), "expected f1: false on ComposerCycleModelParameterAction");
    assert.ok(
      !/f1:\s*true/.test(block),
      "f1 must not be true — the binary hides this command from the palette",
    );
  });

  it("has the binary keybinding: primary 0, mac CtrlCmd+Shift+/, win CtrlCmd+Alt+/ (NO secondary), linux CtrlCmd+Shift+/", () => {
    const block = cycleModelParameterBlock();
    assert.ok(/primary:\s*0/.test(block), "expected primary: 0 (no generic chord)");
    assert.ok(
      /mac:\s*\{\s*primary:\s*KeyMod\.CtrlCmd\s*\|\s*KeyMod\.Shift\s*\|\s*KeyCode\.Slash\s*\}/.test(
        block,
      ),
      "expected mac: CtrlCmd+Shift+/",
    );
    assert.ok(
      /win:\s*\{\s*primary:\s*KeyMod\.CtrlCmd\s*\|\s*KeyMod\.Alt\s*\|\s*KeyCode\.Slash/.test(block),
      "expected win primary: CtrlCmd+Alt+/",
    );
    // WORKER-GAPS-16C (adversarial re-verify 2026-10-20): the binary has NO
    // win secondary chord — the earlier claim was refuted. (The doc comment
    // mentions the word "secondary", so match the property form only.)
    assert.ok(!/secondary\s*:/.test(block), "no secondary chord — the binary registers none");
    assert.ok(
      /linux:\s*\{\s*primary:\s*KeyMod\.CtrlCmd\s*\|\s*KeyMod\.Shift\s*\|\s*KeyCode\.Slash\s*\}/.test(
        block,
      ),
      "expected linux: CtrlCmd+Shift+/",
    );
  });

  it("uses the binary weight 251 (NOT WorkbenchContrib+1)", () => {
    const block = cycleModelParameterBlock();
    // WORKER-GAPS-16C: binary weight is yk+1 = 251 (yk=250), NOT 201.
    // (The doc comment mentions the refuted form by name, so assert on the
    // property expression, not on bare text.)
    assert.ok(/weight:\s*251\b/.test(block), "expected weight: 251 (binary yk+1)");
    assert.ok(
      !/weight:\s*KeybindingWeight/.test(block),
      "must not use a KeybindingWeight enum expression for the weight",
    );
  });

  it("uses the binary when clause: !terminalFocusInAny && !editorTextFocus", () => {
    const block = cycleModelParameterBlock();
    assert.ok(/focusInAny\.negate\(\)/.test(block), "expected !terminalFocusInAny in the when clause");
    assert.ok(/editorTextFocus\.negate\(\)/.test(block), "expected !editorTextFocus in the when clause");
    assert.ok(
      /45366468/.test(block) || /45343380/.test(block),
      "expected a comment citing binary evidence (@45366468 / yk=250 @45343380)",
    );
  });

  it("documents the run mechanism and delegates to ide.cycleModelParameter", () => {
    const block = cycleModelParameterBlock();
    assert.ok(
      /cycling the focused model-parameter target/.test(block),
      "expected a comment describing the binary run (cycle focused target first, else fall back to cycleModel)",
    );
    assert.ok(/ide\.cycleModelParameter/.test(block), "expected delegation to ide.cycleModelParameter");
  });
});
