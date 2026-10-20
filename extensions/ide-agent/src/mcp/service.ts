/**
 * McpService — extension-host MCP client facade (Cursor parity §B).
 *
 * Wires together: config discovery (config.ts), server lifecycle
 * (serverManager.ts), tool namespacing (names.ts) and the approval gate
 * (allowlist.ts → HumanReviewService approval card, trigger reason
 * `mcpToolsProtection`, card label `MCP:<tool>`).
 *
 * HONEST GAPS (not implemented, not faked):
 * - Prompts, Resources, Elicitation, MCP Apps (§B9)
 * - stdio transport implemented directly as NDJSON JSON-RPC (no
 *   @modelcontextprotocol/sdk dependency — deliberate, documented in
 *   stdioClient.ts). HTTP transports (streamableHttp + legacy SSE) are
 *   likewise hand-rolled on node:http/https (httpClient.ts).
 *
 * IMPLEMENTED (2026-10-20, WORKER-GAPS-11J):
 * - MCP log channels — Cursor parity (mcpLogs.ts): aggregate "MCP Logs",
 *   "MCP OAuth", "MCP Allowlist" log channels plus per-server `MCP: <name>`
 *   channels (binary-verified: glass bundle @20659807, cursor-mcp @641179).
 * - MCP OAuth static client credentials (oauthStaticCreds.ts + oauthFlow.ts):
 *   `auth: { CLIENT_ID, CLIENT_SECRET }` in mcp.json → staticClientInformation
 *   (binary-verified cursor-mcp @1010800), loopback authorization-code flow
 *   with PKCE, SecretStorage token persistence keyed by canonical server URL
 *   (HONEST-DIVERGENCE: Cursor uses diskKV in mcpProcess; ours is
 *   OS-keychain-backed). Bearer injection happens at client construction
 *   (Cursor injects per-request via `mcp.cursorAccessToken`).
 *
 * IMPLEMENTED (2026-10-20, DEV-GAPS-8):
 * - `cursor.registerMcpProvider()` extension API (providerRegistry.ts +
 *   providerApi.ts): in-process providers register tools that surface as
 *   `mcp__<provider.id>__<tool>` and run through this service's approval
 *   gate. Binary-verified against Cursor 3.25.9 (see providerRegistry.ts).
 *   Architectural delta (documented, not hidden): Cursor attaches the
 *   `cursor` namespace to the `vscode` module from workbench-core and
 *   bridges providers workbench-side; here the agent runtime and MCP stack
 *   live in this extension, so the contract is implemented extension-locally
 *   and published on this extension's exports (`ide-code.ide-agent`).
 *
 * Relationship to the engine sidecar: the ide-code engine (OpenCode core)
 * already runs its own MCP layer with `mcp__<server>__<tool>` namespacing and
 * permission gating when `ide.agent.engineMode=sidecar`. This service is the
 * extension-host counterpart: it manages `.cursor/mcp.json` servers, the
 * workbench surfaces (Output channels, server list, restart commands) and the
 * approval cards. When the engine adapter runs a turn, `mcp__*` tool calls
 * from the sidecar surface through the engine's own permission flow
 * (IdeCodeEngineAdapter.handleApproval → HumanReviewService); this service's
 * `callTool` is the entry point for extension-host-initiated calls.
 */
import * as vscode from "vscode";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { EventEmitter } from "node:events";
import { ComposerDataService } from "../services/composerDataService";
import {
  ConfiguredServer,
  McpApprovalDecision,
  McpLogger,
  McpServerConfig,
  McpServerState,
  McpServerStatus,
  McpToolInfo,
} from "./types";
import { approvalLabel, displayNameFor, parseToolName, toolName } from "./names";
import { candidateConfigFiles, discoverServers, mergeServerIntoMcpConfig } from "./config";
import { McpServerManager, McpManagerEvent } from "./serverManager";
import { McpAllowlist } from "./allowlist";
import { ExtensionMcpGrantStore } from "./grantStore";
import { mcpApprovalOptions } from "./approvalOptions";
import { McpCallResult, formatResultMarkdown, normalizeResult } from "./results";
import { McpLogChannels } from "./mcpLogs";
import { McpOAuthBroker, discoverOAuthEndpoints, refreshAccessToken } from "./oauthFlow";
import { staticClientInfoFromConfig } from "./oauthStaticCreds";
import {
  McpProvider,
  McpProviderCallContext,
  McpProviderRegistry,
  McpProviderTurnEndedContext,
} from "./providerRegistry";
import {
  SymbolicFileArgBinding,
  SymbolicArgError,
  collectSymbolicFileArgs,
  describeSymbolicFileArgs,
  expandSymbolicFileArgs,
  nodeFsSymbolicFileReader,
  refuseSymbolicArgsForFirstPartyTool,
  sharedSymbolicArgsMetrics,
  type SymbolicFileReader,
} from "./symbolicFileArgs";

export type { McpCallResult };

export type McpServiceEvent =
  | { kind: "serversChanged" }
  | { kind: "toolsChanged" };

/** Re-exported for callers that only need the result shape. */
export { normalizeResult };

const vscodeLogger = (channel: vscode.OutputChannel): McpLogger => ({
  appendLine: (message: string) => channel.appendLine(message),
});

/** Optional McpService wiring (all fields optional; existing 2-arg callers unaffected). */
export interface McpServiceOptions {
  /**
   * Whether hooks that inspect MCP calls are configured
   * (`beforeMCPExecution`/`afterMCPExecution`). Cursor refuses `$file:`
   * symbolic arguments on such computers (binary hook-interplay string) —
   * the hooks would see the literal, not the file's contents.
   */
  hooksInspectMcpCalls?: () => boolean;
}

export class McpService implements vscode.Disposable {
  private readonly emitter = new EventEmitter();
  private readonly managers = new Map<string, McpServerManager>();
  private readonly disposables: vscode.Disposable[] = [];
  private readonly allowlist: McpAllowlist;
  private readonly outputChannels = new Map<string, vscode.OutputChannel>();
  private readonly mainChannel: vscode.OutputChannel;
  /**
   * Cursor-verbatim MCP log channels ("MCP Logs", "MCP OAuth",
   * "MCP Allowlist", per-server "MCP: <name>"). See mcpLogs.ts for the
   * binary evidence.
   */
  private readonly logChannels: McpLogChannels;
  /**
   * Static-credential OAuth broker: auth failure → "Authenticate" prompt →
   * loopback flow → Bearer header → restart. See oauthFlow.ts.
   */
  private readonly oauthBroker: McpOAuthBroker;
  /** Server ids already offered the Authenticate prompt (no nag loops). */
  private readonly authPrompted = new Set<string>();
  private readonly roots: string[];
  /** In-process providers registered via `cursor.registerMcpProvider()`. */
  private readonly providerRegistry = new McpProviderRegistry();
  /** Read executor for `$file:` symbolic MCP arguments (see symbolicFileArgs.ts). */
  private readonly symbolicFileReader: SymbolicFileReader;

  readonly onDidChange = (listener: (e: McpServiceEvent) => void): vscode.Disposable => {
    this.emitter.on("event", listener);
    return { dispose: () => this.emitter.off("event", listener) };
  };

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly getComposer: () => ComposerDataService,
    private readonly options: McpServiceOptions = {},
  ) {
    this.roots = (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath);
    this.mainChannel = vscode.window.createOutputChannel("IDE Agent — MCP");
    this.logChannels = new McpLogChannels();
    this.disposables.push(this.logChannels);
    /**
     * Read executor for `$file:` symbolic MCP arguments (Cursor parity,
     * symbolicFileArgs.ts): reads via node:fs and hashes locally (the
     * binary's `vm_digest` equivalent — see the module's HONEST-DIVERGENCE).
     */
    this.symbolicFileReader = nodeFsSymbolicFileReader();
    this.oauthBroker = new McpOAuthBroker(context, (message) =>
      this.logChannels.oauthLogger.appendLine(message),
    );
    this.allowlist = new McpAllowlist(
      this.roots,
      vscodeLogger(this.logChannels.allowlistLogger),
      // Cursor 3.25.9 parity (mcp-approval-persistence): "Always allow"
      // grants live in user-global `composerState.mcpAllowedTools`
      // (ExtensionContext.globalState); one-shot RUN grants live in
      // per-composer memory. No .cursor/mcp-approvals.json (0 hits in Cursor).
      new ExtensionMcpGrantStore(this.context.globalState),
    );
  }

  /** Discover config, start watchers, connect servers. */
  start(): void {
    this.refreshServers();
    this.watchConfigFiles();
    this.registerCommands();
    // Provider registry → service events, so the agent tool list and the
    // Customize view follow register/unregister/snapshot pushes.
    this.disposables.push(
      this.providerRegistry.onDidChange((e) => {
        if (e.kind === "toolsChanged") {
          this.emitter.emit("event", { kind: "toolsChanged" } satisfies McpServiceEvent);
        } else {
          this.emitter.emit("event", { kind: "serversChanged" } satisfies McpServiceEvent);
        }
      }),
    );
  }

  dispose(): void {
    for (const d of this.disposables) {
      try {
        d.dispose();
      } catch {
        /* ignore */
      }
    }
    for (const m of this.managers.values()) {
      m.stop();
    }
    this.managers.clear();
    this.providerRegistry.clear();
    this.emitter.removeAllListeners();
  }

  // ---- servers -----------------------------------------------------------

  /** Current status of every configured server (for UI). */
  getServerStatuses(): McpServerStatus[] {
    const out: McpServerStatus[] = [];
    for (const [id, mgr] of this.managers) {
      out.push({
        id,
        displayName: mgr.server.displayName,
        scope: mgr.server.scope,
        state: mgr.currentState,
        consecutiveFailures: mgr.failureCount,
        lastError: mgr.error,
        toolCount: mgr.toolList.length,
        serverInfo: mgr.info,
        transport: mgr.server.transport,
      });
    }
    return out.sort((a, b) => a.displayName.localeCompare(b.displayName));
  }

  /** All tools across ready servers AND registered providers, with Cursor's
   * `mcp__<server>__<tool>` names. For providers, `<server>` is the provider
   * id (e.g. `mcp__cursor-ide-browser__browser_navigate`). */
  getTools(): McpToolInfo[] {
    const out: McpToolInfo[] = [];
    for (const [, mgr] of this.managers) {
      if (mgr.currentState !== "ready") continue;
      for (const t of mgr.toolList) {
        out.push({
          namespacedName: toolName(mgr.server.displayName, t.name),
          serverId: mgr.server.id,
          serverDisplayName: mgr.server.displayName,
          toolName: t.name,
          description: t.description ?? "",
          inputSchema: t.inputSchema ?? { type: "object", properties: {} },
        });
      }
    }
    for (const { provider, tool } of this.providerRegistry.getTools()) {
      out.push({
        namespacedName: toolName(provider.id, tool.name),
        serverId: provider.id,
        serverDisplayName: provider.name ?? provider.id,
        toolName: tool.name,
        description: tool.description,
        inputSchema:
          tool.parameters && typeof tool.parameters === "object"
            ? (tool.parameters as Record<string, unknown>)
            : { type: "object", properties: {} },
      });
    }
    return out;
  }

  // ---- in-process providers: cursor.registerMcpProvider() ------------------

  /**
   * Register an in-process MCP provider (the `cursor.registerMcpProvider()`
   * contract — see providerRegistry.ts for binary evidence).
   *
   * The provider's tools appear in `getTools()` as
   * `mcp__<provider.id>__<tool>` once its offerings are fetched; disposing
   * the returned Disposable unregisters it. Like Cursor, `initialize()` is
   * NOT invoked here — the registering extension calls it itself.
   */
  registerMcpProvider(provider: McpProvider): vscode.Disposable {
    const handle = this.providerRegistry.register(provider);
    // Fetch offerings in the background; toolsChanged fires when they land.
    void this.refreshProviderTools(provider.id).catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      vscodeLogger(this.mainChannel).appendLine(
        `IDE Agent: MCP provider "${provider.id}" failed to list offerings: ${message}`,
      );
    });
    return handle;
  }

  /** Remove a provider registered via `registerMcpProvider`. */
  unregisterMcpProvider(id: string): boolean {
    return this.providerRegistry.unregister(id);
  }

  /** Re-fetch one provider's offerings (also the `pushMcpSnapshots` path). */
  async refreshProviderTools(id: string): Promise<void> {
    await this.providerRegistry.refreshOfferings(id);
  }

  /** Ids of currently registered providers. */
  getProviderIds(): string[] {
    return this.providerRegistry.ids();
  }

  /**
   * Fan-out of Cursor's `$mcpTurnEnded` to every registered provider's
   * optional `onTurnEnded`. Wired in extension.ts (DEV-GAPS-74): the
   * ChatTabService composerEvent relay's `turnState running:false` event
   * (fired once per settled turn by ComposerDataService.runTurn) calls this
   * with `{conversationId: <tab composer's stable composerId>}`.
   */
  async notifyProvidersTurnEnded(context: McpProviderTurnEndedContext): Promise<void> {
    await this.providerRegistry.notifyTurnEnded(context);
  }

  restartServer(id: string): void {
    const mgr = this.managers.get(id);
    if (!mgr) {
      void vscode.window.showWarningMessage(`IDE Agent: unknown MCP server "${displayNameFor(id)}".`);
      return;
    }
    mgr.restart();
  }

  showOutput(id: string): void {
    const channel = this.outputChannels.get(id) ?? this.mainChannel;
    channel.show(true);
  }

  // ---- tool execution with approval gate ----------------------------------

  /**
   * Execute an MCP tool by its namespaced name (`mcp__<server>__<tool>`).
   * Runs the §B5 precheck: allow → run; deny → reject; ask → approval card
   * (reason `mcpToolsProtection`, label `MCP:<tool>`).
   *
   * `<server>` may also be a provider id registered via
   * `cursor.registerMcpProvider()` — the call is dispatched to the
   * provider's `callTool(name, args, { composerId })` through the SAME
   * approval gate as config-file servers.
   *
   * `$file:` symbolic arguments (Cursor parity, symbolicFileArgs.ts):
   * detected in args on both paths. In-process providers are first-party
   * tools, so symbolic args are refused there (binary scoping string);
   * external config-file servers go through the review boundary (describe →
   * approval card) then the executor boundary (expand → substitute).
   */
  async callTool(
    namespacedName: string,
    args: Record<string, unknown>,
    opts: { toolCallId: string; timeoutMs?: number },
  ): Promise<McpCallResult> {
    const parsed = parseToolName(namespacedName);
    if (!parsed) {
      throw new Error(`"${namespacedName}" is not an MCP tool name (expected mcp__<server>__<tool>)`);
    }
    const symbolicPaths = collectSymbolicFileArgs(args);

    // In-process provider path (cursor.registerMcpProvider).
    if (this.providerRegistry.has(parsed.server)) {
      if (symbolicPaths.length > 0) {
        // Binary scoping: "$file:" is only supported for external MCP
        // tools; providers are first-party tools.
        throw new SymbolicArgError(
          refuseSymbolicArgsForFirstPartyTool(symbolicPaths[0], parsed.server),
        );
      }
      await this.runMcpApprovalGate(parsed.server, parsed.tool, opts.toolCallId);
      const context: McpProviderCallContext = { composerId: this.getComposer().composerId };
      const raw = await this.providerRegistry.callTool(parsed.server, parsed.tool, args, context);
      return normalizeResult(raw);
    }

    const mgr = [...this.managers.values()].find((m) => m.server.displayName === parsed.server);
    if (!mgr) {
      throw new Error(`MCP server "${parsed.server}" is not configured`);
    }
    if (mgr.currentState !== "ready") {
      throw new Error(
        `MCP server "${parsed.server}" is not ready (state=${mgr.currentState}${mgr.error ? `: ${mgr.error}` : ""})`,
      );
    }

    // Review boundary (Cursor route "review", binary `dr`): describe the
    // symbolic files; the bindings flow into the approval card (our review
    // surface) and seed the executor's TOCTOU check. Throws on refusal.
    const review = await this.reviewSymbolicFileArgs(opts.toolCallId, symbolicPaths);

    await this.runMcpApprovalGate(parsed.server, parsed.tool, opts.toolCallId, review.approvalReasons);

    // Executor boundary (Cursor route "local", binary `lr` + `pr`):
    // late-bind `$file:` literals to file contents just before the tool runs.
    const expanded = await expandSymbolicFileArgs(args, {
      reader: this.symbolicFileReader,
      toolCallId: opts.toolCallId,
      metrics: sharedSymbolicArgsMetrics,
      expectedBindings: review.bindings,
      hooksInspectMcpCalls: this.hooksInspectMcpCalls(),
    });

    const raw = await mgr.callTool(parsed.tool, expanded.args, opts.timeoutMs);
    return normalizeResult(raw);
  }

  /** Whether hooks that inspect MCP calls are configured (binary hook interplay). */
  private hooksInspectMcpCalls(): boolean {
    try {
      return this.options.hooksInspectMcpCalls?.() === true;
    } catch {
      return false;
    }
  }

  /**
   * Review boundary for `$file:` symbolic MCP arguments — mirrors the
   * binary's `dr` (route "review"). Describes each symbolic file (digestOnly)
   * and returns the bindings plus approval-card reason lines (our review
   * surface for Cursor's `symbolicPathArgumentsForClassifier` /
   * `symbolicPathArgumentBindings`). Throws `SymbolicArgError` on any refusal
   * (hooks configured, unreadable file, …) — fail closed before approval.
   */
  private async reviewSymbolicFileArgs(
    toolCallId: string,
    symbolicPaths: string[],
  ): Promise<{ bindings: SymbolicFileArgBinding[]; approvalReasons: string[] }> {
    if (symbolicPaths.length === 0) {
      return { bindings: [], approvalReasons: [] };
    }
    const described = await describeSymbolicFileArgs(symbolicPaths, {
      reader: this.symbolicFileReader,
      toolCallId,
      metrics: sharedSymbolicArgsMetrics,
      hooksInspectMcpCalls: this.hooksInspectMcpCalls(),
    });
    if (described.kind === "failed") {
      throw new SymbolicArgError(described.failure);
    }
    const approvalReasons = described.bindings.map(
      (b) =>
        `$file: symbolic argument → ${b.path} (${b.sizeBytes} bytes, sha256 ${b.sha256.slice(0, 12)}…) — ` +
        `the file's contents will be substituted into the tool call before it runs.`,
    );
    return { bindings: described.bindings, approvalReasons };
  }

  /**
   * The §B5 approval gate — the choke point before ANY MCP tool executes,
   * whether from a config-file server or a registered provider.
   */
  private async runMcpApprovalGate(
    server: string,
    tool: string,
    toolCallId: string,
    /**
     * Review-boundary reason lines (Cursor's `symbolicPathArgumentsForClassifier`/
     * `symbolicPathArgumentBindings` surface). Appended to the approval card so
     * the reviewer sees which `$file:` files will be substituted.
     */
    extraReasons: string[] = [],
  ): Promise<void> {
    // §B5 precheck — the choke point before any MCP tool executes.
    // Cursor consult: [...effectiveAllowlist, ...mcpAllowedToolsForChat??[]]
    // (case-insensitive); chat grants are scoped to the current composer.
    const composerId = this.getComposer().composerId;
    let decision: McpApprovalDecision | undefined;
    let precheckReason = "";
    {
      const pre = this.allowlist.precheck(server, tool, composerId);
      decision = pre.decision;
      precheckReason = pre.reason;
    }
    if (decision === "deny") {
      throw new Error(`MCP tool blocked: ${precheckReason}`);
    }
    // §B5: MCP follows Run Modes. runEverything auto-approves.
    const runMode = vscode.workspace.getConfiguration("ide.composer").get<string>("runMode", "autoReview");
    if (runMode === "runEverything") {
      decision = "allow";
      precheckReason = "Run mode is runEverything — auto-approved";
    }
    if (decision === "ask") {
      const approval = await this.getComposer().reviews.requestApproval(
        toolCallId,
        approvalLabel(server, tool),
        [
          `mcpToolsProtection — MCP tool "${server} / ${tool}" wants to run.`,
          precheckReason,
          ...extraReasons,
        ],
        undefined,
        mcpApprovalOptions(server, tool),
      );
      if (!approval || approval.optionId === "skip") {
        throw new Error(`MCP tool skipped by user: ${server} / ${tool}`);
      }
      if (approval.optionId === "approve-once") {
        // Cursor DJ.RUN (unless allowOnce — our card has no such variant, so
        // every one-shot approval becomes a chat grant): per-composer memory
        // `mcpAllowedToolsForChat`, silencing further prompts for this chat.
        this.allowlist.rememberChatGrant(composerId, server, tool);
      } else if (approval.optionId === "approve-always") {
        // Cursor ALLOWLIST_TOOL: user-global persistent
        // `composerState.mcpAllowedTools` (no TTL). Works with no workspace
        // folder open — unlike the old file-based persistence, there is no
        // "nowhere to persist" warning path anymore.
        this.allowlist.rememberAlwaysAllow(server, tool);
      } else if (approval.optionId === "deny-always") {
        // HONEST-DIVERGENCE: Cursor has no client-side persistent-deny store
        // (no mcpDeniedTools-like key in 3.25.9) — the old
        // `.cursor/mcp-approvals.json` deny persistence was our invention and
        // is removed. Deny rejects the current call only; lasting deny is
        // via `.cursor/permissions.json` blocklists (Cursor docs).
        throw new Error(`MCP tool denied by user: ${server} / ${tool}`);
      }
    }
  }

  // ---- internals -----------------------------------------------------------

  private refreshServers(): void {
    const discovered = discoverServers({
      workspaceFolders: this.roots,
      logger: vscodeLogger(this.logChannels.filesLogger),
    });
    const wanted = new Set(discovered.map((s) => s.id));

    // Stop servers that disappeared from config.
    for (const [id, mgr] of [...this.managers]) {
      if (!wanted.has(id)) {
        const displayName = mgr.server.displayName;
        mgr.stop();
        this.managers.delete(id);
        this.logChannels.disposeServerLogger(displayName);
        this.outputChannels.delete(id);
        this.authPrompted.delete(id);
      }
    }
    // Add / update the rest.
    for (const srv of discovered) {
      if (!this.managers.has(srv.id)) {
        // Per-server `MCP: <name>` log channel (Cursor parity, mcpLogs.ts).
        const channel = this.logChannels.getServerLogger(srv.displayName);
        this.outputChannels.set(srv.id, channel);
        const mgr = new McpServerManager(srv, this.roots, vscodeLogger(channel));
        const off = mgr.onEvent((e: McpManagerEvent) => {
          if (e.kind === "toolsChanged") {
            this.emitter.emit("event", { kind: "toolsChanged" } satisfies McpServiceEvent);
          } else {
            this.emitter.emit("event", { kind: "serversChanged" } satisfies McpServiceEvent);
            if (e.kind === "stateChanged" && e.state === "failed") {
              // Cursor parity: {target:"auth",kind:"auth_required"} — offer
              // the Authenticate flow for static-cred servers (once).
              void this.maybeOfferAuthentication(srv.id).catch(() => undefined);
            }
          }
        });
        this.disposables.push({ dispose: off });
        this.managers.set(srv.id, mgr);
        // Apply a stored OAuth token (if any) before connecting, so a
        // previously authenticated server reconnects with Bearer auth.
        void this.applyStoredOAuthToken(mgr).finally(() => {
          if (this.managers.get(srv.id) === mgr) {
            mgr.start();
          }
        });
      }
    }
    this.allowlist.reload();
    this.emitter.emit("event", { kind: "serversChanged" } satisfies McpServiceEvent);
  }

  /**
   * Cursor parity (`{target:"auth",kind:"auth_required"}`): when a server
   * configured with static OAuth credentials fails with an auth-flavored
   * error, offer "Authenticate" once per session. On success the server
   * restarts with a Bearer header.
   */
  private async maybeOfferAuthentication(serverId: string): Promise<void> {
    if (this.authPrompted.has(serverId)) {
      return;
    }
    const mgr = this.managers.get(serverId);
    if (!mgr || mgr.currentState !== "failed") {
      return;
    }
    const errorText = `${mgr.error ?? ""}`.toLowerCase();
    if (!/auth|401|403|unauthorized|oauth|credential|token/.test(errorText)) {
      return;
    }
    if (!staticClientInfoFromConfig(mgr.server.config.auth) || !mgr.server.config.url) {
      return;
    }
    this.authPrompted.add(serverId);
    await this.authenticateServer(serverId);
  }

  /**
   * Run the static-credential OAuth flow for a server and restart it with
   * the fresh Bearer token. Public so the `ide.mcp.authenticate` command
   * and tests can drive it directly.
   */
  async authenticateServer(serverId: string): Promise<boolean> {
    const mgr = this.managers.get(serverId);
    const staticInfo = mgr && staticClientInfoFromConfig(mgr.server.config.auth);
    const url = mgr?.server.config.url;
    if (!mgr || !staticInfo || !url) {
      return false;
    }
    const ok = await this.oauthBroker.promptAndAuthenticate(
      mgr.server.displayName,
      url,
      staticInfo,
      [],
    );
    if (ok) {
      await this.applyStoredOAuthToken(mgr);
      this.restartServer(serverId);
    }
    return ok;
  }

  /**
   * Merge a stored OAuth access token into the in-memory server config as
   * an `Authorization: Bearer` header (refreshed proactively when a
   * refresh token exists and the access token is expiring). The mcp.json
   * file is never touched — tokens live in SecretStorage.
   *
   * HONEST-DIVERGENCE: Cursor injects the Bearer token per request via the
   * `mcp.cursorAccessToken` command; our hand-rolled httpClient reads
   * headers at construction, so we inject at client-construction time
   * (behaviorally equivalent: every request carries the token).
   */
  private async applyStoredOAuthToken(mgr: McpServerManager): Promise<void> {
    const url = mgr.server.config.url;
    const staticInfo = staticClientInfoFromConfig(mgr.server.config.auth);
    if (!url || !staticInfo) {
      return;
    }
    const store = this.oauthBroker.getTokenStore();
    const tokens = await store.getTokens(url).catch(() => undefined);
    const access = tokens?.access_token;
    if (!access) {
      return;
    }
    let token = access;
    if (tokens.expires_at_ms && tokens.expires_at_ms < Date.now() + 60_000 && tokens.refresh_token) {
      try {
        const endpoints = await discoverOAuthEndpoints(url);
        const refreshed = await refreshAccessToken(endpoints.tokenEndpoint, staticInfo, tokens.refresh_token);
        await store.saveTokens(url, refreshed);
        token = refreshed.access_token;
        this.logChannels.oauthLogger.appendLine(`[mcp] ${mgr.server.displayName}: access token refreshed`);
      } catch {
        // Fall through with the stale token; the 401 path re-prompts.
      }
    }
    mgr.server.config.headers = { ...mgr.server.config.headers, Authorization: `Bearer ${token}` };
  }

  private watchConfigFiles(): void {
    // NOTE: `**/.cursor/mcp-approvals.json` is intentionally NOT watched —
    // Cursor has no such file (0 hits in the bundles); the invented
    // persistence was removed (mcp-approval-persistence).
    const patterns = ["**/.cursor/mcp.json", "**/.cursor/permissions.json"];
    for (const pattern of patterns) {
      const watcher = vscode.workspace.createFileSystemWatcher(pattern);
      const refresh = () => this.refreshServers();
      watcher.onDidChange(refresh, null, this.disposables);
      watcher.onDidCreate(refresh, null, this.disposables);
      watcher.onDidDelete(refresh, null, this.disposables);
      this.disposables.push(watcher);
    }
  }

  private registerCommands(): void {
    this.disposables.push(
      vscode.commands.registerCommand("ide.mcp.restartServer", async () => {
        const statuses = this.getServerStatuses();
        if (statuses.length === 0) {
          void vscode.window.showInformationMessage("IDE Agent: no MCP servers configured. Add one to .cursor/mcp.json.");
          return;
        }
        const pick = await vscode.window.showQuickPick(
          statuses.map((s) => ({
            label: s.displayName,
            description: `${s.scope} · ${s.state}${s.toolCount ? ` · ${s.toolCount} tools` : ""}`,
            id: s.id,
          })),
          { placeHolder: "Restart MCP server" },
        );
        if (pick) this.restartServer(pick.id);
      }),
      vscode.commands.registerCommand("ide.mcp.showOutput", async () => {
        const statuses = this.getServerStatuses();
        const pick = await vscode.window.showQuickPick(
          [{ label: "MCP (all servers)", id: "__main" },
           ...statuses.map((s) => ({ label: s.displayName, id: s.id }))],
          { placeHolder: "Show MCP output" },
        );
        if (pick) this.showOutput(pick.id === "__main" ? "__main" : pick.id);
      }),
      vscode.commands.registerCommand("ide.mcp.refreshServers", () => {
        this.refreshServers();
        void vscode.window.showInformationMessage("IDE Agent: MCP servers reloaded.");
      }),
      // WORKER-GAPS-11J (mcp-logs-panel): show the aggregate "MCP Logs"
      // channel (Cursor's workbench.mcp.files logger, glass @20659807).
      vscode.commands.registerCommand("ide.mcp.showLogs", () => {
        this.logChannels.showLogs();
      }),
      // WORKER-GAPS-11J (mcp-oauth-flow): manually (re-)authenticate a
      // static-credential MCP server, then restart it with a Bearer header.
      vscode.commands.registerCommand("ide.mcp.authenticate", async () => {
        const candidates = this.getServerStatuses().filter((s) => {
          const mgr = this.managers.get(s.id);
          return !!mgr?.server.config.url && !!staticClientInfoFromConfig(mgr.server.config.auth);
        });
        if (candidates.length === 0) {
          void vscode.window.showInformationMessage(
            "IDE Agent: no MCP servers with static OAuth credentials (mcp.json `auth.CLIENT_ID`) are configured.",
          );
          return;
        }
        const pick = await vscode.window.showQuickPick(
          candidates.map((s) => ({ label: s.displayName, description: s.state, id: s.id })),
          { placeHolder: "Authenticate MCP server (OAuth)" },
        );
        if (pick) {
          this.authPrompted.delete(pick.id);
          await this.authenticateServer(pick.id);
        }
      }),
      // IDE-CODE (deeplink-mcp-install): Cursor parity — binary-verified
      // (extensions/cursor-deeplink/dist/main.js → workbench bundle, 3.25.6).
      // Cursor's deeplink extension validates `name` + `config` (base64 JSON)
      // from `cursor://anysphere.cursor-deeplink/mcp/install` and fires
      // `mcp.deeplinkInstall(name, config)`; core proposes the server and, on
      // user confirm, merges it into the user mcp.json. Our equivalent:
      // `ide-code://anysphere.ide-code-deeplink/mcp/install` (handled by the
      // ide-deeplink extension) → this command. The workbench-core McpService
      // registers the same command id for when core is wired; this
      // extension-host service is the live one today.
      vscode.commands.registerCommand("composer.mcp.deeplinkInstall", async (name: unknown, server: unknown) => {
        // Defense in depth: the deeplink extension already validates, but any
        // extension can execute this command.
        if (typeof name !== "string" || name.trim().length === 0 || typeof server !== "object" || server === null || Array.isArray(server)) {
          void vscode.window.showErrorMessage("IDE Agent: invalid MCP deeplink — expected a non-empty server name and a JSON object config.");
          return;
        }
        const serverName = name.trim();
        // Cursor parity: a deeplink install is a PROPOSED server — the user
        // confirms before anything is written (binary:
        // mcpInstallationService.setProposedServer → composer notification →
        // installProposedServer on confirm).
        const choice = await vscode.window.showInformationMessage(
          `Install MCP server "${serverName}"?`,
          { modal: false },
          "Add",
          "Cancel",
        );
        if (choice !== "Add") {
          return;
        }
        await this.installDeeplinkServer(serverName, server as McpServerConfig);
      }),
    );
  }

  /**
   * IDE-CODE (deeplink-mcp-install): install a deeplink-proposed MCP server.
   * Cursor parity — mirrors MCPInstallationService.installProposedServer
   * (3.25.6): merges `mcpServers[name] = server` into the USER config file
   * (`~/.cursor/mcp.json` via candidateConfigFiles), writes it back
   * (JSON.stringify 2-space), and reloads servers. Fail-closed: write
   * failures surface an error instead of silently dropping the install.
   */
  private async installDeeplinkServer(name: string, server: McpServerConfig): Promise<void> {
    const userEntry = candidateConfigFiles(this.roots).find((c) => c.scope === "user");
    if (!userEntry) {
      void vscode.window.showErrorMessage(`IDE Agent: could not locate the user MCP config file — "${name}" was not installed.`);
      return;
    }
    try {
      let existingRaw: string | undefined;
      if (fs.existsSync(userEntry.path)) {
        existingRaw = fs.readFileSync(userEntry.path, "utf8");
      } else {
        fs.mkdirSync(path.dirname(userEntry.path), { recursive: true });
      }
      fs.writeFileSync(userEntry.path, mergeServerIntoMcpConfig(existingRaw, name, server), "utf8");
    } catch (err) {
      void vscode.window.showErrorMessage(
        `IDE Agent: could not install MCP server "${name}": ${err instanceof Error ? err.message : String(err)}`,
      );
      return;
    }
    this.refreshServers();
    void vscode.window.showInformationMessage(`IDE Agent: MCP server "${name}" installed.`);
  }
}
