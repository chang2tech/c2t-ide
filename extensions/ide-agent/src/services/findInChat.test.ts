/**
 * findInChat host-service tests (node:test, zero extra deps).
 *
 * Cursor parity: the fork's chat surface is a webview, so the core
 * `composer.find.*` Action2 commands (binary-verbatim ids/titles/keybindings,
 * Cursor 3.25.9 workbench.glass.main.js) delegate to ide.* commands in
 * extension.ts, which call these host functions. These tests pin the
 * host → webview message protocol the chat webview's find bar understands
 * (components/composer.ts FIND-IN-CHAT):
 *   showFindInChat     → { type: "showFindInChat" }
 *   hideFindInChat     → { type: "hideFindInChat" }
 *   findNextInChat     → { type: "findNextInChat" }      (composer.find.next)
 *   findPreviousInChat → { type: "findPreviousInChat" }  (composer.find.previous)
 *
 * Run after `tsc`:  node out/services/findInChat.test.js
 */
import { describe, it } from "node:test";
import * as assert from "node:assert";
import {
  SHOW_FIND_IN_CHAT,
  HIDE_FIND_IN_CHAT,
  FIND_NEXT_IN_CHAT,
  FIND_PREVIOUS_IN_CHAT,
  FIND_BAR_STATE,
  COMPOSER_FIND_WIDGET_FOCUSED_KEY,
  GLASS_CHAT_FIND_BAR_VISIBLE_KEY,
  GLASS_CHAT_FIND_INPUT_FOCUSED_KEY,
  findBarContextUpdates,
  showFindInChat,
  hideFindInChat,
  findNextInChat,
  findPreviousInChat,
  type FindInChatHost,
} from "./findInChat";

/** Recording host: captures every message posted to the chat webview. */
function recordingHost(): { host: FindInChatHost; posted: unknown[] } {
  const posted: unknown[] = [];
  return { host: { postToWebview: (msg: unknown) => posted.push(msg) }, posted };
}

describe("find-in-chat — host service message protocol", () => {
  it("message constants match the webview's protocol strings", () => {
    assert.strictEqual(SHOW_FIND_IN_CHAT, "showFindInChat");
    assert.strictEqual(HIDE_FIND_IN_CHAT, "hideFindInChat");
    assert.strictEqual(FIND_NEXT_IN_CHAT, "findNextInChat");
    assert.strictEqual(FIND_PREVIOUS_IN_CHAT, "findPreviousInChat");
    assert.strictEqual(FIND_BAR_STATE, "findBarState");
  });

  it("showFindInChat posts exactly one {type:'showFindInChat'}", () => {
    const { host, posted } = recordingHost();
    showFindInChat(host);
    assert.deepStrictEqual(posted, [{ type: "showFindInChat" }]);
  });

  it("hideFindInChat posts exactly one {type:'hideFindInChat'}", () => {
    const { host, posted } = recordingHost();
    hideFindInChat(host);
    assert.deepStrictEqual(posted, [{ type: "hideFindInChat" }]);
  });

  it("findNextInChat posts exactly one {type:'findNextInChat'} (composer.find.next)", () => {
    const { host, posted } = recordingHost();
    findNextInChat(host);
    assert.deepStrictEqual(posted, [{ type: "findNextInChat" }]);
  });

  it("findPreviousInChat posts exactly one {type:'findPreviousInChat'} (composer.find.previous)", () => {
    const { host, posted } = recordingHost();
    findPreviousInChat(host);
    assert.deepStrictEqual(posted, [{ type: "findPreviousInChat" }]);
  });

  it("a full open → next → previous → close sequence posts the verbatim types in order", () => {
    const { host, posted } = recordingHost();
    showFindInChat(host);
    findNextInChat(host);
    findPreviousInChat(host);
    hideFindInChat(host);
    assert.deepStrictEqual(posted, [
      { type: "showFindInChat" },
      { type: "findNextInChat" },
      { type: "findPreviousInChat" },
      { type: "hideFindInChat" },
    ]);
  });
});

describe("find-in-chat — GAPS-134 pane-level context key bridge (findBarContextUpdates)", () => {
  it("context key names are the verbatim binary strings", () => {
    // Old family key (DEV-GAPS-29) + pane-level keys (Cursor 3.25.9 glass
    // @23559549/@23559590: glassChatFindBarVisible / glassChatFindInputFocused).
    assert.strictEqual(COMPOSER_FIND_WIDGET_FOCUSED_KEY, "composerFindWidgetFocused");
    assert.strictEqual(GLASS_CHAT_FIND_BAR_VISIBLE_KEY, "glassChatFindBarVisible");
    assert.strictEqual(GLASS_CHAT_FIND_INPUT_FOCUSED_KEY, "glassChatFindInputFocused");
  });

  it("open + input focused sets all three keys true", () => {
    assert.deepStrictEqual(findBarContextUpdates({ open: true, inputFocused: true }), [
      ["composerFindWidgetFocused", true],
      ["glassChatFindBarVisible", true],
      ["glassChatFindInputFocused", true],
    ]);
  });

  it("open + input blurred keeps bar visible, clears only input-focused", () => {
    assert.deepStrictEqual(findBarContextUpdates({ open: true, inputFocused: false }), [
      ["composerFindWidgetFocused", true],
      ["glassChatFindBarVisible", true],
      ["glassChatFindInputFocused", false],
    ]);
  });

  it("closed clears all three keys (stale inputFocused:true is clamped)", () => {
    assert.deepStrictEqual(findBarContextUpdates({ open: false, inputFocused: true }), [
      ["composerFindWidgetFocused", false],
      ["glassChatFindBarVisible", false],
      ["glassChatFindInputFocused", false],
    ]);
  });

  it("legacy report without inputFocused (old webview) still maintains the bar keys", () => {
    assert.deepStrictEqual(findBarContextUpdates({ open: true }), [
      ["composerFindWidgetFocused", true],
      ["glassChatFindBarVisible", true],
      ["glassChatFindInputFocused", false],
    ]);
  });
});
