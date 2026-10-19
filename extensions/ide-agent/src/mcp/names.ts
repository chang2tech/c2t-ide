/**
 * MCP tool namespacing — parity §B4, adopted VERBATIM from Cursor.
 *
 * Agent-facing tool name: `mcp__<server>__<tool>`.
 * Parser splits on `__`: part[1] = server, parts[2..] = tool name
 * (tool names may themselves contain `__`).
 */

export const MCP_TOOL_PREFIX = "mcp__";

/**
 * Build the agent-facing tool name. Server and tool names are used verbatim
 * (no sanitization — Cursor does the same; collisions are the user's config
 * problem and are surfaced in the server list).
 */
export function toolName(server: string, tool: string): string {
  return `${MCP_TOOL_PREFIX}${server}__${tool}`;
}

export interface ParsedMcpToolName {
  server: string;
  tool: string;
}

/**
 * Parse `mcp__<server>__<tool>`. Returns undefined when the name is not an
 * MCP tool name (missing prefix or fewer than 3 `__`-separated parts).
 */
export function parseToolName(namespaced: string): ParsedMcpToolName | undefined {
  if (!namespaced.startsWith(MCP_TOOL_PREFIX)) {
    return undefined;
  }
  const parts = namespaced.split("__");
  // ["mcp", "<server>", "<tool>", ...] — need at least 3 parts.
  if (parts.length < 3 || !parts[1]) {
    return undefined;
  }
  return { server: parts[1], tool: parts.slice(2).join("__") };
}

/** Approval-card label for an MCP tool: `MCP:<tool>` (parity §B4). */
export function approvalLabel(server: string, tool: string): string {
  return `MCP:${tool}`;
}

/** Scope-qualified server identifier: `user-<name>` / `project-<name>` / `vscode-<name>` (§B7). */
export function serverId(scope: "project" | "user" | "vscode", name: string): string {
  return `${scope}-${name}`;
}

/** Strip the scope prefix for display (§B7 `stripIdentifierPrefix`). */
export function displayNameFor(id: string): string {
  return id.replace(/^(project|user|vscode)-/, "");
}
