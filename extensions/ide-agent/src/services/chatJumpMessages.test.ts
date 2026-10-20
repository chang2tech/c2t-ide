/**
 * chatJumpMessages tests (DEV-GAPS-119 — node:test, zero extra deps).
 *
 * Pins the binary-verbatim contract dissected from Cursor 3.25.9
 * (docs/rea/work-notes-gaps119.md):
 *  - command ids / titles / webview event types (glass id table
 *    @25984888 + registrations @45371395),
 *  - the jump algorithm of composerReactTranscriptCommands.js
 *    (glass @25908293 / desk @28640600): ±2px epsilon, no wrap-around,
 *  - the `gno` when-clause predicate (glass @45335715),
 *  - the host posting helpers emit the binary's event shapes.
 *
 * Run after `tsc`:  node out/services/chatJumpMessages.test.js
 */
import { describe, it } from "node:test";
import * as assert from "node:assert";
import {
  AGENT_PANEL_SCROLL_TO_EDGE_REQUESTED,
  HUMAN_ROW_JUMP_EPSILON_PX,
  IDE_JUMP_TO_NEXT_USER_MESSAGE_ID,
  IDE_JUMP_TO_PREV_USER_MESSAGE_ID,
  IDE_SCROLL_AGENT_PANEL_TO_BOTTOM_ID,
  IDE_SCROLL_AGENT_PANEL_TO_TOP_ID,
  JUMP_TO_NEXT_USER_MESSAGE_ID,
  JUMP_TO_NEXT_USER_MESSAGE_REQUESTED,
  JUMP_TO_NEXT_USER_MESSAGE_TITLE,
  JUMP_TO_PREV_USER_MESSAGE_ID,
  JUMP_TO_PREV_USER_MESSAGE_REQUESTED,
  JUMP_TO_PREV_USER_MESSAGE_TITLE,
  SCROLL_AGENT_PANEL_TO_BOTTOM_ID,
  SCROLL_AGENT_PANEL_TO_BOTTOM_TITLE,
  SCROLL_AGENT_PANEL_TO_TOP_ID,
  SCROLL_AGENT_PANEL_TO_TOP_TITLE,
  jumpKeybindingWhenMatches,
  jumpToNextUserMessage,
  jumpToPrevUserMessage,
  pickNextHumanRowKey,
  pickPrevHumanRowKey,
  scrollAgentPanelToEdge,
  scrollTopForEdge,
  type HumanRowTarget,
} from "./chatJumpMessages";

const targets: HumanRowTarget[] = [
  { rowKey: "h1", absoluteTop: 0 },
  { rowKey: "h2", absoluteTop: 400 },
  { rowKey: "h3", absoluteTop: 950 },
  { rowKey: "h4", absoluteTop: 2000 },
];

describe("binary-verbatim ids and titles", () => {
  it("command ids match the glass id table", () => {
    assert.equal(JUMP_TO_NEXT_USER_MESSAGE_ID, "jumpToNextUserMessage");
    assert.equal(JUMP_TO_PREV_USER_MESSAGE_ID, "jumpToPrevUserMessage");
    assert.equal(SCROLL_AGENT_PANEL_TO_TOP_ID, "scrollAgentPanelToTop");
    assert.equal(SCROLL_AGENT_PANEL_TO_BOTTOM_ID, "scrollAgentPanelToBottom");
  });

  it("titles match the glass registrations", () => {
    assert.equal(JUMP_TO_NEXT_USER_MESSAGE_TITLE, "Jump to Next User Message");
    assert.equal(JUMP_TO_PREV_USER_MESSAGE_TITLE, "Jump to Previous User Message");
    assert.equal(SCROLL_AGENT_PANEL_TO_TOP_TITLE, "Scroll Agent Panel to Top");
    assert.equal(SCROLL_AGENT_PANEL_TO_BOTTOM_TITLE, "Scroll Agent Panel to Bottom");
  });

  it("runtime delegate ids are the fork ide.* layer", () => {
    assert.equal(IDE_JUMP_TO_NEXT_USER_MESSAGE_ID, "ide.jumpToNextUserMessage");
    assert.equal(IDE_JUMP_TO_PREV_USER_MESSAGE_ID, "ide.jumpToPrevUserMessage");
    assert.equal(IDE_SCROLL_AGENT_PANEL_TO_TOP_ID, "ide.scrollAgentPanelToTop");
    assert.equal(IDE_SCROLL_AGENT_PANEL_TO_BOTTOM_ID, "ide.scrollAgentPanelToBottom");
  });
});

describe("pickNextHumanRowKey (binary jumpToNextHumanMessage)", () => {
  it("from the top, jumps to the SECOND human row (first is within epsilon)", () => {
    // scrollTop 0: h1 at 0 is not > 0 + 2, so next is h2 — the binary's
    // exact behavior when the first message is already at the top.
    assert.equal(pickNextHumanRowKey(targets, 0), "h2");
  });

  it("from mid-scroll, finds the first row below scrollTop + 2", () => {
    assert.equal(pickNextHumanRowKey(targets, 500), "h3");
    assert.equal(pickNextHumanRowKey(targets, 949), "h4");
  });

  it("epsilon: a row exactly at scrollTop + 2 does not count", () => {
    assert.equal(HUMAN_ROW_JUMP_EPSILON_PX, 2);
    assert.equal(pickNextHumanRowKey(targets, 398), "h3"); // h2 at 400 == 398+2
  });

  it("past the last human row: undefined (no wrap-around)", () => {
    assert.equal(pickNextHumanRowKey(targets, 2000), undefined);
    assert.equal(pickNextHumanRowKey(targets, 5000), undefined);
  });

  it("empty transcript: undefined", () => {
    assert.equal(pickNextHumanRowKey([], 0), undefined);
  });
});

describe("pickPrevHumanRowKey (binary jumpToPrevHumanMessage)", () => {
  it("from the bottom, jumps to the last human row above", () => {
    assert.equal(pickPrevHumanRowKey(targets, 5000), "h4");
    assert.equal(pickPrevHumanRowKey(targets, 1000), "h3");
  });

  it("epsilon: a row exactly at scrollTop - 2 does not count", () => {
    assert.equal(pickPrevHumanRowKey(targets, 402), "h1"); // h2 at 400 == 402-2
    assert.equal(pickPrevHumanRowKey(targets, 403), "h2");
  });

  it("at/above the first human row: undefined (no wrap-around)", () => {
    assert.equal(pickPrevHumanRowKey(targets, 0), undefined);
    assert.equal(pickPrevHumanRowKey(targets, 2), undefined);
  });

  it("empty transcript: undefined", () => {
    assert.equal(pickPrevHumanRowKey([], 100), undefined);
  });
});

describe("scrollTopForEdge (binary scrollToEdge / scrollBy document)", () => {
  it("direction -1 goes to the very top", () => {
    assert.equal(scrollTopForEdge(-1, 3000, 600), 0);
  });

  it("direction +1 goes to the very bottom", () => {
    assert.equal(scrollTopForEdge(1, 3000, 600), 2400);
  });

  it("short transcript clamps to 0", () => {
    assert.equal(scrollTopForEdge(1, 500, 600), 0);
  });
});

describe("jumpKeybindingWhenMatches (binary gno)", () => {
  const base = {
    editorPanelFocused: false,
    terminalFocusInAny: false,
    inputFocus: false,
    promptInputEmpty: false,
  };

  it("matches when nothing is focused", () => {
    assert.equal(jumpKeybindingWhenMatches(base), true);
  });

  it("matches while the prompt has focus as long as it's empty (docs)", () => {
    assert.equal(
      jumpKeybindingWhenMatches({ ...base, inputFocus: true, promptInputEmpty: true }),
      true,
    );
  });

  it("does not match while a non-empty input has focus", () => {
    assert.equal(
      jumpKeybindingWhenMatches({ ...base, inputFocus: true, promptInputEmpty: false }),
      false,
    );
  });

  it("NF-136-1: does not match when the webview prompt is focused with a non-empty draft (host inputFocus stays false)", () => {
    // The main NF-136-1 scenario: user typing in the chat webview —
    // host stock inputFocus is false (activeElement is the iframe),
    // chatInputFocused is the first-hand signal that must block.
    assert.equal(
      jumpKeybindingWhenMatches({ ...base, inputFocus: false, chatInputFocused: true, promptInputEmpty: false }),
      false,
    );
  });

  it("NF-136-1: matches when the webview prompt is focused as long as it's empty (docs)", () => {
    assert.equal(
      jumpKeybindingWhenMatches({ ...base, inputFocus: false, chatInputFocused: true, promptInputEmpty: true }),
      true,
    );
  });

  it("does not match when the editor panel is focused", () => {
    assert.equal(jumpKeybindingWhenMatches({ ...base, editorPanelFocused: true }), false);
  });

  it("does not match when a terminal is focused (terminal owns CtrlCmd+Up/Down)", () => {
    assert.equal(jumpKeybindingWhenMatches({ ...base, terminalFocusInAny: true }), false);
  });
});

describe("host posting helpers emit the binary event shapes", () => {
  function capture() {
    const posted: unknown[] = [];
    return { posted, host: { postToWebview: (m: unknown) => void posted.push(m) } };
  }

  it("next / prev post the *Requested events verbatim", () => {
    const { posted, host } = capture();
    jumpToNextUserMessage(host);
    jumpToPrevUserMessage(host);
    assert.deepEqual(posted, [
      { type: JUMP_TO_NEXT_USER_MESSAGE_REQUESTED },
      { type: JUMP_TO_PREV_USER_MESSAGE_REQUESTED },
    ]);
    assert.equal(JUMP_TO_NEXT_USER_MESSAGE_REQUESTED, "jumpToNextUserMessageRequested");
    assert.equal(JUMP_TO_PREV_USER_MESSAGE_REQUESTED, "jumpToPrevUserMessageRequested");
  });

  it("edge posts agentPanelScrollToEdgeRequested with direction payload", () => {
    const { posted, host } = capture();
    scrollAgentPanelToEdge(host, -1);
    scrollAgentPanelToEdge(host, 1);
    assert.deepEqual(posted, [
      { type: AGENT_PANEL_SCROLL_TO_EDGE_REQUESTED, payload: { direction: -1 } },
      { type: AGENT_PANEL_SCROLL_TO_EDGE_REQUESTED, payload: { direction: 1 } },
    ]);
    assert.equal(AGENT_PANEL_SCROLL_TO_EDGE_REQUESTED, "agentPanelScrollToEdgeRequested");
  });
});
