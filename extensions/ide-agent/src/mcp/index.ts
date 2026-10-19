/**
 * MCP module public surface.
 *
 * Entry point: `activateMcp(context, composer)` — call once from the
 * extension's `activate()`. It creates the McpService, starts server
 * discovery/lifecycle, and registers the `ide.mcp.*` commands.
 */
import * as vscode from "vscode";
import { ComposerDataService } from "../services/composerDataService";
import { McpService } from "./service";

export { McpService } from "./service";
export type { McpCallResult, McpServiceEvent } from "./service";
export { normalizeResult, formatResultMarkdown } from "./results";
export { mcpApprovalOptions } from "./approvalOptions";
export { McpHttpClient, McpTransportError, McpAuthError, McpRetryableError, parseSseEvents } from "./httpClient";
export type {
  ConfiguredServer,
  McpLogger,
  McpServerScope,
  McpServerState,
  McpServerStatus,
  McpToolInfo,
  McpPrecheckResult,
  McpApprovalDecision,
} from "./types";
export { toolName, parseToolName, approvalLabel, serverId, displayNameFor } from "./names";
export { discoverServers, expandVariables, expandServerConfig, parseEnvFile } from "./config";
export { McpAllowlist, matchAllowlistPattern } from "./allowlist";

/**
 * Activate MCP support. Safe to call once; returns the service (also pushed
 * to `context.subscriptions` for disposal on deactivate).
 */
export function activateMcp(
  context: vscode.ExtensionContext,
  getComposer: () => ComposerDataService,
): McpService {
  const service = new McpService(context, getComposer);
  context.subscriptions.push(service);
  service.start();
  return service;
}
