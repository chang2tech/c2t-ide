/**
 * GAPS-152 tests (`agent-notification-actions`, node:test).
 *
 * Guards the Cursor 3.25.9 (workbench.desktop.main.js) notification
 * behavior ported in services/agentNotifications.ts:
 *  - verbatim payloads: completed @31367250 (title `Done \u2022 {name}` /
 *    "Agent complete", body, silent:!0, clickAction only) and pending
 *    @31370281 (urgency "critical", Accept/Reject actions, actionCommands
 *    0→accept / 1→reject with the RAW composer id, clickAction with the
 *    jR_-routed id);
 *  - `getPendingActionNotificationInfo` @31367568 copy per tool family,
 *    including the 140-char terminal-command truncation;
 *  - producer gates in the binary's order (completed: enabled → focus →
 *    YOh queued-messages; pending: focus → blocking group → enabled);
 *  - pending copy classifies group[0], not the triggering request
 *    (GAPS-165, QA-160 NEEDS-FIX P2 — mixed-group cases both ways);
 *  - command handlers @29946768: open switches to the named tab,
 *    accept/reject resolve every decision of that composer's group,
 *    unknown/empty ids are silent no-ops.
 *
 * The REAL compiled AgentNotificationService is exercised with injected
 * fake deps (no vscode runtime); only the transitive `vscode` import of
 * permissionsFileService needs the Module._load stub below.
 *
 * Run after `tsc`:  node --test out/services/test/run-agent-notification-tests.js
 */
import { describe, it, before } from "node:test";
import * as assert from "node:assert";

/* ------------------------------------------------------------------ */
/* vscode stub — installed before the service module is required.      */
/* ------------------------------------------------------------------ */

class FakeEventEmitter<T> {
  private listeners: Array<(e: T) => void> = [];
  readonly event = (listener: (e: T) => void): { dispose(): void } => {
    this.listeners.push(listener);
    return { dispose: () => undefined };
  };
  fire(e: T): void {
    for (const listener of [...this.listeners]) {
      listener(e);
    }
  }
  dispose(): void {
    this.listeners = [];
  }
}

const vscodeStub = {
  EventEmitter: FakeEventEmitter,
  workspace: {
    getConfiguration: () => ({
      get: <T>(_key: string, fallback?: T): T | undefined => fallback,
    }),
    workspaceFolders: undefined,
  },
  window: { state: { focused: false } },
};

type Mod = typeof import("../agentNotifications");
let mod: Mod;

before(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const Module = require("node:module") as { _load: (request: string, ...rest: unknown[]) => unknown };
  const origLoad = Module._load.bind(Module);
  Module._load = function (request: string, ...rest: unknown[]): unknown {
    if (request === "vscode") {
      return vscodeStub;
    }
    return origLoad(request, ...rest);
  };
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  mod = require("../agentNotifications") as Mod;
});

/* ------------------------------------------------------------------ */
/* Fakes.                                                              */
/* ------------------------------------------------------------------ */

interface FakeDecision {
  toolCallId: string;
  clientSideTool: string;
  title: string;
  blocking: boolean;
  startedAt: number;
  accepted: number;
  rejected: number;
  accept(): void;
  reject(): void;
}

function fakeDecision(toolCallId: string, clientSideTool: string, title?: string): FakeDecision {
  const d: FakeDecision = {
    toolCallId,
    clientSideTool,
    title: title ?? clientSideTool,
    blocking: true,
    startedAt: 0,
    accepted: 0,
    rejected: 0,
    accept() {
      d.accepted += 1;
    },
    reject() {
      d.rejected += 1;
    },
  };
  return d;
}

function fakeTab(opts?: { id?: string; title?: string; queuedCount?: number; group?: FakeDecision[] }) {
  return {
    id: opts?.id ?? "tab-1",
    title: opts?.title ?? "Fix the parser",
    queuedCount: opts?.queuedCount ?? 0,
    getPendingUserDecisionGroup: () => opts?.group ?? [],
  };
}

/** Build a service with recording fake deps. */
function makeService(opts?: {
  enabled?: boolean;
  focused?: boolean;
  tabs?: Map<string, ReturnType<typeof fakeTab>>;
  bridgeResult?: boolean;
  bridgeThrows?: boolean;
}) {
  const shown: Array<{ id: string; args: unknown[] }> = [];
  const opened: string[] = [];
  const tabs = opts?.tabs ?? new Map();
  const svc = new mod.AgentNotificationService({
    executeCommand: async (id: string, ...args: unknown[]) => {
      shown.push({ id, args });
      if (opts?.bridgeThrows) {
        throw new Error("bridge unavailable");
      }
      return opts?.bridgeResult ?? true;
    },
    isWindowFocused: () => opts?.focused ?? false,
    systemNotificationsEnabled: () => opts?.enabled ?? true,
    getTab: (composerId: string) => tabs.get(composerId),
    openTab: async (composerId: string) => {
      opened.push(composerId);
    },
  });
  return { svc, shown, opened, tabs };
}

function fakeRequest(overrides?: { title?: string; clientSideTool?: string }) {
  return {
    approvalId: "approval-1",
    toolCallId: "tc-1",
    title: overrides?.title ?? "bash npm test",
    reasons: [],
    options: [],
    clientSideTool: overrides?.clientSideTool ?? "bash",
    startedAt: 0,
  };
}

/* ------------------------------------------------------------------ */
/* Verbatim payload builders.                                          */
/* ------------------------------------------------------------------ */

describe("agentNotifications — verbatim payload builders (GAPS-152)", () => {
  it("completed: named composer → Done • {name}, silent, clickAction only", () => {
    const n = mod.buildCompletedNotification({ composerId: "tab-1", name: "Fix the parser" });
    assert.equal(n.title, "Done \u2022 Fix the parser");
    assert.equal(n.body, "Open Cursor to view the agent's output.");
    assert.equal(n.silent, true);
    assert.deepEqual(n.clickAction, {
      commandId: "composer.openComposerFromNotification",
      args: { composerId: "tab-1" },
    });
    assert.equal(n.actions, undefined);
    assert.equal(n.actionCommands, undefined);
  });

  it("completed: no name → 'Agent complete'; source rides in click args (ext-host-exited variant)", () => {
    const plain = mod.buildCompletedNotification({ composerId: "tab-2" });
    assert.equal(plain.title, "Agent complete");
    assert.deepEqual(plain.clickAction?.args, { composerId: "tab-2" });
    const stopped = mod.buildCompletedNotification({
      composerId: "tab-2",
      source: "composer.notifications.extensionHostExited",
    });
    assert.deepEqual(stopped.clickAction?.args, {
      composerId: "tab-2",
      source: "composer.notifications.extensionHostExited",
    });
  });

  it("pending: critical, Accept/Reject, actionCommands raw id, click routed id", () => {
    const info = mod.getPendingActionNotificationInfo({ kind: "other", groupCount: 1 });
    const n = mod.buildPendingNotification({
      composerId: "tab-raw",
      clickComposerId: "tab-parent",
      info,
      silent: false,
    });
    assert.equal(n.urgency, "critical");
    assert.equal(n.silent, false);
    assert.deepEqual(n.actions, [
      { type: "button", text: "Accept" },
      { type: "button", text: "Reject" },
    ]);
    assert.deepEqual(n.clickAction, {
      commandId: "composer.openComposerFromNotification",
      args: { composerId: "tab-parent" },
    });
    assert.deepEqual(n.actionCommands?.[0], {
      commandId: "composer.acceptPendingFromNotification",
      args: { composerId: "tab-raw" },
    });
    assert.deepEqual(n.actionCommands?.[1], {
      commandId: "composer.rejectPendingFromNotification",
      args: { composerId: "tab-raw" },
    });
  });

  it("jR_ routing: parent id wins, blank parent falls back to self", () => {
    assert.equal(mod.routeNotificationComposerId("tab-sub", "tab-parent"), "tab-parent");
    assert.equal(mod.routeNotificationComposerId("tab-sub", "  "), "tab-sub");
    assert.equal(mod.routeNotificationComposerId("tab-sub"), "tab-sub");
  });
});

describe("agentNotifications — getPendingActionNotificationInfo copy (desk@31367568)", () => {
  it("default branch", () => {
    const info = mod.getPendingActionNotificationInfo({ kind: "other", groupCount: 1 });
    assert.deepEqual(info, {
      title: "Approve pending action",
      body: "Return to Cursor to review and approve.",
      toolType: undefined,
    });
  });

  it("terminal: command in body; >140 chars truncates to 140 + '...'", () => {
    const short = mod.getPendingActionNotificationInfo({ kind: "terminal", groupCount: 1, command: " npm test " });
    assert.equal(short.title, "Approve terminal command");
    assert.equal(short.body, "Approval required to run: npm test");
    assert.equal(short.toolType, "terminal");
    const longCommand = "x".repeat(200);
    const long = mod.getPendingActionNotificationInfo({ kind: "terminal", groupCount: 1, command: longCommand });
    assert.equal(long.body, `Approval required to run: ${"x".repeat(140)}...`);
    // No command → generic branch (binary: params without `command`).
    const none = mod.getPendingActionNotificationInfo({ kind: "terminal", groupCount: 1 });
    assert.equal(none.title, "Approve pending action");
  });

  it("edit: single shows basename, multiple shows count copy", () => {
    const one = mod.getPendingActionNotificationInfo({
      kind: "edit",
      groupCount: 1,
      relativePath: "src/deep/file.ts",
    });
    assert.equal(one.title, "Approve file edit");
    assert.equal(one.body, "Approval required to edit: file.ts");
    // Binary quirk, pinned verbatim: `l.split("/").pop() || l.split("\\").pop() || l`
    // — for a backslash path the first pop() already returns the whole
    // (truthy) string, so the binary shows the FULL path, not a basename.
    const win = mod.getPendingActionNotificationInfo({
      kind: "edit",
      groupCount: 1,
      relativePath: "src\\deep\\file.ts",
    });
    assert.equal(win.body, "Approval required to edit: src\\deep\\file.ts");
    const many = mod.getPendingActionNotificationInfo({ kind: "edit", groupCount: 3 });
    assert.equal(many.title, "Approve 3 file edits");
    assert.equal(many.body, "Return to Cursor to review and approve 3 file changes.");
  });

  it("delete / mcp / question copy", () => {
    const del = mod.getPendingActionNotificationInfo({ kind: "delete", groupCount: 1, relativePath: "a/b.txt" });
    assert.equal(del.title, "Approve file deletion");
    assert.equal(del.body, "Approval required to delete: b.txt");
    const mcp = mod.getPendingActionNotificationInfo({ kind: "mcp", groupCount: 1, mcpToolName: "search" });
    assert.equal(mcp.title, "Approve MCP tool");
    assert.equal(mcp.body, "Approval required for MCP tool: search");
    const mcpFallback = mod.getPendingActionNotificationInfo({ kind: "mcp", groupCount: 1 });
    assert.equal(mcpFallback.body, "Return to Cursor to review and approve the MCP tool execution.");
    const q = mod.getPendingActionNotificationInfo({ kind: "question", groupCount: 1, questionPrompt: " Which db? " });
    assert.equal(q.title, "Input needed \u2022 Which db?");
    assert.equal(q.body, "Open Cursor to answer the agent's questions.");
  });
});

describe("agentNotifications — classifyPendingRequest (fork approval → binary branches)", () => {
  it("terminal / edit / mcp / other from clientSideTool + title suffix", () => {
    assert.deepEqual(mod.classifyPendingRequest(fakeRequest({})), { kind: "terminal", command: "npm test" });
    assert.deepEqual(
      mod.classifyPendingRequest(fakeRequest({ title: "edit src/a.ts", clientSideTool: "edit" })),
      { kind: "edit", relativePath: "src/a.ts" },
    );
    assert.deepEqual(
      mod.classifyPendingRequest(fakeRequest({ title: "MCP: search (srv)", clientSideTool: "mcp__srv__search" })),
      { kind: "mcp", mcpToolName: "search" },
    );
    assert.deepEqual(mod.classifyPendingRequest(fakeRequest({ title: "web_search x", clientSideTool: "web_search" })), {
      kind: "other",
    });
  });

  it("legacy request without clientSideTool: first title token is the action", () => {
    const legacy = fakeRequest({ title: "bash ls -la" });
    delete (legacy as { clientSideTool?: string }).clientSideTool;
    assert.deepEqual(mod.classifyPendingRequest(legacy), { kind: "terminal", command: "ls -la" });
  });

  it("classifyPendingDecision (GAPS-165): stored identity + legacy resolved identity", () => {
    // Stored identity: title carries the resource suffix.
    assert.deepEqual(mod.classifyPendingDecision({ title: "bash npm test", clientSideTool: "bash" }), {
      kind: "terminal",
      command: "npm test",
    });
    assert.deepEqual(mod.classifyPendingDecision({ title: "edit src/a.ts", clientSideTool: "edit" }), {
      kind: "edit",
      relativePath: "src/a.ts",
    });
    // Legacy: the group's resolved clientSideTool IS the full title
    // (humanReviewService fallback) — the action comes from its first
    // token and the command from the remainder, as for a raw request.
    assert.deepEqual(mod.classifyPendingDecision({ title: "bash ls -la", clientSideTool: "bash ls -la" }), {
      kind: "terminal",
      command: "ls -la",
    });
  });
});

/* ------------------------------------------------------------------ */
/* Producers: gates + payload dispatch.                                */
/* ------------------------------------------------------------------ */

describe("agentNotifications — producers (gates in binary order)", () => {
  it("completed: happy path shows the verbatim payload through the bridge", async () => {
    const { svc, shown } = makeService();
    const ok = await svc.notifyTurnCompleted(fakeTab({}));
    assert.equal(ok, true);
    assert.equal(shown.length, 1);
    assert.equal(shown[0].id, "composer.showAgentSystemNotification");
    const payload = shown[0].args[0] as ReturnType<typeof mod.buildCompletedNotification>;
    assert.equal(payload.title, "Done \u2022 Fix the parser");
    assert.deepEqual(payload.clickAction?.args, { composerId: "tab-1" });
  });

  it("completed: disabled / focused / queued each suppress (no bridge call)", async () => {
    for (const opts of [{ enabled: false }, { focused: true }]) {
      const { svc, shown } = makeService(opts);
      assert.equal(await svc.notifyTurnCompleted(fakeTab({})), false);
      assert.equal(shown.length, 0);
    }
    const queued = makeService();
    assert.equal(await queued.svc.notifyTurnCompleted(fakeTab({ queuedCount: 2 })), false);
    assert.equal(queued.shown.length, 0);
  });

  it("completed: untitled tab → 'Agent complete'; bridge failure → false, never throws", async () => {
    const { svc, shown } = makeService();
    await svc.notifyTurnCompleted(fakeTab({ title: "New chat" }));
    const payload = shown[0].args[0] as ReturnType<typeof mod.buildCompletedNotification>;
    assert.equal(payload.title, "Agent complete");
    const failing = makeService({ bridgeThrows: true });
    assert.equal(await failing.svc.notifyTurnCompleted(fakeTab({})), false);
  });

  it("pending: happy path builds critical Accept/Reject payload for the tab's group", async () => {
    const group = [fakeDecision("tc-1", "bash", "bash npm test")];
    const { svc, shown } = makeService();
    const ok = await svc.notifyPendingDecision(fakeTab({ group }), fakeRequest({}));
    assert.equal(ok, true);
    const payload = shown[0].args[0] as ReturnType<typeof mod.buildPendingNotification>;
    assert.equal(payload.title, "Approve terminal command");
    assert.equal(payload.body, "Approval required to run: npm test");
    assert.equal(payload.urgency, "critical");
    assert.deepEqual(payload.actionCommands?.[0]?.args, { composerId: "tab-1" });
    assert.deepEqual(payload.clickAction?.args, { composerId: "tab-1" });
  });

  it("pending: mixed group, terminal heads group + edit triggers → terminal copy (GAPS-165)", async () => {
    // Binary getPendingActionNotificationInfo classifies group[0]
    // (desk@31367568), never the triggering request: a terminal
    // decision is already pending and a NEW edit request wakes the
    // producer — the notification must still describe the terminal.
    const group = [fakeDecision("tc-term", "bash", "bash npm run build")];
    const { svc, shown } = makeService();
    const ok = await svc.notifyPendingDecision(
      fakeTab({ group }),
      fakeRequest({ title: "edit src/a.ts", clientSideTool: "edit" }),
    );
    assert.equal(ok, true);
    const payload = shown[0].args[0] as ReturnType<typeof mod.buildPendingNotification>;
    assert.equal(payload.title, "Approve terminal command");
    assert.equal(payload.body, "Approval required to run: npm run build");
  });

  it("pending: mixed group, edit heads group + terminal triggers → edit copy (GAPS-165)", async () => {
    // Reverse direction: an edit decision heads the group and a NEW
    // terminal request wakes the producer — copy must be the edit's
    // (with group[0]'s path basename), not the terminal trigger's.
    const group = [fakeDecision("tc-edit", "edit", "edit src/deep/file.ts")];
    const { svc, shown } = makeService();
    const ok = await svc.notifyPendingDecision(fakeTab({ group }), fakeRequest({}));
    assert.equal(ok, true);
    const payload = shown[0].args[0] as ReturnType<typeof mod.buildPendingNotification>;
    assert.equal(payload.title, "Approve file edit");
    assert.equal(payload.body, "Approval required to edit: file.ts");
  });

  it("pending: focused / empty group / disabled each suppress", async () => {
    const group = [fakeDecision("tc-1", "bash")];
    const focused = makeService({ focused: true });
    assert.equal(await focused.svc.notifyPendingDecision(fakeTab({ group }), fakeRequest({})), false);
    assert.equal(focused.shown.length, 0);
    const empty = makeService();
    assert.equal(await empty.svc.notifyPendingDecision(fakeTab({ group: [] }), fakeRequest({})), false);
    assert.equal(empty.shown.length, 0);
    const disabled = makeService({ enabled: false });
    assert.equal(await disabled.svc.notifyPendingDecision(fakeTab({ group }), fakeRequest({})), false);
    assert.equal(disabled.shown.length, 0);
  });
});

/* ------------------------------------------------------------------ */
/* Handlers: open / accept / reject.                                   */
/* ------------------------------------------------------------------ */

describe("agentNotifications — command handlers (desk@29946768)", () => {
  it("open: string and object args open the named tab; unknown/empty are no-ops", async () => {
    const tabs = new Map([["tab-1", fakeTab({})]]);
    const { svc, opened } = makeService({ tabs });
    await svc.openComposerFromNotification("tab-1");
    await svc.openComposerFromNotification({ composerId: "tab-1", source: "composer.notifications.completed" });
    assert.deepEqual(opened, ["tab-1", "tab-1"]);
    await svc.openComposerFromNotification({ composerId: "tab-gone" });
    await svc.openComposerFromNotification(undefined);
    await svc.openComposerFromNotification({});
    await svc.openComposerFromNotification("");
    assert.deepEqual(opened, ["tab-1", "tab-1"]);
  });

  it("accept: resolves every decision of the named composer's group only", async () => {
    const mine = [fakeDecision("tc-1", "bash"), fakeDecision("tc-2", "edit")];
    const other = [fakeDecision("tc-3", "bash")];
    const tabs = new Map([
      ["tab-1", fakeTab({ group: mine })],
      ["tab-2", fakeTab({ id: "tab-2", group: other })],
    ]);
    const { svc } = makeService({ tabs });
    await svc.acceptPendingFromNotification({ composerId: "tab-1" });
    assert.deepEqual(mine.map((d) => d.accepted), [1, 1]);
    assert.equal(other[0].accepted, 0);
    await svc.acceptPendingFromNotification({ composerId: "tab-gone" });
    await svc.acceptPendingFromNotification(undefined);
  });

  it("reject: rejects every decision of the group", async () => {
    const mine = [fakeDecision("tc-1", "bash"), fakeDecision("tc-2", "mcp__srv__tool")];
    const tabs = new Map([["tab-1", fakeTab({ group: mine })]]);
    const { svc } = makeService({ tabs });
    await svc.rejectPendingFromNotification("tab-1");
    assert.deepEqual(mine.map((d) => d.rejected), [1, 1]);
    assert.deepEqual(mine.map((d) => d.accepted), [0, 0]);
  });

  it("parse helpers: binary arg rule", () => {
    assert.equal(mod.parseNotificationComposerId("tab-1"), "tab-1");
    assert.equal(mod.parseNotificationComposerId({ composerId: "tab-1" }), "tab-1");
    assert.equal(mod.parseNotificationComposerId({}), undefined);
    assert.equal(mod.parseNotificationComposerId(42), undefined);
    assert.equal(mod.parseNotificationComposerId(null), undefined);
    assert.equal(mod.parseNotificationSource({ source: "composer.notifications.completed" }), "composer.notifications.completed");
    assert.equal(mod.parseNotificationSource("tab-1"), undefined);
  });
});
