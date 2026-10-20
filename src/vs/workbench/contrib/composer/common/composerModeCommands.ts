/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// IDE-CODE: Cursor composer-mode palette commands parity.
//
// Binary mechanism (Cursor 3.25.9, verified against
// workbench.glass.main.js — NOT against auditor run-27's summary doc, whose
// "all 7 modes get palette commands" claim is REFUTED by the code below):
//
//   registerExistingModeActions(){const t=this.getAllModes();for(const e of t)e.actionId&&this.registerModeAction(e,e.actionId)}
//   registerModeAction(t,e){ ... registerAction2(class extends ln{constructor(){super({
//       id:e,
//       title:{value:`Open Chat in ${t.name} Mode`,original:`Open Chat in ${t.name} Mode`},
//       precondition:t.id==="background"?xte.INSTANCE:void 0,
//       f1:!0})} ... run(s){return s.get(sr).executeCommand(YGt,t.id)}}) ... }
//
// Critically, the loop iterates getAllModes(), and getAllModes() drops
// "spec" and "triage" BEFORE the loop runs:
//
//   getAllModes(){const t=...composerState?.modes4??[],e=["spec"];e.push("triage");
//     ...return i.filter(r=>PROTECTED_MODE_IDS.includes(r.id)).filter(r=>!e.includes(r.id))...}
//
// Complete call-site enumeration of registerModeAction in 3.25.9 shows NO
// other path registers triage/spec at startup:
//   1. registerExistingModeActions() — getAllModes() only (excludes spec/triage)
//   2. maybeRegisterBackgroundModeAction() — "background" mode only
//   3. saveModeKeybinding(t,e) — user-initiated via the keybinding UI; there is
//      no UI path that lists triage/spec, so no command is ever created for them.
//
// Therefore Cursor 3.25.9 registers EXACTLY FIVE "Open Chat in X Mode" palette
// commands at startup, with these verbatim action ids (seed defs @16321791,
// actionId field captured verbatim; "chat" mode's display name is "Ask"):
//   composerMode.agent, composerMode.plan, composerMode.chat,
//   composerMode.debug, composerMode.multitask.
//
// There is NO "Open Chat in Triage Mode" and NO "Open Chat in Spec Mode"
// command in the binary (the title template is built dynamically, so literal
// grep for the full titles finds 0 hits — the loop+filter above is the proof).
//
// This module is pure (ZERO imports, not even vs/base) so the extension test
// suite can transpile it standalone for behavioral coverage — same pattern as
// common/customModes.ts. Keep it that way.

/**
 * One palette command registered by the binary's `registerExistingModeActions()`
 * loop. `actionId` values are verbatim from the Cursor seed defs.
 */
export interface ComposerModeCommandDef {
  /** Internal mode id (wire id; "chat" stays "chat" even though the UI name is "Ask"). */
  modeId: 'agent' | 'plan' | 'chat' | 'debug' | 'multitask';
  /** Verbatim command id from the binary: `composerMode.<suffix>`. */
  actionId: string;
  /** Display name substituted into the title template. */
  name: string;
  /**
   * IDE-CODE: the ide-agent extension command this core palette entry
   * delegates to (the engine's mode switcher lives in the extension until it
   * migrates to core). Extension-side ids are `ide.set<Name>Mode`.
   */
  extensionCommand: string;
}

/**
 * Binary `registerExistingModeActions()` registerable set: getAllModes()
 * entries that carry an actionId, in the binary's sort order
 * (["agent","triage","plan","spec","debug","multitask","chat"] with
 * triage/spec filtered out). Exactly 5 — triage and spec are NEVER here.
 */
export const COMPOSER_MODE_COMMANDS: readonly ComposerModeCommandDef[] = [
  { modeId: 'agent', actionId: 'composerMode.agent', name: 'Agent', extensionCommand: 'ide.setAgentMode' },
  { modeId: 'plan', actionId: 'composerMode.plan', name: 'Plan', extensionCommand: 'ide.setPlanMode' },
  { modeId: 'chat', actionId: 'composerMode.chat', name: 'Ask', extensionCommand: 'ide.setAskMode' },
  { modeId: 'debug', actionId: 'composerMode.debug', name: 'Debug', extensionCommand: 'ide.setDebugMode' },
  { modeId: 'multitask', actionId: 'composerMode.multitask', name: 'Multitask', extensionCommand: 'ide.setMultitaskMode' },
];

/**
 * Binary title template: `Open Chat in ${t.name} Mode`.
 */
export function buildComposerModeCommandTitle(name: string): string {
  return `Open Chat in ${name} Mode`;
}

/** nls key for one palette entry (one static key per entry for the i18n pipeline). */
export function composerModeCommandTitleKey(def: ComposerModeCommandDef): string {
  return `composerMode.command.${def.modeId}`;
}
