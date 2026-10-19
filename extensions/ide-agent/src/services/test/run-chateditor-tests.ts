/**
 * Chat editor tab tests (node:test, vscode stubbed via ./vscode-stub).
 *
 * Covers (Cursor parity — chat tabs as real editor tabs):
 *  - chatEditorUriForTab / tabIdFromUri: URI scheme contract (ide-chat:/<tabId>),
 *    foreign schemes rejected, path traversal rejected (P3-5).
 *  - transcriptToMarkdown: Export Transcript content (Cursor title menu).
 *  - resolveChatEditorTab: honors the right-clicked tab URI (P2-1); prefers
 *    the active chat editor tab; falls back to the single open chat editor;
 *    finally to the sidebar active tab.
 *  - openChatEditor: creates a tab and opens it via vscode.openWith
 *    (respects ide.chat.openAsEditorTabs, default ON in the stub).
 *  - openChatAsEditorTabs: default true.
 *  - sanitizeAddToChatArgs (P3-12): rejects forwarded Uri-like objects.
 *  - addToChat (services/addToChat.ts):
 *      explicit {source:'terminal'} → clipboard probe; stale clipboard is
 *      NEVER attached (P1-1); clipboard restored after the round-trip (P3-13);
 *      explicit {source:'editor'} → editor selection, no clipboard touch;
 *      no args (palette) → behavioral probe decides terminal vs editor.
 *
 * Run after `tsc`:  node --test out/services/test/run-chateditor-tests.js
 */
import { describe, it } from "node:test";
import * as assert from "node:assert";
import "./vscode-stub";
import { vscodeStub } from "./vscode-stub";
import {
  CHAT_EDITOR_SCHEME,
  CHAT_EDITOR_VIEW_TYPE,
  chatEditorUriForTab,
  openChatAsEditorTabs,
  tabIdFromUri,
  openChatEditor,
  resolveChatEditorTab,
  transcriptToMarkdown,
} from "../chatEditorProvider";
import {
  addToChat,
  addTerminalSelectionToChat,
  probeTerminalSelection,
  sanitizeAddToChatArgs,
  type VscodeSeam,
  type AddToChatHost,
} from "../addToChat";
import { ChatTabService } from "../chatTabService";

// ---- Test setup (uses the extended shared vscode stub) --------------------
type MutableStub = Record<string, unknown>;
const stub = vscodeStub as unknown as MutableStub;
const stubCommands = (vscodeStub as unknown as {
  commands: { calls: Array<{ command: string; args: unknown[] }>; impl: null };
}).commands;
const stubWindow = (vscodeStub as unknown as {
  window: {
    tabGroups: {
      all: Array<{ activeTab?: { input?: unknown }; tabs: Array<{ input?: unknown }> }>;
      activeTabGroup?: { activeTab?: { input?: unknown }; tabs: Array<{ input?: unknown }> };
    };
  };
}).window;
const StubTabInputCustom = stub.TabInputCustom as new (
  uri: unknown,
  viewType: string,
) => { uri: unknown; viewType: string };
const stubUriFrom = (stub.Uri as unknown as {
  from: (parts: { scheme: string; path: string }) => { scheme: string; path: string; toString(): string };
}).from;

// ---- Fakes ----------------------------------------------------------------
const fakeContext = {
  subscriptions: [],
  globalState: { get: () => undefined, update: async () => undefined },
  workspaceState: { get: () => undefined, update: async () => undefined },
} as unknown as import("vscode").ExtensionContext;

function makeSeam(overrides: Partial<VscodeSeam> = {}): VscodeSeam & { calls: string[] } {
  const calls: string[] = [];
  const seam = {
    calls,
    activeTextEditor: undefined,
    activeTerminal: undefined,
    executeCommand: async (command: string) => {
      calls.push(`exec:${command}`);
      return undefined;
    },
    readClipboardText: async () => "",
    writeClipboardText: async (text: string) => {
      calls.push(`writeClipboard:${text}`);
    },
    showInformationMessage: (m: string) => {
      calls.push(`info:${m}`);
    },
    asRelativePath: (uri: { path: string }) => uri.path.replace(/^\//, ""),
    ...overrides,
  };
  return seam as VscodeSeam & { calls: string[] };
}

/** Clipboard fake: successive reads return the queued values. */
function clipboardQueue(values: string[]): () => Promise<string> {
  let i = 0;
  return async () => values[Math.min(i++, values.length - 1)];
}

function makeHost(): AddToChatHost & { posted: unknown[]; focused: boolean } {
  const posted: unknown[] = [];
  const host: AddToChatHost & { posted: unknown[]; focused: boolean } = {
    posted,
    focused: false,
    postToWebview: (m: unknown) => {
      posted.push(m);
    },
    focusChatView: async () => {
      host.focused = true;
    },
  };
  return host;
}

// ---- URI helpers -----------------------------------------------------------
describe("chatEditorUriForTab / tabIdFromUri", () => {
  it("round-trips a tab id through the ide-chat scheme", () => {
    const uri = chatEditorUriForTab("tab-123");
    assert.equal((uri as unknown as { scheme: string }).scheme, CHAT_EDITOR_SCHEME);
    assert.equal(tabIdFromUri(uri), "tab-123");
  });

  it("rejects foreign schemes and empty paths", () => {
    const foreign = stubUriFrom({ scheme: "file", path: "/x" });
    assert.equal(tabIdFromUri(foreign as unknown as import("vscode").Uri), undefined);
    const empty = stubUriFrom({ scheme: CHAT_EDITOR_SCHEME, path: "/" });
    assert.equal(tabIdFromUri(empty as unknown as import("vscode").Uri), undefined);
  });

  it("rejects path traversal and multi-segment paths (P3-5)", () => {
    assert.equal(
      tabIdFromUri(stubUriFrom({ scheme: CHAT_EDITOR_SCHEME, path: "/../../.." }) as unknown as import("vscode").Uri),
      undefined,
    );
    assert.equal(
      tabIdFromUri(stubUriFrom({ scheme: CHAT_EDITOR_SCHEME, path: "/a/b" }) as unknown as import("vscode").Uri),
      undefined,
    );
    assert.equal(
      tabIdFromUri(stubUriFrom({ scheme: CHAT_EDITOR_SCHEME, path: "/.." }) as unknown as import("vscode").Uri),
      undefined,
    );
  });
});

// ---- openChatAsEditorTabs ---------------------------------------------------
describe("openChatAsEditorTabs (P1-3)", () => {
  it("defaults to true", () => {
    assert.equal(openChatAsEditorTabs(), true);
  });
});

// ---- Export Transcript -----------------------------------------------------
describe("transcriptToMarkdown (Export Transcript)", () => {
  it("renders human/assistant bubbles as Markdown sections", () => {
    const tabs = new ChatTabService(fakeContext);
    const tab = tabs.activeTab;
    tab.composer.bubbles.setBubbleData({
      bubbleId: "b1",
      role: "human",
      text: "hello",
      createdAt: Date.now(),
      toolCalls: [],
    } as never);
    tab.composer.bubbles.setBubbleData({
      bubbleId: "b2",
      role: "assistant",
      text: "world",
      createdAt: Date.now(),
      toolCalls: [],
    } as never);
    const md = transcriptToMarkdown(tab);
    assert.ok(md.startsWith(`# ${tab.title}`));
    assert.ok(md.includes("## User"));
    assert.ok(md.includes("hello"));
    assert.ok(md.includes("## Assistant"));
    assert.ok(md.includes("world"));
  });

  it("renders an empty transcript without crashing", () => {
    const tabs = new ChatTabService(fakeContext);
    const md = transcriptToMarkdown(tabs.activeTab);
    assert.ok(md.startsWith("# "));
  });
});

// ---- resolveChatEditorTab ---------------------------------------------------
describe("resolveChatEditorTab", () => {
  it("honors the right-clicked tab URI over the active tab (P2-1)", () => {
    const tabs = new ChatTabService(fakeContext);
    const tabA = tabs.activeTab;
    const tabB = tabs.createTab({ title: "B" });
    // B is open as an editor but A is the active tab; right-click B.
    const uriB = chatEditorUriForTab(tabB.id);
    const uriA = chatEditorUriForTab(tabA.id);
    stubWindow.tabGroups.activeTabGroup = {
      activeTab: { input: new StubTabInputCustom(uriA, CHAT_EDITOR_VIEW_TYPE) },
      tabs: [],
    };
    stubWindow.tabGroups.all = [stubWindow.tabGroups.activeTabGroup];
    assert.equal(resolveChatEditorTab(tabs, uriB as unknown as import("vscode").Uri)?.id, tabB.id);
  });

  it("ignores a foreign right-clicked URI and falls back to heuristics", () => {
    const tabs = new ChatTabService(fakeContext);
    const tab = tabs.activeTab;
    const uri = chatEditorUriForTab(tab.id);
    const foreignUri = stubUriFrom({ scheme: "file", path: "/x" });
    stubWindow.tabGroups.activeTabGroup = {
      activeTab: { input: new StubTabInputCustom(uri, CHAT_EDITOR_VIEW_TYPE) },
      tabs: [],
    };
    stubWindow.tabGroups.all = [stubWindow.tabGroups.activeTabGroup];
    assert.equal(
      resolveChatEditorTab(tabs, foreignUri as unknown as import("vscode").Uri)?.id,
      tab.id,
    );
  });

  it("prefers the active tab when it is a chat editor", () => {
    const tabs = new ChatTabService(fakeContext);
    const tab = tabs.activeTab;
    const uri = chatEditorUriForTab(tab.id);
    stubWindow.tabGroups.activeTabGroup = {
      activeTab: { input: new StubTabInputCustom(uri, CHAT_EDITOR_VIEW_TYPE) },
      tabs: [],
    };
    stubWindow.tabGroups.all = [stubWindow.tabGroups.activeTabGroup];
    assert.equal(resolveChatEditorTab(tabs)?.id, tab.id);
  });

  it("falls back to the single open chat editor when the active tab is foreign", () => {
    const tabs = new ChatTabService(fakeContext);
    const tab = tabs.activeTab;
    const uri = chatEditorUriForTab(tab.id);
    const foreignUri = stubUriFrom({ scheme: "file", path: "/x" });
    stubWindow.tabGroups.activeTabGroup = {
      activeTab: { input: new StubTabInputCustom(foreignUri, "default") },
      tabs: [],
    };
    stubWindow.tabGroups.all = [
      stubWindow.tabGroups.activeTabGroup,
      { tabs: [{ input: new StubTabInputCustom(uri, CHAT_EDITOR_VIEW_TYPE) }] },
    ];
    assert.equal(resolveChatEditorTab(tabs)?.id, tab.id);
  });

  it("falls back to the sidebar active tab when no chat editor is open", () => {
    const tabs = new ChatTabService(fakeContext);
    stubWindow.tabGroups.activeTabGroup = { activeTab: { input: undefined }, tabs: [] };
    stubWindow.tabGroups.all = [stubWindow.tabGroups.activeTabGroup];
    assert.equal(resolveChatEditorTab(tabs)?.id, tabs.activeTab.id);
  });
});

// ---- openChatEditor ---------------------------------------------------------
describe("openChatEditor", () => {
  it("creates a tab and opens it with vscode.openWith", async () => {
    stubCommands.calls.length = 0;
    const tabs = new ChatTabService(fakeContext);
    const before = tabs.listTabs().length;
    const tab = await openChatEditor(tabs);
    assert.equal(tabs.listTabs().length, before + 1);
    const openWith = stubCommands.calls.find((c) => c.command === "vscode.openWith");
    assert.ok(openWith, "expected vscode.openWith to be called");
    const uri = openWith.args[0] as { scheme: string };
    assert.equal(uri.scheme, CHAT_EDITOR_SCHEME);
    assert.equal(tabIdFromUri(openWith.args[0] as import("vscode").Uri), tab.id);
    assert.equal(openWith.args[1], CHAT_EDITOR_VIEW_TYPE);
  });

  it("reveals an existing tab when a tabId is given", async () => {
    stubCommands.calls.length = 0;
    const tabs = new ChatTabService(fakeContext);
    const tab = tabs.activeTab;
    const opened = await openChatEditor(tabs, undefined, tab.id);
    assert.equal(opened.id, tab.id);
    assert.ok(stubCommands.calls.some((c) => c.command === "vscode.openWith"));
  });
});

// ---- sanitizeAddToChatArgs (P3-12) ------------------------------------------
describe("sanitizeAddToChatArgs", () => {
  it("accepts { source, text }", () => {
    assert.deepEqual(sanitizeAddToChatArgs({ source: "terminal", text: "x" }), {
      source: "terminal",
      text: "x",
    });
  });

  it("rejects Uri-like objects forwarded by menus", () => {
    const fakeUri = { scheme: "ide-chat", authority: "", path: "/tab-1", query: "", fragment: "" };
    assert.equal(sanitizeAddToChatArgs(fakeUri), undefined);
  });

  it("rejects arrays, null, primitives and empty objects", () => {
    assert.equal(sanitizeAddToChatArgs([]), undefined);
    assert.equal(sanitizeAddToChatArgs(null), undefined);
    assert.equal(sanitizeAddToChatArgs("terminal"), undefined);
    assert.equal(sanitizeAddToChatArgs({}), undefined);
    assert.equal(sanitizeAddToChatArgs({ source: "terminal", unexpected: 1 }), undefined);
  });

  it("accepts { source, text, newChat } (Ctrl+click from core toolbar)", () => {
    assert.deepEqual(sanitizeAddToChatArgs({ source: "terminal", text: "x", newChat: true }), {
      source: "terminal",
      text: "x",
      newChat: true,
    });
    // newChat must be boolean true to survive; other truthy values are dropped.
    assert.deepEqual(sanitizeAddToChatArgs({ source: "terminal", newChat: 1 }), {
      source: "terminal",
    });
  });
});

// ---- probeTerminalSelection (P1-1 / P3-13 / REVERIFY-P2-2) -------------------
describe("probeTerminalSelection", () => {
  it("returns the selection text when the clipboard changed and restores the original (P3-13)", async () => {
    const seam = makeSeam({ readClipboardText: clipboardQueue(["old-secret", "selected text", "selected text"]) });
    const text = await probeTerminalSelection(seam);
    assert.equal(text, "selected text");
    assert.ok(seam.calls.includes("exec:workbench.action.terminal.copySelection"));
    assert.ok(seam.calls.includes("writeClipboard:old-secret"), "clipboard must be restored");
  });

  it("returns undefined when the clipboard is unchanged — stale content is never attached (P1-1)", async () => {
    const seam = makeSeam({ readClipboardText: clipboardQueue(["stale-secret", "stale-secret"]) });
    const text = await probeTerminalSelection(seam);
    assert.equal(text, undefined);
    assert.ok(
      !seam.calls.some((c) => c.startsWith("writeClipboard:")),
      "no restore needed when nothing changed",
    );
  });

  it("returns undefined when the clipboard is empty", async () => {
    const seam = makeSeam({ readClipboardText: clipboardQueue(["", ""]) });
    assert.equal(await probeTerminalSelection(seam), undefined);
  });

  it("aborts without attach or restore when the clipboard is still changing (REVERIFY-P2-2 race)", async () => {
    // User copies something else mid-probe: after="user-fresh", after2="user-fresh-2".
    // Must NOT attach their text as a terminal chip (privacy) and must NOT
    // restore `before` over their fresh copy (data loss).
    const seam = makeSeam({
      readClipboardText: clipboardQueue(["old", "user-fresh-copy", "user-fresh-copy-2"]),
    });
    const text = await probeTerminalSelection(seam);
    assert.equal(text, undefined, "concurrent copy must not be misattributed");
    assert.ok(
      !seam.calls.some((c) => c.startsWith("writeClipboard:")),
      "must not clobber the user's fresh copy",
    );
  });

  it("skips restore when the clipboard changed again after the settle check (REVERIFY2-P3-2 restore-clobber)", async () => {
    // Scenario: before="old"; the probe's after read sees "user-fresh" and the
    // settle check passes (stable); then the user copies "user-fresh-2" right
    // before we would restore. The restore must be SKIPPED — writing "old"
    // now would clobber their fresh copy (data loss).
    const seam = makeSeam({
      readClipboardText: clipboardQueue(["old", "user-fresh", "user-fresh", "user-fresh-2"]),
    });
    const text = await probeTerminalSelection(seam);
    assert.equal(text, "user-fresh", "selection is still returned");
    assert.ok(
      !seam.calls.some((c) => c.startsWith("writeClipboard:")),
      "must not write over the user's newer clipboard content",
    );
  });
});

// ---- addToChat: editor path --------------------------------------------------
describe("addToChat — editor path", () => {
  it("attaches the editor selection as a context chip", async () => {
    const doc = {
      uri: stubUriFrom({ scheme: "file", path: "/proj/a.ts" }),
      getText: (_sel: unknown) => "const x = 1;",
    };
    const sel = { isEmpty: false, start: { line: 4 } };
    const seam = makeSeam({
      activeTextEditor: { document: doc, selection: sel } as never,
    });
    const host = makeHost();
    await addToChat(host, seam, { source: "editor" });
    assert.equal(host.focused, true);
    assert.equal(host.posted.length, 1);
    const msg = host.posted[0] as { type: string; label: string; content: string };
    assert.equal(msg.type, "addSelectionContext");
    assert.equal(msg.label, "selection:proj/a.ts:5");
    assert.equal(msg.content, "const x = 1;");
  });

  it("shows an info message when nothing is selected", async () => {
    const seam = makeSeam({
      activeTextEditor: { document: {}, selection: { isEmpty: true } } as never,
    });
    const host = makeHost();
    await addToChat(host, seam, { source: "editor" });
    assert.equal(host.posted.length, 0);
    assert.ok(seam.calls.some((c) => c.startsWith("info:IDE Agent: select code")));
  });

  it("explicit editor source never touches the clipboard", async () => {
    const seam = makeSeam({
      activeTextEditor: {
        document: { uri: stubUriFrom({ scheme: "file", path: "/p.ts" }), getText: () => "y" },
        selection: { isEmpty: false, start: { line: 0 } },
      } as never,
      readClipboardText: clipboardQueue(["a", "b"]),
    });
    const host = makeHost();
    await addToChat(host, seam, { source: "editor" });
    assert.ok(!seam.calls.some((c) => c.startsWith("exec:workbench.action.terminal.copySelection")));
    assert.equal(host.posted.length, 1);
  });
});

// ---- addToChat: terminal path -------------------------------------------------
describe("addToChat — terminal path", () => {
  it("attaches the probed terminal selection and restores the clipboard", async () => {
    const seam = makeSeam({
      activeTerminal: {} as never,
      readClipboardText: clipboardQueue(["before", "$ npm test\nFAIL 1"]),
    });
    const host = makeHost();
    await addToChat(host, seam, { source: "terminal" });
    assert.ok(seam.calls.includes("exec:workbench.action.terminal.copySelection"));
    assert.ok(seam.calls.includes("writeClipboard:before"));
    assert.equal(host.posted.length, 1);
    const msg = host.posted[0] as { type: string; label: string; content: string };
    assert.equal(msg.type, "addSelectionContext");
    assert.equal(msg.label, "terminal selection");
    assert.equal(msg.content, "$ npm test\nFAIL 1");
  });

  it("never attaches the stale clipboard as a terminal selection (P1-1)", async () => {
    const seam = makeSeam({
      activeTerminal: {} as never,
      readClipboardText: clipboardQueue(["user-secret", "user-secret"]),
    });
    const host = makeHost();
    await addTerminalSelectionToChat(host, seam);
    assert.equal(host.posted.length, 0);
    assert.ok(seam.calls.some((c) => c.startsWith("info:IDE Agent: select text in the terminal")));
  });

  it("attaches pre-resolved text directly when invoked with { source: 'terminal', text } (core toolbar path)", async () => {
    const seam = makeSeam({});
    const host = makeHost();
    await addToChat(host, seam, { source: "terminal", text: "$ npm test\nFAIL 1" });
    assert.ok(!seam.calls.includes("exec:workbench.action.terminal.copySelection"));
    assert.equal(host.posted.length, 1);
    const msg = host.posted[0] as { type: string; label: string; content: string };
    assert.equal(msg.type, "addSelectionContext");
    assert.equal(msg.label, "terminal selection");
    assert.equal(msg.content, "$ npm test\nFAIL 1");
  });

  it("ignores an empty text arg and falls back to the probe", async () => {
    const seam = makeSeam({
      activeTerminal: {} as never,
      readClipboardText: clipboardQueue(["before", "$ npm test"]),
    });
    const host = makeHost();
    await addToChat(host, seam, { source: "terminal", text: "" });
    assert.ok(seam.calls.includes("exec:workbench.action.terminal.copySelection"));
    assert.equal(host.posted.length, 1);
  });
});

// ---- addToChat: ambiguous palette path ---------------------------------------
describe("addToChat — palette path (no args)", () => {
  it("uses the terminal chip when the probe finds a terminal selection", async () => {
    const seam = makeSeam({
      activeTerminal: {} as never,
      activeTextEditor: {
        document: { uri: stubUriFrom({ scheme: "file", path: "/p.ts" }), getText: () => "y" },
        selection: { isEmpty: false, start: { line: 0 } },
      } as never,
      readClipboardText: clipboardQueue(["before", "term sel"]),
    });
    const host = makeHost();
    await addToChat(host, seam);
    const msg = host.posted[0] as { label: string };
    assert.equal(msg.label, "terminal selection");
  });

  it("falls back to the editor when the probe finds no terminal selection", async () => {
    const seam = makeSeam({
      activeTerminal: {} as never,
      activeTextEditor: {
        document: { uri: stubUriFrom({ scheme: "file", path: "/p.ts" }), getText: () => "y" },
        selection: { isEmpty: false, start: { line: 0 } },
      } as never,
      readClipboardText: clipboardQueue(["same", "same"]),
    });
    const host = makeHost();
    await addToChat(host, seam);
    const msg = host.posted[0] as { label: string };
    assert.ok(msg.label.startsWith("selection:"));
  });
});
