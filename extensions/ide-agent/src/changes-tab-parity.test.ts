/**
 * Changes-tab parity tests — WORKER-GAPS-21B (P1 `workbench-open-changes-tab`).
 *
 * The fork implements Cursor's `glass.openChangesTab` ("Review Changes", Ctrl+E):
 * the new-tab-model "changes" action gated by a `showChangesAction`-style flag,
 * `executeCommand` routing with `{scope:"lastTurn", agentId, filePath?}` (+ the
 * cloud shape `{bcId, label, initialFilterScope:"branch", ownerAgentId}`) to the
 * agent-changes view and the review-changes editor, and the availability policy
 * (`changesTabAvailable`, `_isChangesTabActivatable()`, `preferChangesAsDefault`).
 *
 * This test loads the real core sources as text (same approach as
 * palette-dedupe.test.ts) and asserts the implementation's structural
 * invariants. Behavioral unit tests live in
 * src/vs/sessions/contrib/changes/test/browser/openChangesTabCommand.test.ts
 * (run in CI with the workbench test runner).
 *
 * node:test, zero extra deps. Run after `tsc`: node out/changes-tab-parity.test.js
 */
import { describe, it } from "node:test";
import * as assert from "node:assert";
import * as fs from "fs";
import * as path from "path";

// Compiled to out/changes-tab-parity.test.js, so the extension root is one level up.
const EXT_ROOT = path.resolve(__dirname, "..");
const REPO_ROOT = path.resolve(EXT_ROOT, "..", "..");

function readCore(relPath: string): string {
  return fs.readFileSync(path.join(REPO_ROOT, relPath), "utf8");
}

const OPEN_CHANGES_TAB_COMMAND = "src/vs/sessions/contrib/changes/browser/openChangesTabCommand.ts";
const REVIEW_EDITOR = "src/vs/sessions/contrib/changes/browser/sessionReviewChangesEditor.ts";
const REVIEW_PROPS_COMMON = "src/vs/sessions/contrib/changes/common/sessionChangesService.ts";
const CHANGES_SERVICE = "src/vs/sessions/contrib/changes/browser/sessionChangesService.ts";
const CHANGES_CONTRIBUTION = "src/vs/sessions/contrib/changes/browser/changes.contribution.ts";

describe("workbench-open-changes-tab parity (WORKER-GAPS-21B)", () => {
  it("glass.openChangesTab is registered with the verbatim binary id, title, and Ctrl+E keybinding", () => {
    const src = readCore(OPEN_CHANGES_TAB_COMMAND);
    assert.ok(src.includes("export const OPEN_CHANGES_TAB_COMMAND_ID = 'glass.openChangesTab'"));
    assert.ok(src.includes("static readonly ID = OPEN_CHANGES_TAB_COMMAND_ID"));
    assert.ok(/title: localize2\('openChangesTab', "Review Changes"\)/.test(src));
    assert.ok(/primary:\s*KeyMod\.CtrlCmd\s*\|\s*KeyCode\.KeyE/.test(src), "Ctrl+E keybinding missing");
  });

  it("new-tab-model 'changes' action carries the verbatim binary data and a showChangesAction-style gate", () => {
    const src = readCore(OPEN_CHANGES_TAB_COMMAND);
    // Verbatim action data: {id:"changes", label:"Changes", keywords:["git"], icon:"plus-minus", keybindingCommandId}
    assert.ok(src.includes("id: CHANGES_NEW_TAB_MODEL_ACTION_ID"));
    assert.ok(src.includes("label: 'Changes'"));
    assert.ok(src.includes("keywords: ['git']"));
    assert.ok(src.includes("keybindingCommandId: OPEN_CHANGES_TAB_COMMAND_ID"));
    // The gate: shown when the verbatim changesTabAvailable policy holds.
    assert.ok(src.includes("export function isNewTabModelActionShown"), "gate function missing");
    assert.ok(src.includes("export function getVisibleNewTabModelActions"), "visible-actions listing missing");
    assert.ok(src.includes("ChangesTabAvailableContext.key"), "gate must read the verbatim changesTabAvailable context key");
    assert.ok(src.includes("showChangesAction"), "gate must document the showChangesAction mapping");
    // openNewTabModelAction enforces the gate at run time, not just registration time.
    const runFn = src.slice(src.indexOf("export async function openNewTabModelAction"));
    assert.ok(runFn.includes("isNewTabModelActionShown"), "openNewTabModelAction must enforce the gate");
  });

  it("executeCommand args accept both the local and the cloud (openAgentChangesTab) shapes", () => {
    const src = readCore(OPEN_CHANGES_TAB_COMMAND);
    for (const field of ["agentId", "filePath", "bcId", "label", "initialFilterScope", "ownerAgentId"]) {
      assert.ok(src.includes(`readonly ${field}?: string`), `IOpenChangesTabArgs missing field: ${field}`);
    }
    assert.ok(src.includes(`readonly scope?: 'lastTurn'`), "IOpenChangesTabArgs missing field: scope");
    assert.ok(src.includes("export function parseOpenChangesTabArgs"), "arg parser must be exported for tests");
  });

  it("routing: filePath goes to the review-changes editor, otherwise the agent-changes view", () => {
    const src = readCore(OPEN_CHANGES_TAB_COMMAND);
    assert.ok(src.includes("openReviewChangesEditor(sessionResource, reviewProps"), "filePath must route to the review-changes editor");
    assert.ok(src.includes("scrollToFile: args.filePath"), "review props must carry scrollToFile");
    assert.ok(src.includes("openChangesEditor(sessionResource, { pinned: true })"), "default path must open the agent-changes view");
    // Cloud-shape agent resolution: agentId -> bcId/ownerAgentId -> active session.
    assert.ok(src.includes("args.agentId ?? args.bcId ?? args.ownerAgentId"));
  });

  it("_isChangesTabActivatable implements the resolved binary semantics (no agent -> true; remote env -> false)", () => {
    const src = readCore(OPEN_CHANGES_TAB_COMMAND);
    assert.ok(src.includes("export function isRemoteEnvironmentSession"), "bA predicate missing");
    assert.ok(src.includes("session.environment === 'local'"), "Kl (local env) mapping missing");
    assert.ok(src.includes("Schemas.file"), "Kl (local folder workspace w/ uri) mapping missing");
    const contrib = src.slice(src.indexOf("class ChangesTabAvailabilityContribution"));
    assert.ok(contrib.includes("if (!activeSession)"), "no current agent id must yield true");
    assert.ok(contrib.includes("return true;"), "no-agent branch missing");
    assert.ok(contrib.includes("!isRemoteEnvironmentSession(activeSession)"), "remote-environment agents must not be activatable");
  });

  it("review-changes editor carries the verbatim workbench.editor.reviewchanges identity", () => {
    const src = readCore(REVIEW_EDITOR);
    const common = readCore(REVIEW_PROPS_COMMON);
    assert.ok(src.includes("workbench.editor.reviewchanges"), "verbatim binary input id must be referenced");
    assert.ok(common.includes("export interface IReviewChangesProps"), "verbatim props interface must live in the common layer");
    for (const prop of ["composerId", "parentComposerId", "initialMode", "fromBugbot", "scrollToFile", "scrollToLine", "scrollToReviewFile", "fromBackgroundAgent", "gitMode", "gitModeLabel"]) {
      assert.ok(common.includes(`readonly ${prop}?:`), `IReviewChangesProps missing verbatim prop: ${prop}`);
    }
    for (const field of ["composerIdOverride", "parentComposerId", "options"]) {
      assert.ok(src.includes(field), `serialized shape missing verbatim field: ${field}`);
    }
    assert.ok(src.includes('"Review Changes"'), 'tab title must be the verbatim "Review Changes" string');
  });

  it("review-changes editor is registered (pane descriptor + serializer) in changes.contribution.ts", () => {
    const src = readCore(CHANGES_CONTRIBUTION);
    assert.ok(src.includes("SessionReviewChangesEditorInput"), "review input not imported");
    assert.ok(src.includes("SessionReviewChangesEditorSerializer"), "review serializer not imported");
    assert.ok(src.includes("SessionReviewChangesEditorInput.EDITOR_ID"), "review pane descriptor not registered");
    assert.ok(src.includes("SessionReviewChangesEditorInput.ID,"), "review serializer not registered");
  });

  it("session changes service exposes openReviewChangesEditor alongside openChangesEditor", () => {
    const src = readCore(CHANGES_SERVICE);
    assert.ok(src.includes("async openReviewChangesEditor(sessionResource"), "service method missing");
    assert.ok(src.includes("SessionReviewChangesEditorInput, multiDiffSource, reviewProps"), "review input must be created with the verbatim props");
  });
});
