/**
 * Native browser driver — drives the fork's Integrated Browser (native
 * WebContentsView tab) via the proposed `vscode.window.openBrowserTab` API
 * instead of launching a separate Chromium + CDP screencast.
 *
 * This is the Cursor-equivalent approach: Cursor's browser tab is a native
 * WebContentsView in the editor area (not a webview stream). The old
 * `CdpPageDriver` (separate Chromium process, screencast into a webview)
 * remains as a fallback for environments where the native tab is unavailable.
 *
 * Requires the `browser` API proposal in `enabledApiProposals`.
 *
 * Parity notes (mirrors CdpPageDriver in driver.ts):
 *  - navigate() enforces the same P0 URL/protocol guard (http/https only)
 *    and the same Page.navigate errorText fail-fast.
 *  - evaluate() uses awaitPromise and surfaces page exceptions as
 *    BrowserError("EVAL_FAILED"), like the CDP driver.
 *  - captureScreenshot() applies Cursor's JPEG quality default (80) and the
 *    MAX_CAPTURE_DIMENSION cap for full-page clips, and reports real
 *    viewport metrics instead of zeros.
 *  - open() enables the Page + Runtime CDP domains on the extension session
 *    (CdpPageDriver.attach does the same). The main-process side attaches
 *    the debugger without enabling domains for extension sessions
 *    (see browserViewCDPTarget.ts) — without Page.enable, Page.loadEventFired
 *    never arrives and navigate() would hang until timeout.
 */
import * as vscode from "vscode";
import { pageErrorMessage, type PageDriver, type ScreencastOptions } from "./driver";
import { BrowserError, MAX_CAPTURE_DIMENSION, type CaptureOptions, type ScreenshotResult } from "./types";

/** Minimal local shape of the proposed `vscode.BrowserTab` API. Exported so
 *  the `cursor.browserView.*` command registry can attach drivers to tabs it
 *  opened itself (e.g. `newTab` / `newHeadlessTab`). */
export interface ProposedBrowserTab {
  readonly url: string;
  readonly title: string;
  startCDPSession(): Thenable<ProposedBrowserCDPSession>;
  close(): Thenable<void>;
}

/** Minimal local shape of the proposed `vscode.BrowserCDPSession` API. */
export interface ProposedBrowserCDPSession {
  readonly onDidReceiveMessage: vscode.Event<unknown>;
  readonly onDidClose: vscode.Event<void>;
  sendMessage(message: unknown): Thenable<void>;
  close(): Thenable<void>;
}

interface CdpResponse {
  id?: number;
  result?: unknown;
  error?: { code: number; message: string };
}

interface CdpEventMsg {
  method?: string;
  params?: unknown;
}

/** Synchronous probe: is the native browser-tab API present? */
export function isNativeBrowserTabAvailable(): boolean {
  const w = vscode.window as unknown as { openBrowserTab?: unknown };
  return typeof w.openBrowserTab === "function";
}

function getProposedWindow(): {
  openBrowserTab(url: string): Thenable<ProposedBrowserTab>;
} {
  const w = vscode.window as unknown as {
    openBrowserTab?: (url: string) => Thenable<ProposedBrowserTab>;
  };
  if (typeof w.openBrowserTab !== "function") {
    throw new Error(
      "Native browser tab API is unavailable (missing 'browser' API proposal). " +
        "Falling back to the screencast driver is required.",
    );
  }
  return { openBrowserTab: w.openBrowserTab };
}

let cdpId = 0;

/**
 * PageDriver backed by a native Integrated Browser tab. CDP requests are
 * multiplexed over the tab's BrowserCDPSession with id-based matching.
 */
export class NativeBrowserPageDriver implements PageDriver {
  private tab: ProposedBrowserTab | undefined;
  private session: ProposedBrowserCDPSession | undefined;
  private readonly pending = new Map<
    number,
    { resolve: (v: unknown) => void; reject: (e: Error) => void }
  >();
  private readonly eventHandlers = new Map<string, Set<(params?: Record<string, unknown>) => void>>();
  private readonly disposables: vscode.Disposable[] = [];
  private closed = false;

  /** Open the native tab and attach a CDP session. Call once. */
  async open(url: string): Promise<void> {
    const { openBrowserTab } = getProposedWindow();
    const tab = await openBrowserTab(url);
    try {
      await this.attachToTab(tab);
    } catch (e) {
      // Don't leak the half-opened tab.
      try {
        await tab.close();
      } catch {
        /* already closed */
      }
      throw e;
    }
  }

  /**
   * Attach this driver to an ALREADY-OPEN native tab (opened e.g. by the
   * `cursor.browserView.newTab` / `newHeadlessTab` commands, or discovered
   * via `vscode.window.browserTabs`). Starts the CDP session and enables the
   * Page + Runtime domains (mirrors `open()`). The caller owns the tab's
   * lifecycle — on failure the tab is left open for the caller to close.
   */
  async attachToTab(tab: ProposedBrowserTab): Promise<void> {
    if (this.tab || this.session) {
      throw new Error("NativeBrowserPageDriver is already attached to a tab");
    }
    this.tab = tab;
    try {
      this.session = await this.tab.startCDPSession();
      this.disposables.push(
        this.session.onDidReceiveMessage((msg) => this.handleMessage(msg)),
        this.session.onDidClose(() => this.handleClose()),
      );
      // The main-process side attaches the debugger without enabling domains
      // for extension sessions — enable what the driver needs (mirrors
      // CdpPageDriver.attach). Without Page.enable, Page.loadEventFired
      // never arrives and navigate() hangs until timeout.
      await this.rawCdp("Page.enable");
      await this.rawCdp("Runtime.enable");
    } catch (e) {
      // Don't leak a half-opened session; the tab stays the caller's.
      try {
        await this.session?.close();
      } catch {
        /* already closed */
      }
      this.session = undefined;
      this.tab = undefined;
      throw e;
    }
  }

  private handleMessage(msg: unknown): void {
    const m = msg as CdpResponse & CdpEventMsg;
    if (typeof m.id === "number" && this.pending.has(m.id)) {
      const { resolve, reject } = this.pending.get(m.id)!;
      this.pending.delete(m.id);
      if (m.error) {
        reject(new Error(`CDP error ${m.error.code}: ${m.error.message}`));
      } else {
        resolve(m.result);
      }
      return;
    }
    if (typeof m.method === "string") {
      const handlers = this.eventHandlers.get(m.method);
      if (handlers) {
        for (const h of handlers) {
          try {
            h(m.params as Record<string, unknown> | undefined);
          } catch {
            /* listener errors must not break the dispatch loop */
          }
        }
      }
    }
  }

  private handleClose(): void {
    this.closed = true;
    for (const [, { reject }] of this.pending) {
      reject(new Error("Native browser CDP session closed"));
    }
    this.pending.clear();
  }

  private ensureOpen(): ProposedBrowserCDPSession {
    if (!this.session || this.closed) {
      throw new Error("Native browser tab is not open (or was closed)");
    }
    return this.session;
  }

  async rawCdp<T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    const session = this.ensureOpen();
    const id = ++cdpId;
    const result = new Promise<T>((resolve, reject) => {
      this.pending.set(id, {
        resolve: (v) => resolve(v as T),
        reject,
      });
    });
    await session.sendMessage({ id, method, params });
    return result;
  }

  async navigate(url: string, timeoutMs = 30000): Promise<void> {
    // P0 security (QA-03), mirrored from CdpPageDriver.navigate: file: URLs
    // would let a prompt-injected agent render and screenshot arbitrary local
    // files (exfiltration channel).
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new BrowserError("INVALID_ARGS", `browser_navigate: invalid URL "${url}"`);
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new BrowserError("INVALID_ARGS", `browser_navigate: unsupported protocol "${parsed.protocol}" (only http/https allowed)`);
    }
    // The load-wait timer is armed before Page.navigate is sent; if the
    // send fails we must disarm it (mirrors the CdpPageDriver pattern).
    let cancelLoadWait: () => void = () => undefined;
    const loadFired = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        unsub();
        reject(new BrowserError("NAVIGATION_FAILED", `navigation to ${url} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      const unsub = this.onCdpEvent("Page.loadEventFired", () => {
        clearTimeout(timer);
        unsub();
        resolve();
      });
      cancelLoadWait = () => {
        clearTimeout(timer);
        unsub();
      };
    });
    // Observe the rejection here so it can never surface as unhandled;
    // `await loadFired` below still receives the original rejection normally.
    loadFired.catch(() => undefined);
    try {
      const navRes = await this.rawCdp<{ errorText?: string }>("Page.navigate", { url });
      // Fail fast on CDP-reported net errors (DNS failures, blocked hosts)
      // instead of waiting out the full load timeout.
      if (navRes && typeof navRes.errorText === "string" && navRes.errorText) {
        cancelLoadWait();
        throw new BrowserError("NAVIGATION_FAILED", `navigation to ${url} failed: ${navRes.errorText}`);
      }
    } catch (e) {
      cancelLoadWait();
      if (e instanceof BrowserError) throw e;
      throw new BrowserError("NAVIGATION_FAILED", `Page.navigate failed: ${(e as Error).message}`);
    }
    await loadFired;
  }

  async captureScreenshot(opts: CaptureOptions): Promise<ScreenshotResult> {
    const format = opts.format ?? "png";
    const params: Record<string, unknown> = {
      format,
      quality: format === "jpeg" ? (opts.quality ?? 80) : undefined,
    };
    if (opts.type === "fullPage" || opts.fullPage) {
      // Full-page: ask the layout metrics for content size, then clip to it
      // (mirrors CdpPageDriver.captureScreenshot).
      const metrics = await this.rawCdp<{ contentSize: { width: number; height: number } }>(
        "Page.getLayoutMetrics",
        {},
      );
      const rawW = metrics.contentSize.width;
      const rawH = metrics.contentSize.height;
      if (!Number.isFinite(rawW) || !Number.isFinite(rawH) || rawW <= 0 || rawH <= 0) {
        throw new BrowserError("CAPTURE_FAILED", "Page.getLayoutMetrics returned an invalid content size");
      }
      const w = Math.min(Math.ceil(rawW), MAX_CAPTURE_DIMENSION);
      const h = Math.min(Math.ceil(rawH), MAX_CAPTURE_DIMENSION);
      params.clip = { x: 0, y: 0, width: w, height: h, scale: 1 };
    } else if (opts.clip) {
      const c = opts.clip;
      params.clip = { x: c.x, y: c.y, width: c.width, height: c.height, scale: 1 };
    }
    let data: string;
    try {
      const res = await this.rawCdp<{ data: string }>("Page.captureScreenshot", params);
      data = res.data;
    } catch (e) {
      throw new BrowserError("CAPTURE_FAILED", `Page.captureScreenshot failed: ${(e as Error).message}`);
    }
    if (!data) throw new BrowserError("CAPTURE_FAILED", "Page.captureScreenshot returned empty data");
    const viewport = await this.rawCdp<{
      visualViewport: { clientWidth: number; clientHeight: number };
    }>("Page.getLayoutMetrics", {}).catch(() => null);
    return {
      data: Buffer.from(data, "base64"),
      mimeType: format === "jpeg" ? "image/jpeg" : "image/png",
      viewportWidth: Math.round(viewport?.visualViewport?.clientWidth ?? 0),
      viewportHeight: Math.round(viewport?.visualViewport?.clientHeight ?? 0),
      devicePixelRatio: 1,
    };
  }

  async evaluate<T>(script: string): Promise<T> {
    let res: {
      result?: { value?: T; subtype?: string; description?: string };
      exceptionDetails?: { text?: string };
    };
    try {
      res = await this.rawCdp("Runtime.evaluate", {
        expression: script,
        returnByValue: true,
        awaitPromise: true,
      });
    } catch (e) {
      throw new BrowserError("EVAL_FAILED", `Runtime.evaluate failed: ${(e as Error).message}`);
    }
    if (res.exceptionDetails) {
      throw new BrowserError("EVAL_FAILED", `page script threw: ${pageErrorMessage(res)}`);
    }
    return (res.result?.value ?? null) as T;
  }

  async getUrl(): Promise<string> {
    // The ext host keeps BrowserTab.url live via onDidChangeBrowserTabState
    // (extHostBrowsers.ts); no page round-trip needed.
    return this.tab?.url ?? "";
  }

  async getTitle(): Promise<string> {
    return this.tab?.title ?? "";
  }

  onCdpEvent(method: string, handler: (params?: Record<string, unknown>) => void): () => void {
    let set = this.eventHandlers.get(method);
    if (!set) {
      set = new Set();
      this.eventHandlers.set(method, set);
    }
    set.add(handler);
    return () => {
      set!.delete(handler);
      if (set!.size === 0) {
        this.eventHandlers.delete(method);
      }
    };
  }

  async startScreencast(
    opts: ScreencastOptions,
    onFrame: (dataBase64: string, metadata?: Record<string, unknown>) => void,
  ): Promise<() => Promise<void>> {
    // The native tab renders itself — no screencast needed for display. Poll
    // screenshots so callers written against the screencast path keep working.
    const intervalMs = 2000;
    let stopped = false;
    const timer = setInterval(() => {
      if (stopped) {
        return;
      }
      void this.captureScreenshot({ format: "jpeg", quality: 60 })
        .then((shot) => {
          if (!stopped) {
            onFrame(shot.data.toString("base64"));
          }
        })
        .catch(() => {
          /* tab may be navigating; skip the frame */
        });
    }, intervalMs);
    return async () => {
      stopped = true;
      clearInterval(timer);
    };
  }

  async close(): Promise<void> {
    this.closed = true;
    for (const d of this.disposables) {
      d.dispose();
    }
    this.disposables.length = 0;
    try {
      await this.session?.close();
    } catch {
      /* already closed */
    }
    this.session = undefined;
    try {
      await this.tab?.close();
    } catch {
      /* already closed */
    }
    this.tab = undefined;
  }
}
