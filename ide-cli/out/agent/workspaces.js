"use strict";
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
exports.loadWorkspacesFile = loadWorkspacesFile;
exports.validateWorkspaceName = validateWorkspaceName;
exports.workspaceDirs = workspaceDirs;
exports.activeWorkspaceName = activeWorkspaceName;
exports.listWorkspaceNames = listWorkspaceNames;
exports.addDirToWorkspace = addDirToWorkspace;
exports.saveWorkspaceAs = saveWorkspaceAs;
exports.loadWorkspace = loadWorkspace;
exports.removeDirFromWorkspace = removeDirFromWorkspace;
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const store_1 = require("./store");
const FILE_NAME = "workspaces.json";
const DEFAULT_NAME = "default";
function filePath() {
    return path.join((0, store_1.configDir)(), FILE_NAME);
}
function loadWorkspacesFile() {
    const file = (0, store_1.readJsonFile)(filePath(), {});
    const workspaces = {};
    if (file.workspaces && typeof file.workspaces === "object") {
        for (const [name, w] of Object.entries(file.workspaces)) {
            if (w && Array.isArray(w.dirs)) {
                workspaces[name] = {
                    dirs: w.dirs.filter((d) => typeof d === "string"),
                    updatedAt: typeof w.updatedAt === "number" ? w.updatedAt : 0,
                };
            }
        }
    }
    if (!workspaces[DEFAULT_NAME]) {
        workspaces[DEFAULT_NAME] = { dirs: [], updatedAt: Date.now() };
    }
    const active = typeof file.active === "string" && workspaces[file.active]
        ? file.active
        : DEFAULT_NAME;
    return { active, workspaces };
}
function saveWorkspacesFile(f) {
    (0, store_1.writeJsonFile)(filePath(), f);
}
function validateWorkspaceName(name) {
    if (!name || name.length === 0) {
        return "workspace name must not be empty";
    }
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(name)) {
        return `invalid workspace name ${JSON.stringify(name)} (letters, digits, . _ -; max 64 chars)`;
    }
    return undefined;
}
/** Absolute, normalized directory list of the active (or named) workspace. */
function workspaceDirs(name) {
    const f = loadWorkspacesFile();
    const ws = f.workspaces[name ?? f.active];
    return ws ? [...ws.dirs] : [];
}
function activeWorkspaceName() {
    return loadWorkspacesFile().active;
}
function listWorkspaceNames() {
    const f = loadWorkspacesFile();
    return Object.keys(f.workspaces).sort((a, b) => a.localeCompare(b));
}
/**
 * Add an existing directory to the active workspace. Returns undefined on
 * success, or an error message.
 */
function addDirToWorkspace(dir, name) {
    const resolved = path.resolve(dir);
    let stat;
    try {
        stat = fs.statSync(resolved);
    }
    catch {
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
function saveWorkspaceAs(name) {
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
function loadWorkspace(name) {
    const f = loadWorkspacesFile();
    const ws = f.workspaces[name];
    if (!ws) {
        const known = listWorkspaceNames().join(", ");
        return { error: `unknown workspace ${JSON.stringify(name)} (known: ${known || "none"})` };
    }
    f.active = name;
    saveWorkspacesFile(f);
    const dirs = [...ws.dirs];
    let chdirTo;
    if (dirs.length > 0) {
        try {
            process.chdir(dirs[0]);
            chdirTo = dirs[0];
        }
        catch {
            // The directory may have been deleted since it was saved; the
            // workspace still activates, we just can't chdir into it.
            chdirTo = undefined;
        }
    }
    return { dirs, chdirTo };
}
/** Remove a directory from the active workspace. Returns an error or undefined. */
function removeDirFromWorkspace(dir) {
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
