"use strict";
/**
 * store.ts — shared local state directory for the agent CLI.
 *
 * Everything the CLI persists locally (persistent sessions, plugin
 * registry, hooks) lives under ~/.ide-code. The IDE_CODE_HOME env var
 * overrides the home directory (used by tests to stay hermetic).
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
exports.configDir = configDir;
exports.ensureConfigDir = ensureConfigDir;
exports.readJsonFile = readJsonFile;
exports.writeJsonFile = writeJsonFile;
const fs = __importStar(require("fs"));
const os = __importStar(require("os"));
const path = __importStar(require("path"));
/** ~/.ide-code (or $IDE_CODE_HOME/.ide-code when set). */
function configDir() {
    const home = process.env.IDE_CODE_HOME ?? os.homedir();
    return path.join(home, ".ide-code");
}
/** configDir(), created if missing. */
function ensureConfigDir() {
    const dir = configDir();
    fs.mkdirSync(dir, { recursive: true });
    return dir;
}
function readJsonFile(file, fallback) {
    try {
        const raw = fs.readFileSync(file, "utf8");
        return JSON.parse(raw);
    }
    catch {
        return fallback;
    }
}
/** Atomic-ish write: temp file + rename, so a crash never leaves half a JSON file. */
function writeJsonFile(file, value) {
    const dir = path.dirname(file);
    fs.mkdirSync(dir, { recursive: true });
    const tmp = `${file}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    fs.renameSync(tmp, file);
}
