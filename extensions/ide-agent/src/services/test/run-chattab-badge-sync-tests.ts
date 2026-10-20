/**
 * DEV-GAPS-14 (orange-dot-native-tabs) tests (node:test, vscode stubbed via ./vscode-stub).
 *
 * Covers the extension side of the native-tab orange dot:
 *  - diffTabBadgePushes: minimal push list (changed only, plus clearing
 *    pushes for vanished/closed tabs).
 *  - ChatTabBadgeSync: initial sync, approval pending -> true push,
 *    approval resolved -> false push, no duplicate pushes on unchanged
 *    state, closed tab -> clearing push.
 *  - Default transport calls the core bridge command
 *    `ide.chat.setEditorTabBadge` with a single `{ tabId, awaitingInput }`
 *    args object (the core command signature), and never rejects the host.
 *
 * Run after `tsc`:  node --test out/services/test/run-chattab-badge-sync-tests.js
 */
import { after, describe, it } from "node:test";
import * as assert from "node:assert";
import "./vscode-stub";
import { vscodeStub } from "./vscode-stub";
import { ChatTabService } from "../chatTabService";
import {
  ChatTabBadgeSync,
  SET_EDITOR_TAB_BADGE_COMMAND_ID,
  diffTabBadgePushes,
  type TabBadgePush,
} from "../chatTabBadgeSync";

const fakeContext = {
  subscriptions: [],
  globalState: { get: () => undefined, update: async () => undefined },
  workspaceState: { get: () => undefined, update: async () => undefined },
} as unknown as import("vscode").ExtensionContext;

// W68C: every ChatTabService created below is tracked so the file-level
// after() can dispose it. Disposing only the ChatTabBadgeSync is not
// enough: an undisposed ChatTabService leaves each tab's
// ComposerDataService alive, whose CheckpointService arms a ref'd 15 s
// activation timer (then a re-arming 10 min interval) in
// CheckpointStorageCompareService — that keeps the event loop alive
// forever after all tests pass ("Promise resolution is still pending...").
// dispose() is idempotent; same pattern as run-chattabs-tests.ts.
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

describe("diffTabBadgePushes — minimal push list", () => {
  it("empty on both sides -> no pushes", () => {
    assert.deepEqual(diffTabBadgePushes(new Map(), new Map()), []);
  });

  it("pushes new tabs, skips unchanged, pushes changed", () => {
    const current = new Map([
      ["tab-1", true],
      ["tab-2", false],
      ["tab-3", true],
    ]);
    const last = new Map([
      ["tab-1", true],
      ["tab-2", false],
      ["tab-3", false],
    ]);
    assert.deepEqual(diffTabBadgePushes(current, last), [
      { tabId: "tab-3", awaitingInput: true },
    ]);
  });

  it("pushes a clearing false for a vanished tab whose dot was on", () => {
    const current = new Map([["tab-1", false]]);
    const last = new Map([
      ["tab-1", false],
      ["tab-9", true],
    ]);
    assert.deepEqual(diffTabBadgePushes(current, last), [
      { tabId: "tab-9", awaitingInput: false },
    ]);
  });

  it("no clearing push for a vanished tab whose dot was already off", () => {
    const current = new Map([["tab-1", false]]);
    const last = new Map([
      ["tab-1", false],
      ["tab-9", false],
    ]);
    assert.deepEqual(diffTabBadgePushes(current, last), []);
  });

  it("brand-new tab awaiting input gets a true push", () => {
    assert.deepEqual(diffTabBadgePushes(new Map([["tab-7", true]]), new Map()), [
      { tabId: "tab-7", awaitingInput: true },
    ]);
  });
});

describe("ChatTabBadgeSync — drives the core bridge command", () => {
  it("initial sync pushes false for the starting tab; unchanged syncs push nothing", () => {
    const tabs = track(new ChatTabService(fakeContext));
    const pushes: TabBadgePush[] = [];
    const sync = new ChatTabBadgeSync(tabs, (p) => pushes.push(p));
    assert.deepEqual(pushes, [{ tabId: tabs.activeTab.id, awaitingInput: false }]);
    // No state change -> no further pushes.
    sync.sync();
    assert.equal(pushes.length, 1);
    sync.dispose();
  });

  it("approval pending -> true push; resolved -> false push; no duplicates", () => {
    const tabs = track(new ChatTabService(fakeContext));
    const pushes: TabBadgePush[] = [];
    const sync = new ChatTabBadgeSync(tabs, (p) => pushes.push(p));
    pushes.length = 0;

    const tab = tabs.activeTab;
    const p = tab.composer.reviews.requestApproval("tc-sync-1", "Run the tests?", ["shell"], 60000);
    void p.then(() => undefined); // resolved below
    sync.sync();
    assert.deepEqual(pushes, [{ tabId: tab.id, awaitingInput: true }]);

    // Same state again -> nothing new.
    sync.sync();
    assert.equal(pushes.length, 1);

    // User resolves -> dot clears.
    const approvalId = tab.composer.reviews.currentApproval!.approvalId;
    tab.composer.reviews.resolveApproval(approvalId, { optionId: "approve-once" });
    sync.sync();
    assert.deepEqual(pushes[1], { tabId: tab.id, awaitingInput: false });
    assert.equal(pushes.length, 2);
    sync.dispose();
  });

  it("approval request/resolve pushes via the reviews event (no manual sync)", () => {
    // Regression: reviews.requestApproval/resolveApproval do NOT go through
    // composer.onDidChange, so tabs.onDidChange alone would miss them. The
    // per-tab reviews.onDidChangeApproval subscription must drive the push.
    const tabs = track(new ChatTabService(fakeContext));
    const pushes: TabBadgePush[] = [];
    const sync = new ChatTabBadgeSync(tabs, (p) => pushes.push(p));
    pushes.length = 0;

    const tab = tabs.activeTab;
    const p = tab.composer.reviews.requestApproval("tc-sync-3", "Run?", ["shell"], 60000);
    void p.then(() => undefined); // resolved below
    assert.deepEqual(pushes, [{ tabId: tab.id, awaitingInput: true }]);

    const approvalId = tab.composer.reviews.currentApproval!.approvalId;
    tab.composer.reviews.resolveApproval(approvalId, { optionId: "approve-once" });
    assert.deepEqual(pushes[1], { tabId: tab.id, awaitingInput: false });
    assert.equal(pushes.length, 2);
    sync.dispose();
  });

  it("closed tab gets a clearing push and is forgotten", async () => {
    const tabs = track(new ChatTabService(fakeContext));
    const pushes: TabBadgePush[] = [];
    const sync = new ChatTabBadgeSync(tabs, (p) => pushes.push(p));
    pushes.length = 0;

    const bg = tabs.createTab({});
    // createTab fires tabsChanged -> the subscription pushes the new tab's
    // (not-awaiting) state on its own, no manual sync() needed.
    assert.deepEqual(pushes, [{ tabId: bg.id, awaitingInput: false }]);
    pushes.length = 0;

    const p = bg.composer.reviews.requestApproval("tc-sync-2", "Delete?", ["shell"], 60000);
    void p.then(() => undefined); // resolved below
    sync.sync();
    assert.deepEqual(pushes, [{ tabId: bg.id, awaitingInput: true }]);

    // Resolve first (clears the pending approval + its timer), then close.
    const approvalId = bg.composer.reviews.currentApproval!.approvalId;
    bg.composer.reviews.resolveApproval(approvalId, { optionId: "approve-once" });
    assert.equal(await tabs.closeTab(bg.id), true);
    sync.sync();
    assert.deepEqual(pushes[1], { tabId: bg.id, awaitingInput: false });
    // Forgotten: a further sync must not re-push for the closed tab.
    sync.sync();
    assert.equal(pushes.length, 2);
    sync.dispose();
  });

  it("closing a tab while its dot is on pushes a clearing false", async () => {
    const tabs = track(new ChatTabService(fakeContext));
    const pushes: TabBadgePush[] = [];
    const sync = new ChatTabBadgeSync(tabs, (p) => pushes.push(p));
    const bg = tabs.createTab({});
    pushes.length = 0;

    const p = bg.composer.reviews.requestApproval("tc-sync-4", "Delete?", ["shell"], 60000);
    void p.then(() => undefined); // never resolved; the timeout timer is unref'd
    // The reviews event drove the true push — no manual sync() needed.
    assert.deepEqual(pushes, [{ tabId: bg.id, awaitingInput: true }]);

    // Close while the approval is still pending -> the dot must clear.
    assert.equal(await tabs.closeTab(bg.id), true);
    assert.deepEqual(pushes[1], { tabId: bg.id, awaitingInput: false });
    // Forgotten: further syncs stay silent for the closed tab.
    sync.sync();
    assert.equal(pushes.length, 2);
    sync.dispose();
  });

  it("pushTab pushes one tab's state unconditionally (editor reopen path)", () => {
    const tabs = track(new ChatTabService(fakeContext));
    const pushes: TabBadgePush[] = [];
    const sync = new ChatTabBadgeSync(tabs, (p) => pushes.push(p));
    pushes.length = 0;

    const tab = tabs.activeTab;
    // No state change, but pushTab always pushes — a reopen needs a fresh
    // push because core drops badge state for editors that were never open.
    sync.pushTab(tab.id);
    assert.deepEqual(pushes, [{ tabId: tab.id, awaitingInput: false }]);

    // With an approval pending, pushTab reports true even with no diff.
    const p = tab.composer.reviews.requestApproval("tc-sync-5", "Run?", ["shell"], 60000);
    void p.then(() => undefined); // resolved below
    pushes.length = 0; // the reviews event already pushed true
    sync.pushTab(tab.id);
    assert.deepEqual(pushes, [{ tabId: tab.id, awaitingInput: true }]);

    const approvalId = tab.composer.reviews.currentApproval!.approvalId;
    tab.composer.reviews.resolveApproval(approvalId, { optionId: "approve-once" });
    sync.dispose();
  });

  it("reacts to ChatTabService.onDidChange without a manual sync() call", () => {
    const tabs = track(new ChatTabService(fakeContext));
    const pushes: TabBadgePush[] = [];
    const sync = new ChatTabBadgeSync(tabs, (p) => pushes.push(p));
    pushes.length = 0;
    // createTab fires tabsChanged -> the subscription re-syncs.
    const bg = tabs.createTab({});
    assert.ok(
      pushes.some((p) => p.tabId === bg.id && p.awaitingInput === false),
      "new tab state is pushed via the onDidChange subscription",
    );
    sync.dispose();
  });
});

describe("ChatTabBadgeSync — default transport", () => {
  it("calls the core bridge command with { tabId, awaitingInput } and swallows rejection", async () => {
    const commands = vscodeStub.commands as {
      calls: Array<{ command: string; args: unknown[] }>;
      impl: null | ((c: string, ...a: unknown[]) => Promise<unknown>);
    };
    commands.calls.length = 0;
    commands.impl = async () => {
      throw new Error("bridge not ready");
    };
    try {
      const tabs = track(new ChatTabService(fakeContext));
      // Default transport (no pushCommand override).
      const sync = new ChatTabBadgeSync(tabs);
      // Flush the swallowed rejection.
      await new Promise((r) => setTimeout(r, 10));
      assert.equal(commands.calls.length, 1);
      assert.equal(commands.calls[0]!.command, SET_EDITOR_TAB_BADGE_COMMAND_ID);
      assert.equal(SET_EDITOR_TAB_BADGE_COMMAND_ID, "ide.chat.setEditorTabBadge");
      assert.deepEqual(commands.calls[0]!.args, [
        { tabId: tabs.activeTab.id, awaitingInput: false },
      ]);
      sync.dispose();
    } finally {
      commands.impl = null;
      commands.calls.length = 0;
    }
  });
});

/**
 * WORKER-ORANGE-DOT-NATIVE (2026-10-20): question-pending coverage.
 *
 * The suite above exercises the approval half of "awaiting input"; these
 * tests exercise the clarifying-question half — a pending question must
 * light the native dot, and answering it must clear the dot, including via
 * the composer event relay (no manual sync()).
 */
describe("ChatTabBadgeSync — clarifying questions drive the dot", () => {
  const askQuestionViaToolCall = (composer: unknown) => {
    // Shape mirrors the engine's real ask_question_tool_call event (see the
    // passing DEV-ORANGE-DOT test in run-chattabs-tests.ts): the question
    // payload lives on `toolCall.question`, not `toolCall.askQuestion`.
    const toolCall = {
      toolCallId: "tc-badge-q",
      kind: "ask_question_tool_call",
      title: "question",
      status: "pending",
      description: "",
      outputPreview: "",
      expanded: false,
      question: {
        questionId: "q-badge",
        question: "Which scope?",
        header: "Scope",
        options: [
          { id: "opt-0", label: "Repo", description: "Whole repo" },
          { id: "opt-1", label: "File", description: "One file" },
        ],
        multiple: false,
        toolCallId: "tc-badge-q",
      },
    };
    (composer as unknown as { applyEvent: (e: unknown) => void }).applyEvent({
      type: "toolCall",
      bubbleId: "b-badge",
      toolCall,
    });
  };

  it("pending question -> true push; answered -> false push (manual sync)", () => {
    const tabs = track(new ChatTabService(fakeContext));
    const pushes: TabBadgePush[] = [];
    const sync = new ChatTabBadgeSync(tabs, (p) => pushes.push(p));
    pushes.length = 0;

    const tab = tabs.activeTab;
    // Simulate the engine asking (same pendingQuestions shape the
    // questionAsked handler populates in production).
    (
      tab.composer as unknown as { pendingQuestions: Map<string, unknown> }
    ).pendingQuestions.set("q-badge", { questionId: "q-badge" });
    assert.equal(tabs.getTabStates().find((s) => s.id === tab.id)!.questionPending, true);
    sync.sync();
    assert.deepEqual(pushes, [{ tabId: tab.id, awaitingInput: true }]);

    // Answering clears the pending question -> dot clears.
    (tab.composer as unknown as { pendingQuestions: Map<string, unknown> }).pendingQuestions.delete(
      "q-badge",
    );
    sync.sync();
    assert.deepEqual(pushes[1], { tabId: tab.id, awaitingInput: false });
    assert.equal(pushes.length, 2);
    sync.dispose();
  });

  it("questionAsked / questionAnswered flow through the composer relay (no manual sync)", () => {
    const tabs = track(new ChatTabService(fakeContext));
    const pushes: TabBadgePush[] = [];
    const sync = new ChatTabBadgeSync(tabs, (p) => pushes.push(p));
    pushes.length = 0;

    const tab = tabs.activeTab;
    askQuestionViaToolCall(tab.composer);
    // questionAsked -> composer.onDidChange -> tab relay -> tabs.onDidChange
    // -> sync: the true push happens without a manual sync() call.
    assert.ok(
      pushes.some((p) => p.tabId === tab.id && p.awaitingInput === true),
      "questionAsked drives a true push via the event relay",
    );

    // questionAnswered clears it the same way. NOTE: we clear
    // pendingQuestions directly and fire the relay event instead of calling
    // composer.answerQuestion(), because answerQuestion() starts an engine
    // turn (runTurn) that never settles in the stubbed test env and would
    // hang the test file — the composer-relay path under test here is
    // identical either way.
    (
      tab.composer as unknown as { pendingQuestions: Map<string, unknown> }
    ).pendingQuestions.delete("q-badge");
    (
      tab.composer as unknown as { emitter: { fire: (e: unknown) => void } }
    ).emitter.fire({ kind: "questionAnswered", questionId: "q-badge" });
    assert.ok(
      pushes.some((p) => p.tabId === tab.id && p.awaitingInput === false),
      "questionAnswered drives a false push via the event relay",
    );
    sync.dispose();
  });

  it("approval AND question pending together still push a single true", () => {
    const tabs = track(new ChatTabService(fakeContext));
    const pushes: TabBadgePush[] = [];
    const sync = new ChatTabBadgeSync(tabs, (p) => pushes.push(p));
    pushes.length = 0;

    const tab = tabs.activeTab;
    const p = tab.composer.reviews.requestApproval("tc-badge-both", "Run?", ["shell"], 60000);
    void p.then(() => undefined);
    (
      tab.composer as unknown as { pendingQuestions: Map<string, unknown> }
    ).pendingQuestions.set("q-badge", { questionId: "q-badge" });
    sync.sync();
    // One push, not two — the badge is a single boolean per tab.
    assert.deepEqual(pushes, [{ tabId: tab.id, awaitingInput: true }]);
    sync.dispose();
  });
});
