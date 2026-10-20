/**
 * findInPlan host-service tests (node:test, zero extra deps) — GAPS-157.
 *
 * Cursor parity: the fork's plan surface is the chat webview's plan
 * tray, so the core pane-level plan find Action2 commands
 * (binary-verbatim ids/titles/keybindings, Cursor 3.25.9
 * workbench.glass.main.js @45501537–@45502700) delegate to ide.*
 * commands in extension.ts, which call these host functions. These
 * tests pin the host → webview message protocol the webview's plan find
 * bar understands (components/composer.ts PLAN-FIND):
 *   showFindInPlan     → { type: "showFindInPlan" }
 *   hideFindInPlan     → { type: "hideFindInPlan" }
 *   findNextInPlan     → { type: "findNextInPlan" }      (nextPlanFindMatch)
 *   findPreviousInPlan → { type: "findPreviousInPlan" }  (previousPlanFindMatch)
 * plus the pure context-key mappings that keep the VERBATIM keys
 * `glassPlanFindBarVisible` / `glassFindInputFocused` (binary @23559865
 * / @23559425) and the fork-only `composerPlanTrayVisible` truthful.
 *
 * Run after `tsc`:  node out/services/findInPlan.test.js
 */
import { describe, it } from "node:test";
import * as assert from "node:assert";
import {
  SHOW_FIND_IN_PLAN,
  HIDE_FIND_IN_PLAN,
  FIND_NEXT_IN_PLAN,
  FIND_PREVIOUS_IN_PLAN,
  PLAN_FIND_BAR_STATE,
  GLASS_PLAN_FIND_BAR_VISIBLE_KEY,
  GLASS_FIND_INPUT_FOCUSED_KEY,
  COMPOSER_PLAN_TRAY_VISIBLE_KEY,
  planFindBarContextUpdates,
  planTrayContextUpdates,
  showFindInPlan,
  hideFindInPlan,
  findNextInPlan,
  findPreviousInPlan,
  type FindInPlanHost,
} from "./findInPlan";

/** Recording host: captures every message posted to the chat webview. */
function recordingHost(): { host: FindInPlanHost; posted: unknown[] } {
  const posted: unknown[] = [];
  return { host: { postToWebview: (msg: unknown) => posted.push(msg) }, posted };
}

describe("find-in-plan — host service message protocol", () => {
  it("message constants match the webview's protocol strings", () => {
    assert.strictEqual(SHOW_FIND_IN_PLAN, "showFindInPlan");
    assert.strictEqual(HIDE_FIND_IN_PLAN, "hideFindInPlan");
    assert.strictEqual(FIND_NEXT_IN_PLAN, "findNextInPlan");
    assert.strictEqual(FIND_PREVIOUS_IN_PLAN, "findPreviousInPlan");
    assert.strictEqual(PLAN_FIND_BAR_STATE, "planFindBarState");
  });

  it("showFindInPlan posts exactly one {type:'showFindInPlan'}", () => {
    const { host, posted } = recordingHost();
    showFindInPlan(host);
    assert.deepStrictEqual(posted, [{ type: "showFindInPlan" }]);
  });

  it("hideFindInPlan posts exactly one {type:'hideFindInPlan'}", () => {
    const { host, posted } = recordingHost();
    hideFindInPlan(host);
    assert.deepStrictEqual(posted, [{ type: "hideFindInPlan" }]);
  });

  it("findNextInPlan posts exactly one {type:'findNextInPlan'}", () => {
    const { host, posted } = recordingHost();
    findNextInPlan(host);
    assert.deepStrictEqual(posted, [{ type: "findNextInPlan" }]);
  });

  it("findPreviousInPlan posts exactly one {type:'findPreviousInPlan'}", () => {
    const { host, posted } = recordingHost();
    findPreviousInPlan(host);
    assert.deepStrictEqual(posted, [{ type: "findPreviousInPlan" }]);
  });
});

describe("find-in-plan — context key mappings (verbatim binary keys)", () => {
  it("key name constants are the binary-verbatim strings", () => {
    // e3i @23559865 / MX @23559425 (workbench.glass.main.js 3.25.9).
    assert.strictEqual(GLASS_PLAN_FIND_BAR_VISIBLE_KEY, "glassPlanFindBarVisible");
    assert.strictEqual(GLASS_FIND_INPUT_FOCUSED_KEY, "glassFindInputFocused");
    // Fork-only port of the cf.isEqualTo(Ot.Plan) when-arm.
    assert.strictEqual(COMPOSER_PLAN_TRAY_VISIBLE_KEY, "composerPlanTrayVisible");
  });

  it("open + input focused sets both verbatim keys true", () => {
    assert.deepStrictEqual(planFindBarContextUpdates({ open: true, inputFocused: true }), [
      ["glassPlanFindBarVisible", true],
      ["glassFindInputFocused", true],
    ]);
  });

  it("open + input blurred keeps visibility, clears input focus", () => {
    assert.deepStrictEqual(planFindBarContextUpdates({ open: true, inputFocused: false }), [
      ["glassPlanFindBarVisible", true],
      ["glassFindInputFocused", false],
    ]);
  });

  it("open without an inputFocused field clears input focus", () => {
    assert.deepStrictEqual(planFindBarContextUpdates({ open: true }), [
      ["glassPlanFindBarVisible", true],
      ["glassFindInputFocused", false],
    ]);
  });

  it("closed clamps input focus to false even for a stale report", () => {
    assert.deepStrictEqual(planFindBarContextUpdates({ open: false, inputFocused: true }), [
      ["glassPlanFindBarVisible", false],
      ["glassFindInputFocused", false],
    ]);
  });

  it("planTrayContextUpdates maps plan pending/cleared onto the surface key", () => {
    assert.deepStrictEqual(planTrayContextUpdates(true), [["composerPlanTrayVisible", true]]);
    assert.deepStrictEqual(planTrayContextUpdates(false), [["composerPlanTrayVisible", false]]);
  });
});
