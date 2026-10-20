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
  /** streamableHttp transport: endpoint URL. NOT SUPPORTED — labeled gap. */
  url?: string;
  headers?: Record<string, string>;
  /**
   * "stdio" | "sse" | "streamableHttp". sse/streamableHttp are gaps.
   * Cursor's binary enum is camelCase `streamableHttp`
   * (cursor-mcp/dist/main.js: `"streamableHttp"===n.type`); the legacy
   * snake_case `streamable_http` is still accepted at the parse boundary
   * (see detectTransport).
   */
  transportType?: string;
  allowDeprecatedSseFallback?: boolean;
  /** If false, the server is configured but never started. */
  enabled?: boolean;
  /**
   * Static OAuth client credentials — Cursor parity (cursor-mcp/dist/main.js
   * @1010800): `auth: { CLIENT_ID, CLIENT_SECRET }`. When CLIENT_ID is
   * present it becomes `staticClientInformation` on the OAuth provider and
   * dynamic client registration is skipped. See `mcp/oauthStaticCreds.ts`.
   */
  auth?: McpServerAuthConfig;
}

/** Raw mcp.json file shape. */
export interface McpConfigFile {
  mcpServers?: Record<string, McpServerConfig>;
  inputs?: unknown[];
}

/** Where a server was configured. Precedence: project > user > vscode. */
export type McpServerScope = "project" | "user" | "vscode";

/**
 * `auth` block of an mcp.json server entry — Cursor's key names, verbatim
 * (cursor-mcp/dist/main.js @1010800 reads `r.auth?.CLIENT_ID` /
 * `r.auth?.CLIENT_SECRET`). Re-exported here so config authors import from
 * one place; the logic lives in `mcp/oauthStaticCreds.ts`.
 */
export interface McpServerAuthConfig {
  CLIENT_ID?: string;
  CLIENT_SECRET?: string;
  [key: string]: string | undefined;
}

/**
 * Transport we will actually use. Canonical literal is the binary-verbatim
 * camelCase `streamableHttp` (cursor-mcp/dist/main.js 3.25.9:
 * `"streamableHttp"===n.type`, `function B(e,t){return"streamableHttp"===t&&...}`).
 */
export type McpTransport = "stdio" | "streamableHttp" | "sse";

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
  /**
   * Cursor's hosted-gateway server id, extracted from the URL path when it
   * matches `^/rest-mcp/([^/]+)/mcp/?$` (cursor-mcp/dist/main.js 3.25.9:
   * `const r=/^\/rest-mcp\/([^/]+)\/mcp\/?$/.exec(t.pathname);return r?.[1]`).
   * Absent for non-gateway URLs. Used for gateway auth/routing.
   */
  gatewayServerId?: string;
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

/**
 * Wake / network-resume reconnect policy — Cursor parity (supervisor-level
 * config, `mcp-reconnect-config.ts` in Cursor's mcpProcess).
 *
 * KEY NAMES ARE EVIDENCE-VERIFIED — Cursor 3.25.9 (see
 * `docs/rea/dig-continuous-mcp-deep-2026-10-19.md` §2.5, auditor run 30):
 * - `retryNonRetryableOnWake` — the ACTUAL key (2–3 hits in
 *   mcpProcessMain.js, cursor-mcp/dist/main.js and the glass bundle).
 * - `networkResumeReconnectEnabled`, `networkResumeReconnectDebounceMs`
 *   — real keys in the same section (`networkResumeReconnectDebounceMs`
 *   observed = 5000 ms in the 3.25.9 host bundle).
 *
 * FABRICATION WARNING (GAPS-22D): `connectOnWake` and `retryOnWake` have
 * 0 hits in EVERY 3.25.9 bundle — they were invented and do not exist.
 * Never re-introduce those names; use the keys below instead.
 */
export interface McpReconnectPolicy {
  /**
   * When true, the supervisor ALSO retries non-retryable operations on
   * wake/network-resume (e.g. servers stuck in `failed` because of a 401/403
   * auth failure). When false (default), wake only retries retryable
   * failures — non-retryable ones stay `failed` until a manual restart,
   * exactly like Cursor's semantics.
   */
  retryNonRetryableOnWake?: boolean;
  /** Master switch for wake/network-resume reconnect. */
  networkResumeReconnectEnabled?: boolean;
  /** Debounce window for wake signals (ms); observed Cursor value: 5000. */
  networkResumeReconnectDebounceMs?: number;
}

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
  /** Transport in use: stdio | streamableHttp | sse. */
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

/**
 * MCP approval grant storage — Cursor 3.25.9 parity (WORKER-GAPS-30D,
 * audit item `mcp-approval-persistence`).
 *
 * Binary evidence (workbench.glass.main.js 3.25.9, self-verified 2026-10-20):
 * - "Always allow" grants live in USER-GLOBAL reactive storage
 *   `composerState.mcpAllowedTools` — 6
 *   `setApplicationUserPersistentStorage("composerState","mcpAllowedTools",…)`
 *   call sites; entries are normalized `server:tool` strings; NO timestamps
 *   and NO TTL anywhere near them (see also P0 `mcp-approval-ttl-claim-debunked`).
 * - One-shot RUN grants live in PER-COMPOSER memory `mcpAllowedToolsForChat`:
 *   `case DJ.RUN: if(A&&!A.allowOnce){…updateComposerDataSetStore(handle,
 *   z=>z("mcpAllowedToolsForChat",K=>K?.includes(W)?K:[...K??[],W]))}`.
 * - Consult = `[...effectiveAllowlist, ...mcpAllowedToolsForChat??[]]`
 *   compared case-insensitively.
 * - `mcp-approvals.json` = 0 hits in the glass AND desktop bundles: Cursor
 *   has NO project-level approvals file. The old `<project>/.cursor/
 *   mcp-approvals.json` persistence was our invention and is removed.
 * - There is NO client-side persistent-deny store (no `mcpDeniedTools`-like
 *   key anywhere): a card "Deny" rejects the current call only; lasting
 *   deny comes from `.cursor/permissions.json` blocklists (docs).
 */
export interface McpGrantStore {
  /** User-global persistent "Always allow" grants (normalized `server:tool`). */
  getGlobalGrants(): readonly string[];
  /** Append one grant; dedupe; no TTL. */
  addGlobalGrant(entry: string): void;
  /** Per-composer in-memory one-shot RUN grants. */
  getChatGrants(composerId: string): readonly string[];
  /** Append one chat-scoped grant. */
  addChatGrant(composerId: string, entry: string): void;
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
