/**
 * Agents Window command wiring tests (node:test, zero extra deps).
 *
 * F7 (2026-10-20): `ide.openAgentsWindow` must open/focus the IDE's dedicated
 * Agents ("glass") window via the core `ide.openOrFocusGlassWindow` command —
 * the analog of Cursor's `cursor.openOrFocusGlassWindow`. It must NEVER
 * delegate to the stock `workbench.action.openAgentsWindow` (the VS Code
 * Copilot-style agent-sessions window) — that wrong delegation was finding F7
 * (feature_id: agents-window-wrong-mechanism).
 *
 * Verifies the `ide.openAgentsWindow` handler:
 *  - registered exactly once in extension.ts;
 *  - executes the core `ide.openOrFocusGlassWindow` command exactly once;
 *  - has ZERO code references to `workbench.action.openAgentsWindow`;
 *  - forwards `agentsWindowOpenSource` (Cursor arg parity);
 *  - NEVER re-executes `ide.openAgentsWindow` (no recursive retry loop);
 *  - is declared in package.json contributes (commands + commandPalette menu)
 *    with NO `config.chat.agent.enabled` gate — that was the stock command's
 *    precondition and does not apply to the glass-window mechanism (Cursor's
 *    `cursor.openOrFocusGlassWindow` has no precondition either).
 *
 * Run after `tsc`:  node out/agents-window.test.js
 */
import { describe, it } from "node:test";
import * as assert from "node:assert";
import * as fs from "fs";
import * as path from "path";

// Compiled to out/agents-window.test.js, so the extension root is one level up.
const EXT_ROOT = path.resolve(__dirname, "..");
const EXTENSION_TS = path.join(EXT_ROOT, "src", "extension.ts");
const PACKAGE_JSON = path.join(EXT_ROOT, "package.json");

function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^\S\r\n])\/\/[^\r\n]*/gm, "$1");
}

function agentsWindowBlock(): string {
  const src = fs.readFileSync(EXTENSION_TS, "utf8");
  const start = src.indexOf("// ---- Agents Window (F7 fix 2026-10-20) ----");
  assert.ok(start >= 0, "Agents Window registration block missing in extension.ts");
  // Block runs until the next section banner (a line starting with `// ----`).
  const rest = src.slice(start + "// ---- Agents Window (F7 fix 2026-10-20) ----".length);
  const next = rest.search(/\n\s*\/\/ ----/);
  return rest.slice(0, next < 0 ? undefined : next);
}

describe("agents-window command (F7: glass-window mechanism)", () => {
  it("registers ide.openAgentsWindow exactly once", () => {
    const src = fs.readFileSync(EXTENSION_TS, "utf8");
    const hits = src.match(/registerCommand\("ide\.openAgentsWindow"/g) ?? [];
    assert.strictEqual(hits.length, 1, `expected 1 registration, found ${hits.length}`);
  });

  it("executes the core ide.openOrFocusGlassWindow command", () => {
    const block = agentsWindowBlock();
    const hits =
      block.match(/executeCommand\("ide\.openOrFocusGlassWindow"/g) ?? [];
    assert.strictEqual(hits.length, 1, `expected 1 core call, found ${hits.length}`);
  });

  it("has ZERO references to the stock workbench.action.openAgentsWindow", () => {
    const code = stripComments(fs.readFileSync(EXTENSION_TS, "utf8"));
    const hits = code.match(/workbench\.action\.openAgentsWindow/g) ?? [];
    assert.strictEqual(
      hits.length,
      0,
      `F7 regression: extension.ts still references the stock agents window (${hits.length}x)`,
    );
  });

  it("forwards agentsWindowOpenSource (Cursor arg parity)", () => {
    const block = agentsWindowBlock();
    assert.ok(
      block.includes("agentsWindowOpenSource"),
      "handler does not forward agentsWindowOpenSource",
    );
  });

  it("has no recursive retry — the handler never re-executes ide.openAgentsWindow", () => {
    const block = agentsWindowBlock();
    assert.ok(
      !block.includes('executeCommand("ide.openAgentsWindow")'),
      "handler still re-executes ide.openAgentsWindow (infinite-retry loop)",
    );
    assert.ok(
      !/["']Retry["']/.test(block),
      "handler still offers a Retry button that re-triggers the command",
    );
  });

  it("is contributed in package.json without the stock chat.agent.enabled gate", () => {
    const pkg = JSON.parse(fs.readFileSync(PACKAGE_JSON, "utf8"));
    const commands: Array<{ command: string; title: string }> =
      pkg.contributes?.commands ?? [];
    const entry = commands.find((c) => c.command === "ide.openAgentsWindow");
    assert.ok(entry, "ide.openAgentsWindow missing from contributes.commands");
    assert.strictEqual(entry.title, "Agents Window");

    const palette: Array<{ command: string; when?: string }> =
      pkg.contributes?.menus?.commandPalette ?? [];
    const menu = palette.find((m) => m.command === "ide.openAgentsWindow");
    assert.ok(menu, "ide.openAgentsWindow missing from menus.commandPalette");
    assert.ok(
      !menu.when || !menu.when.includes("chat.agent.enabled"),
      "menu must NOT be gated on config.chat.agent.enabled — that was the stock command's precondition",
    );
  });
});
