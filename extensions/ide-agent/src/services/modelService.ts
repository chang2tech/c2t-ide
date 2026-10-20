import { EngineModelInfo, ModelRef } from "./agentService";

/**
 * ModelService — chat model selection state (M-03 model picker, Cursor parity).
 *
 * Owns the currently selected model for agent turns:
 *   - persisted per workspace (workspaceState-backed store, injected by
 *     ComposerDataService — this module never imports vscode so it stays
 *     unit-testable under plain node:test),
 *   - "auto" (kind "auto", no explicit ref) means automatic routing — the
 *     engine default is used; "cursor-default" (kind "cursor-default") is the
 *     Cursor-parity virtual selector for Settings > Models > "Default Model"
 *     (live value `cursor-default`); both resolve through the engine default
 *     (see the engine-adapter seam),
 *   - changes fire onDidChangeModel, which ComposerDataService forwards as a
 *     `modelChanged` ComposerEvent so the webview's model button stays honest.
 *
 * The actual engine switching lives in the EngineAdapter seam
 * (EngineAdapter.setModel / listModels / getDefaultModel — implemented by
 * IdeCodeEngineAdapter against the real /api/model + /api/session/:id/model
 * endpoints). This service only owns selection state; it never talks to the
 * engine itself.
 */
/**
 * P1 (DEV-MODEL-PICKER-ENTRIES, Cursor parity): first-class model-picker
 * selection kinds. Cursor's composer model picker (detail-chat-2026-10-19 §4)
 * has two virtual entries on top of the concrete engine catalog:
 *
 * - "Auto" — "Balanced quality and speed, recommended for most tasks"
 *   (verbatim description from the live 3.25.9 capture). Automatic routing;
 *   NOT a fixed model.
 * - "Cursor Default" (live value `cursor-default`, observed in
 *   Settings > Models > "Default Model" — "What model new agents use by
 *   default", detail-settings-2026-10-19 §"Models").
 *
 * `kind` is optional so persisted pre-P1 selections (which only carried
 * `ref`/`label`) keep working: no ref = auto, a ref = explicit.
 */
export type ModelSelectionKind = "auto" | "cursor-default" | "explicit";

export interface ModelSelection {
  /** Explicit model reference; absent = virtual selector (auto/cursor-default). */
  ref?: ModelRef;
  /** Human label shown in the composer model button. */
  label: string;
  /** Selection kind; legacy persisted selections omit it (derived by selectionKind). */
  kind?: ModelSelectionKind;
}

/** Wire values for the two virtual picker entries. */
export const AUTO_MODEL_VALUE = "auto";
export const CURSOR_DEFAULT_VALUE = "cursor-default";

/** Verbatim picker entry for "Auto" (live capture, detail-chat-2026-10-19 §4). */
export const AUTO_MODEL_LABEL = "Auto";
export const AUTO_MODEL_DESCRIPTION = "Balanced quality and speed, recommended for most tasks";

/** Picker entry for "Cursor Default" (live value `cursor-default`,
 * detail-settings-2026-10-19). NOTE: the description below is INFERRED —
 * the live capture only showed the setting's label/value, never the
 * option's description text, and web docs don't carry it either. Marked
 * UNKNOWN per the no-guessing rule; re-capture when quota allows. */
export const CURSOR_DEFAULT_LABEL = "Cursor Default";
export const CURSOR_DEFAULT_DESCRIPTION = "Use the default model for new agents";

/** One row of the composer model picker (quickpick-agnostic). */
export interface ModelPickerEntry {
  /**
   * Stable value: "auto" | "cursor-default" | ModelService.refToString(ref).
   * This is what gets persisted/compared — never the label.
   */
  value: string;
  /** Label shown in the picker. */
  label: string;
  /** Description shown under the label (Auto's is verbatim from Cursor). */
  description?: string;
  /** Present only for concrete engine models. */
  ref?: ModelRef;
  /**
   * Context window size in tokens, carried through from the catalog entry
   * (DEV-GAPS-88; Cursor's AvailableModel `contextTokenLimit`). Absent
   * when the engine reported no limit for the model.
   */
  contextTokenLimit?: number;
}

/**
 * DEV-GAPS-88: read the context window (tokens) off a raw engine
 * Model.Info wire object.
 *
 * The engine's catalog schema (ide-code `packages/schema/src/model.ts`)
 * is `limit: { context: Int, input?: Int, output: Int }` — `limit.context`
 * is the model's context window, the counterpart of Cursor's
 * AvailableModel `context_token_limit` (field 15). Returns undefined for
 * anything that is not a finite positive number: the field stays absent
 * rather than guessed when the engine omits it.
 */
export function contextTokenLimitFromEngineModel(raw: unknown): number | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const limit = (raw as Record<string, unknown>).limit;
  if (!limit || typeof limit !== "object") return undefined;
  const context = (limit as Record<string, unknown>).context;
  if (typeof context !== "number" || !Number.isFinite(context) || context <= 0) {
    return undefined;
  }
  return Math.round(context);
}

/**
 * GAPS-183: resolve the REAL context-window denominator (tokens) for the
 * currently active model — the `contextTokenLimit` the ring/report divide by.
 *
 * Resolution (catalog = `EngineAdapter.listModels()` output, whose entries
 * carry `contextTokenLimit` mapped from the engine wire `limit.context` by
 * IdeCodeEngineAdapter — DEV-GAPS-88):
 * - explicit selection (has `ref`): the catalog entry for that exact ref
 *   (providerID + id + variant, via ModelService.refEquals). If no entry
 *   matches exactly, an entry with the same providerID + id is accepted —
 *   a variant is the same underlying model, so its window is the model's
 *   window; the exact match is always preferred when present.
 * - "auto" / "cursor-default" (no ref): the ENGINE DEFAULT model's limit
 *   (`EngineAdapter.getDefaultModel()`), because that is the model the
 *   engine will actually run. The catalog alone cannot identify the
 *   default, so without `defaultModel` this stays unresolved.
 *
 * Returns undefined when nothing usable resolves (unknown model, entry
 * without a limit, missing default) — the caller then applies the fork's
 * documented fallback (contextUsageService FALLBACK_CONTEXT_WINDOW_TOKENS).
 * Never guesses a limit from a different model.
 */
export function resolveActiveContextTokenLimit(args: {
  selection: ModelSelection;
  catalog: readonly EngineModelInfo[];
  defaultModel?: EngineModelInfo;
}): number | undefined {
  const usable = (info: EngineModelInfo | undefined): number | undefined => {
    const limit = info?.contextTokenLimit;
    return typeof limit === "number" && Number.isFinite(limit) && limit > 0
      ? Math.round(limit)
      : undefined;
  };
  const { selection, catalog, defaultModel } = args;
  if (selection.ref) {
    const ref = selection.ref;
    const exact = catalog.find((m) =>
      ModelService.refEquals(
        { id: m.id, providerID: m.providerID, ...(m.variant ? { variant: m.variant } : {}) },
        ref,
      ),
    );
    if (exact) {
      return usable(exact);
    }
    const sameModel = catalog.find((m) => m.providerID === ref.providerID && m.id === ref.id);
    return usable(sameModel);
  }
  return usable(defaultModel);
}

/** Derive the selection kind, including for legacy persisted selections. */
export function selectionKind(selection: ModelSelection): ModelSelectionKind {
  if (selection.kind === "cursor-default") return "cursor-default";
  if (selection.kind === "explicit" || selection.ref) return "explicit";
  return "auto";
}

/** Stable value for a selection (mirrors the picker's entry values). */
export function selectionValue(selection: ModelSelection): string {
  const kind = selectionKind(selection);
  if (kind === "explicit" && selection.ref) {
    return ModelService.refToString(selection.ref);
  }
  return kind === "cursor-default" ? CURSOR_DEFAULT_VALUE : AUTO_MODEL_VALUE;
}

/** Canonical "Auto" selection. */
export function autoSelection(): ModelSelection {
  return { kind: "auto", label: AUTO_MODEL_LABEL };
}

/** Canonical "Cursor Default" selection. */
export function cursorDefaultSelection(): ModelSelection {
  return { kind: "cursor-default", label: CURSOR_DEFAULT_LABEL };
}

/**
 * P1 (DEV-MODEL-PICKER-ENTRIES): the full composer model-picker list —
 * "Auto" and "Cursor Default" virtual entries followed by the
 * enabled engine catalog (provider grouping happens in the quickpick).
 *
 * ORDER NOTE (UNKNOWN, do not treat as verified): the live 3.25.9 capture
 * only ever showed "Auto" alone (account was at "Usage limit reached", so
 * the full list never rendered). "Auto" is listed first to match the live
 * composer trigger default ("Auto"); the relative order of "Cursor Default"
 * vs "Auto" is UNVERIFIED — re-check against a quota-holding account.
 */
export function buildModelPickerEntries(
  models: readonly EngineModelInfo[],
  enabledModels: readonly string[],
): ModelPickerEntry[] {
  const entries: ModelPickerEntry[] = [
    { value: AUTO_MODEL_VALUE, label: AUTO_MODEL_LABEL, description: AUTO_MODEL_DESCRIPTION },
    {
      value: CURSOR_DEFAULT_VALUE,
      label: CURSOR_DEFAULT_LABEL,
      description: CURSOR_DEFAULT_DESCRIPTION,
    },
  ];
  for (const m of filterEnabledModels(models, enabledModels)) {
    const ref: ModelRef = {
      id: m.id,
      providerID: m.providerID,
      ...(m.variant ? { variant: m.variant } : {}),
    };
    entries.push({
      value: ModelService.refToString(ref),
      label: ModelService.labelFor(m),
      description: m.name && m.name !== m.id ? m.id : undefined,
      ref,
      ...(m.contextTokenLimit !== undefined ? { contextTokenLimit: m.contextTokenLimit } : {}),
    });
  }
  return entries;
}

/** Persistence behind the selection. Injected — vscode-backed in prod. */
export interface ModelSelectionStore {
  load(): ModelSelection | undefined;
  save(selection: ModelSelection): void;
}

/** In-memory store: tests and contexts without an ExtensionContext. */
export class InMemoryModelStore implements ModelSelectionStore {
  private saved?: ModelSelection;
  load(): ModelSelection | undefined {
    return this.saved;
  }
  save(selection: ModelSelection): void {
    this.saved = selection;
  }
}

/** Default selection label — matches Cursor's live composer trigger text ("Auto"). */
export const DEFAULT_MODEL_LABEL = "Auto";

export class ModelService {
  private selection: ModelSelection;
  private readonly listeners = new Set<(selection: ModelSelection) => void>();

  constructor(private readonly store: ModelSelectionStore = new InMemoryModelStore()) {
    const restored = store.load();
    this.selection =
      restored && typeof restored.label === "string" && restored.label.length > 0
        ? restored
        : autoSelection();
  }

  getSelection(): ModelSelection {
    return this.selection;
  }

  /** Persist the selection and notify listeners (webview updates via ComposerDataService). */
  setSelection(selection: ModelSelection): void {
    this.selection = selection;
    this.store.save(selection);
    for (const listener of this.listeners) {
      try {
        listener(selection);
      } catch {
        /* listener errors must not break selection persistence */
      }
    }
  }

  onDidChangeModel(listener: (selection: ModelSelection) => void): { dispose(): void } {
    this.listeners.add(listener);
    return {
      dispose: () => {
        this.listeners.delete(listener);
      },
    };
  }

  /** Display label for an engine model: friendly name, falling back to the id. */
  static labelFor(info: EngineModelInfo): string {
    const name = typeof info.name === "string" ? info.name.trim() : "";
    return name.length > 0 ? name : info.id;
  }

  /** Identity comparison for model refs (provider + id + variant). */
  static refEquals(a: ModelRef | undefined, b: ModelRef | undefined): boolean {
    if (!a || !b) {
      return !a && !b;
    }
    return (
      a.providerID === b.providerID && a.id === b.id && (a.variant ?? "") === (b.variant ?? "")
    );
  }

  /** "providerID/modelID" wire form (variant appended as #variant when present). */
  static refToString(ref: ModelRef): string {
    return `${ref.providerID}/${ref.id}${ref.variant ? `#${ref.variant}` : ""}`;
  }

  /**
   * Parse an enabled-models entry back into a ModelRef.
   * Accepts the `refToString` wire form ("providerID/modelID[#variant]").
   * Returns undefined for malformed entries (never throws — config is user-edited).
   */
  static refFromString(entry: string): ModelRef | undefined {
    if (typeof entry !== "string") return undefined;
    const trimmed = entry.trim();
    if (trimmed.length === 0) return undefined;
    const slash = trimmed.indexOf("/");
    if (slash <= 0 || slash === trimmed.length - 1) return undefined;
    const providerID = trimmed.slice(0, slash);
    const rest = trimmed.slice(slash + 1);
    const hash = rest.indexOf("#");
    const id = hash < 0 ? rest : rest.slice(0, hash);
    const variant = hash < 0 ? undefined : rest.slice(hash + 1);
    if (id.length === 0) return undefined;
    return variant ? { providerID, id, variant } : { providerID, id };
  }
}

/**
 * M-04 (Settings UI enable/disable per model): enabled-models allowlist.
 *
 * `ide.agent.enabledModels` holds `ModelService.refToString(ref)` entries.
 * An empty list means every model the engine reports is enabled — this keeps
 * newly-added engine models visible by default instead of silently hiding them.
 * A non-empty list is an exact allowlist: only listed models are selectable
 * (picker, cycle, default restore).
 */
export function isModelEnabled(ref: ModelRef, enabledModels: readonly string[]): boolean {
  if (enabledModels.length === 0) return true;
  const wire = ModelService.refToString(ref);
  return enabledModels.some((entry) => {
    if (typeof entry !== "string") return false;
    return entry.trim() === wire;
  });
}

/** M-04: keep only the enabled models, preserving engine order. */
export function filterEnabledModels(
  models: readonly EngineModelInfo[],
  enabledModels: readonly string[],
): EngineModelInfo[] {
  if (enabledModels.length === 0) return [...models];
  return models.filter((m) =>
    isModelEnabled({ id: m.id, providerID: m.providerID, ...(m.variant ? { variant: m.variant } : {}) }, enabledModels),
  );
}

/**
 * M-09 / ide.cycleModel: the next enabled model after the current selection.
 * Wraps around. The virtual selectors ("auto"/"cursor-default", no ref) are
 * automatic — never a fixed model — so cycling from either restarts at the
 * first enabled model; a now-disabled explicit selection does the same.
 * Returns undefined when no enabled model exists.
 */
export function nextEnabledModel(
  models: readonly EngineModelInfo[],
  enabledModels: readonly string[],
  current: ModelRef | undefined,
): EngineModelInfo | undefined {
  const enabled = filterEnabledModels(models, enabledModels);
  if (enabled.length === 0) return undefined;
  const idx = current
    ? enabled.findIndex((m) =>
        ModelService.refEquals(
          { id: m.id, providerID: m.providerID, ...(m.variant ? { variant: m.variant } : {}) },
          current,
        ),
      )
    : -1;
  return enabled[(idx + 1) % enabled.length];
}
