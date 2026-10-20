/**
 * Tests for the `cursor.browserView.*` command registry — Slice 3 (Group 1:
 * newTab, navigate, goBack, goForward, reload).
 *
 * No Chrome needed: the proposed `vscode.window.openBrowserTab` API and the
 * tab's CDP session are faked with the same message shapes the real
 * NativeBrowserPageDriver speaks. This exercises real wiring —
 * command → viewId resolution → driver → CDP request/response — end to end.
 */
// The vscode stub MUST be installed before any module importing "vscode".
import "../../test/vscode-stub";
import { describe, it, beforeEach } from "node:test";
import * as assert from "node:assert";
import { vscodeStub, windowStub } from "../../test/vscode-stub";
import { activateBrowserViewCommands } from "../browserViewCommands";
import { BrowserError } from "../../../browser/types";

/* ---------------- fake native browser API ---------------- */

interface SentMsg {
  id: number;
  method: string;
  params: Record<string, unknown>;
}

interface FakeSession {
  sent: SentMsg[];
  respond: (method: string, result: unknown) => void;
  fireEvent: (method: string, params?: unknown) => void;
}

function makeFakeTab(tabId: string, url = "about:blank") {
  const msgHandlers: Array<(m: unknown) => void> = [];
  const closeHandlers: Array<() => void> = [];
  const sent: SentMsg[] = [];
  let closed = false;
  // Stateful navigation history so goBack/goForward move the index.
  const histEntries = [{ id: 101 }, { id: 102 }];
  let histIndex = 1;

  function fakeCdpResult(method: string, _params: Record<string, unknown>): unknown {
    switch (method) {
      case "Page.enable":
      case "Runtime.enable":
      case "Page.reload":
        return {};
      case "Page.navigate":
        return {};
      case "Page.getNavigationHistory":
        return { currentIndex: histIndex, entries: histEntries };
      case "Page.navigateToHistoryEntry":
        return {};
      case "Page.captureScreenshot":
        return { data: Buffer.from("fakepng").toString("base64") };
      case "Page.getFrameTree":
        return { frameTree: { frame: { id: "frame-1" } } };
      case "Page.createIsolatedWorld":
        return { executionContextId: 7 };
      case "Runtime.evaluate": {
        const expr = typeof _params.expression === "string" ? _params.expression : "";
        if (expr.includes("querySelector")) {
          return { result: { value: { x: 10, y: 20, width: 100, height: 50 } } };
        }
        return { result: { value: 42 } };
      }
      case "Page.getLayoutMetrics":
        return {
          contentSize: { width: 800, height: 600 },
          visualViewport: { clientWidth: 800, clientHeight: 600 },
        };
      default:
        return {};
    }
  };
  const session = {
    sent,
    onDidReceiveMessage(h: (m: unknown) => void) {
      msgHandlers.push(h);
      return { dispose() {} };
    },
    onDidClose(h: () => void) {
      closeHandlers.push(h);
      return { dispose() {} };
    },
    async sendMessage(msg: SentMsg) {
      sent.push(msg);
      const result = fakeCdpResult(msg.method, msg.params);
      if (msg.method === "Page.navigateToHistoryEntry") {
        const idx = histEntries.findIndex((e) => e.id === msg.params.entryId);
        if (idx >= 0) {
          histIndex = idx;
        }
      }
      queueMicrotask(() => {
        for (const h of msgHandlers) {
          h({ id: msg.id, result });
        }
        // Complete the driver's load wait: a real page fires loadEventFired
        // after Page.navigate resolves.
        if (msg.method === "Page.navigate") {
          for (const h of msgHandlers) {
            h({ method: "Page.loadEventFired", params: {} });
          }
        }
      });
    },
    async close() {
      closed = true;
      for (const h of closeHandlers) {
        h();
      }
    },
    wasClosed: () => closed,
  };
  const sessionFacade: FakeSession = {
    sent,
    respond(method, result) {
      /* not needed; sendMessage auto-responds */
    },
    fireEvent(method, params) {
      for (const h of msgHandlers) {
        h({ method, params });
      }
    },
  };
  const tab = {
    id: tabId, // internal ExtHostBrowserTab id (read defensively by the registry)
    url,
    title: "fake",
    startCDPSession: async () => session,
    close: async () => {
      /* fake */
    },
  };
  return { tab, session, sessionFacade };
}

function fakeCdpResult(method: string, params: Record<string, unknown>): unknown {
  switch (method) {
    case "Page.enable":
    case "Runtime.enable":
    case "Page.reload":
    case "Page.navigateToHistoryEntry":
      return {};
    case "Page.navigate":
      return {};
    case "Page.getNavigationHistory":
      return { currentIndex: 1, entries: [{ id: 101 }, { id: 102 }] };
    case "Page.captureScreenshot":
      return { data: Buffer.from("fakepng").toString("base64") };
    case "Page.getLayoutMetrics":
      return {
        contentSize: { width: 800, height: 600 },
        visualViewport: { clientWidth: 800, clientHeight: 600 },
      };
    default:
      return {};
  }
}

function handlerFor(id: string): (...args: unknown[]) => unknown {
  const rec = (vscodeStub.commands.registrations as Array<{ id: string; handler: (...a: unknown[]) => unknown }>).find(
    (r) => r.id === id,
  );
  assert.ok(rec, `command ${id} must be registered`);
  return rec.handler;
}

async function invoke(id: string, args?: unknown): Promise<unknown> {
  return handlerFor(id)(args);
}

const fakeContext = { subscriptions: [] as Array<{ dispose(): void }> } as unknown as Parameters<
  typeof activateBrowserViewCommands
>[0];

describe("browserViewCommands — slice 3 (group 1)", () => {
  beforeEach(() => {
    // Reset stub state between tests.
    (vscodeStub.commands.registrations as unknown[]).length = 0;
    delete (windowStub as Record<string, unknown>).openBrowserTab;
    delete (windowStub as Record<string, unknown>).browserTabs;
    delete (windowStub as Record<string, unknown>).activeBrowserTab;
    activateBrowserViewCommands(fakeContext);
  });

  it("registers the group-1 + group-2 command IDs verbatim", () => {
    for (const id of [
      "cursor.browserView.newTab",
      "cursor.browserView.navigate",
      "cursor.browserView.goBack",
      "cursor.browserView.goForward",
      "cursor.browserView.reload",
      "cursor.browserView.newHeadlessTab",
      "cursor.browserView.showHeadlessTab",
      "cursor.browserView.isHeadless",
      "cursor.browserView.hideTab",
      "cursor.browserView.closeTab",
    ]) {
      handlerFor(id); // throws if missing
    }
  });

  it("fails fast with NATIVE_API_UNAVAILABLE when the browser API is absent", async () => {
    for (const id of ["cursor.browserView.newTab", "cursor.browserView.navigate"]) {
      await assert.rejects(() => invoke(id, { url: "https://example.com" }), (e: unknown) => {
        assert.ok(e instanceof BrowserError);
        assert.strictEqual((e as BrowserError).code, "NATIVE_API_UNAVAILABLE");
        return true;
      });
    }
  });

  it("newTab opens a native tab and returns its viewId", async () => {
    const { tab } = makeFakeTab("tab-1");
    (windowStub as Record<string, unknown>).openBrowserTab = async (url: string) => {
      assert.strictEqual(url, "https://example.com");
      return tab;
    };
    const res = (await invoke("cursor.browserView.newTab", { url: "https://example.com" })) as {
      viewId: string;
      url: string;
    };
    assert.strictEqual(res.viewId, "tab-1"); // internal tab id reused as viewId
    assert.strictEqual(res.url, "about:blank"); // fake tab's url
  });

  it("navigate drives Page.navigate through the real driver and defaults to the last tab", async () => {
    const { tab, sessionFacade } = makeFakeTab("tab-2");
    (windowStub as Record<string, unknown>).openBrowserTab = async () => tab;
    const created = (await invoke("cursor.browserView.newTab", { url: "about:blank" })) as { viewId: string };
    // viewId defaulting: no viewId passed → last interacted tab.
    const res = (await invoke("cursor.browserView.navigate", { url: "https://example.com" })) as {
      viewId: string;
      ok: boolean;
    };
    // The fake must answer the load wait or navigate() times out.
    assert.strictEqual(res.viewId, created.viewId);
    assert.strictEqual(res.ok, true);
    const methods = sessionFacade.sent.map((m) => m.method);
    assert.ok(methods.includes("Page.navigate"), `expected Page.navigate, got ${methods}`);
  });

  it("navigate rejects non-http(s) URLs via the driver's P0 guard", async () => {
    const { tab } = makeFakeTab("tab-3");
    (windowStub as Record<string, unknown>).openBrowserTab = async () => tab;
    await invoke("cursor.browserView.newTab", {});
    await assert.rejects(() => invoke("cursor.browserView.navigate", { url: "file:///etc/passwd" }), (e: unknown) => {
      assert.ok(e instanceof BrowserError);
      assert.strictEqual((e as BrowserError).code, "INVALID_ARGS");
      return true;
    });
  });

  it("goBack/goForward use Page.getNavigationHistory + Page.navigateToHistoryEntry", async () => {
    const { tab, sessionFacade } = makeFakeTab("tab-4");
    (windowStub as Record<string, unknown>).openBrowserTab = async () => tab;
    await invoke("cursor.browserView.newTab", {});
    await invoke("cursor.browserView.goBack", {});
    let methods = sessionFacade.sent.map((m) => m.method);
    assert.ok(methods.includes("Page.getNavigationHistory"));
    assert.ok(methods.includes("Page.navigateToHistoryEntry"));
    const backEntry = sessionFacade.sent.find((m) => m.method === "Page.navigateToHistoryEntry");
    assert.strictEqual(backEntry!.params.entryId, 101); // currentIndex-1
    sessionFacade.sent.length = 0;
    await invoke("cursor.browserView.goForward", {});
    methods = sessionFacade.sent.map((m) => m.method);
    assert.ok(methods.includes("Page.navigateToHistoryEntry"));
    const fwdEntry = sessionFacade.sent.find((m) => m.method === "Page.navigateToHistoryEntry");
    assert.strictEqual(fwdEntry!.params.entryId, 102); // currentIndex+1
  });

  it("reload sends Page.reload with ignoreCache for hard=true", async () => {
    const { tab, sessionFacade } = makeFakeTab("tab-5");
    (windowStub as Record<string, unknown>).openBrowserTab = async () => tab;
    await invoke("cursor.browserView.newTab", {});
    await invoke("cursor.browserView.reload", { hard: true });
    const reload = sessionFacade.sent.find((m) => m.method === "Page.reload");
    assert.ok(reload);
    assert.strictEqual(reload.params.ignoreCache, true);
  });

  it("take_screenshot_afterwards attaches a real screenshot to the result", async () => {
    const { tab } = makeFakeTab("tab-6");
    (windowStub as Record<string, unknown>).openBrowserTab = async () => tab;
    await invoke("cursor.browserView.newTab", {});
    const res = (await invoke("cursor.browserView.reload", { take_screenshot_afterwards: true })) as {
      screenshot?: { dataUrl: string; mimeType: string };
    };
    assert.ok(res.screenshot, "screenshot must be attached");
    assert.ok(res.screenshot.dataUrl.startsWith("data:image/png;base64,"));
  });

  it("unknown viewId throws UNKNOWN_VIEW", async () => {
    const { tab } = makeFakeTab("tab-7");
    (windowStub as Record<string, unknown>).openBrowserTab = async () => tab;
    await invoke("cursor.browserView.newTab", {});
    await assert.rejects(() => invoke("cursor.browserView.navigate", { viewId: "nope", url: "https://example.com" }), (e: unknown) => {
      assert.ok(e instanceof BrowserError);
      assert.strictEqual((e as BrowserError).code, "UNKNOWN_VIEW");
      return true;
    });
  });
});

describe("browserViewCommands — slice 4 (group 2)", () => {
  beforeEach(() => {
    (vscodeStub.commands.registrations as unknown[]).length = 0;
    (vscodeStub.commands.calls as unknown[]).length = 0;
    delete (windowStub as Record<string, unknown>).openBrowserTab;
    delete (windowStub as Record<string, unknown>).browserTabs;
    delete (windowStub as Record<string, unknown>).activeBrowserTab;
    activateBrowserViewCommands(fakeContext);
  });

  it("newHeadlessTab opens in background and reports headless", async () => {
    let sawOptions: unknown;
    (windowStub as Record<string, unknown>).openBrowserTab = async (url: string, options: unknown) => {
      sawOptions = options;
      return makeFakeTab("tab-h1", url).tab;
    };
    const res = (await invoke("cursor.browserView.newHeadlessTab", { url: "https://example.com" })) as {
      viewId: string;
      headless: boolean;
    };
    assert.strictEqual(res.viewId, "tab-h1");
    assert.strictEqual(res.headless, true);
    assert.deepStrictEqual(sawOptions, { background: true, preserveFocus: true });
    const check = (await invoke("cursor.browserView.isHeadless", { viewId: "tab-h1" })) as {
      headless: boolean;
    };
    assert.strictEqual(check.headless, true);
  });

  it("showHeadlessTab promotes to visible and focuses via vscode.open on the browser URI", async () => {
    (windowStub as Record<string, unknown>).openBrowserTab = async () => makeFakeTab("tab-h2").tab;
    await invoke("cursor.browserView.newHeadlessTab", {});
    await invoke("cursor.browserView.showHeadlessTab", { viewId: "tab-h2" });
    const calls = vscodeStub.commands.calls as Array<{ command: string; args: unknown[] }>;
    const open = calls.find((c) => c.command === "vscode.open");
    assert.ok(open, "must focus through vscode.open");
    assert.strictEqual((open.args[0] as { toString(): string }).toString(), "vscode-browser:///tab-h2");
    const check = (await invoke("cursor.browserView.isHeadless", { viewId: "tab-h2" })) as {
      headless: boolean;
    };
    assert.strictEqual(check.headless, false);
  });

  it("hideTab marks hidden without closing; closeTab destroys the view", async () => {
    (windowStub as Record<string, unknown>).openBrowserTab = async () => makeFakeTab("tab-h3").tab;
    await invoke("cursor.browserView.newTab", {});
    const hid = (await invoke("cursor.browserView.hideTab", { viewId: "tab-h3" })) as {
      ok: boolean;
      hidden: boolean;
    };
    assert.strictEqual(hid.ok, true);
    assert.strictEqual(hid.hidden, true);
    // View still resolvable after hide.
    await invoke("cursor.browserView.isHeadless", { viewId: "tab-h3" });
    await invoke("cursor.browserView.closeTab", { viewId: "tab-h3" });
    await assert.rejects(() => invoke("cursor.browserView.isHeadless", { viewId: "tab-h3" }), (e: unknown) => {
      assert.ok(e instanceof BrowserError);
      assert.strictEqual((e as BrowserError).code, "UNKNOWN_VIEW");
      return true;
    });
  });
});

describe("browserViewCommands — slice 5 (group 3)", () => {
  beforeEach(() => {
    (vscodeStub.commands.registrations as unknown[]).length = 0;
    (vscodeStub.commands.calls as unknown[]).length = 0;
    delete (windowStub as Record<string, unknown>).openBrowserTab;
    delete (windowStub as Record<string, unknown>).browserTabs;
    delete (windowStub as Record<string, unknown>).activeBrowserTab;
    activateBrowserViewCommands(fakeContext);
  });

  it("selectTab/focusOrShowTab focus through vscode.open", async () => {
    (windowStub as Record<string, unknown>).openBrowserTab = async () => makeFakeTab("tab-s1").tab;
    await invoke("cursor.browserView.newTab", {});
    await invoke("cursor.browserView.selectTab", { viewId: "tab-s1" });
    await invoke("cursor.browserView.focusOrShowTab", { viewId: "tab-s1" });
    const calls = vscodeStub.commands.calls as Array<{ command: string; args: unknown[] }>;
    const opens = calls.filter((c) => c.command === "vscode.open");
    assert.strictEqual(opens.length, 2);
    assert.ok(
      opens.every((o) => (o.args[0] as { toString(): string }).toString() === "vscode-browser:///tab-s1"),
    );
  });

  it("getURL/getTitle read the live tab state", async () => {
    const { tab } = makeFakeTab("tab-s2", "https://example.com/page");
    tab.title = "Example Page";
    (windowStub as Record<string, unknown>).openBrowserTab = async () => tab;
    await invoke("cursor.browserView.newTab", {});
    const u = (await invoke("cursor.browserView.getURL", {})) as { url: string };
    const t = (await invoke("cursor.browserView.getTitle", {})) as { title: string };
    assert.strictEqual(u.url, "https://example.com/page");
    assert.strictEqual(t.title, "Example Page");
  });

  it("listTabs returns the REA shape and adopts externally opened tabs", async () => {
    const ext = makeFakeTab("tab-ext", "https://external.example");
    (windowStub as Record<string, unknown>).openBrowserTab = async () => makeFakeTab("tab-s3").tab;
    (windowStub as Record<string, unknown>).browserTabs = [ext.tab];
    await invoke("cursor.browserView.newHeadlessTab", { ownerAgentId: "agent-1" });
    const list = (await invoke("cursor.browserView.listTabs", {})) as {
      viewIds: string[];
      activeViewId: string | undefined;
      lastInteractedViewId: string | undefined;
      headlessViewIds: string[];
      owners: Record<string, string>;
    };
    assert.ok(list.viewIds.includes("tab-s3"), `viewIds: ${list.viewIds}`);
    assert.ok(list.viewIds.includes("tab-ext"), `externally opened tab adopted: ${list.viewIds}`);
    assert.deepStrictEqual(list.headlessViewIds, ["tab-s3"]);
    assert.strictEqual(list.owners["tab-s3"], "agent-1");
  });
});

describe("browserViewCommands — slice 6 (group 4)", () => {
  beforeEach(() => {
    (vscodeStub.commands.registrations as unknown[]).length = 0;
    (vscodeStub.commands.calls as unknown[]).length = 0;
    delete (windowStub as Record<string, unknown>).openBrowserTab;
    delete (windowStub as Record<string, unknown>).browserTabs;
    delete (windowStub as Record<string, unknown>).activeBrowserTab;
    activateBrowserViewCommands(fakeContext);
  });

  function openTab(tabId: string): ReturnType<typeof makeFakeTab> {
    const f = makeFakeTab(tabId);
    (windowStub as Record<string, unknown>).openBrowserTab = async () => f.tab;
    return f;
  }

  it("takeScreenshot returns a real dataUrl capture", async () => {
    openTab("tab-c1");
    await invoke("cursor.browserView.newTab", {});
    const res = (await invoke("cursor.browserView.takeScreenshot", {})) as {
      dataUrl: string;
      mimeType: string;
      viewportWidth: number;
    };
    assert.ok(res.dataUrl.startsWith("data:image/png;base64,"));
    assert.strictEqual(res.mimeType, "image/png");
    assert.strictEqual(res.viewportWidth, 800);
  });

  it("takeScreenshot with a selector ref clips to the measured element rect", async () => {
    const f = openTab("tab-c2");
    await invoke("cursor.browserView.newTab", {});
    await invoke("cursor.browserView.takeScreenshot", { ref: "#hero" });
    const shot = f.session.sent.find((m) => m.method === "Page.captureScreenshot");
    assert.ok(shot, "Page.captureScreenshot must be sent");
    assert.deepStrictEqual(shot.params.clip, { x: 10, y: 20, width: 100, height: 50, scale: 1 });
  });

  it("takeScreenshot with a non-selector ref throws instead of mis-shooting", async () => {
    openTab("tab-c3");
    await invoke("cursor.browserView.newTab", {});
    await assert.rejects(() => invoke("cursor.browserView.takeScreenshot", { ref: 123 }), (e: unknown) => {
      assert.ok(e instanceof BrowserError);
      assert.strictEqual((e as BrowserError).code, "INVALID_ARGS");
      return true;
    });
  });

  it("updateScreenshot stores the live thumbnail", async () => {
    openTab("tab-c4");
    await invoke("cursor.browserView.newTab", {});
    const res = (await invoke("cursor.browserView.updateScreenshot", {
      viewId: "tab-c4",
      dataUrl: "data:image/png;base64,thumb",
    })) as { ok: boolean };
    assert.strictEqual(res.ok, true);
    await assert.rejects(
      () => invoke("cursor.browserView.updateScreenshot", { viewId: "tab-c4", dataUrl: "not-a-data-url" }),
      (e: unknown) => (e as BrowserError).code === "INVALID_ARGS",
    );
  });

  it("getConsoleLogs returns CDP-captured console entries", async () => {
    const f = openTab("tab-c5");
    await invoke("cursor.browserView.newTab", {});
    // First call subscribes the view (Log.enable sent), then events flow.
    await invoke("cursor.browserView.getConsoleLogs", {});
    const methods = f.session.sent.map((m) => m.method);
    assert.ok(methods.includes("Log.enable"), `expected Log.enable, got ${methods}`);
    f.sessionFacade.fireEvent("Runtime.consoleAPICalled", {
      type: "log",
      args: [{ value: "hello" }, { value: 7 }],
    });
    f.sessionFacade.fireEvent("Log.entryAdded", {
      entry: { level: "warning", text: "slow", source: "network" },
    });
    const res = (await invoke("cursor.browserView.getConsoleLogs", {})) as {
      logs: Array<{ level: string; text: string; source?: string }>;
    };
    assert.strictEqual(res.logs.length, 2);
    assert.strictEqual(res.logs[0].text, "hello 7");
    assert.strictEqual(res.logs[1].source, "network");
  });

  it("getNetworkRequests correlates request/response/finish events", async () => {
    const f = openTab("tab-c6");
    await invoke("cursor.browserView.newTab", {});
    await invoke("cursor.browserView.getNetworkRequests", {});
    assert.ok(f.session.sent.map((m) => m.method).includes("Network.enable"));
    f.sessionFacade.fireEvent("Network.requestWillBeSent", {
      requestId: "r1",
      request: { url: "https://example.com/a.js", method: "GET" },
    });
    f.sessionFacade.fireEvent("Network.responseReceived", {
      requestId: "r1",
      response: { status: 200, mimeType: "application/javascript" },
    });
    f.sessionFacade.fireEvent("Network.loadingFinished", { requestId: "r1" });
    f.sessionFacade.fireEvent("Network.requestWillBeSent", {
      requestId: "r2",
      request: { url: "https://example.com/b.js", method: "GET" },
    });
    f.sessionFacade.fireEvent("Network.loadingFailed", { requestId: "r2", errorText: "net::ERR_ABORTED" });
    const res = (await invoke("cursor.browserView.getNetworkRequests", {})) as {
      requests: Array<{ url: string; status?: number; failed?: boolean; errorText?: string }>;
    };
    assert.strictEqual(res.requests.length, 2);
    assert.strictEqual(res.requests[0].status, 200);
    assert.strictEqual(res.requests[1].failed, true);
    assert.strictEqual(res.requests[1].errorText, "net::ERR_ABORTED");
  });

  it("executeJavaScript evaluates in-page and returns the value", async () => {
    openTab("tab-c7");
    await invoke("cursor.browserView.newTab", {});
    const res = (await invoke("cursor.browserView.executeJavaScript", {
      script: "1 + 1",
    })) as { result: unknown; ok: boolean };
    assert.strictEqual(res.ok, true);
    assert.strictEqual(res.result, 42); // fake Runtime.evaluate result
    await assert.rejects(() => invoke("cursor.browserView.executeJavaScript", {}), (e: unknown) => {
      assert.ok(e instanceof BrowserError);
      assert.strictEqual((e as BrowserError).code, "INVALID_ARGS");
      return true;
    });
  });
});

describe("browserViewCommands — slice 7 (group 5)", () => {
  beforeEach(() => {
    (vscodeStub.commands.registrations as unknown[]).length = 0;
    (vscodeStub.commands.calls as unknown[]).length = 0;
    delete (windowStub as Record<string, unknown>).openBrowserTab;
    delete (windowStub as Record<string, unknown>).browserTabs;
    delete (windowStub as Record<string, unknown>).activeBrowserTab;
    activateBrowserViewCommands(fakeContext);
  });

  function openTab(tabId: string): ReturnType<typeof makeFakeTab> {
    const f = makeFakeTab(tabId);
    (windowStub as Record<string, unknown>).openBrowserTab = async () => f.tab;
    return f;
  }

  it("executeJavaScriptInIsolatedWorld creates a world and evaluates in it", async () => {
    const f = openTab("tab-d1");
    await invoke("cursor.browserView.newTab", {});
    const res = (await invoke("cursor.browserView.executeJavaScriptInIsolatedWorld", {
      script: "location.href",
      worldName: "agent-world",
    })) as { result: unknown; ok: boolean };
    assert.strictEqual(res.ok, true);
    assert.strictEqual(res.result, 42); // fake Runtime.evaluate result
    const methods = f.session.sent.map((m) => m.method);
    assert.ok(methods.includes("Page.getFrameTree"));
    const world = f.session.sent.find((m) => m.method === "Page.createIsolatedWorld");
    assert.ok(world);
    assert.strictEqual(world.params.worldName, "agent-world");
    const evalMsg = f.session.sent.filter((m) => m.method === "Runtime.evaluate").pop();
    assert.strictEqual(evalMsg!.params.contextId, 7);
  });

  it("sendCDPCommand passes allowed methods through and enforces the denylist", async () => {
    openTab("tab-d2");
    await invoke("cursor.browserView.newTab", {});
    const ok = (await invoke("cursor.browserView.sendCDPCommand", {
      method: "Runtime.evaluate",
      params: { expression: "1" },
    })) as { ok: boolean; result: unknown };
    assert.strictEqual(ok.ok, true);
    for (const denied of [
      "Input.dispatchKeyEvent", // Input.* rejected
      "Browser.getVersion", // domain-prefix deny
      "Page.navigate", // exact-method deny
      "Network.getCookies", // exact-method deny
    ]) {
      await assert.rejects(
        () => invoke("cursor.browserView.sendCDPCommand", { method: denied }),
        (e: unknown) => {
          assert.ok(e instanceof BrowserError);
          assert.strictEqual((e as BrowserError).code, "UNSUPPORTED");
          return true;
        },
        `expected ${denied} to be denied`,
      );
    }
  });

  it("resize drives Emulation.setDeviceMetricsOverride", async () => {
    const f = openTab("tab-d3");
    await invoke("cursor.browserView.newTab", {});
    await invoke("cursor.browserView.resize", { width: 390, height: 844, mobile: true });
    const msg = f.session.sent.find((m) => m.method === "Emulation.setDeviceMetricsOverride");
    assert.ok(msg);
    assert.deepStrictEqual(msg.params, {
      width: 390,
      height: 844,
      deviceScaleFactor: 0,
      mobile: true,
    });
    await assert.rejects(() => invoke("cursor.browserView.resize", { width: -1, height: 10 }), (e: unknown) => {
      assert.ok(e instanceof BrowserError);
      assert.strictEqual((e as BrowserError).code, "INVALID_ARGS");
      return true;
    });
  });

  it("clearAgentDeviceEmulation clears the device-metrics override", async () => {
    const f = openTab("tab-d4");
    await invoke("cursor.browserView.newTab", {});
    await invoke("cursor.browserView.clearAgentDeviceEmulation", {});
    assert.ok(f.session.sent.some((m) => m.method === "Emulation.clearDeviceMetricsOverride"));
  });
});

describe("browserViewCommands — slice 8 (group 6)", () => {
  beforeEach(() => {
    (vscodeStub.commands.registrations as unknown[]).length = 0;
    (vscodeStub.commands.calls as unknown[]).length = 0;
    delete (windowStub as Record<string, unknown>).openBrowserTab;
    delete (windowStub as Record<string, unknown>).browserTabs;
    delete (windowStub as Record<string, unknown>).activeBrowserTab;
    activateBrowserViewCommands(fakeContext);
  });

  it("setLocked/isLocked round-trips lock state with owner", async () => {
    (windowStub as Record<string, unknown>).openBrowserTab = async () => makeFakeTab("tab-e1").tab;
    await invoke("cursor.browserView.newTab", {});
    const locked = (await invoke("cursor.browserView.setLocked", {
      viewId: "tab-e1",
      locked: true,
      ownerAgentId: "agent-9",
    })) as { locked: boolean };
    assert.strictEqual(locked.locked, true);
    const check = (await invoke("cursor.browserView.isLocked", { viewId: "tab-e1" })) as {
      locked: boolean;
      lockedBy?: string;
    };
    assert.strictEqual(check.locked, true);
    assert.strictEqual(check.lockedBy, "agent-9");
    await invoke("cursor.browserView.setLocked", { viewId: "tab-e1", locked: false });
    const after = (await invoke("cursor.browserView.isLocked", { viewId: "tab-e1" })) as {
      locked: boolean;
    };
    assert.strictEqual(after.locked, false);
  });

  it("setRecordingType/getRecordingType stores the type verbatim", async () => {
    (windowStub as Record<string, unknown>).openBrowserTab = async () => makeFakeTab("tab-e2").tab;
    await invoke("cursor.browserView.newTab", {});
    const before = (await invoke("cursor.browserView.getRecordingType", {})) as {
      recordingType?: string;
    };
    assert.strictEqual(before.recordingType, undefined);
    await invoke("cursor.browserView.setRecordingType", { type: "video" });
    const after = (await invoke("cursor.browserView.getRecordingType", {})) as {
      recordingType?: string;
    };
    assert.strictEqual(after.recordingType, "video");
    await assert.rejects(() => invoke("cursor.browserView.setRecordingType", {}), (e: unknown) => {
      assert.ok(e instanceof BrowserError);
      assert.strictEqual((e as BrowserError).code, "INVALID_ARGS");
      return true;
    });
  });

  it("configureDialogHandling auto-answers JS dialogs via CDP", async () => {
    const f = openTab("tab-e3");
    await invoke("cursor.browserView.newTab", {});
    const res = (await invoke("cursor.browserView.configureDialogHandling", {
      mode: "accept",
      promptText: "typed",
    })) as { ok: boolean };
    assert.strictEqual(res.ok, true);
    // A dialog opening is answered through Page.handleJavaScriptDialog.
    f.sessionFacade.fireEvent("Page.javascriptDialogOpening", { url: "https://example.com" });
    await new Promise((r) => setTimeout(r, 20));
    const handled = f.session.sent.find((m) => m.method === "Page.handleJavaScriptDialog");
    assert.ok(handled, "dialog must be auto-handled");
    assert.deepStrictEqual(handled.params, { accept: true, promptText: "typed" });
    await assert.rejects(
      () => invoke("cursor.browserView.configureDialogHandling", { mode: "maybe" }),
      (e: unknown) => {
        assert.ok(e instanceof BrowserError);
        assert.strictEqual((e as BrowserError).code, "INVALID_ARGS");
        return true;
      },
    );
  });

  function openTab(tabId: string): ReturnType<typeof makeFakeTab> {
    const f = makeFakeTab(tabId);
    (windowStub as Record<string, unknown>).openBrowserTab = async () => f.tab;
    return f;
  }
});

describe("browserViewCommands — completeness", () => {
  it("registers exactly the 29 implemented command IDs (blur + allowlist pending per QA)", () => {
    (vscodeStub.commands.registrations as unknown[]).length = 0;
    activateBrowserViewCommands(fakeContext);
    const expected = [
      "cursor.browserView.executeJavaScript",
      "cursor.browserView.executeJavaScriptInIsolatedWorld",
      "cursor.browserView.takeScreenshot",
      "cursor.browserView.updateScreenshot",
      "cursor.browserView.reload",
      "cursor.browserView.navigate",
      "cursor.browserView.goBack",
      "cursor.browserView.goForward",
      "cursor.browserView.newTab",
      "cursor.browserView.closeTab",
      "cursor.browserView.hideTab",
      "cursor.browserView.showHeadlessTab",
      "cursor.browserView.newHeadlessTab",
      "cursor.browserView.isHeadless",
      "cursor.browserView.selectTab",
      "cursor.browserView.focusOrShowTab",
      "cursor.browserView.listTabs",
      "cursor.browserView.getURL",
      "cursor.browserView.getTitle",
      "cursor.browserView.getConsoleLogs",
      "cursor.browserView.getNetworkRequests",
      "cursor.browserView.sendCDPCommand",
      "cursor.browserView.setLocked",
      "cursor.browserView.isLocked",
      "cursor.browserView.setRecordingType",
      "cursor.browserView.getRecordingType",
      "cursor.browserView.configureDialogHandling",
      "cursor.browserView.clearAgentDeviceEmulation",
      "cursor.browserView.resize",
    ].sort();
    const actual = (
      vscodeStub.commands.registrations as Array<{ id: string }>
    )
      .map((r) => r.id)
      .sort();
    assert.deepStrictEqual(actual, expected);
  });
});
