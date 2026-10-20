/**
 * mentionLinkToolbar tests (GAPS-131 — node:test, zero extra deps).
 *
 * Pins the binary-verbatim contract dissected from Cursor 3.25.9
 * (docs/rea/work-notes-gaps131.md):
 *  - command id/title + toolbar labels (desk @40072383, @40171210),
 *  - payload shape {x, y, link} + the y = rect.bottom + 2 offset,
 *  - the uiOverlayService show/close Promise semantics (desk @2345232),
 *  - the paste auto-parse conditions (desk @24723930): length < 2000,
 *    single URL.
 * GAPS-143 adds the NF-1 teardown-close case: a bare close (the call the
 * hosts make on surface dispose/re-resolve) resolves + clears and a
 * later show still works.
 *
 * Run after `tsc`:  node out/services/mentionLinkToolbar.test.js
 */
import { describe, it } from "node:test";
import * as assert from "node:assert";
import {
  AUTO_PARSE_LINK_MAX_LENGTH,
  CURSOR_MENTION_LINK_TOOLBAR_ID,
  HIDE_MENTION_LINK_TOOLBAR,
  IDE_MENTION_LINK_TOOLBAR_ID,
  MENTION_LINK_TOOLBAR_CLOSE,
  MENTION_LINK_TOOLBAR_OPEN,
  MENTION_LINK_TOOLBAR_OPEN_LABEL,
  MENTION_LINK_TOOLBAR_REQUEST,
  MENTION_LINK_TOOLBAR_TITLE,
  MENTION_LINK_TOOLBAR_UNLINK_LABEL,
  MENTION_LINK_TOOLBAR_Y_OFFSET_PX,
  SHOW_MENTION_LINK_TOOLBAR,
  MentionLinkToolbarController,
  isAutoParseLinkText,
  isMentionLinkToolbarPayload,
  mentionLinkToolbarPosition,
  type MentionLinkToolbarHost,
  type MentionLinkToolbarPayload,
} from "./mentionLinkToolbar";

describe("binary-verbatim ids, title and labels", () => {
  it("command ids match the binary registration", () => {
    assert.equal(CURSOR_MENTION_LINK_TOOLBAR_ID, "cursor.mentionLinkToolbar");
    assert.equal(IDE_MENTION_LINK_TOOLBAR_ID, "ide.mentionLinkToolbar");
  });

  it("title and item labels are verbatim", () => {
    assert.equal(MENTION_LINK_TOOLBAR_TITLE, "Mention Link Toolbar");
    assert.equal(MENTION_LINK_TOOLBAR_OPEN_LABEL, "Open");
    assert.equal(MENTION_LINK_TOOLBAR_UNLINK_LABEL, "Unlink");
  });

  it("message types and geometry constants match the binary", () => {
    assert.equal(MENTION_LINK_TOOLBAR_REQUEST, "mentionLinkToolbar");
    assert.equal(SHOW_MENTION_LINK_TOOLBAR, "showMentionLinkToolbar");
    assert.equal(HIDE_MENTION_LINK_TOOLBAR, "hideMentionLinkToolbar");
    assert.equal(MENTION_LINK_TOOLBAR_OPEN, "mentionLinkToolbarOpen");
    assert.equal(MENTION_LINK_TOOLBAR_CLOSE, "mentionLinkToolbarClose");
    assert.equal(MENTION_LINK_TOOLBAR_Y_OFFSET_PX, 2);
    assert.equal(AUTO_PARSE_LINK_MAX_LENGTH, 2000);
  });
});

describe("payload validation", () => {
  const good: MentionLinkToolbarPayload = { x: 10, y: 42, link: "https://example.com" };

  it("accepts the binary payload shape, with or without the fork uuid", () => {
    assert.equal(isMentionLinkToolbarPayload(good), true);
    assert.equal(isMentionLinkToolbarPayload({ ...good, uuid: "u1" }), true);
  });

  it("rejects malformed payloads", () => {
    assert.equal(isMentionLinkToolbarPayload(undefined), false);
    assert.equal(isMentionLinkToolbarPayload(null), false);
    assert.equal(isMentionLinkToolbarPayload({ ...good, x: "10" }), false);
    assert.equal(isMentionLinkToolbarPayload({ ...good, y: Number.NaN }), false);
    assert.equal(isMentionLinkToolbarPayload({ ...good, link: "" }), false);
    assert.equal(isMentionLinkToolbarPayload({ ...good, link: 7 }), false);
    assert.equal(isMentionLinkToolbarPayload({ ...good, uuid: 7 }), false);
  });

  it("position renders px strings like the binary (top=y, left=x)", () => {
    assert.deepEqual(mentionLinkToolbarPosition(good), { left: "10px", top: "42px" });
  });
});

describe("paste auto-parse predicate (desk @24723930)", () => {
  it("accepts a single http/https URL", () => {
    assert.equal(isAutoParseLinkText("https://example.com/docs"), true);
    assert.equal(isAutoParseLinkText("http://localhost:3000/a?b=1"), true);
    assert.equal(isAutoParseLinkText("  https://example.com  "), true);
  });

  it("rejects non-URLs, multi-token text and other schemes", () => {
    assert.equal(isAutoParseLinkText(""), false);
    assert.equal(isAutoParseLinkText("hello world"), false);
    assert.equal(isAutoParseLinkText("see https://example.com"), false);
    assert.equal(isAutoParseLinkText("example.com"), false);
    assert.equal(isAutoParseLinkText("ftp://example.com/file"), false);
    assert.equal(isAutoParseLinkText("/new-chat do things"), false);
  });

  it("enforces the binary length cap (< 2000)", () => {
    const base = "https://example.com/";
    const at1999 = base + "a".repeat(1999 - base.length);
    const at2000 = base + "a".repeat(2000 - base.length);
    assert.equal(at1999.length, 1999);
    assert.equal(isAutoParseLinkText(at1999), true);
    assert.equal(at2000.length, 2000);
    assert.equal(isAutoParseLinkText(at2000), false);
  });
});

describe("controller — binary show/close Promise semantics", () => {
  function makeHost(): MentionLinkToolbarHost & { messages: unknown[] } {
    const messages: unknown[] = [];
    return {
      messages,
      postToWebview(message: unknown) {
        messages.push(message);
      },
    };
  }
  const payload: MentionLinkToolbarPayload = {
    x: 3,
    y: 9,
    link: "https://example.com",
    uuid: "chip-1",
  };

  it("show posts the show message and stays pending until close", async () => {
    const host = makeHost();
    const controller = new MentionLinkToolbarController();
    let resolved = false;
    const pending = controller.showMentionLinkToolbar(host, payload).then(() => {
      resolved = true;
    });
    assert.equal(controller.isOpen, true);
    assert.deepEqual(controller.current, payload);
    assert.deepEqual(host.messages, [{ type: SHOW_MENTION_LINK_TOOLBAR, ...payload }]);
    await Promise.resolve();
    assert.equal(resolved, false);
    controller.closeMentionLinkToolbar();
    await pending;
    assert.equal(resolved, true);
    assert.equal(controller.isOpen, false);
    assert.equal(controller.current, undefined);
  });

  it("close with a host also posts the hide message; bare close does not", async () => {
    const host = makeHost();
    const controller = new MentionLinkToolbarController();
    const pending = controller.showMentionLinkToolbar(host, payload);
    controller.closeMentionLinkToolbar(host);
    await pending;
    assert.deepEqual(host.messages[1], { type: HIDE_MENTION_LINK_TOOLBAR });
  });

  it("teardown close (GAPS-143 NF-1): bare close resolves, clears, posts no hide to the dead surface, and a later show works", async () => {
    const deadHost = makeHost();
    const controller = new MentionLinkToolbarController();
    let resolved = false;
    const pending = controller.showMentionLinkToolbar(deadHost, payload).then(() => {
      resolved = true;
    });
    assert.equal(controller.isOpen, true);
    // Surface teardown calls close with NO host — exactly what
    // ChatViewProvider.onDidDispose / resolveWebviewView and
    // ChatEditorHost.dispose / resolveCustomEditor do in GAPS-143.
    controller.closeMentionLinkToolbar();
    await pending;
    assert.equal(resolved, true);
    assert.equal(controller.isOpen, false);
    assert.equal(controller.current, undefined);
    // No hide message was posted to the dead surface: only the show.
    assert.equal(deadHost.messages.length, 1);
    // A later show on a fresh surface works normally.
    const freshHost = makeHost();
    const second = controller.showMentionLinkToolbar(freshHost, { ...payload, x: 7 });
    assert.equal(controller.isOpen, true);
    assert.deepEqual(controller.current, { ...payload, x: 7 });
    assert.deepEqual(freshHost.messages, [
      { type: SHOW_MENTION_LINK_TOOLBAR, ...payload, x: 7 },
    ]);
    controller.closeMentionLinkToolbar();
    await second;
    assert.equal(controller.current, undefined);
  });

  it("close when nothing is open is a no-op (binary guard)", () => {
    const controller = new MentionLinkToolbarController();
    controller.closeMentionLinkToolbar();
    assert.equal(controller.isOpen, false);
  });

  it("a second show overwrites the resolver (binary verbatim semantics)", async () => {
    const host = makeHost();
    const controller = new MentionLinkToolbarController();
    let firstResolved = false;
    void controller.showMentionLinkToolbar(host, payload).then(() => {
      firstResolved = true;
    });
    const second = controller.showMentionLinkToolbar(host, { ...payload, x: 100 });
    assert.deepEqual(controller.current, { ...payload, x: 100 });
    controller.closeMentionLinkToolbar();
    await second;
    // The first promise's resolver was overwritten by the second show —
    // it never resolves, exactly like the binary service.
    await Promise.resolve();
    assert.equal(firstResolved, false);
  });
});
