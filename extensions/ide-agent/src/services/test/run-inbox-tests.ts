/**
 * DEV-CHAT-INBOX tests (node:test, vscode stubbed via ./vscode-stub).
 *
 * Covers ChatInboxService + ChatInboxTreeProvider:
 *  - Empty inbox: no items, zero counts, provider shows the empty node.
 *  - Pending tool-call approvals (HumanReviewService) surface as
 *    "approval" items with the requesting tab's title; resolving removes them.
 *  - Unanswered clarifying questions (ComposerDataService) surface as
 *    "question" items; answering removes them.
 *  - Running turns surface as "running" items (isRunning), sorted after
 *    needs-attention items.
 *  - needsAttentionCount counts approvals + questions only (never running).
 *  - onDidChange fires when approvals open/resolve and when tabs change
 *    (create/close/switch) — the inbox never shows stale closed-tab items.
 *
 * All data comes from the real services — no fabricated inbox state.
 *
 * Run after `tsc`:  node --test out/services/test/run-inbox-tests.js
 */
import { describe, it } from "node:test";
import * as assert from "node:assert";
import "./vscode-stub";
import { ChatTabService } from "../chatTabService";
import { ComposerDataService } from "../composerDataService";
import { ChatInboxService, ChatInboxItem } from "../chatInboxService";
import { ChatInboxTreeProvider, InboxTreeNode } from "../chatInboxTreeProvider";

const fakeContext = {
  subscriptions: [],
  globalState: { get: () => undefined, update: async () => undefined },
  workspaceState: { get: () => undefined, update: async () => undefined },
} as unknown as import("vscode").ExtensionContext;

/** Drive a clarifying question through the same seam run-chattabs-tests uses. */
function injectQuestion(composer: ComposerDataService, questionId: string, header: string): void {
  (composer as unknown as { applyEvent: (e: unknown) => void }).applyEvent({
    type: "toolCall",
    bubbleId: "b1",
    toolCall: {
      toolCallId: `tc-${questionId}`,
      kind: "ask_question_tool_call",
      title: "question",
      status: "pending" as const,
      description: "",
      outputPreview: "",
      expanded: false,
      question: {
        questionId,
        header,
        question: `${header}?`,
        options: [{ id: "opt-0", label: "Yes", description: "" }],
        multiple: false,
        toolCallId: `tc-${questionId}`,
      },
    },
  });
}

describe("ChatInboxService", () => {
  it("starts empty: no items, zero counts", () => {
    const tabs = new ChatTabService(fakeContext);
    const inbox = new ChatInboxService(tabs);
    try {
      assert.deepEqual(inbox.getItems(), []);
      assert.equal(inbox.needsAttentionCount, 0);
      assert.equal(inbox.runningCount, 0);
    } finally {
      inbox.dispose();
      tabs.dispose();
    }
  });

  it("lists a pending approval as a needs-attention item, then clears on resolve", () => {
    const tabs = new ChatTabService(fakeContext);
    const inbox = new ChatInboxService(tabs);
    try {
      const tab = tabs.activeTab;
      // requestApproval returns a promise the turn awaits on — do NOT await
      // here; the approval stays pending until resolved below.
      void tab.composer.reviews.requestApproval("tc-1", "Run tests", ["Needs your approval"]);
      const items = inbox.getItems();
      assert.equal(items.length, 1);
      const item: ChatInboxItem = items[0]!;
      assert.equal(item.kind, "approval");
      assert.equal(item.tabId, tab.id);
      assert.equal(item.tabTitle, tab.title);
      assert.equal(item.title, "Run tests");
      assert.equal(item.detail, "Needs your approval");
      assert.equal(inbox.needsAttentionCount, 1);
      assert.equal(inbox.runningCount, 0);
      // Resolve → the item disappears.
      tab.composer.reviews.resolveApprovalForToolCall("tc-1", { optionId: "skip" });
      assert.deepEqual(inbox.getItems(), []);
      assert.equal(inbox.needsAttentionCount, 0);
    } finally {
      inbox.dispose();
      tabs.dispose();
    }
  });

  it("lists an unanswered clarifying question, then clears on answer", () => {
    const tabs = new ChatTabService(fakeContext);
    const inbox = new ChatInboxService(tabs);
    try {
      const tab = tabs.activeTab;
      injectQuestion(tab.composer, "q-1", "Scope");
      const items = inbox.getItems();
      assert.equal(items.length, 1);
      assert.equal(items[0]!.kind, "question");
      assert.equal(items[0]!.tabId, tab.id);
      assert.equal(items[0]!.title, "Scope");
      assert.equal(items[0]!.detail, "Scope?");
      assert.equal(inbox.needsAttentionCount, 1);
      // Answer while a turn is "running" (private seam) so the answer takes
      // the steer path (stageInterruptSend) instead of starting a real
      // follow-up turn — no engine exists in the stub env, and a fire-and-
      // forget runTurn would leak async activity past the test's end.
      (tab.composer as unknown as { running: boolean }).running = true;
      assert.equal(tab.composer.answerQuestion("q-1", "opt-0"), true);
      (tab.composer as unknown as { running: boolean }).running = false;
      // The question no longer needs attention. NOTE: answering while idle
      // steers the answer as a follow-up turn (ComposerDataService), so the
      // tab may transiently show as RUNNING — real state, not a leak — hence
      // we assert on the question/needs-attention signals, not total emptiness.
      assert.deepEqual(
        inbox.getItems().filter((i) => i.kind === "question"),
        [],
      );
      assert.equal(inbox.needsAttentionCount, 0);
    } finally {
      inbox.dispose();
      tabs.dispose();
    }
  });

  it("orders approvals, then questions, then running agents", () => {
    const tabs = new ChatTabService(fakeContext);
    const inbox = new ChatInboxService(tabs);
    try {
      const tab = tabs.activeTab;
      injectQuestion(tab.composer, "q-1", "Scope");
      void tab.composer.reviews.requestApproval("tc-1", "Run tests", []);
      // Simulate a running turn (private field — test seam only).
      (tab.composer as unknown as { running: boolean }).running = true;
      const kinds = inbox.getItems().map((i) => i.kind);
      assert.deepEqual(kinds, ["approval", "question", "running"]);
      assert.equal(inbox.needsAttentionCount, 2);
      assert.equal(inbox.runningCount, 1);
    } finally {
      tabs.activeTab.composer.reviews.settleAllPending();
      inbox.dispose();
      tabs.dispose();
    }
  });

  it("attributes items to the right tab and drops closed tabs", async () => {
    const tabs = new ChatTabService(fakeContext);
    const inbox = new ChatInboxService(tabs);
    try {
      const second = tabs.createTab({ title: "Second chat" });
      void second.composer.reviews.requestApproval("tc-2", "Delete file", []);
      let items = inbox.getItems();
      assert.equal(items.length, 1);
      assert.equal(items[0]!.tabId, second.id);
      assert.equal(items[0]!.tabTitle, "Second chat");
      // Closing the tab removes its inbox items (no stale state).
      assert.equal(await tabs.closeTab(second.id), true);
      items = inbox.getItems();
      assert.deepEqual(items, []);
      assert.equal(inbox.needsAttentionCount, 0);
    } finally {
      inbox.dispose();
      tabs.dispose();
    }
  });

  it("fires onDidChange when an approval opens and resolves", () => {
    const tabs = new ChatTabService(fakeContext);
    const inbox = new ChatInboxService(tabs);
    try {
      let fires = 0;
      const sub = inbox.onDidChange(() => {
        fires += 1;
      });
      try {
        const tab = tabs.activeTab;
        void tab.composer.reviews.requestApproval("tc-1", "Run tests", []);
        assert.ok(fires >= 1, "fired when the approval opened");
        const before = fires;
        tab.composer.reviews.resolveApprovalForToolCall("tc-1", { optionId: "skip" });
        assert.ok(fires > before, "fired when the approval resolved");
      } finally {
        sub.dispose();
      }
    } finally {
      inbox.dispose();
      tabs.dispose();
    }
  });
});

describe("ChatInboxTreeProvider", () => {
  it("shows the empty node when nothing needs attention", async () => {
    const tabs = new ChatTabService(fakeContext);
    const inbox = new ChatInboxService(tabs);
    const provider = new ChatInboxTreeProvider(inbox);
    try {
      const roots = (await provider.getChildren(undefined)) ?? [];
      assert.equal(roots.length, 1);
      assert.equal(roots[0]!.node, "empty");
      const treeItem = provider.getTreeItem(roots[0]!);
      assert.match(treeItem.label as string, /caught up/);
    } finally {
      provider.dispose();
      inbox.dispose();
      tabs.dispose();
    }
  });

  it("renders Needs-attention and Running sections with real counts", async () => {
    const tabs = new ChatTabService(fakeContext);
    const inbox = new ChatInboxService(tabs);
    const provider = new ChatInboxTreeProvider(inbox);
    try {
      const tab = tabs.activeTab;
      void tab.composer.reviews.requestApproval("tc-1", "Run tests", []);
      injectQuestion(tab.composer, "q-1", "Scope");
      (tab.composer as unknown as { running: boolean }).running = true;

      const roots = ((await provider.getChildren(undefined)) ?? []) as Array<{ node: string; label?: string }>;
      assert.equal(roots.length, 2);
      assert.equal(roots[0]!.label, "Needs attention (2)");
      assert.equal(roots[1]!.label, "Running (1)");

      const attentionKids = ((await provider.getChildren(roots[0] as InboxTreeNode)) ?? []) as Array<
        Extract<InboxTreeNode, { node: "item" }>
      >;
      assert.equal(attentionKids.length, 2);
      assert.equal(attentionKids[0]!.item.kind, "approval");
      assert.equal(attentionKids[1]!.item.kind, "question");

      // Clicking an item reveals its tab via the reveal command.
      const treeItem = provider.getTreeItem(attentionKids[0]!);
      assert.equal(treeItem.command?.command, "ideAgent.inbox.revealTab");
      assert.deepEqual(treeItem.command?.arguments, [tab.id]);
    } finally {
      tabs.activeTab.composer.reviews.settleAllPending();
      provider.dispose();
      inbox.dispose();
      tabs.dispose();
    }
  });

  it("refreshes the tree when the inbox changes", async () => {
    const tabs = new ChatTabService(fakeContext);
    const inbox = new ChatInboxService(tabs);
    const provider = new ChatInboxTreeProvider(inbox);
    try {
      let fires = 0;
      const sub = provider.onDidChangeTreeData(() => {
        fires += 1;
      });
      try {
        void tabs.activeTab.composer.reviews.requestApproval("tc-1", "Run tests", []);
        assert.ok(fires >= 1, "tree refreshed when an approval opened");
      } finally {
        sub.dispose();
      }
    } finally {
      tabs.activeTab.composer.reviews.settleAllPending();
      provider.dispose();
      inbox.dispose();
      tabs.dispose();
    }
  });
});
