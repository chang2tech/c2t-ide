/**
 * McpProviderRegistry — the `cursor.registerMcpProvider()` contract.
 *
 * BINARY EVIDENCE (Cursor 3.25.9, all offsets verified 2026-10-20):
 *
 * 1. `.../resources/app/extensions/cursor-browser-automation/dist/extension.js`
 *    - Registration call site (offset 221465):
 *        `const n = o.cursor.registerMcpProvider($t); t.subscriptions.push(n)`
 *      The return value is pushed into `vscode.ExtensionContext.subscriptions`
 *      → `registerMcpProvider()` returns a `vscode.Disposable` whose dispose
 *      unregisters the provider.
 *    - The provider object `$t` is an instance of class `_t` (offset ~193940):
 *        `this.id = "cursor-ide-browser"`
 *        `this.featureGateName = void 0`
 *        `this.instructions = 'The cursor-ide-browser MCP server provides ...'`
 *    - `async initialize(t)` — called by the EXTENSION itself with
 *      `t.globalStorageUri.fsPath` BEFORE registering (offset 221465:
 *      `await e.initialize(t.globalStorageUri.fsPath)` precedes the
 *      `registerMcpProvider` call). The host never calls `initialize`.
 *    - `async listOfferings()` → `{ tools: [...this.tools], prompts: [], resources: [] }`
 *      (offset 211527). Each tool carries `{ name, description, parameters,
 *      outputSchema? }`; the snapshot controller maps `parameters` → inputSchema.
 *    - `async callTool(t, e, n)` (offset 211527): `t` = tool name, `e` = args,
 *      `n` = call context; the provider reads `n?.composerId` as `ownerAgentId`.
 *    - `async onTurnEnded(t)` (offset 213171): `t` carries `conversationId`.
 *    - Snapshot push (offset ~188808): `o.cursor.pushMcpSnapshots(snapshots)`.
 *
 * 2. `.../resources/app/out/vs/workbench/api/node/extensionHostProcess.js`
 *    - ExtHost implementation (offset 4372393):
 *        `registerMcpProvider(n) {`
 *        `  return this._mcpProviders.set(n.id, n),`
 *        `    this._proxy.$registerMcpProvider(n.id, n.featureGateName, n.instructions, n.name),`
 *        `    this._onDidRegisterMcpProvider.fire(n),`
 *        `    de(() => { this._mcpProviders.delete(n.id),`
 *        `               this._proxy.$unregisterMcpProvider(n.id) }) }`
 *      → last registration wins on duplicate id; dispose removes + notifies.
 *    - `async $mcpListOfferings(n)` (offset 4377765):
 *        `const a = this._mcpProviders.get(n);`
 *        `if (!a) throw new Error(\`MCP provider with id '${n}' not found\`);`
 *        `return a.listOfferings()`
 *    - `async $mcpCallTool(n, a, r, s)` (offset 4377914): same lookup, then
 *      `o.callTool(a, r, s)` — (toolName, args, context).
 *    - `async $mcpTurnEnded(n, a)` (offset 4378064):
 *      `await this._mcpProviders.get(n)?.onTurnEnded?.(a)` — optional.
 *
 * ARCHITECTURAL NOTE (honest delta, not hidden):
 * In Cursor's app the `cursor` namespace is attached to the `vscode` module by
 * workbench-core's extension host, and providers are bridged workbench-side
 * (`$registerMcpProvider` → `mcpProviderService`). In this fork the whole agent
 * runtime and MCP stack live in the `ide-agent` extension itself, so the same
 * contract is implemented extension-locally: `registerMcpProvider()` is
 * exposed on this extension's exports (`ide-code.ide-agent`) as `cursor`, and
 * provider tools join `McpService.getTools()` with Cursor's
 * `mcp__<server>__<tool>` namespacing, flowing through the identical approval
 * gate (`mcpToolsProtection`, card label `MCP:<tool>`). No workbench RPC bridge
 * is needed because there is no separate agent-host process here.
 */
import { EventEmitter } from "node:events";

/** One tool as a provider offers it (pre-namespacing). */
export interface McpProviderToolOffering {
  name: string;
  description: string;
  /** JSON Schema for the tool input (mapped to McpToolInfo.inputSchema). */
  parameters: unknown;
  outputSchema?: unknown;
}

/** What `listOfferings()` returns. Cursor's browser provider returns
 * `{ tools: [...], prompts: [], resources: [] }`. */
export interface McpProviderOfferings {
  tools: McpProviderToolOffering[];
  prompts: unknown[];
  resources: unknown[];
}

/** Third argument of `callTool(name, args, context)`. Cursor's browser
 * provider reads `context.composerId` as the tool call's `ownerAgentId`. */
export interface McpProviderCallContext {
  composerId?: string;
}

/** Argument of `onTurnEnded(context)`. Cursor's browser provider reads
 * `context.conversationId`. */
export interface McpProviderTurnEndedContext {
  conversationId: string;
}

/**
 * The provider contract for `cursor.registerMcpProvider(provider)`.
 * Field-for-field from the Cursor 3.25.9 binary (see header evidence).
 *
 * `initialize` is invoked by the registering extension itself (with its
 * global-storage path), never by the host — mirroring Cursor, this registry
 * does not call it.
 */
export interface McpProvider {
  /** Unique server id, e.g. `"cursor-ide-browser"`. Becomes the `<server>`
   * segment of `mcp__<server>__<tool>`. */
  id: string;
  name?: string;
  featureGateName?: string;
  /** Server instructions surfaced to the agent alongside the tools. */
  instructions: string;
  initialize?(globalStoragePath: string): Promise<void> | void;
  listOfferings(): Promise<McpProviderOfferings> | McpProviderOfferings;
  callTool(
    name: string,
    args: Record<string, unknown>,
    context: McpProviderCallContext,
  ): Promise<unknown>;
  onTurnEnded?(context: McpProviderTurnEndedContext): Promise<void> | void;
}

/** A tool snapshot as pushed via `cursor.pushMcpSnapshots(snapshots)`. */
export interface McpProviderSnapshot {
  serverIdentifier: string;
  serverName: string;
  snapshotEpoch: number;
  snapshotRevision: number;
  status: string;
  tools: Array<{ name: string; description: string; inputSchema?: unknown; outputSchema?: unknown }>;
  resources: unknown[];
  prompts: unknown[];
  instructions: string;
}

/** One registered provider plus its last-fetched tool offerings. */
export interface McpProviderRegistration {
  provider: McpProvider;
  tools: McpProviderToolOffering[];
}

export type McpProviderRegistryEvent = { kind: "providersChanged" } | { kind: "toolsChanged" };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function assertValidProvider(provider: McpProvider): void {
  if (!isRecord(provider)) {
    throw new Error("cursor.registerMcpProvider: provider must be an object");
  }
  if (typeof provider.id !== "string" || provider.id.length === 0) {
    throw new Error("cursor.registerMcpProvider: provider.id must be a non-empty string");
  }
  if (typeof provider.instructions !== "string") {
    throw new Error(
      `cursor.registerMcpProvider: provider "${provider.id}" must define instructions: string`,
    );
  }
  if (typeof provider.listOfferings !== "function") {
    throw new Error(
      `cursor.registerMcpProvider: provider "${provider.id}" must define listOfferings()`,
    );
  }
  if (typeof provider.callTool !== "function") {
    throw new Error(
      `cursor.registerMcpProvider: provider "${provider.id}" must define callTool(name, args, context)`,
    );
  }
}

function normalizeOfferings(raw: unknown, providerId: string): McpProviderToolOffering[] {
  if (!isRecord(raw) || !Array.isArray(raw.tools)) {
    throw new Error(
      `cursor.registerMcpProvider: provider "${providerId}" listOfferings() must resolve to { tools, prompts, resources }`,
    );
  }
  const tools: McpProviderToolOffering[] = [];
  for (const t of raw.tools) {
    if (!isRecord(t) || typeof t.name !== "string" || t.name.length === 0) {
      throw new Error(
        `cursor.registerMcpProvider: provider "${providerId}" offered a tool without a valid name`,
      );
    }
    tools.push({
      name: t.name,
      description: typeof t.description === "string" ? t.description : "",
      parameters: t.parameters ?? { type: "object", properties: {} },
      outputSchema: t.outputSchema,
    });
  }
  return tools;
}

/**
 * Registry of providers added via `cursor.registerMcpProvider()`.
 * Deliberately free of the `vscode` runtime module so it stays unit-testable
 * under plain node (the Disposable shape is structural).
 */
export class McpProviderRegistry {
  private readonly emitter = new EventEmitter();
  private readonly providers = new Map<string, McpProviderRegistration>();

  onDidChange(listener: (e: McpProviderRegistryEvent) => void): { dispose(): void } {
    this.emitter.on("event", listener);
    return { dispose: () => this.emitter.off("event", listener) };
  }

  private emit(e: McpProviderRegistryEvent): void {
    this.emitter.emit("event", e);
  }

  /**
   * Register a provider. Mirrors Cursor's extHost: last registration wins on
   * duplicate id. Returns a disposable that unregisters (Cursor pushes it into
   * `ExtensionContext.subscriptions`).
   *
   * NOTE: like Cursor, this does NOT call `provider.initialize()` — the
   * registering extension calls that itself with its global-storage path.
   * Tool offerings are fetched via `refreshOfferings(id)` (called by
   * McpService right after registering).
   */
  register(provider: McpProvider): { dispose(): void } {
    assertValidProvider(provider);
    this.providers.set(provider.id, { provider, tools: [] });
    this.emit({ kind: "providersChanged" });
    let disposed = false;
    return {
      dispose: () => {
        if (disposed) return;
        disposed = true;
        this.unregister(provider.id);
      },
    };
  }

  /** Remove a provider. Returns true when one was registered. */
  unregister(id: string): boolean {
    const removed = this.providers.delete(id);
    if (removed) {
      this.emit({ kind: "providersChanged" });
      this.emit({ kind: "toolsChanged" });
    }
    return removed;
  }

  has(id: string): boolean {
    return this.providers.has(id);
  }

  get(id: string): McpProvider | undefined {
    return this.providers.get(id)?.provider;
  }

  ids(): string[] {
    return [...this.providers.keys()];
  }

  /** Re-fetch a provider's offerings and cache the tool list. */
  async refreshOfferings(id: string): Promise<void> {
    const reg = this.providers.get(id);
    if (!reg) {
      return;
    }
    const raw = await reg.provider.listOfferings();
    // The provider may have been unregistered while listing.
    if (this.providers.get(id) !== reg) {
      return;
    }
    reg.tools = normalizeOfferings(raw, id);
    this.emit({ kind: "toolsChanged" });
  }

  /** Every offered tool across providers, pre-namespacing. */
  getTools(): Array<{ provider: McpProvider; tool: McpProviderToolOffering }> {
    const out: Array<{ provider: McpProvider; tool: McpProviderToolOffering }> = [];
    for (const { provider, tools } of this.providers.values()) {
      for (const tool of tools) {
        out.push({ provider, tool });
      }
    }
    return out;
  }

  /**
   * Dispatch a tool call to its provider. Error strings are Cursor-verbatim
   * (extensionHostProcess.js `$mcpListOfferings` / `$mcpCallTool`).
   */
  async callTool(
    providerId: string,
    toolName: string,
    args: Record<string, unknown>,
    context: McpProviderCallContext,
  ): Promise<unknown> {
    const reg = this.providers.get(providerId);
    if (!reg) {
      throw new Error(`MCP provider with id '${providerId}' not found`);
    }
    if (!reg.tools.some((t) => t.name === toolName)) {
      throw new Error(`Tool "${toolName}" was not found on "${providerId}".`);
    }
    return reg.provider.callTool(toolName, args, context);
  }

  /** Fan-out of Cursor's `$mcpTurnEnded` (optional per provider). One failing
   * provider must not break the others. */
  async notifyTurnEnded(context: McpProviderTurnEndedContext): Promise<void> {
    for (const { provider } of this.providers.values()) {
      try {
        await provider.onTurnEnded?.(context);
      } catch {
        /* per-provider failure is isolated */
      }
    }
  }

  clear(): void {
    if (this.providers.size === 0) {
      return;
    }
    this.providers.clear();
    this.emitter.removeAllListeners();
  }
}
