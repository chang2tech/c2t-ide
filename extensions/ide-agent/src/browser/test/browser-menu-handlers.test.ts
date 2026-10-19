/**
 * Browser "..." menu host-handler behavior tests (QA-BROWSERMENU P3-6).
 *
 * The 6 menu tests in browser-tab.test.ts only cover zoom-ladder math,
 * message validation and HTML rendering. These tests drive the actual host
 * handlers in BrowserTabManager (setZoom / hardReload / clearBrowsingData /
 * copyCurrentUrl / openDevTools / captureAreaToChat / startAreaSelect /
 * zoomStep) against a fake BrowserService + stubbed vscode, verifying:
 *   - hardReload sends Page.reload{ignoreCache:true} and re-applies zoom
 *     after the reload (P2-1);
 *   - setZoom evaluates document.body.style.zoom and updates zoomPercent;
 *   - clearBrowsingData shows the confirm dialog BEFORE any CDP call and
 *     aborts when the user cancels;
 *   - copyCurrentUrl copies the live URL, refuses about:blank (P3-3);
 *   - openDevTools is a singleton, re-checks disposed after awaits (P3-7/P3-8),
 *     and surfaces NO_DEBUG_PORT loudly;
 *   - captureAreaToChat passes the clip rect through and posts to chat.
 *
 * Run after `tsc`: node --test out/browser/test/browser-menu-handlers.test.js
 */
import { describe, it, beforeEach } from "node:test";
import * as assert from "node:assert";
import * as fs from "node:fs";
import "../../services/test/vscode-stub";
import "./setup-viewcolumn";
import { vscodeStub, windowStub } from "../../services/test/vscode-stub";
import { BrowserTabManager } from "../browserTab";

/* ---------- vscode surface augmentation (for the browser tab only) ---------- */

interface FakeWebview {
  html: string;
  posted: unknown[];
  postMessage(msg: unknown): void;
  onDidReceiveMessage(): { dispose(): void };
}
interface FakePanel {
  webview: FakeWebview;
  title: string;
  revealed: number;
  disposed: boolean;
  reveal(): void;
  dispose(): void;
  onDidDispose(fn: () => void): { dispose(): void };
}

const createdPanels: FakePanel[] = [];
let clipboardText: string | undefined;
let warningAnswer: string | undefined = "Clear";

function makePanel(title: string): FakePanel {
  const panel: FakePanel = {
    webview: {
      html: "",
      posted: [],
      postMessage(msg: unknown) {
        this.posted.push(msg);
      },
      onDidReceiveMessage() {
        return { dispose() {} };
      },
    },
    title,
    revealed: 0,
    disposed: false,
    reveal() {
      this.revealed++;
    },
    dispose() {
      this.disposed = true;
    },
    onDidDispose() {
      return { dispose() {} };
    },
  };
  createdPanels.push(panel);
  return panel;
}

// Augment the shared stub with the browser-tab surface (additive only).
// NOTE: ViewColumn is set in ./setup-viewcolumn (must run before browserTab
// is required — see that file).
(vscodeStub as Record<string, unknown>).env = {
  clipboard: {
    writeText: async (t: string) => {
      clipboardText = t;
    },
  },
};
const winStub = vscodeStub.window as Record<string, unknown>;
winStub.createWebviewPanel = (
  _viewType: string,
  title: string,
  _showOptions: unknown,
  _options: unknown,
) => makePanel(title);
windowStub.showWarningMessage = ((_msg: string, ..._rest: unknown[]) =>
  Promise.resolve(warningAnswer)) as typeof windowStub.showWarningMessage;

/* ---------- fakes ---------- */

interface CdpCall {
  method: string;
  params: Record<string, unknown>;
}
function makeFakeService() {
  const cdpCalls: CdpCall[] = [];
  const evalScripts: string[] = [];
  return {
    cdpCalls,
    evalScripts,
    navUrl: "https://example.com/",
    debugInfo: { host: "127.0.0.1", port: 19999, targetId: "TARGET1" } as
      | { host: string; port: number; targetId: string }
      | undefined,
    screenshotClip: undefined as unknown,
    async cdp(
      _sid: string | undefined,
      _agent: string,
      method: string,
      params: Record<string, unknown> = {},
    ): Promise<unknown> {
      cdpCalls.push({ method, params });
      return {};
    },
    // REVERIFY-P1-1: sanctioned internal clear path (bypasses the agent denylist).
    async clearBrowsingDataInternal(
      _sid: string | undefined,
      _agent: string,
      method: string,
    ): Promise<void> {
      cdpCalls.push({ method, params: {} });
    },
    async getNavState() {
      return {
        url: this.navUrl,
        title: "Example",
        canGoBack: false,
        canGoForward: false,
        viewportWidth: 1280,
        viewportHeight: 800,
      };
    },
    async evaluateInPage(_sid: string | undefined, _agent: string, script: string) {
      evalScripts.push(script);
      return true;
    },
    async getDebugInfo() {
      if (!this.debugInfo) {
        const { BrowserError } = await import("../types");
        throw new BrowserError("NO_DEBUG_PORT", "driver has no remote-debugging port");
      }
      return this.debugInfo;
    },
    async screenshot(
      _sid: string | undefined,
      _agent: string,
      opts: { clip?: unknown },
    ) {
      this.screenshotClip = opts.clip;
      return {
        content: [
          {
            type: "image",
            mimeType: "image/png",
            base64Data: Buffer.from([137, 80, 78, 71]).toString("base64"),
          },
        ],
      };
    },
  };
}

function makeManager() {
  const postedImages: Array<{ filePath: string; label: string }> = [];
  const postedElements: Array<{ label: string }> = [];
  const mgr = new BrowserTabManager(
    { subscriptions: [] } as never,
    {
      postImageToChat: (filePath: string, label: string) => {
        postedImages.push({ filePath, label });
      },
      postElementToChat: (label: string) => {
        postedElements.push({ label });
      },
      output: { appendLine() {} } as never,
    },
    () => undefined,
  );
  return { mgr, postedImages, postedElements };
}

function injectTab(mgr: BrowserTabManager, svc: ReturnType<typeof makeFakeService>) {
  const panel = makePanel("Browser");
  const rec = {
    panel,
    sessionId: "sess1",
    stopScreencast: null,
    unsubs: [] as Array<() => void>,
    pickerMode: false,
    renderMode: "live",
    loading: false,
    disposed: false,
    zoomPercent: 100,
    areaSelectMode: false,
    devToolsPanels: [] as FakePanel[],
  };
  (mgr as unknown as { service: unknown }).service = svc;
  (mgr as unknown as { tab: unknown }).tab = rec;
  // Bypass the real HTTP target lookup.
  (mgr as unknown as { resolveTargetWs: unknown }).resolveTargetWs = async () =>
    "ws://127.0.0.1:19999/devtools/page/TARGET1";
  return rec;
}

beforeEach(() => {
  createdPanels.length = 0;
  clipboardText = undefined;
  warningAnswer = "Clear";
});

/* ---------- setZoom ---------- */
describe("browser menu handlers — setZoom", () => {
  it("evaluates document.body.style.zoom and updates zoomPercent", async () => {
    const { mgr } = makeManager();
    const svc = makeFakeService();
    const rec = injectTab(mgr, svc);
    await mgr.setZoom(rec as never, 200);
    assert.strictEqual(svc.evalScripts.length, 1);
    assert.ok(svc.evalScripts[0].includes("b.style.zoom='200%'"), "zoom script sets 200%");
    assert.strictEqual(rec.zoomPercent, 200);
  });
  it("clamps to the Chromium ladder", async () => {
    const { mgr } = makeManager();
    const svc = makeFakeService();
    const rec = injectTab(mgr, svc);
    await mgr.setZoom(rec as never, 9999);
    assert.strictEqual(rec.zoomPercent, 500);
    assert.ok(svc.evalScripts[0].includes("'500%'"));
  });
});

/* ---------- hardReload (P2-1) ---------- */
describe("browser menu handlers — hardReload", () => {
  it("sends Page.reload with ignoreCache:true", async () => {
    const { mgr } = makeManager();
    const svc = makeFakeService();
    injectTab(mgr, svc);
    await mgr.hardReload();
    const reload = svc.cdpCalls.find((c) => c.method === "Page.reload");
    assert.ok(reload, "Page.reload sent");
    assert.deepStrictEqual(reload!.params, { ignoreCache: true });
  });
  it("re-applies a non-100% zoom after the reload (P2-1)", async () => {
    const { mgr } = makeManager();
    const svc = makeFakeService();
    const rec = injectTab(mgr, svc);
    rec.zoomPercent = 200;
    await mgr.hardReload();
    // hardReload itself must NOT re-apply synchronously (Page.reload ACK races
    // the new document — X1 note); the re-apply happens on loadEventFired.
    // Simulate the load event the same way open() wires it:
    await (mgr as unknown as { reapplyZoom(r: unknown): Promise<void> }).reapplyZoom(rec);
    assert.ok(
      svc.evalScripts.some((s) => s.includes("b.style.zoom='200%'")),
      "zoom re-applied after reload",
    );
  });
});

/* ---------- clearBrowsingData ---------- */
describe("browser menu handlers — clearBrowsingData", () => {
  it("shows the confirm dialog BEFORE any CDP call", async () => {
    const { mgr } = makeManager();
    const svc = makeFakeService();
    const rec = injectTab(mgr, svc);
    const order: string[] = [];
    const origClear = svc.clearBrowsingDataInternal.bind(svc);
    svc.clearBrowsingDataInternal = async (...a: Parameters<typeof svc.clearBrowsingDataInternal>) => {
      order.push("cdp");
      return origClear(...a);
    };
    windowStub.showWarningMessage = ((_m: string) => {
      order.push("dialog");
      return Promise.resolve(warningAnswer);
    }) as typeof windowStub.showWarningMessage;
    await mgr.clearBrowsingData(rec as never, "cookies");
    assert.deepStrictEqual(order, ["dialog", "cdp"], "dialog before delete");
    assert.ok(svc.cdpCalls.some((c) => c.method === "Network.clearBrowserCookies"));
    windowStub.showWarningMessage = ((_m: string) =>
      Promise.resolve(warningAnswer)) as typeof windowStub.showWarningMessage;
  });
  it("aborts when the user cancels", async () => {
    const { mgr } = makeManager();
    const svc = makeFakeService();
    const rec = injectTab(mgr, svc);
    warningAnswer = undefined;
    windowStub.showWarningMessage = ((_m: string) =>
      Promise.resolve(warningAnswer)) as typeof windowStub.showWarningMessage;
    await mgr.clearBrowsingData(rec as never, "cache");
    assert.strictEqual(svc.cdpCalls.length, 0, "no CDP on cancel");
    warningAnswer = "Clear";
    windowStub.showWarningMessage = ((_m: string) =>
      Promise.resolve(warningAnswer)) as typeof windowStub.showWarningMessage;
  });
  it("rejects unknown kinds at the type level (validation in tabView)", async () => {
    const { validateBrowserTabMessage } = await import("../tabView");
    assert.strictEqual(validateBrowserTabMessage({ type: "clearData", kind: "passwords" }), null);
  });
});

/* ---------- copyCurrentUrl (P3-3) ---------- */
describe("browser menu handlers — copyCurrentUrl", () => {
  it("copies the live URL", async () => {
    const { mgr } = makeManager();
    const svc = makeFakeService();
    injectTab(mgr, svc);
    await mgr.copyCurrentUrl();
    assert.strictEqual(clipboardText, "https://example.com/");
  });
  it("refuses about:blank instead of copying it (P3-3)", async () => {
    const { mgr } = makeManager();
    const svc = makeFakeService();
    svc.navUrl = "about:blank";
    const rec = injectTab(mgr, svc);
    await mgr.copyCurrentUrl();
    assert.strictEqual(clipboardText, undefined, "must not copy about:blank");
    const toasts = (rec.panel as FakePanel).webview.posted.filter(
      (m) => (m as { type: string }).type === "toast",
    );
    assert.ok(toasts.length > 0, "user gets a toast");
  });
});

/* ---------- openDevTools (P3-7/P3-8) ---------- */
describe("browser menu handlers — openDevTools", () => {
  it("is a singleton: second call reveals instead of creating", async () => {
    const { mgr } = makeManager();
    const svc = makeFakeService();
    const rec = injectTab(mgr, svc);
    await mgr.openDevTools();
    // Singleton is tracked on the tab record — the source of truth.
    assert.strictEqual(rec.devToolsPanels.length, 1, "first call tracks one panel");
    const first = rec.devToolsPanels[0] as FakePanel;
    const revealedBefore = first.revealed;
    await mgr.openDevTools();
    assert.strictEqual(rec.devToolsPanels.length, 1, "second call tracks none new");
    assert.strictEqual(
      first.revealed,
      revealedBefore + 1,
      "existing panel revealed instead of creating",
    );
  });
  it("does not open a panel when the tab was disposed mid-lookup (P3-8)", async () => {
    const { mgr } = makeManager();
    const svc = makeFakeService();
    const rec = injectTab(mgr, svc);
    // Dispose between getDebugInfo and panel creation.
    const origGetDebugInfo = svc.getDebugInfo.bind(svc);
    svc.getDebugInfo = async () => {
      const info = await origGetDebugInfo();
      rec.disposed = true;
      return info;
    };
    await mgr.openDevTools();
    assert.strictEqual(rec.devToolsPanels.length, 0, "no panel after dispose");
  });
  it("fails loud on NO_DEBUG_PORT", async () => {
    const { mgr } = makeManager();
    const svc = makeFakeService();
    svc.debugInfo = undefined;
    const rec = injectTab(mgr, svc);
    await mgr.openDevTools();
    assert.strictEqual(rec.devToolsPanels.length, 0, "no panel without debug port");
    const toasts = (rec.panel as FakePanel).webview.posted.filter(
      (m) => (m as { type: string }).type === "toast",
    );
    assert.ok(
      toasts.some((t) => String((t as { text: string }).text).includes("DevTools unavailable")),
      "loud toast",
    );
  });
});

/* ---------- captureAreaToChat ---------- */
describe("browser menu handlers — captureAreaToChat", () => {
  it("passes the clip rect to the screenshot call and posts to chat", async () => {
    const { mgr, postedImages } = makeManager();
    const svc = makeFakeService();
    const rec = injectTab(mgr, svc);
    await mgr.captureAreaToChat(rec as never, 10, 20, 300, 150);
    assert.deepStrictEqual(svc.screenshotClip, { x: 10, y: 20, width: 300, height: 150 });
    assert.strictEqual(postedImages.length, 1);
    assert.ok(postedImages[0].label.includes("area screenshot"));
    assert.ok(fs.existsSync(postedImages[0].filePath), "file written");
    fs.unlinkSync(postedImages[0].filePath);
  });
  it("clamps hostile clip values (defense in depth)", async () => {
    const { mgr, postedImages } = makeManager();
    const svc = makeFakeService();
    const rec = injectTab(mgr, svc);
    await mgr.captureAreaToChat(rec as never, -50, -20, 100, 100);
    const clip = svc.screenshotClip as { x: number; y: number };
    assert.ok(clip.x >= 0 && clip.y >= 0, "clamped to >= 0");
    for (const p of postedImages) {
      if (fs.existsSync(p.filePath)) fs.unlinkSync(p.filePath);
    }
  });
});

/* ---------- startAreaSelect (P3-3) ---------- */
describe("browser menu handlers — startAreaSelect", () => {
  it("refuses on a blank tab", async () => {
    const { mgr } = makeManager();
    const svc = makeFakeService();
    svc.navUrl = "about:blank";
    const rec = injectTab(mgr, svc);
    await mgr.startAreaSelect();
    assert.strictEqual(rec.areaSelectMode, false, "not entered on blank tab");
  });
  it("enters area-select on a loaded page", async () => {
    const { mgr } = makeManager();
    const svc = makeFakeService();
    const rec = injectTab(mgr, svc);
    await mgr.startAreaSelect();
    assert.strictEqual(rec.areaSelectMode, true);
  });
});

/* ---------- Page.loadEventFired → reapplyZoom wiring (REVERIFY-P3-7) ---------- */
describe("browser menu handlers — loadEventFired wiring", () => {
  it("registers Page.loadEventFired and re-applies zoom when it fires", async () => {
    const { mgr } = makeManager();
    const svc = makeFakeService();
    const handlers = new Map<string, () => void>();
    (svc as Record<string, unknown>).onPageEvent = (
      _sid: string | undefined,
      _agent: string,
      event: string,
      handler: () => void,
    ) => {
      handlers.set(event, handler);
      return () => {
        handlers.delete(event);
      };
    };
    const rec = injectTab(mgr, svc);
    rec.zoomPercent = 200;
    // Drive the extracted wiring directly (this is what open() calls).
    (mgr as unknown as { setupPageEventHandlers: (r: unknown, s: unknown) => void }).setupPageEventHandlers(rec, svc);
    const onLoad = handlers.get("Page.loadEventFired");
    assert.ok(onLoad, "Page.loadEventFired handler must be registered — deleting the listener must fail this test");
    svc.evalScripts.length = 0;
    onLoad!();
    // reapplyZoom is async (void promise) — let it run.
    await new Promise((r) => setTimeout(r, 10));
    assert.ok(
      svc.evalScripts.some((s) => s.includes("b.style.zoom='200%'")),
      `expected zoom re-apply script for 200%, got: ${JSON.stringify(svc.evalScripts)}`,
    );
  });

  it("does not re-apply when zoom is 100%", async () => {
    const { mgr } = makeManager();
    const svc = makeFakeService();
    const handlers = new Map<string, () => void>();
    (svc as Record<string, unknown>).onPageEvent = (
      _sid: string | undefined,
      _agent: string,
      event: string,
      handler: () => void,
    ) => {
      handlers.set(event, handler);
      return () => {
        handlers.delete(event);
      };
    };
    const rec = injectTab(mgr, svc);
    rec.zoomPercent = 100;
    (mgr as unknown as { setupPageEventHandlers: (r: unknown, s: unknown) => void }).setupPageEventHandlers(rec, svc);
    const onLoad = handlers.get("Page.loadEventFired");
    assert.ok(onLoad);
    svc.evalScripts.length = 0;
    onLoad!();
    await new Promise((r) => setTimeout(r, 10));
    assert.strictEqual(svc.evalScripts.length, 0, "no zoom script when zoom is 100%");
  });
});
