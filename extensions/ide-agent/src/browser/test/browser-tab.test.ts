/**
 * Browser-tab UI tests (node:test, zero extra deps).
 *
 * Unit: omnibar URL normalization, webview message validation, tab HTML
 * rendering (incl. XSS escaping), Chromium resolution, and the
 * BrowserService tab surface (nav state, back/forward, click/scroll/key
 * forwarding, screencast, element pick) against a fake driver.
 *
 * Imported by run-tests.ts. Run after `tsc`: node out/browser/test/run-tests.js
 */
import { describe, it } from "node:test";
import * as assert from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  normalizeOmnibarUrl,
  validateBrowserTabMessage,
  renderBrowserTabHtml,
  zoomStepIn,
  zoomStepOut,
  clampZoom,
  ZOOM_MIN,
  ZOOM_MAX,
} from "../tabView";
import { browserCaptureDir, resolveChromiumPath, screenshotFilename, saveUserImageDataUrl, userImageAttachmentsDir } from "../chromium";
import { PickerController } from "../picker";
import { BrowserService, ServiceDriver } from "../service";
import type { PageDriver, ScreencastOptions } from "../driver";

/* ---------- unit: omnibar URL normalization ---------- */
describe("browser tab omnibar", () => {
  it("upgrades bare domains to https", () => {
    assert.strictEqual(normalizeOmnibarUrl("example.com"), "https://example.com/");
    assert.strictEqual(normalizeOmnibarUrl("  docs.cursor.com/cli  "), "https://docs.cursor.com/cli");
  });
  it("passes http(s) URLs through", () => {
    assert.strictEqual(normalizeOmnibarUrl("http://localhost:3000/x"), "http://localhost:3000/x");
    assert.strictEqual(normalizeOmnibarUrl("https://a.b/?q=1"), "https://a.b/?q=1");
  });
  it("rejects dangerous schemes (P0 — no local-file exfil channel)", () => {
    assert.strictEqual(normalizeOmnibarUrl("javascript:alert(1)"), null);
    assert.strictEqual(normalizeOmnibarUrl("file:///etc/passwd"), null);
    assert.strictEqual(normalizeOmnibarUrl("data:text/html,<h1>x</h1>"), null);
    assert.strictEqual(normalizeOmnibarUrl(""), null);
    assert.strictEqual(normalizeOmnibarUrl("   "), null);
    assert.strictEqual(normalizeOmnibarUrl("not a url"), null);
  });
  it("accepts bare localhost/loopback as http (QA-BROWSERTAB-01 P2)", () => {
    assert.strictEqual(normalizeOmnibarUrl("localhost:3000"), "http://localhost:3000/");
    assert.strictEqual(normalizeOmnibarUrl("localhost"), "http://localhost/");
    assert.strictEqual(normalizeOmnibarUrl("localhost:3000/path?q=1"), "http://localhost:3000/path?q=1");
    assert.strictEqual(normalizeOmnibarUrl("127.0.0.1:8080"), "http://127.0.0.1:8080/");
    assert.strictEqual(normalizeOmnibarUrl("  localhost:3000  "), "http://localhost:3000/");
  });
  it("still rejects every dangerous scheme after the localhost fix (regression)", () => {
    for (const bad of [
      "javascript:alert(1)",
      "JAVASCRIPT:alert(1)",
      "JaVaScRiPt:alert(1)",
      "java\tscript:alert(1)",
      "java\nscript:alert(1)",
      "ｊavascript:alert(1)",
      "data:text/html,<h1>x</h1>",
      "file:///etc/passwd",
      "FILE:///etc/passwd",
      "vbscript:msgbox(1)",
      "blob:https://example.com/x",
      "about:blank",
      "chrome://settings",
      "view-source:https://example.com/",
    ]) {
      assert.strictEqual(normalizeOmnibarUrl(bad), null, `must reject: ${JSON.stringify(bad)}`);
    }
    // Public host:port keeps the previous conservative behavior.
    assert.strictEqual(normalizeOmnibarUrl("example.com:8080"), null);
  });
});

/* ---------- unit: webview message validation ---------- */
describe("browser tab message validation", () => {
  it("accepts the full chrome message set", () => {
    assert.deepStrictEqual(validateBrowserTabMessage({ type: "navigate", url: "https://x.io" }), {
      type: "navigate",
      url: "https://x.io",
    });
    for (const t of ["back", "forward", "reload", "screenshot", "togglePicker", "refreshSnapshot"]) {
      assert.ok(validateBrowserTabMessage({ type: t }), t);
    }
    assert.deepStrictEqual(validateBrowserTabMessage({ type: "pageClick", x: 10, y: 20 }), {
      type: "pageClick",
      x: 10,
      y: 20,
    });
    assert.deepStrictEqual(
      validateBrowserTabMessage({ type: "pageWheel", deltaX: 0, deltaY: 100, x: 5, y: 5 }),
      { type: "pageWheel", deltaX: 0, deltaY: 100, x: 5, y: 5 },
    );
    assert.deepStrictEqual(validateBrowserTabMessage({ type: "pageKey", key: "Enter" }), {
      type: "pageKey",
      key: "Enter",
    });
  });
  it("rejects malformed / hostile messages", () => {
    assert.strictEqual(validateBrowserTabMessage(null), null);
    assert.strictEqual(validateBrowserTabMessage("navigate"), null);
    assert.strictEqual(validateBrowserTabMessage({ type: "navigate" }), null);
    assert.strictEqual(validateBrowserTabMessage({ type: "navigate", url: "x".repeat(3000) }), null);
    assert.strictEqual(validateBrowserTabMessage({ type: "pageClick", x: NaN, y: 1 }), null);
    assert.strictEqual(validateBrowserTabMessage({ type: "pageClick", x: 1 }), null);
    assert.strictEqual(validateBrowserTabMessage({ type: "pageKey", key: "" }), null);
    assert.strictEqual(validateBrowserTabMessage({ type: "pageKey", key: "x".repeat(64) }), null);
    assert.strictEqual(validateBrowserTabMessage({ type: "dropTables" }), null);
  });
});

/* ---------- unit: tab HTML ---------- */
describe("browser tab html", () => {
  const html = renderBrowserTabHtml("NONCE123", {
    url: "https://example.com/",
    title: "Example",
    loading: true,
    canGoBack: true,
    canGoForward: false,
    pickerMode: false,
    viewportWidth: 1280,
    viewportHeight: 800,
    renderMode: "live",
    zoomPercent: 100,
    areaSelectMode: false,
  });
  it("renders the Cursor-style chrome", () => {
    assert.ok(html.includes('id="omnibar"'), "omnibar");
    assert.ok(html.includes('id="backBtn"'), "back");
    assert.ok(html.includes('id="fwdBtn"'), "forward");
    assert.ok(html.includes('id="reloadBtn"'), "reload");
    assert.ok(html.includes('id="shotBtn"'), "screenshot button");
    assert.ok(html.includes('id="pickBtn"'), "picker button");
    assert.ok(html.includes('id="screen"'), "viewport image");
    assert.ok(html.includes('nonce="NONCE123"'), "script nonce");
    assert.ok(html.includes('class="on"'), "loading spinner on");
  });
  it("emits a content security policy binding the script nonce (QA-BROWSERTAB-01 P2)", () => {
    assert.ok(
      html.includes('<meta http-equiv="Content-Security-Policy"'),
      "CSP meta tag present",
    );
    assert.ok(html.includes("default-src 'none'"), "default-src none");
    assert.ok(html.includes("script-src 'nonce-NONCE123'"), "nonce bound to script-src");
    // Screencast frames are assigned as data: URLs — the policy must allow them.
    assert.ok(html.includes("img-src data:"), "img-src data: for screencast frames");
  });
  it("escapes the URL against attribute injection", () => {
    const evil = renderBrowserTabHtml("n", {
      url: '"><script>alert(1)</script>',
      title: "",
      loading: false,
      canGoBack: false,
      canGoForward: false,
      pickerMode: false,
      viewportWidth: 1280,
      viewportHeight: 800,
      renderMode: "live",
      zoomPercent: 100,
      areaSelectMode: false,
    });
    assert.ok(!evil.includes('"><script>alert(1)</script>'), "raw payload must not appear");
    assert.ok(evil.includes("&quot;&gt;&lt;script&gt;"), "escaped payload present");
  });
  it("uses inline SVG icons, never emoji", () => {
    assert.ok(html.includes("<svg"), "svg icons");
    for (const ch of ["📷", "🎯", "📸", "🔍"]) {
      assert.ok(!html.includes(ch), `no emoji ${ch}`);
    }
  });
});

/* ---------- unit: chromium resolution ---------- */
describe("chromium resolution", () => {
  it("prefers an explicit configured path that exists", () => {
    const r = resolveChromiumPath("/opt/chrome", (p) => p === "/opt/chrome");
    assert.strictEqual(r, "/opt/chrome");
  });
  it("falls back to well-known locations when the configured path is missing", () => {
    const r = resolveChromiumPath("/nope", (p) => p === "/usr/bin/chromium");
    assert.strictEqual(r, "/usr/bin/chromium");
  });
  it("returns undefined when nothing exists (honest, no fake browser)", () => {
    assert.strictEqual(resolveChromiumPath("", () => false), undefined);
    assert.strictEqual(resolveChromiumPath(undefined, () => false), undefined);
  });
  it("capture dir lives under the .ide-code data folder", () => {
    assert.strictEqual(browserCaptureDir(), path.join(os.homedir(), ".ide-code", "browser-captures"));
  });
  it("user image attachments dir prefers the workspace, falls back to home", () => {
    assert.strictEqual(userImageAttachmentsDir("/ws/proj"), path.join("/ws/proj", ".ide-code", "attachments"));
    assert.strictEqual(userImageAttachmentsDir(), path.join(os.homedir(), ".ide-code", "attachments"));
  });
  it("saveUserImageDataUrl writes a png data URL to disk and returns its path", () => {
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), "ide-userimg-"));
    try {
      const dataUrl = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
      const filePath = saveUserImageDataUrl(dataUrl, ws);
      assert.ok(filePath.startsWith(path.join(ws, ".ide-code", "attachments") + path.sep));
      assert.ok(filePath.endsWith(".png"));
      assert.ok(fs.existsSync(filePath), "file exists on disk");
      assert.ok(fs.statSync(filePath).size > 0);
    } finally {
      fs.rmSync(ws, { recursive: true, force: true });
    }
  });
  it("saveUserImageDataUrl rejects non-image and oversized payloads", () => {
    assert.throws(() => saveUserImageDataUrl("data:text/plain;base64,aGk=", "/tmp"), /supported image/);
    assert.throws(() => saveUserImageDataUrl("not-a-data-url", "/tmp"), /supported image/);
    const huge = "A".repeat(Math.ceil((15 * 1024 * 1024 * 4) / 3) + 8);
    assert.throws(() => saveUserImageDataUrl(`data:image/png;base64,${huge}`, "/tmp"), /15MB/);
  });
});

/* ---------- unit: BrowserService tab surface ---------- */
describe("browser service tab surface", () => {
  interface FakeState {
    evalScripts: string[];
    cdpCalls: { method: string; params: Record<string, unknown> }[];
    screencastOpts: ScreencastOptions | null;
    eventSubs: string[];
    frameHandler: ((data: string) => void) | null;
  }
  function fakeTabDriver(state: FakeState): ServiceDriver & Partial<PageDriver> {
    return {
      navigate: async () => undefined,
      captureScreenshot: async () => ({
        data: Buffer.from([1, 2, 3]),
        mimeType: "image/png" as const,
        viewportWidth: 1280,
        viewportHeight: 800,
        devicePixelRatio: 1,
      }),
      evaluate: (async <T>(script: string): Promise<T> => {
        state.evalScripts.push(script);
        if (script.includes("window.__idePicker.highlightAt")) {
          return {
            tagName: "BUTTON",
            id: "",
            className: "btn",
            innerText: "Sign in",
            xpath: "/html/body/button[1]",
            rect: { x: 10, y: 20, width: 80, height: 30 },
          } as T;
        }
        if (script.includes("__idePicker")) return { ok: true, already: true } as T;
        if (script.includes("elementFromPoint")) return true as T;
        return true as T;
      }) as ServiceDriver["evaluate"],
      getUrl: async () => "https://example.com/",
      getTitle: async () => "Example",
      rawCdp: (async (method: string, params: Record<string, unknown> = {}) => {
        state.cdpCalls.push({ method, params });
        if (method === "Page.getNavigationHistory") {
          return { currentIndex: 1, entries: [{ id: 11 }, { id: 22 }, { id: 33 }] };
        }
        if (method === "Page.getLayoutMetrics") {
          return { visualViewport: { clientWidth: 1280, clientHeight: 800 } };
        }
        return {};
      }) as ServiceDriver["rawCdp"],
      close: async () => undefined,
      onCdpEvent: (method: string, handler: (p?: Record<string, unknown>) => void) => {
        state.eventSubs.push(method);
        void handler;
        return () => undefined;
      },
      startScreencast: async (
        opts: ScreencastOptions,
        onFrame: (data: string) => void,
      ): Promise<() => Promise<void>> => {
        state.screencastOpts = opts;
        state.frameHandler = onFrame;
        return async () => {
          state.frameHandler = null;
        };
      },
    };
  }

  async function makeService(state: FakeState) {
    const service = new BrowserService(async () => fakeTabDriver(state) as ServiceDriver);
    const s = await service.createSession({ agentId: "user" });
    return { service, sessionId: s.sessionId };
  }

  it("getNavState reports url/title/history/viewport (listTabs wire shape)", async () => {
    const state: FakeState = { evalScripts: [], cdpCalls: [], screencastOpts: null, eventSubs: [], frameHandler: null };
    const { service, sessionId } = await makeService(state);
    const nav = await service.getNavState(sessionId, "user");
    assert.strictEqual(nav.url, "https://example.com/");
    assert.strictEqual(nav.title, "Example");
    assert.strictEqual(nav.canGoBack, true);
    assert.strictEqual(nav.canGoForward, true);
    assert.strictEqual(nav.viewportWidth, 1280);
    assert.strictEqual(nav.viewportHeight, 800);
    await service.closeSession(sessionId, "user");
  });

  it("goBack/goForward drive history entries (not the gated agent path)", async () => {
    const state: FakeState = { evalScripts: [], cdpCalls: [], screencastOpts: null, eventSubs: [], frameHandler: null };
    const { service, sessionId } = await makeService(state);
    await service.goBack(sessionId, "user");
    const back = state.cdpCalls.find((c) => c.method === "Page.navigateToHistoryEntry");
    assert.deepStrictEqual(back?.params, { entryId: 11 });
    await service.goForward(sessionId, "user");
    const fwd = state.cdpCalls.filter((c) => c.method === "Page.navigateToHistoryEntry").pop();
    assert.deepStrictEqual(fwd?.params, { entryId: 33 });
    await service.closeSession(sessionId, "user");
  });

  it("userClick forwards coordinates via synthetic DOM events (no Input.*)", async () => {
    const state: FakeState = { evalScripts: [], cdpCalls: [], screencastOpts: null, eventSubs: [], frameHandler: null };
    const { service, sessionId } = await makeService(state);
    await service.userClick(sessionId, "user", 123, 456);
    const script = state.evalScripts.find((s) => s.includes("elementFromPoint"));
    assert.ok(script, "must evaluate elementFromPoint click");
    assert.ok(script!.includes("123") && script!.includes("456"), "coordinates in script");
    assert.ok(!state.cdpCalls.some((c) => c.method.startsWith("Input.")), "no CDP Input.*");
    await service.closeSession(sessionId, "user");
  });

  it("userScroll and userKey forward into the page", async () => {
    const state: FakeState = { evalScripts: [], cdpCalls: [], screencastOpts: null, eventSubs: [], frameHandler: null };
    const { service, sessionId } = await makeService(state);
    await service.userScroll(sessionId, "user", 0, 240);
    assert.ok(state.evalScripts.some((s) => s.includes("scrollBy") && s.includes("240")));
    await service.userKey(sessionId, "user", "a");
    assert.ok(state.evalScripts.some((s) => s.includes("insertText")));
    await service.userKey(sessionId, "user", "Enter");
    assert.ok(state.evalScripts.some((s) => s.includes("requestSubmit")));
    await service.closeSession(sessionId, "user");
  });

  it("startScreencast streams frames and stops cleanly", async () => {
    const state: FakeState = { evalScripts: [], cdpCalls: [], screencastOpts: null, eventSubs: [], frameHandler: null };
    const { service, sessionId } = await makeService(state);
    const frames: string[] = [];
    const stop = await service.startScreencast(sessionId, "user", { format: "jpeg", quality: 55 }, (d) =>
      frames.push(d),
    );
    assert.strictEqual(state.screencastOpts?.format, "jpeg");
    assert.strictEqual(state.screencastOpts?.quality, 55);
    state.frameHandler!("ZmFrZQ==");
    assert.deepStrictEqual(frames, ["ZmFrZQ=="]);
    await stop();
    assert.strictEqual(state.frameHandler, null);
    await service.closeSession(sessionId, "user");
  });

  it("onPageEvent subscribes to CDP page events (loading indicator)", async () => {
    const state: FakeState = { evalScripts: [], cdpCalls: [], screencastOpts: null, eventSubs: [], frameHandler: null };
    const { service, sessionId } = await makeService(state);
    const unsub = service.onPageEvent(sessionId, "user", "Page.loadEventFired", () => undefined);
    assert.ok(state.eventSubs.includes("Page.loadEventFired"));
    unsub();
    await service.closeSession(sessionId, "user");
  });

  it("userPickAt returns the element payload (orange highlight visible in stream)", async () => {
    const state: FakeState = { evalScripts: [], cdpCalls: [], screencastOpts: null, eventSubs: [], frameHandler: null };
    const { service, sessionId } = await makeService(state);
    const payload = await service.userPickAt(sessionId, "user", 50, 35);
    assert.ok(payload, "payload expected");
    assert.strictEqual(payload!.tagName, "BUTTON");
    assert.strictEqual(payload!.innerText, "Sign in");
    assert.ok(payload!.xpath.length > 0, "xpath for chat context");
    await service.closeSession(sessionId, "user");
  });

  it("userPickAt clears the hover outline after capturing the payload (QA-BROWSERTAB-01 P2)", async () => {
    const state: FakeState = { evalScripts: [], cdpCalls: [], screencastOpts: null, eventSubs: [], frameHandler: null };
    const { service, sessionId } = await makeService(state);
    const payload = await service.userPickAt(sessionId, "user", 50, 35);
    assert.ok(payload, "payload expected");
    // NB: the injected PICKER_SCRIPT itself mentions both names — match the
    // actual call expressions, not the definitions.
    const hi = state.evalScripts.findIndex((s) => s.includes("window.__idePicker.highlightAt("));
    const clear = state.evalScripts.findIndex((s) => s.includes("__idePicker.clearHover()"));
    assert.ok(hi >= 0, "highlightAt evaluated");
    assert.ok(clear > hi, "clearHover evaluated after highlightAt (no lingering outline)");
    await service.closeSession(sessionId, "user");
  });

  it("tab sessions are owned by the user agent id (ownership isolation)", async () => {
    const state: FakeState = { evalScripts: [], cdpCalls: [], screencastOpts: null, eventSubs: [], frameHandler: null };
    const { service, sessionId } = await makeService(state);
    await assert.rejects(
      () => service.getNavState(sessionId, "agent-9"),
      (e: unknown) => (e as { code?: string }).code === "OWNED_BY_ANOTHER_AGENT",
    );
    await service.closeSession(sessionId, "user");
  });
});

/* ---------- QA-BROWSERTAB-01 fixes: screenshot filenames + pickAt validation ---------- */
describe("QA-BROWSERTAB-01 fixes", () => {
  it("screenshot filenames are unique even within the same millisecond (P3)", () => {
    const fixed = new Date("2026-10-19T11:00:00.000Z");
    const names = new Set<string>();
    for (let i = 0; i < 1000; i++) names.add(screenshotFilename(fixed));
    assert.strictEqual(names.size, 1000, "no collisions across 1000 same-ms filenames");
    for (const n of names) {
      assert.match(n, /^browser-2026-10-19T11-00-00-000Z-[0-9a-f]{8}\.png$/);
      assert.ok(!n.includes("/") && !n.includes("\\") && !n.includes(".."), "no path separators");
    }
  });

  it("PickerController.pickAt rejects non-finite coordinates with INVALID_ARGS (P3)", async () => {
    const calls: string[] = [];
    const driver = {
      evaluate: async <T>(s: string): Promise<T> => {
        calls.push(s);
        return null as T;
      },
    };
    const picker = new PickerController(driver as never);
    for (const [x, y] of [
      [NaN, 10],
      [10, NaN],
      [Infinity, 10],
      [10, -Infinity],
    ] as const) {
      await assert.rejects(
        () => picker.pickAt(x, y),
        (e: unknown) => (e as { code?: string }).code === "INVALID_ARGS",
        `pickAt(${x}, ${y}) must throw INVALID_ARGS`,
      );
    }
    assert.strictEqual(calls.length, 0, "no page evaluation on invalid input");
    // Finite coordinates still flow through to the page.
    const okCalls: string[] = [];
    const okDriver = {
      evaluate: async <T>(s: string): Promise<T> => {
        okCalls.push(s);
        return { ok: true } as T;
      },
    };
    const picker2 = new PickerController(okDriver as never);
    await picker2.pickAt(10, 20);
    assert.ok(
      okCalls.some((s) => s.includes("highlightAt(10, 20)")),
      "finite coordinates are interpolated",
    );
  });

  it("PickerController.clearHover evaluates the in-page clear (P2)", async () => {
    const calls: string[] = [];
    const driver = {
      evaluate: async <T>(s: string): Promise<T> => {
        calls.push(s);
        return { ok: true } as T;
      },
    };
    const picker = new PickerController(driver as never);
    await picker.clearHover();
    assert.ok(calls.some((s) => s.includes("clearHover")), "clearHover script evaluated");
  });
});

/* ---------- unit: browser "..." menu (Cursor BrowserMoreMenu parity) ---------- */
describe("browser more menu", () => {
  it("renders the full Cursor menu surface", () => {
    const html = renderBrowserTabHtml("n", {
      url: "https://example.com/",
      title: "Example",
      loading: false,
      canGoBack: false,
      canGoForward: false,
      pickerMode: false,
      viewportWidth: 1280,
      viewportHeight: 800,
      renderMode: "live",
      zoomPercent: 125,
      areaSelectMode: false,
    });
    assert.ok(html.includes('id="moreBtn"'), "ellipsis button");
    assert.ok(html.includes("Take Screenshot"), "menu: Take Screenshot");
    assert.ok(html.includes("Capture Area Screenshot"), "menu: Capture Area Screenshot");
    assert.ok(html.includes("Hard Reload"), "menu: Hard Reload");
    assert.ok(html.includes("Copy Current URL"), "menu: Copy Current URL");
    assert.ok(html.includes("Zoom"), "menu: Zoom row");
    assert.ok(html.includes("125%"), "zoom percent rendered");
    assert.ok(html.includes("Clear Browsing History"), "menu: Clear Browsing History");
    assert.ok(html.includes("Clear Cookies"), "menu: Clear Cookies");
    assert.ok(html.includes("Clear Cache"), "menu: Clear Cache");
    assert.ok(html.includes("Open DevTools"), "menu: Open DevTools");
    assert.ok(html.includes('id="areaOverlay"'), "area-select overlay");
  });
  it("validates the new webview message types", () => {
    for (const t of ["captureArea", "cancelAreaSelect", "hardReload", "copyUrl", "zoomIn", "zoomOut", "zoomReset", "openDevTools"]) {
      assert.ok(validateBrowserTabMessage({ type: t }), t);
    }
    assert.deepStrictEqual(
      validateBrowserTabMessage({ type: "areaSelect", x: 10, y: 20, width: 100, height: 50 }),
      { type: "areaSelect", x: 10, y: 20, width: 100, height: 50 },
    );
    for (const kind of ["history", "cookies", "cache"]) {
      assert.deepStrictEqual(validateBrowserTabMessage({ type: "clearData", kind }), {
        type: "clearData",
        kind,
      });
    }
  });
  it("rejects malformed areaSelect / clearData messages", () => {
    assert.strictEqual(validateBrowserTabMessage({ type: "areaSelect", x: 1, y: 2, width: 0, height: 5 }), null, "zero width");
    assert.strictEqual(validateBrowserTabMessage({ type: "areaSelect", x: 1, y: 2, width: -3, height: 5 }), null, "negative width");
    assert.strictEqual(validateBrowserTabMessage({ type: "areaSelect", x: 1, y: 2, width: 99999, height: 5 }), null, "oversize width");
    assert.strictEqual(validateBrowserTabMessage({ type: "areaSelect", x: 1, y: 2 }), null, "missing fields");
    assert.strictEqual(validateBrowserTabMessage({ type: "clearData", kind: "passwords" }), null, "unknown kind");
    assert.strictEqual(validateBrowserTabMessage({ type: "clearData" }), null, "missing kind");
  });
});

/* ---------- unit: zoom ladder (Cursor: 25–500) ---------- */
describe("browser zoom ladder", () => {
  it("steps in/out along the Chromium ladder", () => {
    assert.strictEqual(zoomStepIn(100), 110);
    assert.strictEqual(zoomStepOut(100), 90);
    assert.strictEqual(zoomStepIn(400), 500);
    assert.strictEqual(zoomStepOut(33), 25);
  });
  it("clamps at the Cursor bounds", () => {
    assert.strictEqual(zoomStepIn(500), ZOOM_MAX);
    assert.strictEqual(zoomStepOut(25), ZOOM_MIN);
    assert.strictEqual(zoomStepIn(999), ZOOM_MAX);
    assert.strictEqual(zoomStepOut(1), ZOOM_MIN);
  });
  it("clampZoom sanitizes arbitrary input", () => {
    assert.strictEqual(clampZoom(150), 150);
    assert.strictEqual(clampZoom(10), ZOOM_MIN);
    assert.strictEqual(clampZoom(900), ZOOM_MAX);
    assert.strictEqual(clampZoom(NaN), 100);
    assert.strictEqual(clampZoom(124.6), 125);
  });
});
