/**
 * Chat export tests (node:test, vscode stubbed via ./vscode-stub).
 *
 * Covers:
 * - serializeChatToMarkdown: title/role sections, code blocks preserved,
 *   tool calls (title/kind/status/output preview), thinking <details>,
 *   empty transcript placeholder.
 * - chatExportFileName: sanitization + "chat.md" fallback.
 * - registerChatExportCommands: registers the two Cursor `composer.*`
 *   command ids; exportChatAsMd writes a Markdown file through the save
 *   dialog (and does nothing on cancel); export_chat copies Markdown to
 *   the clipboard.
 *
 * Run after `tsc`:  node --test out/services/test/run-chat-export-tests.js
 */
import { describe, it, beforeEach } from "node:test";
import * as assert from "node:assert";
import "./vscode-stub";
import { vscodeStub } from "./vscode-stub";
import type { BubbleData, ToolCallViewModel } from "../../model";
import type { ChatTab } from "../chatTabService";
import {
  EXPORT_CHAT_AS_MD_COMMAND,
  EXPORT_CHAT_COMMAND,
  chatExportFileName,
  registerChatExportCommands,
  serializeChatToMarkdown,
  type ChatExportDeps,
} from "../chatExportService";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// Runtime seam extensions on the vscode stub (the stub object is plain JS,
// so tests add the surface the export commands touch). vscode-stub.ts itself
// is untouched.
// ---------------------------------------------------------------------------

type Mutable = Record<string, unknown>;

const registered = new Map<string, (...args: unknown[]) => unknown>();
const disposables: Array<{ dispose(): void }> = [];

function asMutable(v: unknown): Mutable {
  return v as Mutable;
}

// commands.registerCommand
asMutable(vscodeStub.commands).registerCommand = (id: string, fn: (...args: unknown[]) => unknown) => {
  registered.set(id, fn);
  const d = { dispose(): void { /* stub */ } };
  disposables.push(d);
  return d;
};

// window.showSaveDialog — canned answer, replaceable per test.
const windowMutable = asMutable((vscodeStub as Mutable).window);
windowMutable.lastSaveDialogOptions = undefined as unknown;
windowMutable.nextSaveUri = undefined as unknown;
windowMutable.showSaveDialog = async (options: unknown) => {
  windowMutable.lastSaveDialogOptions = options;
  const uri = windowMutable.nextSaveUri;
  windowMutable.nextSaveUri = undefined;
  return uri;
};

// workspace.fs.writeFile + workspaceFolders
const workspaceMutable = asMutable((vscodeStub as Mutable).workspace);
const written = new Map<string, string>();
workspaceMutable.fs = {
  async writeFile(uri: { toString(): string }, bytes: Uint8Array): Promise<void> {
    written.set(uri.toString(), Buffer.from(bytes).toString("utf8"));
  },
};
workspaceMutable.workspaceFolders = [
  { uri: { toString: () => "file:///ws", fsPath: "/ws" } },
];

// env.clipboard.writeText
const envMutable = asMutable((vscodeStub as Mutable).env);
envMutable.lastClipboardText = undefined as unknown;
envMutable.clipboard = {
  async writeText(text: string): Promise<void> {
    envMutable.lastClipboardText = text;
  },
};

// Uri.file / Uri.joinPath (the stub only has parse/from)
const uriMutable = asMutable((vscodeStub as Mutable).Uri);
uriMutable.file = (p: string) => ({ toString: () => `file://${p}`, fsPath: p });
uriMutable.joinPath = (base: { toString(): string; fsPath: string }, seg: string) => ({
  toString: () => `${base.toString()}/${seg}`,
  fsPath: `${base.fsPath}/${seg}`,
});

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

let bubbleSeq = 0;
function bubble(partial: Partial<BubbleData> & { role: BubbleData["role"]; text: string }): BubbleData {
  bubbleSeq += 1;
  return {
    bubbleId: `b-${bubbleSeq}`,
    mode: "agent",
    toolCalls: [],
    createdAt: Date.now(),
    ...partial,
  };
}

function toolCall(partial: Partial<ToolCallViewModel> & { kind: string; title: string }): ToolCallViewModel {
  return {
    toolCallId: `tc-${Math.random().toString(36).slice(2)}`,
    status: "done",
    description: "",
    outputPreview: "",
    expanded: false,
    ...partial,
  };
}

function fakeTab(title: string, bubbles: BubbleData[]): ChatTab {
  return {
    id: "tab-1",
    title,
    createdAt: Date.now(),
    pinned: false,
    composer: {
      bubbles: { getAllInOrder: () => bubbles },
    },
  } as unknown as ChatTab;
}

function fakeDeps(tab: ChatTab): ChatExportDeps {
  return { chatTabs: { activeTab: tab } };
}

function fakeContext(): { subscriptions: Array<{ dispose(): void }> } {
  return { subscriptions: [] };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("serializeChatToMarkdown", () => {
  it("renders title + role sections and preserves code blocks", () => {
    const tab = fakeTab("Fix login bug", [
      bubble({ role: "human", text: "The login button is broken." }),
      bubble({
        role: "assistant",
        text: "Here is the fix:\n\n```ts\nconst ok = true;\n```\n\nDone.",
      }),
    ]);
    const md = serializeChatToMarkdown(tab);
    assert.ok(md.startsWith("# Fix login bug\n"));
    assert.ok(md.includes("## User"));
    assert.ok(md.includes("The login button is broken."));
    assert.ok(md.includes("## Assistant"));
    assert.ok(md.includes("```ts\nconst ok = true;\n```"), "fenced code block must survive");
  });

  it("serializes tool calls with kind, status, description and output preview", () => {
    const tab = fakeTab("t", [
      bubble({
        role: "assistant",
        text: "Reading the file first.",
        toolCalls: [
          toolCall({
            kind: "read",
            title: "Read src/auth.ts",
            status: "done",
            description: "Read the auth module.",
            outputPreview: "export function login() {}",
            filePath: "src/auth.ts",
          }),
        ],
      }),
    ]);
    const md = serializeChatToMarkdown(tab);
    assert.ok(md.includes("### Tool: Read src/auth.ts"));
    assert.ok(md.includes("`read`") && md.includes("status: **done**"));
    assert.ok(md.includes("Read the auth module."));
    assert.ok(md.includes("```output\nexport function login() {}\n```"));
  });

  it("renders thinking as a collapsed details block", () => {
    const tab = fakeTab("t", [
      bubble({
        role: "assistant",
        text: "Answer.",
        thinking: { text: "Let me think…", durationMs: 12000, done: true },
      }),
    ]);
    const md = serializeChatToMarkdown(tab);
    assert.ok(md.includes("<details>"));
    assert.ok(md.includes("<summary>Thinking (12s)</summary>"));
    assert.ok(md.includes("Let me think…"));
  });

  it("emits a placeholder for an empty transcript", () => {
    const md = serializeChatToMarkdown(fakeTab("Empty chat", []));
    assert.ok(md.startsWith("# Empty chat\n"));
    assert.ok(md.includes("No messages yet"));
  });

  it("maps tool/system roles to headings", () => {
    const tab = fakeTab("t", [
      bubble({ role: "tool", text: "tool result" }),
      bubble({ role: "system", text: "system note" }),
    ]);
    const md = serializeChatToMarkdown(tab);
    assert.ok(md.includes("## Tool"));
    assert.ok(md.includes("## System"));
  });
});

describe("chatExportFileName", () => {
  it("sanitizes unsafe characters", () => {
    assert.equal(chatExportFileName("Fix: login / bug? (v2)"), "Fix login  bug v2.md");
  });

  it("falls back to chat.md for empty titles", () => {
    assert.equal(chatExportFileName(""), "chat.md");
    assert.equal(chatExportFileName("   "), "chat.md");
  });
});

describe("registerChatExportCommands", () => {
  beforeEach(() => {
    registered.clear();
    disposables.length = 0;
    written.clear();
    windowMutable.nextSaveUri = undefined;
    envMutable.lastClipboardText = undefined;
  });

  it("registers both composer.* ids and pushes disposables to subscriptions", () => {
    const ctx = fakeContext();
    registerChatExportCommands(ctx as never, fakeDeps(fakeTab("t", [])));
    assert.ok(registered.has(EXPORT_CHAT_AS_MD_COMMAND), "composer.exportChatAsMd");
    assert.ok(registered.has(EXPORT_CHAT_COMMAND), "composer.export_chat");
    assert.equal(EXPORT_CHAT_AS_MD_COMMAND, "composer.exportChatAsMd");
    assert.equal(EXPORT_CHAT_COMMAND, "composer.export_chat");
    assert.equal(ctx.subscriptions.length, 2);
  });

  it("exportChatAsMd writes the serialized chat to the chosen file", async () => {
    const tab = fakeTab("Fix login bug", [
      bubble({ role: "human", text: "hello" }),
      bubble({ role: "assistant", text: "```js\n1\n```" }),
    ]);
    registerChatExportCommands(fakeContext() as never, fakeDeps(tab));
    windowMutable.nextSaveUri = { toString: () => "file:///ws/export.md", fsPath: "/ws/export.md" };
    await registered.get(EXPORT_CHAT_AS_MD_COMMAND)!();
    await sleep(10);
    const content = written.get("file:///ws/export.md");
    assert.ok(content, "writeFile must be called with the chosen URI");
    assert.ok(content!.startsWith("# Fix login bug\n"));
    assert.ok(content!.includes("## User"));
    assert.ok(content!.includes("```js\n1\n```"), "code blocks preserved in the file");
    const opts = asMutable(windowMutable.lastSaveDialogOptions);
    assert.deepEqual((opts.filters as { Markdown: string[] }).Markdown, ["md"]);
  });

  it("exportChatAsMd does nothing when the save dialog is cancelled", async () => {
    registerChatExportCommands(fakeContext() as never, fakeDeps(fakeTab("t", [bubble({ role: "human", text: "x" })])));
    windowMutable.nextSaveUri = undefined; // user pressed cancel
    await registered.get(EXPORT_CHAT_AS_MD_COMMAND)!();
    await sleep(10);
    assert.equal(written.size, 0);
  });

  it("export_chat copies the serialized chat to the clipboard", async () => {
    const tab = fakeTab("Deploy notes", [bubble({ role: "assistant", text: "ship it" })]);
    registerChatExportCommands(fakeContext() as never, fakeDeps(tab));
    await registered.get(EXPORT_CHAT_COMMAND)!();
    await sleep(10);
    const text = envMutable.lastClipboardText as string;
    assert.ok(text, "clipboard must receive the markdown");
    assert.ok(text.startsWith("# Deploy notes\n"));
    assert.ok(text.includes("## Assistant"));
  });
});
