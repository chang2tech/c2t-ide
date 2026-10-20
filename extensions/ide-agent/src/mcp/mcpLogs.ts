/**
 * MCP log channels — Cursor parity (docs/rea/deep-mcp.md §7).
 *
 * Binary evidence (cursor-3.25.9, READ-ONLY reference):
 * - workbench.glass.main.js @20659807:
 *   `loggerService.createLogger("workbench.mcp.files",{name:"MCP Logs",hidden:!1})`
 *   plus sibling loggers named "MCP OAuth" and "MCP Allowlist".
 *   → "MCP Logs" is a VISIBLE log channel in the Output panel, not a hidden one.
 * - extensions/cursor-mcp/dist/main.js @641179:
 *   `t.window.createOutputChannel("MCP Logs",{log:!0})` (aggregate) and
 *   per-instance `t.window.createOutputChannel(\`MCP: ${r}\`,{log:!0})`
 *   when `useAggregateOutputForInstances` is false. The flag defaults to
 *   false (`!0===undefined` → false), so per-server channels are the default.
 * - deep-mcp.md §7: shared fallback channel "MCP Process" (`useSharedProcessOutput`).
 *
 * Our fork keeps the existing "IDE Agent — MCP" aggregate channel (used by
 * older code/tests) and ADDS the Cursor-verbatim channels on top.
 */
import * as vscode from "vscode";

/** Aggregate log channel name, verbatim from the Cursor binary. */
export const MCP_LOGS_CHANNEL_NAME = "MCP Logs";
/** OAuth token/refresh log channel name, verbatim from the Cursor binary. */
export const MCP_OAUTH_CHANNEL_NAME = "MCP OAuth";
/** Allowlist evaluation log channel name, verbatim from the Cursor binary. */
export const MCP_ALLOWLIST_CHANNEL_NAME = "MCP Allowlist";
/** Shared fallback channel name, verbatim from the Cursor binary. */
export const MCP_PROCESS_CHANNEL_NAME = "MCP Process";

/** Per-server channel name, verbatim from cursor-mcp (`MCP: ${identifier}`). */
export const mcpServerChannelName = (displayName: string): string => `MCP: ${displayName}`;

export interface McpLogChannelFactory {
  createLogChannel(name: string): vscode.LogOutputChannel;
}

/**
 * Lazily-created Cursor-verbatim MCP log channels.
 *
 * The factory is injectable so unit tests can capture created channels
 * without the real vscode API.
 */
export class McpLogChannels implements vscode.Disposable {
  private readonly created = new Map<string, vscode.LogOutputChannel>();
  private readonly serverChannels = new Map<string, vscode.LogOutputChannel>();
  private readonly disposables: vscode.Disposable[] = [];

  /**
   * @param factory channel factory (defaults to `vscode.window.createOutputChannel(name, {log:true})`).
   * @param useAggregateOutputForInstances mirrors cursor-mcp's flag: when
   *   true every server logs into the single "MCP Logs" channel; when false
   *   (Cursor's default) each server gets its own `MCP: <name>` channel.
   */
  constructor(
    factory?: McpLogChannelFactory,
    private readonly useAggregateOutputForInstances = false,
  ) {
    this.factory =
      factory ?? { createLogChannel: (name) => vscode.window.createOutputChannel(name, { log: true }) };
  }

  private readonly factory: McpLogChannelFactory;

  /** Aggregate "MCP Logs" channel (config discovery, file watching). */
  get filesLogger(): vscode.LogOutputChannel {
    return this.getOrCreate(MCP_LOGS_CHANNEL_NAME);
  }

  /** "MCP OAuth" channel (token operations, refresh locking). */
  get oauthLogger(): vscode.LogOutputChannel {
    return this.getOrCreate(MCP_OAUTH_CHANNEL_NAME);
  }

  /** "MCP Allowlist" channel (allowlist evaluation). */
  get allowlistLogger(): vscode.LogOutputChannel {
    return this.getOrCreate(MCP_ALLOWLIST_CHANNEL_NAME);
  }

  /** Shared "MCP Process" fallback channel. */
  get processLogger(): vscode.LogOutputChannel {
    return this.getOrCreate(MCP_PROCESS_CHANNEL_NAME);
  }

  /**
   * Per-server log channel. In aggregate mode this IS the "MCP Logs" channel
   * (cursor-mcp: `this.output = e.output`), otherwise `MCP: <displayName>`.
   */
  getServerLogger(displayName: string): vscode.LogOutputChannel {
    if (this.useAggregateOutputForInstances) {
      return this.filesLogger;
    }
    let ch = this.serverChannels.get(displayName);
    if (!ch) {
      ch = this.factory.createLogChannel(mcpServerChannelName(displayName));
      this.serverChannels.set(displayName, ch);
      this.disposables.push(ch);
    }
    return ch;
  }

  /** Dispose a per-server channel (server removed from config). */
  disposeServerLogger(displayName: string): void {
    const ch = this.serverChannels.get(displayName);
    if (ch) {
      this.serverChannels.delete(displayName);
      try {
        ch.dispose();
      } catch {
        /* ignore */
      }
    }
  }

  /** Show the aggregate "MCP Logs" channel (the "MCP Logs panel" surface). */
  showLogs(): void {
    this.filesLogger.show();
  }

  /** Show one server's `MCP: <name>` channel (cursor-mcp `onShowMcpOutput`). */
  showServer(displayName: string): void {
    this.getServerLogger(displayName).show();
  }

  dispose(): void {
    for (const d of this.disposables) {
      try {
        d.dispose();
      } catch {
        /* ignore */
      }
    }
    this.disposables.length = 0;
    this.created.clear();
    this.serverChannels.clear();
  }

  private getOrCreate(name: string): vscode.LogOutputChannel {
    let ch = this.created.get(name);
    if (!ch) {
      ch = this.factory.createLogChannel(name);
      this.created.set(name, ch);
      this.disposables.push(ch);
    }
    return ch;
  }
}
