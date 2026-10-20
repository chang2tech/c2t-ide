/**
 * Cmd+K (inline edit) model eligibility — Cursor parity (feature_id
 * `cmdk-model-eligibility`). Pure logic: no vscode imports, unit-testable
 * under plain node:test (same pattern as modelService.ts).
 *
 * EVIDENCE (all real, no inference presented as fact):
 *  1. Staff-confirmed — Colin (Cursor staff), forum.cursor.com/t/cursor-2-2-20-inline-edit-issue/146433
 *     (2025-12-16), quoted verbatim: "Cmd+K is designed for fast, non-reasoning
 *     models suitable for quick inline edits rather than deep reasoning tasks.
 *     There are a couple of criteria used to determine whether a model is
 *     available or not when using Ctrl+K. One of those is that only non-thinking
 *     models are available. Another would be that models that require max mode
 *     aren't available."
 *  2. Binary-OBSERVED (3.25.9, cursor-agent-exec/dist/main.js;
 *     docs/rea/dig-root-team/root-js.md:135, findings-root-js.json:160) —
 *     per-model capability flags: `supportsAgent` / `supportsPlanMode` /
 *     `supportsSandboxing` / `supportsNonMaxMode` / `supportsCmdK`.
 *  3. Binary-OBSERVED (3.25.9 glass; docs/rea/dig-continuous-inline-edit-2026-10-19.md:18) —
 *     the Cmd+K backend submits with `submitEditWithSelection({options:{fastMode, ...}})`:
 *     Cmd+K turns run in fast mode, consistent with the staff statement.
 *
 * HONEST SCOPE NOTE: Cursor computes `supportsCmdK` in its own model registry
 * (server-side); the flags are plumbed through here so that when the engine
 * catalog carries them, parity holds exactly. When the engine omits the
 * metadata, the model stays eligible (fail-open) — the filter then degrades to
 * a no-op rather than hiding the user's models. This is documented, not silent.
 */

/** The capability signals a model record may carry for Cmd+K eligibility. */
export interface CmdKEligibilityInfo {
  /**
   * Binary-verbatim capability flag (cursor-agent-exec/dist/main.js).
   * Cursor's registry computes this from the criteria below; when present it
   * is authoritative.
   */
  readonly supportsCmdK?: boolean;
  /** Staff criterion 1: "only non-thinking models are available". */
  readonly thinking?: boolean;
  /** Staff criterion 2: "models that require max mode aren't available". */
  readonly requiresMaxMode?: boolean;
}

/**
 * Whether `model` may appear in the Cmd+K (inline edit) model picker.
 *
 * Precedence (mirrors Cursor's architecture — the registry flag IS the
 * verdict, the staff criteria are how the registry computes it):
 *   1. `supportsCmdK` explicitly set → authoritative (true = eligible).
 *   2. Otherwise apply the staff criteria: `thinking === true` or
 *      `requiresMaxMode === true` → ineligible.
 *   3. No metadata at all → eligible (fail-open; see scope note above).
 */
export function isModelEligibleForCmdK(model: CmdKEligibilityInfo): boolean {
  if (typeof model.supportsCmdK === "boolean") {
    return model.supportsCmdK;
  }
  if (model.thinking === true) {
    return false;
  }
  if (model.requiresMaxMode === true) {
    return false;
  }
  return true;
}

/** Keep only the Cmd+K-eligible models, preserving engine order. */
export function filterModelsEligibleForCmdK<T extends CmdKEligibilityInfo>(
  models: readonly T[],
): T[] {
  return models.filter(isModelEligibleForCmdK);
}
