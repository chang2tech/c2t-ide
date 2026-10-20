/**
 * F2-A live-path tests (node:test): Cmd+K prompt bar — core must be called on
 * the live path (Cursor 3.25.9 parity: the prompt bar is a workbench-core
 * Monaco view zone, NOT an extension quick-input box).
 *
 * Finding (audit-fix-queue.md 2026-10-19 22:35, feature_id
 * cmdk-prompt-bar-viewzone-live-path): core `InlineEditPromptBarService`
 * implemented the binary-verified view-zone params but was never called on
 * the live path — `composer.openInlinePrompt` delegated to the extension's
 * `ide.openInlinePrompt` → `vscode.window.createInputBox()`.
 *
 * These tests lock in the fix:
 *  1. `composer.openInlinePrompt` (Cmd+K) drives the core
 *     `IInlineEditService.openPrompt()` — not `ide.openInlinePrompt`.
 *  2. The rest of the live path (accept / reject / sendToAgent /
 *     focusEditorFromDiff / addSelectionToInlinePrompt) also drives core.
 *  3. `IInlineEditService` + `IInlinePromptSelectionService` are registered
 *     via `registerSingleton` (previously dead code — never registered).
 *  4. The core service's prompt step calls the view-zone bar
 *     (`promptBar.showPromptBar`) and never `createInputBox`.
 *
 * Style: source-scan, same as run-partial-diff-tests.ts (the workbench core
 * cannot be imported in node, so the wiring is asserted on the sources).
 *
 * Run after `tsc`:  node --test out/services/test/run-cmdk-live-path-tests.js
 */
import { describe, it } from "node:test";
import * as assert from "node:assert";
import * as fs from "node:fs";
import * as path from "node:path";

const REPO = path.join(__dirname, "..", "..", "..", "..", "..");
const composerSrc = path.join(REPO, "src", "vs", "workbench", "contrib", "composer");

function read(rel: string): string {
  return fs.readFileSync(path.join(composerSrc, rel), "utf8");
}

/** Extract the source block of one `export class XAction extends Action2 { ... }`. */
function classBlock(src: string, className: string): string {
  const start = src.indexOf(`export class ${className} extends Action2 {`);
  assert.ok(start >= 0, `missing action class ${className}`);
  const nextClass = src.indexOf("\nexport class ", start + 1);
  const nextFn = src.indexOf("\nexport function ", start + 1);
  const endCandidates = [nextClass, nextFn].filter((i) => i > start);
  const end = endCandidates.length > 0 ? Math.min(...endCandidates) : src.length;
  return src.slice(start, end);
}

describe("F2-A: composer.openInlinePrompt (Cmd+K) drives the core view-zone bar", () => {
  const src = read(path.join("browser", "composerActions.ts"));
  const block = classBlock(src, "ComposerOpenInlinePromptAction");

  it("keybinding is still CtrlCmd+K when editorTextFocus", () => {
    assert.ok(
      block.includes("primary: KeyMod.CtrlCmd | KeyCode.KeyK"),
      "Cmd+K primary keybinding intact",
    );
    assert.ok(block.includes("when: EditorContextKeys.editorTextFocus"), "editorTextFocus when-clause intact");
  });

  it("run() calls core IInlineEditService.openPrompt()", () => {
    assert.ok(block.includes("getCoreInlineEditService(accessor)"), "resolves the core service");
    assert.ok(block.includes("core.openPrompt()"), "drives the core inline-edit flow");
  });

  it("the extension quick-input is only a non-desktop fallback, never the primary path", () => {
    const runStart = block.indexOf("async run(");
    const coreCall = block.indexOf("core.openPrompt()", runStart);
    const legacyCall = block.indexOf("executeCommand('ide.openInlinePrompt'", runStart);
    assert.ok(coreCall >= 0, "core call present");
    // The legacy command may only survive as a fallback AFTER the core path.
    if (legacyCall >= 0) {
      assert.ok(
        legacyCall > coreCall,
        "ide.openInlinePrompt (if present) must come after the core call, as a fallback",
      );
      assert.ok(
        block.includes("fall back"),
        "the fallback is documented as web/aux-only",
      );
    }
  });
});

describe("F2-A: the rest of the live path drives core too", () => {
  const composerSrc = read(path.join("browser", "composerActions.ts"));
  // WORKER-GAPS-34C (inline-edit-command-ids, P1): the accept/reject actions
  // moved to inlineDiffActions.ts with the binary-verbatim
  // `editor.action.inlineDiffs.*` ids.
  const inlineDiffSrc = read(path.join("browser", "inlineDiffActions.ts"));

  const EXPECTED: Array<{ cls: string; coreCall: string; legacy: string; file: "composer" | "inlineDiff" }> = [
    { cls: "EditorInlineDiffsAcceptAllAction", coreCall: "core.accept()", legacy: "ide.acceptInlineEdit", file: "inlineDiff" },
    { cls: "EditorInlineDiffsRejectAllAction", coreCall: "core.reject()", legacy: "ide.rejectInlineEdit", file: "inlineDiff" },
    { cls: "EditorInlineDiffsCancelEditsAction", coreCall: "core.cancelGeneration()", legacy: "ide.cancelInlineEditGeneration", file: "inlineDiff" },
    { cls: "ComposerSendToAgentAction", coreCall: "core.escalateToAgent()", legacy: "ide.sendToAgent", file: "composer" },
  ];
  for (const e of EXPECTED) {
    it(`${e.cls} calls ${e.coreCall} before any ${e.legacy} fallback`, () => {
      const block = classBlock(e.file === "inlineDiff" ? inlineDiffSrc : composerSrc, e.cls);
      const runStart = block.indexOf("async run(");
      const coreCall = block.indexOf(e.coreCall, runStart);
      assert.ok(coreCall >= 0, `${e.cls} drives the core service (${e.coreCall})`);
      const legacyCall = block.indexOf(`'${e.legacy}'`, runStart);
      if (legacyCall >= 0) {
        assert.ok(legacyCall > coreCall, `${e.legacy} is fallback-only`);
      }
    });
  }

  it("ComposerFocusEditorFromDiffAction focuses the editor in core (no extension delegation)", () => {
    const block = classBlock(composerSrc, "ComposerFocusEditorFromDiffAction");
    assert.ok(block.includes("editor.focus()"), "focuses the editor directly in core");
    assert.ok(
      !block.includes("ide.focusEditorFromDiff"),
      "no delegation to the extension's ide.focusEditorFromDiff",
    );
  });

  it("ComposerAddSelectionToInlinePromptAction attaches via the core selection service", () => {
    const block = classBlock(composerSrc, "ComposerAddSelectionToInlinePromptAction");
    assert.ok(block.includes("IInlinePromptSelectionService"), "uses the core selection service");
    assert.ok(block.includes("attachPendingSelection()"), "attaches the selection");
    assert.ok(block.includes("core.openPrompt()"), "opens the core prompt afterwards");
  });
});

describe("F2-A: IInlineEditService is registered (no longer dead code)", () => {
  const contrib = read(path.join("electron-browser", "composer.contribution.ts"));

  it("registerSingleton(IInlineEditService, InlineEditService, ...)", () => {
    assert.ok(
      contrib.includes("registerSingleton(IInlineEditService, InlineEditService"),
      "IInlineEditService is registered",
    );
  });

  it("registerSingleton(IInlinePromptSelectionService, InlinePromptSelectionService, ...)", () => {
    assert.ok(
      contrib.includes("registerSingleton(IInlinePromptSelectionService, InlinePromptSelectionService"),
      "the selection service the core flow depends on is registered too",
    );
  });

  it("the service contract lives in common/ (browser-safe, no node imports)", () => {
    const contract = read(path.join("common", "inlineEditService.ts"));
    assert.ok(
      contract.includes("createDecorator<IInlineEditService>('composerInlineEditService')"),
      "contract + decorator in common/",
    );
    assert.ok(contract.includes("openPrompt(): Promise<void>"), "openPrompt on the contract");
    assert.ok(contract.includes("escalateToAgent(): Promise<void>"), "escalateToAgent on the contract");
  });
});

describe("F2-A: the core prompt step is the view-zone bar, never a quick-input box", () => {
  const core = read(path.join("electron-browser", "inlineEditService.ts"));

  it("imports the contract from common/ (not defined locally)", () => {
    assert.ok(
      core.includes('from "../common/inlineEditService.js"'),
      "contract imported from common/",
    );
    assert.ok(
      !core.includes("createDecorator<IInlineEditService>"),
      "no local duplicate decorator",
    );
  });

  it("the constructor is pure DI (no non-service `opts` callback)", () => {
    assert.ok(!core.includes("private readonly opts"), "non-DI opts param removed");
    assert.ok(core.includes("@IInlineEditChatBridge"), "chat escalation is an injectable bridge");
  });

  it("promptForInstruction drives the view-zone bar", () => {
    assert.ok(
      core.includes("this.promptBar.showPromptBar(editor, {"),
      "opens the native view-zone prompt bar",
    );
  });

  it("never calls vscode.window.createInputBox", () => {
    assert.ok(
      !core.includes("createInputBox"),
      "the core live path must not open a quick-input box",
    );
  });

  it("maps the bar's 3 modes onto edit/question/escalate", () => {
    assert.ok(core.includes('"quick_question" ? "question"'), "quick_question → question");
    assert.ok(core.includes('"send_to_chat" ? "escalate"'), "send_to_chat → escalate");
  });
});

describe("F2-A: the chat bridge reaches the extension chat surface", () => {
  it("browser/inlineEditChatBridge.ts routes through ide.submitInlinePromptToChat", () => {
    const bridge = read(path.join("browser", "inlineEditChatBridge.ts"));
    assert.ok(
      bridge.includes("executeCommand('ide.submitInlinePromptToChat', text)"),
      "bridge delegates to the extension command",
    );
  });

  it("browser/composer.contribution.ts registers the bridge", () => {
    const contrib = read(path.join("browser", "composer.contribution.ts"));
    assert.ok(
      contrib.includes("registerSingleton(IInlineEditChatBridge, InlineEditChatBridge"),
      "IInlineEditChatBridge is registered",
    );
  });

  it("the extension registers ide.submitInlinePromptToChat (submits to the active composer)", () => {
    const ext = fs.readFileSync(
      path.join(REPO, "extensions", "ide-agent", "src", "extension.ts"),
      "utf8",
    );
    assert.ok(
      ext.includes('{ id: "ide.submitInlinePromptToChat"'),
      "command declared in the extension command list",
    );
    assert.ok(
      ext.includes('case "ide.submitInlinePromptToChat":'),
      "command has a runtime handler",
    );
    assert.ok(
      ext.includes("tabs.activeComposer.submit(text)"),
      "handler submits the text to the active composer",
    );
  });
});
