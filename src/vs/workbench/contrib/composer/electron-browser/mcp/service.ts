/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// IDE-CODE: Migrated from extensions/ide-agent/src/mcp/service.ts (CAT-B, vscode→DI)
//
// vscode API → core mapping used here (per docs/rea/ext-api-audit-2026-10-19.md §3):
//   window.createOutputChannel                 → IOutputService (channel registry; the
//                                               `ide-agent-mcp*` channels are resolved via
//                                               getChannel with a console fallback until a
//                                               composer contribution registers them)
//   workspace.getConfiguration("ide.composer").get("runMode")
//                                            → IConfigurationService.getValue("ide.composer.runMode")
//   workspace.workspaceFolders               → IWorkspaceContextService.getWorkspace().folders
//   workspace.createFileSystemWatcher       → IFileService.watch + onDidFilesChange (glob-filtered)
//   window.show*Message                      → INotificationService
//   window.showQuickPick                     → IQuickInputService.pick
//   commands.registerCommand("ide.mcp.*")   → CommandsRegistry.registerCommand("composer.mcp.*")
//   node:events EventEmitter                 → Emitter (vs/base/common/event)
//   vscode.Disposable                        → Disposable (vs/base/common/lifecycle)
//   vscode.ExtensionContext (ctor)          → DROPPED (stored but never used in the original)
//
// The composer is supplied by a factory callback (same pattern as the migrated
// chatTabService/slashCommandService) to avoid a hard workbench-layer cycle.

/**
 * McpService — workbench MCP client facade.
 * (was: "Cursor parity §B" — §B is OUR internal spec, not a Cursor source;
 *  no REA evidence for the §B numbering. What IS verified: REA shows Cursor
 *  keeps MCP in workbench core (vs/workbench/contrib/mcp/) plus a
 *  cursor-mcp extension — docs/rea/cursor-agent-layers-2026-10-19.md §1.
 *  The mcp__<server>__<tool> naming below is OUR convention, UNKNOWN whether
 *  Cursor uses it.)
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
 *   stdioClient.ts). HTTP transports (streamableHttp + legacy SSE) are
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
import { Disposable, toDisposable } from "../../../../../base/common/lifecycle.js";
import { Emitter, Event } from "../../../../../base/common/event.js";
import { extUri } from "../../../../../base/common/resources.js";
import { URI } from "../../../../../base/common/uri.js";
import { VSBuffer } from "../../../../../base/common/buffer.js";
import Severity from "../../../../../base/common/severity.js";
import { match as globMatch } from "../../../../../base/common/glob.js";
import { IConfigurationService } from "../../../../../platform/configuration/common/configuration.js";
import { INotificationService } from "../../../../../platform/notification/common/notification.js";
import { IQuickInputService } from "../../../../../platform/quickinput/common/quickInput.js";
import { IFileService } from "../../../../../platform/files/common/files.js";
import { IWorkspaceContextService } from "../../../../../platform/workspace/common/workspace.js";
import { IStorageService } from "../../../../../platform/storage/common/storage.js";
import { IOutputService } from "../../../../../workbench/services/output/common/output.js";
import { CommandsRegistry } from "../../../../../platform/commands/common/commands.js";
import type { ComposerDataService } from "../composerDataService.js";
import {
  McpApprovalDecision,
  McpLogger,
  McpServerConfig,
  McpServerStatus,
  McpToolInfo,
} from "../../common/mcp/types.js";
import { approvalLabel, displayNameFor, parseToolName, toolName } from "../../common/mcp/names.js";
import { candidateConfigFiles, discoverServers, mergeServerIntoMcpConfig } from "./config.js";
import { McpServerManager, McpManagerEvent } from "./serverManager.js";
import { McpAllowlist } from "./allowlist.js";
import { WorkbenchMcpGrantStore } from "./grantStore.js";
import { mcpApprovalOptions } from "../../common/mcp/approvalOptions.js";
import { normalizeResult } from "../../common/mcp/results.js";

import {
	IMcpService,
	McpServiceEvent,
	IMcpOutputChannel,
	McpCallResult,
} from "../../common/mcp/service.js";

/**
 * Resolve an MCP output channel through IOutputService. Falls back to a
 * console-backed channel until the `ide-agent-mcp*` channels are registered
 * by the composer workbench contribution (OutputChannelRegistry).
 */
function toMcpOutputChannel(outputService: IOutputService, channelId: string, label: string): IMcpOutputChannel {
	const core = outputService.getChannel(channelId);
	if (core) {
		return {
			appendLine: (message: string) => core.append(message + '\n'),
			show: (preserveFocus?: boolean) => { void outputService.showChannel(channelId, preserveFocus); },
			// Registry-owned channels are not disposed by consumers.
			dispose: () => { },
		};
	}
	// TODO(composer): register the `ide-agent-mcp*` output channels in the composer
	// workbench contribution via OutputChannelRegistry (Extensions.OutputChannels)
	// so they show in the Output panel. Until then, log to the console — the
	// appendLine behavior is preserved either way.
	return {
		appendLine: (message: string) => console.log(`[${label}] ${message}`),
		show: () => { },
		dispose: () => { },
	};
}

const channelLogger = (channel: IMcpOutputChannel): McpLogger => ({
	appendLine: (message: string) => channel.appendLine(message),
});

export class McpService extends Disposable implements IMcpService {

  declare readonly _serviceBrand: undefined;

  private readonly emitter = new Emitter<McpServiceEvent>();
  readonly onDidChange: Event<McpServiceEvent> = this.emitter.event;
  private readonly managers = new Map<string, McpServerManager>();
  private readonly allowlist: McpAllowlist;
  private readonly outputChannels = new Map<string, IMcpOutputChannel>();
  private readonly mainChannel: IMcpOutputChannel;
  private readonly roots: string[];
  private started = false;

  constructor(
    @IWorkspaceContextService private readonly workspaceContextService: IWorkspaceContextService,
    @IConfigurationService private readonly configurationService: IConfigurationService,
    @IOutputService private readonly outputService: IOutputService,
    @INotificationService private readonly notificationService: INotificationService,
    @IQuickInputService private readonly quickInputService: IQuickInputService,
    @IFileService private readonly fileService: IFileService,
    @IStorageService storageService: IStorageService,
    /**
     * IDE-CODE: the ExtensionContext param of the original is DROPPED — it was
     * stored but never used. The composer is supplied by this factory callback
     * (same pattern as the migrated chatTabService/slashCommandService).
     */
    private readonly getComposer: () => ComposerDataService,
  ) {
    super();
    this.roots = this.workspaceContextService.getWorkspace().folders.map((f) => f.uri.fsPath);
    this.mainChannel = toMcpOutputChannel(this.outputService, 'ide-agent-mcp', 'IDE Agent — MCP');
    // Cursor 3.25.9 parity (mcp-approval-persistence): "Always allow" grants
    // live in user-global `composerState.mcpAllowedTools` (IStorageService,
    // APPLICATION scope); one-shot RUN grants live in per-composer memory.
    // No .cursor/mcp-approvals.json (0 hits in Cursor's bundles).
    this.allowlist = new McpAllowlist(
      this.roots,
      channelLogger(this.mainChannel),
      new WorkbenchMcpGrantStore(storageService),
    );
    this._register(this.emitter);
  }

  /** Discover config, start watchers, connect servers. */
  start(): void {
    if (this.started) {
      return;
    }
    this.started = true;
    this.refreshServers();
    this.watchConfigFiles();
    this.registerCommands();
  }

  override dispose(): void {
    for (const m of this.managers.values()) {
      try {
        m.stop();
      } catch {
        /* ignore */
      }
    }
    this.managers.clear();
    super.dispose();
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

  /** All tools across ready servers, with `mcp__<server>__<tool>` names.
   *  (OUR namespacing convention — UNKNOWN whether Cursor uses it.) */
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
      void this.notificationService.warn(`IDE Agent: unknown MCP server "${displayNameFor(id)}".`);
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
    // Cursor consult: [...effectiveAllowlist, ...mcpAllowedToolsForChat??[]].
    // NOTE (HONEST): this core service is deliberately NOT registered yet
    // (composer.contribution.ts — the per-tab composer hasn't landed), so
    // there is no per-composer id to scope chat grants to. Chat-grant writes
    // are skipped here; they live on the extension live path
    // (extensions/ide-agent/src/mcp/service.ts) until the core composer
    // exposes a stable per-chat identity.
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
    // §B5: MCP follows Run Modes. runEverything auto-approves.
    const runMode = this.configurationService.getValue<string>("ide.composer.runMode") ?? "autoReview";
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
        // Chat-scoped grant skipped: no per-composer id on this (currently
        // unregistered) core path — see NOTE above. The extension live path
        // implements the binary's DJ.RUN → mcpAllowedToolsForChat write.
      } else if (approval.optionId === "approve-always") {
        // Cursor ALLOWLIST_TOOL: user-global persistent
        // `composerState.mcpAllowedTools` (no TTL). Works with no workspace
        // folder open — no "nowhere to persist" warning path anymore.
        this.allowlist.rememberAlwaysAllow(parsed.server, parsed.tool);
      } else if (approval.optionId === "deny-always") {
        // HONEST-DIVERGENCE: Cursor has no client-side persistent-deny store
        // (no mcpDeniedTools-like key in 3.25.9) — the old
        // `.cursor/mcp-approvals.json` deny persistence was our invention and
        // is removed. Deny rejects the current call only.
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
      logger: channelLogger(this.mainChannel),
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
        const channel = toMcpOutputChannel(this.outputService, `ide-agent-mcp-${srv.id}`, `IDE Agent — MCP: ${srv.displayName}`);
        this.outputChannels.set(srv.id, channel);
        const mgr = new McpServerManager(srv, this.roots, channelLogger(channel));
        this._register(toDisposable(mgr.onEvent((e: McpManagerEvent) => {
          this.emitter.fire(e.kind === "toolsChanged" ? { kind: "toolsChanged" } : { kind: "serversChanged" });
        })));
        this.managers.set(srv.id, mgr);
        mgr.start();
      }
    }
    this.allowlist.reload();
    this.emitter.fire({ kind: "serversChanged" });
  }

  private watchConfigFiles(): void {
    // NOTE: `**/.cursor/mcp-approvals.json` is intentionally NOT watched —
    // Cursor has no such file (0 hits in the bundles); the invented
    // persistence was removed (mcp-approval-persistence).
    const patterns = ["**/.cursor/mcp.json", "**/.cursor/permissions.json"];
    // IFileService.createWatcher is non-recursive only — config files are
    // watched per workspace folder through watch() + the shared
    // onDidFilesChange event, filtered to the config globs.
    for (const folder of this.workspaceContextService.getWorkspace().folders) {
      this._register(this.fileService.watch(folder.uri, {
        recursive: true,
        excludes: ['**/node_modules/**', '**/.git/**', '**/dist/**', '**/out/**'],
      }));
    }
    this._register(this.fileService.onDidFilesChange((e) => {
      const hit = [...e.rawAdded, ...e.rawUpdated, ...e.rawDeleted].some((resource) => {
        const folder = this.workspaceContextService.getWorkspaceFolder(resource);
        if (!folder) {
          return false;
        }
        const rel = extUri.relativePath(folder.uri, resource);
        return !!rel && patterns.some((p) => globMatch(p, rel));
      });
      if (hit) {
        this.refreshServers();
      }
    }));
  }

  private registerCommands(): void {
    // Extension-owned `ide.mcp.*` ids are renamed to the `composer.*` layer
    // (same convention as the migrated terminalService/slashCommandService);
    // a future composer contribution registers their menu/keybinding entries.
    this._register(CommandsRegistry.registerCommand("composer.mcp.restartServer", async () => {
        const statuses = this.getServerStatuses();
        if (statuses.length === 0) {
          this.notificationService.info("IDE Agent: no MCP servers configured. Add one to .cursor/mcp.json.");
          return;
        }
        const pick = await this.quickInputService.pick(
          statuses.map((s) => ({
            label: s.displayName,
            description: `${s.scope} · ${s.state}${s.toolCount ? ` · ${s.toolCount} tools` : ""}`,
            id: s.id,
          })),
          { placeHolder: "Restart MCP server" },
        );
        if (pick) { this.restartServer(pick.id); }
      }));
    this._register(CommandsRegistry.registerCommand("composer.mcp.showOutput", async () => {
        const statuses = this.getServerStatuses();
        const pick = await this.quickInputService.pick(
          [{ label: "MCP (all servers)", id: "__main" },
           ...statuses.map((s) => ({ label: s.displayName, id: s.id }))],
          { placeHolder: "Show MCP output" },
        );
        if (pick) { this.showOutput(pick.id); }
      }));
    this._register(CommandsRegistry.registerCommand("composer.mcp.refreshServers", () => {
        this.refreshServers();
        this.notificationService.info("IDE Agent: MCP servers reloaded.");
      }));
    // IDE-CODE (deeplink-mcp-install): Cursor parity — binary-verified
    // (extensions/cursor-deeplink/dist/main.js → workbench bundle, 3.25.6).
    // Cursor's deeplink extension validates `name` + `config` (base64 JSON)
    // from `cursor://anysphere.cursor-deeplink/mcp/install` and fires
    // `mcp.deeplinkInstall(name, config)`; core proposes the server and, on
    // user confirm, merges it into the user mcp.json. Our equivalent:
    // `ide-code://anysphere.ide-code-deeplink/mcp/install` (handled by the
    // ide-deeplink extension) → this command.
    this._register(CommandsRegistry.registerCommand("composer.mcp.deeplinkInstall", async (_accessor: unknown, name: unknown, server: unknown) => {
        // Defense in depth: the deeplink extension already validates, but any
        // extension can execute this command.
        if (typeof name !== "string" || name.trim().length === 0 || typeof server !== "object" || server === null || Array.isArray(server)) {
          this.notificationService.error("IDE Agent: invalid MCP deeplink — expected a non-empty server name and a JSON object config.");
          return;
        }
        const serverName = name.trim();
        // Cursor parity: a deeplink install is a PROPOSED server — the user
        // confirms via a notification before anything is written (binary:
        // mcpInstallationService.setProposedServer → composer notification →
        // installProposedServer on confirm).
        this.notificationService.prompt(
          Severity.Info,
          `Install MCP server "${serverName}"?`,
          [
            {
              label: "Add",
              run: () => {
                void this.installDeeplinkServer(serverName, server as McpServerConfig);
              },
            },
            {
              label: "Cancel",
              run: () => {
                /* dismissed */
              },
            },
          ],
          { sticky: true },
        );
      }));
  }

  /**
   * IDE-CODE (deeplink-mcp-install): install a deeplink-proposed MCP server.
   * Cursor parity — mirrors MCPInstallationService.installProposedServer
   * (3.25.6): merges `mcpServers[name] = server` into the USER config file
   * (`~/.cursor/mcp.json` via candidateConfigFiles), writes it back
   * (JSON.stringify 2-space), and reloads servers. Fail-closed: parse/write
   * failures surface an error notification instead of silently dropping the
   * install.
   */
  private async installDeeplinkServer(name: string, server: McpServerConfig): Promise<void> {
    const userEntry = candidateConfigFiles(this.roots).find((c) => c.scope === "user");
    if (!userEntry) {
      this.notificationService.error(`IDE Agent: could not locate the user MCP config file — "${name}" was not installed.`);
      return;
    }
    const uri = URI.file(userEntry.path);
    try {
      let existingRaw: string | undefined;
      if (await this.fileService.exists(uri)) {
        existingRaw = (await this.fileService.readFile(uri)).value.toString();
      } else {
        const dir = extUri.dirname(uri);
        if (!(await this.fileService.exists(dir))) {
          await this.fileService.createFolder(dir);
        }
      }
      const merged = mergeServerIntoMcpConfig(existingRaw, name, server);
      await this.fileService.writeFile(uri, VSBuffer.fromString(merged));
    } catch (err) {
      this.notificationService.error(
        `IDE Agent: could not install MCP server "${name}": ${err instanceof Error ? err.message : String(err)}`,
      );
      return;
    }
    this.refreshServers();
    this.notificationService.info(`IDE Agent: MCP server "${name}" installed.`);
  }
}
