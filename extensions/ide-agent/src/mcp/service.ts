/**
 * McpService — extension-host MCP client facade (Cursor parity §B).
 *
 * Wires together: config discovery (config.ts), server lifecycle
 * (serverManager.ts), tool namespacing (names.ts) and the approval gate
 * (allowlist.ts → HumanReviewService approval card, trigger reason
 * `mcpToolsProtection`, card label `MCP:<tool>`).
 *
 * HONEST GAPS (not implemented, not faked):
 * - OAuth flows incl. token storage (§B6)
 * - Prompts, Resources, Elicitation, MCP Apps (§B9)
 * - `vscode.cursor.mcp.registerServer()` extension API (§B5)
 * - stdio transport implemented directly as NDJSON JSON-RPC (no
 *   @modelcontextprotocol/sdk dependency — deliberate, documented in
 *   stdioClient.ts). HTTP transports (streamable_http + legacy SSE) are
 *   likewise hand-rolled on node:http/https (httpClient.ts).
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
import { EventEmitter } from "node:events";
import { ComposerDataService } from "../services/composerDataService";
import {
  ConfiguredServer,
  McpApprovalDecision,
  McpLogger,
  McpServerState,
  McpServerStatus,
  McpToolInfo,
} from "./types";
import { approvalLabel, displayNameFor, parseToolName, toolName } from "./names";
import { discoverServers } from "./config";
import { McpServerManager, McpManagerEvent } from "./serverManager";
import { McpAllowlist } from "./allowlist";
import { mcpApprovalOptions } from "./approvalOptions";
import { McpCallResult, formatResultMarkdown, normalizeResult } from "./results";

export type { McpCallResult };

export type McpServiceEvent =
  | { kind: "serversChanged" }
  | { kind: "toolsChanged" };

/** Re-exported for callers that only need the result shape. */
export { normalizeResult };

const vscodeLogger = (channel: vscode.OutputChannel): McpLogger => ({
  appendLine: (message: string) => channel.appendLine(message),
});

export class McpService implements vscode.Disposable {
  private readonly emitter = new EventEmitter();
  private readonly managers = new Map<string, McpServerManager>();
  private readonly disposables: vscode.Disposable[] = [];
  private readonly allowlist: McpAllowlist;
  private readonly outputChannels = new Map<string, vscode.OutputChannel>();
  private readonly mainChannel: vscode.OutputChannel;
  private readonly roots: string[];

  readonly onDidChange = (listener: (e: McpServiceEvent) => void): vscode.Disposable => {
    this.emitter.on("event", listener);
    return { dispose: () => this.emitter.off("event", listener) };
  };

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly getComposer: () => ComposerDataService,
  ) {
    this.roots = (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath);
    this.mainChannel = vscode.window.createOutputChannel("IDE Agent — MCP");
    this.allowlist = new McpAllowlist(this.roots, vscodeLogger(this.mainChannel));
  }

  /** Discover config, start watchers, connect servers. */
  start(): void {
    this.refreshServers();
    this.watchConfigFiles();
    this.registerCommands();
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

  /** All tools across ready servers, with Cursor's `mcp__<server>__<tool>` names. */
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
    return out;
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
    const mgr = [...this.managers.values()].find((m) => m.server.displayName === parsed.server);
    if (!mgr) {
      throw new Error(`MCP server "${parsed.server}" is not configured`);
    }
    if (mgr.currentState !== "ready") {
      throw new Error(
        `MCP server "${parsed.server}" is not ready (state=${mgr.currentState}${mgr.error ? `: ${mgr.error}` : ""})`,
      );
    }

    // §B5 precheck — the choke point before any MCP tool executes.
    let decision: McpApprovalDecision | undefined;
    let precheckReason = "";
    {
      const pre = this.allowlist.precheck(parsed.server, parsed.tool);
      decision = pre.decision;
      precheckReason = pre.reason;
    }
    if (decision === "deny") {
      throw new Error(`MCP tool blocked: ${precheckReason}`);
    }
    // §B5: MCP follows Run Modes. runEverything auto-approves (explicit
    // "deny" in mcp-approvals.json still wins — deny > ask > allow).
    const runMode = vscode.workspace.getConfiguration("ide.composer").get<string>("runMode", "autoReview");
    if (runMode === "runEverything") {
      decision = "allow";
      precheckReason = "Run mode is runEverything — auto-approved";
    }
    if (decision === "ask") {
      const approval = await this.getComposer().reviews.requestApproval(
        opts.toolCallId,
        approvalLabel(parsed.server, parsed.tool),
        [
          `mcpToolsProtection — MCP tool "${parsed.server} / ${parsed.tool}" wants to run.`,
          precheckReason,
        ],
        undefined,
        mcpApprovalOptions(parsed.server, parsed.tool),
      );
      if (!approval || approval.optionId === "skip") {
        throw new Error(`MCP tool skipped by user: ${parsed.server} / ${parsed.tool}`);
      }
      if (approval.optionId === "approve-once") {
        // nothing to remember
      } else if (approval.optionId === "approve-always") {
        // Persist per server+tool so future turns run silently (§B5).
        // P2-5: with no workspace folder open there is nowhere to persist —
        // say so out loud instead of silently dropping the choice.
        if (this.roots[0]) {
          this.allowlist.persistApproval(this.roots[0], parsed.server, parsed.tool, "allow");
          this.allowlist.reload();
        } else {
          void vscode.window.showWarningMessage(
            `IDE Agent: could not remember "Always allow" for ${parsed.server} / ${parsed.tool} — no workspace folder is open. The choice applies to this session only.`,
          );
        }
      } else if (approval.optionId === "deny-always") {
        if (this.roots[0]) {
          this.allowlist.persistApproval(this.roots[0], parsed.server, parsed.tool, "deny");
          this.allowlist.reload();
        } else {
          void vscode.window.showWarningMessage(
            `IDE Agent: could not remember "Deny" for ${parsed.server} / ${parsed.tool} — no workspace folder is open. The choice applies to this session only.`,
          );
        }
        throw new Error(`MCP tool denied by user: ${parsed.server} / ${parsed.tool}`);
      }
    }

    const raw = await mgr.callTool(parsed.tool, args, opts.timeoutMs);
    return normalizeResult(raw);
  }

  // ---- internals -----------------------------------------------------------

  private refreshServers(): void {
    const discovered = discoverServers({
      workspaceFolders: this.roots,
      logger: vscodeLogger(this.mainChannel),
    });
    const wanted = new Set(discovered.map((s) => s.id));

    // Stop servers that disappeared from config.
    for (const [id, mgr] of [...this.managers]) {
      if (!wanted.has(id)) {
        mgr.stop();
        this.managers.delete(id);
        this.outputChannels.get(id)?.dispose();
        this.outputChannels.delete(id);
      }
    }
    // Add / update the rest.
    for (const srv of discovered) {
      if (!this.managers.has(srv.id)) {
        const channel = vscode.window.createOutputChannel(`IDE Agent — MCP: ${srv.displayName}`);
        this.outputChannels.set(srv.id, channel);
        const mgr = new McpServerManager(srv, this.roots, vscodeLogger(channel));
        const off = mgr.onEvent((e: McpManagerEvent) => {
          if (e.kind === "toolsChanged") {
            this.emitter.emit("event", { kind: "toolsChanged" } satisfies McpServiceEvent);
          } else {
            this.emitter.emit("event", { kind: "serversChanged" } satisfies McpServiceEvent);
          }
        });
        this.disposables.push({ dispose: off });
        this.managers.set(srv.id, mgr);
        mgr.start();
      }
    }
    this.allowlist.reload();
    this.emitter.emit("event", { kind: "serversChanged" } satisfies McpServiceEvent);
  }

  private watchConfigFiles(): void {
    const patterns = ["**/.cursor/mcp.json", "**/.cursor/permissions.json", "**/.cursor/mcp-approvals.json"];
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
    );
  }
}
