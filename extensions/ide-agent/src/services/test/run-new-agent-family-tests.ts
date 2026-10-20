/**
 * WORKER-GAPS-22A (agent-new-agent-command-family): runtime tests for the
 * extension side of the workbench-core `glass.newAgent*` family (Cursor
 * 3.25.9 parity, workbench.glass.main.js @45354715).
 *
 * Run after `tsc`:
 *   node --test out/services/test/run-new-agent-family-tests.js
 */
import "./vscode-stub";
import { describe, it, beforeEach } from "node:test";
import * as assert from "node:assert";
import * as fs from "node:fs";
import * as path from "node:path";
import { vscodeStub, windowStub } from "./vscode-stub";
import {
  sanitizeNewAgentArgs,
  newAgent,
  newAgentWithModel,
  newProjectSubagent,
  type NewAgentArgs,
} from "../../extension";
import type { ChatTabService, ChatTab } from "../chatTabService";
import type { ComposerDataService } from "../composerDataService";

/* ---------- fake ChatTabService ---------- */

function fakeTabs() {
  const created: Array<{ title?: string; mode?: string }> = [];
  let n = 0;
  const composer = {
    models: {
      selections: [] as Array<{ kind?: string; ref?: unknown; label: string }>,
      setSelection(s: { kind?: string; ref?: unknown; label: string }) {
        this.selections.push(s);
      },
      getSelection() {
        return this.selections[this.selections.length - 1];
      },
    },
    engineAdapter: {
      setModelCalls: [] as Array<unknown>,
      async listModels() {
        return [{ id: "opus-4-5", providerID: "anthropic", name: "Claude Opus 4.5" }];
      },
      async setModel(ref: unknown) {
        this.setModelCalls.push(ref);
      },
    },
    getEngineAdapter() {
      return this.engineAdapter;
    },
  };
  const tabs = {
    created,
    currentId: "",
    tabMap: new Map<string, ChatTab>(),
    createAndActivate(opts?: { title?: string; mode?: string }): ChatTab {
      created.push({ ...(opts ?? {}) });
      const id = `tab-${++n}`;
      const tab = {
        id,
        title: opts?.title ?? `tab ${n}`,
        composer: composer as unknown as ComposerDataService,
        createdAt: Date.now(),
        pinned: false,
      };
      tabs.tabMap.set(id, tab);
      tabs.currentId = id;
      return tab;
    },
    listTabs(): ChatTab[] {
      return [...tabs.tabMap.values()];
    },
    get activeTab(): ChatTab {
      return tabs.tabMap.get(tabs.currentId)!;
    },
  } as unknown as ChatTabService & { created: typeof created; tabMap: Map<string, ChatTab>; currentId: string };
  return { tabs, created, composer };
}

beforeEach(() => {
  vscodeStub.commands.calls.length = 0;
});

/* ---------- sanitizeNewAgentArgs ---------- */

describe("sanitizeNewAgentArgs", () => {
  it("rejects non-objects and unknown-only shapes", () => {
    assert.strictEqual(sanitizeNewAgentArgs(undefined), undefined);
    assert.strictEqual(sanitizeNewAgentArgs(null), undefined);
    assert.strictEqual(sanitizeNewAgentArgs("x"), undefined);
    assert.strictEqual(sanitizeNewAgentArgs([]), undefined);
    assert.strictEqual(sanitizeNewAgentArgs({}), undefined);
    assert.strictEqual(sanitizeNewAgentArgs({ bogus: 1 }), undefined);
  });

  it("keeps the binary arg shapes (source/keybinding/cloudRepoUrls/folderUri/shouldOpenEditorPanel)", () => {
    assert.deepStrictEqual(sanitizeNewAgentArgs({ source: "command_palette" }), {
      source: "command_palette",
    });
    // binary: cloudRepoUrls filtered to non-blank strings
    assert.deepStrictEqual(
      sanitizeNewAgentArgs({ cloudRepoUrls: ["https://a", 7, "  ", "https://b"] }),
      { cloudRepoUrls: ["https://a", "https://b"] },
    );
    assert.strictEqual(sanitizeNewAgentArgs({ cloudRepoUrls: ["  "] }), undefined);
    assert.deepStrictEqual(sanitizeNewAgentArgs({ folderUri: "file:///x" }), {
      folderUri: "file:///x",
    });
    assert.deepStrictEqual(
      sanitizeNewAgentArgs({
        source: "keyboard_shortcut",
        keybinding: "Ctrl+Alt+N",
        shouldOpenEditorPanel: true,
      }),
      { source: "keyboard_shortcut", keybinding: "Ctrl+Alt+N", shouldOpenEditorPanel: true },
    );
  });

  it("never forwards a Uri-shaped object as args", () => {
    // P3-12-style: menu invocations can forward model objects; the core
    // sanitize only accepts the known key subset.
    assert.strictEqual(sanitizeNewAgentArgs({ scheme: "file", path: "/x" }), undefined);
  });
});

/* ---------- newAgent branches ---------- */

describe("newAgent", () => {
  it("default: creates an agent-mode tab and reveals it (binary newAgentRequested)", async () => {
    const { tabs, created } = fakeTabs();
    await newAgent(tabs, undefined);
    assert.strictEqual(created.length, 1);
    assert.strictEqual(created[0].mode, "agent");
    // focusChatSurface -> openChatAsEditorTabs() is true in the stub ->
    // the new tab is opened as a chat editor
    const openWith = vscodeStub.commands.calls.find((c) => c.command === "vscode.openWith");
    assert.ok(openWith, "expected vscode.openWith for the new chat editor tab");
    assert.strictEqual(openWith!.args[1], "ideAgent.chatEditor");
  });

  it("shouldOpenEditorPanel: opens the new tab in the editor panel directly", async () => {
    const { tabs, created } = fakeTabs();
    const args: NewAgentArgs = {
      source: "keyboard_shortcut",
      keybinding: "Ctrl+Alt+N",
      shouldOpenEditorPanel: true,
    };
    await newAgent(tabs, args);
    assert.strictEqual(created.length, 1);
    assert.strictEqual(created[0].mode, "agent");
    const openWith = vscodeStub.commands.calls.find((c) => c.command === "vscode.openWith");
    assert.ok(openWith, "preserve-editor-panel opens the chat editor tab directly");
    // the URI targets the NEW tab (not a stale one)
    assert.ok(
      String((openWith!.args[0] as { toString(): string }).toString()).includes("tab-1"),
      "opens the newly created tab",
    );
  });

  it("cloudRepoUrls: new agent tab is created (binary newAgentWithCloudTargetRequested branch)", async () => {
    const { tabs, created } = fakeTabs();
    await newAgent(tabs, { cloudRepoUrls: ["https://github.com/a/b"] });
    assert.strictEqual(created.length, 1, "a fresh agent tab is created for the cloud target");
    assert.strictEqual(created[0].mode, "agent");
  });

  it("folderUri file-scheme: folder is added to the workspace, then a new agent tab opens", async () => {
    const { tabs, created } = fakeTabs();
    const added: unknown[] = [];
    const ws = vscodeStub.workspace as unknown as {
      workspaceFolders?: Array<{ uri: { fsPath: string } }>;
      updateWorkspaceFolders: (...a: unknown[]) => void;
    };
    ws.workspaceFolders = [];
    ws.updateWorkspaceFolders = (...a: unknown[]) => {
      added.push(a);
    };
    try {
      await newAgent(tabs, { folderUri: "file:///tmp/proj", source: "cli" });
    } finally {
      delete (vscodeStub.workspace as Record<string, unknown>).updateWorkspaceFolders;
      delete (vscodeStub.workspace as Record<string, unknown>).workspaceFolders;
    }
    assert.strictEqual(added.length, 1, "the folder is added to the workspace");
    assert.strictEqual(created.length, 1, "then a new agent tab opens");
    assert.strictEqual(created[0].mode, "agent");
  });

  it("folderUri non-file scheme / unparseable: falls through to a plain new agent", async () => {
    const { tabs, created } = fakeTabs();
    await newAgent(tabs, { folderUri: "https://example.com/x" });
    assert.strictEqual(created.length, 1);
    assert.strictEqual(created[0].mode, "agent");
  });
});

/* ---------- newAgentWithModel ---------- */

describe("newAgentWithModel", () => {
  it("creates an agent tab and seeds the engine model (binary XQb)", async () => {
    const { tabs, created, composer } = fakeTabs();
    await newAgentWithModel(tabs, "anthropic/opus-4-5");
    assert.strictEqual(created.length, 1);
    assert.strictEqual(created[0].mode, "agent");
    // engine switched FIRST, then the composer selection persisted
    assert.strictEqual(composer.engineAdapter.setModelCalls.length, 1);
    assert.deepStrictEqual(composer.engineAdapter.setModelCalls[0], {
      id: "opus-4-5",
      providerID: "anthropic",
    });
    const sel = composer.models.getSelection();
    assert.strictEqual(sel.kind, "explicit");
    assert.strictEqual(sel.label, "Claude Opus 4.5");
  });

  it("unknown modelId: warns, keeps the current model, still opens the agent", async () => {
    const { tabs, created, composer } = fakeTabs();
    await newAgentWithModel(tabs, "nope/unknown-model");
    assert.strictEqual(created.length, 1, "the agent tab still opens");
    assert.strictEqual(composer.engineAdapter.setModelCalls.length, 0, "engine untouched");
    assert.strictEqual(composer.models.selections.length, 0, "selection untouched");
    const warning = windowStub.consumeWarning();
    assert.ok(warning?.includes("unknown model"), `expected unknown-model warning, got: ${warning}`);
  });

  it('virtual selectors "auto" / "cursor-default" resolve without an engine ref', async () => {
    const { tabs, composer } = fakeTabs();
    await newAgentWithModel(tabs, "auto");
    const sel = composer.models.getSelection();
    assert.strictEqual(sel.kind, "auto");
    assert.strictEqual(composer.engineAdapter.setModelCalls[0], undefined);
  });
});

/* ---------- registration: COMMANDS + case handlers ---------- */

describe("ide.newAgent / ide.newAgentWithModel / ide.newProjectSubagent registration", () => {
  const src = fs.readFileSync(
    path.join(__dirname, "..", "..", "..", "src", "extension.ts"),
    "utf8",
  );

  it("COMMANDS lists all three runtime commands", () => {
    assert.ok(src.includes('{ id: "ide.newAgent", title: "New Agent"'), "ide.newAgent scaffold entry");
    assert.ok(
      src.includes('{ id: "ide.newAgentWithModel", title: "New Agent with Model"'),
      "ide.newAgentWithModel scaffold entry",
    );
    assert.ok(
      src.includes('{ id: "ide.newProjectSubagent", title: "New Agent"'),
      "ide.newProjectSubagent scaffold entry (Cursor glass.newProjectSubagent parity)",
    );
  });

  it("all three have real case handlers (not scaffold popups)", () => {
    assert.ok(src.includes('case "ide.newAgent":'), "ide.newAgent case");
    assert.ok(src.includes('case "ide.newAgentWithModel":'), "ide.newAgentWithModel case");
    assert.ok(src.includes('case "ide.newProjectSubagent":'), "ide.newProjectSubagent case");
    assert.ok(src.includes("void newAgent(tabs,"), "ide.newAgent -> newAgent()");
    assert.ok(src.includes("void newAgentWithModel(tabs,"), "ide.newAgentWithModel -> newAgentWithModel()");
    assert.ok(src.includes("void newProjectSubagent(tabs,"), "ide.newProjectSubagent -> newProjectSubagent()");
  });

  it("newProjectSubagent logs the binary-verbatim emission name (distinct from newAgentRequested)", () => {
    // Binary: glass.newProjectSubagent run emits `newProjectSubagentRequested`
    // (not `newAgentRequested`). The fork preserves the distinct name in the
    // telemetry log even though the runtime shares newAgent()'s path.
    assert.ok(
      src.includes("newProjectSubagentRequested"),
      "the distinct binary emission name is preserved",
    );
  });
});

/* ---------- newProjectSubagent runtime ---------- */

describe("newProjectSubagent", () => {
  it("creates a new agent-mode tab like the sibling New Agent commands", async () => {
    const { tabs, created } = fakeTabs();
    await newProjectSubagent(tabs, { source: "keyboard_shortcut", keybinding: "Ctrl+T" });
    assert.strictEqual(created.length, 1, "one fresh agent tab");
    assert.strictEqual(created[0].mode, "agent");
    const openWith = vscodeStub.commands.calls.find((c) => c.command === "vscode.openWith");
    assert.ok(openWith, "the new tab is revealed on the chat surface");
  });

  it("sanitizes args through the shared newAgent arg shape", () => {
    // The core action forwards {source:"keyboard_shortcut",keybinding:"Ctrl+T"};
    // unknown shapes are rejected by the same sanitizer.
    assert.deepStrictEqual(sanitizeNewAgentArgs({ source: "keyboard_shortcut", keybinding: "Ctrl+T" }), {
      source: "keyboard_shortcut",
      keybinding: "Ctrl+T",
    });
    assert.strictEqual(sanitizeNewAgentArgs({ bogus: 1 }), undefined);
  });
});
