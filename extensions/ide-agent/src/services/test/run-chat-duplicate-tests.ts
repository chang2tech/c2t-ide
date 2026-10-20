/**
 * agent-chat-duplicate tests (node:test, vscode stubbed via ./vscode-stub).
 *
 * Binary evidence (Cursor 3.25.9, workbench.glass.main.js, static literals —
 * verified 2026-10-19 against the extracted AppImage squashfs):
 * - command 'composer.duplicateChat' (command-telemetry category
 *   'chat_management': `["composer.duplicateChat","chat_management"]`)
 * - 'composer.deepCloneComposer' — internal deep-clone: fresh composer id,
 *   id remapping, orphaned headers dropped, clone timestamps = now
 * - command 'composer.duplicate_tab' — trackEvent + deepCloneComposer, name
 *   dedup via js0() ("composerForkNameUtils.js"): strip "(N) " prefix, then
 *   first free "(1) <name>", "(2) <name>", …; forkBubbleId defaults to
 *   "latest" (whole conversation retained); the new tab is opened.
 *
 * Covers:
 * - All three commands register under the evidence-backed ids.
 * - dedupeDuplicateName: Cursor's "(N) name" rule incl. prefix stripping,
 *   collision skipping, and blank-title fallback.
 * - duplicateChatTab: transcript deep-clone (fresh bubble ids,
 *   serverBubbleId cleared, toolCalls/thinking detached — a streaming
 *   source cannot mutate the clone), mode + model selection copied,
 *   queued context (text + attachments) carried over, title deduped,
 *   source tab untouched, unknown id → undefined.
 * - Command handlers: duplicateChat duplicates the active tab and reveals
 *   it; deepCloneComposer resolves the new tab id; duplicate_tab honors an
 *   explicit tab id; unknown ids show an error and create nothing.
 * - Disposal unregisters all three commands.
 *
 * Run after `tsc`:  node --test out/services/test/run-chat-duplicate-tests.js
 */
import { describe, it } from "node:test";
import * as assert from "node:assert";
import "./vscode-stub";
import { vscodeStub, windowStub } from "./vscode-stub";
import { ChatTabService } from "../chatTabService";
import type { ComposerDataService } from "../composerDataService";
import type { BubbleData } from "../../model";
import {
  duplicateChatTab,
  dedupeDuplicateName,
  registerChatDuplicateCommands,
  DUPLICATE_CHAT_COMMAND,
  DEEP_CLONE_COMPOSER_COMMAND,
  DUPLICATE_TAB_COMMAND,
} from "../chatDuplicateService";

// The shared stub doesn't implement command registration; add a registry
// for this file's tests (this file runs in its own node:test process).
const registered = new Map<string, (...args: unknown[]) => unknown>();
const stubCommands = vscodeStub.commands as unknown as {
  registerCommand(
    id: string,
    callback: (...args: unknown[]) => unknown,
  ): { dispose(): void };
};
stubCommands.registerCommand = (id, callback) => {
  registered.set(id, callback);
  return {
    dispose: () => {
      registered.delete(id);
    },
  };
};

// Capture messages for the rejection-path tests.
const errors: string[] = [];
const infos: string[] = [];
const origShowError = windowStub.showErrorMessage;
const origShowInfo = windowStub.showInformationMessage;
windowStub.showErrorMessage = (message: string) => {
  errors.push(message);
  return origShowError(message);
};
windowStub.showInformationMessage = (message: string) => {
  infos.push(message);
  return origShowInfo(message);
};

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

const fakeContext = {
  subscriptions: [] as Array<{ dispose(): void }>,
  globalState: { get: () => undefined, update: async () => undefined },
  workspaceState: { get: () => undefined, update: async () => undefined },
} as unknown as import("vscode").ExtensionContext;

let bubbleSeq = 0;
function makeBubble(overrides: Partial<BubbleData> = {}): BubbleData {
  bubbleSeq += 1;
  return {
    bubbleId: `src-bubble-${bubbleSeq}`,
    role: "human",
    mode: "agent",
    text: `message ${bubbleSeq}`,
    toolCalls: [],
    createdAt: Date.now(),
    ...overrides,
  };
}

/** Seed the tab's composer with a small realistic transcript. */
function seedTranscript(composer: ComposerDataService): BubbleData[] {
  const bubbles: BubbleData[] = [
    makeBubble({ role: "human", text: "refactor the auth module" }),
    makeBubble({
      role: "assistant",
      text: "On it.",
      serverBubbleId: "srv-1",
      thinking: { text: "plan…", durationMs: 120, done: true },
      toolCalls: [
        {
          toolCallId: "tc-1",
          kind: "read",
          title: "Read auth.ts",
          status: "done",
          description: "read file",
          outputPreview: "…",
          expanded: false,
        },
      ],
    }),
    makeBubble({ role: "human", text: "also add tests" }),
  ];
  composer.bubbles.appendBubbles(bubbles);
  return bubbles;
}

function makeTabs() {
  const tabs = new ChatTabService(fakeContext);
  return tabs;
}

describe("dedupeDuplicateName — Cursor js0 rule", () => {
  it("names the first duplicate '(1) <title>'", () => {
    assert.equal(
      dedupeDuplicateName("Refactor auth", ["Refactor auth"]),
      "(1) Refactor auth",
    );
  });

  it("skips taken numbers: '(2) <title>' when '(1)' exists", () => {
    assert.equal(
      dedupeDuplicateName("Refactor auth", [
        "Refactor auth",
        "(1) Refactor auth",
      ]),
      "(2) Refactor auth",
    );
  });

  it("strips an existing '(N) ' prefix before numbering (Cursor Bs0)", () => {
    assert.equal(
      dedupeDuplicateName("(1) Refactor auth", [
        "(1) Refactor auth",
        "(2) Refactor auth",
      ]),
      "(3) Refactor auth",
    );
  });

  it("falls back to 'New chat' for a blank source title", () => {
    assert.equal(dedupeDuplicateName("   ", []), "(1) New chat");
  });
});

describe("duplicateChatTab — deep clone", () => {
  it("registers the three evidence-backed command ids", () => {
    const tabs = makeTabs();
    const d = registerChatDuplicateCommands(fakeContext, tabs, {
      revealNewTab: async () => {},
    });
    try {
      assert.ok(registered.has(DUPLICATE_CHAT_COMMAND), "composer.duplicateChat");
      assert.ok(registered.has(DEEP_CLONE_COMPOSER_COMMAND), "composer.deepCloneComposer");
      assert.ok(registered.has(DUPLICATE_TAB_COMMAND), "composer.duplicate_tab");
      assert.equal(DUPLICATE_CHAT_COMMAND, "composer.duplicateChat");
      assert.equal(DEEP_CLONE_COMPOSER_COMMAND, "composer.deepCloneComposer");
      assert.equal(DUPLICATE_TAB_COMMAND, "composer.duplicate_tab");
    } finally {
      d.dispose();
      // W67B: every other test in this file disposes its tabs — this one
      // didn't. An undisposed ChatTabService leaves each composer's
      // CheckpointStorageCompareService scheduler armed (ref'd 15 s
      // activation timer, then a 10 min interval chain; see
      // composerDataService dispose / DEV-GAPS-25), which kept the
      // node:test child process alive forever after 16/16 passes
      // ("Promise resolution is still pending but the event loop has
      // already resolved"). Proper teardown, not process.exit().
      tabs.dispose();
    }
  });

  it("clones the transcript with fresh ids and cleared serverBubbleId", () => {
    const tabs = makeTabs();
    const source = tabs.activeTab;
    const seeded = seedTranscript(source.composer);
    const cloned = duplicateChatTab(tabs);
    assert.ok(cloned);
    const copies = cloned.tab.composer.bubbles.getAllInOrder();
    assert.equal(copies.length, seeded.length);
    // Same text, same order.
    assert.deepEqual(
      copies.map((b) => b.text),
      seeded.map((b) => b.text),
    );
    // Fresh client ids — no id is shared with the source tab.
    const sourceIds = new Set(seeded.map((b) => b.bubbleId));
    for (const c of copies) {
      assert.ok(!sourceIds.has(c.bubbleId), `id ${c.bubbleId} must be fresh`);
      assert.equal(c.serverBubbleId, undefined);
    }
    // Tool-call index rebuilt for the clone's own store.
    const withToolCall = copies.find((b) => b.toolCalls.length > 0)!;
    assert.equal(
      cloned.tab.composer.bubbles.getBubbleIdByToolCallId(
        withToolCall.toolCalls[0]!.toolCallId,
      ),
      withToolCall.bubbleId,
    );
    // Source untouched.
    assert.equal(source.composer.bubbles.getAllInOrder().length, seeded.length);
    tabs.dispose();
  });

  it("deep-detaches toolCalls/thinking — mutating the source can't corrupt the clone", () => {
    const tabs = makeTabs();
    const source = tabs.activeTab;
    const seeded = seedTranscript(source.composer);
    const cloned = duplicateChatTab(tabs);
    assert.ok(cloned);
    // Simulate the source still streaming: mutate in place.
    const srcAssistant = seeded.find((b) => b.role === "assistant")!;
    srcAssistant.thinking!.text = "MUTATED";
    srcAssistant.toolCalls[0]!.title = "MUTATED";
    const copyAssistant = cloned.tab.composer.bubbles
      .getAllInOrder()
      .find((b) => b.role === "assistant")!;
    assert.equal(copyAssistant.thinking!.text, "plan…");
    assert.equal(copyAssistant.toolCalls[0]!.title, "Read auth.ts");
    tabs.dispose();
  });

  it("copies mode, model selection, and queued context; dedupes the title", () => {
    const tabs = makeTabs();
    const source = tabs.activeTab;
    tabs.renameTab(source.id, "Refactor auth");
    source.composer.modes.setMode("plan");
    source.composer.models.setSelection({ label: "My Model", kind: "explicit" });
    seedTranscript(source.composer);
    source.composer.queue.enqueue("follow-up", "agent", [
      { uri: "file:///a.ts", name: "a.ts" },
    ]);

    const cloned = duplicateChatTab(tabs);
    assert.ok(cloned);
    assert.equal(cloned.tab.title, "(1) Refactor auth");
    assert.equal(cloned.tab.composer.modes.getMode(), "plan");
    assert.equal(cloned.tab.composer.models.getSelection().label, "My Model");
    // Detached model object.
    source.composer.models.setSelection({ label: "Other", kind: "explicit" });
    assert.equal(cloned.tab.composer.models.getSelection().label, "My Model");
    // Queue carried over with detached attachments.
    const items = cloned.tab.composer.queue.getItems();
    assert.equal(items.length, 1);
    assert.equal(items[0]!.text, "follow-up");
    assert.deepEqual(items[0]!.attachments, [{ uri: "file:///a.ts", name: "a.ts" }]);
    assert.notEqual(items[0]!.attachments, source.composer.queue.getItems()[0]!.attachments);
    // The duplicate becomes a real second tab.
    assert.equal(tabs.tabCount, 2);
    assert.notEqual(cloned.result.newTabId, cloned.result.sourceTabId);
    assert.equal(cloned.result.bubbleCount, 3);
    assert.equal(cloned.result.queuedCount, 1);
    tabs.dispose();
  });

  it("duplicating a duplicate keeps numbering unique: '(2) <title>'", () => {
    const tabs = makeTabs();
    tabs.renameTab(tabs.activeTab.id, "Refactor auth");
    const first = duplicateChatTab(tabs);
    assert.ok(first);
    assert.equal(first.tab.title, "(1) Refactor auth");
    const second = duplicateChatTab(tabs, first.result.newTabId);
    assert.ok(second);
    assert.equal(second.tab.title, "(2) Refactor auth");
    tabs.dispose();
  });

  it("returns undefined for an unknown tab id and creates nothing", () => {
    const tabs = makeTabs();
    const before = tabs.tabCount;
    assert.equal(duplicateChatTab(tabs, "nope"), undefined);
    assert.equal(tabs.tabCount, before);
    tabs.dispose();
  });

  it("clones an empty 'New chat' tab into '(1) New chat'", () => {
    const tabs = makeTabs();
    const cloned = duplicateChatTab(tabs);
    assert.ok(cloned);
    assert.equal(cloned.tab.title, "(1) New chat");
    assert.equal(cloned.result.bubbleCount, 0);
    tabs.dispose();
  });
});

describe("command handlers", () => {
  function setup() {
    errors.length = 0;
    infos.length = 0;
    const tabs = makeTabs();
    const revealed: string[] = [];
    const duplicated: Array<[string, string]> = [];
    const d = registerChatDuplicateCommands(fakeContext, tabs, {
      revealNewTab: async (_t, id) => {
        revealed.push(id);
      },
      onDuplicated: (s, n) => duplicated.push([s, n]),
    });
    return { tabs, revealed, duplicated, dispose: () => d.dispose() };
  }

  it("composer.duplicateChat duplicates the ACTIVE tab and reveals it", async () => {
    const { tabs, revealed, duplicated, dispose } = setup();
    try {
      tabs.renameTab(tabs.activeTab.id, "Active chat");
      seedTranscript(tabs.activeTab.composer);
      const handler = registered.get(DUPLICATE_CHAT_COMMAND)!;
      handler();
      await sleep(20);
      assert.equal(tabs.tabCount, 2);
      const titles = tabs.listTabs().map((t) => t.title);
      assert.ok(titles.includes("(1) Active chat"), `titles: ${titles}`);
      assert.equal(revealed.length, 1);
      assert.equal(duplicated.length, 1);
      assert.ok(infos.some((m) => m.includes("duplicated chat")));
    } finally {
      dispose();
      tabs.dispose();
    }
  });

  it("composer.deepCloneComposer resolves the new tab id without revealing", async () => {
    const { tabs, revealed, dispose } = setup();
    try {
      const handler = registered.get(DEEP_CLONE_COMPOSER_COMMAND)!;
      const newId = await handler(tabs.activeTab.id);
      assert.ok(typeof newId === "string");
      assert.ok(tabs.listTabs().some((t) => t.id === newId));
      assert.equal(revealed.length, 0);
    } finally {
      dispose();
      tabs.dispose();
    }
  });

  it("composer.duplicate_tab honors an explicit tab id", async () => {
    const { tabs, revealed, dispose } = setup();
    try {
      const other = tabs.createTab({ title: "Other" });
      seedTranscript(other.composer);
      const handler = registered.get(DUPLICATE_TAB_COMMAND)!;
      handler(other.id);
      await sleep(20);
      const titles = tabs.listTabs().map((t) => t.title);
      assert.ok(titles.includes("(1) Other"), `titles: ${titles}`);
      assert.equal(revealed.length, 1);
    } finally {
      dispose();
      tabs.dispose();
    }
  });

  it("unknown tab id: error message, no new tab", async () => {
    const { tabs, dispose } = setup();
    try {
      const before = tabs.tabCount;
      const handler = registered.get(DUPLICATE_TAB_COMMAND)!;
      handler("nope");
      await sleep(20);
      assert.equal(tabs.tabCount, before);
      assert.ok(errors.some((m) => m.includes("not found")));
    } finally {
      dispose();
      tabs.dispose();
    }
  });

  it("dispose unregisters all three commands", () => {
    const { tabs, dispose } = setup();
    try {
      assert.ok(registered.has(DUPLICATE_CHAT_COMMAND));
    } finally {
      dispose();
    }
    assert.ok(!registered.has(DUPLICATE_CHAT_COMMAND));
    assert.ok(!registered.has(DEEP_CLONE_COMPOSER_COMMAND));
    assert.ok(!registered.has(DUPLICATE_TAB_COMMAND));
    tabs.dispose();
  });
});
