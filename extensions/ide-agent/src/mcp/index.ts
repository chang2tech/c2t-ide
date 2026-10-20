/**
 * MCP module public surface.
 *
 * Entry point: `activateMcp(context, composer)` — call once from the
 * extension's `activate()`. It creates the McpService, starts server
 * discovery/lifecycle, and registers the `ide.mcp.*` commands.
 */
import * as vscode from "vscode";
import { ComposerDataService } from "../services/composerDataService";
import { McpService, type McpServiceOptions } from "./service";

export { McpService } from "./service";
export type { McpCallResult, McpServiceEvent, McpServiceOptions } from "./service";
export {
  SYMBOLIC_FILE_ARG_PREFIX,
  MAX_SYMBOLIC_FILE_ARGS_PER_CALL,
  MAX_SYMBOLIC_FILE_ARGS_TOTAL_BYTES,
  DEFAULT_MAX_SYMBOLIC_FILE_ARG_BYTES,
  SymbolicArgError,
  InMemorySymbolicArgsMetrics,
  sharedSymbolicArgsMetrics,
  noopSymbolicArgsMetrics,
  detectSymbolicFileArg,
  collectSymbolicFileArgs,
  substituteSymbolicFileArgs,
  symbolicArgFailure,
  toSymbolicArgFailure,
  refuseSymbolicArgsForHooks,
  refuseSymbolicArgsForFirstPartyTool,
  nodeFsSymbolicFileReader,
  describeSymbolicFileArgs,
  expandSymbolicFileArgs,
} from "./symbolicFileArgs";
export type {
  SymbolicArgsRoute,
  SymbolicFileArgBinding,
  SymbolicArgFailureKind,
  SymbolicArgFailure,
  SymbolicFileRead,
  SymbolicFileReader,
  SymbolicArgsMetrics,
  DescribeSymbolicArgsOptions,
  DescribeSymbolicArgsResult,
  ExpandSymbolicArgsOptions,
  ExpandedSymbolicArgs,
} from "./symbolicFileArgs";
export { normalizeResult, formatResultMarkdown } from "./results";
export { mcpApprovalOptions } from "./approvalOptions";
export { McpHttpClient, McpTransportError, McpAuthError, McpRetryableError, parseSseEvents } from "./httpClient";
export { McpServerManager, DEFAULT_MCP_RECONNECT_POLICY } from "./serverManager";
export type {
  ConfiguredServer,
  McpLogger,
  McpReconnectPolicy,
  McpServerScope,
  McpServerState,
  McpServerStatus,
  McpToolInfo,
  McpPrecheckResult,
  McpApprovalDecision,
  McpGrantStore,
} from "./types";
export { toolName, parseToolName, approvalLabel, serverId, displayNameFor } from "./names";
export { discoverServers, expandVariables, expandServerConfig, parseEnvFile } from "./config";
export { McpAllowlist, matchAllowlistPattern, normalizeGrantEntry } from "./allowlist";
export {
  ExtensionMcpGrantStore,
  InMemoryMcpGrantStore,
  MCP_ALLOWED_TOOLS_GLOBAL_KEY,
} from "./grantStore";
export {
  McpProviderRegistry,
} from "./providerRegistry";
export type {
  McpProvider,
  McpProviderCallContext,
  McpProviderOfferings,
  McpProviderRegistration,
  McpProviderRegistryEvent,
  McpProviderSnapshot,
  McpProviderToolOffering,
  McpProviderTurnEndedContext,
} from "./providerRegistry";
export { createCursorApi } from "./providerApi";
export type { CursorApi } from "./providerApi";
export {
  MCP_LOGS_CHANNEL_NAME,
  MCP_OAUTH_CHANNEL_NAME,
  MCP_ALLOWLIST_CHANNEL_NAME,
  MCP_PROCESS_CHANNEL_NAME,
  McpLogChannels,
  mcpServerChannelName,
} from "./mcpLogs";
export {
  McpOAuthTokenStore,
  canonicalizeServerUrl,
  resolveClientInformation,
  staticClientInfoFromConfig,
} from "./oauthStaticCreds";
export type {
  McpServerAuthConfig,
  ResolvedClientInfo,
  StaticClientInfo,
  StoredClientInfo,
  McpOAuthTokens,
} from "./oauthStaticCreds";
export {
  McpOAuthBroker,
  McpOAuthDiscoveryError,
  McpOAuthFlowCancelledError,
  McpOAuthLoopbackUnavailableError,
  discoverOAuthEndpoints,
  refreshAccessToken,
  runAuthorizationCodeFlow,
} from "./oauthFlow";
export { activateIntegrations } from "../integrations";
export type { IntegrationAuthState, IntegrationProviderId } from "../integrations";

/**
 * Activate MCP support. Safe to call once; returns the service (also pushed
 * to `context.subscriptions` for disposal on deactivate).
 */
export function activateMcp(
  context: vscode.ExtensionContext,
  getComposer: () => ComposerDataService,
  opts?: McpServiceOptions,
): McpService {
  const service = new McpService(context, getComposer, opts);
  context.subscriptions.push(service);
  service.start();
  // DEV-GAPS-80 (W80B): Integrations are NO longer activated here — they
  // are wired directly in extension.ts activate() via the
  // activateIntegrations entry point. Calling it here as well would
  // register ide.integrations.* twice. The re-export above is kept for
  // consumers importing activateIntegrations from "./mcp".
  return service;
}
