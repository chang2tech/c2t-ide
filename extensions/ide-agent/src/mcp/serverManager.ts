/**
 * MCP server lifecycle — parity §B8.
 *
 * States: idle → starting → ready; failure → degraded → backoff → starting.
 * Supervision: max 5 restarts per 10 minutes (§B3), exponential backoff
 * capped at 60s, 60s cold-start timeout.
 * - stdio: `transport_closed` is terminal for the current attempt (§B8) —
 *   the supervisor decides whether to retry.
 * - HTTP: transport errors reconnect rather than die (§B8); HTTP 404 with a
 *   session id invalidates the session and re-handshakes; HTTP 401/403 is
 *   NOT retryable (auth needed → `failed` state).
 * After supervision is exhausted the server is `failed` (manual restart via
 * the `ide.mcp.restartServer` command).
 */
import { EventEmitter } from "node:events";
import { ConfiguredServer, McpLogger, McpServerState, McpTransportClient } from "./types";
import { McpAuthError, McpHttpClient } from "./httpClient";
import { McpStdioClient, McpToolDescription } from "./stdioClient";

const MAX_RESTARTS_PER_WINDOW = 5;
const RESTART_WINDOW_MS = 10 * 60_000;
const BACKOFF_BASE_MS = 1_000;
const BACKOFF_CAP_MS = 60_000;

export type McpManagerEvent =
  | { kind: "stateChanged"; state: McpServerState }
  | { kind: "toolsChanged" };

export class McpServerManager {
  private readonly emitter = new EventEmitter();
  private state: McpServerState = "idle";
  private client: McpTransportClient | undefined;
  private tools: McpToolDescription[] = [];
  private consecutiveFailures = 0;
  private restartTimestamps: number[] = [];
  private backoffTimer: NodeJS.Timeout | undefined;
  private disposed = false;
  private lastError: string | undefined;
  private serverInfo: { name: string; version?: string } | undefined;
  private startAttempt = 0;

  readonly onEvent = (listener: (e: McpManagerEvent) => void): (() => void) => {
    this.emitter.on("event", listener);
    return () => this.emitter.off("event", listener);
  };

  constructor(
    readonly server: ConfiguredServer,
    private readonly roots: string[],
    private readonly logger: McpLogger,
  ) {}

  get currentState(): McpServerState {
    return this.state;
  }
  get toolList(): McpToolDescription[] {
    return [...this.tools];
  }
  get failureCount(): number {
    return this.consecutiveFailures;
  }
  get error(): string | undefined {
    return this.lastError;
  }
  get info(): { name: string; version?: string } | undefined {
    return this.serverInfo;
  }

  /** Begin (or resume) the connection loop. */
  start(): void {
    if (this.disposed) return;
    if (this.state === "starting" || this.state === "ready" || this.state === "backoff") return;
    if (this.server.config.enabled === false) {
      this.setState("disabled");
      return;
    }
    void this.attemptStart();
  }

  /** Manual restart — resets supervision counters. */
  restart(): void {
    this.restartTimestamps = [];
    this.consecutiveFailures = 0;
    this.stopClient();
    this.clearBackoff();
    this.setState("idle");
    this.start();
  }

  stop(): void {
    this.disposed = true;
    this.clearBackoff();
    this.stopClient();
    this.setState("idle");
  }

  async callTool(
    name: string,
    args: Record<string, unknown>,
    timeoutMs?: number,
  ): Promise<unknown> {
    if (this.state !== "ready" || !this.client) {
      throw new Error(`MCP server "${this.server.displayName}" is not ready (state=${this.state})`);
    }
    try {
      return await this.client.callTool(name, args, timeoutMs);
    } catch (err) {
      // Per-call failures don't kill the connection; the transport watcher
      // handles dead processes. Count them for the degraded signal.
      this.consecutiveFailures += 1;
      if (err instanceof McpAuthError) {
        // P1-4: a 401/403 mid-session is NOT retryable (§B8) — the token
        // expired or was revoked. Mirror onStartFailure: surface an
        // actionable message and fail fast instead of leaving the server
        // "ready" while every subsequent call fails.
        this.lastError = `${err.message} — configure headers/OAuth credentials in mcp.json, then restart the server`;
        this.logger.appendLine(`[mcp] ${this.server.displayName}: authentication failed mid-session (${err.message})`);
        this.stopClient();
        this.setState("failed");
      }
      throw err;
    }
  }

  // ---- internals ---------------------------------------------------------

  private setState(next: McpServerState): void {
    if (this.state === next) return;
    this.state = next;
    this.emitter.emit("event", { kind: "stateChanged", state: next } satisfies McpManagerEvent);
  }

  private async attemptStart(): Promise<void> {
    if (this.disposed) return;
    const now = Date.now();
    this.restartTimestamps = this.restartTimestamps.filter((t) => now - t < RESTART_WINDOW_MS);
    if (this.restartTimestamps.length >= MAX_RESTARTS_PER_WINDOW) {
      this.lastError = `supervision exhausted: ${MAX_RESTARTS_PER_WINDOW} restarts in 10 minutes`;
      this.logger.appendLine(`[mcp] ${this.server.displayName}: ${this.lastError} — manual restart required`);
      this.setState("failed");
      return;
    }
    this.restartTimestamps.push(now);
    this.startAttempt += 1;
    this.setState("starting");

    const client = createTransportClient(this.server, this.roots, this.logger, {
      onNotification: (n) => {
        if (n.method === "notifications/tools/list_changed") {
          void this.refreshTools();
        }
      },
      onClose: (code, signal) => this.onTransportClosed(code, signal),
    });
    this.client = client;

    try {
      const init = await client.start();
      if (this.disposed) return;
      this.serverInfo = init.serverInfo;
      this.consecutiveFailures = 0;
      this.lastError = undefined;
      await this.refreshTools();
      if (this.disposed) return;
      this.setState("ready");
      this.logger.appendLine(
        `[mcp] ${this.server.displayName}: connected (${init.serverInfo.name}${init.serverInfo.version ? ` ${init.serverInfo.version}` : ""}, ${this.tools.length} tools)`,
      );
    } catch (err) {
      this.onStartFailure(err instanceof Error ? err : new Error(String(err)));
    }
  }

  private async refreshTools(): Promise<void> {
    if (!this.client) return;
    try {
      this.tools = await this.client.listTools();
      this.emitter.emit("event", { kind: "toolsChanged" } satisfies McpManagerEvent);
    } catch (err) {
      this.logger.appendLine(
        `[mcp] ${this.server.displayName}: tools/list failed (${err instanceof Error ? err.message : String(err)})`,
      );
    }
  }

  private onStartFailure(err: Error): void {
    if (this.disposed) return;
    this.stopClient();
    this.consecutiveFailures += 1;
    this.lastError = err.message;
    this.logger.appendLine(`[mcp] ${this.server.displayName}: start failed (${err.message})`);
    if (err instanceof McpAuthError) {
      // §B8: auth failures are NOT retryable — needs OAuth or credentials.
      this.lastError = `${err.message} — configure headers/OAuth credentials in mcp.json, then restart the server`;
      this.setState("failed");
      return;
    }
    this.scheduleBackoff();
  }

  private onTransportClosed(code: number | null, signal: string | null): void {
    if (this.disposed) return;
    // §B8: stdio transport_closed is terminal for this attempt.
    this.client = undefined;
    if (this.state === "starting") {
      // The close raced the handshake — treat as a start failure.
      this.onStartFailure(new Error(`process exited during handshake (code=${code}, signal=${signal})`));
      return;
    }
    this.consecutiveFailures += 1;
    this.lastError = `process exited (code=${code}, signal=${signal})`;
    this.logger.appendLine(`[mcp] ${this.server.displayName}: ${this.lastError}`);
    this.setState("degraded");
    this.scheduleBackoff();
  }

  private scheduleBackoff(): void {
    if (this.disposed) return;
    this.clearBackoff();
    this.setState("backoff");
    const delay = Math.min(BACKOFF_BASE_MS * 2 ** Math.min(this.consecutiveFailures - 1, 6), BACKOFF_CAP_MS);
    this.logger.appendLine(`[mcp] ${this.server.displayName}: retrying in ${Math.round(delay / 1000)}s`);
    this.backoffTimer = setTimeout(() => {
      this.backoffTimer = undefined;
      void this.attemptStart();
    }, delay);
    this.backoffTimer.unref?.();
  }

  private clearBackoff(): void {
    if (this.backoffTimer) {
      clearTimeout(this.backoffTimer);
      this.backoffTimer = undefined;
    }
  }

  private stopClient(): void {
    try {
      this.client?.stop();
    } catch {
      /* ignore */
    }
    this.client = undefined;
  }
}

/**
 * Transport factory: pick stdio or HTTP client from the server's configured
 * transport (parity §B2). stdio requires `command`; HTTP requires `url`.
 */
function createTransportClient(
  server: ConfiguredServer,
  roots: string[],
  logger: McpLogger,
  hooks: {
    onNotification: (n: import("./types").JsonRpcNotification) => void;
    onClose: (code: number | null, signal: string | null) => void;
  },
): McpTransportClient {
  if (server.transport === "streamable_http" || server.transport === "sse") {
    return new McpHttpClient({
      url: server.config.url!,
      headers: server.config.headers,
      legacySse: server.transport === "sse",
      roots,
      logger,
      onNotification: hooks.onNotification,
      onClose: hooks.onClose,
    });
  }
  return new McpStdioClient({
    command: server.config.command!,
    args: server.config.args ?? [],
    env: server.config.env,
    cwd: server.config.cwd,
    roots,
    logger,
    onNotification: hooks.onNotification,
    onClose: hooks.onClose,
  });
}
