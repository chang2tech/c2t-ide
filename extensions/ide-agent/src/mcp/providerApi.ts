/**
 * The `cursor` extension API namespace (Cursor parity).
 *
 * In Cursor's app this namespace is attached to the `vscode` module by
 * workbench-core's extension host (proposed API `cursor`), so extensions call
 * `require("vscode").cursor.registerMcpProvider(provider)`. Each extension in
 * stock VS Code gets its own `vscode` API object, so an extension cannot
 * attach to it for others — instead this extension exposes the identical
 * contract on its own exports (`ide-code.ide-agent` → `exports.cursor`).
 * Same function name, same parameter shape, same Disposable return; see
 * `providerRegistry.ts` for the binary evidence.
 */
import type * as vscode from "vscode";
import type { McpService } from "./service";
import type { McpProvider, McpProviderSnapshot } from "./providerRegistry";

/** The `cursor` namespace surface this extension publishes. */
export interface CursorApi {
  /**
   * Register an in-process MCP provider (Cursor 3.25.9:
   * `cursor.registerMcpProvider(provider) → vscode.Disposable`).
   * The provider's tools surface to the agent as
   * `mcp__<provider.id>__<tool>` and execute through the standard MCP
   * approval gate. Disposing the returned Disposable unregisters.
   */
  registerMcpProvider(provider: McpProvider): vscode.Disposable;
  /**
   * Push tool-list snapshots (`cursor.pushMcpSnapshots(snapshots)`).
   * Refreshes the offerings of every snapshotted provider that is currently
   * registered, so the agent's tool list follows provider changes — the
   * mechanism behind Cursor's `BrowserSnapshotPushController`.
   */
  pushMcpSnapshots(snapshots: McpProviderSnapshot[]): Promise<void>;
}

/** Build the `cursor` namespace bound to a live McpService. */
export function createCursorApi(service: McpService): CursorApi {
  return {
    registerMcpProvider(provider: McpProvider): vscode.Disposable {
      return service.registerMcpProvider(provider);
    },
    async pushMcpSnapshots(snapshots: McpProviderSnapshot[]): Promise<void> {
      const ids = new Set<string>();
      for (const s of snapshots ?? []) {
        if (s && typeof s.serverIdentifier === "string") {
          ids.add(s.serverIdentifier);
        }
      }
      await Promise.all(
        [...ids].map((id) => service.refreshProviderTools(id).catch(() => undefined)),
      );
    },
  };
}
