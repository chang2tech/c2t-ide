/**
 * DEV-GAPS-10: Changes tab command surface (Cursor `workbench-open-changes-tab`
 * parity, audit-fix-queue run 24).
 *
 * Binary evidence (verbatim):
 *   - New-tab-model action {id:"changes", label:"Changes", keywords:["git"],
 *     icon:"plus-minus", keybindingCommandId:"glass.openChangesTab"},
 *     gated on `showChangesAction`.
 *   - Invocation: commandService.executeCommand("glass.openChangesTab",
 *     {scope:"lastTurn", agentId, filePath?}).
 *   - Cloud-agent renderer args:
 *     tabPersistenceService.openAgentChangesTab({bcId, label,
 *     initialFilterScope:"branch", ownerAgentId}).
 *
 * Command-id layout (repo convention `ide.*` -> `composer.*`):
 *   - `ide.openChangesTab`      — this extension (package.json + extension.ts),
 *     delegates to the core action below.
 *   - `composer.openChangesTab` — canonical core Action2 (real implementation,
 *     src/vs/workbench/contrib/composer/browser/composerChangesTab.ts).
 *   - `glass.openChangesTab`    — verbatim binary id, thin compat alias in
 *     core delegating to `composer.openChangesTab`.
 *
 * This module holds the pure, unit-testable pieces: the verbatim new-tab
 * action data and the arg normalizer. The core workbench file mirrors the
 * normalizer (extension code cannot import workbench-core modules).
 */

export const CHANGES_TAB_COMMAND_IDS = {
  /** Extension command (package.json + extension.ts registration). */
  extension: "ide.openChangesTab",
  /** Canonical core Action2 (real implementation). */
  core: "composer.openChangesTab",
  /**
   * Verbatim Cursor binary command id. OWNED by
   * src/vs/sessions/contrib/changes/browser/openChangesTabCommand.ts — the
   * composer side deliberately does not register it (duplicate ids are
   * last-registration-wins in CommandsRegistry).
   */
  glassCompat: "glass.openChangesTab",
} as const;

/**
 * Verbatim Cursor new-tab-model action for the Changes tab (binary evidence).
 * `icon: "plus-minus"` is verbatim data — that codicon does not exist in this
 * VS Code codicon set, so the package.json contribution uses `$(diff)` as the
 * closest fallback (documented at the contribution site).
 */
export const CHANGES_TAB_NEW_TAB_ACTION = {
  id: "changes",
  label: "Changes",
  keywords: ["git"],
  icon: "plus-minus",
  keybindingCommandId: CHANGES_TAB_COMMAND_IDS.glassCompat,
} as const;

/**
 * Invocation args accepted by `ide.openChangesTab`. Accepts both
 * binary-verbatim shapes:
 *   - local: {scope:"lastTurn", agentId, filePath?}
 *   - cloud-agent: {bcId, label, initialFilterScope:"branch", ownerAgentId}
 */
export interface OpenChangesTabArgs {
  scope?: string;
  agentId?: string;
  filePath?: string;
  bcId?: string;
  label?: string;
  initialFilterScope?: string;
  ownerAgentId?: string;
}

export interface NormalizedOpenChangesTabArgs {
  readonly scope: string;
  readonly agentId: string;
  readonly initialFilterScope: string;
  readonly filePath?: string;
  readonly bcId?: string;
  readonly label?: string;
  readonly ownerAgentId?: string;
}

/**
 * Applies the binary-verified defaults (`scope: "lastTurn"`,
 * `initialFilterScope: "branch"`, agent id `"default"`) and drops anything
 * outside the evidence-backed arg shape. Pure — covered by
 * run-changes-tab-tests.ts.
 */
export function normalizeOpenChangesTabArgs(raw: unknown): NormalizedOpenChangesTabArgs {
  const o = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
  const str = (v: unknown): string | undefined =>
    typeof v === "string" && v.length > 0 ? v : undefined;
  return {
    scope: str(o["scope"]) ?? "lastTurn",
    agentId: str(o["agentId"]) ?? "default",
    initialFilterScope: str(o["initialFilterScope"]) ?? "branch",
    filePath: str(o["filePath"]),
    bcId: str(o["bcId"]),
    label: str(o["label"]),
    ownerAgentId: str(o["ownerAgentId"]),
  };
}
