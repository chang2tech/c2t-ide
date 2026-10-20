/**
 * Find in Chat host-glue tests — node:test, zero extra deps.
 *
 * Exercises services/findInChat.ts: showFindInChat / hideFindInChat /
 * findNextInChat / findPreviousInChat must post exactly the webview message
 * types the composer's find bar listens for, and nothing else. The host in
 * extension.ts is a thin wrapper around these functions with a mockable
 * host, so this pins the protocol both sides agree on.
 *
 * DEV-GAPS-29: next/previous cover the binary-verbatim `composer.find.next`
 * / `composer.find.previous` commands ("Find Next/Previous in Chat",
 * F3/Enter and Shift+F3/Shift+Enter).
 *
 * Run after `tsc`:  node --test out/services/test/run-find-in-chat-tests.js
 */
import { describe, it } from "node:test";
import * as assert from "node:assert";
import {
  SHOW_FIND_IN_CHAT,
  HIDE_FIND_IN_CHAT,
  FIND_NEXT_IN_CHAT,
  FIND_PREVIOUS_IN_CHAT,
  FIND_BAR_STATE,
  showFindInChat,
  hideFindInChat,
  findNextInChat,
  findPreviousInChat,
  type FindInChatHost,
} from "../findInChat";

function mockHost(): { host: FindInChatHost; posted: unknown[] } {
  const posted: unknown[] = [];
  return {
    posted,
    host: {
      postToWebview: (message: unknown): void => {
        posted.push(message);
      },
    },
  };
}

describe("findInChat host protocol", () => {
  it("exposes the exact webview message types the composer listens for", () => {
    assert.strictEqual(SHOW_FIND_IN_CHAT, "showFindInChat");
    assert.strictEqual(HIDE_FIND_IN_CHAT, "hideFindInChat");
    assert.strictEqual(FIND_NEXT_IN_CHAT, "findNextInChat");
    assert.strictEqual(FIND_PREVIOUS_IN_CHAT, "findPreviousInChat");
    assert.strictEqual(FIND_BAR_STATE, "findBarState");
  });

  it("showFindInChat posts exactly one {type:'showFindInChat'} message", () => {
    const { host, posted } = mockHost();
    showFindInChat(host);
    assert.deepStrictEqual(posted, [{ type: "showFindInChat" }]);
  });

  it("hideFindInChat posts exactly one {type:'hideFindInChat'} message", () => {
    const { host, posted } = mockHost();
    hideFindInChat(host);
    assert.deepStrictEqual(posted, [{ type: "hideFindInChat" }]);
  });

  it("show then hide posts the two messages in order, nothing else", () => {
    const { host, posted } = mockHost();
    showFindInChat(host);
    hideFindInChat(host);
    assert.deepStrictEqual(posted, [{ type: "showFindInChat" }, { type: "hideFindInChat" }]);
  });

  it("findNextInChat posts exactly one {type:'findNextInChat'} message", () => {
    const { host, posted } = mockHost();
    findNextInChat(host);
    assert.deepStrictEqual(posted, [{ type: "findNextInChat" }]);
  });

  it("findPreviousInChat posts exactly one {type:'findPreviousInChat'} message", () => {
    const { host, posted } = mockHost();
    findPreviousInChat(host);
    assert.deepStrictEqual(posted, [{ type: "findPreviousInChat" }]);
  });

  it("never throws when the host accepts the message (fire-and-forget)", () => {
    const { host } = mockHost();
    assert.doesNotThrow(() => showFindInChat(host));
    assert.doesNotThrow(() => hideFindInChat(host));
    assert.doesNotThrow(() => findNextInChat(host));
    assert.doesNotThrow(() => findPreviousInChat(host));
  });
});
