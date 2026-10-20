/**
 * plan-copy tests (node:test, vscode stubbed via ./vscode-stub).
 *
 * DEV-GAPS-77 (W77D) — `agent-chat-copy-plan-markdown` (Cursor 3.25.9 parity):
 * the binary's plan-tab copy handler (`Et`, workbench.glass.main.js
 * @32802481, wired as `onCopyAsMarkdown` in PlanTabContent) is, verbatim:
 *   ae.writeText(Le.serializedMarkdown)
 *     .then(() => de.notify({severity:ii.Info,
 *       message:"Copied plan markdown to clipboard", id:lm.copyPlanMarkdown}))
 *     .catch(mn => ee.error("[PlanTabContent] Failed to copy plan as markdown:", mn))
 * with the copy-action map entry `copyPlanMarkdown:"glass.copy-plan-markdown"`
 * @25574265-25574289.
 *
 * These tests pin the three VERBATIM pieces — the copied markdown source
 * (the pending plan's serialized markdown), the success toast text and the
 * failure log tag — plus the resolver truth table and the empty/failed
 * branches.
 *
 * Run after `tsc`:  node --test out/services/test/run-plan-copy-tests.js
 */
import { describe, it } from "node:test";
import * as assert from "node:assert";
import "./vscode-stub";
import {
  COPY_PLAN_MARKDOWN_COMMAND_ID,
  COPY_PLAN_MARKDOWN_FAILED_LOG_TAG,
  COPY_PLAN_MARKDOWN_TITLE,
  copyPendingPlanMarkdownToClipboard,
  PLAN_MARKDOWN_COPIED_MESSAGE,
  resolvePlanMarkdownToCopy,
  type CopyPlanMarkdownResult,
  type PlanCopySeam,
  type PlanMarkdownHolder,
} from "../planCopyService";

class StubSeam implements PlanCopySeam {
  readonly clipboard: string[] = [];
  readonly messages: string[] = [];
  readonly errors: Array<{ tag: string; err: unknown }> = [];
  failClipboard: Error | undefined;

  async writeClipboardText(text: string): Promise<void> {
    if (this.failClipboard) {
      throw this.failClipboard;
    }
    this.clipboard.push(text);
  }

  showInformationMessage(message: string): void {
    this.messages.push(message);
  }

  logError(tag: string, err: unknown): void {
    this.errors.push({ tag, err });
  }
}

function holderWithPlan(text: string | null | undefined): PlanMarkdownHolder {
  return { getPendingPlan: () => (text === undefined ? undefined : { text }) };
}

describe("plan-copy — DEV-GAPS-77 (Cursor 3.25.9 glass.copy-plan-markdown parity)", () => {
  it("verbatim constants match the binary (toast / log tag / command id / title)", () => {
    assert.equal(PLAN_MARKDOWN_COPIED_MESSAGE, "Copied plan markdown to clipboard");
    assert.equal(
      COPY_PLAN_MARKDOWN_FAILED_LOG_TAG,
      "[PlanTabContent] Failed to copy plan as markdown:",
    );
    assert.equal(COPY_PLAN_MARKDOWN_COMMAND_ID, "ide.copyPlanMarkdown");
    assert.equal(COPY_PLAN_MARKDOWN_TITLE, "Copy plan markdown");
  });

  it("resolvePlanMarkdownToCopy: trims and returns non-empty markdown", () => {
    assert.equal(resolvePlanMarkdownToCopy({ text: "  ## Plan\n\n1. x\n  " }), "## Plan\n\n1. x");
    assert.equal(resolvePlanMarkdownToCopy({ text: "# t" }), "# t");
  });

  it("resolvePlanMarkdownToCopy: empty/blank/null/undefined -> undefined", () => {
    assert.equal(resolvePlanMarkdownToCopy(null), undefined);
    assert.equal(resolvePlanMarkdownToCopy(undefined), undefined);
    assert.equal(resolvePlanMarkdownToCopy({ text: "" }), undefined);
    assert.equal(resolvePlanMarkdownToCopy({ text: "   \n  " }), undefined);
    assert.equal(resolvePlanMarkdownToCopy({}), undefined);
    assert.equal(resolvePlanMarkdownToCopy({ text: null }), undefined);
  });

  it("copies the pending plan markdown and shows the verbatim toast", async () => {
    const markdown = "## Plan\n\n1. Do **this**\n2. Then `that`\n";
    const seam = new StubSeam();

    const result: CopyPlanMarkdownResult = await copyPendingPlanMarkdownToClipboard(
      holderWithPlan(markdown),
      seam,
    );

    assert.equal(result, "copied");
    assert.deepEqual(seam.clipboard, [markdown.trim()]);
    assert.deepEqual(seam.messages, ["Copied plan markdown to clipboard"]);
    assert.deepEqual(seam.errors, []);
  });

  it("no pending plan -> 'empty', silent no-op (binary handler only exists while a plan is loaded)", async () => {
    const seam = new StubSeam();

    for (const holder of [holderWithPlan(null), holderWithPlan(""), holderWithPlan("   ")]) {
      const result = await copyPendingPlanMarkdownToClipboard(holder, seam);
      assert.equal(result, "empty");
    }
    assert.deepEqual(seam.clipboard, []);
    assert.deepEqual(seam.messages, []);
    assert.deepEqual(seam.errors, []);
  });

  it("clipboard failure -> 'failed' with the verbatim log tag (binary .catch branch)", async () => {
    const seam = new StubSeam();
    const boom = new Error("denied");
    seam.failClipboard = boom;

    const result = await copyPendingPlanMarkdownToClipboard(holderWithPlan("# plan"), seam);

    assert.equal(result, "failed");
    assert.deepEqual(seam.clipboard, []);
    assert.deepEqual(seam.messages, []);
    assert.equal(seam.errors.length, 1);
    assert.equal(seam.errors[0].tag, "[PlanTabContent] Failed to copy plan as markdown:");
    assert.equal(seam.errors[0].err, boom);
  });

  it("toast fires only after the clipboard write resolves (binary .then order)", async () => {
    const order: string[] = [];
    const seam = new StubSeam();
    seam.writeClipboardText = async (text: string) => {
      order.push("write");
      seam.clipboard.push(text);
    };
    const origNotify = seam.showInformationMessage.bind(seam);
    seam.showInformationMessage = (message: string) => {
      order.push("notify");
      origNotify(message);
    };

    await copyPendingPlanMarkdownToClipboard(holderWithPlan("# p"), seam);

    assert.deepEqual(order, ["write", "notify"]);
  });
});
