/**
 * Cancel-generation shortcut tests (node:test, zero extra deps).
 *
 * W65D (2026-10-20): feature `chat-cancel-generation-shortcut`
 * (feature-matrix.json). Cursor 3.25.9 registers TWO binary-verbatim core
 * commands (workbench.glass.main.js @39862622/@39865699):
 *   - `composer.cancelComposerStep`            "Cancel Chat"
 *   - `composer.cancelComposerStepInputFocused` "Cancel Chat (Input Focused)"
 *   both f1:!0, Ctrl/Cmd+Shift+Backspace at weight 600,
 *   when composerFocused || focusedView =~ /^workbench.panel.aichat.view/,
 *   the second with a mac-only Ctrl+C override.
 * Binary run: resolve the selected composer; if the tab service would show
 * the cancel affordance (shouldShowCancel) -> trackEvent("composer.cancel_chat",
 * {composerId, source:"cmd_backspace"}) + cancelCurrentStep; else if the
 * view would show accept/reject-all -> rejectAll.
 *
 * Fork port: the two core Action2 ids above live in
 * src/vs/workbench/contrib/composer/browser/composerActions.ts (they
 * replaced the fork-invented `composer.cancelAgentStep`, which the binary
 * does not have) and delegate to the extension runtime `ide.cancelAgentStep`.
 * The extension implements the cancel branch (a running turn -> abort);
 * the binary's accept/reject-all branch has no fork analog (the engine
 * applies file edits directly) and must stay a documented no-op — never
 * invented.
 *
 * Run after `tsc`:  node out/cancel-composer-step.test.js
 */
import { describe, it } from "node:test";
import * as assert from "node:assert";
import * as fs from "fs";
import * as path from "path";

// Compiled to out/cancel-composer-step.test.js, so the extension root is one level up.
const EXT_ROOT = path.resolve(__dirname, "..");
const EXTENSION_TS = path.join(EXT_ROOT, "src", "extension.ts");
const ACTIONS_TS = path.join(
  EXT_ROOT,
  "..",
  "..",
  "src",
  "vs",
  "workbench",
  "contrib",
  "composer",
  "browser",
  "composerActions.ts",
);

function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^\S\r\n])\/\/[^\r\n]*/gm, "$1");
}

/** Extract an `export class <name> extends Action2 { ... }` block from composerActions.ts. */
function coreActionBlock(className: string): string {
  const src = fs.readFileSync(ACTIONS_TS, "utf8");
  const start = src.indexOf(`export class ${className} extends Action2 {`);
  assert.ok(start >= 0, `${className} missing in composerActions.ts`);
  const lines = src.slice(start).split("\n");
  const block: string[] = [];
  for (const line of lines) {
    block.push(line);
    if (block.length > 1 && /^\}$/.test(line)) {
      break;
    }
  }
  return block.join("\n");
}

/** Extract the `case "ide.cancelAgentStep": ... break;` block from extension.ts. */
function extensionCaseBlock(): string {
  const src = fs.readFileSync(EXTENSION_TS, "utf8");
  const start = src.indexOf('case "ide.cancelAgentStep":');
  assert.ok(start >= 0, 'case "ide.cancelAgentStep" missing in extension.ts');
  const rest = src.slice(start);
  const end = rest.search(/\n\s*case "/);
  assert.ok(end > 0, "could not find the end of the ide.cancelAgentStep case");
  return rest.slice(0, end);
}

describe("cancel-generation shortcut — core Action2 registrations (Cursor 3.25.9 binary-verbatim)", () => {
  it("composer.cancelComposerStep: id/title/f1/chord/weight/when are binary-verbatim", () => {
    const block = stripComments(coreActionBlock("ComposerCancelComposerStepAction"));
    assert.ok(block.includes("static readonly ID = 'composer.cancelComposerStep'"), "wrong command id");
    assert.ok(block.includes("'Cancel Chat'"), 'title must be "Cancel Chat"');
    assert.ok(/f1:\s*true/.test(block), "binary f1:!0 — must be in the palette");
    assert.ok(
      block.includes("KeyMod.CtrlCmd | KeyMod.Shift | KeyCode.Backspace"),
      "primary chord must be CtrlCmd+Shift+Backspace",
    );
    assert.ok(
      /weight:\s*cancelComposerStepKeybindingWeight/.test(block),
      "weight must be the binary-verbatim 600 (cancelComposerStepKeybindingWeight)",
    );
    assert.ok(block.includes("when: chatSurface"), "when must be the fork's composerFocused port (chatSurface)");
    assert.ok(!/category:/.test(block), "the binary registers no category");
  });

  it("composer.cancelComposerStepInputFocused: binary-verbatim + mac Ctrl+C override", () => {
    const block = stripComments(coreActionBlock("ComposerCancelComposerStepInputFocusedAction"));
    assert.ok(
      block.includes("static readonly ID = 'composer.cancelComposerStepInputFocused'"),
      "wrong command id",
    );
    assert.ok(block.includes("'Cancel Chat (Input Focused)'"), 'title must be "Cancel Chat (Input Focused)"');
    assert.ok(/f1:\s*true/.test(block), "binary f1:!0 — must be in the palette");
    assert.ok(
      block.includes("KeyMod.CtrlCmd | KeyMod.Shift | KeyCode.Backspace"),
      "primary chord must be CtrlCmd+Shift+Backspace",
    );
    assert.ok(
      /mac:\s*\{\s*primary:\s*KeyMod\.WinCtrl\s*\|\s*KeyCode\.KeyC\s*\}/.test(block),
      "binary mac:{primary:dt.WinCtrl|Xe.KeyC} override missing",
    );
    assert.ok(
      /weight:\s*cancelComposerStepKeybindingWeight/.test(block),
      "weight must be the binary-verbatim 600",
    );
    assert.ok(block.includes("when: chatSurface"), "when must be the fork's composerFocused port (chatSurface)");
  });

  it("both actions are registered, in binary class order", () => {
    const src = stripComments(fs.readFileSync(ACTIONS_TS, "utf8"));
    const plain = src.indexOf("registerAction2(ComposerCancelComposerStepAction);");
    const focused = src.indexOf("registerAction2(ComposerCancelComposerStepInputFocusedAction);");
    assert.ok(plain >= 0 && focused >= 0, "both actions must be registered");
    assert.ok(
      plain < focused,
      "registration order must follow the binary (cancelComposerStep @39862622 before cancelComposerStepInputFocused @39865699)",
    );
  });

  it("the fork-invented composer.cancelAgentStep core id is gone", () => {
    const code = stripComments(fs.readFileSync(ACTIONS_TS, "utf8"));
    assert.ok(
      !code.includes("static readonly ID = 'composer.cancelAgentStep'"),
      "fork-invented composer.cancelAgentStep must be removed — the binary has no such command id",
    );
  });

  it("both actions delegate to the extension runtime ide.cancelAgentStep", () => {
    for (const cls of ["ComposerCancelComposerStepAction", "ComposerCancelComposerStepInputFocusedAction"]) {
      const block = stripComments(coreActionBlock(cls));
      assert.ok(
        block.includes("executeCommand('ide.cancelAgentStep'"),
        `${cls} must delegate run to ide.cancelAgentStep`,
      );
    }
  });

  it("composer.cancelChat: the palette-invisible programmatic member of the trio", () => {
    // DEV-GAPS-64/W64D: binary-verbatim `composer.cancelChat` ("Cancel
    // Chat", workbench.glass.main.js 3.25.9 @39820510, class iAb):
    // {id:Kki,title:"Cancel Chat",f1:!1} — no keybinding, never in the
    // palette; the binary invokes it from menu surfaces.
    const block = stripComments(coreActionBlock("ComposerCancelChatAction"));
    assert.ok(block.includes("static readonly ID = 'composer.cancelChat'"), "wrong command id");
    assert.ok(block.includes("'Cancel Chat'"), 'title must be "Cancel Chat"');
    assert.ok(/f1:\s*false/.test(block), "binary f1:!1 — must NOT be in the palette");
    assert.ok(!/keybinding:/.test(block), "the binary registers no keybinding for this command");
    assert.ok(
      block.includes("executeCommand('ide.cancelAgentStep'"),
      "must share the ide.cancelAgentStep runtime",
    );
    const src = stripComments(fs.readFileSync(ACTIONS_TS, "utf8"));
    assert.ok(
      src.includes("registerAction2(ComposerCancelChatAction);"),
      "composer.cancelChat must be registered",
    );
  });
});

describe("cancel-generation shortcut — extension runtime ide.cancelAgentStep", () => {
  it("registers the ide.cancelAgentStep case exactly once", () => {
    const code = stripComments(fs.readFileSync(EXTENSION_TS, "utf8"));
    const hits = code.match(/case "ide\.cancelAgentStep":/g) ?? [];
    assert.strictEqual(hits.length, 1, `expected 1 case, found ${hits.length}`);
  });

  it("only aborts when a turn is running (the cancel affordance)", () => {
    const block = stripComments(extensionCaseBlock());
    assert.ok(block.includes("isRunning"), "handler must gate on the running state (binary shouldShowCancel)");
    assert.ok(block.includes("composer.abort("), "handler must abort the running step (the fork's cancelCurrentStep)");
  });

  it("does NOT restore the prompt (the binary does not)", () => {
    const block = stripComments(extensionCaseBlock());
    assert.ok(
      !/restoreQuery/.test(block),
      "handler must not pass restoreQuery — the binary's cancelComposerStep run does not restore the query (unlike the Stop button)",
    );
  });

  it("logs the binary trackEvent payload inspectably, per binary source", () => {
    const block = stripComments(extensionCaseBlock());
    assert.ok(block.includes("composer.cancel_chat"), "handler must log the binary's composer.cancel_chat event");
    // DEV-GAPS-64/W64E merge: the core actions forward their binary source
    // ("cmd_backspace" for composer.cancelComposerStep, "winctrl_c" for
    // composer.cancelComposerStepInputFocused); the handler interpolates it
    // into the payload and logs ONLY for those two binary sources —
    // composer.cancelChat forwards no source and the binary logs nothing
    // for it.
    assert.ok(
      block.includes('telemetrySource === "cmd_backspace"') && block.includes('telemetrySource === "winctrl_c"'),
      "handler must gate telemetry on the two binary sources",
    );
    assert.ok(
      block.includes("source=${telemetrySource}"),
      "handler must interpolate the forwarded binary source into the payload",
    );
  });

  it("does NOT invent the accept/reject-all branch", () => {
    const block = stripComments(extensionCaseBlock());
    assert.ok(
      !/rejectAll|acceptAll/i.test(block),
      "the binary's accept/reject-all branch has no fork analog (the engine applies edits directly) — it must stay a no-op, never invented",
    );
  });
});
