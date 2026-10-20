/**
 * Nested subagents — Cursor `subagent-nested` parity (P2).
 *
 * Spec (verbatim, docs/rea/deep-docs-all.md §"Subagents — new details",
 * sourced from cursor.com/docs Subagents, read directly, HIGH confidence):
 *   - "Nested: main → subagent → sub-subagent allowed (2.5+), one level"
 *
 * The engine (sidecar) already enforces a nesting cap in its subagent
 * tool (packages/core/src/tool/plugin/subagent.ts): it walks the
 * `parentID` chain to compute `depth` and fails the spawn when
 * `depth >= (experimental.subagent_depth ?? 1)`. In engine terms Cursor's
 * "one nested level" is exactly `subagent_depth = 2`: the main session
 * (depth 0) may spawn, a subagent (depth 1) may spawn one sub-subagent,
 * and the sub-subagent (depth 2) may not spawn further.
 *
 * The engine default (1) is stricter than Cursor — a subagent could never
 * delegate. This module computes the IDE-side default: IDE-launched
 * engines get `{"experimental":{"subagent_depth":2}}` injected through
 * `OPENCODE_CONFIG_CONTENT` (wired by the engine's serve path:
 * packages/cli/src/server-process.ts passes
 * `process.env.OPENCODE_CONFIG_CONTENT` as config `content`, and
 * `Config.latest` is findLast, so it applies when the user set nothing —
 * MDM managed settings still outrank it).
 *
 * The injection is a DEFAULT, never an override: it is skipped when the
 * user already configured the key — in any of their opencode.json[c]
 * files (global or project) or via the OPENCODE_CONFIG_CONTENT env var
 * itself. Explicit user configuration always wins.
 */

import * as fs from "node:fs";
import * as path from "node:path";

/**
 * Cursor's nesting allowance in engine depth terms: main → subagent →
 * sub-subagent, one nested level. A session at this depth may not spawn.
 */
export const CURSOR_SUBAGENT_NESTING_DEPTH = 2;

/** Engine config file names (packages/core/src/config/discovery.ts). */
export const ENGINE_CONFIG_FILE_NAMES = ["opencode.json", "opencode.jsonc"] as const;

/**
 * The config content injected as the IDE default. JSON — parsed by the
 * engine's own config loader.
 */
export const NESTING_DEFAULT_CONFIG_CONTENT = JSON.stringify({
  experimental: { subagent_depth: CURSOR_SUBAGENT_NESTING_DEPTH },
});

/** Matches an explicit `"subagent_depth": <n>` key in raw config text. */
const SUBAGENT_DEPTH_KEY_RE = /"subagent_depth"\s*:/;

/**
 * True when the raw config text explicitly sets `subagent_depth`.
 * Defensive by design: a commented-out key also counts (fail-safe —
 * skipping the injection keeps the engine's stricter default rather than
 * overriding something the user may have meant).
 */
export function configTextSetsSubagentDepth(text: string): boolean {
  return SUBAGENT_DEPTH_KEY_RE.test(text);
}

/**
 * Candidate config-file paths the engine reads for this user/workspace
 * set: the global config dir plus one entry per workspace root.
 * `explicitConfigPath` covers `OPENCODE_CONFIG` when set.
 */
export function engineConfigFilePaths(opts: {
  globalConfigDir: string;
  workspaceRoots: string[];
  explicitConfigPath?: string;
}): string[] {
  const out: string[] = [];
  for (const name of ENGINE_CONFIG_FILE_NAMES) {
    out.push(path.join(opts.globalConfigDir, name));
  }
  for (const root of opts.workspaceRoots) {
    for (const name of ENGINE_CONFIG_FILE_NAMES) {
      out.push(path.join(root, name));
    }
  }
  if (opts.explicitConfigPath) {
    out.push(opts.explicitConfigPath);
  }
  return out;
}

/** Read the config texts that exist; missing/unreadable files are skipped. */
export function readConfigTexts(paths: string[]): string[] {
  const out: string[] = [];
  for (const p of paths) {
    try {
      out.push(fs.readFileSync(p, "utf8"));
    } catch {
      /* not present or unreadable — not an explicit setting */
    }
  }
  return out;
}

export interface NestingInjectionInputs {
  /**
   * Current value of process.env.OPENCODE_CONFIG_CONTENT (undefined when
   * unset). Never overridden — an explicit env config always wins.
   */
  existingEnvContent?: string;
  /** Raw texts of the user's engine config files (see readConfigTexts). */
  userConfigTexts: string[];
}

/**
 * Decide the OPENCODE_CONFIG_CONTENT value for an IDE-launched engine.
 * Returns the Cursor-parity default (`experimental.subagent_depth: 2`)
 * only when the user has NOT configured the key anywhere — neither in
 * their config files nor via the env var itself. Returns undefined when
 * an explicit setting exists (the engine then honors the user's value).
 *
 * Pure — unit-tested. The spawn call sites (extension adapter, ide-cli)
 * pass the real env + config texts.
 */
export function resolveSubagentDepthConfigContent(
  inputs: NestingInjectionInputs,
): string | undefined {
  if (inputs.existingEnvContent !== undefined && inputs.existingEnvContent !== "") {
    return undefined;
  }
  for (const text of inputs.userConfigTexts) {
    if (configTextSetsSubagentDepth(text)) {
      return undefined;
    }
  }
  return NESTING_DEFAULT_CONFIG_CONTENT;
}
