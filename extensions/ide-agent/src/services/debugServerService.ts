import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import * as vscode from "vscode";
import { DebugModeConfig } from "./modeService";

export interface DebugServerExtensionOptions {
  /**
   * Explicit log directory override (tests). When omitted the binary's
   * resolution applies ([BIN] module 593): `<workspace>/.cursor`, else
   * `~/.cursor/debug-logs`.
   */
  logDir?: string;
}

/**
 * DebugServerService — the extension-side half of Debug mode, mirroring
 * Cursor's `anysphere.cursor-ndjson-ingest` extension (spec
 * dig-debug-multitask-2026-10-19 §3.1–3.2, re-verified verbatim against
 * 3.25.9 `extensions/cursor-ndjson-ingest/dist/main.js` module 93).
 *
 * A localhost HTTP server (127.0.0.1 only) that ingests NDJSON log lines
 * the debug agent's instrumentation POSTs while the user reproduces the
 * bug. Per debug session: one unguessable target id, one NDJSON log file
 * (`{logDir}/debug-{sessionId}.log`), and a bounded in-memory ring buffer
 * of recent lines (a stepping stone toward the "Debug Logs" chat block).
 *
 * Binary-verbatim request handling (module 93 `handleRequest`):
 *   - CORS headers (`Access-Control-Allow-Origin: *`,
 *     `Access-Control-Allow-Methods: GET, POST, OPTIONS`,
 *     `Access-Control-Allow-Headers: Content-Type, X-Debug-Session-Id`)
 *     are set on EVERY response;
 *   - `OPTIONS` → 200;
 *   - `POST /ingest/<targetId>` (exact raw-URL match) → 204; the body is
 *     OPAQUE BYTES — streamed straight to the log file with only a
 *     guaranteed trailing newline (NO JSON schema validation);
 *   - the only validated input is the `X-Debug-Session-Id` header against
 *     `/^[a-zA-Z0-9-]+$/`: missing → 400 "missing-session-id",
 *     non-string or pattern mismatch → 400 "invalid-session-id";
 *   - anything else → 404; a write failure → 500 "write-failed".
 * The server refuses to start in untrusted workspaces ([BIN] module 593:
 * "debug mode disabled in untrusted workspace.").
 *
 * Port: `ide.debug.ndjsonPort` (0 = auto-allocate in Cursor's verbatim
 * range 7242–7942).
 *
 * Honest gaps (documented in parity-chat-modes.md):
 * - no "Debug Logs" live block in the chat UI yet (lines go to the
 *   "IDE Agent — Debug Logs" output channel + the log file, which the
 *   agent itself reads via its read tool);
 * - no dispatch-hold while waiting for the repro (the engine has no
 *   queue-dispatch-hold primitive; the prompt asks the user to reproduce
 *   instead).
 */
export class DebugServerService implements vscode.Disposable {
  /** Cursor's verbatim auto-allocate range ([BIN] ndjson-ingest). */
  static readonly PORT_MIN = 7242;
  static readonly PORT_MAX = 7942;
  /** Ring-buffer cap for recent lines (UI stepping stone). */
  static readonly MAX_RECENT_LINES = 500;
  /**
   * Cap for the in-memory copy of a request body kept for the recent-lines
   * UI feed. The log file write itself streams uncapped, like the binary
   * (the binary imposes no body size limit).
   */
  static readonly MAX_LINE_CAPTURE_BYTES = 1024 * 1024;
  /**
   * [BIN] module 93 verbatim (`const u=/^[a-zA-Z0-9-]+$/`): the only
   * validated input of the ingest server is the `X-Debug-Session-Id`
   * header.
   */
  static readonly SESSION_ID_PATTERN = /^[a-zA-Z0-9-]+$/;

  private server: http.Server | undefined;
  private port = 0;
  private targetId = "";
  private sessionId = "";
  private logDir = "";
  /** Serializes appendExclusive calls ([BIN] module 93: `writeQueue`). */
  private writeQueue: Promise<void> = Promise.resolve();
  private readonly recentLines: string[] = [];
  private readonly lineListeners = new Set<(line: string) => void>();
  private output: vscode.OutputChannel | undefined;

  /**
   * `context` is retained for API compatibility; the log directory now
   * follows the binary (`<workspace>/.cursor`, else `~/.cursor/debug-logs`)
   * instead of the extension storage dir.
   */
  constructor(
    private readonly context?: vscode.ExtensionContext,
    private readonly opts?: DebugServerExtensionOptions,
  ) {
    void this.context;
  }

  /**
   * [BIN] module 93 verbatim (`function p(e){if(e&&u.test(e))return e}`).
   */
  private static validateSessionId(value: string): string | undefined {
    return value && DebugServerService.SESSION_ID_PATTERN.test(value) ? value : undefined;
  }

  /**
   * [BIN] module 93 verbatim: throws "Expected a valid debug session id"
   * for anything failing the pattern, otherwise
   * `{logDir}/debug-{sessionId}.log`. Because the session id is
   * pattern-validated first, no filename sanitization is needed (the
   * binary does none either).
   */
  getLogPathForSession(sessionId: string): string {
    const valid = DebugServerService.validateSessionId(sessionId);
    if (!valid) {
      throw new Error("Expected a valid debug session id");
    }
    return path.join(this.logDir, `debug-${valid}.log`);
  }

  /**
   * Start (or reuse) the ingest server for a debug session. Idempotent per
   * session id: calling again with the same id returns the current config
   * without restarting. A different session id restarts with a fresh
   * target id; the log file is per session id (`debug-{sessionId}.log`),
   * so a new session naturally starts with a fresh file.
   *
   * Refuses to start in untrusted workspaces ([BIN] module 593).
   */
  async ensureStarted(sessionId: string): Promise<DebugModeConfig> {
    // [BIN] module 593 ($): the start command refuses untrusted workspaces
    // before doing anything else.
    if (!vscode.workspace.isTrusted) {
      vscode.window.showWarningMessage("debug mode disabled in untrusted workspace.");
      throw new Error("debug mode disabled in untrusted workspace.");
    }
    if (this.server && this.sessionId === sessionId) {
      const existing = this.getConfig();
      if (existing) return existing;
    }
    await this.stop();
    this.sessionId = sessionId;
    this.targetId = randomUUID();
    this.logDir = this.resolveLogDir();
    await fsp.mkdir(this.logDir, { recursive: true });
    // No truncation: the binary appends (flags: "a"); a new session id
    // already yields a fresh file via getLogPathForSession (which throws
    // for an invalid session id, [BIN]).

    const port = await this.pickPort();
    this.server = http.createServer((req, res) => {
      void this.handleRequest(req, res).catch(() => {
        try {
          res.writeHead(500);
          res.end("write-failed");
        } catch {
          /* already closed */
        }
      });
    });
    await new Promise<void>((resolve, reject) => {
      const onError = (err: unknown): void => reject(err);
      this.server!.once("error", onError);
      this.server!.listen(port, "127.0.0.1", () => {
        this.server!.removeListener("error", onError);
        resolve();
      });
    });
    this.port = port;
    if (!this.output) {
      this.output = vscode.window.createOutputChannel("IDE Agent — Debug Logs");
    }
    this.output.appendLine(`[debug] ingest server listening on 127.0.0.1:${port} (session ${sessionId})`);
    return this.buildConfig();
  }

  /** Current config for the running server, or undefined when stopped. */
  getConfig(): DebugModeConfig | undefined {
    if (!this.server || !this.port) return undefined;
    return this.buildConfig();
  }
  private buildConfig(): DebugModeConfig {
    return {
      logPath: this.getLogPathForSession(this.sessionId),
      serverEndpoint: `http://127.0.0.1:${this.port}/ingest/${this.targetId}`,
      sessionId: this.sessionId,
    };
  }

  /** Most recent ingested lines (oldest first), up to `limit`. */
  getRecentLines(limit = 100): string[] {
    return this.recentLines.slice(-Math.max(0, limit));
  }

  /** Subscribe to ingested lines (UI stepping stone). */
  onLine(listener: (line: string) => void): vscode.Disposable {
    this.lineListeners.add(listener);
    return { dispose: () => this.lineListeners.delete(listener) };
  }

  /** Stop the server. Safe to call when not started. */
  async stop(): Promise<void> {
    const server = this.server;
    this.server = undefined;
    this.port = 0;
    this.targetId = "";
    this.sessionId = "";
    this.recentLines.length = 0;
    if (server) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }

  dispose(): void {
    void this.stop();
    this.lineListeners.clear();
    this.output?.dispose();
    this.output = undefined;
  }

  private async pickPort(): Promise<number> {
    const configured = vscode.workspace
      .getConfiguration("ide.debug")
      .get<number>("ndjsonPort", 0);
    if (configured && configured > 0) {
      await this.assertPortFree(configured);
      return configured;
    }
    for (let port = DebugServerService.PORT_MIN; port <= DebugServerService.PORT_MAX; port++) {
      if (await this.isPortFree(port)) return port;
    }
    throw new Error(
      `IDE Agent: no free debug ingest port in ${DebugServerService.PORT_MIN}–${DebugServerService.PORT_MAX} ` +
        `(set ide.debug.ndjsonPort to override)`,
    );
  }

  private isPortFree(port: number): Promise<boolean> {
    return new Promise((resolve) => {
      const probe = http.createServer();
      probe.once("error", () => resolve(false));
      probe.listen(port, "127.0.0.1", () => probe.close(() => resolve(true)));
    });
  }

  private async assertPortFree(port: number): Promise<void> {
    if (!(await this.isPortFree(port))) {
      throw new Error(`IDE Agent: ide.debug.ndjsonPort ${port} is already in use`);
    }
  }

  /**
   * [BIN] module 593 ($) verbatim resolution: `<workspace>/.cursor` for the
   * first workspace folder, else `~/.cursor/debug-logs`. An explicit
   * `opts.logDir` overrides both (tests).
   */
  private resolveLogDir(): string {
    if (this.opts?.logDir) {
      return this.opts.logDir;
    }
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (folder) {
      return path.join(folder.uri.fsPath, ".cursor");
    }
    return path.join(os.homedir(), ".cursor", "debug-logs");
  }

  /**
   * [BIN] module 93 verbatim request handling: CORS headers on every
   * response → OPTIONS 200 → non-POST / wrong-path 404 → missing/invalid
   * X-Debug-Session-Id 400 → stream the opaque body to the session's log
   * file → 204 (500 "write-failed" on write error).
   */
  private async handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-Debug-Session-Id");
    if (req.method === "OPTIONS") {
      res.writeHead(200);
      res.end();
      return;
    }
    // Exact raw-URL match — no URL parsing, no query-string tolerance.
    if (req.method !== "POST" || req.url !== `/ingest/${this.targetId}`) {
      res.writeHead(404);
      res.end();
      return;
    }
    const headerValue = req.headers["x-debug-session-id"];
    if (headerValue === undefined) {
      this.output?.appendLine("Rejected NDJSON ingest request without X-Debug-Session-Id header");
      res.writeHead(400);
      res.end("missing-session-id");
      return;
    }
    if (typeof headerValue !== "string") {
      this.output?.appendLine("Rejected NDJSON ingest request with invalid X-Debug-Session-Id header");
      res.writeHead(400);
      res.end("invalid-session-id");
      return;
    }
    const sessionId = DebugServerService.validateSessionId(headerValue);
    if (!sessionId) {
      this.output?.appendLine("Rejected NDJSON ingest request with invalid X-Debug-Session-Id header");
      res.writeHead(400);
      res.end("invalid-session-id");
      return;
    }
    // Bounded in-memory copy for the recent-lines UI feed; the file write
    // streams the raw bytes uncapped, like the binary.
    const chunks: Buffer[] = [];
    let capturedBytes = 0;
    try {
      await this.appendExclusive(req, this.getLogPathForSession(sessionId), (chunk) => {
        if (capturedBytes < DebugServerService.MAX_LINE_CAPTURE_BYTES) {
          chunks.push(chunk);
          capturedBytes += chunk.length;
        }
      });
    } catch (e) {
      this.output?.appendLine(
        `NDJSON ingest write error: ${e instanceof Error ? e.message : String(e)}`,
      );
      res.writeHead(500);
      res.end("write-failed");
      return;
    }
    res.writeHead(204);
    res.end();
    this.emitLines(Buffer.concat(chunks).toString("utf8"));
  }

  /**
   * [BIN] module 93 verbatim: appends the request's raw bytes to the log
   * file (stream pipeline, `flags: "a"`); the only transformation is a
   * guaranteed trailing newline. Bodies are OPAQUE — no JSON parsing, no
   * line splitting. Writes serialize through `writeQueue`; a failed write
   * is logged and the queue continues, while the caller still sees the
   * rejection.
   *
   * `onChunk` is our own addition: it taps the raw chunks for the
   * recent-lines UI feed without touching the bytes written to disk.
   */
  private async appendExclusive(
    req: http.IncomingMessage,
    logPath: string,
    onChunk?: (chunk: Buffer) => void,
  ): Promise<void> {
    const run = async (): Promise<void> => {
      let lastByte = 10; // "\n" — an empty body writes nothing.
      const out = fs.createWriteStream(logPath, { flags: "a" });
      await pipeline(
        req,
        new Transform({
          transform(chunk: Buffer, _encoding, callback) {
            if (chunk.length > 0) {
              lastByte = chunk[chunk.length - 1];
            }
            onChunk?.(chunk);
            callback(null, chunk);
          },
          flush(callback) {
            if (lastByte !== 10) {
              this.push(Buffer.from("\n"));
            }
            callback();
          },
        }),
        out,
      );
    };
    const pending = this.writeQueue.then(run, run);
    this.writeQueue = pending.catch((e) => {
      this.output?.appendLine(
        `Error appending to log file: ${e instanceof Error ? e.message : String(e)}`,
      );
    });
    return pending;
  }

  /**
   * Our own UI stepping stone (not in the binary): a best-effort line view
   * of the ingested bytes for the recent-lines ring buffer, the line
   * listeners and the output channel. The log file always gets the verbatim
   * bytes.
   */
  private emitLines(body: string): void {
    const lines = body
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.length > 0);
    if (lines.length === 0) {
      return;
    }
    for (const line of lines) {
      this.recentLines.push(line);
      if (this.recentLines.length > DebugServerService.MAX_RECENT_LINES) {
        this.recentLines.shift();
      }
      this.output?.appendLine(formatLine(line));
      for (const listener of this.lineListeners) {
        try {
          listener(line);
        } catch {
          /* listener errors must not break ingestion */
        }
      }
    }
  }
}

/** Best-effort pretty line for the output channel: "<time> <msg>". */
function formatLine(line: string): string {
  try {
    const obj = JSON.parse(line) as { ts?: number; level?: string; msg?: string; message?: string };
    const time = typeof obj.ts === "number" ? new Date(obj.ts).toISOString().slice(11, 23) : "";
    const msg = obj.msg ?? obj.message ?? line;
    const level = obj.level ? `[${obj.level}] ` : "";
    return `${time} ${level}${msg}`.trim();
  } catch {
    return line;
  }
}
