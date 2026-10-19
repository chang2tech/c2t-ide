/**
 * MCP HTTP transport client — Streamable HTTP (spec 2025-03-26) with legacy
 * SSE fallback (deprecated 2024-11-05 transport).
 *
 * Zero dependencies: built on node:http/https with a hand-rolled SSE parser.
 * Implements the same McpTransportClient surface as McpStdioClient so the
 * server manager can pick either transport per server config.
 *
 * Streamable HTTP flow:
 *   POST {url}  JSON-RPC (headers: Content-Type + Accept application/json,
 *               text/event-stream; Mcp-Session-Id once established)
 *   → response is either a single JSON-RPC message or an SSE stream whose
 *     final `message` event carries the matching response id.
 *   GET {url}   (Accept: text/event-stream, Mcp-Session-Id) opens the
 *               long-lived server→client stream (notifications / requests).
 *   The GET stream is re-established on drop (reconnect, §B8: HTTP transport
 *   errors are NOT terminal). HTTP 404 on a POST with a session id means the
 *   session was invalidated → drop the id, re-initialize, retry once.
 *   HTTP 404 (right after a fresh handshake) or 405 on the GET stream means
 *   the server does not offer the standalone stream → stop opening it and
 *   keep using POSTs (R1: 405 is the spec 2025-03-26 signal for this).
 *
 * Legacy SSE flow (transportType "sse" or allowDeprecatedSseFallback):
 *   GET {url} → first `endpoint` event gives the message POST URL
 *   (absolute or relative); POST JSON-RPC there; server→client messages
 *   arrive on the GET stream.
 *
 * Error classification (§B8): 401/403 → McpAuthError (NOT retryable, OAuth
 * needed); 429/503 → McpRetryableError (request_degraded); 404 with session
 * → session invalidation; anything else → McpTransportError.
 */
import * as http from "node:http";
import * as https from "node:https";
import { URL } from "node:url";
import {
  JsonRpcNotification,
  JsonRpcRequest,
  JsonRpcResponse,
  McpLogger,
  McpTransportClient,
} from "./types";
import { InitializeResult, McpToolDescription } from "./stdioClient";

const PROTOCOL_VERSIONS = ["2025-06-18", "2024-11-05"];
const INITIALIZE_TIMEOUT_MS = 60_000;
const DEFAULT_TOOL_TIMEOUT_MS = 120_000;
const STREAM_RECONNECT_BASE_MS = 1_000;
const STREAM_RECONNECT_CAP_MS = 30_000;
/** Stream-level reconnects are bounded; exhaustion escalates to the manager. */
const MAX_STREAM_RECONNECTS = 5;
/** POST attempts for 429/503 before McpRetryableError surfaces. */
const MAX_POST_RETRYABLE_ATTEMPTS = 3;
/** Headers never forwarded to a server-declared cross-origin endpoint. */
const SENSITIVE_HEADER_NAMES = new Set([
  "authorization",
  "proxy-authorization",
  "cookie",
  "x-api-key",
]);

export class McpTransportError extends Error {
  constructor(
    message: string,
    readonly statusCode?: number,
  ) {
    super(message);
    this.name = "McpTransportError";
  }
}

/** HTTP 401/403 — not retryable; OAuth (or a valid credential) is required. */
export class McpAuthError extends McpTransportError {
  constructor(message: string, statusCode?: number) {
    super(message, statusCode);
    this.name = "McpAuthError";
  }
}

/** HTTP 429/503 — request-level degradation, retry after backoff. */
export class McpRetryableError extends McpTransportError {
  constructor(message: string, statusCode?: number) {
    super(message, statusCode);
    this.name = "McpRetryableError";
  }
}

export interface HttpClientOptions {
  url: string;
  headers: Record<string, string> | undefined;
  /** true → legacy SSE transport; false → Streamable HTTP. */
  legacySse: boolean;
  roots: string[];
  logger: McpLogger;
  onNotification?: (notification: JsonRpcNotification) => void;
  /** Fired when the server→client stream drops (manager decides reconnect). */
  onClose?: (code: number | null, signal: string | null) => void;
}

interface Pending {
  resolve: (result: unknown) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

let requestSeq = 0;

export class McpHttpClient implements McpTransportClient {
  private readonly opts: HttpClientOptions;
  private sessionId: string | undefined;
  private messageEndpoint: string | undefined; // legacy SSE only
  private readonly pending = new Map<string | number, Pending>();
  private closed = false;
  private initResult: InitializeResult | undefined;
  private streamAbort: AbortController | undefined;
  private streamReq: http.ClientRequest | undefined;
  private legacyStreamRes: http.IncomingMessage | undefined;
  private streamReconnectDelay = STREAM_RECONNECT_BASE_MS;
  private streamReconnectTimer: NodeJS.Timeout | undefined;
  private streamReconnectAttempts = 0;
  private streamReconnectInFlight = false;
  /**
   * R2: consecutive 404s on the standalone GET stream. This MUST be separate
   * from streamReconnectAttempts (the drop-reconnect budget): sharing one
   * counter meant a single 404 right after a stream blip exhausted the
   * reconnect budget and permanently killed the stream, and the reset was
   * dead code.
   */
  private streamNotFoundAttempts = 0;
  private streamDead = false;
  /**
   * Generation counter for the server→client stream. Every open/close bumps
   * it; async handlers capture the generation they belong to and ignore
   * events from older generations. This is what makes closeStream()
   * race-safe: aborting our own request fires 'error'/'close' asynchronously,
   * and those stale events must never schedule a reconnect or touch the new
   * stream (P2-3).
   */
  private streamGeneration = 0;
  /**
   * The server 404s (after a fresh handshake) or 405s the standalone stream
   * — stop opening it. R2: cleared when a fresh server-side session is
   * recovered (POST 404 → re-handshake), because the new session is new
   * stream state and the stream deserves one retry; the GET 404/405 path
   * re-marks it if the new session still doesn't support the stream. The
   * guard in openServerStream() checks this flag.
   */
  private streamUnsupported = false;
  private messageEndpointCrossOrigin = false;
  private legacyReconnectAttempts = 0;

  constructor(opts: HttpClientOptions) {
    this.opts = opts;
  }

  get initialized(): InitializeResult | undefined {
    return this.initResult;
  }

  /** Handshake: POST initialize → notifications/initialized → open GET stream. */
  async start(): Promise<InitializeResult> {
    if (this.opts.legacySse) {
      await this.openLegacySseStream();
    }
    let lastError: Error | undefined;
    for (const version of PROTOCOL_VERSIONS) {
      try {
        const result = await this.postRequest<InitializeResult>(
          "initialize",
          {
            protocolVersion: version,
            capabilities: { roots: { listChanged: true } },
            clientInfo: { name: "ide-code", version: "0.1.0" },
          },
          INITIALIZE_TIMEOUT_MS,
        );
        this.initResult = result;
        await this.postNotification("notifications/initialized", {});
        if (!this.opts.legacySse && this.sessionId) {
          // Stateful server (returned a session id) → open the standalone
          // server→client stream. Stateless servers answer inline; no stream.
          this.openServerStream();
        }
        return result;
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        if (lastError instanceof McpAuthError) break; // not retryable
        if (!/protocol|version|32602/i.test(lastError.message)) break;
      }
    }
    throw lastError instanceof McpAuthError
      ? lastError // keep the type: auth failures are not retryable (§B8)
      : new Error(`MCP initialize failed: ${lastError?.message ?? "unknown error"}`);
  }

  async listTools(): Promise<McpToolDescription[]> {
    const tools: McpToolDescription[] = [];
    let cursor: string | undefined;
    do {
      const page = await this.postRequest<{ tools?: McpToolDescription[]; nextCursor?: string }>(
        "tools/list",
        cursor === undefined ? {} : { cursor },
        DEFAULT_TOOL_TIMEOUT_MS,
      );
      if (Array.isArray(page.tools)) tools.push(...page.tools);
      cursor = page.nextCursor;
    } while (cursor);
    return tools;
  }

  async callTool(
    name: string,
    args: Record<string, unknown>,
    timeoutMs = DEFAULT_TOOL_TIMEOUT_MS,
  ): Promise<unknown> {
    return this.postRequest("tools/call", { name, arguments: args }, timeoutMs);
  }

  stop(): void {
    this.closed = true;
    this.streamReconnectInFlight = false;
    this.failAllPending(new Error("MCP client stopped"));
    try {
      this.legacyStreamRes?.destroy();
    } catch {
      /* ignore */
    }
    this.legacyStreamRes = undefined;
    this.closeStream();
  }

  // ---- JSON-RPC over HTTP ------------------------------------------------

  private async postRequest<T>(method: string, params: unknown, timeoutMs: number): Promise<T> {
    if (this.closed) return Promise.reject(new Error("MCP client is closed"));
    requestSeq += 1;
    const id = `ide-${requestSeq}`;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP request "${method}" timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      timer.unref?.();
      this.pending.set(id, { resolve: (v) => resolve(v as T), reject, timer });
      void this.sendMessage({ jsonrpc: "2.0", id, method, params })
        .then((sessionInvalidated) => {
          if (sessionInvalidated) {
            // Session dropped server-side: re-handshake once, then the
            // manager's supervision loop owns further retries.
            this.pending.delete(id);
            clearTimeout(timer);
            reject(new McpTransportError(`MCP session invalidated by server (HTTP 404)`, 404));
          }
        })
        .catch((err) => {
          this.pending.delete(id);
          clearTimeout(timer);
          reject(err instanceof Error ? err : new Error(String(err)));
        });
    });
  }

  private async postNotification(method: string, params: unknown): Promise<void> {
    await this.sendMessage({ jsonrpc: "2.0", method, params });
  }

  /**
   * POST one JSON-RPC message. Returns true when the server reported the
   * session as invalid (HTTP 404 with a session id) so the caller can
   * re-initialize instead of waiting on a dead request.
   */
  private async sendMessage(
    msg: JsonRpcRequest | JsonRpcNotification | JsonRpcResponse,
    allowSessionRecovery = true,
  ): Promise<boolean> {
    for (let attempt = 0; ; attempt += 1) {
      const res = await this.doPost(msg);
      try {
        if (res.statusCode === 404 && this.sessionId && !this.opts.legacySse && allowSessionRecovery) {
          // §B8: session_invalidated → drop the session, re-handshake, then
          // retry the ORIGINAL request once on the fresh session (P2-1) so a
          // transient expiry doesn't fail a tool call that already recovered.
          this.sessionId = undefined;
          this.closeStream();
          try {
            // R2: the fresh handshake creates a genuinely new server-side
            // session, which is new stream state — clear streamUnsupported so
            // the openServerStream() guard retries the stream once. If the
            // new session still doesn't support it, the GET 404/405 path
            // re-marks it. Bounded: a GET 404 after a fresh handshake does
            // NOT re-handshake again (streamNotFoundAttempts > 1 →
            // streamUnsupported).
            this.streamUnsupported = false;
            this.streamNotFoundAttempts = 0;
            await this.start();
          } catch {
            return true; // manager supervision handles it
          }
          return this.sendMessage(msg, false);
        }
        if (res.statusCode === 404 && this.sessionId && !this.opts.legacySse) {
          return true; // second 404 — genuinely gone; signal invalidation
        }
        if (res.statusCode === 401 || res.statusCode === 403) {
          throw new McpAuthError(
            `MCP server requires authentication (HTTP ${res.statusCode}) — configure headers or OAuth credentials`,
            res.statusCode,
          );
        }
        if (res.statusCode === 429 || res.statusCode === 503) {
          if (attempt < MAX_POST_RETRYABLE_ATTEMPTS - 1) {
            const delayMs = retryAfterMs(res.headers["retry-after"], attempt);
            this.opts.logger.appendLine(
              `[mcp] HTTP ${res.statusCode} — retrying POST in ${delayMs}ms (attempt ${attempt + 2}/${MAX_POST_RETRYABLE_ATTEMPTS})`,
            );
            await sleep(delayMs);
            continue;
          }
          throw new McpRetryableError(
            `MCP server temporarily unavailable (HTTP ${res.statusCode}) after ${MAX_POST_RETRYABLE_ATTEMPTS} attempts`,
            res.statusCode,
          );
        }
        if (res.statusCode === 202) return false; // accepted, response on the GET stream
        if (res.statusCode < 200 || res.statusCode >= 300) {
          throw new McpTransportError(
            `MCP HTTP POST failed (HTTP ${res.statusCode}): ${res.body.slice(0, 200)}`,
            res.statusCode,
          );
        }
        const sessionHeader = res.headers["mcp-session-id"];
        if (typeof sessionHeader === "string" && sessionHeader) {
          this.sessionId = sessionHeader;
        }
        const contentType = String(res.headers["content-type"] ?? "");
        if (contentType.includes("text/event-stream")) {
          // Streaming mode: a truncated trailing event stays in the remainder
          // instead of being parsed as a bogus event (P3-3). A non-blank
          // remainder means the server cut the response mid-event — fail fast
          // with a clear error instead of letting the request time out.
          const remainder = this.pumpSseBody(res.body, true);
          if (remainder.trim() !== "") {
            throw new McpTransportError(
              `MCP server returned a truncated SSE event in the POST response (${remainder.length} trailing bytes unparsed)`,
            );
          }
        } else {
          this.dispatchJson(res.body);
        }
        return false;
      } finally {
        res.destroy?.();
      }
    }
  }

  /** One raw POST; header filtering for cross-origin legacy endpoints (P2-6). */
  private async doPost(
    msg: JsonRpcRequest | JsonRpcNotification | JsonRpcResponse,
  ): Promise<{ statusCode: number; headers: http.IncomingHttpHeaders; body: string; destroy?: () => void }> {
    const isLegacyEndpointPost = this.opts.legacySse && !!this.messageEndpoint;
    const target = isLegacyEndpointPost ? this.messageEndpoint! : this.opts.url;
    const stripSensitive = isLegacyEndpointPost && this.messageEndpointCrossOrigin;
    const body = JSON.stringify(msg);
    const headers: Record<string, string> = {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...filterHeaders(this.opts.headers, stripSensitive),
    };
    if (this.sessionId) headers["mcp-session-id"] = this.sessionId;
    return this.httpRequest(target, "POST", headers, body, 30_000);
  }

  // ---- server→client stream ----------------------------------------------

  private openServerStream(): void {
    if (this.closed || this.streamAbort || this.streamDead || this.streamUnsupported) return;
    const gen = ++this.streamGeneration;
    const abort = new AbortController();
    this.streamAbort = abort;
    const headers: Record<string, string> = {
      accept: "text/event-stream",
      ...(this.opts.headers ?? {}),
    };
    if (this.sessionId) headers["mcp-session-id"] = this.sessionId;

    const req = this.rawRequest(this.opts.url, "GET", headers, abort.signal);
    this.streamReq = req;
    req.on("response", (res: http.IncomingMessage) => {
      if (res.statusCode === 405) {
        // R1: spec MCP Streamable HTTP (2025-03-26) — a server that does not
        // offer the standalone SSE stream MUST answer GET with 405. The
        // session and the POST transport are unaffected, so: stop opening
        // the stream, NO reconnect, NO session invalidation, NO onClose —
        // the manager must not see this as a dead server.
        res.resume();
        this.streamUnsupported = true;
        this.streamNotFoundAttempts = 0;
        this.closeStream();
        this.opts.logger.appendLine(
          "[mcp] server answered 405 on the standalone SSE stream (no stream offered) — continuing with POST requests only",
        );
        return;
      }
      if (res.statusCode === 404 && this.sessionId) {
        // Session gone server-side. First consecutive 404: assume the session
        // expired → clear it and re-handshake for a fresh one. A 404 right
        // after a fresh handshake means the server simply does not support
        // the standalone stream → stop opening it and keep the fresh session
        // for POSTs. Session validity and stream availability are separate
        // concerns (P2-4).
        res.resume();
        // R2: own counter for consecutive GET 404s — NOT the drop-reconnect
        // budget (streamReconnectAttempts). The old code bumped the shared
        // counter here, so one 404 after a reconnect blip looked like
        // exhaustion and killed the stream permanently.
        this.streamNotFoundAttempts += 1;
        if (this.streamNotFoundAttempts > 1) {
          this.streamUnsupported = true;
          this.streamNotFoundAttempts = 0;
          this.closeStream();
          this.opts.logger.appendLine(
            "[mcp] server does not support the standalone SSE stream — continuing with POST requests only",
          );
          return;
        }
        this.sessionId = undefined;
        this.closeStream();
        void (async () => {
          try {
            await this.start(); // opens a fresh stream on success
            // R2: deliberately NO reset of streamNotFoundAttempts here. A
            // successful re-handshake means nothing about stream support —
            // the fresh stream's own response decides: 200 resets the
            // counter, a second consecutive 404 marks it unsupported. (The
            // old `gen === this.streamGeneration` reset was dead code: both
            // closeStream() and start() bump the generation first.)
          } catch {
            if (gen === this.streamGeneration) this.scheduleStreamReconnect(); // bounded; surfaces via onClose when exhausted
          }
        })();
        return;
      }
      if (res.statusCode !== 200) {
        res.resume();
        this.opts.logger.appendLine(
          `[mcp] server stream rejected (HTTP ${res.statusCode}) — reconnecting`,
        );
        this.scheduleStreamReconnect();
        return;
      }
      this.streamReconnectDelay = STREAM_RECONNECT_BASE_MS;
      this.streamReconnectAttempts = 0;
      this.streamNotFoundAttempts = 0; // R2: an open stream proves support — later 404s are session expiry again
      let buf = "";
      res.on("data", (chunk: Buffer) => {
        buf += chunk.toString("utf8");
        buf = this.pumpSseBody(buf, true);
      });
      res.on("end", () => {
        if (gen === this.streamGeneration) this.scheduleStreamReconnect();
      });
      res.on("error", () => {
        if (gen === this.streamGeneration) this.scheduleStreamReconnect();
      });
    });
    req.on("error", () => {
      if (gen !== this.streamGeneration) return; // stale: we closed/aborted it ourselves
      this.streamReq = undefined;
      this.scheduleStreamReconnect();
    });
    req.on("close", () => {
      if (gen !== this.streamGeneration) return; // stale: superseded by a newer stream
      this.streamReq = undefined;
      this.scheduleStreamReconnect();
    });
    req.end();
  }

  private scheduleStreamReconnect(): void {
    // P2-3: stale-event guard. closeStream() bumps streamGeneration, so the
    // async 'error'/'close' fired by aborting our own request belongs to an
    // older generation and never reaches here (each handler checks its gen).
    // streamReconnectInFlight additionally prevents two live schedules.
    if (this.streamReconnectInFlight) return;
    this.streamReconnectInFlight = true;
    this.closeStream();
    if (this.closed) {
      this.streamReconnectInFlight = false;
      return;
    }
    this.streamReconnectAttempts += 1;
    if (this.streamReconnectAttempts > MAX_STREAM_RECONNECTS) {
      // P1-2: bounded reconnects. The transport is dead — tell the manager
      // via onClose so it can mark the server degraded and restart cleanly.
      this.streamReconnectInFlight = false;
      this.streamReconnectAttempts = 0;
      this.streamDead = true;
      this.failAllPending(new Error("MCP server stream unavailable after reconnect attempts"));
      this.opts.logger.appendLine(
        `[mcp] server stream failed ${MAX_STREAM_RECONNECTS} reconnects — notifying manager`,
      );
      this.opts.onClose?.(null, null);
      return;
    }
    // §B8: HTTP transport errors reconnect (never terminal at stream level).
    const delay = this.streamReconnectDelay;
    this.streamReconnectDelay = Math.min(delay * 2, STREAM_RECONNECT_CAP_MS);
    this.opts.logger.appendLine(
      `[mcp] server stream dropped — reconnecting in ${Math.round(delay / 1000)}s (attempt ${this.streamReconnectAttempts}/${MAX_STREAM_RECONNECTS})`,
    );
    this.streamReconnectTimer = setTimeout(() => {
      this.streamReconnectTimer = undefined;
      this.streamReconnectInFlight = false;
      this.openServerStream();
    }, delay);
    this.streamReconnectTimer.unref?.();
  }

  private closeStream(): void {
    // Bump the generation FIRST so every async handler attached to the dying
    // request ('error', 'close', 'end') is recognized as stale and ignored.
    // Error listeners stay attached (an aborted request always has a
    // handler, so destroy() can never emit an unhandled 'error') — the
    // generation check is what stops the abort from looking like a drop
    // (P2-3). This also fixes the unhandled AbortError crash that listener
    // surgery caused.
    this.streamGeneration += 1;
    try {
      this.streamAbort?.abort();
    } catch {
      /* ignore */
    }
    this.streamAbort = undefined;
    this.streamReq = undefined;
    if (this.streamReconnectTimer) {
      clearTimeout(this.streamReconnectTimer);
      this.streamReconnectTimer = undefined;
    }
  }

  // ---- legacy SSE transport ------------------------------------------------

  private async openLegacySseStream(): Promise<void> {
    const gen = ++this.streamGeneration;
    const headers: Record<string, string> = {
      accept: "text/event-stream",
      ...(this.opts.headers ?? {}),
    };
    const endpointUrl: string = await new Promise((resolve, reject) => {
      const req = this.rawRequest(this.opts.url, "GET", headers);
      const timer = setTimeout(() => {
        req.destroy(new Error("MCP SSE connect timed out after 30000ms"));
      }, 30_000);
      timer.unref?.();
      req.on("error", (err) => {
        clearTimeout(timer);
        reject(err);
      });
      req.on("response", (res: http.IncomingMessage) => {
        if (res.statusCode === 401 || res.statusCode === 403) {
          clearTimeout(timer);
          res.resume();
          reject(
            new McpAuthError(
              `MCP SSE stream requires authentication (HTTP ${res.statusCode})`,
              res.statusCode,
            ),
          );
          return;
        }
        if (res.statusCode !== 200) {
          clearTimeout(timer);
          res.resume();
          reject(
            new McpTransportError(
              `MCP SSE stream failed (HTTP ${res.statusCode})`,
              res.statusCode,
            ),
          );
          return;
        }
        // Read chunks until the first `endpoint` event arrives, then hand
        // the live socket to the streaming pump.
        let buf = "";
        const onData = (chunk: Buffer) => {
          buf += chunk.toString("utf8");
          // Streaming mode: a partial trailing block stays in the remainder
          // and is NOT treated as a complete event (P1-1). A split
          // `event: endpoint` chunk previously resolved to an empty/truncated
          // URL, sending every later POST to the wrong address.
          //
          // P3 (X3): only accept events explicitly named `endpoint`. The old
          // `(!evt.event && evt.data)` fallback resolved ANY data-only line
          // (e.g. a server comment/message sent before the endpoint event)
          // into the message URL.
          for (const evt of parseSseEvents(buf, true).ready) {
            if (evt.event === "endpoint" && evt.data.trim()) {
              clearTimeout(timer);
              const endpoint = new URL(evt.data.trim(), this.opts.url);
              // P2-6: the message endpoint is server-declared. Never forward
              // Authorization-class headers to a cross-origin endpoint — a
              // compromised server could otherwise harvest credentials.
              const base = new URL(this.opts.url);
              this.messageEndpointCrossOrigin = endpoint.origin !== base.origin;
              if (this.messageEndpointCrossOrigin) {
                this.opts.logger.appendLine(
                  `[mcp] SSE message endpoint is cross-origin (${endpoint.origin}) — sensitive headers will not be forwarded`,
                );
              }
              const url = endpoint.toString();
              // Keep pumping the rest of this socket for server→client msgs.
              let rest = buf;
              this.legacyStreamRes = res;
              res.removeListener("data", onData);
              res.on("data", (c: Buffer) => {
                rest += c.toString("utf8");
                rest = this.pumpSseBody(rest, true);
              });
              res.on("end", () => {
                if (gen === this.streamGeneration) this.onLegacyStreamDropped();
              });
              res.on("error", () => {
                if (gen === this.streamGeneration) this.onLegacyStreamDropped();
              });
              resolve(url);
              return;
            }
          }
        };
        res.on("data", onData);
        res.on("error", (err) => {
          clearTimeout(timer);
          reject(err);
        });
      });
      req.end();
    });
    this.messageEndpoint = endpointUrl;
  }

  /** Legacy SSE stream dropped — §B8 reconnects HTTP transports (bounded). */
  private onLegacyStreamDropped(): void {
    if (this.closed) return;
    this.legacyReconnectAttempts += 1;
    if (this.legacyReconnectAttempts > MAX_STREAM_RECONNECTS) {
      this.legacyReconnectAttempts = 0;
      this.failAllPending(new Error("MCP legacy SSE stream unavailable after reconnect attempts"));
      this.opts.logger.appendLine(
        `[mcp] legacy SSE stream failed ${MAX_STREAM_RECONNECTS} reconnects — notifying manager`,
      );
      this.opts.onClose?.(null, null);
      return;
    }
    this.opts.logger.appendLine("[mcp] legacy SSE stream dropped — reconnecting");
    // P3 (X1): keep the last-known message endpoint while re-opening. Clearing
    // it here made every sendMessage in the reconnect window POST to the SSE
    // GET endpoint (404/405). The stale endpoint may itself be dead, but a
    // connection error there is honest; posting to the GET URL never is. It is
    // replaced with the fresh endpoint as soon as the re-open resolves.
    void this.openLegacySseStream()
      .then(() => {
        this.legacyReconnectAttempts = 0;
      })
      .catch((err) =>
        this.opts.logger.appendLine(`[mcp] SSE reconnect failed: ${err instanceof Error ? err.message : String(err)}`),
      );
  }

  // ---- SSE parsing ---------------------------------------------------------

  /**
   * Feed a chunk of SSE text; dispatches complete events. When `streaming` is
   * true, returns the unprocessed remainder to feed the next chunk.
   */
  private pumpSseBody(text: string, streaming = false): string {
    const events = parseSseEvents(text, streaming);
    for (const evt of events.ready) {
      if (evt.event === "endpoint") continue; // handled at connect time
      if (!evt.data || evt.data === "[DONE]") continue;
      this.dispatchJson(evt.data);
    }
    return events.remainder;
  }

  private dispatchJson(text: string): void {
    let msg: unknown;
    try {
      msg = JSON.parse(text);
    } catch {
      this.opts.logger.appendLine(`[mcp] dropping non-JSON message: ${text.slice(0, 120)}`);
      return;
    }
    if (!msg || typeof msg !== "object") return;
    const m = msg as Record<string, unknown>;
    if (m.jsonrpc !== "2.0") return;
    if ("id" in m && ("result" in m || "error" in m)) {
      const pending = this.pending.get(m.id as string | number);
      if (!pending) return;
      this.pending.delete(m.id as string | number);
      clearTimeout(pending.timer);
      const resp = m as unknown as JsonRpcResponse;
      if (resp.error) {
        pending.reject(new Error(`MCP error ${resp.error.code ?? "?"}: ${resp.error.message ?? "unknown"}`));
      } else {
        pending.resolve(resp.result);
      }
      return;
    }
    if ("method" in m && typeof m.method === "string" && !("id" in m)) {
      this.opts.onNotification?.(m as unknown as JsonRpcNotification);
      return;
    }
    if ("method" in m && typeof m.method === "string" && "id" in m) {
      this.answerServerRequest(m as unknown as JsonRpcRequest);
    }
  }

  private answerServerRequest(req: JsonRpcRequest): void {
    const respond = (result: unknown) => void this.directRespond(req.id, result);
    switch (req.method) {
      case "ping":
        respond({});
        break;
      case "roots/list":
        respond({ roots: this.opts.roots.map((r) => ({ uri: pathToFileUri(r), name: r })) });
        break;
      default:
        void this.directRespondError(req.id, -32601, `Method not found: ${req.method}`);
    }
  }

  private async directRespond(id: string | number, result: unknown): Promise<void> {
    await this.sendMessage({ jsonrpc: "2.0", id, result } as JsonRpcResponse);
  }

  private async directRespondError(id: string | number, code: number, message: string): Promise<void> {
    await this.sendMessage({ jsonrpc: "2.0", id, error: { code, message } } as JsonRpcResponse);
  }

  private failAllPending(err: Error): void {
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(err);
    }
    this.pending.clear();
  }

  // ---- raw HTTP ------------------------------------------------------------

  private rawRequest(
    url: string,
    method: string,
    headers: Record<string, string>,
    signal?: AbortSignal,
  ): http.ClientRequest {
    const u = new URL(url);
    const lib = u.protocol === "https:" ? https : http;
    return lib.request(
      {
        hostname: u.hostname,
        port: u.port ? Number(u.port) : undefined,
        path: u.pathname + u.search,
        method,
        headers,
        signal,
      },
    );
  }

  private httpRequest(
    url: string,
    method: string,
    headers: Record<string, string>,
    body: string | undefined,
    timeoutMs: number,
  ): Promise<{ statusCode: number; headers: http.IncomingHttpHeaders; body: string; destroy?: () => void }> {
    return new Promise((resolve, reject) => {
      const req = this.rawRequest(url, method, headers);
      const timer = setTimeout(() => {
        req.destroy(new Error(`MCP HTTP ${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      timer.unref?.();
      req.on("error", (err) => {
        clearTimeout(timer);
        reject(err);
      });
      req.on("response", (res: http.IncomingMessage) => {
        clearTimeout(timer);
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () =>
          resolve({
            statusCode: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks).toString("utf8"),
            destroy: () => res.destroy(),
          }),
        );
        res.on("error", (err) => reject(err));
      });
      if (body !== undefined) req.write(body);
      req.end();
    });
  }
}

/** Parse SSE text into events. Streaming mode keeps the tail remainder. */
export function parseSseEvents(
  text: string,
  streaming = false,
): { ready: Array<{ event: string; data: string }>; remainder: string } {
  const ready: Array<{ event: string; data: string }> = [];
  // Split on blank lines; keep the trailing partial block when streaming.
  const blocks = text.split(/\r?\n\r?\n/);
  const remainder = streaming ? (blocks.pop() ?? "") : "";
  for (const block of blocks) {
    let event = "";
    const dataLines: string[] = [];
    for (const line of block.split(/\r?\n/)) {
      if (line.startsWith(":")) continue; // comment / heartbeat
      if (line.startsWith("event:")) event = line.slice(6).trim();
      else if (line.startsWith("data:")) dataLines.push(line.slice(5).replace(/^ /, ""));
    }
    const data = dataLines.join("\n");
    if (data !== "" || event !== "") ready.push({ event, data });
  }
  return { ready, remainder };
}

function pathToFileUri(p: string): string {
  let normalized = p.replace(/\\/g, "/");
  if (!normalized.startsWith("/")) normalized = `/${normalized}`;
  return `file://${normalized}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Backoff for 429/503: honor Retry-After when present, else exponential. */
function retryAfterMs(header: string | string[] | undefined, attempt: number): number {
  if (typeof header === "string") {
    const secs = Number(header);
    if (Number.isFinite(secs) && secs >= 0) return Math.min(secs * 1000, 60_000);
  }
  return Math.min(1000 * 2 ** attempt, 10_000);
}

/** Drop sensitive headers when POSTing to a cross-origin legacy endpoint. */
function filterHeaders(
  headers: Record<string, string> | undefined,
  stripSensitive: boolean,
): Record<string, string> {
  if (!stripSensitive) return { ...(headers ?? {}) };
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers ?? {})) {
    if (!SENSITIVE_HEADER_NAMES.has(k.toLowerCase())) out[k] = v;
  }
  return out;
}
