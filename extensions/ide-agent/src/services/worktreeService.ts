import * as path from "node:path";
import * as os from "node:os";
import * as fs from "node:fs";
import * as vscode from "vscode";
import { gitExecFile, GIT_TIMEOUT_MS, GIT_MAX_BUFFER } from "./gitExec";
import { runWorktreeSetup } from "./worktreeSetup";

/**
 * Metadata for one git worktree, parsed from `git worktree list --porcelain`.
 */
export interface Worktree {
  path: string;
  head: string;
  branch: string | undefined;
  bare: boolean;
  detached: boolean;
  locked: boolean;
  prunable: boolean;
  isMain: boolean;
}

// ---------------------------------------------------------------------------
// Worktree location convention.
//
// Evidence (Cursor, audited 2026-10-19 QA-3 `multitask-worktree-location`):
// - cursor-agent-host (verbatim): "This applies especially to Cursor-managed
//   worktrees in ~/.cursor/worktrees." → Cursor keeps its agent worktrees
//   HOME-RELATIVE under ~/.cursor/worktrees.
// - Cursor 3.25.9 binary, `worktrees.ts`: `fLo = ".cursor/worktrees"`.
//
// We mirror that: our managed worktrees live HOME-RELATIVE under
// `~/.ide-code/worktrees/<repo-name>/<slug>` (`.ide-code` is our brand's
// equivalent of Cursor's `.cursor` home directory).
//
// Migration (2026-10-19): the previous default was a sibling
// `<repo>-worktrees/<slug>` directory. Legacy worktrees there are handled
// GRACEFULLY — never auto-moved, never auto-deleted, never a crash:
// `resolveWorktreePath()` detects an existing legacy directory for the same
// branch, logs a deprecation warning, and keeps using it. New worktrees
// always go to the home-relative location.
// ---------------------------------------------------------------------------

/** Our brand home directory, mirroring Cursor's `~/.cursor`. */
export const IDE_CODE_HOME_DIR = ".ide-code";

/**
 * Root for all managed worktrees: `~/.ide-code/worktrees`.
 *
 * Test/dev override: when `IDE_CODE_WORKTREES_ROOT` is set (absolute path),
 * it is used instead. Documented so unit tests never touch the real home.
 */
export function managedWorktreesRoot(): string {
  const override = process.env["IDE_CODE_WORKTREES_ROOT"];
  if (override && path.isAbsolute(override)) return override;
  return path.join(os.homedir(), IDE_CODE_HOME_DIR, "worktrees");
}

// ---------------------------------------------------------------------------
// worktree-max-count (Cursor parity: `cursor.worktreeMaxCount`, default 25).
//
// Binary evidence (REA 2026-10-19): `workbench.desktop.main.js` settings-tab
// entry "Max Worktrees" — "Maximum number of Cursor-managed worktrees to
// retain across all workspaces. Older worktrees are removed first."
// (detail-settings-2026-10-19.md:182; deep-docs-all.md:124: default 25 per
// machine). The sibling settings `cursor.worktreeCleanupIntervalHours`
// (default 6) and `cursor.worktreesGlobalMaxSizeGb` (default 50, 0 disabled)
// are implemented in this file too (DEV-GAPS-41), sharing one oldest-first
// eviction engine with this cap.
//
// Mirrored as setting `ide.worktreeMaxCount` (default 25, machine scope).
// Enforced machine-wide over the managed root: after each `create()`, the
// OLDEST managed worktrees beyond the cap are removed first. Worktrees that
// are git-locked, have uncommitted changes (dirty), or are prunable are
// DEFERRED — skipped, never force-removed — mirroring Cursor's
// "protected-worktree deferral". The worktree just created is never a
// candidate.
// ---------------------------------------------------------------------------

/** Setting key mirroring Cursor's `cursor.worktreeMaxCount`. */
export const WORKTREE_MAX_COUNT_SETTING = "worktreeMaxCount";

/** Default mirroring Cursor: 25 managed worktrees per machine. */
export const DEFAULT_WORKTREE_MAX_COUNT = 25;

/**
 * Read `ide.worktreeMaxCount` (machine scope). Values < 1 or non-numeric
 * fall back to the Cursor default (25).
 */
export function getWorktreeMaxCount(): number {
  let raw: unknown;
  try {
    raw = vscode.workspace.getConfiguration("ide").get<number>(WORKTREE_MAX_COUNT_SETTING, DEFAULT_WORKTREE_MAX_COUNT);
  } catch {
    raw = DEFAULT_WORKTREE_MAX_COUNT;
  }
  const n = typeof raw === "number" ? Math.floor(raw) : NaN;
  return Number.isFinite(n) && n >= 1 ? n : DEFAULT_WORKTREE_MAX_COUNT;
}

// ---------------------------------------------------------------------------
// worktree-cleanup-interval + worktrees-global-max-size (Cursor parity,
// DEV-GAPS-41, siblings of `cursor.worktreeMaxCount` from the REA harvest
// `harvest-cursor-worktree-textmate-2026-10-19.md`):
//
// - `cursor.worktreeCleanupIntervalHours` (default 6) — how often the
//   lease-coordinated periodic cleanup pass runs. The pass enforces
//   `ide.worktreeMaxCount` AND the global size limit below.
// - `cursor.worktreesGlobalMaxSizeGb` (default 50, 0 = disabled) — when the
//   total size of all managed worktrees exceeds the limit, the oldest
//   worktrees are removed first until the total is back under it, combined
//   with the max-count logic (oldest-first, protected-worktree deferral).
//
// Mirrored as `ide.worktreeCleanupIntervalHours` (default 6, machine scope)
// and `ide.worktreesGlobalMaxSizeGb` (default 50, 0 = disabled, machine
// scope).
// ---------------------------------------------------------------------------

/** Setting key mirroring Cursor's `cursor.worktreeCleanupIntervalHours`. */
export const WORKTREE_CLEANUP_INTERVAL_HOURS_SETTING = "worktreeCleanupIntervalHours";

/** Default mirroring Cursor: run the cleanup pass every 6 hours. */
export const DEFAULT_WORKTREE_CLEANUP_INTERVAL_HOURS = 6;

/**
 * Read `ide.worktreeCleanupIntervalHours` (machine scope). Values < 1 or
 * non-numeric fall back to the Cursor default (6 hours).
 */
export function getWorktreeCleanupIntervalHours(): number {
  let raw: unknown;
  try {
    raw = vscode.workspace.getConfiguration("ide").get<number>(WORKTREE_CLEANUP_INTERVAL_HOURS_SETTING, DEFAULT_WORKTREE_CLEANUP_INTERVAL_HOURS);
  } catch {
    raw = DEFAULT_WORKTREE_CLEANUP_INTERVAL_HOURS;
  }
  const n = typeof raw === "number" ? Math.floor(raw) : NaN;
  return Number.isFinite(n) && n >= 1 ? n : DEFAULT_WORKTREE_CLEANUP_INTERVAL_HOURS;
}

/** Setting key mirroring Cursor's `cursor.worktreesGlobalMaxSizeGb`. */
export const WORKTREES_GLOBAL_MAX_SIZE_GB_SETTING = "worktreesGlobalMaxSizeGb";

/** Default mirroring Cursor: 50 GB total across all managed worktrees. */
export const DEFAULT_WORKTREES_GLOBAL_MAX_SIZE_GB = 50;

/**
 * Read `ide.worktreesGlobalMaxSizeGb` (machine scope). `0` means the limit
 * is DISABLED (mirrors Cursor). Negative or non-numeric values fall back to
 * the Cursor default (50 GB). Fractional values are allowed.
 */
export function getWorktreesGlobalMaxSizeGb(): number {
  let raw: unknown;
  try {
    raw = vscode.workspace.getConfiguration("ide").get<number>(WORKTREES_GLOBAL_MAX_SIZE_GB_SETTING, DEFAULT_WORKTREES_GLOBAL_MAX_SIZE_GB);
  } catch {
    raw = DEFAULT_WORKTREES_GLOBAL_MAX_SIZE_GB;
  }
  const n = typeof raw === "number" ? raw : NaN;
  if (!Number.isFinite(n) || n < 0) return DEFAULT_WORKTREES_GLOBAL_MAX_SIZE_GB;
  return n;
}

/**
 * Recursive size of `dir` in bytes. Symlinks are never followed (a git
 * worktree's `.git` is a file pointing at the main repo, so nothing is
 * double-counted); unreadable entries are skipped. Never throws.
 */
export function directorySizeBytes(dir: string): number {
  let total = 0;
  const stack: string[] = [dir];
  while (stack.length > 0) {
    const cur = stack.pop() as string;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(cur, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const p = path.join(cur, entry.name);
      try {
        if (entry.isSymbolicLink()) continue;
        if (entry.isDirectory()) stack.push(p);
        else if (entry.isFile()) total += fs.statSync(p).size;
      } catch {
        /* unreadable entry — skip */
      }
    }
  }
  return total;
}

/** Outcome of one cleanup pass (count + size eviction combined). */
export interface WorktreeCleanupResult extends WorktreeCapEnforcement {
  /** Dirs removed by the size-based pass (also present in `removed`). */
  sizeRemoved: string[];
  /** Dirs deferred by the size-based pass (also present in `deferred`). */
  sizeDeferred: string[];
  /** Whether the global size limit was active this pass (false when 0=disabled). */
  sizeLimitEnabled: boolean;
  /** Total size of all managed worktrees in bytes after the pass (0 when disabled). */
  totalSizeBytes: number;
}

/** Outcome of one cap-enforcement pass. */
export interface WorktreeCapEnforcement {
  /** Managed worktree dirs that were removed (oldest first). */
  removed: string[];
  /** Dirs skipped: locked, dirty, prunable, unresolvable, or just-created. */
  deferred: string[];
}

/** Make a branch name safe for use as a worktree directory name. */
export function slugifyWorktreeBranch(branch: string): string {
  return branch.replace(/\//g, "-").replace(/[^a-zA-Z0-9._-]/g, "_");
}

/**
 * LEGACY default worktree location (pre-2026-10-19): sibling
 * `<repo>-worktrees/<slug>`. Kept for graceful detection of existing
 * worktrees — never returned for new repos/branches.
 */
export function legacyWorktreePath(repoRoot: string, branch: string): string {
  const repoName = path.basename(repoRoot);
  const slug = slugifyWorktreeBranch(branch);
  return path.join(path.dirname(repoRoot), `${repoName}-worktrees`, slug);
}

/** Run git with an argument array (never a shell string — no injection).
 * Routes through the centralized sanitizing wrapper (DEV-GAPS-14
 * `ext-git-sanitize`): URL credentials are stripped and the four safe `-c`
 * configs are forced before the subcommand. */
async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await gitExecFile(cwd, args, { timeoutMs: GIT_TIMEOUT_MS, maxBuffer: GIT_MAX_BUFFER });
  return stdout;
}

/**
 * WorktreeService — git worktree management backing the /worktree slash
 * command (mirrors Cursor's /worktree, /apply-worktree, /delete-worktree).
 *
 * Worktrees give each agent run an isolated checkout so parallel work never
 * clobbers the main working tree. Location follows the Cursor convention:
 * home-relative `~/.ide-code/worktrees/<repo-name>/<slug>` (Cursor uses
 * `~/.cursor/worktrees` — see evidence comment above). Legacy sibling
 * `<repo>-worktrees/` locations are detected and kept in use gracefully
 * (warning logged, never auto-migrated) via `resolveWorktreePath()`.
 */
export class WorktreeService {
  /** Repo root for the first workspace folder, or undefined. */
  async getRepoRoot(): Promise<string | undefined> {
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) return undefined;
    try {
      const top = await git(folder.uri.fsPath, ["rev-parse", "--show-toplevel"]);
      return top.trim();
    } catch {
      return undefined;
    }
  }

  /** Parse `git worktree list --porcelain`. */
  async list(repoRoot: string): Promise<Worktree[]> {
    const raw = await git(repoRoot, ["worktree", "list", "--porcelain"]);
    const out: Worktree[] = [];
    let cur: Partial<Worktree> & { path?: string } = {};
    const flush = (): void => {
      if (cur.path) {
        out.push({
          path: cur.path,
          head: cur.head ?? "",
          branch: cur.branch,
          bare: cur.bare ?? false,
          detached: cur.detached ?? false,
          locked: cur.locked ?? false,
          prunable: cur.prunable ?? false,
          isMain: out.length === 0,
        });
      }
      cur = {};
    };
    for (const line of raw.split("\n")) {
      if (line === "") {
        flush();
        continue;
      }
      const [key, ...rest] = line.split(" ");
      const value = rest.join(" ");
      switch (key) {
        case "worktree": cur.path = value; break;
        case "HEAD": cur.head = value; break;
        case "branch": cur.branch = value.replace(/^refs\/heads\//, ""); break;
        case "bare": cur.bare = true; break;
        case "detached": cur.detached = true; break;
        case "locked": cur.locked = true; break;
        case "prunable": cur.prunable = true; break;
      }
    }
    flush();
    return out;
  }

  /**
   * Default new-worktree location: home-relative
   * `~/.ide-code/worktrees/<repo-name>/<slug>` — mirrors Cursor's
   * `~/.cursor/worktrees` convention (cursor-agent-host verbatim + binary
   * `worktrees.ts` evidence, see top of file).
   */
  defaultWorktreePath(repoRoot: string, branch: string): string {
    const repoName = path.basename(repoRoot);
    const slug = slugifyWorktreeBranch(branch);
    return path.join(managedWorktreesRoot(), repoName, slug);
  }

  /**
   * Resolve where a worktree for `branch` should live, handling the legacy
   * sibling `<repo>-worktrees/<slug>` location gracefully:
   * - If a legacy worktree directory already exists for this branch, log a
   *   deprecation warning and KEEP USING IT (no auto-migration of data, no
   *   crash). The user can move/delete it manually if they want the new
   *   home-relative layout.
   * - Otherwise return the new home-relative default (`defaultWorktreePath`).
   *
   * Callers creating worktrees should use this instead of
   * `defaultWorktreePath` directly.
   */
  resolveWorktreePath(repoRoot: string, branch: string): string {
    const legacy = legacyWorktreePath(repoRoot, branch);
    if (fs.existsSync(legacy)) {
      console.warn(
        `[ide-agent] Worktree for branch "${branch}" still lives at the legacy location ${legacy}. ` +
          `Legacy sibling worktrees are deprecated — new worktrees go to ${managedWorktreesRoot()}. ` +
          `Existing legacy worktrees are NOT auto-migrated; move or delete them manually to switch.`,
      );
      return legacy;
    }
    return this.defaultWorktreePath(repoRoot, branch);
  }

  /**
   * Validate a user-supplied branch name for `git worktree add -b`.
   * Returns an error message, or undefined when valid.
   */
  validateBranchName(name: string): string | undefined {
    const trimmed = name.trim();
    if (!trimmed) return "Branch name cannot be empty.";
    if (trimmed.length > 100) return "Branch name is too long (max 100 chars).";
    // git check-ref-format rules, conservative subset.
    if (!/^[a-zA-Z0-9._/-]+$/.test(trimmed)) {
      return "Use only letters, numbers, '.', '_', '/' and '-'.";
    }
    if (trimmed.includes("..") || trimmed.startsWith("/") || trimmed.endsWith("/") || trimmed.endsWith(".lock")) {
      return "Invalid branch name.";
    }
    return undefined;
  }

  /**
   * Create a worktree at `dir`. If `branch` already exists it is checked out;
   * otherwise it is created from `baseRef` (default: current HEAD).
   *
   * Ensures the parent directory exists first: managed worktrees live at
   * `~/.ide-code/worktrees/<repo>/<slug>`, whose parents are never present
   * on first use (same for any custom absolute `dir`).
   */
  async create(repoRoot: string, dir: string, branch: string, baseRef?: string): Promise<Worktree> {
    if (!path.isAbsolute(dir)) throw new Error("Worktree path must be absolute.");
    fs.mkdirSync(path.dirname(dir), { recursive: true });
    let branchExists = false;
    try {
      await git(repoRoot, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`]);
      branchExists = true;
    } catch {
      branchExists = false;
    }
    if (branchExists) {
      await git(repoRoot, ["worktree", "add", dir, branch]);
    } else if (baseRef) {
      await git(repoRoot, ["worktree", "add", "-b", branch, dir, baseRef]);
    } else {
      await git(repoRoot, ["worktree", "add", "-b", branch, dir]);
    }
    const all = await this.list(repoRoot);
    const created = all.find((w) => w.path === path.resolve(dir));
    if (!created) throw new Error("Worktree created but not found in `git worktree list`.");
    // Cursor parity (GAPS-132 `worktrees-json-config`): after the worktree is
    // created and before the agent starts in it, Cursor runs the setup from
    // `.cursor/worktrees.json` (worktree copy first, root copy as fallback —
    // see services/worktreeSetup.ts, port of glass `eiy` @46710083). The
    // runner NEVER throws and a failed script does NOT block creation:
    // Cursor logs "Worktree setup script failed (continuing with agent
    // creation)" and proceeds — mirrored here.
    const setup = await runWorktreeSetup({
      worktreePath: created.path,
      rootWorkspacePath: repoRoot,
    }).catch((err) => {
      console.warn(`[worktree-setup] runner failed unexpectedly: ${err instanceof Error ? err.message : String(err)}`);
      return undefined;
    });
    if (setup?.scriptFailed) {
      console.warn(
        `[worktree-setup] Worktree setup script failed (continuing with agent creation): ${setup.scriptError ?? "unknown error"}`,
      );
    }
    // Cursor parity (DEV-GAPS-37B + DEV-GAPS-41): enforce the cleanup policies
    // machine-wide after every create — the max-count cap AND the global
    // size limit, oldest managed worktrees removed first. Best-effort: never
    // throws, and the worktree just created is never an eviction candidate.
    await this.runWorktreeCleanupPass(path.resolve(dir)).catch((err) => {
      console.warn(`[ide-agent] worktree cleanup pass failed: ${err instanceof Error ? err.message : String(err)}`);
    });
    return created;
  }

  /**
   * Remove a worktree. Refuses when dirty unless `force` is set; can also
   * delete the branch when `deleteBranch` is true.
   */
  async remove(repoRoot: string, worktreePath: string, opts?: { force?: boolean; deleteBranch?: boolean }): Promise<void> {
    const args = ["worktree", "remove"];
    if (opts?.force) args.push("--force");
    args.push(worktreePath);
    await git(repoRoot, args);
    const branch = (await this.resolveBranch(repoRoot, worktreePath)) ?? undefined;
    if (opts?.deleteBranch && branch) {
      await git(repoRoot, ["branch", "-D", branch]);
    }
  }

  private async resolveBranch(repoRoot: string, worktreePath: string): Promise<string | undefined> {
    // Look up the branch from the worktree list before removal.
    const all = await this.list(repoRoot);
    return all.find((w) => w.path === worktreePath)?.branch;
  }

  /**
   * List every managed worktree directory under the managed root
   * (`~/.ide-code/worktrees/<repo>/<slug>`), oldest-first ordering data
   * included. Legacy sibling `<repo>-worktrees/` dirs are NOT counted here —
   * the cap mirrors Cursor's home-relative managed root only.
   */
  private listManagedWorktreeDirs(): Array<{ dir: string; createdAt: number }> {
    const root = managedWorktreesRoot();
    const out: Array<{ dir: string; createdAt: number }> = [];
    let repoNames: string[];
    try {
      repoNames = fs.readdirSync(root);
    } catch {
      return out;
    }
    for (const repo of repoNames) {
      const repoDir = path.join(root, repo);
      let slugs: string[];
      try {
        if (!fs.statSync(repoDir).isDirectory()) continue;
        slugs = fs.readdirSync(repoDir);
      } catch {
        continue;
      }
      for (const slug of slugs) {
        const dir = path.join(repoDir, slug);
        try {
          const st = fs.statSync(dir);
          if (!st.isDirectory()) continue;
          out.push({ dir, createdAt: st.birthtimeMs > 0 ? st.birthtimeMs : st.mtimeMs });
        } catch {
          /* unreadable entry — skip */
        }
      }
    }
    return out;
  }

  /**
   * Decide whether `dir` is a safe eviction candidate. Returns "ok" only for
   * a real, clean, unlocked, non-prunable git worktree whose main repo can
   * remove it. Everything else (locked, dirty, prunable, unresolvable) is
   * DEFERRED — never force-removed, mirroring Cursor's protected-worktree
   * deferral.
   */
  private async assessEviction(dir: string): Promise<{ ok: boolean; reason?: string; mainRepo?: string }> {
    let commonDir: string;
    try {
      commonDir = (await git(dir, ["rev-parse", "--git-common-dir"])).trim();
    } catch {
      return { ok: false, reason: "not a git worktree" };
    }
    const gitDirAbs = path.isAbsolute(commonDir) ? commonDir : path.resolve(dir, commonDir);
    const mainRepo = path.basename(gitDirAbs) === ".git" ? path.dirname(gitDirAbs) : gitDirAbs;
    let entry: Worktree | undefined;
    try {
      const all = await this.list(mainRepo);
      entry = all.find((w) => path.resolve(w.path) === path.resolve(dir));
    } catch {
      return { ok: false, reason: "worktree list failed" };
    }
    if (!entry) return { ok: false, reason: "not registered as a worktree" };
    if (entry.prunable) return { ok: false, reason: "prunable" };
    if (entry.locked) return { ok: false, reason: "locked" };
    let status: string;
    try {
      status = await git(dir, ["status", "--porcelain"]);
    } catch {
      return { ok: false, reason: "status check failed" };
    }
    if (status.trim()) return { ok: false, reason: "uncommitted changes" };
    return { ok: true, mainRepo };
  }

  /**
   * Shared oldest-first eviction engine behind both cleanup policies
   * (max-count and global-max-size). `done()` is checked before each
   * candidate and must return true once enough has been evicted;
   * `onEvicted` runs after each successful removal so the caller can
   * update its own accounting. `keepDir` (the worktree just created) is
   * never a candidate. Protected worktrees (locked / dirty / prunable /
   * unresolvable) are deferred, never force-removed — mirroring Cursor's
   * protected-worktree deferral. Never throws — eviction is best-effort.
   */
  private async evictOldestWhile(
    keepDir: string | undefined,
    done: () => boolean,
    onEvicted: (dir: string) => void,
    result: WorktreeCapEnforcement,
  ): Promise<void> {
    if (done()) return;
    const keep = keepDir ? path.resolve(keepDir) : undefined;
    const dirs = this.listManagedWorktreeDirs().sort((a, b) =>
      a.createdAt === b.createdAt ? (a.dir < b.dir ? -1 : 1) : a.createdAt - b.createdAt,
    );
    for (const { dir } of dirs) {
      if (done()) break;
      if (keep && path.resolve(dir) === keep) continue;
      let verdict: { ok: boolean; reason?: string; mainRepo?: string };
      try {
        verdict = await this.assessEviction(dir);
      } catch {
        verdict = { ok: false, reason: "assessment failed" };
      }
      if (!verdict.ok) {
        result.deferred.push(dir);
        continue;
      }
      try {
        await git(verdict.mainRepo as string, ["worktree", "remove", dir]);
        result.removed.push(dir);
        onEvicted(dir);
      } catch {
        result.deferred.push(dir);
      }
    }
  }

  /**
   * Enforce `ide.worktreeMaxCount` (Cursor parity: `cursor.worktreeMaxCount`,
   * default 25 — "older worktrees are removed first"): keep at most `max`
   * managed worktrees machine-wide; remove the OLDEST beyond the cap.
   *
   * `keepDir` (the worktree just created) is never a candidate. Protected
   * worktrees (locked / dirty / prunable) are deferred, not force-removed.
   * Never throws — eviction is best-effort; failures are logged.
   */
  async enforceWorktreeMaxCount(keepDir?: string): Promise<WorktreeCapEnforcement> {
    const result: WorktreeCapEnforcement = { removed: [], deferred: [] };
    let max: number;
    try {
      max = getWorktreeMaxCount();
    } catch {
      max = DEFAULT_WORKTREE_MAX_COUNT;
    }
    let excess = this.listManagedWorktreeDirs().length - max;
    if (excess <= 0) return result;
    await this.evictOldestWhile(keepDir, () => excess <= 0, () => { excess--; }, result);
    if (excess > 0) {
      console.warn(
        `[ide-agent] worktree cap: ${excess} worktree(s) over the ` +
          `ide.worktreeMaxCount=${max} limit remain (all remaining candidates are protected: locked, dirty, or unresolvable).`,
      );
    }
    return result;
  }

  /**
   * Enforce `ide.worktreesGlobalMaxSizeGb` (Cursor parity:
   * `cursor.worktreesGlobalMaxSizeGb`, default 50, 0 = disabled): while the
   * total size of all managed worktrees exceeds the limit, remove the OLDEST
   * first until the total is back under it — combined with the max-count
   * logic (same oldest-first ordering, same protected-worktree deferral via
   * the shared engine). `keepDir` is never a candidate. Never throws.
   */
  async enforceWorktreesGlobalMaxSize(keepDir?: string): Promise<WorktreeCapEnforcement> {
    const result: WorktreeCapEnforcement = { removed: [], deferred: [] };
    let maxGb: number;
    try {
      maxGb = getWorktreesGlobalMaxSizeGb();
    } catch {
      maxGb = DEFAULT_WORKTREES_GLOBAL_MAX_SIZE_GB;
    }
    if (maxGb === 0) return result; // disabled — Cursor parity for 0
    const maxBytes = maxGb * 1024 * 1024 * 1024;
    let total = this.totalManagedWorktreesSizeBytes();
    if (total <= maxBytes) return result;
    // Per-dir sizes measured once; the running total is decremented as dirs
    // are evicted (sizes cannot change materially mid-pass).
    const sizes = new Map<string, number>();
    for (const { dir } of this.listManagedWorktreeDirs()) {
      sizes.set(path.resolve(dir), directorySizeBytes(dir));
    }
    await this.evictOldestWhile(
      keepDir,
      () => total <= maxBytes,
      (dir) => { total -= sizes.get(path.resolve(dir)) ?? 0; },
      result,
    );
    if (total > maxBytes) {
      console.warn(
        `[ide-agent] worktree size limit: managed worktrees still total ${(total / 1024 / 1024 / 1024).toFixed(2)} GiB ` +
          `over the ide.worktreesGlobalMaxSizeGb=${maxGb} limit (all remaining candidates are protected: locked, dirty, or unresolvable).`,
      );
    }
    return result;
  }

  /**
   * Total size in bytes of all managed worktree directories. Never throws —
   * returns 0 on any failure.
   */
  totalManagedWorktreesSizeBytes(): number {
    let total = 0;
    try {
      for (const { dir } of this.listManagedWorktreeDirs()) {
        total += directorySizeBytes(dir);
      }
    } catch {
      /* best effort */
    }
    return total;
  }

  /**
   * One full cleanup pass (Cursor parity, DEV-GAPS-41): enforce
   * `ide.worktreeMaxCount` first, then `ide.worktreesGlobalMaxSizeGb`.
   * This is what the periodic scheduler runs every
   * `ide.worktreeCleanupIntervalHours`, and what `create()` runs after each
   * new worktree. `keepDir` (just-created worktree) is never an eviction
   * candidate. Never throws.
   */
  async runWorktreeCleanupPass(keepDir?: string): Promise<WorktreeCleanupResult> {
    const countResult = await this.enforceWorktreeMaxCount(keepDir);
    const sizeResult = await this.enforceWorktreesGlobalMaxSize(keepDir);
    const removed = [...countResult.removed, ...sizeResult.removed.filter((d) => !countResult.removed.includes(d))];
    const deferred = [...countResult.deferred, ...sizeResult.deferred.filter((d) => !countResult.deferred.includes(d))];
    return {
      removed,
      deferred,
      sizeRemoved: sizeResult.removed,
      sizeDeferred: sizeResult.deferred,
      sizeLimitEnabled: this.isGlobalMaxSizeEnabled(),
      totalSizeBytes: this.isGlobalMaxSizeEnabled() ? this.totalManagedWorktreesSizeBytes() : 0,
    };
  }

  /** Whether the global size limit is active (false when 0 = disabled). */
  private isGlobalMaxSizeEnabled(): boolean {
    try {
      return getWorktreesGlobalMaxSizeGb() !== 0;
    } catch {
      return true;
    }
  }

  /** Clean up stale administrative metadata for deleted worktree dirs. */
  async prune(repoRoot: string): Promise<void> {
    await git(repoRoot, ["worktree", "prune"]);
  }

  /** Open the worktree folder in a new IDE window. */
  openInNewWindow(worktreePath: string): void {
    void vscode.commands.executeCommand("vscode.openFolder", vscode.Uri.file(worktreePath), true);
  }
}

// ---------------------------------------------------------------------------
// Worktree cleanup scheduler (Cursor parity: `cursor.worktreeCleanupIntervalHours`,
// default 6 — DEV-GAPS-41).
//
// Runs `runWorktreeCleanupPass()` (max-count cap + global size limit) on a
// timer every `ide.worktreeCleanupIntervalHours` hours. Implemented as a
// self-rescheduling setTimeout chain (not a fixed setInterval) so a changed
// setting takes effect on the next cycle without a config-change listener.
// Never throws — a failed pass is logged and the next cycle proceeds.
// `dispose()` stops the timer (register in extension subscriptions).
// ---------------------------------------------------------------------------

/** Minimal disposable shape so tests can register the scheduler anywhere. */
export interface WorktreeCleanupDisposal {
  dispose(): void;
}

export class WorktreeCleanupScheduler implements WorktreeCleanupDisposal {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private readonly svc: WorktreeService;

  constructor(svc?: WorktreeService) {
    this.svc = svc ?? new WorktreeService();
    this.scheduleNext();
  }

  /** Interval for one cleanup cycle, in ms. Overridable for tests. */
  protected cleanupIntervalMs(): number {
    let hours: number;
    try {
      hours = getWorktreeCleanupIntervalHours();
    } catch {
      hours = DEFAULT_WORKTREE_CLEANUP_INTERVAL_HOURS;
    }
    return hours * 60 * 60 * 1000;
  }

  /** Run one cleanup pass now (both policies). Never throws. */
  async runOnce(): Promise<WorktreeCleanupResult> {
    try {
      return await this.svc.runWorktreeCleanupPass();
    } catch (err) {
      console.warn(
        `[ide-agent] scheduled worktree cleanup failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      return {
        removed: [],
        deferred: [],
        sizeRemoved: [],
        sizeDeferred: [],
        sizeLimitEnabled: false,
        totalSizeBytes: 0,
      };
    }
  }

  private scheduleNext(): void {
    this.clearTimer();
    const ms = this.cleanupIntervalMs();
    this.timer = setTimeout(() => {
      void this.runOnce().finally(() => this.scheduleNext());
    }, ms);
    // Don't keep the extension host alive just for cleanup.
    const t = this.timer as unknown as { unref?: () => void };
    if (typeof t.unref === "function") t.unref();
  }

  private clearTimer(): void {
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
  }

  /** Stop the periodic cleanup (extension deactivation). */
  dispose(): void {
    this.clearTimer();
  }
}
