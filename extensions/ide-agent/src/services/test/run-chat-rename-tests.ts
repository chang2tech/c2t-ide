/**
 * agent-chat-rename tests (node:test, vscode stubbed via ./vscode-stub).
 *
 * Evidence (Cursor 3.25.6, workbench.glass.main.js, static literals):
 * - command 'composer.renameChat' (command-telemetry category 'chat_management')
 * - command 'composer.renameComposer' with label/tooltip 'Rename Chat'
 *   (inline rename action)
 *
 * Covers:
 * - Both commands register under the evidence-backed ids/label.
 * - Rename flow: active tab (no arg) and explicit tab id (context-menu arg).
 * - Manual-vs-auto distinction: isManualTitle only for renames through this
 *   service; manual titles survive auto-title passes; newChat/closeTab clear
 *   the manual flag.
 * - Cancel / blank / unknown-tab handling.
 * - Disposal unregisters both commands.
 *
 * Run after `tsc`:  node --test out/services/test/run-chat-rename-tests.js
 */
import { describe, it } from "node:test";
import * as assert from "node:assert";
import "./vscode-stub";
import { vscodeStub, windowStub } from "./vscode-stub";
import { ChatTabService } from "../chatTabService";
import {
  ChatRenameService,
  registerChatRenameCommands,
  RENAME_CHAT_COMMAND,
  RENAME_COMPOSER_COMMAND,
  RENAME_CHAT_LABEL,
} from "../chatRenameService";

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

// Capture error messages for the rejection-path tests.
const errors: string[] = [];
const origShowError = windowStub.showErrorMessage;
windowStub.showErrorMessage = (message: string) => {
  errors.push(message);
  return origShowError(message);
};

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

const fakeContext = {
  subscriptions: [] as Array<{ dispose(): void }>,
  globalState: { get: () => undefined, update: async () => undefined },
  workspaceState: { get: () => undefined, update: async () => undefined },
} as unknown as import("vscode").ExtensionContext;

function makeRename(
  prompt?: (current: string) => Promise<string | undefined>,
) {
  const tabs = new ChatTabService(fakeContext);
  const svc = new ChatRenameService(tabs, {
    promptTitle: prompt ?? (async () => "Renamed by test"),
  });
  return { tabs, svc };
}

function fireComposerEvent(tab: { composer: unknown }, kind: string) {
  (tab.composer as unknown as { emitter: { fire: (e: unknown) => void } }).emitter.fire({
    kind,
    ids: ["b1"],
  });
}

describe("chat-rename commands — registration (Cursor evidence)", () => {
  it("registers both commands under the evidence-backed ids and label", () => {
    const tabs = new ChatTabService(fakeContext);
    const disp = registerChatRenameCommands(fakeContext, tabs, {
      promptTitle: async () => "x",
    });
    assert.equal(RENAME_CHAT_COMMAND, "composer.renameChat");
    assert.equal(RENAME_COMPOSER_COMMAND, "composer.renameComposer");
    assert.equal(RENAME_CHAT_LABEL, "Rename Chat");
    assert.ok(
      registered.has(RENAME_CHAT_COMMAND),
      "composer.renameChat must be registered",
    );
    assert.ok(
      registered.has(RENAME_COMPOSER_COMMAND),
      "composer.renameComposer must be registered",
    );
    disp.dispose();
    assert.equal(registered.size, 0, "dispose unregisters both commands");
    tabs.dispose();
  });
});

describe("ChatRenameService — rename flow", () => {
  it("renames the active tab when no tab id is given", async () => {
    const { tabs, svc } = makeRename(async () => "  Deploy plan  ");
    const ok = await svc.runRename();
    assert.equal(ok, true);
    assert.equal(tabs.activeTab.title, "Deploy plan");
    assert.equal(svc.isManualTitle(tabs.activeTab.id), true);
    tabs.dispose();
  });

  it("renames the target tab when a tab id is given (context-menu path)", async () => {
    const { tabs, svc } = makeRename(async () => "Second chat");
    const second = tabs.createTab({});
    const first = tabs.listTabs()[0]!;
    const ok = await svc.runRename(second.id);
    assert.equal(ok, true);
    assert.equal(second.title, "Second chat");
    assert.equal(svc.isManualTitle(second.id), true);
    // Untouched tab keeps its title and is not marked manual.
    assert.equal(first.title, "New chat");
    assert.equal(svc.isManualTitle(first.id), false);
    tabs.dispose();
  });

  it("composer.renameComposer handler renames the active tab (inline action path)", async () => {
    const tabs = new ChatTabService(fakeContext);
    const disp = registerChatRenameCommands(fakeContext, tabs, {
      promptTitle: async (current) => `inline:${current}`,
    });
    const handler = registered.get(RENAME_COMPOSER_COMMAND);
    assert.ok(handler, "handler must be registered");
    handler(); // no arg → active tab
    await sleep(20); // command handlers are fire-and-forget
    assert.equal(tabs.activeTab.title, "inline:New chat");
    disp.dispose();
    tabs.dispose();
  });

  it("fires onRenamed after a successful rename", async () => {
    const seen: Array<{ id: string; title: string }> = [];
    const tabs = new ChatTabService(fakeContext);
    const svc = new ChatRenameService(tabs, {
      promptTitle: async () => "With hook",
      onRenamed: (id, title) => seen.push({ id, title }),
    });
    await svc.runRename();
    assert.deepEqual(seen, [{ id: tabs.activeTab.id, title: "With hook" }]);
    tabs.dispose();
  });

  it("cancel leaves the title untouched and not manual", async () => {
    const { tabs, svc } = makeRename(async () => undefined);
    const ok = await svc.runRename();
    assert.equal(ok, false);
    assert.equal(tabs.activeTab.title, "New chat");
    assert.equal(svc.isManualTitle(tabs.activeTab.id), false);
    tabs.dispose();
  });

  it("blank input is rejected with an error", async () => {
    errors.length = 0;
    const { tabs, svc } = makeRename(async () => "   \n  ");
    const ok = await svc.runRename();
    assert.equal(ok, false);
    assert.equal(tabs.activeTab.title, "New chat");
    assert.equal(svc.isManualTitle(tabs.activeTab.id), false);
    assert.equal(errors.length, 1);
    tabs.dispose();
  });

  it("unknown tab id errors and returns false", async () => {
    errors.length = 0;
    const { tabs, svc } = makeRename(async () => "X");
    const ok = await svc.runRename("nope");
    assert.equal(ok, false);
    assert.equal(errors.length, 1);
    tabs.dispose();
  });
});

describe("ChatRenameService — manual vs auto-generated title", () => {
  it("a manual title survives the auto-title pass", async () => {
    const { tabs, svc } = makeRename(async () => "Manual name");
    await svc.runRename();
    const tab = tabs.activeTab;
    tab.composer.bubbles.setBubbleData({
      bubbleId: "b1",
      role: "human",
      mode: "agent",
      text: "refactor the auth module to use sessions",
      toolCalls: [],
      createdAt: Date.now(),
    });
    fireComposerEvent(tab, "bubblesChanged");
    assert.equal(tab.title, "Manual name");
    assert.equal(svc.isManualTitle(tab.id), true);
    tabs.dispose();
  });

  it("an auto-generated title is NOT marked manual", () => {
    const tabs = new ChatTabService(fakeContext);
    const svc = new ChatRenameService(tabs, { promptTitle: async () => "x" });
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
    fireComposerEvent(tab, "bubblesChanged");
    assert.notEqual(tab.title, "New chat", "auto-title should have applied");
    assert.equal(svc.isManualTitle(tab.id), false);
    tabs.dispose();
  });

  it("newChat resets the title and clears the manual flag", async () => {
    const { tabs, svc } = makeRename(async () => "Manual name");
    await svc.runRename();
    const tab = tabs.activeTab;
    assert.equal(svc.isManualTitle(tab.id), true);
    await tab.composer.newChat();
    assert.equal(tab.title, "New chat");
    assert.equal(svc.isManualTitle(tab.id), false);
    tabs.dispose();
  });

  it("closeTab drops the manual flag for the closed tab", async () => {
    const { tabs, svc } = makeRename(async () => "Doomed name");
    const second = tabs.createTab({});
    await svc.runRename(second.id);
    assert.equal(svc.isManualTitle(second.id), true);
    const closed = await tabs.closeTab(second.id);
    assert.equal(closed, true);
    assert.equal(svc.isManualTitle(second.id), false);
    tabs.dispose();
  });

  it("dispose clears the manual flags", async () => {
    const { tabs, svc } = makeRename(async () => "Manual name");
    await svc.runRename();
    const id = tabs.activeTab.id;
    assert.equal(svc.isManualTitle(id), true);
    svc.dispose();
    assert.equal(svc.isManualTitle(id), false);
    tabs.dispose();
  });
});
