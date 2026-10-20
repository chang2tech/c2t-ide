/**
 * GAPS-22B (review-labels-always-run-construction) tests — node:test, zero
 * extra deps.
 *
 * Pins the Cursor-verbatim construction of the shell-approval "Always Run"
 * button label. Binary evidence: workbench.glass.main.js (Cursor 3.25.9),
 * module "shell-allowlist-label-truncation.js":
 *   sEa = "Always Run '"
 *   function ycp(t){if(!t?.length)return null;const e=t[0],
 *     n=t.length===1?"'":`' + ${t.length-1}`;
 *     return{prefix:sEa,command:e,suffix:n,fullLabel:`${sEa}${e}${n}`,
 *     commandCount:t.length}}
 * Case distinction (binary-verified):
 *   - BUTTON = title-case "Always Run" (the `sEa` prefix).
 *   - RADIO items = sentence-case "Always run" / "Always ask" (binary `XvS`).
 *   - Actions menu = sentence-case "Always run" (`{kind:"actions",
 *     label:"Always run"}` under USE_ALLOWLIST/SMART_AUTO).
 *   - Selection state = "Always Run Selected" (`Fe && qe ? "Always Run
 *     Selected" : it`).
 *
 * HONEST: `ycp` performs NO truncation despite the module name — no
 * truncation rule is pinned here. Per-option `Ev` nls strings are not
 * statically resolvable and are not fabricated; the service keeps its
 * honest fallback label when no candidates are passed.
 *
 * Run after `tsc`:
 *   node --test out/services/test/run-shell-allowlist-label-tests.js
 */
import { describe, it } from "node:test";
import * as assert from "node:assert";
import "./vscode-stub";
import {
  ALWAYS_RUN_BUTTON_LABEL_PREFIX,
  ALWAYS_RUN_SELECTED_BUTTON_LABEL,
  ALLOWLIST_ACTIONS_MENU_LABEL,
  ALWAYS_RUN_RADIO_LABEL,
  ALWAYS_ASK_RADIO_LABEL,
  buildShellAllowlistLabel,
  allowlistModeRadioLabel,
} from "../shellAllowlistLabel";
import { HumanReviewService } from "../humanReviewService";

/* ------------------------------------------------------------------ */
/* buildShellAllowlistLabel — exact port of binary ycp(t)               */
/* ------------------------------------------------------------------ */

describe("buildShellAllowlistLabel", () => {
  it("returns null for empty input (binary: if (!t?.length) return null)", () => {
    assert.strictEqual(buildShellAllowlistLabel([]), null);
    assert.strictEqual(buildShellAllowlistLabel(undefined), null);
    assert.strictEqual(buildShellAllowlistLabel(null), null);
  });

  it("builds `Always Run '<cmd>'` for a single command", () => {
    const got = buildShellAllowlistLabel(["npm test"]);
    assert.ok(got);
    assert.strictEqual(got.prefix, "Always Run '");
    assert.strictEqual(got.command, "npm test");
    assert.strictEqual(got.suffix, "'");
    assert.strictEqual(got.fullLabel, "Always Run 'npm test'");
    assert.strictEqual(got.commandCount, 1);
  });

  it("builds `Always Run '<first>' + N` for multiple commands", () => {
    const two = buildShellAllowlistLabel(["npm test", "npm run build"]);
    assert.ok(two);
    assert.strictEqual(two.suffix, "' + 1");
    assert.strictEqual(two.fullLabel, "Always Run 'npm test' + 1");
    assert.strictEqual(two.commandCount, 2);

    const three = buildShellAllowlistLabel(["a", "b", "c"]);
    assert.ok(three);
    assert.strictEqual(three.suffix, "' + 2");
    assert.strictEqual(three.fullLabel, "Always Run 'a' + 2");
    assert.strictEqual(three.commandCount, 3);
  });

  it("uses only the first command in the label body", () => {
    const got = buildShellAllowlistLabel(["first-cmd", "second-cmd"]);
    assert.ok(got);
    assert.strictEqual(got.command, "first-cmd");
    assert.ok(!got.fullLabel.includes("second-cmd"));
  });

  it("does not truncate the command text (binary ycp has no truncation)", () => {
    const long = "x".repeat(500);
    const got = buildShellAllowlistLabel([long]);
    assert.ok(got);
    assert.strictEqual(got.command, long);
    assert.strictEqual(got.fullLabel, `Always Run '${long}'`);
  });

  it("keeps the prefix verbatim — char-by-char", () => {
    assert.strictEqual(ALWAYS_RUN_BUTTON_LABEL_PREFIX, "Always Run '");
    assert.strictEqual(ALWAYS_RUN_BUTTON_LABEL_PREFIX.length, 12);
  });
});

/* ------------------------------------------------------------------ */
/* Case distinction: button (title-case) vs radio/menu (sentence-case)  */
/* ------------------------------------------------------------------ */

describe("case distinction", () => {
  it("button prefix is title-case 'Always Run'", () => {
    assert.ok(ALWAYS_RUN_BUTTON_LABEL_PREFIX.startsWith("Always Run"));
  });

  it("radio labels are sentence-case (binary XvS)", () => {
    assert.strictEqual(ALWAYS_RUN_RADIO_LABEL, "Always run");
    assert.strictEqual(ALWAYS_ASK_RADIO_LABEL, "Always ask");
    assert.strictEqual(allowlistModeRadioLabel("alwaysRun"), "Always run");
    assert.strictEqual(allowlistModeRadioLabel("alwaysAsk"), "Always ask");
  });

  it("unknown mode ids pass through untouched (binary default: return t)", () => {
    assert.strictEqual(allowlistModeRadioLabel("runEverything"), "runEverything");
    assert.strictEqual(allowlistModeRadioLabel(""), "");
  });

  it("actions-menu label is sentence-case 'Always run'", () => {
    assert.strictEqual(ALLOWLIST_ACTIONS_MENU_LABEL, "Always run");
  });

  it("selection-state button label is verbatim 'Always Run Selected'", () => {
    assert.strictEqual(ALWAYS_RUN_SELECTED_BUTTON_LABEL, "Always Run Selected");
  });
});

/* ------------------------------------------------------------------ */
/* HumanReviewService wiring                                            */
/* ------------------------------------------------------------------ */

describe("HumanReviewService shell label wiring", () => {
  function allowlistLabelOf(svc: HumanReviewService): string | undefined {
    const req = svc.currentApproval;
    assert.ok(req, "expected a pending approval request");
    return req.options.find((o) => o.id === "approve-allowlist")?.label;
  }

  it("labels the allowlist button Cursor-verbatim for a single shell candidate", async () => {
    const svc = new HumanReviewService();
    const p = svc.requestApproval("tc-1", "bash", ["run?"], 60_000, undefined, undefined, undefined, [
      "npm test",
    ]);
    assert.strictEqual(allowlistLabelOf(svc), "Always Run 'npm test'");
    svc.resolveApproval(svc.currentApproval!.approvalId, { optionId: "approve-allowlist" });
    const res = await p;
    assert.strictEqual(res?.optionId, "approve-allowlist");
  });

  it("labels the allowlist button with the + N form for multiple candidates", async () => {
    const svc = new HumanReviewService();
    const p = svc.requestApproval("tc-2", "bash", ["run?"], 60_000, undefined, undefined, undefined, [
      "npm test",
      "npm run build",
      "npm run lint",
    ]);
    assert.strictEqual(allowlistLabelOf(svc), "Always Run 'npm test' + 2");
    svc.resolveApproval(svc.currentApproval!.approvalId, { optionId: "skip" });
    await p;
  });

  it("keeps the honest fallback label when no candidates are passed", async () => {
    const svc = new HumanReviewService();
    const p = svc.requestApproval("tc-3", "read package.json", ["read?"], 60_000);
    // Ev.* nls strings are not statically resolvable — not fabricated.
    assert.strictEqual(allowlistLabelOf(svc), "Approve and allowlist");
    svc.resolveApproval(svc.currentApproval!.approvalId, { optionId: "approve-once" });
    await p;
  });

  it("keeps the fallback label when candidates are empty", async () => {
    const svc = new HumanReviewService();
    const p = svc.requestApproval("tc-4", "bash", ["run?"], 60_000, undefined, undefined, undefined, []);
    assert.strictEqual(allowlistLabelOf(svc), "Approve and allowlist");
    svc.resolveApproval(svc.currentApproval!.approvalId, { optionId: "approve-once" });
    await p;
  });
});
