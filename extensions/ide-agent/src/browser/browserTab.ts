/**
 * BrowserTabManager — the user-visible in-IDE browser tab.
 *
 * Cursor parity (dissect-browser-tab.md): Cursor renders its browser tab as a
 * native WebContentsView under a React chrome (omnibar, tab strip, pills).
 * An extension cannot overlay native views, so this is the faithful
 * extension-level implementation:
 *
 *   - a WebviewPanel in the editor area hosts the chrome (omnibar with
 *     back/forward/reload/URL/loading, screenshot and element-picker
 *     buttons) — Cursor's look, theme-aware via VS Code CSS variables;
 *   - the page itself is the SAME BrowserService session the agent drives
 *     (headless Chromium over CDP), rendered via Page.startScreencast frames;
 *   - screenshot → saved PNG → attached to the chat composer as an image
 *     chip, then sent to the engine as a real file attachment
 *     (PromptInput.files — the engine sees the image);
 *   - element picker → orange #ff6a00 highlight in the page (visible in the
 *     stream) → element payload posted to chat as context.
 *
 * Wire contracts honored (deepdig-ast-2026-10-19.md): takeScreenshot args
 * {element, fullPage, ref, viewId}; listTabs shape
 * {activeViewId, allViewIds, headlessViewIds, lastInteractedViewId}; tab
 * locks keyed by ownerAgentId. The tab session is owned by agent id "user"
 * so agent sessions stay isolated (Cursor's resourceOwnershipService model).
 */
import * as vscode from "vscode";
import * as fs from "node:fs";
import * as http from "node:http";
import * as path from "node:path";
import { BrowserService, createCdpDriverFactory } from "./service";
import { launchHeadlessChromium } from "./driver";
import { browserCaptureDir, resolveChromiumPath, screenshotFilename } from "./chromium";
import { BrowserError, ElementPayload } from "./types";
import {
  renderBrowserTabHtml,
  validateBrowserTabMessage,
  normalizeOmnibarUrl,
  zoomStepIn,
  zoomStepOut,
  clampZoom,
  ClearDataKind,
  BrowserTabState,
} from "./tabView";

/** Agent id that owns user-visible tab sessions. */
export const BROWSER_TAB_AGENT_ID = "user";

export interface BrowserTabCallbacks {
  /** Attach a captured image to the chat composer (file saved on disk). */
  postImageToChat(filePath: string, label: string, dataUrl: string): void;
  /** Attach a picked element payload to the chat composer. */
  postElementToChat(label: string, content: string): void;
  output: vscode.OutputChannel;
}

/**
 * Chromium path helpers live in ./chromium (vscode-free, unit-tested);
 * re-exported here for consumers that import from ./browserTab.
 */
export { resolveChromiumPath, browserCaptureDir } from "./chromium";

interface TabRecord {
  panel: vscode.WebviewPanel;
  sessionId: string;
  stopScreencast: (() => Promise<void>) | null;
  unsubs: Array<() => void>;
  pickerMode: boolean;
  renderMode: "live" | "snapshot";
  loading: boolean;
  disposed: boolean;
  /** Page zoom percent, 25–500 (Cursor: BrowserMoreMenu zoom row). */
  zoomPercent: number;
  /** Area-select mode for "Capture Area Screenshot". */
  areaSelectMode: boolean;
  /**
   * Open DevTools side panels for this tab (P3-7 singleton + P3-9: disposed
   * together with the tab so no orphan panel points at a dead target).
   */
  devToolsPanels: vscode.WebviewPanel[];
}

export class BrowserTabManager {
  private service: BrowserService | null = null;
  private chromium: { port: number; stop: () => void } | null = null;
  private starting: Promise<void> | null = null;
  private tab: TabRecord | null = null;
  /** REVERIFY-P3-6: DevTools open in flight (double-click guard). */
  private devToolsOpening = false;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly callbacks: BrowserTabCallbacks,
    private readonly getChromiumPathSetting: () => string | undefined,
  ) {}

  /** Lazily launch the tab Chromium and build the BrowserService. */
  private ensureService(): Promise<BrowserService> {
    if (this.service) return Promise.resolve(this.service);
    if (this.starting) return this.starting.then(() => this.service!);
    this.starting = (async () => {
      const exe = resolveChromiumPath(this.getChromiumPathSetting());
      if (!exe) {
        throw new BrowserError(
          "NO_CHROMIUM",
          "No Chromium found for the browser tab. Set \"ide.browser.chromiumPath\" " +
            "to a Chrome / Chromium executable (or chrome-headless-shell).",
        );
      }
      this.callbacks.output.appendLine(`[browser-tab] launching Chromium: ${exe}`);
      this.chromium = await launchHeadlessChromium(exe, {
        viewport: { width: 1280, height: 800 },
      });
      const factory = createCdpDriverFactory("127.0.0.1", this.chromium.port);
      this.service = new BrowserService(factory);
    })();
    // P2: reset the start gate on failure so a later open retries instead of
    // hanging on a rejected promise forever.
    this.starting.catch(() => {
      this.starting = null;
    });
    return this.starting.then(() => this.service!);
  }

  /** Open the browser tab (Cursor: workbench.action.openBrowserEditor). */
  async open(url?: string): Promise<void> {
    if (this.tab && !this.tab.disposed) {
      this.tab.panel.reveal(vscode.ViewColumn.Active);
      if (url) await this.navigateTo(url);
      return;
    }
    let service: BrowserService;
    try {
      service = await this.ensureService();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      void vscode.window.showErrorMessage(`IDE Agent browser tab: ${msg}`);
      return;
    }
    const session = await service.createSession({ agentId: BROWSER_TAB_AGENT_ID });
    const panel = vscode.window.createWebviewPanel(
      "ideAgent.browserTab",
      "Browser",
      vscode.ViewColumn.Active,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
      },
    );
    const nonce = randomNonce();
    panel.webview.html = renderBrowserTabHtml(nonce, {
      url: "",
      title: "Browser",
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
    const rec: TabRecord = {
      panel,
      sessionId: session.sessionId,
      stopScreencast: null,
      unsubs: [],
      pickerMode: false,
      renderMode: "live",
      loading: false,
      disposed: false,
      zoomPercent: 100,
      areaSelectMode: false,
      devToolsPanels: [],
    };
    this.tab = rec;

    // X2-P3-1: these listeners are per-tab — they belong in rec.unsubs
    // (cleaned by disposeTab), NOT in context.subscriptions (which would
    // retain a dead closure per open→close→open cycle until deactivate).
    const msgSub = panel.webview.onDidReceiveMessage((raw) => {
      const msg = validateBrowserTabMessage(raw);
      if (!msg) return;
      void this.handleWebviewMessage(rec, msg).catch((e) => {
        this.toast(rec, e instanceof Error ? e.message : String(e));
      });
    });
    rec.unsubs.push(() => msgSub.dispose());
    const viewStateSub = panel.onDidChangeViewState((e) => {
      if (rec.disposed) return;
      if (e.webviewPanel.visible) void this.startStreaming(rec);
      else void this.stopStreaming(rec);
    });
    rec.unsubs.push(() => viewStateSub.dispose());
    const disposeSub = panel.onDidDispose(() => {
      void this.disposeTab(rec);
    });
    rec.unsubs.push(() => disposeSub.dispose());

    // Loading indicator + URL sync from page events (read-only).
    this.setupPageEventHandlers(rec, service);

    await this.startStreaming(rec);
    if (url) await this.navigateTo(url);
    else await this.pushNavState(rec);
  }

  /**
   * REVERIFY-P3-7: page-event wiring extracted for testability. The
   * Page.loadEventFired → reapplyZoom link is the core of the P2-1 zoom fix;
   * it must have a test that fails if the listener is removed.
   */
  private setupPageEventHandlers(rec: TabRecord, service: BrowserService): void {
    try {
      rec.unsubs.push(
        service.onPageEvent(rec.sessionId, BROWSER_TAB_AGENT_ID, "Page.frameStartedLoading", () => {
          rec.loading = true;
          void this.pushNavState(rec);
        }),
        service.onPageEvent(rec.sessionId, BROWSER_TAB_AGENT_ID, "Page.loadEventFired", () => {
          rec.loading = false;
          void this.pushNavState(rec);
          // P2-1: every new document loses document.body.style.zoom.
          // Re-apply here (after the load event, NOT on the Page.reload ACK —
          // the ACK does not wait for the new document) so hardReload, plain
          // reload, agent-driven navigate and in-page navigations all keep
          // the user's zoom.
          void this.reapplyZoom(rec);
        }),
      );
    } catch {
      /* driver without event support — loading indicator just stays off */
    }
  }

  /** Close the tab if open. */
  async close(): Promise<void> {
    if (this.tab) this.tab.panel.dispose();
  }

  /** Dispose the manager (extension deactivation): tab + Chromium. */
  async dispose(): Promise<void> {
    if (this.tab) await this.disposeTab(this.tab);
    if (this.chromium) {
      try {
        this.chromium.stop();
      } catch {
        /* ignore */
      }
      this.chromium = null;
    }
    this.service = null;
  }

  // -- streaming -----------------------------------------------------

  private async startStreaming(rec: TabRecord): Promise<void> {
    if (rec.disposed || rec.stopScreencast) return;
    const service = this.service;
    if (!service) return;
    try {
      rec.stopScreencast = await service.startScreencast(
        rec.sessionId,
        BROWSER_TAB_AGENT_ID,
        { format: "jpeg", quality: 55, maxWidth: 1280, maxHeight: 800, everyNthFrame: 2 },
        (dataBase64) => {
          if (rec.disposed) return;
          rec.panel.webview.postMessage({
            type: "frame",
            dataUrl: `data:image/jpeg;base64,${dataBase64}`,
          });
        },
      );
      rec.renderMode = "live";
    } catch {
      // Screencast unsupported (e.g. older headless shell) — fall back to
      // periodic viewport captures. Still a real page view, no placeholder.
      rec.renderMode = "snapshot";
      rec.panel.webview.postMessage({ type: "navState", renderMode: "snapshot" });
      this.toast(rec, "Live preview unavailable — showing snapshots (use Reload to refresh)");
      await this.pushSnapshot(rec);
    }
  }

  private async stopStreaming(rec: TabRecord): Promise<void> {
    if (rec.stopScreencast) {
      try {
        await rec.stopScreencast();
      } catch {
        /* ignore */
      }
      rec.stopScreencast = null;
    }
  }

  private async pushSnapshot(rec: TabRecord): Promise<void> {
    const service = this.service;
    if (!service || rec.disposed) return;
    try {
      const res = await service.screenshot(rec.sessionId, BROWSER_TAB_AGENT_ID, {
        format: "jpeg",
        type: "viewport",
      });
      const img = res.content.find((c) => c.type === "image");
      if (img && img.type === "image" && !rec.disposed) {
        rec.panel.webview.postMessage({
          type: "frame",
          dataUrl: `data:${img.mimeType};base64,${img.base64Data}`,
        });
      }
    } catch {
      /* leave the last frame up */
    }
  }

  // -- navigation ----------------------------------------------------

  private async navigateTo(rawUrl: string): Promise<void> {
    const rec = this.tab;
    const service = this.service;
    if (!rec || !service || rec.disposed) return;
    const url = normalizeOmnibarUrl(rawUrl);
    if (!url) {
      this.toast(rec, "Enter a valid http(s) URL");
      return;
    }
    rec.loading = true;
    await this.pushNavState(rec);
    try {
      await service.navigate(rec.sessionId, BROWSER_TAB_AGENT_ID, url);
    } catch (err) {
      this.toast(rec, err instanceof Error ? err.message : String(err));
    } finally {
      rec.loading = false;
      // Re-apply page zoom via the shared helper (idempotent; the
      // Page.loadEventFired listener also calls it — belt and suspenders
      // for drivers whose load event is unreliable).
      await this.reapplyZoom(rec);
      await this.pushNavState(rec);
      if (rec.renderMode === "snapshot") await this.pushSnapshot(rec);
    }
  }

  /**
   * Re-apply the tab's zoom after a document change (P2-1).
   *
   * A new document loses `document.body.style.zoom`; without this,
   * `rec.zoomPercent` goes stale (menu shows 200% while the page renders
   * 100%). Silent on failure (pages without a <body>, e.g. PDFs) — unlike
   * setZoom, this is a restore, not a user request, so no toast.
   */
  private async reapplyZoom(rec: TabRecord): Promise<void> {
    const service = this.service;
    if (!service || rec.disposed || rec.zoomPercent === 100) return;
    await service
      .evaluateInPage(
        rec.sessionId,
        BROWSER_TAB_AGENT_ID,
        `(function(){var b=document.body;if(!b)return false;b.style.zoom='${rec.zoomPercent}%';return true;})()`,
      )
      .catch(() => false);
  }

  private async pushNavState(rec: TabRecord): Promise<void> {
    const service = this.service;
    if (!service || rec.disposed) return;
    try {
      const st = await service.getNavState(rec.sessionId, BROWSER_TAB_AGENT_ID);
      if (!rec.disposed) {
        if (st.title) rec.panel.title = st.title;
        rec.panel.webview.postMessage({
          type: "navState",
          url: st.url,
          title: st.title,
          canGoBack: st.canGoBack,
          canGoForward: st.canGoForward,
          loading: rec.loading,
          pickerMode: rec.pickerMode,
          viewportWidth: st.viewportWidth,
          viewportHeight: st.viewportHeight,
          renderMode: rec.renderMode,
          zoomPercent: rec.zoomPercent,
          areaSelectMode: rec.areaSelectMode,
          // P3-3: Cursor disables Take Screenshot / Capture Area Screenshot /
          // Hard Reload / Copy Current URL when no URL is loaded. A blank tab
          // reports "about:blank" (truthy) — that counts as no URL.
          hasUrl: isRealUrl(st.url),
        });
      }
    } catch {
      /* session may be closing */
    }
  }

  // -- webview messages ----------------------------------------------

  private async handleWebviewMessage(
    rec: TabRecord,
    msg: ReturnType<typeof validateBrowserTabMessage> & {},
  ): Promise<void> {
    const service = this.service;
    if (!service || rec.disposed) return;
    const sid = rec.sessionId;
    switch (msg.type) {
      case "navigate":
        await this.navigateTo(msg.url);
        break;
      case "back":
        await service.goBack(sid, BROWSER_TAB_AGENT_ID).catch((e) => this.toast(rec, String(e)));
        await this.pushNavState(rec);
        if (rec.renderMode === "snapshot") await this.pushSnapshot(rec);
        break;
      case "forward":
        await service.goForward(sid, BROWSER_TAB_AGENT_ID).catch((e) => this.toast(rec, String(e)));
        await this.pushNavState(rec);
        if (rec.renderMode === "snapshot") await this.pushSnapshot(rec);
        break;
      case "reload":
        await service.navigate(sid, BROWSER_TAB_AGENT_ID, (await service.getNavState(sid, BROWSER_TAB_AGENT_ID)).url).catch((e) => this.toast(rec, String(e)));
        await this.pushNavState(rec);
        if (rec.renderMode === "snapshot") await this.pushSnapshot(rec);
        break;
      case "pageClick":
        if (rec.pickerMode) {
          await this.pickElementAt(rec, msg.x, msg.y);
        } else {
          await service.userClick(sid, BROWSER_TAB_AGENT_ID, msg.x, msg.y);
          if (rec.renderMode === "snapshot") await this.pushSnapshot(rec);
        }
        break;
      case "pageWheel":
        await service.userScroll(sid, BROWSER_TAB_AGENT_ID, msg.deltaX, msg.deltaY);
        break;
      case "pageKey":
        await service.userKey(sid, BROWSER_TAB_AGENT_ID, msg.key);
        break;
      case "screenshot":
        await this.screenshotToChat(rec);
        break;
      case "captureArea":
        rec.areaSelectMode = true;
        rec.pickerMode = false;
        await this.pushNavState(rec);
        break;
      case "areaSelect":
        rec.areaSelectMode = false;
        await this.pushNavState(rec);
        await this.captureAreaToChat(rec, msg.x, msg.y, msg.width, msg.height);
        break;
      case "cancelAreaSelect":
        rec.areaSelectMode = false;
        await this.pushNavState(rec);
        break;
      case "hardReload":
        await this.hardReload(rec);
        break;
      case "copyUrl":
        await this.copyCurrentUrl(rec);
        break;
      case "zoomIn":
        await this.setZoom(rec, zoomStepIn(rec.zoomPercent));
        break;
      case "zoomOut":
        await this.setZoom(rec, zoomStepOut(rec.zoomPercent));
        break;
      case "zoomReset":
        await this.setZoom(rec, 100);
        break;
      case "clearData":
        await this.clearBrowsingData(rec, msg.kind);
        break;
      case "openDevTools":
        await this.openDevTools(rec);
        break;
      case "togglePicker":
        rec.pickerMode = !rec.pickerMode;
        await this.pushNavState(rec);
        this.toast(rec, rec.pickerMode ? "Picker on — click an element to send it to chat" : "Picker off");
        break;
      case "refreshSnapshot":
        await this.pushSnapshot(rec);
        break;
    }
  }

  // -- screenshot → chat (the priority flow) --------------------------

  private async screenshotToChat(rec: TabRecord): Promise<void> {
    const service = this.service;
    if (!service || rec.disposed) return;
    this.toast(rec, "Capturing screenshot…");
    const res = await service.screenshot(rec.sessionId, BROWSER_TAB_AGENT_ID, {
      format: "png",
      type: "viewport",
    });
    const img = res.content.find((c) => c.type === "image");
    if (!img || img.type !== "image") throw new Error("screenshot returned no image");
    // X2-P3-3: the tab may have been disposed while the screenshot was in
    // flight — never write an orphan file in that case.
    if (rec.disposed) return;
    const bytes = Buffer.from(img.base64Data, "base64");
    const dir = browserCaptureDir();
    fs.mkdirSync(dir, { recursive: true });
    const filePath = path.join(dir, screenshotFilename());
    fs.writeFileSync(filePath, bytes);
    const st = await service.getNavState(rec.sessionId, BROWSER_TAB_AGENT_ID).catch(() => null);
    // X2-P3-3: disposed between write and chat-post → delete the orphan file.
    if (rec.disposed) {
      try {
        fs.unlinkSync(filePath);
      } catch {
        /* best-effort */
      }
      return;
    }
    const label = `Browser screenshot — ${st?.title || st?.url || "page"}`;
    this.callbacks.output.appendLine(`[browser-tab] screenshot → chat: ${filePath}`);
    this.callbacks.postImageToChat(filePath, label, `data:${img.mimeType};base64,${img.base64Data}`);
    this.toast(rec, "Screenshot attached to chat");
  }

  // -- element picker → chat -------------------------------------------

  private async pickElementAt(rec: TabRecord, x: number, y: number): Promise<void> {
    const service = this.service;
    if (!service || rec.disposed) return;
    const payload: ElementPayload | null = await service.userPickAt(
      rec.sessionId,
      BROWSER_TAB_AGENT_ID,
      x,
      y,
    );
    if (!payload) {
      this.toast(rec, "No element at that point");
      return;
    }
    // userPickAt highlights the element (visible in the page stream) and then
    // clears the orange outline so it does not linger on the real page.
    // Post the payload to chat.
    const label = `Element: <${payload.tagName.toLowerCase()}>${payload.innerText ? ` "${payload.innerText.slice(0, 60)}"` : ""}`;
    const content = [
      `tag: ${payload.tagName.toLowerCase()}`,
      payload.id ? `id: ${payload.id}` : null,
      payload.className ? `class: ${payload.className}` : null,
      payload.innerText ? `text: ${payload.innerText.slice(0, 200)}` : null,
      `xpath: ${payload.xpath}`,
      payload.rect
        ? `rect: x=${Math.round(payload.rect.x)} y=${Math.round(payload.rect.y)} w=${Math.round(payload.rect.width)} h=${Math.round(payload.rect.height)}`
        : null,
      payload.component ? `component: ${payload.component}` : null,
    ]
      .filter(Boolean)
      .join("\n");
    this.callbacks.postElementToChat(label, content);
    this.toast(rec, `Picked ${payload.tagName.toLowerCase()} — sent to chat`);
  }

  // -- misc ------------------------------------------------------------

  /** Focus the omnibar (Cursor: workbench.action.focusBrowserLocationBar). */
  focusOmnibar(): void {
    if (this.tab && !this.tab.disposed) {
      this.tab.panel.reveal(vscode.ViewColumn.Active);
      this.tab.panel.webview.postMessage({ type: "focusOmnibar" });
    }
  }

  /** Reload the current page (Cursor: workbench.action.reloadBrowserTab). */
  async reload(): Promise<void> {
    const rec = this.tab;
    if (rec && !rec.disposed) {
      await this.handleWebviewMessage(rec, { type: "reload" } as never);
    }
  }

  /** Open a fresh tab (Cursor: workbench.action.newBrowserTab). */
  async newTab(): Promise<void> {
    await this.close();
    await this.open();
  }

  /** Capture the current page and attach it to chat (palette command). */
  async captureToChat(): Promise<void> {
    const rec = this.tab;
    if (!rec || rec.disposed) {
      void vscode.window.showWarningMessage("IDE Agent: open a browser tab first (IDE Agent: Open Browser Tab).");
      return;
    }
    await this.screenshotToChat(rec);
  }

  /** Toggle the element picker (palette command). */
  togglePicker(): void {
    const rec = this.tab;
    if (!rec || rec.disposed) {
      void vscode.window.showWarningMessage("IDE Agent: open a browser tab first (IDE Agent: Open Browser Tab).");
      return;
    }
    rec.pickerMode = !rec.pickerMode;
    void this.pushNavState(rec);
    this.toast(rec, rec.pickerMode ? "Picker on — click an element to send it to chat" : "Picker off");
  }

  // -- browser "..." menu (Cursor: BrowserMoreMenu) --------------------

  /** "Capture Area Screenshot" — capture a user-dragged region to chat. */
  async captureAreaToChat(rec: TabRecord, x: number, y: number, w: number, h: number): Promise<void> {
    const service = this.service;
    if (!service || rec.disposed) return;
    this.toast(rec, "Capturing area…");
    // Defense-in-depth: the webview clamps already, but a hostile/forged
    // message could still carry out-of-range values — clamp the clip rect.
    const cx = Math.max(0, Math.round(x));
    const cy = Math.max(0, Math.round(y));
    const cw = Math.max(1, Math.round(w));
    const ch = Math.max(1, Math.round(h));
    const res = await service.screenshot(rec.sessionId, BROWSER_TAB_AGENT_ID, {
      format: "png",
      type: "viewport",
      clip: { x: cx, y: cy, width: cw, height: ch },
    });
    const img = res.content.find((c) => c.type === "image");
    if (!img || img.type !== "image") throw new Error("screenshot returned no image");
    // X2-P3-3: the tab may have been disposed while the screenshot was in
    // flight — never write an orphan file in that case.
    if (rec.disposed) return;
    const bytes = Buffer.from(img.base64Data, "base64");
    const dir = browserCaptureDir();
    fs.mkdirSync(dir, { recursive: true });
    const filePath = path.join(dir, screenshotFilename());
    fs.writeFileSync(filePath, bytes);
    const st = await service.getNavState(rec.sessionId, BROWSER_TAB_AGENT_ID).catch(() => null);
    // X2-P3-3: disposed between write and chat-post → delete the orphan file.
    if (rec.disposed) {
      try {
        fs.unlinkSync(filePath);
      } catch {
        /* best-effort */
      }
      return;
    }
    const label = `Browser area screenshot — ${st?.title || st?.url || "page"}`;
    this.callbacks.output.appendLine(`[browser-tab] area screenshot → chat: ${filePath}`);
    this.callbacks.postImageToChat(filePath, label, `data:${img.mimeType};base64,${img.base64Data}`);
    this.toast(rec, "Area screenshot attached to chat");
  }

  /** "Hard Reload" (Cursor: browserView.reloadIgnoringCache). */
  async hardReload(rec?: TabRecord): Promise<void> {
    const r = rec ?? this.tab;
    const service = this.service;
    if (!r || r.disposed || !service) return;
    r.loading = true;
    await this.pushNavState(r);
    try {
      await service.cdp(r.sessionId, BROWSER_TAB_AGENT_ID, "Page.reload", { ignoreCache: true });
    } catch (e) {
      this.toast(r, e instanceof Error ? e.message : String(e));
    } finally {
      r.loading = false;
      await this.pushNavState(r);
      if (r.renderMode === "snapshot") await this.pushSnapshot(r);
    }
  }

  /** "Copy Current URL" (Cursor: clipboardService.writeText(currentUrl)). */
  async copyCurrentUrl(rec?: TabRecord): Promise<void> {
    const r = rec ?? this.tab;
    const service = this.service;
    if (!r || r.disposed || !service) return;
    try {
      const st = await service.getNavState(r.sessionId, BROWSER_TAB_AGENT_ID);
      // P3-3: "about:blank" is not a copyable URL (Cursor disables the item).
      if (!isRealUrl(st.url)) {
        this.toast(r, "No URL to copy");
        return;
      }
      await vscode.env.clipboard.writeText(st.url);
      this.toast(r, "URL copied to clipboard");
    } catch (e) {
      this.toast(r, e instanceof Error ? e.message : String(e));
    }
  }

  /**
   * Page zoom (Cursor: BrowserMoreMenu zoom row, 25–500).
   *
   * HONEST ARCHITECTURE NOTE: Cursor calls Electron
   * `webContents.setZoomLevel()` on its native WebContentsView. An extension
   * cannot reach webContents, so this applies the same layout zoom via CDP
   * `Runtime.evaluate`: `document.body.style.zoom`. It re-lays out the page
   * (not image scaling), and the page's CSS-px coordinate space is unchanged
   * so click/pick mapping keeps working. On pages without a <body>
   * (about:blank) it is a no-op with a toast.
   */
  async setZoom(rec: TabRecord, percent: number): Promise<void> {
    const service = this.service;
    if (!service || rec.disposed) return;
    const z = clampZoom(percent);
    try {
      const ok = await service.evaluateInPage(
        rec.sessionId,
        BROWSER_TAB_AGENT_ID,
        `(function(){var b=document.body;if(!b)return false;b.style.zoom='${z}%';return true;})()`,
      );
      if (!ok) {
        this.toast(rec, "Zoom not available on this page");
        return;
      }
    } catch (e) {
      this.toast(rec, e instanceof Error ? e.message : String(e));
      return;
    }
    rec.zoomPercent = z;
    await this.pushNavState(rec);
    if (rec.renderMode === "snapshot") await this.pushSnapshot(rec);
  }

  /**
   * "Clear Browsing History / Cookies / Cache" (Cursor: same labels, confirm
   * dialog, toasts). CDP equivalents:
   * - history → Page.resetNavigationHistory (clears back/forward entries)
   * - cookies → Network.clearBrowserCookies (the tab's Chromium profile)
   * - cache → Network.clearBrowserCache
   * "Clear Accepted Certificates" is dev-build-only in Cursor — skipped.
   */
  async clearBrowsingData(rec: TabRecord, kind: ClearDataKind): Promise<void> {
    const service = this.service;
    if (!service || rec.disposed) return;
    const CONFIRM: Record<ClearDataKind, { title: string; detail: string; toast: string }> = {
      history: {
        title: "Clear Browsing History",
        // P3-1: honest scope — CDP Page.resetNavigationHistory only trims this
        // tab's back/forward entries (Cursor's verbatim copy promises "all
        // browsing history entries", which we cannot clear: there is no
        // History DB in this Chromium profile). Keep Cursor's label, fix the
        // detail to match what actually happens.
        detail: "This will clear this tab's back and forward navigation entries.",
        toast: "Browsing history cleared",
      },
      cookies: {
        title: "Clear Cookies",
        detail: "This will remove all cookies. You may be signed out of websites.",
        toast: "Cookies cleared",
      },
      cache: {
        title: "Clear Cache",
        detail: "This will clear the browser cache.",
        toast: "Cache cleared",
      },
    };
    const c = CONFIRM[kind];
    const answer = await vscode.window.showWarningMessage(c.title, { detail: c.detail, modal: true }, "Clear");
    if (answer !== "Clear") return;
    try {
      // REVERIFY-P1-1: the tab chrome's own clear menu uses the sanctioned
      // internal path — the agent-facing service.cdp() denylist correctly
      // denies these methods (fail-closed for the agent), so going through
      // it made Clear Cookies/Cache dead at runtime.
      if (kind === "history") {
        await service.clearBrowsingDataInternal(rec.sessionId, BROWSER_TAB_AGENT_ID, "Page.resetNavigationHistory");
      } else if (kind === "cookies") {
        await service.clearBrowsingDataInternal(rec.sessionId, BROWSER_TAB_AGENT_ID, "Network.clearBrowserCookies");
      } else {
        await service.clearBrowsingDataInternal(rec.sessionId, BROWSER_TAB_AGENT_ID, "Network.clearBrowserCache");
      }
      this.toast(rec, c.toast);
      await this.pushNavState(rec);
    } catch (e) {
      this.toast(rec, e instanceof Error ? e.message : String(e));
    }
  }

  /**
   * "Open DevTools".
   *
   * HONEST LIMITATION: Cursor docks DevTools natively into its
   * WebContentsView (`webContents.openDevTools()`). An extension cannot do
   * that, so this opens the REAL Chrome DevTools frontend
   * (http://127.0.0.1:<debug-port>/devtools/inspector.html?ws=…) for the
   * tab's target in a side WebviewPanel — same inspector (Elements, Console,
   * Network…), separate panel instead of docked. Our driver always launches
   * Chromium with --remote-debugging-port, so the frontend is reachable.
   */
  async openDevTools(rec?: TabRecord): Promise<void> {
    const r = rec ?? this.tab;
    const service = this.service;
    if (!r || r.disposed || !service) {
      void vscode.window.showWarningMessage("IDE Agent: open a browser tab first (IDE Agent: Open Browser Tab).");
      return;
    }
    // P3-7: singleton — reveal the existing panel instead of opening N panels.
    // (onDidDispose below removes dead entries, so the array holds live ones.)
    const live = r.devToolsPanels[0];
    if (live) {
      live.reveal(vscode.ViewColumn.Beside);
      return;
    }
    // REVERIFY-P3-6 (BM-X1): in-flight guard — rapid double-invoke would
    // pass the singleton check twice before either await completes,
    // opening 2 panels. Bail if already opening.
    if (this.devToolsOpening) {
      return;
    }
    this.devToolsOpening = true;
    try {
      const dbg = await service.getDebugInfo(r.sessionId, BROWSER_TAB_AGENT_ID);
      // P3-8 (X1): re-check disposed after the awaits — the user may have
      // closed the browser tab during the (up to 5s) target lookup. Without
      // this, a DevTools panel opens pointing at a dead target.
      if (r.disposed) return;
      const wsUrl = await this.resolveTargetWs(dbg.host, dbg.port, dbg.targetId);
      if (r.disposed) return;
      const wsParam = wsUrl.replace(/^wss?:\/\//, "");
      const devtoolsUrl = `http://${dbg.host}:${dbg.port}/devtools/inspector.html?ws=${encodeURIComponent(wsParam)}`;
      const panel = vscode.window.createWebviewPanel(
        "ideAgent.browserDevTools",
        `DevTools — ${r.panel.title}`,
        vscode.ViewColumn.Beside,
        { enableScripts: true, retainContextWhenHidden: true },
      );
      const hostPort = `${dbg.host}:${dbg.port}`;
      panel.webview.html = `<!DOCTYPE html>
<html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; frame-src http://${this.escHost(hostPort)}; style-src 'unsafe-inline';">
<style>html,body{margin:0;height:100%;background:#1e1e1e}iframe{border:0;width:100%;height:100%}</style>
</head><body><iframe src="${devtoolsUrl.replace(/"/g, "&quot;")}" title="Chrome DevTools"></iframe></body></html>`;
      // P3-9 (X1) + X2-P3-2: track per-tab and dispose with the tab — never
      // push into context.subscriptions (that leaks one entry per click).
      r.devToolsPanels.push(panel);
      panel.onDidDispose(() => {
        r.devToolsPanels = r.devToolsPanels.filter((p) => p !== panel);
      });
    } catch (e) {
      this.toast(r, `DevTools unavailable: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      this.devToolsOpening = false;
    }
  }

  /** Query /json/list on the debug port for the target's webSocketDebuggerUrl. */
  private resolveTargetWs(host: string, port: number, targetId: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const req = http.request(
        { host, port, path: "/json/list", method: "GET" },
        (res) => {
          let body = "";
          res.on("data", (c) => {
            body += String(c);
          });
          res.on("end", () => {
            try {
              const targets = JSON.parse(body) as Array<{ id: string; webSocketDebuggerUrl?: string }>;
              const t = targets.find((x) => x.id === targetId);
              if (t?.webSocketDebuggerUrl) resolve(t.webSocketDebuggerUrl);
              else reject(new Error("DevTools target not found"));
            } catch (e) {
              reject(e);
            }
          });
        },
      );
      req.on("error", reject);
      req.setTimeout(5000, () => req.destroy(new Error("DevTools target lookup timeout")));
      req.end();
    });
  }

  /** Host:port with only safe characters (used inside CSP). */
  private escHost(hostPort: string): string {
    return /^[A-Za-z0-9.\-:]+$/.test(hostPort) ? hostPort : "127.0.0.1";
  }

  /** "Capture Area Screenshot" via palette: enter area-select mode. */
  async startAreaSelect(): Promise<void> {
    const rec = this.tab;
    const service = this.service;
    if (!rec || rec.disposed || !service) {
      void vscode.window.showWarningMessage("IDE Agent: open a browser tab first (IDE Agent: Open Browser Tab).");
      return;
    }
    // P3-3: like Cursor, don't enter area-select on a blank tab.
    try {
      const st = await service.getNavState(rec.sessionId, BROWSER_TAB_AGENT_ID);
      if (rec.disposed) return;
      if (!isRealUrl(st.url)) {
        this.toast(rec, "Load a page first");
        return;
      }
    } catch (e) {
      this.toast(rec, e instanceof Error ? e.message : String(e));
      return;
    }
    rec.areaSelectMode = true;
    rec.pickerMode = false;
    await this.pushNavState(rec);
  }

  /** Zoom via palette command. */
  async zoomStep(dir: "in" | "out" | "reset"): Promise<void> {
    const rec = this.tab;
    if (!rec || rec.disposed) {
      void vscode.window.showWarningMessage("IDE Agent: open a browser tab first (IDE Agent: Open Browser Tab).");
      return;
    }
    if (dir === "in") await this.setZoom(rec, zoomStepIn(rec.zoomPercent));
    else if (dir === "out") await this.setZoom(rec, zoomStepOut(rec.zoomPercent));
    else await this.setZoom(rec, 100);
  }

  /** "Clear Browsing Data" via palette: pick history / cookies / cache first. */
  async clearBrowsingDataMenu(): Promise<void> {
    const rec = this.tab;
    if (!rec || rec.disposed) {
      void vscode.window.showWarningMessage("IDE Agent: open a browser tab first (IDE Agent: Open Browser Tab).");
      return;
    }
    const picked = await vscode.window.showQuickPick(
      [
        { label: "Clear Browsing History", dataKind: "history" },
        { label: "Clear Cookies", dataKind: "cookies" },
        { label: "Clear Cache", dataKind: "cache" },
      ] as Array<vscode.QuickPickItem & { dataKind: ClearDataKind }>,
      { placeHolder: "Clear browsing data" },
    );
    if (picked) await this.clearBrowsingData(rec, picked.dataKind);
  }

  private toast(rec: TabRecord, text: string): void {
    if (!rec.disposed) rec.panel.webview.postMessage({ type: "toast", text });
  }

  private async disposeTab(rec: TabRecord): Promise<void> {
    if (rec.disposed) return;
    rec.disposed = true;
    // P3-9: close DevTools side panels with the tab — no orphan panels
    // pointing at a dead CDP target.
    for (const p of rec.devToolsPanels) {
      try {
        p.dispose();
      } catch {
        /* ignore */
      }
    }
    rec.devToolsPanels = [];
    for (const unsub of rec.unsubs) {
      try {
        unsub();
      } catch {
        /* ignore */
      }
    }
    rec.unsubs = [];
    await this.stopStreaming(rec);
    const service = this.service;
    if (service) {
      try {
        await service.closeSession(rec.sessionId, BROWSER_TAB_AGENT_ID);
      } catch {
        /* ignore */
      }
    }
    if (this.tab === rec) this.tab = null;
  }
}

/**
 * P3-3: whether the tab has a real loaded URL. A blank tab reports
 * "about:blank" (truthy) — Cursor treats that as "no URL" and disables the
 * screenshot / hard-reload / copy-URL menu items.
 */
function isRealUrl(url: string | undefined | null): boolean {
  // REVERIFY-P3-5: Chromium error pages (chrome-error://chromewebdata/)
  // are not copyable URLs either — treat them like about:blank.
  return !!url && url !== "about:blank" && !url.startsWith("chrome-error://");
}

function randomNonce(): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let s = "";
  for (let i = 0; i < 32; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}

// Re-exported for tests without pulling in vscode.
export { normalizeOmnibarUrl, validateBrowserTabMessage };
export type { BrowserTabState };
