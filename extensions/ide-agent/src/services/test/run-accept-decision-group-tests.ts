/**
 * FEATURE-1 (`agent-accept-pending-decisions`) unit tests (node:test, vscode
 * stubbed via ./vscode-stub).
 *
 * Covers `HumanReviewService.getPendingUserDecisionGroup()` — the
 * binary-verbatim port of the tool-former grouping in
 * workbench.glass.main.js 3.25.9 @27763492:
 *  - empty pending -> []
 *  - terminal decisions (RUN_TERMINAL_COMMAND_V2 analog) come first
 *  - otherwise the leading run of similar tools (most-recent-first)
 *  - accept() on a decision resolves that approval as approve-once
 *
 * Run after `tsc`:  node out/services/test/run-accept-decision-group-tests.js
 */
import { describe, it } from "node:test";
import * as assert from "node:assert";
import "./vscode-stub";
import { HumanReviewService } from "../humanReviewService";

function pendingService(): HumanReviewService {
  const svc = new HumanReviewService();
  // Never auto-timeout during the test.
  return svc;
}

function request(svc: HumanReviewService, toolCallId: string, clientSideTool: string): void {
  // Fire-and-forget: the promise stays pending until the test resolves it.
  void svc.requestApproval(toolCallId, `title-${toolCallId}`, [], 60 * 60 * 1000, undefined, undefined, clientSideTool);
}

describe("getPendingUserDecisionGroup (Cursor 3.25.9 @27763492 parity)", () => {
  it("returns [] when nothing is pending", () => {
    const svc = pendingService();
    assert.deepStrictEqual(svc.getPendingUserDecisionGroup(), []);
  });

  it("prioritizes terminal decisions over other tools (binary RUN_TERMINAL_COMMAND_V2 filter)", () => {
    const svc = pendingService();
    request(svc, "tc-edit-1", "edit");
    request(svc, "tc-bash-1", "bash");
    request(svc, "tc-edit-2", "edit");
    const group = svc.getPendingUserDecisionGroup();
    // Only the terminal decision is returned, even though edits were raised too.
    assert.strictEqual(group.length, 1);
    assert.strictEqual(group[0].toolCallId, "tc-bash-1");
    assert.strictEqual(group[0].clientSideTool, "bash");
  });

  it("returns the leading run of similar tools, most-recent-first", () => {
    const svc = pendingService();
    request(svc, "tc-edit-1", "edit");   // oldest
    request(svc, "tc-edit-2", "edit");
    request(svc, "tc-read-1", "read");  // different tool breaks the run
    request(svc, "tc-edit-3", "edit");  // most recent
    const group = svc.getPendingUserDecisionGroup();
    // Reversed (most-recent-first): tc-edit-3, then tc-read-1 breaks the run.
    assert.deepStrictEqual(
      group.map((d) => d.toolCallId),
      ["tc-edit-3"],
    );
  });

  it("groups consecutive similar tools (same tool kind)", () => {
    const svc = pendingService();
    request(svc, "tc-edit-1", "edit");
    request(svc, "tc-edit-2", "edit");
    request(svc, "tc-edit-3", "edit");
    const group = svc.getPendingUserDecisionGroup();
    assert.deepStrictEqual(
      group.map((d) => d.toolCallId),
      ["tc-edit-3", "tc-edit-2", "tc-edit-1"],
    );
  });

  it("decision.accept() resolves the approval as approve-once (unconditional accept loop)", async () => {
    const svc = pendingService();
    const p1 = svc.requestApproval("tc-edit-1", "title-1", [], 60 * 60 * 1000, undefined, undefined, "edit");
    const p2 = svc.requestApproval("tc-edit-2", "title-2", [], 60 * 60 * 1000, undefined, undefined, "edit");
    const group = svc.getPendingUserDecisionGroup();
    assert.strictEqual(group.length, 2);
    // Binary: for (const o of s) o.accept() — unconditional, every item.
    for (const decision of group) {
      decision.accept();
    }
    assert.deepStrictEqual(await p1, { optionId: "approve-once" });
    assert.deepStrictEqual(await p2, { optionId: "approve-once" });
    assert.strictEqual(svc.pendingCount(), 0);
  });

  it("falls back to the title when clientSideTool is absent", () => {
    const svc = pendingService();
    void svc.requestApproval("tc-x-1", "some-title", [], 60 * 60 * 1000);
    const group = svc.getPendingUserDecisionGroup();
    assert.strictEqual(group.length, 1);
    assert.strictEqual(group[0].clientSideTool, "some-title");
  });
});
