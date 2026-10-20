/**
 * MCP-specific approval options (Cursor 3.25.9 parity, WORKER-GAPS-30D).
 *
 * Storage (audit item `mcp-approval-persistence`, binary-verified):
 * "Always allow" → user-global `composerState.mcpAllowedTools`; one-shot
 * approve → per-composer `mcpAllowedToolsForChat`; there is no
 * `<project>/.cursor/mcp-approvals.json` in Cursor (0 hits in the bundles).
 */
import type { ApprovalOption } from "../services/humanReviewService";

/** Option set shown on MCP tool approval cards. */
export function mcpApprovalOptions(server: string, tool: string): ApprovalOption[] {
  return [
    { id: "approve-once", label: "Approve once" },
    { id: "approve-always", label: `Always allow ${tool}` },
    { id: "deny-always", label: `Deny ${tool}` },
    { id: "skip", label: "Skip" },
  ];
}
