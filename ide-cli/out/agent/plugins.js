"use strict";
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
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.pluginsDir = pluginsDir;
exports.loadPluginRegistry = loadPluginRegistry;
exports.marketplaceNameFromUrl = marketplaceNameFromUrl;
exports.runGit = runGit;
exports.pluginAdd = pluginAdd;
exports.pluginRemove = pluginRemove;
exports.pluginUpdate = pluginUpdate;
const childProcess = __importStar(require("child_process"));
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const store_1 = require("./store");
const FILE_NAME = "plugins.json";
const CLONES_DIR = "plugins";
function registryPath() {
    return path.join((0, store_1.configDir)(), FILE_NAME);
}
function pluginsDir() {
    return path.join((0, store_1.configDir)(), CLONES_DIR);
}
function loadPluginRegistry() {
    const file = (0, store_1.readJsonFile)(registryPath(), {});
    const marketplaces = Array.isArray(file.marketplaces) ? file.marketplaces : [];
    return {
        marketplaces: marketplaces.filter((m) => !!m && typeof m.name === "string" && typeof m.url === "string" && typeof m.path === "string"),
    };
}
function savePluginRegistry(reg) {
    (0, store_1.writeJsonFile)(registryPath(), reg);
}
/** "https://github.com/org/repo.git" -> "repo"; "git@github.com:org/repo" -> "repo". */
function marketplaceNameFromUrl(url) {
    const noQuery = url.split("?")[0].split("#")[0];
    const trimmed = noQuery.endsWith("/") ? noQuery.slice(0, -1) : noQuery;
    const last = trimmed.split("/").pop() ?? trimmed;
    const afterColon = last.includes(":") && !last.includes("/") ? last.split(":").pop() : last;
    const name = afterColon.replace(/\.git$/, "");
    return name.length > 0 ? name : "marketplace";
}
/** Run git and collect output. Rejects only when the process itself fails to spawn. */
function runGit(spawnFn, args, cwd) {
    return new Promise((resolve, reject) => {
        const child = spawnFn("git", args, {
            cwd,
            stdio: ["ignore", "pipe", "pipe"],
            env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
        });
        let stdout = "";
        let stderr = "";
        child.stdout?.on("data", (c) => {
            stdout += c.toString();
        });
        child.stderr?.on("data", (c) => {
            stderr += c.toString();
        });
        child.on("error", (err) => reject(err));
        child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
    });
}
/**
 * Clone the marketplace repo and register it. Throws with the git stderr
 * when the clone fails.
 */
async function pluginAdd(url, ref, deps = {}) {
    const spawnFn = deps.spawn ?? childProcess.spawn;
    const name = marketplaceNameFromUrl(url);
    const reg = loadPluginRegistry();
    if (reg.marketplaces.some((m) => m.name === name || m.url === url)) {
        throw new Error(`marketplace ${JSON.stringify(name)} is already registered`);
    }
    const dest = path.join(pluginsDir(), name);
    if (fs.existsSync(dest)) {
        throw new Error(`directory ${dest} already exists (not registered) — remove it or pick another URL first`);
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
    const entry = {
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
function pluginRemove(nameOrUrl) {
    const reg = loadPluginRegistry();
    const idx = reg.marketplaces.findIndex((m) => m.name === nameOrUrl || m.url === nameOrUrl);
    if (idx < 0) {
        throw new Error(`no marketplace registered as ${JSON.stringify(nameOrUrl)}`);
    }
    const [entry] = reg.marketplaces.splice(idx, 1);
    savePluginRegistry(reg);
    // Best effort: the registry is the source of truth; a failed rmdir
    // must not resurrect the entry.
    try {
        fs.rmSync(entry.path, { recursive: true, force: true });
    }
    catch {
        /* keep going */
    }
    return entry;
}
/**
 * Pull latest for one marketplace (or all when `name` is undefined).
 * Returns per-marketplace results; a failing pull does not stop the rest.
 */
async function pluginUpdate(name, deps = {}) {
    const spawnFn = deps.spawn ?? childProcess.spawn;
    const reg = loadPluginRegistry();
    const targets = name
        ? reg.marketplaces.filter((m) => m.name === name || m.url === name)
        : reg.marketplaces;
    if (name && targets.length === 0) {
        throw new Error(`no marketplace registered as ${JSON.stringify(name)}`);
    }
    const results = [];
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
            }
            else {
                const pull = await runGit(spawnFn, ["pull", "--ff-only"], m.path);
                if (pull.code !== 0) {
                    throw new Error(pull.stderr.trim().split("\n").slice(-2).join(" ") || `exit ${pull.code}`);
                }
                results.push({ name: m.name, ok: true, detail: "up to date" });
            }
        }
        catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            results.push({ name: m.name, ok: false, detail: msg });
        }
    }
    return results;
}
