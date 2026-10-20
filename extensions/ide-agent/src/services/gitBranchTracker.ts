import { gitExecFile } from "./gitExec";

/**
 * Tracked git-repo branch-change reminders (agent-git-branch-reminder).
 *
 * BINARY-VERIFIED behavior — extensions/cursor-agent-exec/dist/main.js
 * (Cursor 3.25.6), function `zre` + its call site (verbatim, REA doc
 * docs/rea/deepdig-runtime-agent-loop-2026-10-19.md §2 step 10):
 *
 * ```js
 * const $ = Gre(r.gitRepos);                                    // current {repoPath, branchName}[]
 * if (!0 === n.featureFlags?.enableTrackedGitRepoState) {
 *   const e = zre(this.trackedGitRepoBranches, r.gitRepos,
 *                 !0 === n.featureFlags.enhancedBranchChangeReminder);
 *   if (e) { R.push({ type: "text", text: R.length > 0 ? `\n\n${e}` : e }) }
 * }
 * this.trackedGitRepoBranches = $;
 * ```
 *
 * i.e. at PRE-TURN turn-build time, the previously tracked branches are
 * diffed against the current git repos; on change a `<system_reminder>`
 * text block is injected into the turn's USER CONTENT (the agent's context
 * — never the visible transcript). The reminder strings below are VERBATIM
 * from the binary:
 *
 * basic (enhancedBranchChangeReminder off):
 *   "<system_reminder>\nThe active branch changed since the last turn:\n
 *    {repoPath} changed from {from} to {to}.\n
 *    Assume these branch changes were intentional and use the new branch
 *    state as the current working context.\n</system_reminder>"
 *
 * enhanced (on):
 *   "<system_reminder>\nThe active git branch changed since the last turn:\n
 *    {repoPath}: changed from \"{from}\" to \"{to}\".
 *    [ The previous branch is an ancestor of the current HEAD.]
 *    \n{Prior edits should be present on the current branch.
 *     |Use the current branch as the working context.}\n</system_reminder>"
 *
 * HONEST-DIVERGENCES (mechanism equivalents, same layer):
 * - Cursor's `featureFlags.*` are daemon-side server-driven flags; ours are
 *   `ide.agent.enableTrackedGitRepoState` / `ide.agent.enhancedBranchChangeReminder`
 *   settings (both default true — the defaults are our choice; Cursor's
 *   rollout state for these flags was not observable).
 * - Cursor reads branches from its gitRepos service; we resolve each
 *   workspace folder via `git rev-parse --show-toplevel` /
 *   `--abbrev-ref HEAD`, and compute `previousBranchIsAncestor` via
 *   `git merge-base --is-ancestor` (best-effort; false on any error).
 * - Cursor appends the reminder as a separate user-content text block; we
 *   append it to the engine-bound prompt (enginePrompt), never to the
 *   displayed human bubble — same layer as Cursor's injection.
 */

/** One tracked repo: Cursor's `Gre(r.gitRepos)` yields {repoPath, branchName}. */
export interface TrackedRepoBranch {
  repoPath: string;
  branchName: string;
}

/** A detected change: Cursor's inner diff yields {repoPath, from, to}. */
export interface BranchChange {
  repoPath: string;
  from: string;
  to: string;
}

/** Feature-flag config keys (flag names verbatim from the binary). */
export const TRACKED_GIT_REPO_STATE_SECTION = "ide.agent";
export const TRACKED_GIT_REPO_STATE_KEY = "enableTrackedGitRepoState";
export const ENHANCED_BRANCH_CHANGE_REMINDER_KEY = "enhancedBranchChangeReminder";

/** Timeout for the per-turn git probes (must never stall turn start). */
export const GIT_BRANCH_PROBE_TIMEOUT_MS = 10_000;

/** Run git with an argument array (never a shell string — no injection). */
export type GitRunner = (cwd: string, args: string[]) => Promise<string>;

export const defaultGitRunner: GitRunner = async (cwd, args) => {
  // DEV-GAPS-14 `ext-git-sanitize`: URL credentials stripped, safe `-c`
  // configs forced before the subcommand.
  const { stdout } = await gitExecFile(cwd, args, {
    timeoutMs: GIT_BRANCH_PROBE_TIMEOUT_MS,
    maxBuffer: 1024 * 1024,
  });
  return stdout;
};

/**
 * Cursor's inner diff (verbatim logic): for each CURRENT repo, if the
 * previous snapshot has the same repoPath with a different branchName,
 * record {repoPath, from, to}. New repos / removed repos / unchanged
 * branches produce no entry. Empty previous snapshot → no changes (so the
 * first turn never reminds).
 */
export function diffTrackedBranches(
  prev: TrackedRepoBranch[],
  current: TrackedRepoBranch[],
): BranchChange[] {
  if (prev.length === 0 || current.length === 0) {
    return [];
  }
  const prevByPath = new Map(prev.map((e) => [e.repoPath, e.branchName]));
  const changes: BranchChange[] = [];
  for (const e of current) {
    const from = prevByPath.get(e.repoPath);
    if (from !== undefined && from !== e.branchName) {
      changes.push({ repoPath: e.repoPath, from, to: e.branchName });
    }
  }
  return changes;
}

/**
 * Build the `<system_reminder>` block (verbatim strings from the binary).
 * `previousBranchIsAncestor[repoPath]` mirrors the gitRepos entries'
 * `previousBranchIsAncestor` used by the enhanced variant; when true the
 * reminder asserts prior edits should be present on the current branch.
 */
export function buildBranchChangeReminder(
  changes: BranchChange[],
  enhanced: boolean,
  previousBranchIsAncestor: (change: BranchChange) => boolean = () => false,
): string {
  if (changes.length === 0) {
    return "";
  }
  if (!enhanced) {
    const lines = changes.map(
      (e) => `${e.repoPath} changed from ${e.from} to ${e.to}.`,
    );
    return (
      `<system_reminder>\nThe active branch changed since the last turn:\n` +
      `${lines.join("\n")}\n` +
      `Assume these branch changes were intentional and use the new branch state as the current working context.\n` +
      `</system_reminder>`
    );
  }
  let anyAncestor = false;
  const lines = changes.map((e) => {
    let line = `${e.repoPath}: changed from "${e.from}" to "${e.to}".`;
    if (previousBranchIsAncestor(e)) {
      line += " The previous branch is an ancestor of the current HEAD.";
      anyAncestor = true;
    }
    return line;
  });
  const closing = anyAncestor
    ? "Prior edits should be present on the current branch."
    : "Use the current branch as the working context.";
  return (
    `<system_reminder>\nThe active git branch changed since the last turn:\n` +
    `${lines.join("\n")}\n` +
    `${closing}\n` +
    `</system_reminder>`
  );
}

/**
 * Read the current {repoPath, branchName} for each workspace folder.
 * Non-git folders are skipped. Detached HEAD yields branchName "HEAD"
 * (same as `git rev-parse --abbrev-ref HEAD`).
 */
export async function readTrackedBranches(
  workspaceFolders: string[],
  runGit: GitRunner = defaultGitRunner,
): Promise<TrackedRepoBranch[]> {
  const out: TrackedRepoBranch[] = [];
  for (const folder of workspaceFolders) {
    try {
      const toplevel = (await runGit(folder, ["rev-parse", "--show-toplevel"])).trim();
      const branch = (await runGit(folder, ["rev-parse", "--abbrev-ref", "HEAD"])).trim();
      if (toplevel && branch) {
        out.push({ repoPath: toplevel, branchName: branch });
      }
    } catch {
      // Not a git repo, or git unavailable — skip silently.
    }
  }
  return out;
}

/**
 * Best-effort `previousBranchIsAncestor` (Cursor's gitRepos entry field):
 * true iff `git merge-base --is-ancestor <from> <to>` exits 0. Any error
 * (unknown ref, no repo, timeout) → false.
 */
export async function checkPreviousBranchIsAncestor(
  repoPath: string,
  from: string,
  to: string,
  runGit: GitRunner = defaultGitRunner,
): Promise<boolean> {
  try {
    await runGit(repoPath, ["merge-base", "--is-ancestor", from, to]);
    return true;
  } catch {
    return false;
  }
}

/**
 * Per-composer tracked state — mirrors Cursor's
 * `this.trackedGitRepoBranches` (updated at every pre-turn check).
 * checkForReminder() implements one pre-turn detection step: read current
 * branches, diff against the previous snapshot, build the reminder (or ""),
 * then store the new snapshot.
 */
export class TrackedGitRepoState {
  private prev: TrackedRepoBranch[] = [];

  constructor(
    private readonly readBranches: () => Promise<TrackedRepoBranch[]> = () =>
      readTrackedBranches([]),
    private readonly isAncestor: (change: BranchChange) => Promise<boolean> = async () =>
      false,
  ) {}

  /** For tests: seed the previous snapshot. */
  seedForTest(prev: TrackedRepoBranch[]): void {
    this.prev = prev;
  }

  async checkForReminder(enhanced: boolean): Promise<string> {
    const current = await this.readBranches();
    const changes = diffTrackedBranches(this.prev, current);
    this.prev = current;
    if (changes.length === 0) {
      return "";
    }
    const ancestorFlags = await Promise.all(changes.map((c) => this.isAncestor(c)));
    const ancestorByPath = new Map(
      changes.map((c, i) => [c.repoPath, ancestorFlags[i] === true]),
    );
    return buildBranchChangeReminder(
      changes,
      enhanced,
      (c) => ancestorByPath.get(c.repoPath) === true,
    );
  }
}
