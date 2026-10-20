/**
 * chat-focus-followup wiring test (node:test, reads source — no vscode runtime).
 *
 * DEV-GAPS-73 (`chat-focus-followup`, Cursor binary parity): remeasure
 * 2026-10-20 flagged this as a "handler-less trap" — `composer.newFollowup`
 * (core) delegated to the extension's `ide.newFollowup`, which was only
 * DECLARED in the COMMANDS array and silently fell into the default
 * branch (dead `notifyScaffold` popup): the command did nothing.
 *
 * This test pins the wiring at both ends so the trap cannot silently
 * return:
 *  1. extension.ts COMMANDS declares `ide.newFollowup` (the palette entry).
 *  2. extension.ts has an explicit `case "ide.newFollowup":` whose handler
 *     reveals the chat surface and posts `{ type: "focusInput" }` to the
 *     webview — and does NOT delegate to notifyScaffold.
 *  3. the webview (`components/composer.ts`) handles `focusInput` by
 *     moving DOM focus into the composer input — the fork's follow-up
 *     input (the composer has a single input element, shared with
 *     ide.focusChatInput / ide.focusAgent).
 *
 * It reads the TypeScript SOURCES (not the compiled JS) because this
 * wiring is source-level; the compiled extension.js is not loadable
 * without a vscode runtime.
 *
 * Run after `tsc`:  node --test out/services/test/run-chat-focus-followup-tests.js
 */
import { describe, it } from "node:test";
import * as assert from "node:assert";
import * as fs from "node:fs";
import * as path from "node:path";

const SRC = path.resolve(__dirname, "..", "..", "..", "src");
const extensionTs = fs.readFileSync(path.join(SRC, "extension.ts"), "utf8");
const composerTs = fs.readFileSync(path.join(SRC, "components", "composer.ts"), "utf8");

describe("chat-focus-followup — DEV-GAPS-73 (handler-less trap regression)", () => {
  it("ide.newFollowup is declared in the COMMANDS table", () => {
    assert.ok(
      /{ id: "ide\.newFollowup", title: "Focus Chat Followup"/.test(extensionTs),
      "COMMANDS must declare ide.newFollowup (Focus Chat Followup)",
    );
  });

  it('the switch has an explicit case "ide.newFollowup" (not the default scaffold branch)', () => {
    const caseMatch = extensionTs.match(/case "ide\.newFollowup":([\s\S]*?)break;/);
    assert.ok(caseMatch, 'expected an explicit case "ide.newFollowup" in the switch');
    const body = caseMatch![1]!;
    assert.ok(
      body.includes('postToWebview({ type: "focusInput" })'),
      'the handler must post focusInput to the webview (the follow-up input focus mechanism)',
    );
    assert.ok(
      body.includes("focusChatSurface"),
      "the handler must reveal the chat surface before focusing (sidebar view OR chat editor tab)",
    );
    assert.ok(
      !body.includes("notifyScaffold"),
      "the handler must NOT fall back to the dead notifyScaffold popup",
    );
  });

  it("the webview handles 'focusInput' by focusing the composer input", () => {
    const focusCase = composerTs.match(/case 'focusInput':([\s\S]*?)break;/);
    assert.ok(focusCase, "the webview must handle the focusInput host message");
    assert.ok(
      focusCase![1]!.includes("inputEl.focus()"),
      "focusInput must move DOM focus into the composer input (the fork's single follow-up input)",
    );
  });

  it("a companion case for the legacy trap cannot exist twice (one registration)", () => {
    const occurrences = extensionTs.match(/case "ide\.newFollowup":/g) ?? [];
    assert.equal(occurrences.length, 1);
  });

  it("the handler inserts the editor selection first (binary insertSelection:!0, DEV-GAPS-81)", () => {
    const caseMatch = extensionTs.match(/case "ide\.newFollowup":([\s\S]*?)break;/);
    assert.ok(caseMatch, 'expected an explicit case "ide.newFollowup" in the switch');
    const body = caseMatch![1]!;
    assert.ok(
      body.includes("buildEditorSelectionLabel"),
      "insertSelection must reuse the K-07 selection-label builder",
    );
    assert.ok(
      body.includes('postToWebview({ type: "addSelectionContext", label, content })'),
      "insertSelection must attach the selection as a context chip before focusing",
    );
    assert.ok(
      body.indexOf("addSelectionContext") < body.indexOf("focusInput"),
      "the selection chip must be posted before the focus message (binary order: insert, then focusMainInputBox)",
    );
  });

  it("the core keybinding matches the binary verbatim (weight 410, mac chord, NO when) — DEV-GAPS-81", () => {
    const coreActions = fs.readFileSync(
      path.resolve(
        SRC, "..", "..", "..",
        "src", "vs", "workbench", "contrib", "composer", "browser", "composerActions.ts",
      ),
      "utf8",
    );
    assert.ok(
      coreActions.includes("const newFollowupKeybindingWeight = 410 as KeybindingWeight"),
      "binary weight 410 must be the named cast const (fork enum maxes at 400)",
    );
    const cls = coreActions.match(/class ComposerNewFollowupAction[\s\S]*?async run/);
    assert.ok(cls, "ComposerNewFollowupAction must exist in core composerActions.ts");
    const body = cls![0];
    assert.ok(body.includes("weight: newFollowupKeybindingWeight"), "action must use weight 410");
    assert.ok(
      body.includes("primary: KeyMod.CtrlCmd | KeyCode.KeyY"),
      "primary must be CtrlCmd+KeyY",
    );
    assert.ok(
      body.includes("mac: { primary: KeyMod.CtrlCmd | KeyMod.Shift | KeyCode.KeyY }"),
      "mac primary must be CtrlCmd+Shift+KeyY (binary JiI platform ternary)",
    );
    assert.ok(
      !body.includes("chatInputFocused"),
      "the binary binding has NO when-clause — chatInputFocused must not gate it",
    );
  });
});
