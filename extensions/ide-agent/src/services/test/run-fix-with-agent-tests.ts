/**
 * fix-with-agent tests (node:test, vscode stubbed via ./vscode-stub).
 *
 * DEV-GAPS-83 (`agent-fix-with-agent-error`, Cursor 3.25.9 parity): pins
 * the VERBATIM pieces of `fixLinterErrorWithAI` recovered from
 * workbench.glass.main.js (byte ~40267498) — the exact prompt text, the
 * ±1/+2-line context widening, the generating-dedupe guard, the
 * addToCurrent create-new-chat branch, and the hover telemetry event
 * `hover_bar.submit_fix` with `{ useCurrent, mode: "edit" }`.
 *
 * Run after `tsc`:  node --test out/services/test/run-fix-with-agent-tests.js
 */
import { describe, it } from "node:test";
import * as assert from "node:assert";
import * as fs from "node:fs";
import * as path from "node:path";
import "./vscode-stub";
import {
  buildFixLinterPrompt,
  fixContextLines,
  fixErrorWithAgent,
  FIX_WITH_AGENT_TELEMETRY_EVENT,
  type FixWithAgentSeam,
} from "../fixWithAgentService";

class StubSeam implements FixWithAgentSeam {
  readonly submitted: string[] = [];
  readonly chips: Array<{ label: string; content: string }> = [];
  readonly events: Array<{ name: string; data: Record<string, unknown> }> = [];
  newChats = 0;
  focused = 0;
  lastHuman: string | undefined;
  generating = false;
  docLines: string[] | undefined;

  async openDocument(_uriString: string) {
    if (!this.docLines) {
      return undefined;
    }
    const lines = this.docLines;
    return {
      lineCount: lines.length,
      getLines: (startLine: number, endLine: number) => lines.slice(startLine - 1, endLine).join("\n"),
    };
  }
  lastHumanBubbleText(): string | undefined {
    return this.lastHuman;
  }
  isGenerating(): boolean {
    return this.generating;
  }
  async createNewChat(): Promise<void> {
    this.newChats += 1;
  }
  addSelectionContext(label: string, content: string): void {
    this.chips.push({ label, content });
  }
  submit(prompt: string): void {
    this.submitted.push(prompt);
  }
  async focusChat(): Promise<void> {
    this.focused += 1;
  }
  trackEvent(name: string, data: Record<string, unknown>): void {
    this.events.push({ name, data });
  }
}

const RANGE = { startLineNumber: 5, startColumn: 3, endLineNumber: 5, endColumn: 20 };

describe("fix-with-agent — DEV-GAPS-83 (Cursor 3.25.9 parity)", () => {
  it("prompt is byte-identical to the binary's fixLinterErrorWithAI prompt", () => {
    assert.equal(
      buildFixLinterPrompt("Cannot find name 'foo'."),
      "For the code present, we get this error:\n```\nCannot find name 'foo'.\n```\nFix it, verify, and then give a concise explanation.",
    );
  });

  it("context lines widen by -1/+2 and clamp to the document", () => {
    assert.deepEqual(fixContextLines(RANGE, 100), { startLine: 4, endLine: 7 });
    assert.deepEqual(fixContextLines({ ...RANGE, startLineNumber: 1, endLineNumber: 100 }, 100), { startLine: 1, endLine: 100 });
    assert.deepEqual(fixContextLines({ ...RANGE, startLineNumber: 2, endLineNumber: 99 }, 100), { startLine: 1, endLine: 100 });
  });

  it("submits the verbatim prompt, attaches the widened code chip, fires hover telemetry", async () => {
    const seam = new StubSeam();
    seam.docLines = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`);
    const ok = await fixErrorWithAgent(
      { uriString: "file:///ws/a.ts", errorMessage: "Boom", range: RANGE, addToCurrent: true },
      seam,
    );
    assert.equal(ok, true);
    assert.deepEqual(seam.submitted, [buildFixLinterPrompt("Boom")]);
    assert.equal(seam.newChats, 0);
    assert.equal(seam.chips.length, 1);
    assert.equal(seam.chips[0].label, "a.ts:4-7");
    assert.equal(seam.chips[0].content, "line 4\nline 5\nline 6\nline 7");
    assert.deepEqual(seam.events, [{ name: FIX_WITH_AGENT_TELEMETRY_EVENT, data: { useCurrent: true, mode: "edit" } }]);
    assert.equal(FIX_WITH_AGENT_TELEMETRY_EVENT, "hover_bar.submit_fix");
    assert.equal(seam.focused, 1);
  });

  it("addToCurrent=false creates a new chat first (hover Ctrl/Cmd+click)", async () => {
    const seam = new StubSeam();
    seam.docLines = ["only line"];
    const ok = await fixErrorWithAgent(
      { uriString: "file:///ws/b.ts", errorMessage: "Bad", range: { startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 4 }, addToCurrent: false },
      seam,
    );
    assert.equal(ok, true);
    assert.equal(seam.newChats, 1);
    assert.deepEqual(seam.events[0].data, { useCurrent: false, mode: "edit" });
    assert.equal(seam.submitted.length, 1);
  });

  it("generating-dedupe: same prompt as last human bubble while generating is a no-op", async () => {
    const seam = new StubSeam();
    seam.docLines = ["x"];
    seam.generating = true;
    seam.lastHuman = buildFixLinterPrompt("Boom");
    const ok = await fixErrorWithAgent(
      { uriString: "file:///ws/a.ts", errorMessage: "Boom", range: RANGE, addToCurrent: true },
      seam,
    );
    assert.equal(ok, false);
    assert.equal(seam.submitted.length, 0);
    assert.equal(seam.newChats, 0);
  });

  it("dedupe does NOT fire when not generating, or when the prompt differs", async () => {
    const seam = new StubSeam();
    seam.docLines = ["x"];
    seam.generating = false;
    seam.lastHuman = buildFixLinterPrompt("Boom");
    assert.equal(
      await fixErrorWithAgent({ uriString: "file:///ws/a.ts", errorMessage: "Boom", range: RANGE, addToCurrent: true }, seam),
      true,
    );
    const seam2 = new StubSeam();
    seam2.docLines = ["x"];
    seam2.generating = true;
    seam2.lastHuman = buildFixLinterPrompt("Other");
    assert.equal(
      await fixErrorWithAgent({ uriString: "file:///ws/a.ts", errorMessage: "Boom", range: RANGE, addToCurrent: true }, seam2),
      true,
    );
  });

  it("unopenable document is a no-op (no submit, no new chat)", async () => {
    const seam = new StubSeam();
    seam.docLines = undefined;
    const ok = await fixErrorWithAgent(
      { uriString: "file:///missing.ts", errorMessage: "Boom", range: RANGE, addToCurrent: false },
      seam,
    );
    assert.equal(ok, false);
    assert.equal(seam.submitted.length, 0);
    assert.equal(seam.newChats, 0);
  });
});

describe("fix-with-agent core wiring — DEV-GAPS-83 (source assertions)", () => {
  function coreFile(...segments: string[]): string {
    const p = path.join(
      __dirname, "..", "..", "..", "..", "..",
      "src", "vs", ...segments,
    );
    return fs.readFileSync(p, "utf8");
  }

  it("core contribution registers the verbatim command id + contribution id", () => {
    const common = coreFile("workbench", "contrib", "composer", "common", "fixWithAgent.ts");
    const actions = coreFile("workbench", "contrib", "composer", "browser", "aiFixCodeActions.ts");
    const contribution = coreFile("workbench", "contrib", "composer", "browser", "composer.contribution.ts");
    assert.ok(common.includes("'editor.action.fixInAgent'"));
    assert.ok(common.includes("'workbench.contrib.aiFixCodeActions'"));
    assert.ok(common.includes("'composer.isCursorOnLint'"));
    assert.ok(actions.includes("CommandsRegistry.registerCommand(FIX_IN_AGENT_COMMAND_ID"));
    assert.ok(actions.includes("codeActionProvider.register('*', provider)"));
    assert.ok(actions.includes("'ide.fixWithAgent'"));
    assert.ok(contribution.includes("registerWorkbenchContribution(AiFixCodeActionsContribution"));
  });

  it("core CodeAction title is the verbatim 'Fix in Agent' (not 'Fix with Agent')", () => {
    const common = coreFile("workbench", "contrib", "composer", "common", "fixWithAgent.ts");
    assert.ok(common.includes("FIX_IN_AGENT_ACTION_TITLE = 'Fix in Agent'"));
    assert.ok(common.includes("FIX_WITH_AGENT_HOVER_LABEL = 'Fix with Agent'"));
  });

  it("marker hover participant renders the Fix with Agent button + hint", () => {
    const hover = coreFile("editor", "contrib", "hover", "browser", "markerHoverParticipant.ts");
    assert.ok(hover.includes("div.fix-buttons-container"));
    assert.ok(hover.includes("div.fix-buttons-row"));
    assert.ok(hover.includes("div.fix-buttons-hint"));
    assert.ok(hover.includes("'Fix with Agent' + (investigateKeybinding ? ` (${investigateKeybinding.getLabel()})` : '')"));
    assert.ok(hover.includes("lookupKeybinding('composer.investigateError')"));
    assert.ok(hover.includes("button.fix-in-composer"));
    assert.ok(hover.includes("fix-in-composer-button-hover"));
    assert.ok(hover.includes("+click to open in new tab"));
    assert.ok(hover.includes("+click to fix in new chat"));
    assert.ok(hover.includes("executeCommand('editor.action.fixInAgent'"));
  });
});
