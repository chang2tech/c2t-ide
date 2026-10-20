/**
 * chat-duplicate-from-message tests (node:test, vscode stubbed via ./vscode-stub).
 *
 * Binary evidence (Cursor 3.25.9, workbench.desktop.main.js — verified
 * 2026-10-20 against the extracted squashfs, see docs in
 * chatForkFromBubble.ts):
 * - `jav` in AgentTranscriptTurnActions.js: onForkChat, tooltip "Fork
 *   Chat", label "Fork chat" / busy "Forking chat", "split" icon.
 * - command `composer.duplicateChat` (title "Fork Chat", category Cursor,
 *   f1:true) with {sourceComposerId, bubbleId}: retain headers through
 *   the selected bubble INCLUSIVE, plus the next header when it is an AI
 *   bubble; deepCloneComposer → new composer; name dedup js0()
 *   ("(N) name"); telemetry `composer.duplicate_tab`.
 *
 * Covers:
 * - computeForkPrefix: verbatim truncation semantics (inclusive + next
 *   assistant bubble), unknown id → ForkFromBubbleError, empty → error.
 * - forkTabFromBubble: new tab, js0 name dedup ("(1) X", "(2) X"), prefix
 *   transcript only, fresh bubble ids, serverBubbleId cleared, deep
 *   tool-call/thinking copies (source isolation), mode + model selection
 *   carried, queue NOT copied, source untouched.
 * - forkInfoMessage: names what was/wasn't copied.
 * - Wiring: both webview hosts (chatEditorProvider editor host +
 *   extension.ts ChatViewProvider sidebar) handle the `forkChatFromBubble`
 *   message, and the webview script posts it from a "Fork Chat" button.
 *
 * Run after `tsc`:  node --test out/services/test/run-fork-chat-from-bubble-tests.js
 */
import { after, describe, it as nodeIt, type TestContext } from "node:test";
import * as assert from "node:assert";
import * as fs from "node:fs";
import * as path from "node:path";
import "./vscode-stub";

/**
 * Failure-counting `it` wrapper (exit code must reflect real failures
 * even though the suite exits naturally once every ChatTabService is
 * disposed — see the `after()` hook below). W68C replaced this file's
 * old forced `process.exit()` escape: an undisposed ChatTabService
 * leaves each tab's ComposerDataService alive, whose CheckpointService
 * arms a ref'd 15 s activation timer (then a re-arming 10 min interval)
 * in CheckpointStorageCompareService and whose engine adapter holds
 * keep-alive sockets — the event loop never drains, so node --test's
 * file-level test hangs ("Promise resolution is still pending...").
 * Tracking every service and disposing them all in after() drains the
 * loop naturally; node:test then sets the exit code itself. Same pattern
 * as run-chattabs-tests.ts (DEV-GAPS-25/36).
 */
let failures = 0;
function it(name: string, fn: (t: TestContext) => unknown): Promise<void> {
  return nodeIt(name, async (t) => {
    try {
      await fn(t);
    } catch (err) {
      failures += 1;
      throw err;
    }
  });
}
import type { BubbleData } from "../../model";
import type { ComposerDataService } from "../composerDataService";
import { ChatTabService } from "../chatTabService";
import {
  ForkFromBubbleError,
  computeForkPrefix,
  forkInfoMessage,
  forkTabFromBubble,
  tryForkTabFromBubble,
} from "../chatForkFromBubble";

const fakeContext = {
  subscriptions: [] as Array<{ dispose(): void }>,
  globalState: { get: () => undefined, update: async () => undefined },
  workspaceState: { get: () => undefined, update: async () => undefined },
} as unknown as import("vscode").ExtensionContext;

// W68C: every ChatTabService created via makeTabs() below is tracked so
// this after() can dispose it. dispose() tears down each tab's composer
// (engine adapter sockets + the checkpoint storage-compare timers), so
// the event loop drains and the process exits on its own — no
// process.exit() needed. The failure count is still surfaced as an exit
// code: node:test would set it anyway, but we keep the guard explicit.
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
  if (failures > 0 && !process.exitCode) {
    process.exitCode = 1;
  }
});

let bubbleSeq = 0;
function makeBubble(overrides: Partial<BubbleData> = {}): BubbleData {
  bubbleSeq += 1;
  return {
    bubbleId: `b${bubbleSeq}`,
    role: "human",
    mode: "agent",
    text: `text ${bubbleSeq}`,
    toolCalls: [],
    createdAt: 1700000000000 + bubbleSeq,
    ...overrides,
  };
}

/** human / assistant / human / assistant transcript. */
function transcript(): BubbleData[] {
  bubbleSeq = 0;
  return [
    makeBubble({ role: "human", text: "first question" }),
    makeBubble({ role: "assistant", text: "first answer" }),
    makeBubble({ role: "human", text: "second question" }),
    makeBubble({ role: "assistant", text: "second answer" }),
  ];
}

function seed(composer: ComposerDataService, bubbles: BubbleData[]): BubbleData[] {
  composer.bubbles.appendBubbles(bubbles);
  return bubbles;
}

function makeTabs() {
  return track(new ChatTabService(fakeContext));
}

describe("computeForkPrefix (Cursor composer.duplicateChat semantics)", () => {
  it("fork from a human message keeps it + the following assistant reply", () => {
    const bubbles = transcript();
    const kept = computeForkPrefix(bubbles, bubbles[2]!.bubbleId);
    assert.deepStrictEqual(
      kept.map((b) => b.text),
      ["first question", "first answer", "second question", "second answer"],
    );
  });

  it("fork from an assistant message drops the following human message", () => {
    const bubbles = transcript();
    const kept = computeForkPrefix(bubbles, bubbles[1]!.bubbleId);
    assert.deepStrictEqual(
      kept.map((b) => b.text),
      ["first question", "first answer"],
    );
  });

  it("fork from the first message keeps just it + its reply", () => {
    const bubbles = transcript();
    const kept = computeForkPrefix(bubbles, bubbles[0]!.bubbleId);
    assert.deepStrictEqual(
      kept.map((b) => b.text),
      ["first question", "first answer"],
    );
  });

  it("fork from the latest bubble keeps the whole transcript", () => {
    const bubbles = transcript();
    const kept = computeForkPrefix(bubbles, bubbles[3]!.bubbleId);
    assert.strictEqual(kept.length, 4);
  });

  it("verbatim binary rule: the NEXT bubble is kept iff it is an assistant bubble", () => {
    // Two consecutive assistant bubbles (multi-step turn): binary checks
    // only Y.type===Tr.AI on the next header, so the second assistant
    // bubble is retained even though the selected one is already AI.
    bubbleSeq = 0;
    const bubbles = [
      makeBubble({ role: "human", text: "q" }),
      makeBubble({ role: "assistant", text: "a1" }),
      makeBubble({ role: "assistant", text: "a2" }),
      makeBubble({ role: "human", text: "q2" }),
    ];
    const kept = computeForkPrefix(bubbles, bubbles[1]!.bubbleId);
    assert.deepStrictEqual(
      kept.map((b) => b.text),
      ["q", "a1", "a2"],
    );
  });

  it("human message with no following reply keeps just itself", () => {
    bubbleSeq = 0;
    const bubbles = [
      makeBubble({ role: "human", text: "q1" }),
      makeBubble({ role: "assistant", text: "a1" }),
      makeBubble({ role: "human", text: "unanswered" }),
    ];
    const kept = computeForkPrefix(bubbles, bubbles[2]!.bubbleId);
    assert.deepStrictEqual(
      kept.map((b) => b.text),
      ["q1", "a1", "unanswered"],
    );
  });

  it("unknown bubble id throws ForkFromBubbleError", () => {
    assert.throws(
      () => computeForkPrefix(transcript(), "nope"),
      (err) =>
        err instanceof ForkFromBubbleError &&
        /not found/.test(err.message),
    );
  });

  it("empty transcript throws ForkFromBubbleError", () => {
    assert.throws(
      () => computeForkPrefix([], "x"),
      (err) =>
        err instanceof ForkFromBubbleError &&
        /no messages/.test(err.message),
    );
  });
});

describe("forkTabFromBubble (deep-clone into a new tab)", () => {
  function setup() {
    const tabs = makeTabs();
    const source = tabs.createTab({ title: "auth work", mode: "agent" });
    const bubbles = seed(source.composer, [
      makeBubble({ role: "human", text: "first question" }),
      makeBubble({
        role: "assistant",
        text: "first answer",
        serverBubbleId: "srv-9",
        thinking: { text: "plan…", durationMs: 40, done: true },
        toolCalls: [
          {
            toolCallId: "tc-7",
            kind: "read",
            title: "Read auth.ts",
            status: "done",
            description: "read",
            outputPreview: "…",
            expanded: false,
          },
        ],
      }),
      makeBubble({ role: "human", text: "second question" }),
      makeBubble({ role: "assistant", text: "second answer" }),
    ]);
    source.composer.queue.enqueue("queued later", "agent");
    return { tabs, source, bubbles };
  }

  it("creates a new tab with the js0-deduped name and only the prefix transcript", () => {
    const { tabs, source, bubbles } = setup();
    const result = forkTabFromBubble(tabs, source, bubbles[1]!.bubbleId);
    assert.strictEqual(result.tab.title, "(1) auth work");
    assert.strictEqual(result.sourceTabId, source.id);
    assert.strictEqual(result.retainedCount, 2);
    const forkBubbles = result.tab.composer.bubbles.getAllInOrder();
    assert.deepStrictEqual(
      forkBubbles.map((b) => b.text),
      ["first question", "first answer"],
    );
    // A second fork of the same tab takes the next free "(N)" name.
    const again = forkTabFromBubble(tabs, source, bubbles[3]!.bubbleId);
    assert.strictEqual(again.tab.title, "(2) auth work");
  });

  it("issues fresh bubble ids and clears serverBubbleId", () => {
    const { tabs, source, bubbles } = setup();
    const result = forkTabFromBubble(tabs, source, bubbles[1]!.bubbleId);
    const forkBubbles = result.tab.composer.bubbles.getAllInOrder();
    const sourceIds = new Set(bubbles.map((b) => b.bubbleId));
    for (const b of forkBubbles) {
      assert.ok(!sourceIds.has(b.bubbleId), "fork must not reuse source ids");
      assert.strictEqual(b.serverBubbleId, undefined);
    }
    // Fork ids are unique within the fork.
    const forkIds = forkBubbles.map((b) => b.bubbleId);
    assert.strictEqual(new Set(forkIds).size, forkIds.length);
  });

  it("deep-copies thinking and tool calls — a streaming source cannot corrupt the fork", () => {
    const { tabs, source, bubbles } = setup();
    const result = forkTabFromBubble(tabs, source, bubbles[1]!.bubbleId);
    const forkAnswer = result.tab.composer.bubbles
      .getAllInOrder()
      .find((b) => b.text === "first answer")!;
    assert.notStrictEqual(forkAnswer.thinking, bubbles[1]!.thinking);
    assert.deepStrictEqual(forkAnswer.thinking, bubbles[1]!.thinking);
    assert.notStrictEqual(forkAnswer.toolCalls[0], bubbles[1]!.toolCalls[0]);
    // Mutating the fork does not touch the source.
    forkAnswer.toolCalls[0]!.status = "running";
    forkAnswer.thinking!.text = "changed";
    assert.strictEqual(bubbles[1]!.toolCalls[0]!.status, "done");
    assert.strictEqual(bubbles[1]!.thinking!.text, "plan…");
  });

  it("leaves the source tab completely untouched", () => {
    const { tabs, source, bubbles } = setup();
    const before = bubbles.map((b) => `${b.bubbleId}:${b.text}`).join("|");
    forkTabFromBubble(tabs, source, bubbles[1]!.bubbleId);
    const after = source.composer.bubbles
      .getAllInOrder()
      .map((b) => `${b.bubbleId}:${b.text}`)
      .join("|");
    assert.strictEqual(after, before);
    assert.strictEqual(
      source.composer.bubbles.getAllInOrder().length,
      4,
    );
  });

  it("carries mode + model selection but NOT the pending queue", () => {
    const { tabs, source, bubbles } = setup();
    const result = forkTabFromBubble(tabs, source, bubbles[3]!.bubbleId);
    assert.strictEqual(
      result.tab.composer.modes.getMode(),
      source.composer.modes.getMode(),
    );
    assert.deepStrictEqual(
      result.tab.composer.models.getSelection(),
      source.composer.models.getSelection(),
    );
    assert.strictEqual(
      result.tab.composer.queue.getItems().length,
      0,
      "the pending queue stays with the source tab",
    );
  });

  it("unknown bubble id throws ForkFromBubbleError and creates no tab", () => {
    const { tabs, source } = setup();
    const before = tabs.listTabs().length;
    assert.throws(
      () => forkTabFromBubble(tabs, source, "nope"),
      ForkFromBubbleError,
    );
    assert.strictEqual(tabs.listTabs().length, before);
  });
});

describe("forkInfoMessage", () => {
  it("names the retained count and says the queue stays behind", () => {
    const msg = forkInfoMessage({
      tab: undefined as never,
      retainedCount: 3,
      sourceTabId: "x",
    });
    assert.match(msg, /3 message\(s\) copied/);
    assert.match(msg, /Pending queued messages stay/);
  });
});

describe("tryForkTabFromBubble", () => {
  it("returns the result on success", async () => {
    const tabs = makeTabs();
    const source = tabs.createTab({ title: "t" });
    seed(source.composer, transcript());
    const id = source.composer.bubbles.getAllInOrder()[0]!.bubbleId;
    const result = await tryForkTabFromBubble(tabs, source, id);
    assert.ok(result);
    assert.strictEqual(result!.retainedCount, 2);
  });
});

describe("wiring: webview + both hosts post/handle forkChatFromBubble", () => {
  const srcDir = path.resolve(__dirname, "..", "..", "..", "src");
  const read = (rel: string) => fs.readFileSync(path.join(srcDir, rel), "utf8");

  it("webview bubble script posts forkChatFromBubble from a 'Fork Chat' button", () => {
    const webview = read("components/composer.ts");
    assert.ok(
      webview.includes("{ type: 'forkChatFromBubble', bubbleId: bubble.bubbleId }"),
      "webview must post forkChatFromBubble",
    );
    assert.ok(
      webview.includes("aria-label', 'Fork chat") ||
        webview.includes('aria-label", "Fork chat'),
      "button aria-label 'Fork chat' (Cursor jav: 'Fork chat')",
    );
    assert.ok(
      webview.includes("title', 'Fork Chat") ||
        webview.includes('title", "Fork Chat'),
      "button tooltip 'Fork Chat' (Cursor jav tooltip)",
    );
    assert.ok(
      webview.includes("Forking chat"),
      "busy label 'Forking chat' (Cursor jav busy state)",
    );
  });

  it("editor host (chatEditorProvider) handles forkChatFromBubble", () => {
    const host = read("services/chatEditorProvider.ts");
    assert.ok(
      host.includes('{ type: "forkChatFromBubble"; bubbleId: string }'),
      "message type declared",
    );
    assert.ok(
      host.includes('case "forkChatFromBubble":'),
      "handleMessage case exists",
    );
    assert.ok(
      host.includes("forkTabFromBubble(this.tabs, this.tab, message.bubbleId)"),
      "forks from this host's tab",
    );
  });

  it("sidebar host (extension.ts) handles forkChatFromBubble", () => {
    const ext = read("extension.ts");
    assert.ok(
      ext.includes('{ type: "forkChatFromBubble"; bubbleId: string }'),
      "sidebar message type declared",
    );
    assert.ok(
      ext.includes('case "forkChatFromBubble":'),
      "sidebar handleMessage case exists",
    );
  });

  it("binary reference (3.25.9) still carries the Fork Chat entry point", () => {
    const root =
      "/home/hatch/workspace/ide-code-mission/reference/cursor-3.25.9/squashfs-root/usr/share/cursor/resources/app/out/vs/workbench/workbench.desktop.main.js";
    if (!fs.existsSync(root)) {
      return; // reference extraction absent on this machine — skip.
    }
    const binary = fs.readFileSync(root, "utf8");
    assert.ok(
      binary.includes('title:"Fork Chat"'),
      "jav onForkChat tooltip (binary 3.25.9)",
    );
    assert.ok(
      binary.includes("Forking chat"),
      "jav busy label (binary 3.25.9)",
    );
    // EXACT command-id assertion. The previous check
    // `binary.includes("composer.duplicate")` was VACUOUS: that substring is
    // a PREFIX of the real id "composer.duplicateChat" (and of the
    // telemetry event "composer.duplicate_tab"), so the test stayed green
    // even when the documented command id was wrong. The checks below
    // escape the id and require it to STAND ALONE — not preceded or
    // followed by a word character, "_", or "$" (i.e. not a prefix or
    // suffix of a longer identifier):
    //  - if the binary carried ONLY the bare "composer.duplicate" (no
    //    "...Chat"), the positive assertion FAILS;
    //  - if the binary carried NEITHER id, both assertions FAIL;
    //  - the negative assertion proves the bare id "composer.duplicate"
    //    is NOT registered as a command (binary 3.25.9 verified
    //    2026-10-20 in workbench.desktop.main.js AND
    //    workbench.glass.main.js: "composer.duplicateChat" 2 hits,
    //    telemetry "composer.duplicate_tab" 1 hit, bare
    //    "composer.duplicate" 0 hits).
    const hasStandaloneId = (haystack: string, id: string): boolean => {
      const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      return new RegExp(
        `(?<![A-Za-z0-9_$])${escaped}(?![A-Za-z0-9_$])`,
      ).test(haystack);
    };
    assert.ok(
      hasStandaloneId(binary, "composer.duplicateChat"),
      "exact command id composer.duplicateChat (binary 3.25.9)",
    );
    assert.ok(
      !hasStandaloneId(binary, "composer.duplicate"),
      "no bare composer.duplicate command id (binary 3.25.9)",
    );
    assert.ok(
      binary.includes("forkBubbleId"),
      "forkBubbleId truncation logic (binary 3.25.9)",
    );
  });
});
