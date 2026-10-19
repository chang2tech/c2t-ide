import { EngineModelInfo, ModelRef } from "./agentService";

/**
 * ModelService — chat model selection state (M-03 model picker, Cursor parity).
 *
 * Owns the currently selected model for agent turns:
 *   - persisted per workspace (workspaceState-backed store, injected by
 *     ComposerDataService — this module never imports vscode so it stays
 *     unit-testable under plain node:test),
 *   - "auto" (no explicit ref) means the engine default is used,
 *   - changes fire onDidChangeModel, which ComposerDataService forwards as a
 *     `modelChanged` ComposerEvent so the webview's model button stays honest.
 *
 * The actual engine switching lives in the EngineAdapter seam
 * (EngineAdapter.setModel / listModels / getDefaultModel — implemented by
 * IdeCodeEngineAdapter against the real /api/model + /api/session/:id/model
 * endpoints). This service only owns selection state; it never talks to the
 * engine itself.
 */
export interface ModelSelection {
  /** Explicit model reference; absent = "auto" (engine default). */
  ref?: ModelRef;
  /** Human label shown in the composer model button. */
  label: string;
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

export const DEFAULT_MODEL_LABEL = "auto";

export class ModelService {
  private selection: ModelSelection;
  private readonly listeners = new Set<(selection: ModelSelection) => void>();

  constructor(private readonly store: ModelSelectionStore = new InMemoryModelStore()) {
    const restored = store.load();
    this.selection =
      restored && typeof restored.label === "string" && restored.label.length > 0
        ? restored
        : { label: DEFAULT_MODEL_LABEL };
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
 * Wraps around; "auto" (no ref) or a now-disabled selection restarts from the
 * first enabled model. Returns undefined when no enabled model exists.
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
