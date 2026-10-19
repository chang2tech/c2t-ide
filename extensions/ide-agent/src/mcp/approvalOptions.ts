/**
 * MCP-specific approval options (parity §B5): allow once / always allow /
 * deny / skip. "Always" choices persist per server+tool into
 * <project>/.cursor/mcp-approvals.json so the decision survives restarts.
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
