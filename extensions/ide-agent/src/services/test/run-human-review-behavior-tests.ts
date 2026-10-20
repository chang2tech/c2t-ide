/**
 * HumanReviewService BEHAVIORAL tests (node:test, no vscode dependency).
 *
 * Provenance: authored by DEV-GAPS-21 (W21C) as ad-hoc `/tmp/rk-behavior/behavior.test.cjs`
 * (19 cases), promoted into the tree by WORKER-GAPS-30B (2026-10-20) because /tmp is
 * tmpfs and the tests would be lost on VM restart.
 *
 * Unlike run-approval-review-kinds-tests.ts (which only greps the TS source), these
 * exercise the REAL compiled HumanReviewService at runtime:
 *   src/vs/workbench/contrib/composer/common/humanReviewService.ts
 *
 * The service lives in workbench core and imports vscode DI / vs/base modules, so it
 * cannot be required from the extension test tree directly. Tests load the prebuilt
 * esbuild fixture `./fixtures/human-review-service.bundle.cjs` instead.
 *
 * FIXTURE FRESHNESS: the test recomputes a sha256 over the 24 TS sources the bundle
 * was built from (INPUTS list below) and FAILS LOUDLY if any of them changed, with
 * regeneration instructions. A stale bundle must never silently pass.
 *
 * Run after `tsc`:  node --test out/services/test/run-human-review-behavior-tests.js
 */
import { describe, it } from "node:test";
import * as assert from "node:assert";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

/* ---------- fixture freshness gate ---------- */

/** The 24 TS sources bundled into the fixture (repo-root-relative). */
const INPUTS = [
  "src/vs/base/common/collections.ts",
  "src/vs/base/common/errors.ts",
  "src/vs/base/common/functional.ts",
  "src/vs/base/common/arraysFind.ts",
  "src/vs/base/common/arrays.ts",
  "src/vs/base/common/map.ts",
  "src/vs/base/common/assert.ts",
  "src/vs/base/common/types.ts",
  "src/vs/base/common/iterator.ts",
  "src/vs/base/common/lifecycle.ts",
  "src/vs/base/common/linkedList.ts",
  "src/vs/nls.ts",
  "src/vs/base/common/platform.ts",
  "src/vs/base/common/process.ts",
  "src/vs/base/common/stopwatch.ts",
  "src/vs/base/common/event.ts",
  "src/vs/platform/instantiation/common/instantiation.ts",
  "src/vs/base/common/charCode.ts",
  "src/vs/base/common/marshallingIds.ts",
  "src/vs/base/common/path.ts",
  "src/vs/base/common/uri.ts",
  "src/vs/platform/configuration/common/configuration.ts",
  "src/vs/workbench/contrib/composer/common/shellAllowlistLabel.ts",
  "src/vs/workbench/contrib/composer/common/humanReviewService.ts",
];

/** sha256 recorded when the fixture bundle was built (see fixture header). */
const EXPECTED_INPUTS_HASH =
  "1bc7233fd0050a559984e62e9936a55393e70b16570274f76406c5fba2fc10dd";

// At runtime __dirname = <repo>/extensions/ide-agent/out/services/test
const repoRoot = path.resolve(__dirname, "..", "..", "..", "..", "..");
const fixturePath = path.join(
  repoRoot,
  "extensions",
  "ide-agent",
  "src",
  "services",
  "test",
  "fixtures",
  "human-review-service.bundle.cjs",
);

function failStale(reason: string): never {
  throw new Error(
    `[run-human-review-behavior-tests] STALE FIXTURE BUNDLE: ${reason}\n` +
      `The bundle ${fixturePath}\n` +
      `no longer matches the current core sources. Regenerate it from the repo root:\n` +
      `  npx -y esbuild src/vs/workbench/contrib/composer/common/humanReviewService.ts \\\n` +
      `    --bundle --platform=node --format=cjs \\\n` +
      `    --outfile=extensions/ide-agent/src/services/test/fixtures/human-review-service.bundle.cjs\n` +
      `then recompute EXPECTED_INPUTS_HASH over INPUTS and update this file + the bundle header.`,
  );
}

(function checkFreshness() {
  const hash = crypto.createHash("sha256");
  for (const rel of INPUTS) {
    const abs = path.join(repoRoot, rel);
    if (!fs.existsSync(abs)) {
      failStale(`missing bundled source ${rel}`);
    }
    hash.update(fs.readFileSync(abs));
  }
  if (hash.digest("hex") !== EXPECTED_INPUTS_HASH) {
    failStale("one or more bundled sources changed since the bundle was built");
  }
  if (!fs.existsSync(fixturePath)) {
    failStale("bundle file missing");
  }
})();

/* eslint-disable @typescript-eslint/no-var-requires */
const m = require(fixturePath) as any;

const {
  HumanReviewService,
  ToolCallHumanReviewService,
  ToolCallReviewModel,
  TerminalReviewOption,
  McpReviewOption,
  EditReviewOption,
  PlanReviewOption,
  WebFetchReviewOption,
  RUN_TERMINAL_COMMAND_V2,
} = m;

const fakeConfig = { getValue: () => false };
const svc = () => new HumanReviewService(fakeConfig);

describe("behavior: RUN_TERMINAL_COMMAND_V2 auto-select", () => {
  it("terminal bubble with RUN_TERMINAL_COMMAND_V2 auto-selects RUN", () => {
    const s = svc();
    const model = s.getTerminalReviewModelForBubble("h1", "b1", RUN_TERMINAL_COMMAND_V2);
    assert.strictEqual(model.selectedOption, "run");
    assert.strictEqual(model.selectedOption, TerminalReviewOption.RUN);
  });
  it("terminal bubble with other tool name -> no auto-select", () => {
    const s = svc();
    const model = s.getTerminalReviewModelForBubble("h1", "b2", "SOME_OTHER_TOOL");
    assert.strictEqual(model.selectedOption, undefined);
  });
  it("terminal bubble without toolName -> no auto-select", () => {
    const s = svc();
    const model = s.getTerminalReviewModelForBubble("h1", "b3");
    assert.strictEqual(model.selectedOption, undefined);
  });
  it("auto-select applies once at creation; later user choice is not overwritten", () => {
    const s = svc();
    s.getTerminalReviewModelForBubble("h1", "b1", RUN_TERMINAL_COMMAND_V2);
    s.setSelectedOptionForBubble("h1", "b1", TerminalReviewOption.SKIP);
    const again = s.getTerminalReviewModelForBubble("h1", "b1", RUN_TERMINAL_COMMAND_V2);
    assert.strictEqual(again.selectedOption, "skip");
  });
});

describe("behavior: per-bubble isolation", () => {
  it("different bubbles get different models", () => {
    const s = svc();
    const a = s.getTerminalReviewModelForBubble("h1", "b1");
    const b = s.getTerminalReviewModelForBubble("h1", "b2");
    assert.notStrictEqual(a, b);
  });
  it("same (handle,bubbleId) returns the stable instance", () => {
    const s = svc();
    assert.strictEqual(
      s.getTerminalReviewModelForBubble("h1", "b1"),
      s.getTerminalReviewModelForBubble("h1", "b1"),
    );
  });
  it("handles segment the key (binary API parity)", () => {
    const s = svc();
    const a = s.getTerminalReviewModelForBubble("hA", "b1");
    const b = s.getTerminalReviewModelForBubble("hB", "b1");
    assert.notStrictEqual(a, b);
  });
  it("disposeReviewModelForBubble drops the model; next get creates fresh", () => {
    const s = svc();
    const before = s.getTerminalReviewModelForBubble("h1", "b1", RUN_TERMINAL_COMMAND_V2);
    assert.strictEqual(before.selectedOption, "run");
    s.disposeReviewModelForBubble("h1", "b1");
    const after = s.getTerminalReviewModelForBubble("h1", "b1"); // no toolName
    assert.notStrictEqual(after, before);
    assert.strictEqual(after.selectedOption, undefined);
  });
});

describe("behavior: kind-specific getters", () => {
  it("edit bubble defaults selectedOption to ACCEPT", () => {
    const s = svc();
    const model = s.getEditReviewModelForBubble("h1", "e1");
    assert.strictEqual(model.selectedOption, EditReviewOption.ACCEPT);
  });
  it("mcp bubble: no default selection", () => {
    const s = svc();
    const model = s.getMcpReviewModelForBubble("h1", "m1");
    assert.strictEqual(model.selectedOption, undefined);
  });
  it("configuration kind via generic getter: no crash", () => {
    const s = svc();
    const model = s.getReviewModelForBubble("configuration", "h1", "c1");
    assert.ok(model instanceof ToolCallReviewModel);
  });
  it("edit displayed options = observed subset [accept, reject..., switchToDefaultAgentMode]", () => {
    const s = svc();
    assert.deepStrictEqual(s.getCurrentlyDisplayedOptions("edit"), [
      "accept",
      "rejectAndTellWhatToDoDifferently",
      "switchToDefaultAgentMode",
    ]);
  });
});

describe("behavior: selectTerminalOptionForBubble side-effects", () => {
  it("RUN sets status done", () => {
    const s = svc();
    s.getTerminalReviewModelForBubble("h1", "b1");
    s.selectTerminalOptionForBubble("h1", "b1", TerminalReviewOption.RUN);
    const model = s.getTerminalReviewModelForBubble("h1", "b1");
    assert.strictEqual(model.selectedOption, "run");
    assert.strictEqual(model.status, "done");
  });
  it("REJECT_AND_TELL opens the feedback input instead of finishing", () => {
    const s = svc();
    s.getTerminalReviewModelForBubble("h1", "b1");
    s.selectTerminalOptionForBubble(
      "h1",
      "b1",
      TerminalReviewOption.REJECT_AND_TELL_WHAT_TO_DO_DIFFERENTLY,
    );
    const model = s.getTerminalReviewModelForBubble("h1", "b1");
    assert.strictEqual(model.isShowingInput, true);
    assert.notStrictEqual(model.status, "done");
  });
  it("select on missing bubble is a no-op (no throw)", () => {
    const s = svc();
    s.selectTerminalOptionForBubble("hx", "nope", TerminalReviewOption.RUN);
    s.setSelectedOptionForBubble("hx", "nope", "run");
    s.setIsShowingInputForBubble("hx", "nope", true);
  });
});

describe("behavior: binary-parity alias + verbatim enums at runtime", () => {
  it("ToolCallHumanReviewService === HumanReviewService", () => {
    assert.strictEqual(ToolCallHumanReviewService, HumanReviewService);
  });
  it("runtime enum values are verbatim", () => {
    assert.deepStrictEqual(
      { ...TerminalReviewOption },
      {
        RUN: "run",
        SKIP: "skip",
        ALLOWLIST_COMMANDS: "allowlistCommands",
        REJECT_AND_TELL_WHAT_TO_DO_DIFFERENTLY: "rejectAndTellWhatToDoDifferently",
      },
    );
    assert.deepStrictEqual(
      { ...McpReviewOption },
      {
        RUN: "run",
        SKIP: "skip",
        REJECT_AND_TELL_WHAT_TO_DO_DIFFERENTLY: "rejectAndTellWhatToDoDifferently",
        ALLOWLIST_TOOL: "allowlistTool",
      },
    );
    assert.deepStrictEqual(
      { ...EditReviewOption },
      {
        ACCEPT: "accept",
        REJECT_AND_TELL_WHAT_TO_DO_DIFFERENTLY: "rejectAndTellWhatToDoDifferently",
        SKIP: "skip",
        SWITCH_TO_DEFAULT_AGENT_MODE: "switchToDefaultAgentMode",
        ACCEPT_AND_ALLOW_FOLDER: "acceptAndAllowFolder",
      },
    );
    assert.deepStrictEqual(
      { ...PlanReviewOption },
      {
        NONE: "none",
        APPROVE: "approve",
        REJECT_AND_TELL_WHAT_TO_DO_DIFFERENTLY: "rejectAndTellWhatToDoDifferently",
        EDIT: "edit",
      },
    );
    assert.deepStrictEqual(
      { ...WebFetchReviewOption },
      {
        RUN: "run",
        SKIP: "skip",
        ALLOWLIST_DOMAIN: "allowlistDomain",
      },
    );
    assert.strictEqual(RUN_TERMINAL_COMMAND_V2, "RUN_TERMINAL_COMMAND_V2");
  });
  it("review data shape keys exist on the model", () => {
    const s = svc();
    const model = s.getTerminalReviewModelForBubble("h1", "b1");
    for (const k of [
      "status",
      "selectedOption",
      "isShowingInput",
      "highlightedOption",
      "firstTimeReviewMode",
    ]) {
      assert.ok(k in model, `missing key ${k}`);
    }
    assert.strictEqual(typeof model.setSelectedOption, "function");
    assert.strictEqual(typeof model.setIsShowingInput, "function");
  });
});

describe("behavior: binary-verbatim getMCPReviewModelForBubble alias", () => {
  it("alias returns the same per-bubble model as getMcpReviewModelForBubble", () => {
    const s = new HumanReviewService({ getValue: () => false });
    const a = s.getMCPReviewModelForBubble("h1", "m1");
    const b = s.getMcpReviewModelForBubble("h1", "m1");
    assert.strictEqual(a, b);
    assert.ok(a instanceof ToolCallReviewModel);
  });
});
