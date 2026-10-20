// IDE-CODE: Migrated from extensions/ide-agent/src/browser/cdp-client.ts (CAT-A, pure logic).
/**
 * Minimal Chrome DevTools Protocol client over the global WebSocket.
 *
 * Zero-dependency: uses Node 22+'s built-in WebSocket (undici). This is the
 * real automation substrate — CDP Page.captureScreenshot is what Electron's
 * webContents.capturePage does under the hood, and webContents.debugger
 * exposes the same protocol to the fork's main-process BrowserView service.
 * The driver seam (driver.ts) lets the main-process implementation replace
 * this transport with zero logic changes.
 */

export interface CdpEvent {
  method: string;
  params?: Record<string, unknown>;
}

type PendingEntry = {
  resolve: (value: Record<string, unknown>) => void;
  reject: (err: Error) => void;
};

export class CdpClient {
  private ws: WebSocket | null = null;
  private nextId = 1;
  private pending = new Map<number, PendingEntry>();
  private eventHandlers = new Map<string, Set<(params?: Record<string, unknown>) => void>>();
  private closed = false;

  /** Connect to a debugger WebSocket URL (e.g. a target's webSocketDebuggerUrl). */
  async connect(url: string, timeoutMs = 10000): Promise<void> {
    if (this.ws) throw new Error("CdpClient: already connected");
    this.ws = new WebSocket(url);
    await new Promise<void>((resolve, reject) => {
      const ws = this.ws!;
      const timer = setTimeout(() => {
        reject(new Error(`CdpClient: connect timeout after ${timeoutMs}ms`));
      }, timeoutMs);
      ws.addEventListener(
        "open",
        () => {
          clearTimeout(timer);
          resolve();
        },
        { once: true },
      );
      ws.addEventListener(
        "error",
        () => {
          clearTimeout(timer);
          reject(new Error("CdpClient: websocket error during connect"));
        },
        { once: true },
      );
    });
    this.ws.addEventListener("message", (ev: MessageEvent) => this.onMessage(ev));
    this.ws.addEventListener("close", () => this.onClose());
  }

  /** Send a CDP command and await its result. Rejects on protocol error or timeout. */
  send<T = Record<string, unknown>>(
    method: string,
    params: Record<string, unknown> = {},
    timeoutMs = 30_000,
  ): Promise<T> {
    // P2: fail fast — a socket object that exists but is CONNECTING / CLOSING /
    // CLOSED (close event not yet processed) must not accept new commands.
    if (!this.ws || this.closed || this.ws.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error("CdpClient: not connected"));
    }
    const id = this.nextId++;
    const payload = JSON.stringify({ id, method, params });
    return new Promise<T>((resolve, reject) => {
      // P0: a hung Chromium must not wedge the session queue forever.
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CdpClient: ${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v as T);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      try {
        this.ws!.send(payload);
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  /** Subscribe to a CDP event (e.g. "Page.loadEventFired"). Returns an unsubscribe fn. */
  onEvent(method: string, handler: (params?: Record<string, unknown>) => void): () => void {
    let set = this.eventHandlers.get(method);
    if (!set) {
      set = new Set();
      this.eventHandlers.set(method, set);
    }
    set.add(handler);
    return () => {
      set!.delete(handler);
    };
  }

  close(): void {
    this.closed = true;
    for (const [, p] of this.pending) p.reject(new Error("CdpClient: closed"));
    this.pending.clear();
    try {
      this.ws?.close();
    } catch {
      /* ignore */
    }
    this.ws = null;
  }

  get isConnected(): boolean {
    return !!this.ws && !this.closed;
  }

  private onMessage(ev: MessageEvent): void {
    let msg: { id?: number; method?: string; params?: Record<string, unknown>; result?: Record<string, unknown>; error?: { message?: string } };
    try {
      msg = JSON.parse(String(ev.data));
    } catch {
      return;
    }
    if (msg.id !== undefined) {
      const pending = this.pending.get(msg.id);
      if (!pending) return;
      this.pending.delete(msg.id);
      if (msg.error) pending.reject(new Error(`CDP error: ${msg.error.message ?? "unknown"}`));
      else pending.resolve(msg.result ?? {});
      return;
    }
    if (msg.method) {
      const handlers = this.eventHandlers.get(msg.method);
      if (handlers) for (const h of handlers) h(msg.params);
    }
  }

  private onClose(): void {
    this.closed = true;
    for (const [, p] of this.pending) p.reject(new Error("CdpClient: connection closed"));
    this.pending.clear();
  }
}
