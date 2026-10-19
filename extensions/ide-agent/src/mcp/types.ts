/**
 * MCP types — Cursor parity (docs/rea/parity-rules-mcp.md §B).
 *
 * Config schema mirrors Cursor's mcp.json. Server identity encodes scope
 * in the identifier prefix (user- / project- / vscode-), stripped for display
 * (parity §B7).
 */

/** Raw server entry as written in mcp.json. */
export interface McpServerConfig {
  /** stdio transport: executable to spawn. */
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  /** Extra dotenv file(s) merged into the server env. */
  envFile?: string | string[];
  cwd?: string;
  /** streamable_http transport: endpoint URL. NOT SUPPORTED — labeled gap. */
  url?: string;
  headers?: Record<string, string>;
  /** "stdio" | "sse" | "streamable_http". sse/streamable_http are gaps. */
  transportType?: string;
  allowDeprecatedSseFallback?: boolean;
  /** If false, the server is configured but never started. */
  enabled?: boolean;
}

/** Raw mcp.json file shape. */
export interface McpConfigFile {
  mcpServers?: Record<string, McpServerConfig>;
  inputs?: unknown[];
}

/** Where a server was configured. Precedence: project > user > vscode. */
export type McpServerScope = "project" | "user" | "vscode";

/** Transport we will actually use. */
export type McpTransport = "stdio" | "streamable_http" | "sse";

/** A configured server after discovery + variable expansion. */
export interface ConfiguredServer {
  /** Scoped identifier: `project-<name>` / `user-<name>` / `vscode-<name>`. */
  id: string;
  /** Display name (identifier with the scope prefix stripped). */
  displayName: string;
  scope: McpServerScope;
  /** Absolute path of the config file this came from. */
  sourcePath: string;
  /** Expanded config (variables resolved). */
  config: Required<Pick<McpServerConfig, "args">> & McpServerConfig;
  /** Transport we will actually use. */
  transport: McpTransport;
}

/** Lifecycle states (parity §B8, adapted for extension-host stdio). */
export type McpServerState =
  | "idle"
  | "starting"
  | "ready"
  | "degraded"
  | "backoff"
  | "failed"
  | "disabled";

/** Runtime status snapshot for UI. */
export interface McpServerStatus {
  id: string;
  displayName: string;
  scope: McpServerScope;
  state: McpServerState;
  consecutiveFailures: number;
  /** Last error message, if any. */
  lastError?: string;
  /** Tools discovered on this server (namespaced). */
  toolCount: number;
  /** Server-reported info from initialize. */
  serverInfo?: { name: string; version?: string };
  /** Transport in use: stdio | streamable_http | sse. */
  transport: McpTransport;
}

/** An MCP tool as exposed to the agent (namespaced per §B4). */
export interface McpToolInfo {
  /** Agent-facing name: `mcp__<server>__<tool>`. */
  namespacedName: string;
  serverId: string;
  serverDisplayName: string;
  toolName: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

/** Allowlist decision for one tool call (parity §B5). */
export type McpApprovalDecision = "allow" | "ask" | "deny";

export interface McpPrecheckResult {
  decision: McpApprovalDecision;
  /** Human-readable reason (shown on the approval card). */
  reason: string;
  /** Which rule produced the decision. */
  matchedRule?: string;
}

/** Minimal logger so core logic stays vscode-free (and unit-testable). */
export interface McpLogger {
  appendLine(message: string): void;
}

/** MCP JSON-RPC message shapes (stdio transport). */
export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: string | number;
  method: string;
  params?: unknown;
}

export interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: string | number | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

export interface JsonRpcNotification {
  jsonrpc: "2.0";
  method: string;
  params?: unknown;
}

/**
 * Common surface both transports implement so the server manager can pick
 * stdio or HTTP per server config (parity §B2: three transports).
 */
export interface McpTransportClient {
  /** Connect + MCP initialize handshake. Throws on failure. */
  start(): Promise<{
    protocolVersion: string;
    serverInfo: { name: string; version?: string };
  }>;
  listTools(): Promise<
    Array<{ name: string; description?: string; inputSchema?: Record<string, unknown> }>
  >;
  /** Call a tool. Returns the raw MCP result; the caller normalizes it. */
  callTool(name: string, args: Record<string, unknown>, timeoutMs?: number): Promise<unknown>;
  stop(): void;
}
