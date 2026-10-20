"use strict";
/**
 * sessions.ts — the persistent-session registry behind `agent persist`,
 * `agent ls`, and `agent --resume`.
 *
 * Stored at ~/.ide-code/agent-sessions.json:
 *   { "sessions": [ { id, title, createdAt, lastUsedAt, cwd, mode, model? } ] }
 *
 * The registry only tracks metadata; the engine owns the actual session
 * history. `attach` therefore verifies the id against the engine
 * (session.get) before continuing it.
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
exports.loadRegistry = loadRegistry;
exports.recordSession = recordSession;
exports.touchSession = touchSession;
exports.findSession = findSession;
exports.mostRecentSession = mostRecentSession;
exports.removeSession = removeSession;
const path = __importStar(require("path"));
const store_1 = require("./store");
const FILE_NAME = "agent-sessions.json";
function registryPath() {
    return path.join((0, store_1.configDir)(), FILE_NAME);
}
function loadRegistry() {
    const file = (0, store_1.readJsonFile)(registryPath(), {});
    const sessions = Array.isArray(file.sessions) ? file.sessions : [];
    return {
        sessions: sessions.filter((s) => !!s && typeof s.id === "string" && s.id.length > 0),
    };
}
function saveRegistry(reg) {
    (0, store_1.writeJsonFile)(registryPath(), reg);
}
/** Insert or replace (matched by id). */
function recordSession(session) {
    const reg = loadRegistry();
    const idx = reg.sessions.findIndex((s) => s.id === session.id);
    if (idx >= 0) {
        reg.sessions[idx] = session;
    }
    else {
        reg.sessions.push(session);
    }
    saveRegistry(reg);
}
function touchSession(id, patch) {
    const reg = loadRegistry();
    const s = reg.sessions.find((x) => x.id === id);
    if (!s) {
        return false;
    }
    s.lastUsedAt = Date.now();
    if (patch) {
        Object.assign(s, patch);
    }
    saveRegistry(reg);
    return true;
}
/** Exact match first, then unique id-prefix match. */
function findSession(idOrPrefix) {
    const reg = loadRegistry();
    const exact = reg.sessions.find((s) => s.id === idOrPrefix);
    if (exact) {
        return exact;
    }
    const prefixed = reg.sessions.filter((s) => s.id.startsWith(idOrPrefix));
    return prefixed.length === 1 ? prefixed[0] : undefined;
}
function mostRecentSession() {
    const reg = loadRegistry();
    let best;
    for (const s of reg.sessions) {
        if (!best || s.lastUsedAt > best.lastUsedAt) {
            best = s;
        }
    }
    return best;
}
function removeSession(id) {
    const reg = loadRegistry();
    const before = reg.sessions.length;
    reg.sessions = reg.sessions.filter((s) => s.id !== id);
    if (reg.sessions.length === before) {
        return false;
    }
    saveRegistry(reg);
    return true;
}
