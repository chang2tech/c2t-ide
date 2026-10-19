/**
 * MCP approval integration — parity §B5.
 *
 * Agent loop calls `mcpAllowlistPrecheck` before executing an MCP tool.
 * Sources (per workspace folder):
 *   .cursor/permissions.json      { "mcpAllowlist": ["server:tool", "server:*", "*:tool", "*:*"] }
 *   .cursor/mcp-approvals.json    { "approvals": { "<server>:<tool>": "allow"|"deny"|"ask" } }
 * Merge: deny > ask > allow. A "deny" auto-rejects (no card); "allow" runs
 * silently; "ask" (or no rule) goes through the HumanReviewService approval
 * card with trigger reason `mcpToolsProtection`.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { McpApprovalDecision, McpLogger, McpPrecheckResult } from "./types";

interface PermissionsFile {
  mcpAllowlist?: string[];
}

interface ApprovalsFile {
  approvals?: Record<string, string>;
}

function readJson<T>(filePath: string, logger: McpLogger): T | undefined {
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, "utf8");
  } catch {
    return undefined;
  }
  try {
    return JSON.parse(raw) as T;
  } catch (err) {
    logger.appendLine(
      `[mcp] ${filePath}: invalid JSON (${err instanceof Error ? err.message : String(err)}) — ignoring`,
    );
    return undefined;
  }
}

/**
 * Match an allowlist pattern against server/tool.
 * Patterns: `server:tool`, `server:*`, `*:tool`, `*:*`.
 * Matching is case-sensitive on the server and tool names as configured.
 */
export function matchAllowlistPattern(pattern: string, server: string, tool: string): boolean {
  const colon = pattern.indexOf(":");
  if (colon < 0) return false;
  const pServer = pattern.slice(0, colon).trim();
  const pTool = pattern.slice(colon + 1).trim();
  const serverOk = pServer === "*" || pServer === server;
  const toolOk = pTool === "*" || pTool === tool;
  return serverOk && toolOk;
}

function normalizeDecision(raw: string | undefined): McpApprovalDecision | undefined {
  if (raw === "allow" || raw === "deny" || raw === "ask") return raw;
  return undefined;
}

export class McpAllowlist {
  private permissions = new Map<string, string[]>(); // root -> patterns
  private approvals = new Map<string, Record<string, string>>(); // root -> map

  constructor(
    private readonly workspaceFolders: string[],
    private readonly logger: McpLogger,
  ) {
    this.reload();
  }

  /** Re-read both files from every workspace folder. */
  reload(): void {
    this.permissions.clear();
    this.approvals.clear();
    for (const root of this.workspaceFolders) {
      const perms = readJson<PermissionsFile>(path.join(root, ".cursor", "permissions.json"), this.logger);
      if (Array.isArray(perms?.mcpAllowlist)) {
        this.permissions.set(root, perms.mcpAllowlist.filter((p) => typeof p === "string"));
      }
      const appr = readJson<ApprovalsFile>(path.join(root, ".cursor", "mcp-approvals.json"), this.logger);
      if (appr?.approvals && typeof appr.approvals === "object") {
        this.approvals.set(root, appr.approvals);
      }
    }
  }

  /**
   * The precheck the agent loop must call before executing an MCP tool.
   * Merge order across sources: deny > ask > allow; mcp-approvals.json beats
   * permissions.json at equal severity.
   *
   * Two-pass merge (P1-3): a "deny" recorded in ANY folder must win over an
   * "allow" in another — the old first-folder-wins loop let an allow in
   * folder A silently bypass a deny in folder B.
   */
  precheck(serverDisplayName: string, tool: string): McpPrecheckResult {
    const key = `${serverDisplayName}:${tool}`;
    // Pass 1: any deny wins.
    for (const [, map] of this.approvals) {
      if (normalizeDecision(map[key]) === "deny") {
        return {
          decision: "deny",
          reason: `Denied by .cursor/mcp-approvals.json (${key})`,
          matchedRule: `${key}=deny`,
        };
      }
    }
    // Pass 2: any ask.
    for (const [, map] of this.approvals) {
      if (normalizeDecision(map[key]) === "ask") {
        return {
          decision: "ask",
          reason: `mcpToolsProtection — .cursor/mcp-approvals.json requires approval (${key})`,
          matchedRule: `${key}=ask`,
        };
      }
    }
    // Pass 3: any allow.
    for (const [, map] of this.approvals) {
      if (normalizeDecision(map[key]) === "allow") {
        return {
          decision: "allow",
          reason: `Allowed by .cursor/mcp-approvals.json (${key})`,
          matchedRule: `${key}=allow`,
        };
      }
    }
    // Pass 4: allowlist patterns (allow only).
    for (const [, patterns] of this.permissions) {
      const hit = patterns.find((p) => matchAllowlistPattern(p, serverDisplayName, tool));
      if (hit) {
        return {
          decision: "allow",
          reason: `Allowlisted by .cursor/permissions.json pattern "${hit}"`,
          matchedRule: hit,
        };
      }
    }
    // 5. Default: ask.
    return {
      decision: "ask",
      reason: `mcpToolsProtection — "${serverDisplayName}" / ${tool} is not allowlisted`,
    };
  }

  /**
   * Persist a per-tool decision ("allow" | "deny") into
   * <root>/.cursor/mcp-approvals.json, merging with any existing content.
   * Used by the approval card's "Always allow" / "Deny" options so the
   * choice is remembered per server+tool across sessions (§B5).
   */
  persistApproval(
    root: string | undefined,
    serverDisplayName: string,
    tool: string,
    decision: "allow" | "deny",
  ): void {
    if (!root) {
      this.logger.appendLine(`[mcp] cannot persist approval for ${serverDisplayName}:${tool} — no workspace folder`);
      return;
    }
    const filePath = path.join(root, ".cursor", "mcp-approvals.json");
    let doc: ApprovalsFile = {};
    const existing = readJson<ApprovalsFile>(filePath, this.logger);
    if (existing && typeof existing === "object") doc = existing;
    if (!doc.approvals || typeof doc.approvals !== "object") doc.approvals = {};
    doc.approvals[`${serverDisplayName}:${tool}`] = decision;
    try {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, JSON.stringify(doc, null, 2) + "\n", "utf8");
      this.logger.appendLine(`[mcp] persisted approval ${serverDisplayName}:${tool}=${decision} → ${filePath}`);
    } catch (err) {
      this.logger.appendLine(
        `[mcp] failed to persist approval to ${filePath}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}
