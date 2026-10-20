/**
 * DEV-GAPS-9C tests (node:test, no vscode dependency).
 *
 * Guards the approval-review-kinds parity (docs/rea/audit-fix-queue.md run 25,
 * feature `approval-review-kinds`, matrix #867; option enums from run 23):
 *   src/vs/workbench/contrib/composer/common/humanReviewService.ts
 *
 * Parses the core service source (no vscode runtime needed) and asserts:
 *  - the five HumanReviewOption enums with VERBATIM keys/values;
 *  - the per-bubble review-model API: ToolCallReviewModel shape
 *    {status,selectedOption,isShowingInput,highlightedOption,firstTimeReviewMode},
 *    getTerminalReviewModelForBubble(handle, bubbleId), setSelectedOption,
 *    and the RUN_TERMINAL_COMMAND_V2 -> auto-select RUN rule;
 *  - the binary-parity ToolCallHumanReviewService alias.
 *
 * Behavioral coverage (per-bubble isolation, auto-select executed against the
 * real compiled service) was verified ad-hoc with node --test; see the
 * DEV-GAPS-9C report. Run after `tsc`:
 *   node --test out/services/test/run-approval-review-kinds-tests.js
 */
import { describe, it } from "node:test";
import * as assert from "node:assert";
import * as fs from "node:fs";
import * as path from "node:path";

const servicePath =
  process.env.HUMAN_REVIEW_SERVICE_PATH ??
  path.join(
    __dirname,
    "..",
    "..",
    "..",
    "..",
    "..",
    "src",
    "vs",
    "workbench",
    "contrib",
    "composer",
    "common",
    "humanReviewService.ts",
  );
const src = fs.readFileSync(servicePath, "utf8");

/** Assert a `export const X = { ... } as const;` block contains the verbatim entries. */
function assertEnumVerbatim(name: string, entries: Array<[string, string]>): void {
  const start = src.indexOf(`export const ${name} = {`);
  assert.ok(start >= 0, `missing export const ${name}`);
  const end = src.indexOf("} as const;", start);
  assert.ok(end > start, `malformed ${name} block`);
  const body = src.slice(start, end);
  for (const [key, value] of entries) {
    assert.ok(
      body.includes(`${key}: '${value}'`),
      `${name}: missing verbatim entry ${key}: '${value}'`,
    );
  }
}

describe("approval-review-kinds: verbatim HumanReviewOption enums", () => {
  it("TerminalReviewOption", () => {
    assertEnumVerbatim("TerminalReviewOption", [
      ["RUN", "run"],
      ["SKIP", "skip"],
      ["ALLOWLIST_COMMANDS", "allowlistCommands"],
      ["REJECT_AND_TELL_WHAT_TO_DO_DIFFERENTLY", "rejectAndTellWhatToDoDifferently"],
    ]);
  });
  it("McpReviewOption", () => {
    assertEnumVerbatim("McpReviewOption", [
      ["RUN", "run"],
      ["SKIP", "skip"],
      ["REJECT_AND_TELL_WHAT_TO_DO_DIFFERENTLY", "rejectAndTellWhatToDoDifferently"],
      ["ALLOWLIST_TOOL", "allowlistTool"],
    ]);
  });
  it("EditReviewOption", () => {
    assertEnumVerbatim("EditReviewOption", [
      ["ACCEPT", "accept"],
      ["REJECT_AND_TELL_WHAT_TO_DO_DIFFERENTLY", "rejectAndTellWhatToDoDifferently"],
      ["SKIP", "skip"],
      ["SWITCH_TO_DEFAULT_AGENT_MODE", "switchToDefaultAgentMode"],
      ["ACCEPT_AND_ALLOW_FOLDER", "acceptAndAllowFolder"],
    ]);
  });
  it("PlanReviewOption", () => {
    assertEnumVerbatim("PlanReviewOption", [
      ["NONE", "none"],
      ["APPROVE", "approve"],
      ["REJECT_AND_TELL_WHAT_TO_DO_DIFFERENTLY", "rejectAndTellWhatToDoDifferently"],
      ["EDIT", "edit"],
    ]);
  });
  it("WebFetchReviewOption", () => {
    assertEnumVerbatim("WebFetchReviewOption", [
      ["RUN", "run"],
      ["SKIP", "skip"],
      ["ALLOWLIST_DOMAIN", "allowlistDomain"],
    ]);
  });
  it("RUN_TERMINAL_COMMAND_V2 tool-name constant", () => {
    assert.ok(
      src.includes("export const RUN_TERMINAL_COMMAND_V2 = 'RUN_TERMINAL_COMMAND_V2'"),
      "missing verbatim RUN_TERMINAL_COMMAND_V2 constant",
    );
  });
});

describe("approval-review-kinds: per-bubble review model API", () => {
  it("ToolCallReviewModel has the verbatim shape keys", () => {
    const start = src.indexOf("export class ToolCallReviewModel");
    assert.ok(start >= 0, "missing ToolCallReviewModel");
    const body = src.slice(start, src.indexOf("\n}\n", start));
    for (const key of [
      "status",
      "selectedOption",
      "isShowingInput",
      "highlightedOption",
      "firstTimeReviewMode",
    ]) {
      assert.ok(
        new RegExp(`\\b${key}\\b`).test(body),
        `ToolCallReviewModel missing shape key ${key}`,
      );
    }
    assert.ok(body.includes("setSelectedOption("), "missing setSelectedOption API");
  });

  it("per-bubble getters exist (terminal/edit/mcp + generic)", () => {
    for (const m of [
      "getTerminalReviewModelForBubble(handle: string, bubbleId: string",
      "getEditReviewModelForBubble(handle: string, bubbleId: string",
      "getMcpReviewModelForBubble(handle: string, bubbleId: string",
      "getReviewModelForBubble(kind: HumanReviewKind, handle: string, bubbleId: string",
      "setSelectedOptionForBubble(handle: string, bubbleId: string",
    ]) {
      assert.ok(src.includes(m), `missing API: ${m}`);
    }
  });

  it("RUN_TERMINAL_COMMAND_V2 auto-selects RUN (terminal only)", () => {
    assert.ok(
      src.includes("toolName === RUN_TERMINAL_COMMAND_V2"),
      "missing RUN_TERMINAL_COMMAND_V2 auto-select branch",
    );
    assert.ok(
      src.includes("model.setSelectedOption(TerminalReviewOption.RUN)"),
      "auto-select must set TerminalReviewOption.RUN",
    );
  });

  it("models are keyed per (handle, bubbleId) — isolation", () => {
    assert.ok(
      src.includes("`${handle}:${bubbleId}`") || src.includes("reviewModelKey(handle, bubbleId)"),
      "missing per-(handle,bubbleId) model key",
    );
  });

  it("binary-parity ToolCallHumanReviewService alias exists", () => {
    assert.ok(
      src.includes("export const ToolCallHumanReviewService = HumanReviewService"),
      "missing ToolCallHumanReviewService alias",
    );
  });
});
