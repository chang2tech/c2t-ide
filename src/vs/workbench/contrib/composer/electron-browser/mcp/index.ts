// IDE-CODE: Migrated from extensions/ide-agent/src/mcp/index.ts (CAT-A, pure logic).
/**
 * MCP module public surface.
 *
 * The service itself is constructed through the workbench DI container
 * (IMcpService / McpService); there is no extension-host `activate()`
 * entry point in core.
 */

// IDE-CODE: mcp/service.ts is migrated in this folder — imported from ./service.
export { McpService } from "./service.js";
// IDE-CODE: mcp/service.ts is migrated in this folder — imported from ./service.
export type { McpCallResult, McpServiceEvent } from "../../common/mcp/service.js";
export { normalizeResult, formatResultMarkdown } from "../../common/mcp/results.js";
export { mcpApprovalOptions } from "../../common/mcp/approvalOptions.js";
export { McpHttpClient, McpTransportError, McpAuthError, McpRetryableError, parseSseEvents } from "./httpClient.js";
export type {
  ConfiguredServer,
  McpLogger,
  McpServerScope,
  McpServerState,
  McpServerStatus,
  McpToolInfo,
  McpPrecheckResult,
  McpApprovalDecision,
  McpGrantStore,
} from "../../common/mcp/types.js";
export { toolName, parseToolName, approvalLabel, serverId, displayNameFor } from "../../common/mcp/names.js";
export { discoverServers, expandVariables, expandServerConfig, parseEnvFile } from "./config.js";
export { McpAllowlist, matchAllowlistPattern, normalizeGrantEntry } from "./allowlist.js";
export {
	WorkbenchMcpGrantStore,
	InMemoryMcpGrantStore,
	MCP_ALLOWED_TOOLS_GLOBAL_KEY,
} from "./grantStore.js";
