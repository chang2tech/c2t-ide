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
 */
import * as vscode from "vscode";
import type { PageDriver, ScreencastOptions } from "./driver";
import type { CaptureOptions, ScreenshotResult } from "./types";

/** Minimal local shape of the proposed `vscode.BrowserTab` API. */
interface ProposedBrowserTab {
  readonly url: string;
  readonly title: string;
  startCDPSession(): Thenable<ProposedBrowserCDPSession>;
  close(): Thenable<void>;
}

/** Minimal local shape of the proposed `vscode.BrowserCDPSession` API. */
interface ProposedBrowserCDPSession {
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
    this.tab = await openBrowserTab(url);
    this.session = await this.tab.startCDPSession();
    this.disposables.push(
      this.session.onDidReceiveMessage((msg) => this.handleMessage(msg)),
      this.session.onDidClose(() => this.handleClose()),
    );
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
    // Drive navigation through CDP so the agent owns the tab's location.
    const loaded = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        off();
        reject(new Error(`Native browser navigation timed out after ${timeoutMs}ms: ${url}`));
      }, timeoutMs);
      const off = this.onCdpEvent("Page.loadEventFired", () => {
        clearTimeout(timer);
        off();
        resolve();
      });
    });
    await this.rawCdp("Page.navigate", { url });
    await loaded;
  }

  async captureScreenshot(opts: CaptureOptions): Promise<ScreenshotResult> {
    const params: Record<string, unknown> = {
      format: opts.format ?? "png",
    };
    if (typeof opts.quality === "number") {
      params.quality = opts.quality;
    }
    if (opts.clip) {
      params.clip = opts.clip;
    }
    if (opts.fullPage) {
      params.captureBeyondViewport = true;
    }
    const result = await this.rawCdp<{ data: string }>("Page.captureScreenshot", params);
    const format = (opts.format ?? "png") as "png" | "jpeg";
    return {
      data: Buffer.from(result.data, "base64"),
      mimeType: format === "jpeg" ? "image/jpeg" : "image/png",
      viewportWidth: 0,
      viewportHeight: 0,
      devicePixelRatio: 1,
    };
  }

  async evaluate<T>(script: string): Promise<T> {
    const result = await this.rawCdp<{ result: { value?: T } }>("Runtime.evaluate", {
      expression: script,
      returnByValue: true,
    });
    return result.result.value as T;
  }

  async getUrl(): Promise<string> {
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
