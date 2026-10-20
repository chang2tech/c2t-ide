/**
 * window-layout tests (node:test) — DEV-GAPS-83 (`settings-window-layout`).
 *
 * The implementation lives in workbench core (Cursor's layer for layout
 * application), so — following the run-terminal-cmdk-tests.ts pattern —
 * these tests assert the CURRENT core sources carry the verbatim binary
 * pieces and the wiring (config registration + contribution), rather than
 * re-implementing the logic. The pure-logic behavior itself is pinned by
 * the core test suite (src/vs/workbench/contrib/composer/test/common/
 * windowLayout.test.ts).
 *
 * Binary evidence (Cursor 3.25.9 workbench.glass.main.js, self-verified
 * 2026-10-20): settings entry @28560353 (label "Window Layout",
 * description "Switch between Agent and Editor default layouts",
 * searchAliases ["layout","agent","editor","window layout"]); presets
 * defaultLayoutPresets.js @24309085; storage key
 * "cursor/agentLayout.quickMenu.lastSelectedLayoutId"; telemetry
 * "agent_layout.switch_layout".
 *
 * Run after `tsc`:  node --test out/services/test/run-window-layout-tests.js
 */
import { describe, it } from "node:test";
import * as assert from "node:assert";
import * as fs from "node:fs";
import * as path from "node:path";
import "./vscode-stub";

function coreFile(...segments: string[]): string {
  const p = path.join(
    __dirname, "..", "..", "..", "..", "..",
    "src", "vs", "workbench", "contrib", "composer", ...segments,
  );
  return fs.readFileSync(p, "utf8");
}

const commonSrc = coreFile("common", "windowLayout.ts");
const actionsSrc = coreFile("browser", "windowLayoutActions.ts");
const configSrc = coreFile("common", "composerConfiguration.ts");
const contributionSrc = coreFile("browser", "composer.contribution.ts");

describe("settings-window-layout — DEV-GAPS-83 (Cursor 3.25.9 parity)", () => {
  it("verbatim settings entry strings live in the core common module", () => {
    assert.ok(commonSrc.includes("'Window Layout'"));
    assert.ok(commonSrc.includes("'Switch between Agent and Editor default layouts'"));
    assert.ok(commonSrc.includes("['layout', 'agent', 'editor', 'window layout']"));
  });

  it("verbatim preset states (defaultLayoutPresets.js) are present", () => {
    assert.ok(commonSrc.includes("agentsVisible: true"));
    assert.ok(commonSrc.includes("sidebarLocation: 'left'"));
    assert.ok(commonSrc.includes("sidebarLocation: 'right'"));
    assert.ok(commonSrc.includes("'default-agent'"));
    assert.ok(commonSrc.includes("'default-editor'"));
    // Both presets: chat + editors visible, panel hidden (binary verbatim).
    const presetBlock = commonSrc.slice(commonSrc.indexOf("WINDOW_LAYOUT_PRESETS"));
    assert.equal((presetBlock.match(/chatVisible: true/g) ?? []).length, 2);
    assert.equal((presetBlock.match(/panelVisible: false/g) ?? []).length, 2);
  });

  it("derived value logic matches the binary picker (position 0 = editor)", () => {
    assert.ok(commonSrc.includes("sideBarPosition === 0 ? 'editor' : 'agent'"));
  });

  it("apply path stores the binary storage key with APPLICATION/USER and fires binary telemetry", () => {
    assert.ok(actionsSrc.includes("cursor/agentLayout.quickMenu.lastSelectedLayoutId") || commonSrc.includes("cursor/agentLayout.quickMenu.lastSelectedLayoutId"));
    assert.ok(actionsSrc.includes("StorageScope.APPLICATION"));
    assert.ok(actionsSrc.includes("StorageTarget.USER"));
    assert.ok(commonSrc.includes("'agent_layout.switch_layout'"));
  });

  it("apply path uses the binary-equivalent toggles + sidebar location config", () => {
    assert.ok(actionsSrc.includes("'workbench.action.toggleAuxiliaryBar'"));
    assert.ok(actionsSrc.includes("'workbench.action.togglePanel'"));
    assert.ok(actionsSrc.includes("'workbench.action.toggleSidebarVisibility'"));
    assert.ok(actionsSrc.includes("'workbench.sideBar.location'"));
    assert.ok(actionsSrc.includes("Parts.EDITOR_PART"));
  });

  it("setting is registered in IDE Code › General and the contribution is wired", () => {
    assert.ok(configSrc.includes("'ide.window.defaultLayout'"));
    assert.ok(configSrc.includes("enum: ['agent', 'editor']"));
    assert.ok(configSrc.includes("Window Layout: switch between Agent and Editor default layouts"));
    assert.ok(contributionSrc.includes("WindowLayoutContribution"));
    assert.ok(contributionSrc.includes("registerWorkbenchContribution(WindowLayoutContribution"));
  });

  it("contribution watches the config key (settings change applies the preset)", () => {
    assert.ok(actionsSrc.includes("onDidChangeConfiguration"));
    assert.ok(actionsSrc.includes("WINDOW_LAYOUT_CONFIG_KEY"));
    assert.ok(actionsSrc.includes("affectsConfiguration(WINDOW_LAYOUT_CONFIG_KEY)"));
  });
});
