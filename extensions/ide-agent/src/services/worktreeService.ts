import * as path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import * as vscode from "vscode";

const execFileAsync = promisify(execFile);

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

const GIT_TIMEOUT_MS = 30_000;

/** Run git with an argument array (never a shell string — no injection). */
async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd, timeout: GIT_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024 });
  return stdout;
}

/**
 * WorktreeService — git worktree management backing the /worktree slash
 * command (mirrors Cursor's /worktree, /apply-worktree, /delete-worktree).
 *
 * Worktrees give each agent run an isolated checkout so parallel work never
 * clobbers the main working tree. Layout matches the Cursor convention of a
 * sibling `<repo>-worktrees/` directory.
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

  /** Default new-worktree location: sibling `<repo>-worktrees/<slug>`. */
  defaultWorktreePath(repoRoot: string, branch: string): string {
    const repoName = path.basename(repoRoot);
    const slug = branch.replace(/\//g, "-").replace(/[^a-zA-Z0-9._-]/g, "_");
    return path.join(path.dirname(repoRoot), `${repoName}-worktrees`, slug);
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
   */
  async create(repoRoot: string, dir: string, branch: string, baseRef?: string): Promise<Worktree> {
    if (!path.isAbsolute(dir)) throw new Error("Worktree path must be absolute.");
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

  /** Clean up stale administrative metadata for deleted worktree dirs. */
  async prune(repoRoot: string): Promise<void> {
    await git(repoRoot, ["worktree", "prune"]);
  }

  /** Open the worktree folder in a new IDE window. */
  openInNewWindow(worktreePath: string): void {
    void vscode.commands.executeCommand("vscode.openFolder", vscode.Uri.file(worktreePath), true);
  }
}
