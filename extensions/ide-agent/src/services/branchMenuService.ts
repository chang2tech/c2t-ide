/**
 * branchMenuService — W69C (`changes-tab-base-branch-menu`): the fork port
 * of Cursor's base-branch selector behind `cursor.openBranchMenu`.
 *
 * BINARY EVIDENCE (workbench.glass.main.js, Cursor 3.25.9 — all offsets
 * re-verified by W69C 2026-10-20, not copied from the audit queue):
 *
 * Command registration @27418487 (id) / @27418510 (class JXl):
 *   ZXl = "cursor.openBranchMenu"
 *   JXl = class extends ln { constructor(){ super({
 *     id: gpy.ID, title: {value:"Open Branch Menu", original:"Open Branch Menu"},
 *     f1: !0,
 *     keybinding: { primary: dt.CtrlCmd|Xe.Quote, weight: 600,
 *                   when: ft.has("composerFocused") } }) }
 *   async run(e){ const n=e.get(no),  // composerDataService
 *                       i=e.get(ep),  // composerService @4266368
 *                       r=e.get(Xb),  // composerEventService @17600371
 *                       s=n.selectedComposerId;
 *     !s || !n.getComposerDataIfLoaded(s) || !i.isComposerConversationEmpty(s)
 *       || r.fireDidRequestOpenBranchMenu({composerId:s}) } }
 * — i.e. the menu fires ONLY for a loaded composer whose conversation is
 * still EMPTY (base branch is a pre-chat choice); every guard failure is a
 * SILENT no-op (no warning anywhere in the run body). NOTE: the audit
 * queue's run-34 entry omitted the CtrlCmd+Quote keybinding — the binary
 * registration carries it verbatim (W69C correction).
 *
 * Event service (composerEventService): `fireDidRequestOpenBranchMenu(t){
 * this._onDidRequestOpenBranchMenuEmitter.fire(t)}` @17607923, event
 * registered @17604508.
 *
 * Handler (branch-selector component `Oyv`, @27425412 region): subscribes
 * `composerEventService.onDidRequestOpenBranchMenu(({composerId}) => ...)`
 * and, when the id matches the selected composer, positions a popup under
 * the trigger element (rect left-5 / bottom+3), focuses its input after
 * 50 ms and sets `backgroundComposerDataService.setData(
 * "isBranchSelectorOpen", !0)`. The trigger label is the template
 * `Switch base branch (${ce})` @27426629, where `ce` is the current base
 * branch (its exact reactive source `Z4(ZXl)` is module-local and NOT
 * statically resolvable — UNKNOWN; this port labels it with the effective
 * base ref from `resolveEffectiveBaseRef`, the binary's own ref resolver).
 *
 * Branch-selection modes `bCe` @17425789 (backgroundComposerData.js):
 *   DEFAULT = "default", CURRENT = "current",
 *   CURRENT_WITH_CHANGES = "current-with-changes"
 * persisted as `workspacePersistentData.cachedBranchSelectionMode`
 * (defaulting to DEFAULT when unset, @24917262 / @27425412).
 *
 * Effective base ref `kVm` @17424779 (verbatim port below):
 *   cachedMode === "default" || currentBranch === "HEAD"
 *     ? defaultBranch || "main"
 *     : currentBranch || defaultBranch || "main"
 *
 * Effective mode (selector component, @27425412): the cached mode, except
 * a detached HEAD ("HEAD") forces DEFAULT, and CURRENT_WITH_CHANGES
 * degrades to CURRENT when there are no local changes and the branch is
 * synced with its upstream.
 *
 * Git data (gitContextService, called from the selector @27426629 region):
 *   getGitDiff()                       -> entries; length > 0 = local changes
 *   getCurrentBranch()
 *   executeGitCommand(cwd, ["rev-list","@{u}..HEAD","--count"])
 *                                      -> > 0 = "Not synced with remote"
 *   getDefaultBranch({withoutOrigin:true})
 *   getAllBranchNames({sortBy:"committerdate", includeRemotes:true})
 * Default-branch fallback chain (selector loader, verbatim):
 *   names includes "main" ? "main" : includes "master" ? "master"
 *     : names[0] || "main"
 * Local-changes tag template (verbatim): "(with local changes)";
 * not-synced label constant (verbatim): "Not synced with remote".
 *
 * FORK LAYERING (same layer as Cursor, adapted to the fork's split):
 * Cursor registers the command in workbench core and hosts the selector
 * in the glass composer UI. The fork mirrors that split: the core Action2
 * `cursor.openBranchMenu` lives in
 * src/vs/workbench/contrib/composer/browser/composerActions.ts and
 * delegates to this extension runtime (`ide.openBranchMenu`), which owns
 * the chat-side data (per-composer ComposerDataService) and the picker
 * surface.
 *
 * HONEST DIVERGENCES:
 * - The binary selector is a React popup anchored under a DOM trigger in
 *   the composer input; the fork's chat UI is an extension webview with no
 *   host-reachable trigger element, so the picker surface is a VS Code
 *   QuickPick (the extension-host analog). Popup positioning (left-5 /
 *   bottom+3) and the 50 ms focus timing are not portable and are dropped.
 * - `getDefaultBranch` internals are not statically recoverable; this port
 *   tries `refs/remotes/origin/HEAD` first and otherwise applies the
 *   binary's own documented fallback chain over the branch-name list.
 * - Choosing a branch in the binary picker rewrites the background
 *   composer's gitState ref; the fork stores the choice as this service's
 *   `baseBranchOverride` (consumed by the label) — no fork surface yet
 *   diffs against a per-composer base ref, so the override is state-only
 *   until a consumer lands. It is never silently dropped: it round-trips
 *   through `getBaseBranchLabel()` exactly like the binary label.
 */

import { gitExecFile } from "./gitExec";

/** Binary-verbatim branch-selection mode values (`bCe` @17425789). */
export const BranchSelectionMode = {
  DEFAULT: "default",
  CURRENT: "current",
  CURRENT_WITH_CHANGES: "current-with-changes",
} as const;
export type BranchSelectionMode =
  (typeof BranchSelectionMode)[keyof typeof BranchSelectionMode];

/** Binary-verbatim not-synced label (`DJt` in the selector component). */
export const NOT_SYNCED_WITH_REMOTE_LABEL = "Not synced with remote";
/** Binary-verbatim local-changes tag text (selector template `Nyv`). */
export const WITH_LOCAL_CHANGES_TAG = "(with local changes)";

/**
 * Verbatim port of the binary's effective-base-ref resolver `kVm`
 * @17424779:
 *   `e==="default"||n==="HEAD" ? i||"main" : n||i||"main"`
 */
export function resolveEffectiveBaseRef(input: {
  cachedMode: BranchSelectionMode;
  currentBranch?: string;
  defaultBranch?: string;
}): string {
  const { cachedMode, currentBranch, defaultBranch } = input;
  return cachedMode === BranchSelectionMode.DEFAULT || currentBranch === "HEAD"
    ? defaultBranch || "main"
    : currentBranch || defaultBranch || "main";
}

/**
 * Port of the selector's effective-mode memo (@27425412):
 *   `w() ? DEFAULT : ce===CURRENT_WITH_CHANGES && !hasLocalChanges &&
 *    !notSynced ? CURRENT : ce`
 * where `w()` is the detached-HEAD check (`currentBranch === "HEAD"`).
 */
export function computeEffectiveBranchMode(input: {
  cachedMode: BranchSelectionMode;
  currentBranch?: string;
  hasLocalChanges: boolean;
  notSynced: boolean;
}): BranchSelectionMode {
  const { cachedMode, currentBranch, hasLocalChanges, notSynced } = input;
  if (currentBranch === "HEAD") {
    return BranchSelectionMode.DEFAULT;
  }
  if (
    cachedMode === BranchSelectionMode.CURRENT_WITH_CHANGES &&
    !hasLocalChanges &&
    !notSynced
  ) {
    return BranchSelectionMode.CURRENT;
  }
  return cachedMode;
}

/**
 * The binary's default-branch fallback chain (selector loader, verbatim):
 * main, else master, else the first branch name, else "main".
 */
export function resolveDefaultBranchFromNames(
  names: readonly string[],
): string {
  return names.includes("main")
    ? "main"
    : names.includes("master")
      ? "master"
      : names[0] || "main";
}

/** Binary-verbatim trigger label template @27426629. */
export function baseBranchLabel(baseBranch: string): string {
  return `Switch base branch (${baseBranch})`;
}

/** Run git with an argument array (never a shell string — no injection). */
export type GitRunner = (cwd: string, args: string[]) => Promise<string>;

export const defaultGitRunner: GitRunner = async (cwd, args) => {
  const { stdout } = await gitExecFile(cwd, args);
  return stdout;
};

/**
 * The fork's gitContextService port for the branch selector: exactly the
 * calls the binary selector makes, over the fork's sanitized git wrapper
 * (gitExec). Every method is best-effort like the binary's (its loader
 * wraps the probes in try/catch and degrades to flags-off).
 */
export class BranchGitContext {
  constructor(private readonly runGit: GitRunner = defaultGitRunner) {}

  /** Binary: `gitContextService.getCurrentBranch()`. */
  async getCurrentBranch(cwd: string): Promise<string | undefined> {
    try {
      const out = (await this.runGit(cwd, ["rev-parse", "--abbrev-ref", "HEAD"])).trim();
      return out || undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * Binary: `gitContextService.getAllBranchNames({sortBy:"committerdate",
   * includeRemotes:true})`. Remote names are returned with the
   * `remotes/<remote>/` prefix stripped (and the `HEAD ->` symref line
   * skipped), de-duplicated in committerdate order — the shape the
   * binary's fallback chain (`includes("main")`) operates on.
   */
  async getAllBranchNames(cwd: string): Promise<string[]> {
    try {
      const out = await this.runGit(cwd, [
        "branch",
        "-a",
        "--sort=-committerdate",
        "--format=%(refname:short)",
      ]);
      const names: string[] = [];
      for (const raw of out.split("\n")) {
        let name = raw.trim().replace(/^\*\s+/, "");
        if (!name || name.includes("->")) {
          continue;
        }
        name = name.replace(/^remotes\/[^/]+\//, "").replace(/^origin\//, "");
        if (name && name !== "HEAD" && !names.includes(name)) {
          names.push(name);
        }
      }
      return names;
    } catch {
      return [];
    }
  }

  /**
   * Binary: `gitContextService.getDefaultBranch({withoutOrigin:true})`.
   * Internals UNKNOWN (see header); origin/HEAD first, else the binary's
   * own fallback chain over the branch-name list.
   */
  async getDefaultBranch(cwd: string): Promise<string> {
    try {
      const out = (
        await this.runGit(cwd, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"])
      ).trim();
      const name = out.replace(/^origin\//, "");
      if (name) {
        return name;
      }
    } catch {
      /* fall through to the binary's fallback chain */
    }
    return resolveDefaultBranchFromNames(await this.getAllBranchNames(cwd));
  }

  /**
   * Binary: `gitContextService.getGitDiff()` — the selector only reads
   * `length > 0` (has local changes). Returns one entry per changed path
   * from `git status --porcelain`.
   */
  async getGitDiff(cwd: string): Promise<string[]> {
    try {
      const out = await this.runGit(cwd, ["status", "--porcelain"]);
      return out.split("\n").filter((l) => l.trim().length > 0);
    } catch {
      return [];
    }
  }

  /**
   * Binary: `executeGitCommand(cwd, ["rev-list","@{u}..HEAD","--count"])`
   * with `parseInt(...) > 0` meaning not-synced; any failure degrades to
   * synced (the binary's catch sets the flag false).
   */
  async getNotSynced(cwd: string): Promise<boolean> {
    try {
      const out = await this.runGit(cwd, ["rev-list", "@{u}..HEAD", "--count"]);
      const count = parseInt(out.trim(), 10);
      return !Number.isNaN(count) && count > 0;
    } catch {
      return false;
    }
  }
}

/** One picker row: a branch plus the binary's status annotations. */
export interface BranchPickerItem {
  branch: string;
  isCurrent: boolean;
  isDefault: boolean;
  description?: string;
}

/** Snapshot the selector needs to render (binary loader's data set). */
export interface BranchMenuSnapshot {
  branches: string[];
  currentBranch?: string;
  defaultBranch: string;
  hasLocalChanges: boolean;
  notSynced: boolean;
  effectiveMode: BranchSelectionMode;
  effectiveBaseRef: string;
  label: string;
  items: BranchPickerItem[];
}

/** Picker seam: extension.ts binds this to `vscode.window.showQuickPick`. */
export type BranchPicker = (
  items: BranchPickerItem[],
  snapshot: BranchMenuSnapshot,
) => Promise<BranchPickerItem | undefined>;

/**
 * composerEventService + backgroundComposerDataService port for the
 * branch menu: the `onDidRequestOpenBranchMenu` event, the
 * `isBranchSelectorOpen` data flag, and the persisted
 * `cachedBranchSelectionMode`.
 */
export class BranchMenuService {
  private readonly listeners = new Set<
    (e: { composerId: string }) => void
  >();
  private open = false;
  private cachedMode: BranchSelectionMode = BranchSelectionMode.DEFAULT;
  private _baseBranchOverride: string | undefined;

  constructor(private readonly git: BranchGitContext = new BranchGitContext()) {}

  /** Binary: `composerEventService.onDidRequestOpenBranchMenu` @17604508. */
  onDidRequestOpenBranchMenu(
    listener: (e: { composerId: string }) => void,
  ): { dispose(): void } {
    this.listeners.add(listener);
    return {
      dispose: () => {
        this.listeners.delete(listener);
      },
    };
  }

  /** Binary: `composerEventService.fireDidRequestOpenBranchMenu` @17607923. */
  fireDidRequestOpenBranchMenu(e: { composerId: string }): void {
    for (const listener of [...this.listeners]) {
      listener(e);
    }
  }

  /** Binary data flag: `backgroundComposerDataService` "isBranchSelectorOpen". */
  get isBranchSelectorOpen(): boolean {
    return this.open;
  }
  setBranchSelectorOpen(open: boolean): void {
    this.open = open;
  }

  /** Binary: `workspacePersistentData.cachedBranchSelectionMode ?? DEFAULT`. */
  get cachedBranchSelectionMode(): BranchSelectionMode {
    return this.cachedMode;
  }
  setCachedBranchSelectionMode(mode: BranchSelectionMode): void {
    this.cachedMode = mode;
  }

  get baseBranchOverride(): string | undefined {
    return this._baseBranchOverride;
  }

  /** Gather the selector's data set for one workspace folder. */
  async loadSnapshot(cwd: string): Promise<BranchMenuSnapshot> {
    const [diff, currentBranch, defaultBranch, branches, notSynced] =
      await Promise.all([
        this.git.getGitDiff(cwd),
        this.git.getCurrentBranch(cwd),
        this.git.getDefaultBranch(cwd),
        this.git.getAllBranchNames(cwd),
        this.git.getNotSynced(cwd),
      ]);
    const hasLocalChanges = diff.length > 0;
    const effectiveMode = computeEffectiveBranchMode({
      cachedMode: this.cachedMode,
      currentBranch,
      hasLocalChanges,
      notSynced,
    });
    const effectiveBaseRef =
      this._baseBranchOverride ??
      resolveEffectiveBaseRef({
        cachedMode: this.cachedMode,
        currentBranch,
        defaultBranch,
      });
    const items: BranchPickerItem[] = branches.map((branch) => {
      const tags: string[] = [];
      if (branch === currentBranch && hasLocalChanges) {
        tags.push(WITH_LOCAL_CHANGES_TAG);
      }
      if (branch === currentBranch && notSynced) {
        tags.push(NOT_SYNCED_WITH_REMOTE_LABEL);
      }
      return {
        branch,
        isCurrent: branch === currentBranch,
        isDefault: branch === defaultBranch,
        description: tags.length > 0 ? tags.join(" ") : undefined,
      };
    });
    return {
      branches,
      currentBranch,
      defaultBranch,
      hasLocalChanges,
      notSynced,
      effectiveMode,
      effectiveBaseRef,
      label: baseBranchLabel(effectiveBaseRef),
      items,
    };
  }

  /**
   * The selector handler's flow (@27425412): on the open request for the
   * selected composer, set `isBranchSelectorOpen`, load the git snapshot
   * and show the picker; a choice records the base branch (and the mode
   * the binary's kVm semantics imply: the current branch -> CURRENT,
   * anything else resets the mode to DEFAULT with an explicit override),
   * and the picker closing always clears the open flag (the binary's
   * `z()` close path).
   *
   * @returns the chosen branch, or undefined when dismissed.
   */
  async handleOpenRequest(input: {
    composerId: string;
    selectedComposerId: string | undefined;
    cwd: string;
    pick: BranchPicker;
  }): Promise<string | undefined> {
    // Binary handler guard: only the SELECTED composer's request opens
    // the selector (`if (ue === ae)`).
    if (!input.selectedComposerId || input.composerId !== input.selectedComposerId) {
      return undefined;
    }
    this.setBranchSelectorOpen(true);
    try {
      const snapshot = await this.loadSnapshot(input.cwd);
      const chosen = await input.pick(snapshot.items, snapshot);
      if (!chosen) {
        return undefined;
      }
      if (chosen.branch === snapshot.currentBranch) {
        this.cachedMode = snapshot.hasLocalChanges
          ? BranchSelectionMode.CURRENT_WITH_CHANGES
          : BranchSelectionMode.CURRENT;
        this._baseBranchOverride = undefined;
      } else {
        this.cachedMode = BranchSelectionMode.DEFAULT;
        this._baseBranchOverride =
          chosen.branch === snapshot.defaultBranch ? undefined : chosen.branch;
      }
      return chosen.branch;
    } finally {
      this.setBranchSelectorOpen(false);
    }
  }
}
