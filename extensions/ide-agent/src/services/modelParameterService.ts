/**
 * Model parameter definitions — the `isCycleableByHotkey` lookup behind
 * Cursor's "Cycle Model Parameter" (composer.cycleModelParameter).
 *
 * Binary mechanism (workbench.glass.main.js 3.25.6, audit-fix-queue.md run
 * 2026-10-19 + DEV-GAPS-29): the run does
 * `cycleFocusedTargetInWindow() || executeCommand(cycleModel)` — the first
 * half scans the current model's `parameterDefinitions` for entries with
 * `isCycleableByHotkey && count > 1` and cycles the focused one through its
 * options; when nothing is cycleable it falls back to cycling the model.
 *
 * This module ports that mechanism to the fork:
 *  - `ModelParameterDefinition` mirrors the binary's parameter shape
 *    (`isCycleableByHotkey` included — 0 hits in src/ before this fix).
 *  - `findCycleableParameters` is the binary lookup, verbatim semantics:
 *    only `isCycleableByHotkey && options.length > 1` (the binary's
 *    `isCycleableByHotkey&&count>1`).
 *  - `nextParameterOption` advances one step with wrap-around.
 *  - `buildModelParameterDefinitions` derives the fork's real per-model
 *    parameter surface from the engine catalog: catalog entries for the SAME
 *    model (providerID + id) that differ only in `variant` form a "variant"
 *    parameter whose options are the variant values. Cursor's binary keywords
 *    ("effort"/"thinking") have no counterpart in our engine catalog, so the
 *    variant grouping is the fork's honest per-model multi-option parameter;
 *    a model with a single variant yields `options.length === 1` and is NOT
 *    cycleable — exactly the binary's count>1 gate.
 *
 * Pure functions — unit-tested in modelParameterService.test.ts (node:test,
 * zero extra deps).
 */
import { EngineModelInfo, ModelRef } from "./agentService";

/** Per-model parameter definition (binary `model.parameterDefinitions` entry). */
export interface ModelParameterDefinition {
  /** Stable id, e.g. "variant". */
  id: string;
  /** Display label, e.g. "Variant". */
  label: string;
  /** Binary keywords analog ("effort"/"thinking" in Cursor). */
  keywords: string[];
  /** Selectable values; must have > 1 entry to be cycleable. */
  options: string[];
  /** The binary's `isCycleableByHotkey` flag. */
  isCycleableByHotkey: boolean;
}

/** The fork's only cycleable per-model parameter: engine model variants. */
export const MODEL_VARIANT_PARAMETER_ID = "variant";

/**
 * Binary lookup: keep only parameters with `isCycleableByHotkey` and more
 * than one option (`isCycleableByHotkey&&count>1`).
 */
export function findCycleableParameters(
  definitions: readonly ModelParameterDefinition[],
): ModelParameterDefinition[] {
  return definitions.filter((d) => d.isCycleableByHotkey && d.options.length > 1);
}

/**
 * Next option after `current`, wrapping around. `current` not in the list
 * (or undefined) starts at the first option — Cursor restarts the cycle.
 */
export function nextParameterOption(
  definition: ModelParameterDefinition,
  current: string | undefined,
): string {
  const options = definition.options;
  if (options.length === 0) {
    throw new Error(`model parameter "${definition.id}" has no options`);
  }
  const idx = current === undefined ? -1 : options.indexOf(current);
  return options[(idx + 1) % options.length]!;
}

/**
 * Derive parameter definitions for the currently selected model from the
 * engine catalog. Groups entries by (providerID, id); distinct variants of
 * the same model become the cycleable "variant" parameter. Returns [] when
 * the ref is undefined (auto/cursor-default virtual selectors have no
 * concrete model to parameterize).
 */
export function buildModelParameterDefinitions(
  catalog: readonly EngineModelInfo[],
  ref: ModelRef | undefined,
): ModelParameterDefinition[] {
  if (!ref) {
    return [];
  }
  const variants: string[] = [];
  const seen = new Set<string>();
  for (const m of catalog) {
    if (m.providerID !== ref.providerID || m.id !== ref.id) {
      continue;
    }
    const v = typeof m.variant === "string" && m.variant.length > 0 ? m.variant : "";
    if (!seen.has(v)) {
      seen.add(v);
      variants.push(v);
    }
  }
  if (variants.length === 0) {
    return [];
  }
  return [
    {
      id: MODEL_VARIANT_PARAMETER_ID,
      label: "Variant",
      keywords: ["variant"],
      options: variants,
      isCycleableByHotkey: true,
    },
  ];
}
