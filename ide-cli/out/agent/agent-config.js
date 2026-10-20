"use strict";
/**
 * agent-config.ts — persistent agent preferences for the CLI TUI.
 *
 * Stored at ~/.ide-code/agent-config.json. Covers the settings Cursor's
 * CLI `/config` manages that have a local meaning here:
 *
 *   subagentModel       "default" | "disabled" | "inherit" | "<model id>"
 *                       (stored; the local engine exposes no subagent-model
 *                       knob today, so this is a recorded preference)
 *   modelSlashCommands  boolean — whether /opus /composer /fast work
 *   autoReview          boolean — auto-approve reviewable tools without prompting
 *   trust               boolean — workspace-trust marker (the local engine has
 *                       no trust gate; kept for Cursor compatibility)
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
exports.CONFIG_KEYS = exports.DEFAULT_AGENT_CONFIG = void 0;
exports.loadAgentConfig = loadAgentConfig;
exports.saveAgentConfig = saveAgentConfig;
exports.setAgentConfigValue = setAgentConfigValue;
exports.formatAgentConfig = formatAgentConfig;
const path = __importStar(require("path"));
const store_1 = require("./store");
const FILE_NAME = "agent-config.json";
exports.DEFAULT_AGENT_CONFIG = {
    subagentModel: "default",
    modelSlashCommands: true,
    autoReview: false,
    trust: false,
};
function filePath() {
    return path.join((0, store_1.configDir)(), FILE_NAME);
}
/** Load the persisted config, filling missing keys with defaults. */
function loadAgentConfig() {
    const raw = (0, store_1.readJsonFile)(filePath(), {});
    return {
        subagentModel: typeof raw.subagentModel === "string" && raw.subagentModel.length > 0
            ? raw.subagentModel
            : exports.DEFAULT_AGENT_CONFIG.subagentModel,
        modelSlashCommands: typeof raw.modelSlashCommands === "boolean"
            ? raw.modelSlashCommands
            : exports.DEFAULT_AGENT_CONFIG.modelSlashCommands,
        autoReview: typeof raw.autoReview === "boolean" ? raw.autoReview : exports.DEFAULT_AGENT_CONFIG.autoReview,
        trust: typeof raw.trust === "boolean" ? raw.trust : exports.DEFAULT_AGENT_CONFIG.trust,
    };
}
function saveAgentConfig(cfg) {
    (0, store_1.writeJsonFile)(filePath(), cfg);
}
exports.CONFIG_KEYS = [
    "subagentModel",
    "modelSlashCommands",
    "autoReview",
    "trust",
];
function parseBool(value) {
    const v = value.trim().toLowerCase();
    if (["1", "true", "yes", "on", "enabled", "enable"].includes(v)) {
        return true;
    }
    if (["0", "false", "no", "off", "disabled", "disable"].includes(v)) {
        return false;
    }
    return undefined;
}
/**
 * Set one config key from its string form. Returns undefined on success,
 * or an error message describing the accepted values.
 */
function setAgentConfigValue(key, value) {
    if (!exports.CONFIG_KEYS.includes(key)) {
        return `unknown config key ${JSON.stringify(key)} (known: ${exports.CONFIG_KEYS.join(", ")})`;
    }
    const cfg = loadAgentConfig();
    switch (key) {
        case "subagentModel": {
            const v = value.trim();
            if (v.length === 0) {
                return "subagentModel must be default|disabled|inherit or a model id";
            }
            cfg.subagentModel = v;
            break;
        }
        case "modelSlashCommands":
        case "autoReview":
        case "trust": {
            const b = parseBool(value);
            if (b === undefined) {
                return `${key} must be on|off (got ${JSON.stringify(value)})`;
            }
            // The case labels above narrow key to the three boolean keys.
            const boolKey = key;
            cfg[boolKey] = b;
            break;
        }
    }
    saveAgentConfig(cfg);
    return undefined;
}
/** Human-readable one-line-per-key dump for `/config`. */
function formatAgentConfig(cfg = loadAgentConfig()) {
    const lines = [
        `subagentModel       ${cfg.subagentModel}`,
        `modelSlashCommands  ${cfg.modelSlashCommands ? "on" : "off"}`,
        `autoReview          ${cfg.autoReview ? "on" : "off"}`,
        `trust               ${cfg.trust ? "on" : "off"}`,
    ];
    return lines.join("\n");
}
