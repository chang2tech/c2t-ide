/**
 * chatWidthService tests (node:test, zero extra deps).
 *
 * Covers the Chat Width feature (ide.composer.chatMaxWidth, Settings >
 * Appearance > Agent Conversations — binary evidence: Cursor 3.25.9
 * workbench.glass.main.js QKe={label:"Chat Width",...}; docs:
 * cursor.com/docs/release-notes, 600–1600px Narrow→Wide):
 *  - normalizeChatWidth: default, boundaries, clamping, bad inputs, rounding
 *  - chatWidthCssValue: CSS length formatting
 *  - wiring (source-level, same approach as agents-window.test.ts):
 *    config registration in composerConfiguration.ts, readChatUiConfig in
 *    extension.ts, webview applyUiConfig + #messages CSS in composer.ts
 *
 * Run after `tsc`:  node out/services/chatWidthService.test.js
 */
import { describe, it } from "node:test";
import * as assert from "node:assert";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  CHAT_WIDTH_DEFAULT_PX,
  CHAT_WIDTH_MAX_PX,
  CHAT_WIDTH_MIN_PX,
  chatWidthCssValue,
  normalizeChatWidth,
} from "./chatWidthService";

// Compiled to out/services/chatWidthService.test.js:
// EXT_ROOT = <repo>/extensions/ide-agent ; REPO_ROOT = <repo>.
const EXT_ROOT = path.resolve(__dirname, "..", "..");
const REPO_ROOT = path.resolve(EXT_ROOT, "..", "..");
const CONFIG_TS = path.join(
  REPO_ROOT, "src", "vs", "workbench", "contrib", "composer", "common", "composerConfiguration.ts");
const EXTENSION_TS = path.join(EXT_ROOT, "src", "extension.ts");
const COMPOSER_TS = path.join(EXT_ROOT, "src", "components", "composer.ts");

describe("chatWidthService.normalizeChatWidth", () => {
  it("defaults to 900 for undefined", () => {
    assert.strictEqual(normalizeChatWidth(undefined), 900);
  });

  it("defaults to 900 for NaN", () => {
    assert.strictEqual(normalizeChatWidth(NaN), 900);
  });

  it("defaults to 900 for Infinity", () => {
    assert.strictEqual(normalizeChatWidth(Infinity), 900);
  });

  it("defaults to 900 for non-number values (hand-edited settings.json)", () => {
    assert.strictEqual(normalizeChatWidth("1200" as unknown as number), 900);
    assert.strictEqual(normalizeChatWidth(null), 900);
    assert.strictEqual(normalizeChatWidth({}), 900);
  });

  it("keeps the minimum 600px boundary", () => {
    assert.strictEqual(normalizeChatWidth(600), CHAT_WIDTH_MIN_PX);
  });

  it("keeps the maximum 1600px boundary", () => {
    assert.strictEqual(normalizeChatWidth(1600), CHAT_WIDTH_MAX_PX);
  });

  it("clamps values below 600 up to 600", () => {
    assert.strictEqual(normalizeChatWidth(200), 600);
    assert.strictEqual(normalizeChatWidth(0), 600);
    assert.strictEqual(normalizeChatWidth(-50), 600);
  });

  it("clamps values above 1600 down to 1600", () => {
    assert.strictEqual(normalizeChatWidth(5000), 1600);
    assert.strictEqual(normalizeChatWidth(1600.6), 1600);
  });

  it("passes in-range values through unchanged", () => {
    assert.strictEqual(normalizeChatWidth(1000), 1000);
    assert.strictEqual(normalizeChatWidth(780), 780);
  });

  it("rounds fractional values to whole px", () => {
    assert.strictEqual(normalizeChatWidth(1199.6), 1200);
  });

  it("exports the documented constants", () => {
    assert.strictEqual(CHAT_WIDTH_MIN_PX, 600);
    assert.strictEqual(CHAT_WIDTH_MAX_PX, 1600);
    assert.strictEqual(CHAT_WIDTH_DEFAULT_PX, 900);
  });
});

describe("chatWidthService.chatWidthCssValue", () => {
  it("formats the width as a px CSS length", () => {
    assert.strictEqual(chatWidthCssValue(1200), "1200px");
    assert.strictEqual(chatWidthCssValue(600), "600px");
    assert.strictEqual(chatWidthCssValue(900), "900px");
  });

  it("clamps before formatting", () => {
    assert.strictEqual(chatWidthCssValue(99999), "1600px");
    assert.strictEqual(chatWidthCssValue(1), "600px");
  });
});

describe("chat width wiring", () => {
  it("registers ide.composer.chatMaxWidth in composerConfiguration.ts (600–1600, default 900)", () => {
    const src = fs.readFileSync(CONFIG_TS, "utf8");
    assert.ok(src.includes("'ide.composer.chatMaxWidth'"), "setting id missing");
    const block = src.slice(src.indexOf("'ide.composer.chatMaxWidth'"), src.indexOf("'ide.composer.chatMaxWidth'") + 1200);
    assert.ok(/minimum:\s*600/.test(block), "minimum 600 missing");
    assert.ok(/maximum:\s*1600/.test(block), "maximum 1600 missing");
    assert.ok(/default:\s*900/.test(block), "default 900 missing");
    assert.ok(block.includes("type: 'number'"), "number type missing");
  });

  it("readChatUiConfig in extension.ts returns a normalized chatMaxWidth", () => {
    const src = fs.readFileSync(EXTENSION_TS, "utf8");
    assert.ok(src.includes("chatMaxWidth: number;"), "IdeChatUiConfig.chatMaxWidth missing");
    assert.ok(
      src.includes('chatMaxWidth: normalizeChatWidth(composer.get<unknown>("chatMaxWidth", 900))'),
      "readChatUiConfig does not normalize the setting",
    );
  });

  it("webview applyUiConfig sets --ide-chat-max-width on the body (setting change re-renders without reload)", () => {
    const src = fs.readFileSync(COMPOSER_TS, "utf8");
    assert.ok(src.includes("chatMaxWidth: 900"), "DEFAULT_UI_CONFIG.chatMaxWidth missing");
    assert.ok(
      src.includes("setProperty('--ide-chat-max-width'"),
      "applyUiConfig does not set --ide-chat-max-width",
    );
    // The live {type:'uiConfig'} message path feeds applyUiConfig.
    assert.ok(src.includes("case 'uiConfig'"), "uiConfig message handler missing");
  });

  it("#messages (conversation container) applies max-width from the CSS var", () => {
    const raw = fs.readFileSync(COMPOSER_TS, "utf8");
    // Strip /* ... */ comments first — a comment inside the rule may itself
    // contain braces (e.g. {type:'uiConfig'}), which would cut a naive
    // [^}]* match short.
    const src = raw.replace(/\/\*[\s\S]*?\*\//g, "");
    const rule = src.match(/#messages\s*\{[^}]*\}/);
    assert.ok(rule, "#messages CSS rule missing");
    assert.ok(
      rule[0].includes("max-width: var(--ide-chat-max-width"),
      "#messages does not apply --ide-chat-max-width",
    );
  });
});
