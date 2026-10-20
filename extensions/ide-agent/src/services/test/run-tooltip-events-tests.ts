/**
 * GAPS-176 — tooltip-pipeline chat producers (host side).
 *
 * Covers the extension-host half of the D2 wiring left by GAPS-170:
 *  - `emitTooltipEvent` calls the core bridge command
 *    `composer.tooltip.registerEvent` exactly once per emit, and never
 *    throws even when the bridge command rejects (fire-and-forget).
 *  - `forwardWebviewTooltipEvent` forwards ONLY the webview allowlist
 *    (`chat.type`, `chat.paste`, `chat.copy.codeblock.manual`,
 *    `chat.insert_selection.*`) — anything else (e.g. `chat.submit`,
 *    `editor.cmdk.submit`) is dropped so the webview cannot inject
 *    arbitrary pipeline events.
 *  - `addToChat` tags successful selection inserts with
 *    `tooltipInsertSource` ("editor" | "terminal") on the
 *    `addSelectionContext` message, and failure paths (empty editor
 *    selection, terminal probe miss) post nothing at all.
 *
 * Event names are Cursor 3.25.9's verbatim pipeline-config names — see
 * ide-code-mission work-notes-gaps176.md Slice 1.
 *
 * Run after `tsc`:  node --test out/services/test/run-tooltip-events-tests.js
 */
import { describe, it } from "node:test";
import * as assert from "node:assert";
import "./vscode-stub";
import { vscodeStub } from "./vscode-stub";
import {
  TOOLTIP_REGISTER_EVENT_COMMAND,
  WEBVIEW_TOOLTIP_EVENTS,
  emitTooltipEvent,
  forwardWebviewTooltipEvent,
} from "../tooltipEvents";
import {
  addToChat,
  type AddToChatHost,
  type VscodeSeam,
} from "../addToChat";

const stubCommands = (vscodeStub as unknown as {
  commands: {
    calls: Array<{ command: string; args: unknown[] }>;
    impl: null | ((command: string, ...args: unknown[]) => Promise<unknown>);
  };
}).commands;
const stubUriFrom = (vscodeStub as unknown as {
  Uri: { from: (parts: { scheme: string; path: string }) => { scheme: string; path: string } };
}).Uri.from;

function resetCalls(): void {
  stubCommands.calls.length = 0;
  stubCommands.impl = null;
}

function bridgeCalls(): Array<{ command: string; args: unknown[] }> {
  return stubCommands.calls.filter((c) => c.command === TOOLTIP_REGISTER_EVENT_COMMAND);
}

// ---- emitTooltipEvent -------------------------------------------------------

describe("emitTooltipEvent (GAPS-176)", () => {
  it("calls the core bridge exactly once with the verbatim event name", () => {
    resetCalls();
    emitTooltipEvent("chat.open");
    assert.equal(bridgeCalls().length, 1);
    assert.deepEqual(bridgeCalls()[0]!.args, ["chat.open"]);
  });

  it("never throws when the bridge command rejects", async () => {
    resetCalls();
    stubCommands.impl = () => Promise.reject(new Error("command not registered"));
    assert.doesNotThrow(() => emitTooltipEvent("chat.open"));
    // Let the swallowed rejection settle — an unhandled rejection would
    // fail the node:test process.
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(bridgeCalls().length, 1);
    resetCalls();
  });
});

// ---- forwardWebviewTooltipEvent ----------------------------------------------

describe("forwardWebviewTooltipEvent allowlist (GAPS-176)", () => {
  it("forwards every allowlisted webview event exactly once", () => {
    for (const event of WEBVIEW_TOOLTIP_EVENTS) {
      resetCalls();
      assert.equal(forwardWebviewTooltipEvent(event), true, event);
      assert.equal(bridgeCalls().length, 1, event);
      assert.deepEqual(bridgeCalls()[0]!.args, [event]);
    }
  });

  it("drops non-allowlisted, malformed, and disable-path events", () => {
    const dropped: unknown[] = [
      "chat.submit", // already wired host-side by GAPS-170; webview must not re-emit
      "editor.cmdk.submit", // disable path — never webview-reported
      "terminal.cmdk.submit",
      "chat.open", // host-emitted at resolve, not webview-reported
      "chat.insert_selection", // bare prefix without the config's variant suffix
      "chat.copy.codeblock", // spec name; the real event carries `.manual`
      "",
      undefined,
      null,
      42,
      { event: "chat.type" },
    ];
    for (const event of dropped) {
      resetCalls();
      assert.equal(forwardWebviewTooltipEvent(event), false, String(event));
      assert.equal(bridgeCalls().length, 0, String(event));
    }
  });
});

// ---- addToChat tooltipInsertSource -------------------------------------------

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

function makeHost(): AddToChatHost & { posted: Array<Record<string, unknown>>; focused: boolean } {
  const posted: Array<Record<string, unknown>> = [];
  const host: AddToChatHost & { posted: Array<Record<string, unknown>>; focused: boolean } = {
    posted,
    focused: false,
    postToWebview: (m: unknown) => {
      posted.push(m as Record<string, unknown>);
    },
    focusChatView: async () => {
      host.focused = true;
    },
  };
  return host;
}

function clipboardQueue(values: string[]): () => Promise<string> {
  let i = 0;
  return async () => values[Math.min(i++, values.length - 1)];
}

describe("addToChat tooltipInsertSource (GAPS-176)", () => {
  it("tags a successful editor insert as editor", async () => {
    const seam = makeSeam({
      activeTextEditor: {
        document: {
          uri: stubUriFrom({ scheme: "file", path: "/proj/a.ts" }),
          getText: () => "const x = 1;",
        },
        selection: { isEmpty: false, start: { line: 4 } },
      } as never,
    });
    const host = makeHost();
    await addToChat(host, seam, { source: "editor" });
    assert.equal(host.posted.length, 1);
    assert.equal(host.posted[0]!.type, "addSelectionContext");
    assert.equal(host.posted[0]!.tooltipInsertSource, "editor");
  });

  it("tags a successful terminal insert (core toolbar path) as terminal", async () => {
    const host = makeHost();
    await addToChat(host, makeSeam({}), { source: "terminal", text: "$ npm test\nFAIL 1" });
    assert.equal(host.posted.length, 1);
    assert.equal(host.posted[0]!.tooltipInsertSource, "terminal");
  });

  it("tags a successful terminal insert (probe path) as terminal", async () => {
    const seam = makeSeam({
      activeTerminal: {} as never,
      readClipboardText: clipboardQueue(["before", "$ ls"]),
    });
    const host = makeHost();
    await addToChat(host, seam, { source: "terminal" });
    assert.equal(host.posted.length, 1);
    assert.equal(host.posted[0]!.tooltipInsertSource, "terminal");
  });

  it("posts nothing (hence no insert event) when the editor selection is empty", async () => {
    const seam = makeSeam({
      activeTextEditor: { document: {}, selection: { isEmpty: true } } as never,
    });
    const host = makeHost();
    await addToChat(host, seam, { source: "editor" });
    assert.equal(host.posted.length, 0);
  });

  it("posts nothing (hence no insert event) when the terminal probe finds no selection", async () => {
    const seam = makeSeam({
      activeTerminal: {} as never,
      readClipboardText: clipboardQueue(["same", "same"]),
    });
    const host = makeHost();
    await addToChat(host, seam, { source: "terminal" });
    assert.equal(host.posted.length, 0);
  });
});
