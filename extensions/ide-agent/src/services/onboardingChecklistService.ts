import * as vscode from "vscode";

/**
 * OnboardingChecklistService — local-first onboarding checklist
 * (DEV-GAPS-5-ONBOARDING).
 *
 * EVIDENCE (Cursor 3.25.9, verified 2026-10-19 — see
 * `~/workspace/ide-code-mission/docs/rea/deep-proto.md` lines 411-413):
 *  - Cursor ships `aiserver.v1.OnboardingChecklistService` with 6 RPCs:
 *    `ListOnboardingChecklistItems`, `CompleteOnboardingChecklistItem`,
 *    `DismissOnboardingChecklistItem`, `ReportAgentSnapshot`, `AdmitRun`,
 *    `ReportUsage`.
 *  - VERIFIED in shipped 3.25.9: `OnboardingChecklistService` appears in
 *    extensionHostProcess.js, extensionHostWorkerMain.js and
 *    workbench.desktop.main.js.
 *  - Feature matrix `onboarding-checklist` (P3): "User-facing onboarding
 *    checklist UI with listable, completable, dismissible items, separate
 *    from the first-run onboarding flow."
 *
 * HONEST-DIVERGENCE (2026-10-19):
 *  - No document describes Cursor's checklist UI in detail and the
 *    individual items could not be reversed from the minified bundle
 *    (UNKNOWN). The default items below are OUR OWN choice — they mirror
 *    the "listable, completable, dismissible" contract, not Cursor's actual
 *    list. Do not claim parity for any specific item.
 *  - `ReportUsage` / `AdmitRun` are Cursor server RPCs; they do not exist
 *    in this local-first product and are NOT implemented (no cloud/account,
 *    nothing is sent anywhere). `reportSnapshot()` is the local
 *    `ReportAgentSnapshot`-equivalent: it returns the checklist state for
 *    internal use only.
 *
 * All state is local: globalState key `ide.onboarding.checklist.v1`.
 */

export const ONBOARDING_CHECKLIST_STATE_KEY = "ide.onboarding.checklist.v1";

export interface OnboardingChecklistItem {
  /** Stable identifier, persisted. */
  id: string;
  title: string;
  description: string;
  completed: boolean;
  dismissed: boolean;
  /** Display order (lower first). */
  order: number;
}

export interface OnboardingSnapshot {
  total: number;
  completed: number;
  dismissed: number;
  /** Items neither completed nor dismissed. */
  remaining: number;
  allDone: boolean;
  items: OnboardingChecklistItem[];
}

interface StoredChecklistState {
  version: 1;
  /** id -> completion flags, persisted. Titles/descriptions always come from defaults. */
  items: Record<string, { completed: boolean; dismissed: boolean }>;
}

interface DefaultItemDef {
  id: string;
  title: string;
  description: string;
}

/**
 * The default checklist items.
 *
 * UNKNOWN/DIVERGENCE: Cursor does NOT publish its onboarding checklist
 * items and the list could not be extracted from the 3.25.9 bundle, so
 * these are defined by us to cover the obvious first-run beats of an
 * AI IDE (model selection, engine, workspace, chat, Tab completion,
 * keybindings, project rules). Kept to 7 items — enough to be useful,
 * few enough to not nag.
 */
const DEFAULT_ITEMS: DefaultItemDef[] = [
  {
    id: "choose-ai-model",
    title: "Choose your AI model",
    description: "Pick the model powering chat and Tab in the model picker.",
  },
  {
    id: "connect-engine",
    title: "Connect the agent engine",
    description: "Make sure the IDE Code sidecar engine starts and answers.",
  },
  {
    id: "open-workspace",
    title: "Open your first workspace",
    description: "Open a folder so the agent has real code to work with.",
  },
  {
    id: "try-agent-chat",
    title: "Chat with the agent",
    description: "Ask the agent to explain or edit something in your project.",
  },
  {
    id: "try-tab-completion",
    title: "Try Tab completion",
    description: "Type a line of code and accept the inline suggestion with Tab.",
  },
  {
    id: "customize-keybindings",
    title: "Review keybindings",
    description: "Check the IDE Agent shortcuts and adjust them to your taste.",
  },
  {
    id: "explore-project-rules",
    title: "Set up project rules",
    description: "Add project rules so the agent follows your conventions.",
  },
];

export class OnboardingChecklistService implements vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<void>();
  /** Fires whenever an item is completed, dismissed, reset, or defaults change. */
  readonly onDidChange = this.emitter.event;
  private readonly disposables: vscode.Disposable[] = [];
  private flags = new Map<string, { completed: boolean; dismissed: boolean }>();

  constructor(private readonly context: vscode.ExtensionContext) {
    this.load();
  }

  dispose(): void {
    this.emitter.dispose();
    for (const d of this.disposables) d.dispose();
  }

  /** All default items with persisted completion flags applied, ordered by `order`. */
  listItems(): OnboardingChecklistItem[] {
    return DEFAULT_ITEMS.map((def, index) => {
      const f = this.flags.get(def.id) ?? { completed: false, dismissed: false };
      return {
        id: def.id,
        title: def.title,
        description: def.description,
        completed: f.completed,
        dismissed: f.dismissed,
        order: index,
      };
    });
  }

  /** Items the user still has to do: not completed and not dismissed. */
  visibleItems(): OnboardingChecklistItem[] {
    return this.listItems().filter((i) => !i.completed && !i.dismissed);
  }

  /** true once every default item is completed or dismissed. */
  get allDone(): boolean {
    return this.visibleItems().length === 0;
  }

  /**
   * Mark an item complete. Unknown ids are ignored (never fabricated).
   * Returns true when the item existed and was updated.
   */
  async completeItem(id: string): Promise<boolean> {
    if (!this.isKnownId(id)) return false;
    const f = this.getFlags(id);
    if (f.completed) return true;
    f.completed = true;
    await this.persist();
    this.emitter.fire();
    return true;
  }

  /**
   * Un-mark an item (checkbox unchecked). Unknown ids are ignored.
   */
  async uncompleteItem(id: string): Promise<boolean> {
    if (!this.isKnownId(id)) return false;
    const f = this.getFlags(id);
    if (!f.completed) return true;
    f.completed = false;
    await this.persist();
    this.emitter.fire();
    return true;
  }

  /**
   * Dismiss an item (removes it from the pending list without completing).
   * Returns true when the item existed and was updated.
   */
  async dismissItem(id: string): Promise<boolean> {
    if (!this.isKnownId(id)) return false;
    const f = this.getFlags(id);
    if (f.dismissed) return true;
    f.dismissed = true;
    await this.persist();
    this.emitter.fire();
    return true;
  }

  /** Clear all persisted flags — the full default checklist returns. */
  async resetChecklist(): Promise<void> {
    this.flags.clear();
    await this.persist();
    this.emitter.fire();
  }

  /**
   * Local `ReportAgentSnapshot`-equivalent: returns the current checklist
   * state for internal/telemetry use. Local-first: nothing is sent to any
   * server — the snapshot never leaves the machine.
   */
  reportSnapshot(): OnboardingSnapshot {
    const items = this.listItems();
    const completed = items.filter((i) => i.completed).length;
    const dismissed = items.filter((i) => i.dismissed).length;
    return {
      total: items.length,
      completed,
      dismissed,
      remaining: items.length - completed - dismissed,
      allDone: this.allDone,
      items,
    };
  }

  private isKnownId(id: string): boolean {
    return DEFAULT_ITEMS.some((d) => d.id === id);
  }

  private getFlags(id: string): { completed: boolean; dismissed: boolean } {
    let f = this.flags.get(id);
    if (!f) {
      f = { completed: false, dismissed: false };
      this.flags.set(id, f);
    }
    return f;
  }

  private load(): void {
    const stored = this.context.globalState.get<StoredChecklistState>(ONBOARDING_CHECKLIST_STATE_KEY);
    if (!stored || stored.version !== 1 || typeof stored.items !== "object" || stored.items === null) {
      return;
    }
    // Only adopt flags for ids we still ship; stale ids are dropped and
    // newly added defaults start unset (merge, not overwrite).
    for (const def of DEFAULT_ITEMS) {
      const f = stored.items[def.id];
      if (f && typeof f.completed === "boolean" && typeof f.dismissed === "boolean") {
        this.flags.set(def.id, { completed: f.completed, dismissed: f.dismissed });
      }
    }
  }

  private async persist(): Promise<void> {
    const items: StoredChecklistState["items"] = {};
    for (const [id, f] of this.flags) {
      items[id] = { completed: f.completed, dismissed: f.dismissed };
    }
    await this.context.globalState.update(ONBOARDING_CHECKLIST_STATE_KEY, {
      version: 1,
      items,
    } satisfies StoredChecklistState);
  }
}
