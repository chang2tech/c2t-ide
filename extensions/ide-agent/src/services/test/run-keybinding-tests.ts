/**
 * DEV-KEYBOARD-FIX tests (node:test, no vscode dependency).
 *
 * Guards the Cursor 3.25.9 keybinding parity table. The table MIGRATED from
 * package.json (contributes.keybindings) to workbench core:
 *   src/vs/workbench/contrib/composer/browser/composerActions.ts
 * (Action2 descriptors + KeybindingsRegistry rules). Command ids moved
 * `ide.*` -> `composer.*`; `when` clauses moved `ideAgent.*` -> `composer.*`
 * context keys (see docs/rea/contributes-migration-map.md).
 *
 * This test parses composerActions.ts (no vscode runtime needed) and asserts:
 *  - every keybinding points at a real registered command id;
 *  - every keybinding has a primary chord and a plausible when clause;
 *  - no two bindings share the exact same (platform chords, when) for
 *    different commands (accidental shadowing);
 *  - the 13 P1 gaps from dig-deeper-keyboard-2026-10-19.md stay fixed.
 *
 * Run after `tsc`:  node --test out/services/test/run-keybinding-tests.js
 */
import { describe, it } from "node:test";
import * as assert from "node:assert";
import * as fs from "node:fs";
import * as path from "node:path";

const actionsPath = path.join(
  __dirname,
  "..",
  "..",
  "..",
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
// WORKER-GAPS-36C (inline-edit-command-ids): the Cursor inline-diff family
// (`editor.action.inlineDiffs.*`) lives in inlineDiffActions.ts — parse it too
// so its keybindings are covered by the same guards.
const inlineDiffActionsPath = path.join(
  __dirname,
  "..",
  "..",
  "..",
  "..",
  "..",
  "src",
  "vs",
  "workbench",
  "contrib",
  "composer",
  "browser",
  "inlineDiffActions.ts",
);
const src =
  fs.readFileSync(actionsPath, "utf8") +
  "\n" +
  fs.readFileSync(inlineDiffActionsPath, "utf8");

interface Binding {
  command: string;
  /** effective chords per platform, normalized like "ctrl+shift+t" */
  key: string; // win/linux (default)
  mac: string;
  win: string;
  linux: string;
  when: string; // raw TS when-expression text ("" when absent)
}

const MOD_ORDER = ["ctrl", "cmd", "shift", "alt"];

/** "KeyMod.CtrlCmd | KeyCode.KeyT" -> { mods: ["ctrl"], key: "t" } (platform-aware). */
function parseChordExpr(expr: string, platform: "key" | "mac"): string {
  const mods: string[] = [];
  let key = "";
  for (const tok of expr.split("|").map((t) => t.trim())) {
    if (tok === "KeyMod.CtrlCmd") {
      mods.push(platform === "mac" ? "cmd" : "ctrl");
    } else if (tok === "KeyMod.WinCtrl") {
      mods.push("ctrl"); // physical Ctrl on every platform
    } else if (tok === "KeyMod.Shift") {
      mods.push("shift");
    } else if (tok === "KeyMod.Alt") {
      mods.push("alt");
    } else if (tok.startsWith("KeyCode.")) {
      const name = tok.slice("KeyCode.".length);
      const m = /^Key([A-Z])$/.exec(name);
      const d = /^Digit(\d)$/.exec(name);
      const f = /^F(\d+)$/.exec(name);
      const np = /^Numpad(\d)$/.exec(name);
      if (m) {
        key = m[1]!.toLowerCase();
      } else if (d) {
        key = d[1]!;
      } else if (f) {
        // DEV-GAPS-89: generic F1-F24 (was: only F3 hard-coded below).
        key = `f${f[1]!}`;
      } else if (np) {
        key = `numpad${np[1]!}`;
      } else {
        // DEV-GAPS-89: completed against the KeyCode mapping table in
        // src/vs/base/common/keyCodes.ts (keyCodeStr / US user-settings
        // label). Quote ("'") was the crasher: binary-verbatim
        // CtrlCmd+Quote for cursor.openBranchMenu (composerActions.ts).
        // The remaining punctuation + named keys are the rest of that
        // table's chord-plausible entries, so a future parity chord
        // cannot crash this parser the same way again.
        const map: Record<string, string> = {
          Enter: "enter",
          Escape: "escape",
          Backspace: "backspace",
          Tab: "tab",
          Space: "space",
          UpArrow: "up",
          DownArrow: "down",
          LeftArrow: "left",
          RightArrow: "right",
          Slash: "/",
          BracketLeft: "[",
          BracketRight: "]",
          Period: ".",
          Quote: "'",
          Backquote: "`",
          Backslash: "\\",
          Semicolon: ";",
          Comma: ",",
          Minus: "-",
          Equal: "=",
          Delete: "delete",
          Insert: "insert",
          Home: "home",
          End: "end",
          PageUp: "pageup",
          PageDown: "pagedown",
          PauseBreak: "pausebreak",
          CapsLock: "capslock",
          NumLock: "numlock",
          ScrollLock: "scrolllock",
          ContextMenu: "contextmenu",
          NumpadMultiply: "numpadmultiply",
          NumpadAdd: "numpadadd",
          NumpadSubtract: "numpadsubtract",
          NumpadDecimal: "numpaddecimal",
          NumpadDivide: "numpaddivide",
          OEM_8: "oem_8",
          IntlBackslash: "intlbackslash",
        };
        if (!map[name]) {
          throw new Error(`unknown KeyCode in test parser: ${tok}`);
        }
        key = map[name]!;
      }
    } else {
      throw new Error(`unknown chord token in test parser: ${tok}`);
    }
  }
  const ordered = MOD_ORDER.filter((m) => mods.includes(m));
  return [...ordered, key].join("+");
}

function exprAfter(line: string, prefix: string): string {
  return line.slice(line.indexOf(prefix) + prefix.length).replace(/,\s*$/, "").trim();
}

/** Parse one keybinding rule object (array of its source lines). */
function parseRule(
  command: string,
  ruleLines: string[],
): Binding {
  let primary = "";
  let mac = "";
  let win = "";
  let linux = "";
  let when = "";
  for (let li = 0; li < ruleLines.length; li++) {
    const line = ruleLines[li]!.trim();
    if (line.startsWith("primary:")) {
      primary = exprAfter(line, "primary:");
    } else if (/^(mac|win|linux):\s*\{/.test(line)) {
      const plat = line.slice(0, line.indexOf(":"));
      const inner = /primary:\s*([^}]+)/.exec(line);
      if (!inner) {
        throw new Error(`cannot parse platform override: ${line}`);
      }
      // A platform override may carry `, secondary: [...]` after the primary
      // chord (e.g. cycleModelParameter's win secondary). We only assert the
      // primary chord here, so strip the secondary part before parsing.
      const expr = inner[1]!
        .replace(/,\s*secondary:\s*\[.*$/, "")
        .replace(/,\s*$/, "")
        .trim();
      if (plat === "mac") {
        mac = expr;
      } else if (plat === "win") {
        win = expr;
      } else {
        linux = expr;
      }
    } else if (line.startsWith("when:")) {
      // DEV-GAPS-3-HOTKEYS: when clauses may span multiple lines (e.g. a
      // multi-line ContextKeyExpr.and(...)). Join continuation lines until the
      // parentheses balance, so the parser doesn't choke on formatting.
      let w = exprAfter(line, "when:");
      let opens = (w.match(/\(/g) ?? []).length;
      let closes = (w.match(/\)/g) ?? []).length;
      while (opens > closes && li + 1 < ruleLines.length) {
        li++;
        const cont = ruleLines[li]!.trim().replace(/,\s*$/, "");
        w += ` ${cont}`;
        opens += (cont.match(/\(/g) ?? []).length;
        closes += (cont.match(/\)/g) ?? []).length;
      }
      when = w.replace(/,\s*$/, "").trim();
    }
  }
  if (!primary) {
    throw new Error(`keybinding rule for ${command} has no primary chord`);
  }
  // DEV-GAPS-3-HOTKEYS: Cursor 3.25.9 registers some rules with primary:0
  // (no generic chord; platform overrides only, e.g. cycleModelParameter).
  const unboundGeneric = primary.trim() === "0";
  const macExpr = unboundGeneric ? mac : mac || primary;
  const winExpr = unboundGeneric ? win : win || primary;
  const linuxExpr = unboundGeneric ? linux : linux || primary;
  return {
    command,
    key: unboundGeneric ? "" : parseChordExpr(primary, "key"),
    mac: macExpr ? parseChordExpr(macExpr, "mac") : "",
    win: winExpr ? parseChordExpr(winExpr, "key") : "",
    linux: linuxExpr ? parseChordExpr(linuxExpr, "key") : "",
    when,
  };
}

/** Extract top-level {...} rule blocks from a `keybinding: [...]` array region. */
function splitRuleBlocks(lines: string[], startIdx: number): string[][] {
  const blocks: string[][] = [];
  let depth = 0;
  let current: string[] = [];
  let inRule = false;
  for (let i = startIdx; i < lines.length; i++) {
    const line = lines[i]!;
    const opens = (line.match(/\{/g) ?? []).length;
    const closes = (line.match(/\}/g) ?? []).length;
    if (!inRule) {
      if (opens > 0) {
        inRule = true;
        depth = 0;
        current = [];
        // fall through: count this line's braces below
      } else if (/^\s*\],?\s*$/.test(line)) {
        break;
      } else {
        continue;
      }
    }
    depth += opens - closes;
    current.push(line);
    if (depth <= 0) {
      blocks.push(current);
      inRule = false;
      if (/^\s*\],?\s*$/.test(lines[i + 1] ?? "")) {
        break;
      }
    }
  }
  return blocks;
}

const bindings: Binding[] = [];
const actionIds = new Set<string>();

{
  const lines = src.split("\n");
  let i = 0;
  while (i < lines.length) {
    const classMatch = /export class (\w+) extends Action2 \{/.exec(lines[i]!);
    const ruleMatch = /KeybindingsRegistry\.registerKeybindingRule\(\{/.exec(lines[i]!);
    if (classMatch) {
      // collect the class chunk: from `export class` to its closing `}` at column 0
      const chunk: string[] = [];
      let j = i;
      while (j < lines.length) {
        chunk.push(lines[j]!);
        if (j > i && /^\}$/.test(lines[j]!)) {
          break;
        }
        j++;
      }
      const idMatch = /static readonly ID = '([^']+)'/.exec(chunk.join("\n"));
      if (!idMatch) {
        throw new Error(`action class without static ID near line ${i + 1}`);
      }
      const id = idMatch[1]!;
      actionIds.add(id);
      // (WORKER-GAPS-20C: skip comment lines — a docblock may quote a
      // `keybinding:` shape, e.g. the cmdk.togglePromptBarModel binary quote.)
      const kbIdx = chunk.findIndex((l) => {
        const t = l.trim();
        return !t.startsWith("//") && !t.startsWith("*") && /keybinding:\s*(\{|\[)/.test(l);
      });
      if (kbIdx >= 0) {
        const opener = /keybinding:\s*(\{|\[)/.exec(chunk[kbIdx]!)![1];
        if (opener === "[") {
          for (const block of splitRuleBlocks(chunk, kbIdx)) {
            bindings.push(parseRule(id, block));
          }
        } else {
          // single object form: until the closing "},"
          const ruleLines: string[] = [];
          let depth = 0;
          for (let k = kbIdx; k < chunk.length; k++) {
            const l = chunk[k]!;
            depth += (l.match(/\{/g) ?? []).length - (l.match(/\}/g) ?? []).length;
            ruleLines.push(l);
            if (k > kbIdx && depth <= 0) {
              break;
            }
          }
          bindings.push(parseRule(id, ruleLines));
        }
      }
      i = j + 1;
    } else if (ruleMatch) {
      const ruleLines: string[] = [];
      let depth = 0;
      let j = i;
      const idMatch = /id:\s*'([^']+)'/.exec(lines.slice(i, i + 3).join("\n"));
      if (!idMatch) {
        throw new Error(`registerKeybindingRule without id near line ${i + 1}`);
      }
      while (j < lines.length) {
        const l = lines[j]!;
        depth += (l.match(/\{/g) ?? []).length - (l.match(/\}/g) ?? []).length;
        ruleLines.push(l);
        j++;
        if (j > i && depth <= 0) {
          break;
        }
      }
      bindings.push(parseRule(idMatch[1]!, ruleLines));
      i = j;
    } else {
      i++;
    }
  }
}

// Commands owned by other core contributions (keybinding rules only, no
// Action2 in composerActions.ts).
const coreOwned = new Set([
  "workbench.action.focusActiveEditorGroup",
  "workbench.action.terminal.focus",
  "workbench.action.toggleDevTools",
]);

function isKnownCommand(cmd: string): boolean {
  return actionIds.has(cmd) || coreOwned.has(cmd);
}

const norm = (s: string): string => s.toLowerCase();

function bindingsFor(key: string, platform: "key" | "mac" = "key"): Binding[] {
  return bindings.filter((b) => norm(b[platform]) === key.toLowerCase());
}

describe("keybindings table — structural integrity", () => {
  it("composerActions.ts yields a non-empty keybindings table", () => {
    assert.ok(bindings.length > 0, "no keybindings parsed from composerActions.ts");
  });

  it("every keybinding targets a real command", () => {
    const unknown = bindings.filter((b) => !isKnownCommand(b.command));
    assert.deepEqual(
      unknown.map((b) => b.command),
      [],
      `unknown commands: ${JSON.stringify(unknown)}`,
    );
  });

  it("every keybinding has a primary chord and a plausible when clause", () => {
    for (const b of bindings) {
      // DEV-GAPS-3-HOTKEYS: binary rules may set primary:0 (no generic
      // chord); then mac+win+linux overrides must ALL be present.
      if (b.key.length === 0) {
        assert.ok(
          b.mac.length > 0 && b.win.length > 0 && b.linux.length > 0,
          `${b.command} has primary:0 but is missing a platform override`,
        );
      }
      if (b.when) {
        const opens = (b.when.match(/\(/g) ?? []).length;
        const closes = (b.when.match(/\)/g) ?? []).length;
        assert.equal(opens, closes, `${b.command}: unbalanced parens in when "${b.when}"`);
      }
    }
  });

  it("no exact (key, mac, win, linux, when) duplicate across different commands", () => {
    const seen = new Map<string, string>();
    // WORKER-GAPS-36C (inline-edit-command-ids, P1): Cursor DELIBERATELY binds
    // the same chord to two commands — `editor.action.inlineDiffs.rejectAll`
    // ("Undo Edits", weight 500) and `editor.action.inlineDiffs.cancelEdits`
    // ("Cancel Edits", weight 600). The resolver picks by weight (600 wins
    // while generating); the preconditions are also disjoint
    // (inlineDiffs.activeEditorWithDiffs vs hasActivelyGeneratingDiff).
    // Binary: workbench.glass.main.js 3.25.9 @22686678 + cancelEdits
    // registration. This pair is an intentional shared chord, not a bug.
    const intentionalSharedChords = new Set([
      "editor.action.inlineDiffs.rejectAll|editor.action.inlineDiffs.cancelEdits",
      "editor.action.inlineDiffs.cancelEdits|editor.action.inlineDiffs.rejectAll",
    ]);
    for (const b of bindings) {
      const sig = [b.key, b.mac, b.win, b.linux, b.when].join("|");
      const prev = seen.get(sig);
      if (prev !== undefined) {
        const pair = [prev, b.command].sort().join("|");
        if (intentionalSharedChords.has(pair)) {
          continue;
        }
        assert.equal(prev, b.command, `duplicate binding signature for ${prev} and ${b.command}: ${sig}`);
      } else {
        seen.set(sig, b.command);
      }
    }
  });
});

describe("keybindings — P1 Cursor parity (dig-deeper-keyboard-2026-10-19.md)", () => {
  it("P1-3: Ctrl+/ is SHARED Cursor-style: Select Model wins by weight over cmdk.togglePromptBarModel", () => {
    // Binary evidence (workbench.glass.main.js @40750679 / @45366438, quoted in
    // composerActions.ts) + Cursor forum (team member deanrie): Cursor SHARES
    // CtrlCmd+/ between cmdk.togglePromptBarModel ("Open model toggle", weight
    // 200 = WorkbenchContrib, when editorHasPromptBar && editorPromptBarFocused)
    // and glass.openModelPicker ("Select Model", weight 250 = SessionsContrib,
    // when !terminalFocusInAny && !editorTextFocus, NO secondary chord). The
    // resolver picks by WEIGHT (250 > 200), not by exclusivity — so exactly
    // these two bindings must own the chord, nothing else.
    const all = bindingsFor("ctrl+/");
    const cmds = all.map((b) => b.command).sort();
    assert.deepEqual(
      cmds,
      ["cmdk.togglePromptBarModel", "composer.openModelPicker"],
      `ctrl+/ must be shared by exactly the two Cursor commands, got ${JSON.stringify(all)}`,
    );
    const toggle = all.find((b) => b.command === "cmdk.togglePromptBarModel")!;
    const picker = all.find((b) => b.command === "composer.openModelPicker")!;
    assert.ok(
      toggle.when.includes("editorHasPromptBar") && toggle.when.includes("editorPromptBarFocused"),
      `togglePromptBarModel when must scope to the prompt bar, got: ${toggle.when}`,
    );
    assert.ok(
      picker.when.includes("editorTextFocus.negate()"),
      `openModelPicker when must exclude editor text focus, got: ${picker.when}`,
    );
    // mac: both share Cmd+/
    const macCmds = bindingsFor("cmd+/", "mac")
      .map((b) => b.command)
      .sort();
    assert.deepEqual(macCmds, ["cmdk.togglePromptBarModel", "composer.openModelPicker"]);
  });

  it("P1-3: composer.cycleModel is off Ctrl+/", () => {
    for (const b of bindings) {
      if (b.command === "composer.cycleModel") {
        assert.notEqual(b.key, "ctrl+/");
        assert.notEqual(b.mac, "cmd+/");
      }
    }
  });

  // DEV-GAPS-3-HOTKEYS (Cursor 3.25.9 binary): composer.cycleModel (lQp) has NO
  // keybinding in the binary — it appears only in the model dropdown menu.
  // The Slash chords belong to the separate composer.cycleModelParameter
  // command. This replaces the old test that encoded the DEV-KEYBOARD-FIX
  // mis-mapping.
  it("P1-3: composer.cycleModel has NO keybinding (Cursor binds nothing for it)", () => {
    const ours = bindings.filter((x) => x.command === "composer.cycleModel");
    assert.deepEqual(
      ours.map((x) => x.command),
      [],
      `composer.cycleModel must have no keybinding, got ${JSON.stringify(ours)}`,
    );
  });

  it("P1-3: composer.cycleModelParameter owns Cursor's Cycle Model Parameter keys (win ctrl+alt+/, mac cmd+shift+/, linux ctrl+shift+/, no generic chord)", () => {
    const b = bindings.find((x) => x.command === "composer.cycleModelParameter");
    assert.ok(b, "composer.cycleModelParameter has no keybinding");
    assert.equal(b!.win, "ctrl+alt+/");
    assert.equal(b!.linux, "ctrl+shift+/");
    assert.equal(b!.mac, "cmd+shift+/");
    assert.equal(b!.key, "", "binary primary:0 — no generic chord");
  });

  // DEV-GAPS-29 (chat-focus-agent-hotkey fix, 2026-10-20): adversarial
  // re-verify — the binary registration (workbench.glass.main.js @HAb.ID=oQp)
  // is {id:"composer.focusComposer", title:"Focus Agent", f1:!0, category
  // Cursor} with NO keybinding field, and no keybinding rule references the
  // id. The earlier "CtrlCmd+." claim was REFUTED (feature-matrix.json
  // CORRECTION 2026-10-20): in 3.25.6/3.25.9 CtrlCmd+. (weight 600) is bound
  // to composer.openModeMenu. The fork registers the binary-verbatim id;
  // composer.focusAgent stays as a palette-invisible alias.
  it("P1-3: composer.focusComposer exists, title 'Focus Agent', NO keybinding (binary has none; Ctrl+. is openModeMenu)", () => {
    const ours = bindings.filter((x) => x.command === "composer.focusComposer");
    assert.deepEqual(
      ours.map((x) => x.command),
      [],
      `composer.focusComposer must have no keybinding, got ${JSON.stringify(ours)}`,
    );
    assert.ok(actionIds.has("composer.focusComposer"), "composer.focusComposer action missing");
    assert.ok(
      /static readonly ID = 'composer\.focusComposer'/.test(src),
      "ComposerFocusAgentAction.ID must be the binary-verbatim 'composer.focusComposer'",
    );
    assert.ok(
      /title: localize2\('composer\.focusComposer', 'Focus Agent'\)/.test(src),
      "title must be verbatim 'Focus Agent'",
    );
    assert.ok(
      src.includes("CommandsRegistry.registerCommand('composer.focusAgent'"),
      "legacy alias composer.focusAgent must stay registered",
    );
    // The Ctrl+. chord must NOT be double-bound here — it belongs to the
    // mode menu (binary-verbatim weight 600).
    const period = bindings.filter((x) => x.key === "ctrl+." || x.mac === "cmd+.");
    assert.ok(
      period.every((b) => b.command !== "composer.focusComposer"),
      `composer.focusComposer must not bind Ctrl+., got ${JSON.stringify(period)}`,
    );
    assert.ok(actionIds.has("composer.cycleModelParameter"), "composer.cycleModelParameter action missing");
  });

  it("P1-1: Ctrl+I is Focus Chat Input (composer.focusChatInput)", () => {
    const all = bindingsFor("ctrl+i");
    assert.equal(all.length, 1);
    assert.equal(all[0]!.command, "composer.focusChatInput");
    assert.equal(bindingsFor("cmd+i", "mac").length, 1);
    assert.equal(bindingsFor("cmd+i", "mac")[0]!.command, "composer.focusChatInput");
  });

  it("P1-6: Ctrl+Shift+I is Toggle Developer Tools, not composer.toggleChatAsEditor", () => {
    const all = bindingsFor("ctrl+shift+i");
    assert.equal(all.length, 1);
    assert.equal(all[0]!.command, "workbench.action.toggleDevTools");
    assert.equal(all[0]!.mac, "ctrl+alt+i"); // Cursor mac binding (physical ctrl)
    for (const b of bindings) {
      if (b.command === "composer.toggleChatAsEditor") {
        assert.notEqual(b.key, "ctrl+shift+i");
      }
    }
  });

  it("P1-7: composer.fixWithAI is off Ctrl+Shift+E (Cursor Archive)", () => {
    for (const b of bindings) {
      if (b.command === "composer.fixWithAI") {
        assert.notEqual(b.key, "ctrl+shift+e", "composer.fixWithAI still on ctrl+shift+e");
      }
    }
    const ours = bindings.find((x) => x.command === "composer.fixWithAI");
    assert.ok(ours && ours.key.length > 0, "composer.fixWithAI lost its keybinding entirely");
  });

  // GAPS-16A (open-mode-menu-keybinding): the old P1-8 reading kept Ctrl+.
  // fully unbound because Cursor's *Open Workspace* (primary CtrlCmd+. with
  // NO when clause) has no equivalent command yet. Binary re-verification
  // (workbench.glass.main.js 3.25.9, class GAb) shows `composer.openModeMenu`
  // ALSO registers primary CtrlCmd+. (weight 600, chat-surface when, f1:!1)
  // — the shared chord resolves by weight/when, exactly like Cursor.
  it("P1-8/GAPS-16A: Ctrl+. opens the chat mode menu on the chat surface; Open Workspace stays unbound", () => {
    const all = bindingsFor("ctrl+.");
    assert.equal(all.length, 1, `expected only composer.openModeMenu on ctrl+., got ${JSON.stringify(all)}`);
    assert.equal(all[0]!.command, "composer.openModeMenu");
    // Chat-surface scoped: must require the chat surface and exclude text
    // editors and terminals (binary: && !editorTextFocus && !focusInAny,
    // where the binary's focusInAny is terminalFocusInAny).
    assert.ok(all[0]!.when.includes("editorTextFocus"), `when must exclude editorTextFocus: "${all[0]!.when}"`);
    assert.ok(all[0]!.when.includes("focusInAny"), `when must exclude terminalFocusInAny: "${all[0]!.when}"`);
    const mac = bindingsFor("cmd+.", "mac");
    assert.equal(mac.length, 1);
    assert.equal(mac[0]!.command, "composer.openModeMenu");
    // No other command (and no global Open Workspace equivalent) owns Ctrl+..
    for (const b of bindings) {
      if (b.command !== "composer.openModeMenu") {
        assert.notEqual(b.key, "ctrl+.");
        assert.notEqual(b.mac, "cmd+.");
      }
    }
  });

  it("P1-5/P1-8: Ctrl+K in the editor opens the inline prompt", () => {
    const all = bindingsFor("ctrl+k").filter((b) => b.when.includes("editorTextFocus"));
    assert.ok(
      all.some((b) => b.command === "composer.openInlinePrompt"),
      `no editorTextFocus ctrl+k -> composer.openInlinePrompt: ${JSON.stringify(bindingsFor("ctrl+k"))}`,
    );
  });

  it("P1-5: Ctrl+K is not bound to composer.terminalAiCommand", () => {
    for (const b of bindings) {
      if (b.command === "composer.terminalAiCommand") {
        assert.notEqual(b.key, "ctrl+k", "composer.terminalAiCommand still on ctrl+k");
      }
    }
  });

  it("P1-4: Ctrl+Shift+D is Investigate Error in Chat", () => {
    const all = bindingsFor("ctrl+shift+d");
    assert.equal(all.length, 1);
    assert.equal(all[0]!.command, "composer.investigateError");
  });

  it("P1-9: Ctrl+]/[ switch chat tabs", () => {
    const next = bindingsFor("ctrl+]");
    const prev = bindingsFor("ctrl+[");
    assert.equal(next.length, 1);
    assert.equal(next[0]!.command, "composer.nextChatTab");
    assert.equal(prev.length, 1);
    assert.equal(prev[0]!.command, "composer.previousChatTab");
    // The old Ctrl+Alt+Right/Left bindings are gone.
    assert.equal(bindingsFor("ctrl+alt+right").length, 0);
    assert.equal(bindingsFor("ctrl+alt+left").length, 0);
  });

  it("P1-11: Ctrl+Shift+T reopens the last closed chat tab", () => {
    const all = bindingsFor("ctrl+shift+t");
    assert.equal(all.length, 1);
    assert.equal(all[0]!.command, "composer.reopenChatTab");
  });

  it("P1-11: Ctrl+N and Ctrl+Alt+N create a new agent chat (Ctrl+N yields to partial reject while a diff is pending)", () => {
    const n = bindingsFor("ctrl+n");
    // WORKER-GAPS-34C (inline-edit-command-ids, P1): the binary-verbatim
    // `editor.action.inlineDiffs.rejectPartialEdit` owns Ctrl+N with the
    // binary's kbExpr (`editorTextFocus` ONLY). The pending-diff gate moved
    // to the action PRECONDITION (`inlineDiffs.activeEditorWithDiffs`), not
    // the keybinding when — ported exactly like Cursor's registration
    // (precondition:ext + kbExpr:editorTextFocus).
    assert.equal(n.length, 2);
    const newChat = n.find((b) => b.command === "composer.newAgentChat");
    const partial = n.find((b) => b.command === "editor.action.inlineDiffs.rejectPartialEdit");
    assert.ok(newChat && !newChat.when, "newAgentChat stays global (no when)");
    assert.ok(
      partial && partial.when.includes("editorTextFocus"),
      "rejectPartialEdit keybinding when must be editorTextFocus (binary kbExpr)",
    );
    assert.ok(
      partial && !partial.when.includes("inlineEditPending"),
      "the pending-diff gate is the action precondition, not the keybinding when (binary port)",
    );
    // The parser only sees keybinding whens, so assert the precondition on
    // the source text: the diff-pending gate lives on the action.
    assert.ok(
      src.includes("precondition: InlineDiffContextKeys.activeEditorWithDiffs"),
      "inline-diff actions must carry the inlineDiffs.activeEditorWithDiffs precondition",
    );
    const an = bindingsFor("ctrl+alt+n");
    assert.equal(an.length, 1);
    assert.equal(an[0]!.command, "composer.newAgentChat");
    assert.ok(!an[0]!.when, "Ctrl+Alt+N must be global (Cursor newAgentKeepPaneFromKeyboard has no when)");
  });

  it("P1-12: Alt+I focuses the editor; Alt+L focuses the terminal except while an inline diff is pending (Cursor: next diff file)", () => {
    const i = bindingsFor("alt+i");
    assert.equal(i.length, 1);
    assert.equal(i[0]!.command, "workbench.action.focusActiveEditorGroup");
    const l = bindingsFor("alt+l");
    // Cursor parity (dig-continuous-inline-edit-2026-10-19 §3.3): Alt+L is
    // nextDiffFile (weight 1100 in Cursor -> ExternalExtension here, the
    // fork's top tier) while a diff is pending; otherwise it focuses the
    // terminal. Higher weight + diff-scoped when = wins only during a preview.
    assert.equal(l.length, 2);
    const term = l.find((b) => b.command === "workbench.action.terminal.focus");
    const nextFile = l.find((b) => b.command === "composer.nextInlineDiffFile");
    assert.ok(term, "alt+l -> workbench.action.terminal.focus survives");
    assert.ok(
      nextFile && nextFile.when.includes("inlineEditPending"),
      "alt+l -> composer.nextInlineDiffFile must be scoped to a pending inline diff",
    );
  });

  it("P1-13: Ctrl+Shift+Backspace rejects inline diffs with when-clauses disjoint from cancelComposerStep", () => {
    const all = bindingsFor("ctrl+shift+backspace");
    const byCmd = new Map<string, Binding[]>();
    for (const b of all) {
      const list = byCmd.get(b.command) ?? [];
      list.push(b);
      byCmd.set(b.command, list);
    }
    // WORKER-GAPS-36C (inline-edit-command-ids, P1): `composer.rejectInlineEdit`
    // was replaced by the binary-verbatim `editor.action.inlineDiffs.rejectAll`
    // ("Undo Edits", w500). The shared chord is also bound by
    // `editor.action.inlineDiffs.cancelEdits` ("Cancel Edits", w600, wins while
    // generating) — both must be present.
    assert.ok(
      byCmd.has("editor.action.inlineDiffs.rejectAll"),
      "no ctrl+shift+backspace -> editor.action.inlineDiffs.rejectAll",
    );
    assert.ok(
      byCmd.has("editor.action.inlineDiffs.cancelEdits"),
      "no ctrl+shift+backspace -> editor.action.inlineDiffs.cancelEdits",
    );
    // W65D (chat-cancel-generation-shortcut): the fork-invented
    // `composer.cancelAgentStep` was replaced by the binary-verbatim
    // `composer.cancelComposerStep` + `composer.cancelComposerStepInputFocused`
    // (workbench.glass.main.js 3.25.9 @39862622/@39865699).
    assert.ok(
      byCmd.has("composer.cancelComposerStep"),
      "ctrl+shift+backspace -> composer.cancelComposerStep went missing",
    );
    assert.ok(
      byCmd.has("composer.cancelComposerStepInputFocused"),
      "ctrl+shift+backspace -> composer.cancelComposerStepInputFocused went missing",
    );
    // The mac-only Ctrl+C override of the input-focused variant.
    const macCtrlC = bindingsFor("ctrl+c", "mac").find(
      (b) => b.command === "composer.cancelComposerStepInputFocused",
    );
    assert.ok(macCtrlC, "mac ctrl+c -> composer.cancelComposerStepInputFocused went missing");
    const rejectWhens = (byCmd.get("editor.action.inlineDiffs.rejectAll") ?? []).map((b) => b.when);
    const cancelWhens = [
      ...(byCmd.get("composer.cancelComposerStep") ?? []),
      ...(byCmd.get("composer.cancelComposerStepInputFocused") ?? []),
    ].map((b) => b.when);
    // editorTextFocus (reject) and chat-view focus (cancel) are mutually exclusive.
    assert.ok(
      rejectWhens.some((w) => w.includes("editorTextFocus")),
      "rejectInlineEdit when must require editorTextFocus",
    );
    assert.ok(
      cancelWhens.every((w) => !w.includes("editorTextFocus")),
      `cancelComposerStep when must not include editorTextFocus: ${JSON.stringify(cancelWhens)}`,
    );
  });

  it("P1-8: Shift+Tab cycles the chat mode", () => {
    const all = bindingsFor("shift+tab");
    assert.equal(all.length, 1);
    assert.equal(all[0]!.command, "composer.cycleMode");
  });

  it("P1-2: Ctrl+L has no binding when the chat input is focused (Cursor parity)", () => {
    for (const b of bindingsFor("ctrl+l")) {
      assert.ok(
        !b.when.includes("chatInputFocused"),
        `ctrl+l should not fire when chat input focused: ${b.command} when "${b.when}"`,
      );
    }
  });

  // DEV-FULLSCREEN-COMPOSER (Cursor 3.25.9 binary, workbench.glass.main.js):
  // glass.enterEditorPanelFullscreen ("Enter Full Screen") /
  // glass.exitEditorPanelFullscreen ("Exit Full Screen") share
  // Ctrl/Cmd+Shift+M at binary-verified weight 250 (gp=250 top-level in
  // workbench.glass.main.js 3.25.9; KeybindingWeight.SessionsContrib in this
  // fork — WORKER-GAPS-15B/16E/17E/20C, 2026-10-20) with mutually exclusive
  // whens. Ctrl/Cmd+Shift+I is Toggle Developer Tools in Cursor — the
  // dotcursorrules.com "Fullscreen Composer on Ctrl+Shift+I" claim is
  // contradicted by the binary and must never be reintroduced.
  // NOTE: the command ids are the BINARY-VERBATIM glass ids (WORKER-GAPS-20C
  // redo): `glass.enterEditorPanelFullscreen` /
  // `glass.exitEditorPanelFullscreen`. The TILE-fullscreen "Toggle Fullscreen"
  // (id `_$l`, weight 1602) is a separate surface and must stay distinct.
  it("Fullscreen: Ctrl+Shift+M enters/exits fullscreen composer (Cursor parity), never Ctrl+Shift+I", () => {
    const all = bindingsFor("ctrl+shift+m");
    const cmds = all.map((b) => b.command).sort();
    assert.deepEqual(cmds, ["glass.enterEditorPanelFullscreen", "glass.exitEditorPanelFullscreen"]);
    const enter = all.find((b) => b.command === "glass.enterEditorPanelFullscreen")!;
    const exit = all.find((b) => b.command === "glass.exitEditorPanelFullscreen")!;
    // Binary Wlu = ft.and(glassEditorPanelFullscreenAvailable,
    //                     glassEditorPanelFullscreen.negate()):
    // the enter when must reference the VERBATIM availability key AND the
    // VERBATIM fullscreen key (negated).
    assert.ok(enter.when.includes("glassEditorPanelFullscreenAvailable"), `enter when must reference the verbatim availability key: "${enter.when}"`);
    assert.ok(enter.when.includes("glassEditorPanelFullscreen"), `enter when must reference the verbatim fullscreen key: "${enter.when}"`);
    // Binary Glu = ft.and(glassEditorPanelVisible, glassEditorPanelFullscreen):
    // the exit when must reference the VERBATIM visible + fullscreen keys,
    // and must NOT reference the availability key.
    assert.ok(exit.when.includes("glassEditorPanelVisible"), `exit when must reference the verbatim visible key: "${exit.when}"`);
    assert.ok(exit.when.includes("glassEditorPanelFullscreen"), `exit when must reference the verbatim fullscreen key: "${exit.when}"`);
    assert.ok(!exit.when.includes("glassEditorPanelFullscreenAvailable"), `exit when must NOT reference the availability key: "${exit.when}"`);
    assert.notEqual(enter.when, exit.when, "enter/exit whens must be mutually exclusive");
    const mac = bindingsFor("cmd+shift+m", "mac");
    assert.deepEqual(
      mac.map((b) => b.command).sort(),
      ["glass.enterEditorPanelFullscreen", "glass.exitEditorPanelFullscreen"],
    );
    // Ctrl+Shift+I stays DevTools (P1-6 guards the binding itself); the
    // fullscreen commands must never squat on it.
    for (const b of bindings) {
      if (b.command === "glass.enterEditorPanelFullscreen" || b.command === "glass.exitEditorPanelFullscreen") {
        assert.notEqual(b.key, "ctrl+shift+i");
        assert.notEqual(b.mac, "cmd+shift+i");
      }
    }
  });
});

describe("keybindings — GAPS-14 shell-tool approval keyboard flow (Cursor 3.25.6 binary-verbatim)", () => {
  // The four commands are binary-verbatim from the glass bundle class
  // registrations (feature-matrix.json feature agent-shell-approval-keyboard-flow;
  // keybindings.json "tool approval" whens). This block pins id, title,
  // keybinding, when-clause and the extension delegation target straight off
  // the Action2 class source so a rename/re-key regresses loudly.
  function classBlock(className: string): string {
    const start = src.indexOf(`export class ${className} extends Action2`);
    assert.ok(start !== -1, `${className} not found in composerActions.ts`);
    const next = src.indexOf("export class", start + 1);
    return src.slice(start, next === -1 ? undefined : next);
  }

  // Binary-verified against workbench.glass.main.js 3.25.6 (direct
  // extraction 2026-10-20 — class registrations, not the older "tool
  // approval" inventory which only decoded the Enter/Esc/Shift+Enter trio):
  // approve/allowlist/skip all carry weight 600, f1, and
  // `!isGlass && composerShellToolPendingKeybindingsActive` /
  // `!isGlass && composerShellToolAllowlistShortcutActive` (`!isGlass`
  // defaults true outside the glass overlay window, so the fork drops that
  // term and keeps the `composer.*` keys, bridged from the extension).
  // cancelTerminalToolCall: weight 600, Shift+Backspace,
  // `composerFocused || focusedView =~ /^workbench.panel.aichat/`
  // (fork: `chatSurface`), and — verified — NO f1 field (keybinding-only,
  // not in the command palette; the sibling commands have explicit f1:!0).
  const cases = [
    {
      cls: "ComposerApprovePendingShellToolDecisionAction",
      id: "composer.approvePendingShellToolDecision",
      title: "Approve pending shell tool (run)",
      key: "primary: KeyCode.Enter,",
      weight: "weight: shellApprovalKeybindingWeight,",
      when: "when: ComposerContextKeys.shellToolPendingKeybindingsActive",
      delegate: "ide.approveShellTool",
    },
    {
      cls: "ComposerApprovePendingShellToolDecisionAllowlistAction",
      id: "composer.approvePendingShellToolDecisionAllowlist",
      title: "Approve pending shell tool and allowlist",
      key: "primary: KeyMod.Shift | KeyCode.Enter,",
      weight: "weight: shellApprovalKeybindingWeight,",
      when: "when: ComposerContextKeys.shellToolAllowlistShortcutActive",
      delegate: "ide.approveShellToolAllowlist",
    },
    {
      cls: "ComposerSkipPendingShellToolDecisionAction",
      id: "composer.skipPendingShellToolDecision",
      title: "Skip pending shell tool",
      key: "primary: KeyCode.Escape,",
      weight: "weight: shellApprovalKeybindingWeight,",
      when: "when: ComposerContextKeys.shellToolPendingKeybindingsActive",
      delegate: "ide.skipShellTool",
    },
    {
      cls: "ComposerCancelTerminalToolCallAction",
      id: "composer.cancelTerminalToolCall",
      title: "Cancel Terminal Tool Call",
      key: "primary: KeyMod.Shift | KeyCode.Backspace,",
      weight: "weight: shellApprovalKeybindingWeight,",
      when: "when: chatSurface",
      noF1: true,
      delegate: "ide.cancelTerminalToolCall",
    },
  ];
  for (const c of cases) {
    it(`GAPS-14: ${c.id} — binary-verbatim id/title/keybinding/when + delegation`, () => {
      const block = classBlock(c.cls);
      assert.ok(block.includes(`static readonly ID = '${c.id}'`), "command id");
      assert.ok(block.includes(`'${c.title}'`), "title literal");
      assert.ok(block.includes(c.key), `keybinding (${c.key.trim()})`);
      assert.ok(block.includes(c.when), `when-clause (${c.when})`);
      if ((c as { weight?: string }).weight) {
        assert.ok(
          block.includes((c as { weight?: string }).weight as string),
          `weight (${(c as { weight?: string }).weight})`,
        );
      }
      if ((c as { noF1?: boolean }).noF1) {
        // Binary: the cancel registration carries no f1 field — it must
        // stay a keybinding-only command, out of the command palette.
        assert.ok(!block.includes("f1:"), "cancelTerminalToolCall must not set f1");
      } else {
        assert.ok(block.includes("f1: true,"), "approval commands are f1 palette commands");
      }
      assert.ok(
        block.includes(`executeCommand('${c.delegate}'`),
        `must delegate to ${c.delegate}`,
      );
      const reg = new RegExp(`registerAction2\\(${c.cls}\\)`);
      assert.ok(reg.test(src), `${c.cls} must be registered`);
    });
  }

  it("GAPS-14: the invented pre-parity ids are gone (no duplicate bindings)", () => {
    for (const dead of [
      "'composer.approveShellTool'",
      "'composer.approveShellToolAllowlist'",
      "'composer.skipShellTool'",
    ]) {
      assert.ok(!src.includes(dead), `${dead} must not remain in composerActions.ts`);
    }
  });

  it("GAPS-14: Enter/Escape bindings stay disjoint (approval vs hide-find)", () => {
    // Enter+Escape both exist under toolApprovalVisible (approve/skip) and
    // Escape under chatSurface+!toolApprovalVisible (hide find in chat) —
    // the structural test already forbids identical (key, when) pairs; here
    // pin the intended split explicitly.
    const enter = bindingsFor("enter").map((b) => b.command);
    assert.ok(
      enter.includes("composer.approvePendingShellToolDecision"),
      `enter must approve the pending shell tool: ${JSON.stringify(enter)}`,
    );
    const esc = bindingsFor("escape").map((b) => b.command);
    assert.ok(
      esc.includes("composer.skipPendingShellToolDecision"),
      `escape must skip the pending shell tool: ${JSON.stringify(esc)}`,
    );
  });
});

describe("keybindings — GAPS-16A open-mode-menu (Cursor 3.25.9 binary-verbatim)", () => {
  // Binary: workbench.glass.main.js 3.25.9, class GAb, id `composer.openModeMenu`:
  // `title:{value:"Open chat mode menu",original:"Open chat mode menu"},f1:!1,
  // keybinding:{primary:dt.CtrlCmd|Xe.Period,
  // secondary:[dt.CtrlCmd|dt.Alt|Xe.Period,dt.Shift|Xe.Tab],weight:600,
  // when:(composerFocused || focusedView=~/^workbench.panel.aichat.view/ ||
  // activeEditor==chatEditor || chatModeMenuFocused) && !editorTextFocus && !focusInAny}`.
  // The binary's `is.focusInAny` is the TERMINAL context keys namespace
  // (`focusInAny=new pn("terminalFocusInAny",...)`), so `!focusInAny` is
  // `!terminalFocusInAny` — ported verbatim, not omitted.
  function classBlock(className: string): string {
    const start = src.indexOf(`export class ${className} extends Action2`);
    assert.ok(start !== -1, `${className} not found in composerActions.ts`);
    const next = src.indexOf("export class", start + 1);
    return src.slice(start, next === -1 ? undefined : next);
  }

  it("GAPS-16A: composer.openModeMenu — binary-verbatim id/title/f1/chords/weight/when + delegation", () => {
    const block = classBlock("ComposerOpenModeMenuAction");
    assert.ok(block.includes("static readonly ID = 'composer.openModeMenu'"), "command id");
    assert.ok(block.includes("'Open chat mode menu'"), "title literal (binary verbatim)");
    // Binary f1:!1 — hidden from the command palette.
    assert.ok(block.includes("f1: false,"), "f1 must be false (binary f1:!1)");
    // Binary chords.
    assert.ok(block.includes("primary: KeyMod.CtrlCmd | KeyCode.Period,"), "primary CtrlCmd+.");
    assert.ok(
      block.includes("secondary: [KeyMod.CtrlCmd | KeyMod.Alt | KeyCode.Period, KeyMod.Shift | KeyCode.Tab],"),
      "secondaries CtrlCmd+Alt+. and Shift+Tab",
    );
    // Binary weight 600.
    assert.ok(block.includes("weight: openModeMenuKeybindingWeight,"), "weight constant");
    assert.ok(src.includes("const openModeMenuKeybindingWeight = 600 as KeybindingWeight;"), "weight is 600");
    // When-clause port: chat surface, !editorTextFocus, !terminalFocusInAny.
    assert.ok(block.includes("EditorContextKeys.editorTextFocus.negate()"), "when excludes editorTextFocus");
    assert.ok(
      block.includes("TerminalContextKeys.focusInAny.negate()"),
      "when excludes terminalFocusInAny (binary is.focusInAny.negate())",
    );
    assert.ok(block.includes("chatSurface"), "when covers the chat surface");
    // Delegation + registration.
    assert.ok(block.includes("executeCommand('ide.openModeMenu'"), "must delegate to ide.openModeMenu");
    assert.ok(/registerAction2\(ComposerOpenModeMenuAction\)/.test(src), "must be registered");
  });

  it("GAPS-16A: openModeMenu outranks cycleMode on the shared Shift+Tab (Cursor weight/when resolution)", () => {
    // The structural parser indexes primary chords only; the Shift+Tab
    // secondary lives on the class block (see above). Here pin the
    // resolution contract: openModeMenu's 600 beats cycleMode's
    // WorkbenchContrib (200), and the mode menu's when excludes the editor
    // text focus where cycleMode keeps working.
    const menuBlock = classBlock("ComposerOpenModeMenuAction");
    const cycleBlock = classBlock("ComposerCycleModeAction");
    assert.ok(
      menuBlock.includes("secondary: [KeyMod.CtrlCmd | KeyMod.Alt | KeyCode.Period, KeyMod.Shift | KeyCode.Tab],"),
      "mode menu carries the Shift+Tab secondary",
    );
    assert.ok(cycleBlock.includes("primary: KeyMod.Shift | KeyCode.Tab,"), "cycleMode keeps its Shift+Tab primary");
    assert.ok(cycleBlock.includes("weight: KeybindingWeight.WorkbenchContrib,"), "cycleMode weight is WorkbenchContrib (200)");
    assert.ok(
      menuBlock.includes("EditorContextKeys.editorTextFocus.negate()"),
      "mode menu yields inside text editors (cycleMode's when still holds there)",
    );
  });
});

describe("keybindings — Find in Chat family (DEV-GAPS-29, Cursor 3.25.9 binary)", () => {
  // Binary-verbatim family (workbench.glass.main.js 3.25.6/3.25.9,
  // keybindings-inventory.md rows 36-39): four actions, ALL f1:!1, weight
  // 200, gated by the verbatim context key `composerFindWidgetFocused`:
  //   composer.find.focus    "Find in Chat"         CtrlCmd+F  when composerFocused && !composerFindWidgetFocused
  //   composer.find.hide     "Close Find in Chat"   Escape     when composerFindWidgetFocused
  //   composer.find.next     "Find Next in Chat"    F3 / Enter when composerFindWidgetFocused
  //   composer.find.previous "Find Previous in Chat" Shift+F3 / Shift+Enter when composerFindWidgetFocused
  function classBlock(className: string): string {
    const start = src.indexOf(`export class ${className} extends Action2`);
    assert.ok(start !== -1, `${className} not found in composerActions.ts`);
    const next = src.indexOf("export class", start + 1);
    return src.slice(start, next === -1 ? undefined : next);
  }

  const FAMILY: Array<{ cls: string; id: string; title: string }> = [
    { cls: "ComposerFindInChatAction", id: "composer.find.focus", title: "Find in Chat" },
    { cls: "ComposerHideFindInChatAction", id: "composer.find.hide", title: "Close Find in Chat" },
    { cls: "ComposerFindNextInChatAction", id: "composer.find.next", title: "Find Next in Chat" },
    { cls: "ComposerFindPreviousInChatAction", id: "composer.find.previous", title: "Find Previous in Chat" },
  ];

  it("all four binary-verbatim ids are registered with binary-verbatim titles and f1:!1", () => {
    for (const f of FAMILY) {
      const block = classBlock(f.cls);
      assert.ok(
        block.includes(`static readonly ID = '${f.id}'`),
        `${f.cls} must use the binary-verbatim id ${f.id}`,
      );
      assert.ok(block.includes(`'${f.title}'`), `${f.cls} title must be verbatim '${f.title}'`);
      assert.ok(/f1:\s*false/.test(block), `${f.id} must be f1:false (binary f1:!1)`);
      assert.ok(!/f1:\s*true/.test(block), `${f.id} must not be f1:true`);
    }
  });

  it("focus: CtrlCmd+F, when chat surface && !composerFindWidgetFocused, weight 200", () => {
    const block = classBlock("ComposerFindInChatAction");
    assert.ok(block.includes("primary: KeyMod.CtrlCmd | KeyCode.KeyF,"), "CtrlCmd+F");
    assert.ok(block.includes("ComposerContextKeys.findWidgetFocused.negate()"), "when excludes the open widget");
    assert.ok(block.includes("chatSurface"), "when covers the chat surface");
    assert.ok(block.includes("weight: KeybindingWeight.WorkbenchContrib,"), "weight 200");
    assert.ok(block.includes("executeCommand('ide.findInChat'"), "delegates to ide.findInChat");
  });

  it("hide: Escape, when composerFindWidgetFocused, weight 200", () => {
    const block = classBlock("ComposerHideFindInChatAction");
    assert.ok(block.includes("primary: KeyCode.Escape,"), "Escape");
    assert.ok(block.includes("when: ComposerContextKeys.findWidgetFocused"), "when is composerFindWidgetFocused");
    assert.ok(block.includes("weight: KeybindingWeight.WorkbenchContrib,"), "weight 200");
    assert.ok(block.includes("executeCommand('ide.hideFindInChat'"), "delegates to ide.hideFindInChat");
  });

  it("next: F3 + Enter secondary, when composerFindWidgetFocused, weight 200", () => {
    const block = classBlock("ComposerFindNextInChatAction");
    assert.ok(block.includes("primary: KeyCode.F3,"), "F3 primary");
    assert.ok(block.includes("secondary: [KeyCode.Enter],"), "Enter secondary (binary 'F3 (2nd: Enter)')");
    assert.ok(block.includes("when: ComposerContextKeys.findWidgetFocused"), "when is composerFindWidgetFocused");
    assert.ok(block.includes("weight: KeybindingWeight.WorkbenchContrib,"), "weight 200");
    assert.ok(block.includes("executeCommand('ide.findNextInChat'"), "delegates to ide.findNextInChat");
  });

  it("previous: Shift+F3 + Shift+Enter secondary, when composerFindWidgetFocused, weight 200", () => {
    const block = classBlock("ComposerFindPreviousInChatAction");
    assert.ok(block.includes("primary: KeyMod.Shift | KeyCode.F3,"), "Shift+F3 primary");
    assert.ok(block.includes("secondary: [KeyMod.Shift | KeyCode.Enter],"), "Shift+Enter secondary");
    assert.ok(block.includes("when: ComposerContextKeys.findWidgetFocused"), "when is composerFindWidgetFocused");
    assert.ok(block.includes("weight: KeybindingWeight.WorkbenchContrib,"), "weight 200");
    assert.ok(block.includes("executeCommand('ide.findPreviousInChat'"), "delegates to ide.findPreviousInChat");
  });

  it("legacy fork ids stay registered as palette-invisible aliases", () => {
    assert.ok(
      src.includes("CommandsRegistry.registerCommand('composer.findInChat'"),
      "alias composer.findInChat missing",
    );
    assert.ok(
      src.includes("CommandsRegistry.registerCommand('composer.hideFindInChat'"),
      "alias composer.hideFindInChat missing",
    );
  });

  it("no find-family chord conflicts with the editor find widget", () => {
    // The editor's F3/Escape require editor findWidgetVisible — disjoint from
    // composerFindWidgetFocused, so these bindings cannot shadow editor find.
    for (const f of FAMILY) {
      const b = bindings.find((x) => x.command === f.id);
      assert.ok(b, `${f.id} has no parsed keybinding`);
      assert.ok(
        !/findWidgetVisible/.test(b!.when),
        `${f.id} when must not reference the editor's findWidgetVisible`,
      );
    }
  });
});

describe("keybindings — GAPS-89 Quote chord (cursor.openBranchMenu, Cursor 3.25.9 binary)", () => {
  // Binary: workbench.glass.main.js 3.25.9, class JXl (dig-branch-menu-
  // 2026-10-20.md): `keybinding:{primary:dt.CtrlCmd|Xe.Quote,weight:600,
  // when:ft.has("composerFocused")}`. This chord crashed the test parser at
  // load (`unknown KeyCode in test parser: KeyCode.Quote`) because
  // parseChordExpr had no Quote entry — the chord itself is verbatim
  // parity, so the parser was fixed (DEV-GAPS-89), not the chord.
  it("GAPS-89: CtrlCmd+Quote is cursor.openBranchMenu on the chat surface", () => {
    const all = bindingsFor("ctrl+'");
    assert.equal(all.length, 1, `expected only cursor.openBranchMenu on ctrl+', got ${JSON.stringify(all)}`);
    assert.equal(all[0]!.command, "cursor.openBranchMenu");
    assert.ok(all[0]!.when.includes("chatSurface"), `when must be the chatSurface port of composerFocused: "${all[0]!.when}"`);
    const mac = bindingsFor("cmd+'", "mac");
    assert.equal(mac.length, 1);
    assert.equal(mac[0]!.command, "cursor.openBranchMenu");
  });
});
