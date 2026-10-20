/**
 * Test shim: implements the proposed `vscode.window.openBrowserTab` API on
 * the vscode test stub, backed by a real headless Chromium page target over
 * a raw CDP WebSocket.
 *
 * Why: the integration suite must exercise the REAL NativeBrowserPageDriver
 * (the class the 16 browser MCP tools run on after the native migration),
 * but plain node has no workbench. This shim mocks ONLY the tab-opening
 * seam (`vscode.window.openBrowserTab`); everything below it — the
 * BrowserCDPSession message channel, the driver's id-multiplexing, Page /
 * Runtime domain traffic — is the real driver code talking to a real
 * Chromium.
 *
 * Determinism: the shim keeps the tab's `url`/`title` live by snooping CDP
 * events BEFORE forwarding them to the driver —
 *   - `Page.frameNavigated` (main frame) → tab.url
 *   - `Page.loadEventFired` → refresh document.title via Runtime.evaluate,
 *     THEN forward the event, so the driver's navigate() waiters always see
 *     a fresh title.
 *
 * Test-only semantic deviation (documented): session.close() also closes the
 * underlying CDP target (production keeps the tab open). The driver's
 * close() calls session.close() then tab.close(), and both are idempotent,
 * so no test observes the difference and no targets leak.
 */
import * as http from "node:http";
import { CdpPageDriver } from "../driver";

type Listener = (e: unknown) => void;

function createEmitter() {
  const listeners = new Set<Listener>();
  return {
    event: (fn: Listener) => {
      listeners.add(fn);
      return { dispose: () => void listeners.delete(fn) };
    },
    fire: (e: unknown) => {
      for (const fn of [...listeners]) {
        try {
          fn(e);
        } catch {
          /* listener errors must not break the pump */
        }
      }
    },
    listenerCount: () => listeners.size,
  };
}

interface CdpTarget {
  id: string;
  type: string;
  url: string;
  webSocketDebuggerUrl: string;
}

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
    req.setTimeout(5000, () => req.destroy(new Error("shim: /json timeout")));
  });
}

interface ShimMessage {
  id?: number;
  method?: string;
  params?: Record<string, unknown> & {
    frame?: { url?: string; parentId?: string };
  };
  result?: { result?: { value?: unknown } } & Record<string, unknown>;
}

async function openShimmedTab(host: string, port: number, url: string) {
  const targetId = await CdpPageDriver.createTarget(host, port, "about:blank");
  const targets = await fetchTargets(host, port);
  const target = targets.find((t) => t.id === targetId && t.type === "page");
  if (!target?.webSocketDebuggerUrl) {
    throw new Error(`shim: page target ${targetId} not found`);
  }

  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("shim: websocket connect timeout")), 10000);
    ws.addEventListener("open", () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
    ws.addEventListener("error", () => {
      clearTimeout(timer);
      reject(new Error("shim: websocket error during connect"));
    }, { once: true });
  });

  const onMessage = createEmitter();
  const onClose = createEmitter();
  const shimPending = new Map<number, { resolve: (v: ShimMessage) => void; reject: (e: Error) => void }>();
  let shimId = 1_000_000; // far from the driver's id space
  let closed = false;

  const tab = {
    url: "about:blank",
    title: "",
    closed: false,
  };

  function sendRaw(msg: { id?: number; method: string; params?: Record<string, unknown> }): Promise<ShimMessage> {
    if (closed) return Promise.reject(new Error("shim: tab closed"));
    const id = msg.id ?? ++shimId;
    const payload = JSON.stringify({ ...msg, id });
    return new Promise<ShimMessage>((resolve, reject) => {
      const timer = setTimeout(() => {
        shimPending.delete(id);
        reject(new Error(`shim: ${msg.method} timed out`));
      }, 30000);
      shimPending.set(id, {
        resolve: (m) => {
          clearTimeout(timer);
          resolve(m);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      try {
        ws.send(payload);
      } catch (e) {
        shimPending.delete(id);
        clearTimeout(timer);
        reject(e instanceof Error ? e : new Error(String(e)));
      }
    });
  }

  async function refreshTitle(): Promise<void> {
    try {
      const res = await sendRaw({
        method: "Runtime.evaluate",
        params: { expression: "document.title", returnByValue: true },
      });
      const v = res.result?.result?.value;
      if (typeof v === "string") tab.title = v;
    } catch {
      /* navigation races; title refresh is best-effort */
    }
  }

  // Serialize load-event handling so title refreshes can't reorder.
  let loadChain: Promise<void> = Promise.resolve();

  ws.addEventListener("message", (ev: MessageEvent) => {
    let msg: ShimMessage;
    try {
      msg = JSON.parse(String(ev.data));
    } catch {
      return;
    }
    if (typeof msg.id === "number" && shimPending.has(msg.id)) {
      shimPending.get(msg.id)!.resolve(msg);
      shimPending.delete(msg.id);
      return;
    }
    if (msg.method === "Page.frameNavigated" && msg.params?.frame && !msg.params.frame.parentId) {
      if (typeof msg.params.frame.url === "string") tab.url = msg.params.frame.url;
    }
    if (msg.method === "Page.loadEventFired") {
      // Refresh the title BEFORE the driver sees the event (deterministic).
      loadChain = loadChain.then(refreshTitle).then(() => onMessage.fire(msg));
      return;
    }
    onMessage.fire(msg);
  });
  ws.addEventListener("close", () => {
    if (!closed) {
      closed = true;
      onClose.fire(undefined);
    }
  });

  // Mirror the main side: enable the domains the driver needs, then honor
  // the requested URL (production opens the tab AT the URL).
  await sendRaw({ method: "Page.enable", params: {} });
  await sendRaw({ method: "Runtime.enable", params: {} });
  if (url && url !== "about:blank") {
    await sendRaw({ method: "Page.navigate", params: { url } });
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 15000);
      const off = onMessage.event((m) => {
        if ((m as ShimMessage).method === "Page.loadEventFired") {
          clearTimeout(timer);
          off.dispose();
          resolve();
        }
      });
    });
  }

  async function closeTarget(): Promise<void> {
    if (tab.closed) return;
    tab.closed = true;
    try {
      await sendRaw({ method: "Target.closeTarget", params: { targetId } });
    } catch {
      /* target may already be gone */
    }
    closed = true;
    try {
      ws.close();
    } catch {
      /* ignore */
    }
    onClose.fire(undefined);
  }

  const session = {
    onDidReceiveMessage: onMessage.event,
    onDidClose: onClose.event,
    sendMessage: async (message: unknown): Promise<void> => {
      if (closed) throw new Error("shim: session closed");
      ws.send(JSON.stringify(message));
    },
    // Test-only deviation: closing the session also closes the target (see
    // file header). Idempotent; the driver calls tab.close() right after.
    close: async (): Promise<void> => {
      await closeTarget();
    },
  };

  return {
    get url() {
      return tab.url;
    },
    get title() {
      return tab.title;
    },
    startCDPSession: async () => session,
    close: async (): Promise<void> => {
      await closeTarget();
    },
  };
}

/**
 * Install `openBrowserTab` on the vscode stub's window object, backed by
 * headless Chromium at host:port. Returns an uninstall function that
 * restores the previous value.
 */
export function installNativeBrowserTabShim(
  windowLike: { openBrowserTab?: unknown },
  host: string,
  port: number,
): () => void {
  const prev = windowLike.openBrowserTab;
  windowLike.openBrowserTab = (url: string) => openShimmedTab(host, port, url);
  return () => {
    windowLike.openBrowserTab = prev;
  };
}
