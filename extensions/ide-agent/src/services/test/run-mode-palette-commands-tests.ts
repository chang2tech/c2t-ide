/**
 * WORKER-GAPS-20E tests (node:test, no vscode dependency).
 *
 * Guards the "Open Chat in X Mode" palette-command parity
 * (Cursor binary workbench.glass.main.js 3.25.9; auditor run 26 P2 + run 27):
 *   src/vs/workbench/contrib/composer/common/composerModeCommands.ts
 *
 * QA STEP 1 (adversarial, binary-first): the task brief claimed Cursor
 * registers SEVEN palette commands (Agent/Triage/Plan/Spec/Debug/Multitask/
 * Ask). The binary refutes this: registerExistingModeActions() iterates
 * getAllModes(), and getAllModes() filters out ["spec","triage"] BEFORE the
 * loop. Complete call-site enumeration of registerModeAction in 3.25.9 shows
 * no other startup path registers triage/spec (the only other sites are
 * maybeRegisterBackgroundModeAction — background mode only — and
 * saveModeKeybinding — user-initiated, with no UI path listing triage/spec).
 * So Cursor has EXACTLY FIVE "Open Chat in X Mode" palette commands:
 *   composerMode.agent, composerMode.plan, composerMode.chat ("Ask"),
 *   composerMode.debug, composerMode.multitask
 * — title template `Open Chat in ${name} Mode`, f1:!0, no category.
 * Per the QA 2-step rule the triage/spec commands are therefore REJECTED, not
 * added: this test pins the 5-command set and fails if triage/spec appear.
 *
 * Two layers, like the sibling run-custom-modes-tests.ts:
 *  1. Verbatim source checks — actionIds, title template, f1, no category,
 *     and the core registration loop in composerActions.ts.
 *  2. Behavioral checks — the pure core module is transpiled with
 *     typescript.transpileModule and executed for real.
 *
 * Run after `tsc`:
 *   node --test out/services/test/run-mode-palette-commands-tests.js
 */
import { describe, it } from "node:test";
import * as assert from "node:assert";
import * as fs from "node:fs";
import * as path from "node:path";
import * as ts from "typescript";

const repoRoot = path.join(__dirname, "..", "..", "..", "..", "..");
const corePath = path.join(
  repoRoot,
  "src",
  "vs",
  "workbench",
  "contrib",
  "composer",
  "common",
  "composerModeCommands.ts",
);
const composerActionsPath = path.join(
  repoRoot,
  "src",
  "vs",
  "workbench",
  "contrib",
  "composer",
  "browser",
  "composerActions.ts",
);
const extensionPath = path.join(
  __dirname,
  "..",
  "..",
  "..",
  "src",
  "extension.ts",
);

const src = fs.readFileSync(corePath, "utf8");
const actionsSrc = fs.readFileSync(composerActionsPath, "utf8");
const extensionSrc = fs.readFileSync(extensionPath, "utf8");

// --- behavioral: transpile the zero-dependency core module and load it ---
const js = ts.transpileModule(src, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const mod = { exports: {} as Record<string, unknown> };
// The module has no imports; `require` is passed but never called.
new Function("module", "exports", "require", js)(
  mod,
  mod.exports,
  require,
);
const M = mod.exports as Record<string, any>;

const EXPECTED: Array<[modeId: string, actionId: string, name: string, extensionCommand: string]> = [
  ["agent", "composerMode.agent", "Agent", "ide.setAgentMode"],
  ["plan", "composerMode.plan", "Plan", "ide.setPlanMode"],
  ["chat", "composerMode.chat", "Ask", "ide.setAskMode"],
  ["debug", "composerMode.debug", "Debug", "ide.setDebugMode"],
  ["multitask", "composerMode.multitask", "Multitask", "ide.setMultitaskMode"],
];

describe("composerModeCommands — binary-pinned palette set", () => {
  it("registers exactly 5 mode commands (no triage, no spec)", () => {
    assert.ok(Array.isArray(M.COMPOSER_MODE_COMMANDS));
    assert.strictEqual(M.COMPOSER_MODE_COMMANDS.length, 5);
    for (const def of M.COMPOSER_MODE_COMMANDS) {
      assert.ok(!/triage|spec/i.test(def.modeId), `unexpected modeId ${def.modeId}`);
      assert.ok(!/triage|spec/i.test(def.actionId), `unexpected actionId ${def.actionId}`);
      assert.ok(!/triage|spec/i.test(def.name), `unexpected name ${def.name}`);
    }
  });

  it("uses the Cursor-verbatim actionIds, names and extension delegation", () => {
    const rows = M.COMPOSER_MODE_COMMANDS.map((d: any) => [
      d.modeId,
      d.actionId,
      d.name,
      d.extensionCommand,
    ]);
    assert.deepStrictEqual(rows, EXPECTED);
  });

  it("title template is the binary's `Open Chat in ${name} Mode`", () => {
    for (const [, , name] of EXPECTED) {
      assert.strictEqual(
        M.buildComposerModeCommandTitle(name),
        `Open Chat in ${name} Mode`,
      );
    }
    // The "chat" wire id surfaces as "Ask" in the palette title.
    const chat = M.COMPOSER_MODE_COMMANDS.find((d: any) => d.modeId === "chat");
    assert.strictEqual(M.buildComposerModeCommandTitle(chat.name), "Open Chat in Ask Mode");
  });

  it("title keys are static and unique per entry", () => {
    const keys = M.COMPOSER_MODE_COMMANDS.map((d: any) => M.composerModeCommandTitleKey(d));
    assert.strictEqual(new Set(keys).size, 5);
    for (const k of keys) {
      assert.ok(typeof k === "string" && k.length > 0);
    }
  });

  it("every extensionCommand exists in the ide-agent COMMANDS array", () => {
    for (const [, , , extCmd] of EXPECTED) {
      assert.ok(
        extensionSrc.includes(`"${extCmd}"`),
        `extension.ts does not register ${extCmd}`,
      );
    }
  });
});

describe("composerActions.ts — loop registration (binary mechanism)", () => {
  it("imports the pure mode-command table", () => {
    assert.ok(
      actionsSrc.includes("from '../common/composerModeCommands.js'"),
      "missing import of ../common/composerModeCommands.js",
    );
    assert.ok(actionsSrc.includes("COMPOSER_MODE_COMMANDS"));
  });

  it("registers via a loop mirroring registerExistingModeActions()", () => {
    assert.ok(
      actionsSrc.includes("export function registerComposerModeActions()"),
      "registerComposerModeActions() not defined",
    );
    assert.ok(actionsSrc.includes("registerComposerModeActions();"), "loop not invoked");
    assert.ok(
      actionsSrc.includes("for (const def of COMPOSER_MODE_COMMANDS)"),
      "registration is not a per-entry loop",
    );
  });

  it("uses the verbatim actionId, title template and f1:!0 — no category", () => {
    const fnStart = actionsSrc.indexOf("export function registerComposerModeActions()");
    const fnEnd = actionsSrc.indexOf("export class ComposerOpenDocsAction", fnStart);
    const fnSrc = actionsSrc.slice(fnStart, fnEnd);
    assert.ok(fnSrc.includes("id: def.actionId"), "command id must be the verbatim actionId");
    assert.ok(fnSrc.includes("buildComposerModeCommandTitle(def.name)"), "title template not used");
    assert.ok(/f1:\s*true/.test(fnSrc), "palette visibility f1:!0 missing");
    assert.ok(!/category/.test(fnSrc), "binary has no category on these commands");
  });

  it("no invented composer.set*Mode command ids remain", () => {
    assert.ok(!/composer\.set(Agent|Plan|Ask|Debug|Multitask)Mode/.test(actionsSrc));
  });

  it("run() still delegates to the ide-agent extension command", () => {
    const fnStart = actionsSrc.indexOf("export function registerComposerModeActions()");
    const fnEnd = actionsSrc.indexOf("export class ComposerOpenDocsAction", fnStart);
    const fnSrc = actionsSrc.slice(fnStart, fnEnd);
    assert.ok(fnSrc.includes("executeCommand(def.extensionCommand"), "delegation to ide.* command lost");
  });
});
