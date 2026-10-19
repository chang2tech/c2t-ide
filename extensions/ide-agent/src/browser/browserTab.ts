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
import * as path from "node:path";
import { BrowserService, createCdpDriverFactory } from "./service";
import { launchHeadlessChromium } from "./driver";
import { browserCaptureDir, resolveChromiumPath, screenshotFilename } from "./chromium";
import { BrowserError, ElementPayload } from "./types";
import {
  renderBrowserTabHtml,
  validateBrowserTabMessage,
  normalizeOmnibarUrl,
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
}

export class BrowserTabManager {
  private service: BrowserService | null = null;
  private chromium: { port: number; stop: () => void } | null = null;
  private starting: Promise<void> | null = null;
  private tab: TabRecord | null = null;

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
    };
    this.tab = rec;

    panel.webview.onDidReceiveMessage(
      (raw) => {
        const msg = validateBrowserTabMessage(raw);
        if (!msg) return;
        void this.handleWebviewMessage(rec, msg).catch((e) => {
          this.toast(rec, e instanceof Error ? e.message : String(e));
        });
      },
      undefined,
      this.context.subscriptions,
    );
    panel.onDidChangeViewState(
      (e) => {
        if (rec.disposed) return;
        if (e.webviewPanel.visible) void this.startStreaming(rec);
        else void this.stopStreaming(rec);
      },
      undefined,
      this.context.subscriptions,
    );
    panel.onDidDispose(
      () => {
        void this.disposeTab(rec);
      },
      undefined,
      this.context.subscriptions,
    );

    // Loading indicator + URL sync from page events (read-only).
    try {
      rec.unsubs.push(
        service.onPageEvent(rec.sessionId, BROWSER_TAB_AGENT_ID, "Page.frameStartedLoading", () => {
          rec.loading = true;
          void this.pushNavState(rec);
        }),
        service.onPageEvent(rec.sessionId, BROWSER_TAB_AGENT_ID, "Page.loadEventFired", () => {
          rec.loading = false;
          void this.pushNavState(rec);
        }),
      );
    } catch {
      /* driver without event support — loading indicator just stays off */
    }

    await this.startStreaming(rec);
    if (url) await this.navigateTo(url);
    else await this.pushNavState(rec);
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
      await this.pushNavState(rec);
      if (rec.renderMode === "snapshot") await this.pushSnapshot(rec);
    }
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
    const bytes = Buffer.from(img.base64Data, "base64");
    const dir = browserCaptureDir();
    fs.mkdirSync(dir, { recursive: true });
    const filePath = path.join(dir, screenshotFilename());
    fs.writeFileSync(filePath, bytes);
    const st = await service.getNavState(rec.sessionId, BROWSER_TAB_AGENT_ID).catch(() => null);
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

  private toast(rec: TabRecord, text: string): void {
    if (!rec.disposed) rec.panel.webview.postMessage({ type: "toast", text });
  }

  private async disposeTab(rec: TabRecord): Promise<void> {
    if (rec.disposed) return;
    rec.disposed = true;
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

function randomNonce(): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let s = "";
  for (let i = 0; i < 32; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}

// Re-exported for tests without pulling in vscode.
export { normalizeOmnibarUrl, validateBrowserTabMessage };
export type { BrowserTabState };
