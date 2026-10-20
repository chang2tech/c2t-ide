/**
 * pinnedChatsCap tests (node:test, zero extra deps).
 *
 * Covers the P3 `pinned-chats-cap` fix (Cursor 3.25.9 parity): the persisted
 * pin set is capped at MAX_STORED_PINS = 75. Binary evidence
 * (QA-ADVERSARIAL 2026-10-19 22:35, Finding 2): `pinnedAgentsStorage.js`
 * persists `cursor/pinnedComposers` with max 75.
 *
 * ChatTabService pulls in ComposerDataService (which needs a real vscode
 * EventEmitter at construction), so these assertions are source-level —
 * the same approach as agents-window.test.ts: assert the cap constant and
 * that persistPins() actually enforces it.
 *
 * Run after `tsc`:  node out/services/pinnedChatsCap.test.js
 */
import { describe, it } from "node:test";
import * as assert from "node:assert";
import * as fs from "node:fs";
import * as path from "node:path";

// Compiled to out/services/pinnedChatsCap.test.js:
// EXT_ROOT = <repo>/extensions/ide-agent.
const EXT_ROOT = path.resolve(__dirname, "..", "..");
const CHAT_TAB_SERVICE_TS = path.join(EXT_ROOT, "src", "services", "chatTabService.ts");

describe("pinned chats cap (Cursor parity: max 75)", () => {
  it("MAX_STORED_PINS is 75 (binary: pinnedAgentsStorage.js cursor/pinnedComposers, max 75)", () => {
    const src = fs.readFileSync(CHAT_TAB_SERVICE_TS, "utf8");
    const m = src.match(/const MAX_STORED_PINS\s*=\s*(\d+);/);
    assert.ok(m, "MAX_STORED_PINS declaration not found in chatTabService.ts");
    assert.strictEqual(Number(m![1]), 75, `expected 75, found ${m![1]}`);
  });

  it("persistPins() enforces the cap via .slice(0, MAX_STORED_PINS)", () => {
    const src = fs.readFileSync(CHAT_TAB_SERVICE_TS, "utf8");
    const start = src.indexOf("private persistPins()");
    assert.ok(start >= 0, "persistPins() not found in chatTabService.ts");
    const block = src.slice(start, src.indexOf("}", src.indexOf("catch", start)) + 1);
    assert.ok(
      block.includes(".slice(0, MAX_STORED_PINS)"),
      "persistPins() must cap the stored pin list with .slice(0, MAX_STORED_PINS)",
    );
  });

  it("the cap carries its binary evidence comment", () => {
    const src = fs.readFileSync(CHAT_TAB_SERVICE_TS, "utf8");
    const idx = src.indexOf("MAX_STORED_PINS");
    const before = src.slice(Math.max(0, idx - 400), idx);
    assert.ok(
      /pinnedComposers/i.test(before) && /75/.test(before),
      "MAX_STORED_PINS should keep the Cursor binary evidence comment",
    );
  });
});
