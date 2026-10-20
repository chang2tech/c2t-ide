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

import * as path from "path";
import { configDir, readJsonFile, writeJsonFile } from "./store";

export type SubagentModelSetting = "default" | "disabled" | "inherit" | string;

export interface AgentConfig {
  subagentModel: SubagentModelSetting;
  modelSlashCommands: boolean;
  autoReview: boolean;
  trust: boolean;
}

const FILE_NAME = "agent-config.json";

export const DEFAULT_AGENT_CONFIG: AgentConfig = {
  subagentModel: "default",
  modelSlashCommands: true,
  autoReview: false,
  trust: false,
};

function filePath(): string {
  return path.join(configDir(), FILE_NAME);
}

/** Load the persisted config, filling missing keys with defaults. */
export function loadAgentConfig(): AgentConfig {
  const raw = readJsonFile<Partial<AgentConfig>>(filePath(), {});
  return {
    subagentModel:
      typeof raw.subagentModel === "string" && raw.subagentModel.length > 0
        ? raw.subagentModel
        : DEFAULT_AGENT_CONFIG.subagentModel,
    modelSlashCommands:
      typeof raw.modelSlashCommands === "boolean"
        ? raw.modelSlashCommands
        : DEFAULT_AGENT_CONFIG.modelSlashCommands,
    autoReview:
      typeof raw.autoReview === "boolean" ? raw.autoReview : DEFAULT_AGENT_CONFIG.autoReview,
    trust: typeof raw.trust === "boolean" ? raw.trust : DEFAULT_AGENT_CONFIG.trust,
  };
}

export function saveAgentConfig(cfg: AgentConfig): void {
  writeJsonFile(filePath(), cfg);
}

export type ConfigKey = keyof AgentConfig;

export const CONFIG_KEYS: readonly ConfigKey[] = [
  "subagentModel",
  "modelSlashCommands",
  "autoReview",
  "trust",
];

function parseBool(value: string): boolean | undefined {
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
export function setAgentConfigValue(key: string, value: string): string | undefined {
  if (!(CONFIG_KEYS as readonly string[]).includes(key)) {
    return `unknown config key ${JSON.stringify(key)} (known: ${CONFIG_KEYS.join(", ")})`;
  }
  const cfg = loadAgentConfig();
  switch (key as ConfigKey) {
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
      const boolKey = key as "modelSlashCommands" | "autoReview" | "trust";
      cfg[boolKey] = b;
      break;
    }
  }
  saveAgentConfig(cfg);
  return undefined;
}

/** Human-readable one-line-per-key dump for `/config`. */
export function formatAgentConfig(cfg: AgentConfig = loadAgentConfig()): string {
  const lines = [
    `subagentModel       ${cfg.subagentModel}`,
    `modelSlashCommands  ${cfg.modelSlashCommands ? "on" : "off"}`,
    `autoReview          ${cfg.autoReview ? "on" : "off"}`,
    `trust               ${cfg.trust ? "on" : "off"}`,
  ];
  return lines.join("\n");
}
