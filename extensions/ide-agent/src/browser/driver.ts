/**
 * Page driver seam for the browser-for-agent layer.
 *
 * `PageDriver` is the exact operation surface the BrowserService needs.
 * Today it is backed by `CdpPageDriver` (CDP over WebSocket — the same
 * protocol Electron's webContents.debugger exposes, so the fork's future
 * main-process BrowserViewMainService can implement this interface with
 * zero changes to the service, picker, or screenshot logic).
 *
 * Cursor's main-process service exposes: createBrowserView / destroyBrowserView /
 * setBounds / setVisible / navigate / capturePage / executeJavaScript / CDP.
 * This interface covers the same ground from the extension host.
 */
import { execFile } from "child_process";
import * as http from "http";
import * as net from "net";
import { CdpClient } from "./cdp-client";
import { BrowserError, CaptureOptions, MAX_CAPTURE_DIMENSION, Rect, ScreenshotResult } from "./types";

export interface PageDriver {
  /** Navigate to a URL and wait for load. */
  navigate(url: string, timeoutMs?: number): Promise<void>;
  /** Capture the page. Returns ENCODED image bytes (PNG/JPEG per opts). */
  captureScreenshot(opts: CaptureOptions): Promise<ScreenshotResult>;
  /** Evaluate JS in the page and return the JSON-serializable result. */
  evaluate<T>(script: string): Promise<T>;
  /** Current URL. */
  getUrl(): Promise<string>;
  /** Page title. */
  getTitle(): Promise<string>;
  /** Send a raw CDP command (browser_cdp gate + Input.* simulation). */
  rawCdp<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T>;
  /**
   * Subscribe to a raw CDP event (e.g. "Page.loadEventFired"). Used by the
   * user-visible browser tab chrome (loading indicator, screencast) — the
   * agent's browser_cdp tool path does NOT expose this (gated separately).
   */
  onCdpEvent(method: string, handler: (params?: Record<string, unknown>) => void): () => void;
  /**
   * Start a CDP screencast (Page.startScreencast). Each frame is delivered to
   * onFrame as base64-encoded image bytes; the driver acks frames itself so
   * the stream keeps flowing. Resolves a stop function.
   * Throws when the target does not support screencast — callers must fall
   * back to periodic captureScreenshot.
   */
  startScreencast(
    opts: ScreencastOptions,
    onFrame: (dataBase64: string, metadata?: Record<string, unknown>) => void,
  ): Promise<() => Promise<void>>;
  close(): Promise<void>;
}

/** Options for PageDriver.startScreencast. */
export interface ScreencastOptions {
  format?: "jpeg" | "png";
  /** JPEG quality 0-100 (default 60). */
  quality?: number;
  maxWidth?: number;
  maxHeight?: number;
  /** Deliver every Nth frame (default 1). */
  everyNthFrame?: number;
}

interface CdpTarget {
  id: string;
  type: string;
  url: string;
  webSocketDebuggerUrl: string;
}

/** Fetch http://host:port/json and return the target list. */
function fetchTargets(host: string, port: number): Promise<CdpTarget[]> {
  return new Promise((resolve, reject) => {
    const req = http.get({ host, port, path: "/json" }, (res) => {
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => {
        try {
          resolve(JSON.parse(body));
        } catch (e) {
          reject(e);
        }
      });
    });
    req.on("error", reject);
    req.setTimeout(5000, () => {
      req.destroy(new Error("CDP target list timeout"));
    });
  });
}

/**
 * CDP-backed page driver. Connects to one page target of a Chromium
 * exposing a remote-debugging port.
 */
export class CdpPageDriver implements PageDriver {
  private client: CdpClient;
  private targetId: string;
  private host: string;
  private port: number;

  private constructor(client: CdpClient, targetId: string, host: string, port: number) {
    this.client = client;
    this.targetId = targetId;
    this.host = host;
    this.port = port;
  }

  /**
   * Attach to an existing page target, or create a fresh blank tab when
   * targetId is omitted. Enables the domains the driver needs.
   */
  static async attach(host: string, port: number, targetId?: string): Promise<CdpPageDriver> {
    let tid = targetId;
    if (!tid) {
      tid = await CdpPageDriver.createTarget(host, port, "about:blank");
    }
    const targets = await fetchTargets(host, port);
    const target = targets.find((t) => t.id === tid && t.type === "page");
    if (!target || !target.webSocketDebuggerUrl) {
      throw new BrowserError("EVAL_FAILED", `CDP page target ${tid} not found`);
    }
    const client = new CdpClient();
    await client.connect(target.webSocketDebuggerUrl);
    const driver = new CdpPageDriver(client, tid, host, port);
    // P2 (QA-FILE-05): if domain enabling fails, close the client instead of
    // leaking the CDP WebSocket.
    try {
      await client.send("Page.enable");
      await client.send("Runtime.enable");
    } catch (e) {
      client.close();
      throw e;
    }
    return driver;
  }

  static async createTarget(host: string, port: number, url: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const encoded = encodeURIComponent(url);
      // NOTE: /json/new requires PUT (GET returns a plain-text error).
      const req = http.request(
        { host, port, path: `/json/new?${encoded}`, method: "PUT" },
        (res) => {
          let body = "";
          res.on("data", (c) => (body += c));
          res.on("end", () => {
            try {
              const t = JSON.parse(body) as CdpTarget;
              if (!t.id) throw new Error("no target id returned");
              resolve(t.id);
            } catch (e) {
              reject(e);
            }
          });
        },
      );
      req.on("error", reject);
      req.setTimeout(5000, () => req.destroy(new Error("CDP new-target timeout")));
      req.end();
    });
  }

  async navigate(url: string, timeoutMs = 30000): Promise<void> {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new BrowserError("INVALID_ARGS", `browser_navigate: invalid URL "${url}"`);
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      // P0 security (QA-03): file: URLs would let a prompt-injected agent
      // render and screenshot arbitrary local files (exfiltration channel).
      throw new BrowserError("INVALID_ARGS", `browser_navigate: unsupported protocol "${parsed.protocol}" (only http/https allowed)`);
    }
    // P2: the load-wait timer is armed before Page.navigate is sent; if the
    // send fails we must disarm it (see cancelLoadWait below).
    let cancelLoadWait: () => void = () => undefined;
    const loadFired = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        unsub();
        reject(new BrowserError("NAVIGATION_FAILED", `navigation to ${url} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      const unsub = this.client.onEvent("Page.loadEventFired", () => {
        clearTimeout(timer);
        unsub();
        resolve();
      });
      // P2: expose cancellation so a Page.navigate failure below doesn't leave
      // an armed timer that rejects unobserved (unhandled rejection).
      cancelLoadWait = () => {
        clearTimeout(timer);
        unsub();
      };
    });
    // Belt-and-suspenders: even if cancellation is missed on some future path,
    // the rejection is observed here and can never surface as unhandled.
    // `await loadFired` below still receives the original rejection normally.
    loadFired.catch(() => undefined);
    try {
      const navRes = await this.client.send<{ errorText?: string }>("Page.navigate", { url });
      // P2 (QA-FILE-05): fail fast on CDP-reported net errors (DNS failures,
      // blocked hosts) instead of waiting out the full load timeout.
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
      captureBeyondViewport: !!opts.fullPage,
    };
    if (opts.type === "fullPage" || opts.fullPage) {
      // Full-page: ask the layout metrics for content size, then clip to it.
      const metrics = await this.client.send<{ contentSize: { width: number; height: number } }>(
        "Page.getLayoutMetrics",
        {},
      );
      // P2: validate + cap the content size BEFORE building the clip — an
      // absurd (or NaN) contentSize would otherwise produce a gigantic capture.
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
      const res = await this.client.send<{ data: string }>("Page.captureScreenshot", params);
      data = res.data;
    } catch (e) {
      throw new BrowserError("CAPTURE_FAILED", `Page.captureScreenshot failed: ${(e as Error).message}`);
    }
    if (!data) throw new BrowserError("CAPTURE_FAILED", "Page.captureScreenshot returned empty data");
    const viewport = await this.client.send<{ visualViewport: { clientWidth: number; clientHeight: number } }>(
      "Page.getLayoutMetrics",
      {},
    ).catch(() => null);
    return {
      data: Buffer.from(data, "base64"),
      mimeType: format === "jpeg" ? "image/jpeg" : "image/png",
      viewportWidth: Math.round(viewport?.visualViewport?.clientWidth ?? 0),
      viewportHeight: Math.round(viewport?.visualViewport?.clientHeight ?? 0),
      devicePixelRatio: 1,
    };
  }

  async evaluate<T>(script: string): Promise<T> {
    let res: { result?: { value?: T; subtype?: string }; exceptionDetails?: { text?: string } };
    try {
      res = await this.client.send("Runtime.evaluate", {
        expression: script,
        returnByValue: true,
        awaitPromise: true,
      });
    } catch (e) {
      throw new BrowserError("EVAL_FAILED", `Runtime.evaluate failed: ${(e as Error).message}`);
    }
    if (res.exceptionDetails) {
      throw new BrowserError("EVAL_FAILED", `page script threw: ${res.exceptionDetails.text ?? "unknown"}`);
    }
    return (res.result?.value ?? null) as T;
  }

  async getUrl(): Promise<string> {
    return this.evaluate<string>("window.location.href");
  }

  async getTitle(): Promise<string> {
    return this.evaluate<string>("document.title");
  }

  async rawCdp<T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    return this.client.send<T>(method, params);
  }

  onCdpEvent(method: string, handler: (params?: Record<string, unknown>) => void): () => void {
    return this.client.onEvent(method, handler);
  }

  async startScreencast(
    opts: ScreencastOptions,
    onFrame: (dataBase64: string, metadata?: Record<string, unknown>) => void,
  ): Promise<() => Promise<void>> {
    const format = opts.format ?? "jpeg";
    const quality = opts.quality ?? 60;
    const unsub = this.client.onEvent("Page.screencastFrame", (params) => {
      const data = params?.data;
      const sessionId = params?.sessionId;
      // Ack first — an unacked frame stalls the whole stream.
      if (typeof sessionId === "number") {
        this.client.send("Page.screencastFrameAck", { sessionId }).catch(() => undefined);
      }
      if (typeof data === "string" && data.length > 0) {
        try {
          onFrame(data, params?.metadata as Record<string, unknown> | undefined);
        } catch {
          /* a throwing frame handler must not kill the stream */
        }
      }
    });
    try {
      await this.client.send("Page.startScreencast", {
        format,
        quality: format === "jpeg" ? quality : undefined,
        maxWidth: opts.maxWidth ?? 1280,
        maxHeight: opts.maxHeight ?? 800,
        everyNthFrame: opts.everyNthFrame ?? 1,
      });
    } catch (e) {
      unsub();
      throw new BrowserError(
        "CAPTURE_FAILED",
        `Page.startScreencast failed: ${(e as Error).message}`,
      );
    }
    let stopped = false;
    return async () => {
      if (stopped) return;
      stopped = true;
      unsub();
      await this.client.send("Page.stopScreencast", {}).catch(() => undefined);
    };
  }

  async close(): Promise<void> {
    try {
      await this.client.send("Target.closeTarget", { targetId: this.targetId }).catch(() => undefined);
    } finally {
      this.client.close();
    }
  }
}

/** Launch a headless Chromium with a remote-debugging port. Resolves the port. */
export function launchHeadlessChromium(
  executablePath: string,
  opts: { viewport?: { width: number; height: number }; extraArgs?: string[] } = {},
): Promise<{ port: number; stop: () => void }> {
  return pickDebugPort().then(
    (port) =>
      new Promise<{ port: number; stop: () => void }>((resolve, reject) => {
    const w = opts.viewport?.width ?? 1280;
    const h = opts.viewport?.height ?? 800;
    // P2 (QA-FILE-05): validate extraArgs — they go verbatim into execFile.
    // Never model-supplied (only internal callers pass them), but enforce a
    // strict flag shape so a future caller can't inject shell metacharacters.
    for (const a of opts.extraArgs ?? []) {
      if (!/^--[A-Za-z0-9][A-Za-z0-9\-_=.,:/]*$/.test(a)) {
        throw new BrowserError("INVALID_ARGS", `unsafe Chromium arg rejected: ${a}`);
      }
    }
    // P2 (QA-FILE-05): --no-sandbox only when running as root (Chromium
    // refuses to start sandboxed as root); never disable the sandbox
    // unconditionally for an agent-driven browser visiting arbitrary URLs.
    const needsNoSandbox = typeof process.getuid === "function" && process.getuid() === 0;
    const args = [
      `--remote-debugging-port=${port}`,
      `--window-size=${w},${h}`,
      ...(needsNoSandbox ? ["--no-sandbox"] : []),
      "--disable-gpu",
      "--disable-dev-shm-usage",
      // NOTE: no --headless flag — chrome-headless-shell is headless by nature;
      // passing --headless=new breaks its DevTools server.
      "about:blank",
      ...(opts.extraArgs ?? []),
    ];
    const child = execFile(executablePath, args, { timeout: 0 }, () => undefined);
    let settled = false;
    const timer = setInterval(async () => {
      try {
        await fetchTargets("127.0.0.1", port);
        if (!settled) {
          settled = true;
          clearInterval(timer);
          resolve({
            port,
            stop: () => {
              try {
                child.kill("SIGKILL");
              } catch {
                /* ignore */
              }
            },
          });
        }
      } catch {
        /* not up yet */
      }
    }, 150);
    const startupTimeout = setTimeout(() => {
      if (!settled) {
        settled = true;
        clearInterval(timer);
        try {
          child.kill("SIGKILL");
        } catch {
          /* ignore */
        }
        reject(new BrowserError("NAVIGATION_FAILED", "headless Chromium did not start in time"));
      }
    }, 20000);
    const failFast = (reason: string) => {
      if (!settled) {
        settled = true;
        clearInterval(timer);
        clearTimeout(startupTimeout);
        try {
          child.kill("SIGKILL");
        } catch {
          /* ignore */
        }
        reject(new BrowserError("NAVIGATION_FAILED", reason));
      }
    };
    // P2: if Chromium dies before DevTools comes up (e.g. it lost a port
    // race despite the probe), fail immediately instead of hanging the 20s
    // startup timeout.
    child.on("exit", (code, signal) => {
      failFast(
        `headless Chromium exited before DevTools came up (code=${code}, signal=${signal}) — ` +
          `possible port collision or bad executable`,
      );
    });
    child.on("error", (e) => {
      failFast(`failed to spawn headless Chromium: ${(e as Error).message}`);
    });
      }),
  );
}

/** Base and range for the Chromium remote-debugging port lottery. */
const DEBUG_PORT_BASE = 19322;
const DEBUG_PORT_RANGE = 1000;
/** How many different ports to try before giving up on a collision. */
const PORT_PROBE_ATTEMPTS = 3;

/** Reject if anything is already listening on 127.0.0.1:port. */
function probePortFree(port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.close(() => resolve());
    });
  });
}

/**
 * Pick a random debugging port, verifying it is free first (P2 robustness).
 * Retries with a different port on EADDRINUSE, up to PORT_PROBE_ATTEMPTS.
 */
async function pickDebugPort(): Promise<number> {
  let lastError: unknown;
  for (let i = 0; i < PORT_PROBE_ATTEMPTS; i++) {
    const port = DEBUG_PORT_BASE + Math.floor(Math.random() * DEBUG_PORT_RANGE);
    try {
      await probePortFree(port);
      return port;
    } catch (e) {
      lastError = e;
    }
  }
  throw new BrowserError(
    "NAVIGATION_FAILED",
    `no free Chromium debugging port after ${PORT_PROBE_ATTEMPTS} attempts: ` +
      `${lastError instanceof Error ? lastError.message : String(lastError)}`,
  );
}
