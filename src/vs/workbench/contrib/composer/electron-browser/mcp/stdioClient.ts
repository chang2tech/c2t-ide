// IDE-CODE: Migrated from extensions/ide-agent/src/mcp/stdioClient.ts (CAT-A, pure logic).
/**
 * MCP stdio client — JSON-RPC 2.0 over a child process's stdio (NDJSON framing).
 *
 * Implements the MCP client side of: initialize → notifications/initialized →
 * tools/list → tools/call, plus roots/list for server-initiated requests and
 * tools/list_changed invalidation. OAuth, prompts, resources, elicitation and
 * MCP Apps are NOT implemented (honest gaps — see service.ts).
 *
 * Deliberate deviation from parity §B3 ("use SDK 1.25.1+ verbatim"): the
 * extension ships zero dependencies, and the stdio transport is plain NDJSON
 * JSON-RPC. Behavior is what matters for parity; this is documented, tested,
 * and self-contained.
 */
import { ChildProcess, spawn } from "node:child_process";
import {
  JsonRpcNotification,
  JsonRpcRequest,
  JsonRpcResponse,
  McpLogger,
} from "../../common/mcp/types.js";

const PROTOCOL_VERSIONS = ["2025-06-18", "2024-11-05"];
const INITIALIZE_TIMEOUT_MS = 60_000; // §B3: 60s cold-start timeout
const DEFAULT_TOOL_TIMEOUT_MS = 120_000;

export interface StdioClientOptions {
  command: string;
  args: string[];
  env: Record<string, string> | undefined;
  cwd: string | undefined;
  /** Workspace roots advertised via roots/list. */
  roots: string[];
  logger: McpLogger;
  onNotification?: (notification: JsonRpcNotification) => void;
  onClose?: (code: number | null, signal: string | null) => void;
}

export interface InitializeResult {
  protocolVersion: string;
  serverInfo: { name: string; version?: string };
  capabilities: Record<string, unknown>;
}

export interface McpToolDescription {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

interface Pending {
  resolve: (result: unknown) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

let requestSeq = 0;

export class McpStdioClient {
  private proc: ChildProcess | undefined;
  private buffer = "";
  private readonly pending = new Map<string | number, Pending>();
  private closed = false;
  private initResult: InitializeResult | undefined;

  constructor(private readonly opts: StdioClientOptions) {}

  get initialized(): InitializeResult | undefined {
    return this.initResult;
  }

  /** Spawn + MCP initialize handshake. Throws on failure. */
  async start(): Promise<InitializeResult> {
    const { command, args, env, cwd, logger } = this.opts;
    const proc = spawn(command, args, {
      env: { ...process.env, ...(env ?? {}) },
      cwd,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    this.proc = proc;

    proc.stdout?.on("data", (chunk: Buffer) => this.onStdout(chunk));
    proc.stderr?.on("data", (chunk: Buffer) => {
      for (const line of String(chunk).split(/\r?\n/)) {
        if (line.trim()) logger.appendLine(`[mcp:${command}] ${line}`);
      }
    });
    proc.on("error", (err) => {
      this.failAllPending(err instanceof Error ? err : new Error(String(err)));
      this.opts.onClose?.(null, null);
    });
    proc.on("close", (code, signal) => {
      this.closed = true;
      this.failAllPending(new Error(`MCP server process exited (code=${code}, signal=${signal})`));
      this.opts.onClose?.(code, signal);
    });

    // Give a failed spawn one tick to surface before handshaking.
    await new Promise((resolve) => setImmediate(resolve));

    let lastError: Error | undefined;
    for (const version of PROTOCOL_VERSIONS) {
      try {
        const result = await this.request<InitializeResult>(
          "initialize",
          {
            protocolVersion: version,
            capabilities: { roots: { listChanged: true } },
            clientInfo: { name: "ide-code", version: "0.1.0" },
          },
          INITIALIZE_TIMEOUT_MS,
        );
        this.initResult = result;
        this.sendNotification("notifications/initialized", {});
        return result;
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        // Only retry with an older version on a version-negotiation failure.
        if (!/protocol|version|32602/i.test(lastError.message)) {
          break;
        }
      }
    }
    try {
      proc.kill();
    } catch {
      /* already dead */
    }
    throw new Error(`MCP initialize failed: ${lastError?.message ?? "unknown error"}`);
  }

  async listTools(): Promise<McpToolDescription[]> {
    const tools: McpToolDescription[] = [];
    let cursor: string | undefined;
    do {
      const page = await this.request<{ tools?: McpToolDescription[]; nextCursor?: string }>(
        "tools/list",
        cursor === undefined ? {} : { cursor },
        DEFAULT_TOOL_TIMEOUT_MS,
      );
      if (Array.isArray(page.tools)) tools.push(...page.tools);
      cursor = page.nextCursor;
    } while (cursor);
    return tools;
  }

  /**
   * Call a tool. Returns the raw MCP result; the caller normalizes content
   * blocks (text/image/resource) into agent-visible output.
   */
  async callTool(
    name: string,
    args: Record<string, unknown>,
    timeoutMs = DEFAULT_TOOL_TIMEOUT_MS,
  ): Promise<unknown> {
    return this.request("tools/call", { name, arguments: args }, timeoutMs);
  }

  stop(): void {
    this.closed = true;
    this.failAllPending(new Error("MCP client stopped"));
    try {
      this.proc?.kill();
    } catch {
      /* already dead */
    }
    this.proc = undefined;
  }

  // ---- JSON-RPC plumbing -------------------------------------------------

  private onStdout(chunk: Buffer): void {
    this.buffer += chunk.toString("utf8");
    let nl: number;
    while ((nl = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, nl).trim();
      this.buffer = this.buffer.slice(nl + 1);
      if (!line) continue;
      let msg: unknown;
      try {
        msg = JSON.parse(line);
      } catch {
        this.opts.logger.appendLine(`[mcp] dropping non-JSON stdout line: ${line.slice(0, 120)}`);
        continue;
      }
      this.dispatch(msg);
    }
  }

  private dispatch(msg: unknown): void {
    if (!msg || typeof msg !== "object") return;
    const m = msg as Record<string, unknown>;
    if (m.jsonrpc !== "2.0") return;
    if ("id" in m && ("result" in m || "error" in m)) {
      const pending = this.pending.get(m.id as string | number);
      if (!pending) return;
      this.pending.delete(m.id as string | number);
      clearTimeout(pending.timer);
      if ("error" in m && m.error) {
        const e = m.error as { code?: number; message?: string };
        pending.reject(new Error(`MCP error ${e.code ?? "?"}: ${e.message ?? "unknown"}`));
      } else {
        pending.resolve(m.result);
      }
      return;
    }
    if ("method" in m && typeof m.method === "string" && !("id" in m)) {
      this.opts.onNotification?.(m as unknown as JsonRpcNotification);
      return;
    }
    if ("method" in m && typeof m.method === "string" && "id" in m) {
      // Server → client request. Answer what we must, reject the rest.
      this.answerServerRequest(m as unknown as JsonRpcRequest);
    }
  }

  private answerServerRequest(req: JsonRpcRequest): void {
    const respond = (result: unknown) => this.send({ jsonrpc: "2.0", id: req.id, result });
    const respondError = (code: number, message: string) =>
      this.send({ jsonrpc: "2.0", id: req.id, error: { code, message } });
    switch (req.method) {
      case "ping":
        respond({});
        break;
      case "roots/list": {
        respond({
          roots: this.opts.roots.map((r) => ({ uri: pathToFileUri(r), name: r })),
        });
        break;
      }
      default:
        respondError(-32601, `Method not found: ${req.method}`);
    }
  }

  private request<T>(method: string, params: unknown, timeoutMs: number): Promise<T> {
    if (this.closed || !this.proc?.stdin?.writable) {
      return Promise.reject(new Error("MCP client is closed"));
    }
    requestSeq += 1;
    const id = `ide-${requestSeq}`;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP request "${method}" timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      // Unref so a hung server can't keep the extension host alive.
      timer.unref?.();
      this.pending.set(id, {
        resolve: (v) => resolve(v as T),
        reject,
        timer,
      });
      try {
        this.send({ jsonrpc: "2.0", id, method, params });
      } catch (err) {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  private send(msg: JsonRpcRequest | JsonRpcNotification | JsonRpcResponse): void {
    this.proc?.stdin?.write(JSON.stringify(msg) + "\n");
  }

  private sendNotification(method: string, params: unknown): void {
    this.send({ jsonrpc: "2.0", method, params });
  }

  private failAllPending(err: Error): void {
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(err);
    }
    this.pending.clear();
  }
}

function pathToFileUri(p: string): string {
  let normalized = p.replace(/\\/g, "/");
  if (!normalized.startsWith("/")) normalized = `/${normalized}`;
  return `file://${normalized}`;
}
