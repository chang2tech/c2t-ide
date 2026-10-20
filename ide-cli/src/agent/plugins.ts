/**
 * plugins.ts — the plugin marketplace registry behind
 * `agent plugin marketplace <add|list|update|remove>`.
 *
 * Stored at ~/.ide-code/plugins.json:
 *   { "marketplaces": [ { name, url, ref?, path, addedAt } ] }
 *
 * `add` performs a REAL `git clone` (spawned, never faked in production);
 * `update` runs `git pull --ff-only` (or fetch+checkout when a --git-ref is
 * pinned); `remove` unregisters and deletes the clone directory. The git
 * spawn function is injectable so tests never touch the network.
 */

import * as childProcess from "child_process";
import * as fs from "fs";
import * as path from "path";
import { configDir, readJsonFile, writeJsonFile } from "./store";

export interface PluginMarketplace {
  /** Derived from the git URL (last path segment, minus .git). */
  name: string;
  url: string;
  ref?: string;
  /** Local clone directory. */
  path: string;
  addedAt: number;
}

interface RegistryFile {
  marketplaces: PluginMarketplace[];
}

const FILE_NAME = "plugins.json";
const CLONES_DIR = "plugins";

function registryPath(): string {
  return path.join(configDir(), FILE_NAME);
}

export function pluginsDir(): string {
  return path.join(configDir(), CLONES_DIR);
}

export function loadPluginRegistry(): RegistryFile {
  const file = readJsonFile<Partial<RegistryFile>>(registryPath(), {});
  const marketplaces = Array.isArray(file.marketplaces) ? file.marketplaces : [];
  return {
    marketplaces: marketplaces.filter(
      (m): m is PluginMarketplace =>
        !!m && typeof m.name === "string" && typeof m.url === "string" && typeof m.path === "string",
    ),
  };
}

function savePluginRegistry(reg: RegistryFile): void {
  writeJsonFile(registryPath(), reg);
}

/** "https://github.com/org/repo.git" -> "repo"; "git@github.com:org/repo" -> "repo". */
export function marketplaceNameFromUrl(url: string): string {
  const noQuery = url.split("?")[0].split("#")[0];
  const trimmed = noQuery.endsWith("/") ? noQuery.slice(0, -1) : noQuery;
  const last = trimmed.split("/").pop() ?? trimmed;
  const afterColon = last.includes(":") && !last.includes("/") ? last.split(":").pop()! : last;
  const name = afterColon.replace(/\.git$/, "");
  return name.length > 0 ? name : "marketplace";
}

export type GitSpawn = (
  cmd: string,
  args: string[],
  opts: childProcess.SpawnOptions,
) => childProcess.ChildProcess;

export interface GitResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Run git and collect output. Rejects only when the process itself fails to spawn. */
export function runGit(
  spawnFn: GitSpawn,
  args: string[],
  cwd?: string,
): Promise<GitResult> {
  return new Promise<GitResult>((resolve, reject) => {
    const child = spawnFn("git", args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (c: Buffer) => {
      stdout += c.toString();
    });
    child.stderr?.on("data", (c: Buffer) => {
      stderr += c.toString();
    });
    child.on("error", (err) => reject(err));
    child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });
}

export interface PluginOpDeps {
  spawn?: GitSpawn;
}

/**
 * Clone the marketplace repo and register it. Throws with the git stderr
 * when the clone fails.
 */
export async function pluginAdd(
  url: string,
  ref: string | undefined,
  deps: PluginOpDeps = {},
): Promise<PluginMarketplace> {
  const spawnFn = deps.spawn ?? childProcess.spawn;
  const name = marketplaceNameFromUrl(url);
  const reg = loadPluginRegistry();
  if (reg.marketplaces.some((m) => m.name === name || m.url === url)) {
    throw new Error(`marketplace ${JSON.stringify(name)} is already registered`);
  }
  const dest = path.join(pluginsDir(), name);
  if (fs.existsSync(dest)) {
    throw new Error(
      `directory ${dest} already exists (not registered) — remove it or pick another URL first`,
    );
  }
  fs.mkdirSync(pluginsDir(), { recursive: true });
  const args = ["clone", "--depth", "1"];
  if (ref) {
    args.push("--branch", ref);
  }
  args.push(url, dest);
  const res = await runGit(spawnFn, args);
  if (res.code !== 0) {
    // Don't leave a half-cloned directory behind.
    fs.rmSync(dest, { recursive: true, force: true });
    const detail = res.stderr.trim().split("\n").slice(-3).join(" ");
    throw new Error(`git clone failed: ${detail || `exit code ${res.code}`}`);
  }
  const entry: PluginMarketplace = {
    name,
    url,
    ...(ref ? { ref } : {}),
    path: dest,
    addedAt: Date.now(),
  };
  reg.marketplaces.push(entry);
  savePluginRegistry(reg);
  return entry;
}

export function pluginRemove(nameOrUrl: string): PluginMarketplace {
  const reg = loadPluginRegistry();
  const idx = reg.marketplaces.findIndex(
    (m) => m.name === nameOrUrl || m.url === nameOrUrl,
  );
  if (idx < 0) {
    throw new Error(`no marketplace registered as ${JSON.stringify(nameOrUrl)}`);
  }
  const [entry] = reg.marketplaces.splice(idx, 1);
  savePluginRegistry(reg);
  // Best effort: the registry is the source of truth; a failed rmdir
  // must not resurrect the entry.
  try {
    fs.rmSync(entry.path, { recursive: true, force: true });
  } catch {
    /* keep going */
  }
  return entry;
}

/**
 * Pull latest for one marketplace (or all when `name` is undefined).
 * Returns per-marketplace results; a failing pull does not stop the rest.
 */
export async function pluginUpdate(
  name: string | undefined,
  deps: PluginOpDeps = {},
): Promise<Array<{ name: string; ok: boolean; detail: string }>> {
  const spawnFn = deps.spawn ?? childProcess.spawn;
  const reg = loadPluginRegistry();
  const targets = name
    ? reg.marketplaces.filter((m) => m.name === name || m.url === name)
    : reg.marketplaces;
  if (name && targets.length === 0) {
    throw new Error(`no marketplace registered as ${JSON.stringify(name)}`);
  }
  const results: Array<{ name: string; ok: boolean; detail: string }> = [];
  for (const m of targets) {
    try {
      if (!fs.existsSync(path.join(m.path, ".git"))) {
        // The clone dir is gone (or was never a git clone): re-clone it.
        fs.rmSync(m.path, { recursive: true, force: true });
        const args = ["clone", "--depth", "1"];
        if (m.ref) {
          args.push("--branch", m.ref);
        }
        args.push(m.url, m.path);
        const res = await runGit(spawnFn, args);
        if (res.code !== 0) {
          throw new Error(res.stderr.trim().split("\n").slice(-2).join(" ") || `exit ${res.code}`);
        }
        results.push({ name: m.name, ok: true, detail: "re-cloned" });
        continue;
      }
      if (m.ref) {
        const fetch = await runGit(spawnFn, ["fetch", "origin", m.ref], m.path);
        if (fetch.code !== 0) {
          throw new Error(fetch.stderr.trim().split("\n").slice(-2).join(" ") || `exit ${fetch.code}`);
        }
        const checkout = await runGit(spawnFn, ["checkout", m.ref], m.path);
        if (checkout.code !== 0) {
          throw new Error(checkout.stderr.trim().split("\n").slice(-2).join(" ") || `exit ${checkout.code}`);
        }
        results.push({ name: m.name, ok: true, detail: `updated to ${m.ref}` });
      } else {
        const pull = await runGit(spawnFn, ["pull", "--ff-only"], m.path);
        if (pull.code !== 0) {
          throw new Error(pull.stderr.trim().split("\n").slice(-2).join(" ") || `exit ${pull.code}`);
        }
        results.push({ name: m.name, ok: true, detail: "up to date" });
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      results.push({ name: m.name, ok: false, detail: msg });
    }
  }
  return results;
}
