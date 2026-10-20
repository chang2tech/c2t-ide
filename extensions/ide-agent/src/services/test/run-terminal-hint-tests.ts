/**
 * terminal-hint tests (node:test) — GAPS-142 (`settings-terminal-hint`).
 *
 * The implementation lives in workbench core (Cursor's layer for the
 * terminal prompt-bar contribution), so — following the
 * run-window-layout-tests.ts / run-terminal-cmdk-tests.ts pattern — these
 * tests assert the CURRENT core sources carry the verbatim binary pieces
 * and the wiring (config registration + terminal contribution + import in
 * terminal.all.ts), rather than re-implementing the logic. The pure-logic
 * behavior itself is pinned by the core test suite
 * (src/vs/workbench/contrib/terminalContrib/promptBarHint/test/common/terminalPromptBarHint.test.ts).
 *
 * Binary evidence (Cursor 3.25.9 workbench.desktop.main.js, self-verified
 * 2026-10-20; docs/rea/work-notes-gaps142.md):
 * - registry @37340021: hl("chat","terminal-hint",{label:"Terminal Hint",
 *   surface:"ide",description:"Show the Cmd/Ctrl+K hint in Terminal"})
 * - settings control @37442481: checked selector @37443354
 *   `hideTerminalTooltip===!1`; on-change writes
 *   setApplicationUserPersistentStorage("hideTerminalTooltip", !M)
 * - consumer @36726703 (`qme`, ID "terminal.promptBar"): hint text
 *   `${keybinding.getLabel()} to generate command` for
 *   `cursorai.action.generateInTerminal` (@484110); hidden when the prompt
 *   bar is visible, when hideTerminalTooltip !== false, when
 *   shellLaunchConfig.hideFromUser, or when no keybinding resolves.
 *
 * Run after `tsc`:  node --test out/services/test/run-terminal-hint-tests.js
 * (or standalone: TERMINAL_HINT_CORE_ROOT=<path to src/vs/workbench/contrib> node --test <compiled>)
 */
import { describe, it } from "node:test";
import * as assert from "node:assert";
import * as fs from "node:fs";
import * as path from "node:path";
import "./vscode-stub";

const coreRoot =
  process.env.TERMINAL_HINT_CORE_ROOT ??
  path.join(__dirname, "..", "..", "..", "..", "..", "src", "vs", "workbench", "contrib");

function coreFile(...segments: string[]): string {
  return fs.readFileSync(path.join(coreRoot, ...segments), "utf8");
}

const commonSrc = coreFile("terminalContrib", "promptBarHint", "common", "terminalPromptBarHint.ts");
const browserSrc = coreFile("terminalContrib", "promptBarHint", "browser", "terminalPromptBarHint.ts");
const contributionSrc = coreFile("terminalContrib", "promptBarHint", "browser", "terminal.promptBarHint.contribution.ts");
const cssSrc = coreFile("terminalContrib", "promptBarHint", "browser", "media", "terminalPromptBarHint.css");
const configSrc = coreFile("composer", "common", "composerConfiguration.ts");
const terminalAllSrc = coreFile("terminal", "terminal.all.ts");
const cmdkSrc = coreFile("composer", "browser", "terminalCmdkActions.ts");

describe("settings-terminal-hint — GAPS-142 (Cursor 3.25.9 parity)", () => {
  it("pure module pins Cursor's storage semantics (only exact false enables)", () => {
    assert.ok(commonSrc.includes("hideTerminalTooltip === false"));
    assert.ok(commonSrc.includes("isTerminalHintEnabledFromCursorStorage"));
    assert.ok(commonSrc.includes("'ide.terminal.showCmdkHint'"));
    assert.ok(commonSrc.includes("'cursorai.action.generateInTerminal'"));
  });

  it("hint text is the verbatim `${label} to generate command`", () => {
    assert.ok(commonSrc.includes("`${keybindingLabel} to generate command`"));
  });

  it("decision logic carries every binary guard", () => {
    assert.ok(commonSrc.includes("state.promptBarVisible"));
    assert.ok(commonSrc.includes("!state.settingEnabled"));
    assert.ok(commonSrc.includes("state.hideFromUser"));
    assert.ok(commonSrc.includes("terminalPromptBarHintText(state.keybindingLabel) !== undefined"));
  });

  it("setting is registered once, positive boolean, default false (Cursor unset = OFF)", () => {
    assert.equal((configSrc.match(/'ide\.terminal\.showCmdkHint'/g) ?? []).length, 1);
    const block = configSrc.slice(configSrc.indexOf("'ide.terminal.showCmdkHint'"));
    assert.ok(block.slice(0, 600).includes("default: false"));
    assert.ok(block.slice(0, 600).includes("Show the Cmd/Ctrl+K hint in Terminal"));
    // Sibling of the same Cursor settings group (terminal-preview-box).
    assert.ok(configSrc.indexOf("'ide.terminal.showCmdkHint'") > configSrc.indexOf("'ide.terminal.usePreviewBox'"));
  });

  it("consumer is a per-instance terminal contribution in workbench core", () => {
    assert.ok(browserSrc.includes("implements ITerminalContribution"));
    assert.ok(browserSrc.includes("static readonly ID = 'terminal.promptBarHint'"));
    assert.ok(contributionSrc.includes("registerTerminalContribution(TerminalPromptBarHintContribution.ID, TerminalPromptBarHintContribution, false)"));
    assert.ok(terminalAllSrc.includes("terminalContrib/promptBarHint/browser/terminal.promptBarHint.contribution.js"));
  });

  it("consumer re-renders on setting, keybinding and prompt-bar visibility changes", () => {
    assert.ok(browserSrc.includes("e.affectsConfiguration(TerminalPromptBarHintSettingId.ShowCmdkHint)"));
    assert.ok(browserSrc.includes("onDidUpdateKeybindings"));
    assert.ok(browserSrc.includes("TERMINAL_PROMPT_BAR_VISIBLE_CONTEXT_KEY"));
    assert.ok(browserSrc.includes("lookupKeybinding(GENERATE_IN_TERMINAL_COMMAND_ID)"));
    assert.ok(browserSrc.includes("shellLaunchConfig.hideFromUser"));
  });

  it("DOM + styles use Cursor's verbatim classes and values", () => {
    assert.ok(browserSrc.includes("'prompt-bar-container'"));
    assert.ok(browserSrc.includes("'prompt-bar-hint'"));
    assert.ok(cssSrc.includes("var(--vscode-input-placeholderForeground)"));
    assert.ok(cssSrc.includes("font-size: 10px"));
    assert.ok(cssSrc.includes("height: 20px"));
    assert.ok(cssSrc.includes("text-align: center"));
  });

  it("the advertised command is the fork's real terminal Cmd+K action", () => {
    assert.ok(cmdkSrc.includes("static readonly ID = 'cursorai.action.generateInTerminal'"));
    assert.ok(cmdkSrc.includes("KeyMod.CtrlCmd | KeyCode.KeyK"));
  });
});
