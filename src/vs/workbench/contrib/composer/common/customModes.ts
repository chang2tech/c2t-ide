/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// IDE-CODE: Cursor composer-modes registry parity.
//
// Implements the binary's mode-registry mechanism (workbench.glass.main.js,
// Cursor 3.25.6 + 3.25.9) behind the MISSING gaps `agent-custom-modes` and
// `agent-mode-triage`:
//
//   agent-custom-modes — Cursor persists every chat mode (built-ins AND
//     user-defined custom modes) in
//     `applicationUserPersistentStorage.composerState.modes4`, and exposes
//     them through a modes service (`getAllModes` / `getMode` /
//     `checkIfModeExists` / `updateModeSetStore`). Custom modes are gated by
//     the `glass_custom_modes` experiment (default OFF in both binaries);
//     in the 3.x UI they are derived from slash commands / skills
//     (`.cursor/commands`), not from a separate authoring UI.
//   agent-mode-triage — `triage` is a REGISTERED built-in mode (seeded in
//     `modes4`, protected id, actionId `composerMode.triage`) but is NOT
//     user-selectable: `getAllModes()` drops it (and `spec`) from the picker
//     list, so no `composerMode.triage` command is registered and no palette
//     command "Open Chat in Triage Mode" exists in the binary (0 hits).
//
// PARITY EVIDENCE STATUS (rule: ~/AGENTS.md "KHÔNG BỊA ĐẶT"):
//   OBSERVED (binary, both bundles — offsets are 3.25.6 unless noted):
//     - modes4 storage: `applicationUserPersistentStorage.composerState.modes4`
//       (seed default `LB.modes4` @16321791; 3.25.9 seed @16321791-equivalent)
//     - `getAllModes()` exact code @40176116 (3.25.9 @40185731):
//         slice → keep PROTECTED ids → drop ["spec","triage"] → sort by
//         ["agent","triage","plan","spec","debug","multitask","chat"]
//         (ids missing from the order keep raw storage order)
//     - `getMode(id)`: getAllModes find, else protected-id fallback into raw
//       modes4; logs "[composerModesService] Mode not found: <id>" on miss
//     - `checkIfModeExists(id)` = in getAllModes OR protected id
//     - `updateModeSetStore(id, updater)` →
//       `setApplicationUserPersistentStorage("composerState","modes4", matcher, updater)`
//     - `ACTION_ID_PREFIX="composerMode."`,
//       `PROTECTED_MODE_IDS=["agent","chat","edit","background","plan","spec",
//       "debug","multitask","triage"]` @40188369
//     - `registerExistingModeActions()`: registers a command per getAllModes()
//       entry that has an actionId — triage/spec get NO command @40173411
//     - `generateActionIdForMode()`: `composerMode.<name lower_snake>`,
//       `_2`-suffixed dedupe; no name → `composerMode.<id>` @40187458
//     - seed defs (7, verbatim @16321791): agent/triage/plan/spec/debug/
//       multitask/chat with {id,name,actionId,icon,description,thinkingLevel,
//       shouldAutoApplyIfNoEditTool,autoFix,autoRun,fullAutoRun,
//       enabledTools,enabledMcpServers}
//     - triage def verbatim: {id:"triage",name:"Triage",
//       actionId:"composerMode.triage",icon:"rocket",
//       description:"Coordinate long-horizon tasks with delegated subagents",
//       thinkingLevel:"none",shouldAutoApplyIfNoEditTool:!1,autoFix:!1,
//       autoRun:!0,fullAutoRun:!1,enabledTools:[TASK_V2,APPLY_AGENT_DIFF],
//       enabledMcpServers:[]} (3.25.6 @16322050; 3.25.9 @16322429)
//     - migration v121 "Add triage mode to composer modes": inserts triage
//       right after agent @40165638
//     - gate `glass_custom_modes:{client:!0,default:!1}` (docs/rea
//       dig-debug-multitask-2026-10-19.md, verbatim from binary)
//     - `workbench.contrib.customModesExistenceChecker`: sets a context key
//       when modes4 contains a non-protected entry (3.25.9 @38003000)
//     - `isCustomMode(hkb)`: `!DWE.has(id)` — DWE = protected-id set
//       (3.25.9 @38004171)
//     - command `workbench.action.exportCustomModes` ("Export Custom Modes"):
//       exports each custom mode to `<userHome>/.cursor/commands/<name>.md`
//       (name-sanitized, `_1`-style dedupe), content = OWE() serializer:
//       "Only using the following tools: <names>\n\n<customRulesForAI>\n"
//       (3.25.9 @38003534)
//     - OWE()/FWE()/BWE(): export serializer + tool-enum display names,
//       verbatim (3.25.9 @38004171); APPLY_AGENT_DIFF maps to "" (filtered)
//     - custom-mode-for-display from slash commands, `fvC()` (3.25.9
//       @29825262): {id,label,fullPath,badgeAppearance,description,source,
//       sourcePath,managedSkillId,skillFilename,cacheState:"cached-display"}
//     - backend proto mode-override enum has TRIAGE and CUSTOM cases
//       (3.25.6 @19751893); unifiedMode "triage" disables long_running_jobs
//       exactly like "chat" (@19943081)
//   UNKNOWN (not implemented, do not invent):
//     - exact `ZQv` (skill-filename extraction), `DZa` (id from path),
//       `fYm` (sourcePath fallback) semantics — sane ports below, marked
//     - exact `UWE` filename sanitizer — the binary lowercases/trims then
//       replaces (character class not captured); port marked partial
//     - the custom-mode authoring UI (removed in Cursor 2.1 per Cursor staff
//       on forum.cursor.com; 3.x keeps the registry + commands-derived modes
//       behind the gate)
//     - per-mode `thinkingLevel` values other than "none"
//     - `background` seed def fields (added by migration v106 from a newer
//       default list; not captured verbatim)
//
// DESIGN NOTES / HONEST DIVERGENCES:
//   - Storage: the binary uses `applicationUserPersistentStorage`
//     (reactive). This module takes a plain `{load,save}` adapter; wiring it
//     to the workbench `IStorageService` (application scope, key
//     `composerState.modes4`) is a follow-up outside this worker's scope.
//   - Pure module: ZERO imports (not even vs/base) so the extension test
//     suite can transpile it standalone for behavioral coverage. Keep it
//     that way.
//   - `unifiedMode` vs custom modes: custom modes are NEVER unifiedModes in
//     the binary — they ride as `activeCustomMode` overlays
//     (`modeOverride:CUSTOM`, `customModeIntent` enter/exit). `setMode()` in
//     modeService.ts therefore stays built-in-only; custom-mode activation
//     goes through `activateCustomModeOverlay`, which returns an overlay
//     descriptor instead of mutating unifiedMode.
//   - triage `enabledTools:[TASK_V2,APPLY_AGENT_DIFF]`: Cursor-internal tool
//     enum names. Our engine's closest equivalents are the `subagent`/`task`
//     tool and the `edit` tool; the allowlist is recorded on the def but NOT
//     enforced — no UI path in Cursor (or here) activates triage, and our
//     permission model (session deny-rulesets) has no allowlist primitive.

/**
 * One entry of Cursor's `composerState.modes4` persistent storage.
 * Field names are verbatim from the binary's seed defs (@16321791).
 */
export interface ComposerModeDef {
  id: string;
  name: string;
  actionId?: string;
  icon: string;
  description: string;
  /** "none" in every captured seed def; other values UNKNOWN. */
  thinkingLevel: string;
  shouldAutoApplyIfNoEditTool: boolean;
  autoFix: boolean;
  autoRun: boolean;
  fullAutoRun: boolean;
  /** Cursor-internal tool enum names, e.g. "TASK_V2". */
  enabledTools: string[];
  enabledMcpServers: string[];
  /** Custom instructions for user-defined modes (read by the OWE exporter). */
  customRulesForAI?: string;
}

/** Verbatim: `J3e.ACTION_ID_PREFIX="composerMode."` @40188369. */
export const ACTION_ID_PREFIX = 'composerMode.';

/** Verbatim: `J3e.PROTECTED_MODE_IDS=[...]` @40188369. */
export const PROTECTED_MODE_IDS = [
  'agent',
  'chat',
  'edit',
  'background',
  'plan',
  'spec',
  'debug',
  'multitask',
  'triage',
] as const;

/** Set form of PROTECTED_MODE_IDS (the binary's `DWE` set used by `hkb`). */
export const PROTECTED_MODE_ID_SET: ReadonlySet<string> = new Set<string>(PROTECTED_MODE_IDS);

/**
 * Verbatim sort order from `getAllModes()`:
 * `const n=["agent","triage","plan","spec","debug","multitask","chat"]`.
 */
export const MODE_SORT_ORDER = [
  'agent',
  'triage',
  'plan',
  'spec',
  'debug',
  'multitask',
  'chat',
] as const;

/**
 * Verbatim picker exclusion from `getAllModes()`:
 * `const e=["spec"]; e.push("triage")`.
 */
export const PICKER_EXCLUDED_MODE_IDS = ['spec', 'triage'] as const;

/** Persistent-storage location: `applicationUserPersistentStorage.composerState.modes4`. */
export const MODES_STORAGE_KEY = 'composerState';
export const MODES_STORAGE_FIELD = 'modes4';

/**
 * Experiment gate for the custom-modes feature.
 * Verbatim: `glass_custom_modes:{client:!0,default:!1}` — default OFF.
 */
export const CUSTOM_MODES_GATE = 'glass_custom_modes';
export const CUSTOM_MODES_GATE_DEFAULT_ON = false;

/** Verbatim command id: `NWE="workbench.action.exportCustomModes"` (3.25.9). */
export const EXPORT_CUSTOM_MODES_COMMAND_ID = 'workbench.action.exportCustomModes';

/** Custom modes live under `.cursor/commands` (binary: export target). */
export const CUSTOM_COMMANDS_DIR_NAME = 'commands';
export const CURSOR_DIR_NAME = '.cursor';

/**
 * Built-in seed defs — verbatim from the binary's default `LB.modes4`
 * (@16321791; seed order is agent, triage, plan, spec, debug, multitask,
 * chat). `fullAutoRun` is ABSENT from the plan/spec/debug/chat seed entries
 * in the captured binary — defaulted to false here and marked as ours.
 */
export const BUILTIN_MODE_SEEDS: ComposerModeDef[] = [
  {
    id: 'agent', name: 'Agent', actionId: 'composerMode.agent', icon: 'infinity',
    description: 'Plan, search, make edits, run commands',
    thinkingLevel: 'none', shouldAutoApplyIfNoEditTool: true, autoFix: true,
    autoRun: true, fullAutoRun: false, enabledTools: [], enabledMcpServers: [],
  },
  {
    id: 'triage', name: 'Triage', actionId: 'composerMode.triage', icon: 'rocket',
    description: 'Coordinate long-horizon tasks with delegated subagents',
    thinkingLevel: 'none', shouldAutoApplyIfNoEditTool: false, autoFix: false,
    autoRun: true, fullAutoRun: false,
    // Verbatim binary tool-enum names (St.TASK_V2, St.APPLY_AGENT_DIFF).
    // HONEST-DIVERGENCE: recorded, not enforced (see module header).
    enabledTools: ['TASK_V2', 'APPLY_AGENT_DIFF'], enabledMcpServers: [],
  },
  {
    id: 'plan', name: 'Plan', actionId: 'composerMode.plan', icon: 'todos',
    description: 'Create detailed plans for accomplishing tasks',
    thinkingLevel: 'none', shouldAutoApplyIfNoEditTool: false, autoFix: false,
    autoRun: false, fullAutoRun: false, enabledTools: [], enabledMcpServers: [],
  },
  {
    id: 'spec', name: 'Spec', actionId: 'composerMode.spec', icon: 'checklist',
    description: 'Create structured plans with implementation steps',
    thinkingLevel: 'none', shouldAutoApplyIfNoEditTool: false, autoFix: false,
    autoRun: false, fullAutoRun: false, enabledTools: [], enabledMcpServers: [],
  },
  {
    id: 'debug', name: 'Debug', actionId: 'composerMode.debug', icon: 'bug',
    description: 'Systematically diagnose and fix bugs using runtime traces',
    thinkingLevel: 'none', shouldAutoApplyIfNoEditTool: true, autoFix: false,
    autoRun: false, fullAutoRun: false, enabledTools: [], enabledMcpServers: [],
  },
  {
    id: 'multitask', name: 'Multitask', actionId: 'composerMode.multitask', icon: 'circles',
    description: 'Run and coordinate multiple tasks in parallel',
    thinkingLevel: 'none', shouldAutoApplyIfNoEditTool: true, autoFix: false,
    autoRun: true, fullAutoRun: false, enabledTools: [], enabledMcpServers: [],
  },
  {
    id: 'chat', name: 'Ask', actionId: 'composerMode.chat', icon: 'chat',
    description: 'Ask Cursor questions about your codebase',
    thinkingLevel: 'none', shouldAutoApplyIfNoEditTool: false, autoFix: true,
    autoRun: false, fullAutoRun: false, enabledTools: [], enabledMcpServers: [],
  },
];

/** Alias for the triage seed def (agent-mode-triage). */
export const TRIAGE_MODE_DEF: ComposerModeDef =
  BUILTIN_MODE_SEEDS.find((m) => m.id === 'triage') as ComposerModeDef;

/**
 * agent-mode-triage verdict: triage is REGISTERED but NOT selectable.
 * The binary's `getAllModes()` drops it from the picker list, so no
 * `composerMode.triage` command is registered and no palette/keybinding path
 * activates it. This constant pins that verdict in code.
 */
export const TRIAGE_PICKER_SELECTABLE = false;

// ---------------------------------------------------------------------------
// Modes service semantics (pure ports of the binary's composerModesService)
// ---------------------------------------------------------------------------

/**
 * Binary `getAllModes()` (@40176116), ported exactly:
 * slice → keep PROTECTED ids → drop spec/triage → sort by MODE_SORT_ORDER,
 * with ids missing from the order keeping raw storage order.
 *
 * NOTE: like the binary, this does NOT include user custom modes — those
 * ride as `activeCustomMode` overlays (see `activateCustomModeOverlay`),
 * never as unifiedModes.
 */
export function getAllModes(storedModes: ComposerModeDef[]): ComposerModeDef[] {
  const raw = storedModes.slice();
  const excluded = PICKER_EXCLUDED_MODE_IDS as readonly string[];
  const order = MODE_SORT_ORDER as readonly string[];
  return raw
    .filter((m) => PROTECTED_MODE_ID_SET.has(m.id))
    .filter((m) => !excluded.includes(m.id))
    .sort((a, b) => {
      const ai = order.indexOf(a.id);
      const bi = order.indexOf(b.id);
      const ra = ai === -1 ? raw.indexOf(a) : ai;
      const rb = bi === -1 ? raw.indexOf(b) : bi;
      return ra - rb;
    });
}

/**
 * Binary `getMode(id)`: find in getAllModes(); if missing but the id is
 * protected, fall back to the raw stored list (this is how "triage"
 * resolves despite being picker-excluded). Returns undefined on a true
 * miss — the binary logs `[composerModesService] Mode not found: <id>`
 * there; this pure port leaves logging to the caller.
 */
export function getMode(storedModes: ComposerModeDef[], id: string): ComposerModeDef | undefined {
  const found = getAllModes(storedModes).find((m) => m.id === id);
  if (found) {
    return found;
  }
  if (PROTECTED_MODE_ID_SET.has(id)) {
    return storedModes.find((m) => m.id === id);
  }
  return undefined;
}

/** Binary `checkIfModeExists(id)`: in getAllModes() OR a protected id. */
export function checkIfModeExists(storedModes: ComposerModeDef[], id: string): boolean {
  return getAllModes(storedModes).some((m) => m.id === id) || PROTECTED_MODE_ID_SET.has(id);
}

/**
 * Binary `generateActionIdForMode()` (@40187458): `composerMode.<name
 * lowercased, spaces → underscores>`, `_2`-suffixed until unique among the
 * other modes' actionIds; no name → `composerMode.<id>`.
 */
export function generateActionIdForMode(mode: ComposerModeDef, allModes: ComposerModeDef[]): string {
  if (!mode.name) {
    return `${ACTION_ID_PREFIX}${mode.id}`;
  }
  const slug = mode.name.toLowerCase().replace(/\s+/g, '_');
  const base = `${ACTION_ID_PREFIX}${slug}`;
  const taken = allModes
    .filter((m) => m.id !== mode.id && !!m.actionId)
    .map((m) => m.actionId as string);
  if (!taken.includes(base)) {
    return base;
  }
  let n = 2;
  while (taken.includes(`${base}_${n}`)) {
    n += 1;
  }
  return `${base}_${n}`;
}

/**
 * Binary `registerExistingModeActions()` (@40173411): one command per
 * getAllModes() entry that has an actionId. triage/spec are NOT in
 * getAllModes() → they get NO command. This is why there is no
 * `composerMode.triage` command despite the def carrying that actionId.
 */
export function registerableModeActions(
  storedModes: ComposerModeDef[],
): Array<{ modeId: string; actionId: string }> {
  return getAllModes(storedModes)
    .filter((m) => !!m.actionId)
    .map((m) => ({ modeId: m.id, actionId: m.actionId as string }));
}

/**
 * Binary `hkb(t)`: `!DWE.has(t.id)` — a mode is "custom" iff its id is not
 * protected. (3.25.9 @38004171)
 */
export function isCustomModeDef(mode: ComposerModeDef): boolean {
  return !PROTECTED_MODE_ID_SET.has(mode.id);
}

// ---------------------------------------------------------------------------
// Registry — persistent modes4 store with custom-mode CRUD
// ---------------------------------------------------------------------------

/** Plain storage adapter; the binary's is the reactive persistent storage. */
export interface IComposerModesStorage {
  load(): ComposerModeDef[];
  save(modes: ComposerModeDef[]): void;
}

function cloneDef(def: ComposerModeDef): ComposerModeDef {
  return {
    ...def,
    enabledTools: [...def.enabledTools],
    enabledMcpServers: [...def.enabledMcpServers],
  };
}

export class ComposerModesRegistry {
  constructor(
    private readonly storage: IComposerModesStorage,
    private readonly seed: ComposerModeDef[] = BUILTIN_MODE_SEEDS,
  ) {}

  /** Seed storage with the built-in defs when empty (fresh profile). */
  ensureSeeded(): void {
    const current = this.storage.load();
    if (!Array.isArray(current) || current.length === 0) {
      this.storage.save(this.seed.map(cloneDef));
    }
  }

  /**
   * Add seed defs that are missing (mirrors the binary's storage
   * migrations v106/v117/v119/v121 which back-fill background/plan/spec/
   * triage for existing users). Custom modes are never touched.
   */
  ensureBuiltinsPresent(): void {
    const current = this.storage.load();
    if (!Array.isArray(current)) {
      return;
    }
    const ids = new Set(current.map((m) => m.id));
    let changed = false;
    for (const def of this.seed) {
      if (!ids.has(def.id)) {
        current.push(cloneDef(def));
        changed = true;
      }
    }
    if (changed) {
      this.storage.save(current);
    }
  }

  getAllModes(): ComposerModeDef[] {
    return getAllModes(this.storage.load());
  }

  getMode(id: string): ComposerModeDef | undefined {
    return getMode(this.storage.load(), id);
  }

  checkIfModeExists(id: string): boolean {
    return checkIfModeExists(this.storage.load(), id);
  }

  registerableModeActions(): Array<{ modeId: string; actionId: string }> {
    return registerableModeActions(this.storage.load());
  }

  /** Binary `updateModeSetStore(id, updater)`. Returns false when missing. */
  updateMode(id: string, updater: (mode: ComposerModeDef) => void): boolean {
    const modes = this.storage.load();
    const target = modes.find((m) => m.id === id);
    if (!target) {
      return false;
    }
    updater(target);
    this.storage.save(modes);
    return true;
  }

  /** Binary `setModeThinkingLevel(id, level)`. */
  setModeThinkingLevel(id: string, level: string): boolean {
    return this.updateMode(id, (m) => {
      m.thinkingLevel = level;
    });
  }

  /** Binary `setModeAutoRun(id, autoRun)`. */
  setModeAutoRun(id: string, autoRun: boolean): boolean {
    return this.updateMode(id, (m) => {
      m.autoRun = autoRun;
    });
  }

  /**
   * Register (or replace) a user custom mode. Protected ids are rejected —
   * the binary's protected set guards the built-ins from being overwritten
   * by customs (hkb/DWE). Throws on a protected id.
   */
  upsertCustomMode(def: ComposerModeDef): ComposerModeDef {
    if (PROTECTED_MODE_ID_SET.has(def.id)) {
      throw new Error(`[composerModes] refusing to overwrite protected mode id "${def.id}" with a custom mode`);
    }
    const modes = this.storage.load();
    const normalized: ComposerModeDef = {
      ...cloneDef(def),
      actionId: def.actionId ?? generateActionIdForMode(def, modes),
    };
    const i = modes.findIndex((m) => m.id === normalized.id);
    if (i === -1) {
      modes.push(normalized);
    } else {
      modes[i] = normalized;
    }
    this.storage.save(modes);
    return normalized;
  }

  /**
   * Delete a user custom mode. Returns false when the id is protected or
   * absent (binary: protected modes cannot be deleted).
   */
  deleteCustomMode(id: string): boolean {
    if (PROTECTED_MODE_ID_SET.has(id)) {
      return false;
    }
    const modes = this.storage.load();
    const next = modes.filter((m) => m.id !== id);
    if (next.length === modes.length) {
      return false;
    }
    this.storage.save(next);
    return true;
  }

  /** All non-protected (user-defined) modes. */
  getCustomModes(): ComposerModeDef[] {
    return this.storage.load().filter(isCustomModeDef);
  }

  /**
   * Binary `workbench.contrib.customModesExistenceChecker`: true when any
   * custom mode exists (drives the context key gating custom-mode UI).
   */
  hasCustomModes(): boolean {
    return this.getCustomModes().length > 0;
  }

  /**
   * Binary "Reset Chat Mode to Default": restores modes4 to the seed list.
   * (3.25.6 @39859514: `setApplicationUserPersistentStorage(
   * "composerState","modes4",LB.modes4)`.)
   */
  resetToDefaults(): void {
    this.storage.save(this.seed.map(cloneDef));
  }

  /**
   * Binary `workbench.action.exportCustomModes` file list (IO excluded):
   * one `{fileName, content}` per custom mode. The caller writes each file
   * under `<userHome>/.cursor/commands/` and reveals the folder — exactly
   * what the binary's command does after computing this list.
   */
  exportCustomModes(): CustomModeExportFile[] {
    const customs = this.getCustomModes();
    const taken = new Set<string>();
    return customs.map((m, i) => ({
      fileName: exportFileNameFor(m, i, taken),
      content: serializeCustomModeExport(m),
    }));
  }
}

// ---------------------------------------------------------------------------
// Custom-mode-for-display: slash-command → mode (binary `fvC`, 3.25.9 @29825262)
// ---------------------------------------------------------------------------

/** Minimal slash-command shape the fvC port reads. */
export interface SlashCommandLike {
  id: string;
  label: string;
  commandName?: string;
  description?: string;
  sourceUri?: string;
  badgeAppearance?: { icon: string; colorId: string };
  managedSkillId?: string;
}

/**
 * Binary `CustomModeForDisplay` shape (field names verbatim from `fvC`).
 * `source` is the binary's `Yde.MANAGED_SKILL` / `Yde.REPO_SKILL` enum;
 * the enum's runtime values were not captured — string literals here.
 */
export interface CustomModeForDisplay {
  cacheState: 'cached-display';
  id: string;
  label: string;
  fullPath: string;
  badgeAppearance: { icon: string; colorId: string };
  description?: string;
  source: 'managed-skill' | 'repo-skill';
  sourcePath: string;
  managedSkillId?: string;
  skillFilename: string;
}

/**
 * `ZQv` port — UNKNOWN exact semantics: extracts the skill filename from the
 * command id. Returns undefined when no filename can be determined, in
 * which case (like the binary) the command is NOT convertible to a mode.
 */
function skillFilenameFromCommandId(commandId: string): string | undefined {
  const m = /([^/\\]+?)(?:\.(md|txt))?$/i.exec(commandId.trim());
  const name = m?.[1]?.trim();
  return name ? name : undefined;
}

/**
 * `DZa` port — UNKNOWN exact semantics: display id derived from the full
 * path. Sane slugify; the binary's exact transform was not captured.
 */
function displayIdFromPath(fullPath: string): string {
  return fullPath.toLowerCase().trim().replace(/\s+/g, '-').replace(/[^a-z0-9-_./]/g, '');
}

/**
 * Binary `fvC(t)` (3.25.9 @29825262), ported:
 * `const e=ZQv(t.id); if(e===void 0)return; const n=t.commandName??t.label,
 * i=fYm(n), r=t.sourceUri??n; return{cacheState:"cached-display",id:DZa(r),
 * label:t.label,fullPath:r,badgeAppearance:t.badgeAppearance??
 * {icon:"lightning",colorId:"default"},description:t.description,
 * source:t.managedSkillId!==void 0?MANAGED_SKILL:REPO_SKILL,
 * sourcePath:t.sourceUri??i,managedSkillId:t.managedSkillId,skillFilename:e}`.
 */
export function customModeFromSlashCommand(cmd: SlashCommandLike): CustomModeForDisplay | undefined {
  const skillFilename = skillFilenameFromCommandId(cmd.id);
  if (skillFilename === undefined) {
    return undefined;
  }
  const name = cmd.commandName ?? cmd.label;
  const fullPath = cmd.sourceUri ?? name;
  return {
    cacheState: 'cached-display',
    id: displayIdFromPath(fullPath),
    label: cmd.label,
    fullPath,
    badgeAppearance: cmd.badgeAppearance ?? { icon: 'lightning', colorId: 'default' },
    description: cmd.description,
    source: cmd.managedSkillId !== undefined ? 'managed-skill' : 'repo-skill',
    sourcePath: cmd.sourceUri ?? name,
    managedSkillId: cmd.managedSkillId,
    skillFilename,
  };
}

/**
 * The binary's `customModeIdBySkillKey` map: each source command's
 * id/label/commandName → the derived custom mode id (3.25.9 @29841114).
 */
export function buildCustomModeIdBySkillKey(
  entries: Array<{ command: SlashCommandLike; mode: CustomModeForDisplay }>,
): Map<string, string> {
  const map = new Map<string, string>();
  for (const { command, mode } of entries) {
    map.set(command.id, mode.id);
    map.set(command.label, mode.id);
    if (command.commandName !== undefined) {
      map.set(command.commandName, mode.id);
    }
  }
  return map;
}

/**
 * Custom-mode activation overlay. In the binary, selecting a custom mode
 * does NOT change `unifiedMode` — it sets `activeCustomMode` (+
 * `customModeIntent` enter/exit, `modeOverride:CUSTOM`) on the composer.
 * This descriptor is the pure-data equivalent for future wiring.
 */
export interface CustomModeActivation {
  kind: 'custom';
  modeId: string;
  label: string;
  skillFilename: string;
  sourcePath: string;
}

export function activateCustomModeOverlay(mode: CustomModeForDisplay): CustomModeActivation {
  return {
    kind: 'custom',
    modeId: mode.id,
    label: mode.label,
    skillFilename: mode.skillFilename,
    sourcePath: mode.sourcePath,
  };
}

// ---------------------------------------------------------------------------
// Export serialization: binary OWE/FWE/BWE (3.25.9 @38004171)
// ---------------------------------------------------------------------------

/**
 * Binary `BWE(toolEnum)` display names, verbatim. Note: APPLY_AGENT_DIFF has
 * NO case in the binary → it maps to "" and is filtered out of the export
 * (kept here as "" to preserve that exact behavior — do not "fix" it).
 */
const TOOL_DISPLAY_NAMES: Record<string, string> = {
  READ_FILE: 'Read',
  READ_FILE_V2: 'Read',
  READ_MCP_RESOURCE: 'Read',
  RIPGREP_SEARCH: 'Grep',
  RIPGREP_RAW_SEARCH: 'Grep',
  GLOB_FILE_SEARCH: 'Glob',
  FILE_SEARCH: 'Glob',
  RUN_TERMINAL_COMMAND_V2: 'Shell',
  EDIT_FILE: 'Edit',
  EDIT_FILE_V2: 'Edit',
  LIST_DIR: 'LS',
  LIST_DIR_V2: 'LS',
  SEMANTIC_SEARCH_FULL: 'SemanticSearch',
  READ_SEMSEARCH_FILES: 'SemanticSearch',
  DELETE_FILE: 'Delete',
  WEB_SEARCH: 'WebSearch',
  MCP: 'MCP',
  CALL_MCP_TOOL: 'MCP',
  TASK_V2: 'Task',
  APPLY_AGENT_DIFF: '',
  CREATE_PLAN: 'CreatePlan',
  READ_LINTS: 'ReadLints',
  LIST_MCP_RESOURCES: 'ListMCPResources',
  TODO_WRITE: 'TodoWrite',
  ASK_QUESTION: 'AskQuestion',
};

/** Binary `BWE`: tool enum → display name, "" when unmapped. */
export function toolDisplayName(toolEnumName: string): string {
  return TOOL_DISPLAY_NAMES[toolEnumName] ?? '';
}

/**
 * Binary `OWE(mode)` (3.25.9 @38004171), verbatim:
 * `"Only using the following tools: <names>\n\n" + "<customRulesForAI>\n"`.
 * `FWE`: deduped `BWE` names joined with ", ", "" when empty.
 */
export function serializeCustomModeExport(mode: ComposerModeDef): string {
  const names = Array.from(new Set((mode.enabledTools ?? []).map(toolDisplayName).filter(Boolean)));
  const toolsLine = names.join(', ');
  let out = '';
  if (toolsLine) {
    out += `Only using the following tools: ${toolsLine}\n\n`;
  }
  const rules = (mode.customRulesForAI ?? '').trim();
  if (rules) {
    out += `${rules}\n`;
  }
  return out;
}

/**
 * Binary `UWE(name)` — PARTIAL port: the binary lowercases/trims then
 * replaces (the exact character class was not captured). Marked as such.
 */
export function sanitizeExportFileBase(name: string): string {
  return name.toLowerCase().trim().replace(/\s+/g, '-').replace(/[^a-z0-9-_]/g, '');
}

/**
 * Export file naming from `workbench.action.exportCustomModes`:
 * `<sanitized name>.md`, falling back to `mode-<i>.md`, deduped as
 * `<base>_<n>.md` starting at n=1 (verbatim loop from the binary).
 */
export function exportFileNameFor(
  mode: ComposerModeDef,
  fallbackIndex: number,
  taken: Set<string>,
): string {
  const raw = (mode.name ?? '').trim() || `mode-${fallbackIndex + 1}`;
  const base = sanitizeExportFileBase(raw) || `mode-${fallbackIndex + 1}`;
  let file = `${base}.md`;
  let n = 1;
  while (taken.has(file)) {
    file = `${base}_${n}.md`;
    n += 1;
  }
  taken.add(file);
  return file;
}

/** One export file produced by `ComposerModesRegistry.exportCustomModes()`. */
export interface CustomModeExportFile {
  fileName: string;
  content: string;
}
