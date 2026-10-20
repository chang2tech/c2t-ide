/**
 * workspaces.ts — named workspace directories for the agent CLI.
 *
 * A "workspace" is a named set of project directories, e.g. what Cursor's
 * `/add-dir` adds to. Stored at ~/.ide-code/workspaces.json:
 *
 *   { "active": "default",
 *     "workspaces": { "default": { "dirs": ["/home/u/proj"], "updatedAt": 123 } } }
 *
 * The store only tracks directory lists; `/load-workspace` also chdir()s the
 * CLI process into the first directory so relative paths and newly recorded
 * session cwds follow the workspace.
 */

import * as fs from "fs";
import * as path from "path";
import { configDir, readJsonFile, writeJsonFile } from "./store";

export interface StoredWorkspace {
  dirs: string[];
  updatedAt: number;
}

interface WorkspacesFile {
  active: string;
  workspaces: Record<string, StoredWorkspace>;
}

const FILE_NAME = "workspaces.json";
const DEFAULT_NAME = "default";

function filePath(): string {
  return path.join(configDir(), FILE_NAME);
}

export function loadWorkspacesFile(): WorkspacesFile {
  const file = readJsonFile<Partial<WorkspacesFile>>(filePath(), {});
  const workspaces: Record<string, StoredWorkspace> = {};
  if (file.workspaces && typeof file.workspaces === "object") {
    for (const [name, w] of Object.entries(file.workspaces)) {
      if (w && Array.isArray(w.dirs)) {
        workspaces[name] = {
          dirs: w.dirs.filter((d): d is string => typeof d === "string"),
          updatedAt: typeof w.updatedAt === "number" ? w.updatedAt : 0,
        };
      }
    }
  }
  if (!workspaces[DEFAULT_NAME]) {
    workspaces[DEFAULT_NAME] = { dirs: [], updatedAt: Date.now() };
  }
  const active =
    typeof file.active === "string" && workspaces[file.active]
      ? file.active
      : DEFAULT_NAME;
  return { active, workspaces };
}

function saveWorkspacesFile(f: WorkspacesFile): void {
  writeJsonFile(filePath(), f);
}

export function validateWorkspaceName(name: string): string | undefined {
  if (!name || name.length === 0) {
    return "workspace name must not be empty";
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(name)) {
    return `invalid workspace name ${JSON.stringify(name)} (letters, digits, . _ -; max 64 chars)`;
  }
  return undefined;
}

/** Absolute, normalized directory list of the active (or named) workspace. */
export function workspaceDirs(name?: string): string[] {
  const f = loadWorkspacesFile();
  const ws = f.workspaces[name ?? f.active];
  return ws ? [...ws.dirs] : [];
}

export function activeWorkspaceName(): string {
  return loadWorkspacesFile().active;
}

export function listWorkspaceNames(): string[] {
  const f = loadWorkspacesFile();
  return Object.keys(f.workspaces).sort((a, b) => a.localeCompare(b));
}

/**
 * Add an existing directory to the active workspace. Returns undefined on
 * success, or an error message.
 */
export function addDirToWorkspace(dir: string, name?: string): string | undefined {
  const resolved = path.resolve(dir);
  let stat: fs.Stats;
  try {
    stat = fs.statSync(resolved);
  } catch {
    return `directory not found: ${dir}`;
  }
  if (!stat.isDirectory()) {
    return `not a directory: ${dir}`;
  }
  const f = loadWorkspacesFile();
  const target = name ?? f.active;
  const ws = f.workspaces[target];
  if (!ws) {
    return `unknown workspace ${JSON.stringify(target)}`;
  }
  if (!ws.dirs.includes(resolved)) {
    ws.dirs.push(resolved);
    ws.updatedAt = Date.now();
    saveWorkspacesFile(f);
  }
  return undefined;
}

/**
 * Snapshot the active workspace's directory list under `name`
 * (creating it when needed). Returns an error message, or undefined.
 */
export function saveWorkspaceAs(name: string): string | undefined {
  const bad = validateWorkspaceName(name);
  if (bad) {
    return bad;
  }
  const f = loadWorkspacesFile();
  const active = f.workspaces[f.active];
  f.workspaces[name] = { dirs: [...active.dirs], updatedAt: Date.now() };
  saveWorkspacesFile(f);
  return undefined;
}

/**
 * Make `name` the active workspace and chdir() into its first directory.
 * Returns { dirs } on success, or { error }.
 */
export function loadWorkspace(
  name: string,
): { dirs: string[]; chdirTo?: string } | { error: string } {
  const f = loadWorkspacesFile();
  const ws = f.workspaces[name];
  if (!ws) {
    const known = listWorkspaceNames().join(", ");
    return { error: `unknown workspace ${JSON.stringify(name)} (known: ${known || "none"})` };
  }
  f.active = name;
  saveWorkspacesFile(f);
  const dirs = [...ws.dirs];
  let chdirTo: string | undefined;
  if (dirs.length > 0) {
    try {
      process.chdir(dirs[0]);
      chdirTo = dirs[0];
    } catch {
      // The directory may have been deleted since it was saved; the
      // workspace still activates, we just can't chdir into it.
      chdirTo = undefined;
    }
  }
  return { dirs, chdirTo };
}

/** Remove a directory from the active workspace. Returns an error or undefined. */
export function removeDirFromWorkspace(dir: string): string | undefined {
  const resolved = path.resolve(dir);
  const f = loadWorkspacesFile();
  const ws = f.workspaces[f.active];
  const idx = ws.dirs.indexOf(resolved);
  if (idx < 0) {
    return `${resolved} is not in workspace ${JSON.stringify(f.active)}`;
  }
  ws.dirs.splice(idx, 1);
  ws.updatedAt = Date.now();
  saveWorkspacesFile(f);
  return undefined;
}
