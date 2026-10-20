/**
 * DEV-CHAT-TABS tests (node:test, vscode stubbed via ./vscode-stub).
 *
 * Covers:
 *  - MessageQueueService: remove / move (reorder) / unbounded (DIG-CONTINUOUS
 *    debunked the caps and the 5-minute overdue rule — Cursor's addToQueue
 *    is unbounded with no overdue concept in the queue UI).
 *  - HumanReviewService: approve-allowlist remembered indefinitely
 *    (no TTL — DIG-CONTINUOUS debunked the 24h TTL; Cursor's mcpAllowedTools
 *    has no timestamps/expiry), shadow mode (evaluate-but-don't-enforce).
 *  - ChatTabService: create/switch/close/rename/next/prev, per-tab state
 *    isolation (bubbles/mode/queue), auto-title.
 *  - ComposerDataService.revertToCheckpoint: files-only (PRODUCT DECISION
 *    2026-10-19) — the transcript is NOT rewound.
 *  - ComposerDataService.answerQuestion: option → steer message.
 *
 * Run after `tsc`:  node --test out/services/test/run-chattabs-tests.js
 */
import { after, describe, it } from "node:test";
import * as assert from "node:assert";
import "./vscode-stub";
import { vscodeStub } from "./vscode-stub";
import { MessageQueueService } from "../messageQueueService";
import { HumanReviewService } from "../humanReviewService";
import { ComposerDataService } from "../composerDataService";
import { ChatTabService } from "../chatTabService";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * DEV-GAPS-25: every ComposerDataService / ChatTabService created below is
 * tracked so the file-level after() can dispose it. An undisposed composer
 * leaks its `bun serve` sidecar (IdeCodeEngineAdapter — engineMode defaults
 * to "sidecar", and answering a question while idle starts a real turn via
 * `void runTurn()`): the sidecar's piped stdio keeps the event loop alive, so
 * node:test hangs at file level after all suites pass ("Promise resolution is
 * still pending..."). dispose() is idempotent and kills the sidecar
 * (SIGTERM, escalated to SIGKILL).
 */
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

describe("MessageQueueService — remove/move/unbounded", () => {
  it("removes a queued message by id and fires the change event", () => {
    const q = new MessageQueueService();
    const seen: number[] = [];
    q.onDidChangeQueue((items) => seen.push(items.length));
    const a = q.enqueue("one", "agent");
    q.enqueue("two", "agent");
    assert.equal(q.remove(a.id), true);
    assert.equal(q.length, 1);
    assert.equal(q.remove("nope"), false);
    assert.deepEqual(seen, [1, 2, 1]);
  });

  it("moves a queued message up/down (reorder)", () => {
    const q = new MessageQueueService();
    const a = q.enqueue("one", "agent");
    const b = q.enqueue("two", "agent");
    const c = q.enqueue("three", "agent");
    assert.equal(q.move(b.id, -1), true);
    assert.deepEqual(
      q.getItems().map((m) => m.id),
      [b.id, a.id, c.id],
    );
    assert.equal(q.move(b.id, -1), false); // already first
    assert.equal(q.move(c.id, 1), false); // already last
    assert.equal(q.move(a.id, 1), true);
    assert.deepEqual(
      q.getItems().map((m) => m.id),
      [b.id, c.id, a.id],
    );
    assert.equal(q.move("nope", 1), false);
  });

  it("is unbounded — no message cap, no overdue concept (DIG-CONTINUOUS 2026-10-19)", () => {
    const q = new MessageQueueService();
    for (let i = 0; i < 25; i++) {
      q.enqueue(`msg-${i}`, "agent");
    }
    // Cursor's addToQueue is unbounded: all 25 stay, nothing drops.
    assert.equal(q.length, 25);
    // A message older than 5 minutes is NOT "overdue" — the overdue badge
    // was fabricated (0 hits in Cursor's queue UI); the concept is gone.
    const m = q.enqueue("stale", "agent");
    assert.equal(
      (q as unknown as { isOverdue?: unknown }).isOverdue,
      undefined,
      "isOverdue must not exist",
    );
    assert.equal(
      (MessageQueueService as unknown as { OVERDUE_MS?: unknown }).OVERDUE_MS,
      undefined,
      "OVERDUE_MS must not exist",
    );
    assert.ok(m.enqueuedAt > 0);
  });
});

describe("HumanReviewService — allowlist (no TTL)", () => {
  /** Request an approval and capture its real approvalId. */
  function request(svc: HumanReviewService, toolCallId: string, title: string) {
    let id = "";
    const sub = svc.onDidChangeApproval((req) => {
      if (req) id = req.approvalId;
    });
    const promise = svc.requestApproval(toolCallId, title, ["danger"]);
    sub.dispose();
    return { id, promise };
  }

  it("remembers approve-allowlist indefinitely (no second card)", async () => {
    const svc = new HumanReviewService();
    const { id, promise } = request(svc, "tc-1", "rm -rf /");
    assert.ok(id, "approval was requested");
    svc.resolveApproval(id, { optionId: "approve-allowlist" });
    const r1 = await promise;
    assert.deepEqual(r1, { optionId: "approve-allowlist" });
    // Same tool call auto-resolves — no card is shown.
    let cardShown = false;
    const sub = svc.onDidChangeApproval((req) => {
      if (req) cardShown = true;
    });
    const r2 = await svc.requestApproval("tc-1", "rm -rf /", ["danger"]);
    assert.deepEqual(r2, { optionId: "approve-once" });
    assert.equal(cardShown, false);
    assert.equal(svc.isAllowlisted("rm -rf /"), true);
    sub.dispose();
  });

  it("P1-1: allowlist matches across DIFFERENT request ids for the same tool identity", async () => {
    // Regression: the key was `tc-<permission-request-id>::title`, unique
    // per request — "Approve and allowlist" never suppressed a second prompt
    // in production. Now the key is the stable identity (action+resources).
    const svc = new HumanReviewService();
    let cardCount = 0;
    const sub = svc.onDidChangeApproval((req) => {
      if (req) cardCount += 1;
    });
    const p1 = svc.requestApproval("tc-req-aaa", "edit", ["danger"], undefined, undefined, "edit::src/a.ts");
    // The first card is open synchronously — resolve it as approve-allowlist.
    const cur = svc.currentApproval;
    assert.ok(cur, "first approval card is open");
    svc.resolveApproval(cur.approvalId, { optionId: "approve-allowlist" });
    await p1;
    assert.equal(cardCount, 1);
    // Second request: DIFFERENT toolCallId (new permission request id),
    // same tool identity → auto-resolves, no second card.
    const r2 = await svc.requestApproval("tc-req-bbb", "edit", ["danger"], undefined, undefined, "edit::src/a.ts");
    assert.deepEqual(r2, { optionId: "approve-once" });
    assert.equal(cardCount, 1, "no second card for the same tool identity");
    assert.equal(svc.isAllowlisted("edit::src/a.ts"), true);
    // A different resource is NOT covered.
    assert.equal(svc.isAllowlisted("edit::src/b.ts"), false);
    sub.dispose();
  });

  it("allowlist entries never expire (no TTL)", async () => {
    // DIG-CONTINUOUS debunked the 24h TTL: Cursor's mcpAllowedTools has no
    // timestamps/expiry, so entries must remain valid at any point in time.
    const svc = new HumanReviewService();
    const { id, promise } = request(svc, "tc-9", "doom");
    svc.resolveApproval(id, { optionId: "approve-allowlist" });
    await promise;
    const now = Date.now();
    assert.equal(svc.isAllowlisted("doom", now), true);
    assert.equal(svc.isAllowlisted("doom", now + 86_400_000), true);
    assert.equal(svc.isAllowlisted("doom", now + 365 * 86_400_000), true);
  });

  it("approve-once does NOT create an allowlist entry", async () => {
    const svc = new HumanReviewService();
    const { id, promise } = request(svc, "tc-2", "ls");
    svc.resolveApproval(id, { optionId: "approve-once" });
    await promise;
    assert.equal(svc.isAllowlisted("ls"), false);
  });

  it("shadow mode auto-approves without showing a card", async () => {
    const orig = vscodeStub.workspace.getConfiguration;
    (vscodeStub.workspace as { getConfiguration: unknown }).getConfiguration = () => ({
      get: (key: string, def?: unknown) =>
        key === "smart_mode_classifier_shadow_mode" ? true : def,
    });
    try {
      const svc = new HumanReviewService();
      const lines: string[] = [];
      svc.log = (l) => lines.push(l);
      let cardShown = false;
      const sub = svc.onDidChangeApproval((req) => {
        if (req) cardShown = true;
      });
      const r = await svc.requestApproval("tc-s", "shadowed tool", ["reason"]);
      assert.deepEqual(r, { optionId: "approve-once" });
      assert.equal(cardShown, false);
      assert.ok(lines.some((l) => l.includes("SHADOW")));
      sub.dispose();
    } finally {
      (vscodeStub.workspace as { getConfiguration: unknown }).getConfiguration = orig;
    }
  });
});

describe("ChatTabService", () => {
  const fakeContext = {
    subscriptions: [],
    globalState: { get: () => undefined, update: async () => undefined },
    workspaceState: { get: () => undefined, update: async () => undefined },
  } as unknown as import("vscode").ExtensionContext;

  it("starts with one tab and creates/switches tabs", () => {
    const tabs = track(new ChatTabService(fakeContext));
    assert.equal(tabs.tabCount, 1);
    const t2 = tabs.createAndActivate({ mode: "agent" });
    assert.equal(tabs.tabCount, 2);
    assert.equal(tabs.activeTab.id, t2.id);
    assert.equal(tabs.activeComposer.modes.getMode(), "agent");
    tabs.switchTab(tabs.listTabs()[0]!.id);
    assert.equal(tabs.activeTab.id, tabs.listTabs()[0]!.id);
    assert.equal(tabs.switchTab("nope"), false);
  });

  it("keeps per-tab state isolated (bubbles, mode, queue)", () => {
    const tabs = track(new ChatTabService(fakeContext));
    const first = tabs.activeTab;
    first.composer.modes.setMode("chat");
    first.composer.queue.enqueue("tab-one-msg", "chat");
    const second = tabs.createAndActivate({});
    // New tab starts clean: default mode, empty queue.
    assert.equal(second.composer.modes.getMode(), "agent");
    assert.equal(second.composer.queue.length, 0);
    // First tab's state is untouched.
    tabs.switchTab(first.id);
    assert.equal(tabs.activeComposer.modes.getMode(), "chat");
    assert.equal(tabs.activeComposer.queue.length, 1);
  });

  it("cycles next/previous with wraparound", () => {
    const tabs = track(new ChatTabService(fakeContext));
    const a = tabs.activeTab.id;
    const b = tabs.createTab({}).id;
    tabs.switchTab(a);
    assert.equal(tabs.nextTab().id, b);
    assert.equal(tabs.nextTab().id, a); // wrap
    assert.equal(tabs.previousTab().id, b); // wrap
  });

  it("renames tabs and rejects blank titles", () => {
    const tabs = track(new ChatTabService(fakeContext));
    const id = tabs.activeTab.id;
    assert.equal(tabs.renameTab(id, "  My task  "), true);
    assert.equal(tabs.activeTab.title, "My task");
    assert.equal(tabs.renameTab(id, "   "), false);
    assert.equal(tabs.activeTab.title, "My task");
    assert.equal(tabs.renameTab("nope", "x"), false);
  });

  it("auto-titles a tab from its first human message", () => {
    const tabs = track(new ChatTabService(fakeContext));
    const tab = tabs.activeTab;
    assert.equal(tab.title, "New chat");
    tab.composer.bubbles.setBubbleData({
      bubbleId: "b1",
      role: "human",
      mode: "agent",
      text: "refactor the auth module to use sessions",
      toolCalls: [],
      createdAt: Date.now(),
    });
    // Fire the composer event the tab service listens to (as runTurn does).
    (tab.composer as unknown as { emitter: { fire: (e: unknown) => void } }).emitter.fire({
      kind: "bubblesChanged",
      ids: ["b1"],
    });
    assert.ok(tab.title.startsWith("refactor the auth module"), `title was: ${tab.title}`);
  });

  it("closes tabs; closing the last one clears it instead", async () => {
    const tabs = track(new ChatTabService(fakeContext));
    const t2 = tabs.createTab({});
    assert.equal(await tabs.closeTab(t2.id), true);
    assert.equal(tabs.tabCount, 1);
    // Last tab: closeTab clears it (newChat) instead of removing.
    const only = tabs.activeTab;
    only.composer.bubbles.setBubbleData({
      bubbleId: "b9",
      role: "human",
      mode: "agent",
      text: "hello",
      toolCalls: [],
      createdAt: Date.now(),
    });
    assert.equal(await tabs.closeTab(only.id), true);
    assert.equal(tabs.tabCount, 1);
    assert.equal(only.composer.bubbles.getAllInOrder().length, 0);
  });

  it("keeps a running tab when the Close Running Tab? dialog is not confirmed", async () => {
    const tabs = track(new ChatTabService(fakeContext));
    const t2 = tabs.createTab({});
    // Simulate a running turn via the private flag through submit path is
    // heavy; instead verify the guard exists by stubbing isRunning.
    // DEV-GAPS-81: closeTab now shows Cursor's "Close Running Tab?"
    // confirm dialog instead of refusing outright — the vscode stub's
    // default answer is undefined (dialog dismissed = Cancel), so the
    // tab is kept, matching the old refusal outcome on this path.
    const running = Object.defineProperty(t2.composer, "isRunning", {
      get: () => true,
      configurable: true,
    });
    assert.equal(await tabs.closeTab(t2.id), false);
    assert.equal(tabs.tabCount, 2);
    void running;
  });

  it("forwards composer events tagged with tabId", async () => {
    const tabs = track(new ChatTabService(fakeContext));
    const t2 = tabs.createTab({});
    const seen: Array<{ tabId: string; kind: string }> = [];
    tabs.onDidChange((e) => {
      if (e.kind === "composerEvent") {
        seen.push({ tabId: e.tabId, kind: e.event.kind });
      }
    });
    t2.composer.queue.enqueue("bg", "agent");
    assert.ok(seen.some((s) => s.tabId === t2.id && s.kind === "queueChanged"));
  });
});

describe("ComposerDataService — files-only checkpoint restore", () => {
  it("does NOT rewind the transcript on restore (product decision 2026-10-19)", async () => {
    const composer = track(new ComposerDataService(undefined, undefined));
    // Seed two human bubbles + one assistant bubble.
    for (const [id, role, text] of [
      ["b1", "human", "first"],
      ["b2", "assistant", "answer one"],
      ["b3", "human", "second"],
    ] as const) {
      composer.bubbles.setBubbleData({
        bubbleId: id,
        role,
        mode: "agent",
        text,
        toolCalls: [],
        createdAt: Date.now(),
      });
    }
    // Stub the checkpoint layer: restore succeeds, files reverted.
    (composer.checkpoints as unknown as { getByBubble: unknown }).getByBubble = () => ({
      bubbleId: "b1",
    });
    (composer.checkpoints as unknown as { checkoutToCheckpoint: unknown }).checkoutToCheckpoint =
      async () => ({ reverted: ["/tmp/a.ts"], deleted: [] as string[], isSame: false });
    const removed = await composer.revertToCheckpoint("b1");
    // P3-1 (QA-CHATTABS-01): the method returns what was actually restored.
    assert.deepEqual(removed, ["/tmp/a.ts"]);
    // Transcript intact — all three bubbles survive (files-only).
    assert.deepEqual(
      composer.bubbles.getAllInOrder().map((b) => b.bubbleId),
      ["b1", "b2", "b3"],
    );
    assert.equal(composer.restoredFromBubbleId, "b1");
  });
});

describe("ComposerDataService — clarifying questions", () => {
  it("answerQuestion steers the answer into the running turn", () => {
    const composer = track(new ComposerDataService(undefined, undefined));
    // Simulate the adapter delivering a question tool call.
    const toolCall = {
      toolCallId: "tc-q",
      kind: "ask_question_tool_call",
      title: "question",
      status: "pending" as const,
      description: "",
      outputPreview: "",
      expanded: false,
      question: {
        questionId: "q-tc-q",
        header: "Scope",
        question: "Which scope?",
        options: [
          { id: "opt-0", label: "Repo", description: "Whole repo" },
          { id: "opt-1", label: "File", description: "One file" },
        ],
        multiple: false,
        toolCallId: "tc-q",
      },
    };
    let asked: unknown;
    composer.onDidChange((e) => {
      if (e.kind === "questionAsked") {
        asked = e.question;
      }
    });
    // Drive applyEvent via a fake turn event — use the public surface:
    // push the toolCall through the bubble store path by emitting directly.
    (composer as unknown as { applyEvent: (e: unknown) => void }).applyEvent({
      type: "toolCall",
      bubbleId: "b1",
      toolCall,
    });
    assert.ok(asked, "questionAsked event fired");
    // Answer while idle → runs as a new turn is out of scope here; instead
    // verify the pending question resolves and returns true.
    assert.equal(composer.answerQuestion("q-tc-q", "opt-1"), true);
    // Already answered → false.
    assert.equal(composer.answerQuestion("q-tc-q", "opt-1"), false);
    // Unknown question → false.
    assert.equal(composer.answerQuestion("nope", "opt-0"), false);
  });
});

describe("QA-CHATTABS fix regressions", () => {
  /** Build a question toolCall payload like the adapter produces. */
  function questionToolCall(id: string, multiple = false) {
    return {
      toolCallId: id,
      kind: "ask_question_tool_call",
      title: "question",
      status: "pending" as const,
      description: "",
      outputPreview: "",
      expanded: false,
      question: {
        questionId: `q-${id}`,
        header: "Scope",
        question: "Which scope?",
        options: [
          { id: "opt-0", label: "Repo", description: "Whole repo" },
          { id: "opt-1", label: "File", description: "One file" },
        ],
        multiple,
        toolCallId: id,
      },
    };
  }

  function applyQuestion(composer: ComposerDataService, id: string, multiple = false) {
    (composer as unknown as { applyEvent: (e: unknown) => void }).applyEvent({
      type: "toolCall",
      bubbleId: "b1",
      toolCall: questionToolCall(id, multiple),
    });
  }

  it("P3-3: questionAsked fires only once for a re-emitted question", () => {
    const composer = track(new ComposerDataService(undefined, undefined));
    let askedCount = 0;
    composer.onDidChange((e) => {
      if (e.kind === "questionAsked") askedCount += 1;
    });
    applyQuestion(composer, "tc-q");
    applyQuestion(composer, "tc-q"); // re-emit (reconcile path)
    assert.equal(askedCount, 1);
    assert.equal(composer.getPendingQuestions().length, 1);
  });

  it("P2-4: a question approval is linked via questionApproval event (production order)", () => {
    const composer = track(new ComposerDataService(undefined, undefined));
    // Production order (the old test had it backwards — card first, then the
    // toolCall — which is impossible: Tool.Called is published before the
    // tool's execute fiber raises the approval):
    //   1. toolCall event with the question payload (session.tool.called)
    //   2. approval card opens (permission.asked → handleApproval)
    //   3. adapter emits questionApproval linking the two
    applyQuestion(composer, "tc-q");
    assert.equal(composer.reviews.currentApproval, undefined, "no card before permission.asked");
    const pending0 = composer.getPendingQuestions();
    assert.equal(pending0.length, 1);
    assert.equal(pending0[0]!.approvalToolCallId, undefined, "not linked before the card exists");
    const p = composer.reviews.requestApproval("tc-req-1", "question", ["reason"]);
    assert.ok(composer.reviews.currentApproval, "card is open");
    // What the adapter's handleApproval pushes for a question approval:
    (composer as unknown as { applyEvent: (e: unknown) => void }).applyEvent({
      type: "questionApproval",
      toolCallId: "tc-q",
      approvalToolCallId: "tc-req-1",
    });
    const pending = composer.getPendingQuestions();
    assert.equal(pending.length, 1);
    assert.equal(pending[0]!.approvalToolCallId, "tc-req-1");
    // Answering the widget resolves the card as approve-once (no 5-min hang).
    // (running=true so the answer steers into the FIFO instead of starting a
    // real turn — the link is what's under test, and the vscode stub has no
    // workspace.saveAll for a full runTurn.)
    (composer as unknown as { running: boolean }).running = true;
    assert.equal(composer.answerQuestion(`q-tc-q`, "opt-0"), true);
    assert.equal(composer.reviews.currentApproval, undefined);
    assert.equal(composer.reviews.pendingCount(), 0);
    void p;
  });

  it("P2-4: questionApproval links the right card with two questions pending", () => {
    const composer = track(new ComposerDataService(undefined, undefined));
    applyQuestion(composer, "tc-a");
    applyQuestion(composer, "tc-b");
    const pa = composer.reviews.requestApproval("tc-req-a", "question", ["reason a"]);
    const pb = composer.reviews.requestApproval("tc-req-b", "question", ["reason b"]);
    const apply = (composer as unknown as { applyEvent: (e: unknown) => void }).applyEvent.bind(composer);
    apply({ type: "questionApproval", toolCallId: "tc-a", approvalToolCallId: "tc-req-a" });
    apply({ type: "questionApproval", toolCallId: "tc-b", approvalToolCallId: "tc-req-b" });
    const pending = composer.getPendingQuestions();
    const qa = pending.find((q) => q.toolCallId === "tc-a")!;
    const qb = pending.find((q) => q.toolCallId === "tc-b")!;
    assert.equal(qa.approvalToolCallId, "tc-req-a");
    assert.equal(qb.approvalToolCallId, "tc-req-b");
    // Answering A resolves only A's card. (running=true: answers steer into
    // the FIFO instead of starting real turns — see the note above.)
    (composer as unknown as { running: boolean }).running = true;
    assert.equal(composer.answerQuestion("q-tc-a", "opt-0"), true);
    assert.equal(composer.reviews.pendingCount(), 1);
    assert.equal(composer.answerQuestion("q-tc-b", "opt-1"), true);
    assert.equal(composer.reviews.pendingCount(), 0);
    void pa;
    void pb;
  });

  it("P2-12: multi-select answers submit all options together", () => {
    const composer = track(new ComposerDataService(undefined, undefined));
    applyQuestion(composer, "tc-m", true);
    const pending = composer.getPendingQuestions();
    assert.equal(pending.length, 1);
    assert.equal(pending[0]!.multiple, true);
    // A single answerQuestion would previously delete the question after one
    // option (silent downgrade). Multi goes through answerQuestionMulti.
    assert.equal(composer.answerQuestionMulti("q-tc-m", ["opt-0", "opt-1"]), true);
    assert.equal(composer.getPendingQuestions().length, 0);
    // Second submit → false (exactly-once per question).
    assert.equal(composer.answerQuestionMulti("q-tc-m", ["opt-0"]), false);
    // Empty / unknown option → false.
    applyQuestion(composer, "tc-m2", true);
    assert.equal(composer.answerQuestionMulti("q-tc-m2", []), false);
    assert.equal(composer.answerQuestionMulti("q-tc-m2", ["nope"]), false);
    assert.equal(composer.getPendingQuestions().length, 1);
  });

  it("P2-3: newChat clears pending questions and the staged interrupt send", async () => {
    const composer = track(new ComposerDataService(undefined, undefined));
    applyQuestion(composer, "tc-q");
    assert.equal(composer.getPendingQuestions().length, 1);
    (composer as unknown as { pendingInterruptSend: unknown }).pendingInterruptSend = {
      text: "stale steer",
    };
    assert.equal(await composer.newChat(), true);
    assert.equal(composer.getPendingQuestions().length, 0);
    assert.equal(
      (composer as unknown as { pendingInterruptSend: unknown }).pendingInterruptSend,
      undefined,
    );
  });

  it("P2-1/P2-2: submit while draining stages the interrupt send (no second runTurn)", () => {
    const composer = track(new ComposerDataService(undefined, undefined));
    const c = composer as unknown as {
      drainDepth: number;
      pendingInterruptSend: { text: string } | undefined;
      running: boolean;
    };
    // Simulate the drain window: running=false, drainDepth>0.
    c.drainDepth = 1;
    composer.submit("first steer", { sendMode: "sendNow" });
    composer.submit("second steer", { sendMode: "sendNow" });
    // Single slot: the first steer is staged; the second overflows into the
    // unbounded queue instead of being silently dropped.
    assert.equal(c.pendingInterruptSend?.text, "first steer");
    assert.equal(composer.queue.length, 1);
    assert.deepEqual(
      composer.queue.getItems().map((m) => m.text),
      ["second steer"],
    );
    assert.equal(c.running, false, "no turn was started during the drain window");
    c.drainDepth = 0;
  });

  it("R2 (Round B, reworked): interrupt sends are NOT capped — slot + unbounded queue overflow", () => {
    const composer = track(new ComposerDataService(undefined, undefined));
    const c = composer as unknown as {
      drainDepth: number;
      pendingInterruptSend: { text: string } | undefined;
    };
    c.drainDepth = 1; // keep submissions staged, no turn starts
    for (let i = 0; i < 14; i++) {
      composer.submit(`steer-${i}`, { sendMode: "sendNow" });
    }
    // The 10-entry cap was fabricated (DIG-CONTINUOUS 2026-10-19: Cursor has
    // no interrupt-sends queue at all). Nothing is dropped now.
    assert.equal(c.pendingInterruptSend?.text, "steer-0", "first steer staged in the slot");
    assert.equal(composer.queue.length, 13, "the rest overflow into the unbounded queue");
    assert.deepEqual(
      composer.queue.getItems().map((m) => m.text),
      Array.from({ length: 13 }, (_, i) => `steer-${i + 1}`),
      "overflow preserves order",
    );
    c.drainDepth = 0;
  });

  it("R1 (Round B): submitWithHooks after dispose starts no turn", async () => {
    const composer = track(new ComposerDataService(undefined, undefined));
    composer.dispose();
    const c = composer as unknown as {
      disposed: boolean;
      running: boolean;
      submitWithHooks: (text: string) => Promise<void>;
    };
    assert.equal(c.disposed, true);
    await c.submitWithHooks("hello after close");
    assert.equal(c.running, false, "no turn started on a disposed composer");
  });

  it("P1-2/P2-14: closeTab disposes the composer and its event relay", async () => {
    const fakeContext = {
      subscriptions: [],
      globalState: { get: () => undefined, update: async () => undefined },
      workspaceState: { get: () => undefined, update: async () => undefined },
    } as unknown as import("vscode").ExtensionContext;
    const tabs = track(new ChatTabService(fakeContext));
    const t2 = tabs.createTab({});
    const composer = t2.composer;
    const relays = (tabs as unknown as { tabRelays: Map<string, unknown> }).tabRelays;
    assert.ok(relays.has(t2.id), "relay tracked per tab");
    assert.equal(await tabs.closeTab(t2.id), true);
    assert.equal(
      (composer as unknown as { disposed: boolean }).disposed,
      true,
      "composer disposed on tab close (sidecar killed)",
    );
    assert.ok(!relays.has(t2.id), "relay removed — no subscription leak");
  });

  it("P2-16: newChat event resets the tab title so the next message re-titles", () => {
    const fakeContext = {
      subscriptions: [],
      globalState: { get: () => undefined, update: async () => undefined },
      workspaceState: { get: () => undefined, update: async () => undefined },
    } as unknown as import("vscode").ExtensionContext;
    const tabs = track(new ChatTabService(fakeContext));
    const tab = tabs.activeTab;
    tab.title = "Old title";
    (tab.composer as unknown as { emitter: { fire: (e: unknown) => void } }).emitter.fire({
      kind: "newChat",
    });
    assert.equal(tab.title, "New chat");
  });
});

describe("DEV-ORANGE-DOT — orange dot on chat tab awaiting input", () => {
  const fakeContext = {
    subscriptions: [],
    globalState: { get: () => undefined, update: async () => undefined },
    workspaceState: { get: () => undefined, update: async () => undefined },
  } as unknown as import("vscode").ExtensionContext;

  it("dot flag on when a tab has a pending approval, off when resolved", () => {
    const tabs = track(new ChatTabService(fakeContext));
    const tab = tabs.activeTab;
    assert.equal(tabs.getTabStates()[0]!.approvalPending, false);
    // The agent requests approval → awaiting user input.
    const p = tab.composer.reviews.requestApproval("tc-dot-1", "Run the tests?", ["shell"], 60000);
    void p.then(() => undefined); // swallow: we resolve below
    const pending = tabs.getTabStates()[0]!;
    assert.equal(pending.approvalPending, true, "approvalPending drives the orange dot");
    assert.equal(pending.questionPending, false);
    // User approves → the dot clears.
    const approvalId = tab.composer.reviews.currentApproval!.approvalId;
    tab.composer.reviews.resolveApproval(approvalId, { optionId: "approve-once" });
    assert.equal(tabs.getTabStates()[0]!.approvalPending, false);
  });

  it("dot flag on when a background tab has a pending question, off when answered", () => {
    const tabs = track(new ChatTabService(fakeContext));
    const bg = tabs.createTab({});
    const toolCall = {
      toolCallId: "tc-dot-q",
      kind: "ask_question_tool_call",
      title: "question",
      status: "pending" as const,
      description: "",
      outputPreview: "",
      expanded: false,
      question: {
        questionId: "q-dot-q",
        header: "Scope",
        question: "Which scope?",
        options: [
          { id: "opt-0", label: "Repo", description: "Whole repo" },
          { id: "opt-1", label: "File", description: "One file" },
        ],
        multiple: false,
        toolCallId: "tc-dot-q",
      },
    };
    (bg.composer as unknown as { applyEvent: (e: unknown) => void }).applyEvent({
      type: "toolCall",
      bubbleId: "b-dot",
      toolCall,
    });
    const bgState = tabs.getTabStates().find((s) => s.id === bg.id)!;
    assert.equal(bgState.questionPending, true, "questionPending drives the orange dot on the background tab");
    assert.equal(bgState.approvalPending, false);
    // The active tab is unaffected.
    const activeState = tabs.getTabStates().find((s) => s.id === tabs.activeTab.id)!;
    assert.equal(activeState.questionPending, false);
    // Answering clears the pending question → dot clears.
    assert.equal(bg.composer.answerQuestion("q-dot-q", "opt-1"), true);
    assert.equal(tabs.getTabStates().find((s) => s.id === bg.id)!.questionPending, false);
  });

  it("question-pending flag clears on newChat (stale questions must not keep the dot)", async () => {
    const tabs = track(new ChatTabService(fakeContext));
    const tab = tabs.activeTab;
    (tab.composer as unknown as { pendingQuestions: Map<string, unknown> }).pendingQuestions.set("q-stale", {
      questionId: "q-stale",
    });
    assert.equal(tabs.getTabStates()[0]!.questionPending, true);
    // newChat clears pending questions (QA-CHATTABS-01 P2-3); the orange
    // dot must go away with them.
    assert.equal(await tab.composer.newChat(), true);
    assert.equal(tabs.getTabStates()[0]!.questionPending, false);
  });
});
