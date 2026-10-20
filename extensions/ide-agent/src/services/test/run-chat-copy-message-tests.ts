/**
 * chat-copy-message tests (node:test, vscode stubbed via ./vscode-stub).
 *
 * DEV-GAPS-73 (`chat-copy-message`, Cursor 3.25.6 parity): the binary's
 * message action is `{label:'Copy Message', onSelect:
 * clipboardService.writeText + trackEvent('composer.copy_message') +
 * toast 'Message copied to clipboard'}`. These tests pin the three
 * VERBATIM pieces — clipboard content (the bubble's raw markdown source),
 * telemetry event name, toast text — and the no-op failure branches.
 *
 * Run after `tsc`:  node --test out/services/test/run-chat-copy-message-tests.js
 */
import { after, describe, it } from "node:test";
import * as assert from "node:assert";
import "./vscode-stub";
import { ComposerDataService } from "../composerDataService";
import {
  copyBubbleMessageToClipboard,
  COPY_MESSAGE_LABEL,
  COPY_MESSAGE_TELEMETRY_EVENT,
  COPY_MESSAGE_TOAST,
  type ChatCopyMessageSeam,
} from "../chatCopyMessageService";

const trackedDisposables = new Set<{ dispose(): void }>();
function track<T extends { dispose(): void }>(d: T): T {
  trackedDisposables.add(d);
  return d;
}
after(() => {
  for (const d of trackedDisposables) {
    try {
      d.dispose();
    } catch {
      /* teardown must never fail the run */
    }
  }
  trackedDisposables.clear();
});

class StubSeam implements ChatCopyMessageSeam {
  readonly clipboard: string[] = [];
  readonly messages: string[] = [];
  readonly events: string[] = [];
  failClipboard: Error | undefined;

  async writeClipboardText(text: string): Promise<void> {
    if (this.failClipboard) {
      throw this.failClipboard;
    }
    this.clipboard.push(text);
  }

  showInformationMessage(message: string): void {
    this.messages.push(message);
  }

  trackEvent(eventName: string): void {
    this.events.push(eventName);
  }
}

function composerWithBubble(bubbleId: string, text: string): ComposerDataService {
  const composer = track(new ComposerDataService(undefined, undefined));
  composer.bubbles.setBubbleData({
    bubbleId,
    role: "assistant",
    mode: "agent",
    text,
    toolCalls: [],
    createdAt: Date.now(),
  });
  return composer;
}

describe("chat-copy-message — DEV-GAPS-73 (Cursor 3.25.6 parity)", () => {
  it("verbatim constants match the binary (label / telemetry / toast)", () => {
    assert.equal(COPY_MESSAGE_LABEL, "Copy Message");
    assert.equal(COPY_MESSAGE_TELEMETRY_EVENT, "composer.copy_message");
    assert.equal(COPY_MESSAGE_TOAST, "Message copied to clipboard");
  });

  it("copies the bubble's raw markdown, fires the verbatim event and toast", async () => {
    const markdown = "## Plan\n\n1. Do **this**\n2. Then `that`\n";
    const composer = composerWithBubble("b1", markdown);
    const seam = new StubSeam();

    const ok = await copyBubbleMessageToClipboard(composer, "b1", seam);

    assert.equal(ok, true);
    assert.deepEqual(seam.clipboard, [markdown]);
    assert.deepEqual(seam.events, ["composer.copy_message"]);
    assert.deepEqual(seam.messages, ["Message copied to clipboard"]);
  });

  it("copies human bubbles too (chat transcript bubbles of both roles)", async () => {
    const composer = track(new ComposerDataService(undefined, undefined));
    composer.bubbles.setBubbleData({
      bubbleId: "h1",
      role: "human",
      mode: "agent",
      text: "please fix the bug",
      toolCalls: [],
      createdAt: Date.now(),
    });
    const seam = new StubSeam();

    assert.equal(await copyBubbleMessageToClipboard(composer, "h1", seam), true);
    assert.deepEqual(seam.clipboard, ["please fix the bug"]);
  });

  it("unknown bubble: no clipboard write, no telemetry, informational message", async () => {
    const composer = composerWithBubble("b1", "content");
    const seam = new StubSeam();

    const ok = await copyBubbleMessageToClipboard(composer, "nope", seam);

    assert.equal(ok, false);
    assert.deepEqual(seam.clipboard, []);
    assert.deepEqual(seam.events, []);
    assert.equal(seam.messages.length, 1);
    assert.ok(seam.messages[0]!.length > 0);
    assert.notEqual(seam.messages[0], "Message copied to clipboard");
  });

  it("empty-text bubble: no clipboard write", async () => {
    const composer = composerWithBubble("empty", "");
    const seam = new StubSeam();

    assert.equal(await copyBubbleMessageToClipboard(composer, "empty", seam), false);
    assert.deepEqual(seam.clipboard, []);
    assert.deepEqual(seam.events, []);
  });

  it("clipboard failure: reports the error, no toast, no telemetry", async () => {
    const composer = composerWithBubble("b1", "content");
    const seam = new StubSeam();
    seam.failClipboard = new Error("clipboard busy");

    const ok = await copyBubbleMessageToClipboard(composer, "b1", seam);

    assert.equal(ok, false);
    assert.deepEqual(seam.events, []);
    assert.equal(seam.messages.length, 1);
    assert.ok(seam.messages[0]!.includes("clipboard busy"));
    assert.notEqual(seam.messages[0], "Message copied to clipboard");
  });
});
