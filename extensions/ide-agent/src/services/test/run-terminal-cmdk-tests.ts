/**
 * DEV-GAPS-9C tests (node:test, no vscode dependency).
 *
 * Guards the Cursor 3.25.9 terminal Cmd+K command family parity
 * (docs/rea/audit-fix-queue.md run 19:07, feature `terminal-ai-cmdk`):
 *   src/vs/workbench/contrib/composer/browser/terminalCmdkActions.ts
 *
 * This test parses terminalCmdkActions.ts (no vscode runtime needed) and
 * asserts the VERBATIM registrations: command ids, titles, keybindings,
 * weights, when-clauses, precondition, eligibility gate, localMode
 * short-circuit, and the `terminal.cmdk.show` telemetry event.
 *
 * Run after `tsc`:  node --test out/services/test/run-terminal-cmdk-tests.js
 * (or standalone: TERMINAL_CMDK_ACTIONS_PATH=<path> node --test <compiled>)
 */
import { describe, it } from "node:test";
import * as assert from "node:assert";
import * as fs from "node:fs";
import * as path from "node:path";

const actionsPath =
  process.env.TERMINAL_CMDK_ACTIONS_PATH ??
  path.join(
    __dirname,
    "..",
    "..",
    "..",
    "..",
    "..",
    "src",
    "vs",
    "workbench",
    "contrib",
    "composer",
    "browser",
    "terminalCmdkActions.ts",
  );
const src = fs.readFileSync(actionsPath, "utf8");

const composerActionsPath = path.join(
  path.dirname(actionsPath),
  "composerActions.ts",
);
const composerActionsSrc = fs.existsSync(composerActionsPath)
  ? fs.readFileSync(composerActionsPath, "utf8")
  : "";

/** Extract the class body for `static readonly ID = '<id>'` (up to the next top-level class). */
function classBodyFor(id: string): string {
  const marker = `static readonly ID = '${id}'`;
  const start = src.indexOf(marker);
  assert.ok(start >= 0, `missing action class for id ${id}`);
  const classStart = src.lastIndexOf("class ", start);
  let end = src.indexOf("\nclass ", start);
  if (end < 0) {
    end = src.indexOf("\n/**", start);
  }
  if (end < 0) {
    end = src.length;
  }
  return src.slice(classStart, end);
}

describe("terminal-ai-cmdk: verbatim command ids", () => {
  const ids = [
    "cursorai.action.generateInTerminal",
    "cursorai.action.hideGenerateInTerminal",
    "cursorai.action.cancelGenerateInTerminal",
    "cursorai.action.acceptGenerateInTerminal",
    "cursorai.action.acceptAndRunGenerateInTerminal",
    "cursorai.action.rejectGenerateInTerminal",
    "cursorai.action.switchToModel",
    "cursorai.action.switchToModelSlug",
    "cursorai.action.addModelToSwitcher",
  ];
  for (const id of ids) {
    it(`registers ${id}`, () => {
      assert.ok(
        src.includes(`static readonly ID = '${id}'`),
        `missing verbatim id ${id}`,
      );
      assert.ok(
        src.includes(`registerAction2(`) && classBodyFor(id).length > 0,
        `no class body for ${id}`,
      );
    });
  }

  it("registers all nine via registerAction2 in registerTerminalCmdkActions", () => {
    const fnStart = src.indexOf("export function registerTerminalCmdkActions");
    assert.ok(fnStart >= 0, "missing registerTerminalCmdkActions");
    const fnBody = src.slice(fnStart);
    for (const id of ids) {
      const before = src.slice(0, src.indexOf(`static readonly ID = '${id}'`));
      const className = before.match(/class (\w+) extends Action2/g)?.pop()?.match(/class (\w+)/)?.[1];
      assert.ok(
        className && fnBody.includes(`registerAction2(${className})`),
        `${id} (${className}) not registered in registerTerminalCmdkActions`,
      );
    }
  });

  it("does NOT register glass-only cursorai.action.switchToModelSlugInGlass", () => {
    assert.ok(
      !src.includes("static readonly ID = 'cursorai.action.switchToModelSlugInGlass'"),
      "glass-only switchToModelSlugInGlass must not be registered in the desktop build",
    );
  });

  it("old composer.terminalAiCommand is removed (renamed, not duplicated)", () => {
    assert.ok(
      !composerActionsSrc.includes("static readonly ID = 'composer.terminalAiCommand'"),
      "composer.terminalAiCommand still registered — must be replaced by the verbatim family",
    );
  });
});

describe("terminal-ai-cmdk: verbatim titles", () => {
  const titles: Array<[string, string]> = [
    ["cursorai.action.generateInTerminal", "Generate in Terminal"],
    ["cursorai.action.hideGenerateInTerminal", "Hide Prompt Bar"],
    ["cursorai.action.cancelGenerateInTerminal", "Cancel Generation"],
    ["cursorai.action.acceptGenerateInTerminal", "Accept Generated Command"],
    ["cursorai.action.acceptAndRunGenerateInTerminal", "Accept & Run Generated Command"],
    ["cursorai.action.rejectGenerateInTerminal", "Reject Generated Command"],
    ["cursorai.action.switchToModel", "Switch to model"],
    ["cursorai.action.switchToModelSlug", "Switch to Model Slug"],
    ["cursorai.action.addModelToSwitcher", "Add model to switcher"],
  ];
  for (const [id, title] of titles) {
    it(`${id} title is verbatim "${title}"`, () => {
      const body = classBodyFor(id);
      assert.ok(
        body.includes(`'${title}'`) || body.includes(`"${title}"`),
        `${id}: title "${title}" not found verbatim in its class`,
      );
    });
  }
});

describe("terminal-ai-cmdk: verbatim keybindings / weights / when-clauses", () => {
  it("generateInTerminal: CtrlCmd+K, weight 10200, when terminalFocus || promptBarVisible", () => {
    const body = classBodyFor("cursorai.action.generateInTerminal");
    assert.ok(body.includes("KeyMod.CtrlCmd | KeyCode.KeyK"), "missing CtrlCmd+K chord");
    assert.ok(
      body.includes("KeybindingWeight.WorkbenchContrib + 200"),
      "missing weight 10200 (WorkbenchContrib + 200)",
    );
    assert.ok(
      body.includes("ContextKeyExpr.or(TerminalContextKeys.focus, terminalPromptBarVisible)"),
      "missing when: terminalFocus || promptBarVisible",
    );
  });

  it("generateInTerminal: precondition terminal process supported", () => {
    const body = classBodyFor("cursorai.action.generateInTerminal");
    assert.ok(
      body.includes("precondition: TerminalContextKeys.processSupported"),
      "missing precondition TerminalContextKeys.processSupported",
    );
  });

  it("hideGenerateInTerminal: Esc, Cursor w10200 → fork WorkbenchContrib+200, when terminalFocus && promptBarVisible", () => {
    const body = classBodyFor("cursorai.action.hideGenerateInTerminal");
    assert.ok(body.includes("KeyCode.Escape"), "missing Esc keybinding");
    assert.ok(
      body.includes("KeybindingWeight.WorkbenchContrib + 200"),
      "missing weight 400 (Cursor w10200 mapped to WorkbenchContrib + 200)",
    );
    assert.ok(
      body.includes("ContextKeyExpr.and(TerminalContextKeys.focus, terminalPromptBarVisible)"),
      "missing when: terminalFocus && promptBarVisible (verbatim binary when-clause)",
    );
  });

  it("cancelGenerateInTerminal: CtrlCmd+Backspace, when promptBarCanCancelGeneration", () => {
    const body = classBodyFor("cursorai.action.cancelGenerateInTerminal");
    assert.ok(body.includes("KeyMod.CtrlCmd | KeyCode.Backspace"), "missing CtrlCmd+Backspace chord");
    assert.ok(body.includes("terminalPromptBarCanCancelGeneration"), "missing when promptBarCanCancelGeneration");
  });

  it("acceptGenerateInTerminal: CtrlCmd+Enter, when terminalFocus && promptBarVisible", () => {
    const body = classBodyFor("cursorai.action.acceptGenerateInTerminal");
    assert.ok(body.includes("KeyMod.CtrlCmd | KeyCode.Enter"), "missing CtrlCmd+Enter chord");
    assert.ok(
      body.includes("ContextKeyExpr.and(TerminalContextKeys.focus, terminalPromptBarVisible)"),
      "missing when: terminalFocus && promptBarVisible",
    );
  });

  it("acceptAndRunGenerateInTerminal: CtrlCmd+Enter, weight 10201", () => {
    const body = classBodyFor("cursorai.action.acceptAndRunGenerateInTerminal");
    assert.ok(body.includes("KeyMod.CtrlCmd | KeyCode.Enter"), "missing CtrlCmd+Enter chord");
    assert.ok(
      body.includes("KeybindingWeight.WorkbenchContrib + 201"),
      "missing weight 10201 (WorkbenchContrib + 201)",
    );
  });

  it("rejectGenerateInTerminal: CtrlCmd+Backspace, weight 10201, when promptBarCanRejectGeneration", () => {
    const body = classBodyFor("cursorai.action.rejectGenerateInTerminal");
    assert.ok(body.includes("KeyMod.CtrlCmd | KeyCode.Backspace"), "missing CtrlCmd+Backspace chord");
    assert.ok(
      body.includes("KeybindingWeight.WorkbenchContrib + 201"),
      "missing weight 10201 (WorkbenchContrib + 201)",
    );
    assert.ok(body.includes("terminalPromptBarCanRejectGeneration"), "missing when promptBarCanRejectGeneration");
  });

  it("prompt-bar context keys use the verbatim key names", () => {
    assert.ok(src.includes("new RawContextKey<boolean>('promptBarVisible'"), "promptBarVisible key name");
    assert.ok(src.includes("new RawContextKey<boolean>('promptBarCanCancelGeneration'"), "promptBarCanCancelGeneration key name");
    assert.ok(src.includes("new RawContextKey<boolean>('promptBarCanRejectGeneration'"), "promptBarCanRejectGeneration key name");
  });
});

describe("terminal-ai-cmdk: eligibility gate, localMode, telemetry", () => {
  it('eligibility gate: modelAccess("cmdk") semantic check, fail logs `Cmd-K: ${reason}`', () => {
    assert.ok(src.includes("modelAccess"), "missing modelAccess gate reference");
    assert.ok(src.includes('"cmdk"'), 'missing "cmdk" feature string');
    assert.ok(src.includes("`Cmd-K: ${"), "missing verbatim `Cmd-K: ${reason}` log format");
  });

  it("localMode short-circuits generateInTerminal (return, no-op)", () => {
    const body = classBodyFor("cursorai.action.generateInTerminal");
    assert.ok(body.includes("isLocalMode("), "missing localMode check in generateInTerminal");
  });

  it("telemetry event is verbatim `terminal.cmdk.show`", () => {
    assert.ok(src.includes("'terminal.cmdk.show'"), "missing verbatim telemetry event terminal.cmdk.show");
  });
});

describe("terminal-ai-cmdk: model switcher", () => {
  it("all three model-switcher actions are palette-hidden (f1:false)", () => {
    for (const id of [
      "cursorai.action.switchToModel",
      "cursorai.action.switchToModelSlug",
      "cursorai.action.addModelToSwitcher",
    ]) {
      const body = classBodyFor(id);
      assert.ok(body.includes("f1: false"), `${id} must be palette-hidden (f1:false)`);
    }
  });

  it("registers the composer.terminalPromptBar.setVisible bridge command", () => {
    assert.ok(
      src.includes("'composer.terminalPromptBar.setVisible'"),
      "missing bridge command composer.terminalPromptBar.setVisible",
    );
  });
});
