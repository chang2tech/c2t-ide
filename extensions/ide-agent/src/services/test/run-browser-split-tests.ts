/**
 * browser-split-tab tests (node:test, vscode stubbed via ./vscode-stub).
 *
 * Covers:
 *  - normalizeSplitDirection: string / {direction} / missing / invalid.
 *  - isIdeAgentWebviewBrowserTab: viewType match on the ide-agent webview tab.
 *  - splitBrowserTab: guard when the active editor is not a browser tab;
 *    opens 'workbench.action.browser.open' with { url, openToSide: true }
 *    preserving the active tab's URL.
 *  - splitBrowserTabToDirection: direction mapping to
 *    workbench.action.moveEditorTo<Above|Below|Left|Right>Group; invalid
 *    direction is rejected without opening anything.
 *  - registerBrowserSplitCommands: registers both Cursor command ids and
 *    pushes the disposables into context.subscriptions.
 *
 * Run after `tsc`:  node --test out/services/test/run-browser-split-tests.js
 */
import { describe, it } from "node:test";
import * as assert from "node:assert";
import "./vscode-stub";
import {
  SPLIT_BROWSER_TAB_COMMAND,
  SPLIT_BROWSER_TAB_TO_DIRECTION_COMMAND,
  IDE_AGENT_BROWSER_TAB_VIEW_TYPE,
  isIdeAgentWebviewBrowserTab,
  normalizeSplitDirection,
  splitBrowserTab,
  splitBrowserTabToDirection,
  registerBrowserSplitCommands,
  type BrowserSplitDeps,
  type BrowserSplitHost,
} from "../browserSplitService";

interface FakeContext {
  subscriptions: Array<{ dispose(): void }>;
}

function makeHost(overrides: Partial<BrowserSplitHost> = {}): BrowserSplitHost & {
  executed: Array<{ command: string; args: unknown[] }>;
  messages: string[];
  registered: Array<{ id: string; handler: (...args: unknown[]) => unknown }>;
} {
  const executed: Array<{ command: string; args: unknown[] }> = [];
  const messages: string[] = [];
  const registered: Array<{ id: string; handler: (...args: unknown[]) => unknown }> = [];
  const host: BrowserSplitHost = {
    getActiveTabInput: () => undefined,
    executeCommand: async (command: string, ...args: unknown[]) => {
      executed.push({ command, args });
    },
    showInformationMessage: (message: string) => {
      messages.push(message);
    },
    registerCommand: (id: string, handler: (...args: unknown[]) => unknown) => {
      registered.push({ id, handler });
      return { dispose: () => undefined };
    },
    ...overrides,
  };
  return Object.assign(host, { executed, messages, registered });
}

const browserTabDeps: BrowserSplitDeps = {
  isActiveBrowserTab: () => true,
  getActiveBrowserTabUrl: () => "https://example.com/docs",
};

describe("normalizeSplitDirection", () => {
  it("accepts the four directions case-insensitively", () => {
    assert.equal(normalizeSplitDirection("up"), "up");
    assert.equal(normalizeSplitDirection("DOWN"), "down");
    assert.equal(normalizeSplitDirection("Left"), "left");
    assert.equal(normalizeSplitDirection("right"), "right");
  });
  it("accepts { direction } object form", () => {
    assert.equal(normalizeSplitDirection({ direction: "down" }), "down");
  });
  it("defaults to right when missing", () => {
    assert.equal(normalizeSplitDirection(undefined), "right");
    assert.equal(normalizeSplitDirection(null), "right");
    assert.equal(normalizeSplitDirection({}), "right");
  });
  it("rejects anything else", () => {
    assert.equal(normalizeSplitDirection("sideways"), undefined);
    assert.equal(normalizeSplitDirection(42), undefined);
    assert.equal(normalizeSplitDirection({ direction: 1 }), undefined);
  });
});

describe("isIdeAgentWebviewBrowserTab", () => {
  it("matches the ide-agent webview browser tab viewType", () => {
    assert.equal(isIdeAgentWebviewBrowserTab({ viewType: IDE_AGENT_BROWSER_TAB_VIEW_TYPE }), true);
    assert.equal(isIdeAgentWebviewBrowserTab({ viewType: "other.view" }), false);
    assert.equal(isIdeAgentWebviewBrowserTab(undefined), false);
    assert.equal(isIdeAgentWebviewBrowserTab(null), false);
    assert.equal(isIdeAgentWebviewBrowserTab("ideAgent.browserTab"), false);
  });
});

describe("splitBrowserTab", () => {
  it("opens a new browser tab with the active tab URL in the side group", async () => {
    const host = makeHost();
    const result = await splitBrowserTab(browserTabDeps, host);
    assert.equal(result, "split");
    assert.equal(host.executed.length, 1);
    assert.equal(host.executed[0].command, "workbench.action.browser.open");
    assert.deepEqual(host.executed[0].args, [
      { url: "https://example.com/docs", openToSide: true },
    ]);
    assert.equal(host.messages.length, 0);
  });

  it("does nothing but inform when the active editor is not a browser tab", async () => {
    const host = makeHost();
    const result = await splitBrowserTab({ isActiveBrowserTab: () => false }, host);
    assert.equal(result, "not-a-browser-tab");
    assert.equal(host.executed.length, 0);
    assert.equal(host.messages.length, 1);
  });

  it("opens a blank tab when the URL is unavailable", async () => {
    const host = makeHost();
    const result = await splitBrowserTab({ isActiveBrowserTab: () => true }, host);
    assert.equal(result, "split");
    assert.deepEqual(host.executed[0].args, [{ url: undefined, openToSide: true }]);
  });

  it("awaits an async URL getter", async () => {
    const host = makeHost();
    const result = await splitBrowserTab(
      { isActiveBrowserTab: () => true, getActiveBrowserTabUrl: async () => "https://async.example/" },
      host,
    );
    assert.equal(result, "split");
    assert.deepEqual(host.executed[0].args, [{ url: "https://async.example/", openToSide: true }]);
  });
});

describe("splitBrowserTabToDirection", () => {
  it("moves the new tab into the requested directional group, keeping the URL", async () => {
    const host = makeHost();
    const result = await splitBrowserTabToDirection("left", browserTabDeps, host);
    assert.equal(result, "split");
    assert.equal(host.executed.length, 2);
    assert.equal(host.executed[0].command, "workbench.action.browser.open");
    assert.deepEqual(host.executed[0].args, [{ url: "https://example.com/docs" }]);
    assert.equal(host.executed[1].command, "workbench.action.moveEditorToLeftGroup");
  });

  it("maps every direction to its move command", async () => {
    const expected: Record<string, string> = {
      up: "workbench.action.moveEditorToAboveGroup",
      down: "workbench.action.moveEditorToBelowGroup",
      left: "workbench.action.moveEditorToLeftGroup",
      right: "workbench.action.moveEditorToRightGroup",
    };
    for (const [dir, cmd] of Object.entries(expected)) {
      const host = makeHost();
      const result = await splitBrowserTabToDirection(dir, browserTabDeps, host);
      assert.equal(result, "split", dir);
      assert.equal(host.executed[1].command, cmd, dir);
    }
  });

  it("rejects an invalid direction without opening anything", async () => {
    const host = makeHost();
    const result = await splitBrowserTabToDirection("sideways", browserTabDeps, host);
    assert.equal(result, "invalid-direction");
    assert.equal(host.executed.length, 0);
    assert.equal(host.messages.length, 1);
  });

  it("guards on non-browser active editor", async () => {
    const host = makeHost();
    const result = await splitBrowserTabToDirection("right", { isActiveBrowserTab: () => false }, host);
    assert.equal(result, "not-a-browser-tab");
    assert.equal(host.executed.length, 0);
  });
});

describe("registerBrowserSplitCommands", () => {
  it("registers both Cursor command ids and subscribes the disposables", async () => {
    const host = makeHost();
    const context = { subscriptions: [] } as FakeContext;
    const ids = registerBrowserSplitCommands(
      context as unknown as import("vscode").ExtensionContext,
      browserTabDeps,
      host,
    );
    assert.deepEqual(ids, [SPLIT_BROWSER_TAB_COMMAND, SPLIT_BROWSER_TAB_TO_DIRECTION_COMMAND]);
    assert.equal(SPLIT_BROWSER_TAB_COMMAND, "browser.splitEditorWithNewBrowserTab");
    assert.equal(SPLIT_BROWSER_TAB_TO_DIRECTION_COMMAND, "browser.splitEditorWithNewBrowserTabToDirection");
    assert.equal(context.subscriptions.length, 2);
    assert.deepEqual(
      host.registered.map((r) => r.id),
      ids,
    );

    // The registered handlers drive the same logic.
    const splitEntry = host.registered.find((r) => r.id === SPLIT_BROWSER_TAB_COMMAND)!;
    await splitEntry.handler();
    assert.equal(host.executed[0].command, "workbench.action.browser.open");

    const dirEntry = host.registered.find((r) => r.id === SPLIT_BROWSER_TAB_TO_DIRECTION_COMMAND)!;
    await dirEntry.handler("down");
    assert.equal(host.executed[2].command, "workbench.action.moveEditorToBelowGroup");
  });
});
