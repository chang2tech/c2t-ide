// IDE-CODE: Migrated from extensions/ide-agent/src/hooks/hookLoader.ts (CAT-A, pure logic).
/**
 * hookLoader — reads hooks.json from every config source, validates each
 * source independently (`parseAndValidateHooksConfig` parity), and merges.
 *
 * Read order (Cursor parity, rebranded for IDE Code):
 *   enterprise → user → project → cursor-compat → claude-compat
 * A bad source records per-source errors (`hooksConfigErrors`) and never
 * kills the other sources.
 *
 * Pure node: fs/path/os only. No vscode import (testable with node:test).
 */

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  HookEntry,
  HookEventName,
  HookSourceKind,
  isKnownEvent,
  LoadedHook,
  SourceLoadResult,
} from "../../common/hooks/hookTypes.js";

const FILENAME = "hooks.json";
const PROJECT_DIR_NAMES = [".ide-code", ".cursor"]; // rebrand first, Cursor compat second
const USER_DIR_NAMES = [".ide-code", ".cursor"];

function enterprisePath(): string {
  switch (process.platform) {
    case "darwin":
      return path.join("/Library", "Application Support", "IDE Code", FILENAME);
    case "win32":
      return path.join(process.env["ProgramData"] ?? "C:\\ProgramData", "IDE Code", FILENAME);
    default:
      return path.join("/etc", "ide-code", FILENAME);
  }
}

function userPath(dirName: string): string {
  return path.join(os.homedir(), dirName, FILENAME);
}

function projectPath(workspaceRoot: string, dirName: string): string {
  return path.join(workspaceRoot, dirName, FILENAME);
}

/** Validate one raw hooks.json object. Returns entries + errors. */
export function parseAndValidateHooksConfig(
  raw: unknown,
  kind: HookSourceKind,
  sourcePath: string,
): { hooks: LoadedHook[]; errors: string[] } {
  const hooks: LoadedHook[] = [];
  const errors: string[] = [];
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    errors.push(`${sourcePath}: expected a JSON object at top level`);
    return { hooks, errors };
  }
  const obj = raw as Record<string, unknown>;
  const hooksObj = obj["hooks"];
  if (hooksObj === undefined) {
    return { hooks, errors }; // empty config — valid, no hooks
  }
  if (hooksObj === null || typeof hooksObj !== "object" || Array.isArray(hooksObj)) {
    errors.push(`${sourcePath}: "hooks" must be an object mapping event names to arrays`);
    return { hooks, errors };
  }
  for (const [eventName, rawList] of Object.entries(hooksObj as Record<string, unknown>)) {
    if (!isKnownEvent(eventName)) {
      // Unknown event — never invent one. Record and skip.
      errors.push(`${sourcePath}: unknown hook event "${eventName}" (expected one of the 21 verified events) — skipped`);
      continue;
    }
    if (!Array.isArray(rawList)) {
      errors.push(`${sourcePath}: hooks for "${eventName}" must be an array — skipped`);
      continue;
    }
    rawList.forEach((rawEntry, i) => {
      const where = `${sourcePath}: hooks.${eventName}[${i}]`;
      if (rawEntry === null || typeof rawEntry !== "object" || Array.isArray(rawEntry)) {
        errors.push(`${where}: must be an object — skipped`);
        return;
      }
      const e = rawEntry as Record<string, unknown>;
      if (typeof e["command"] !== "string" || e["command"].length === 0) {
        errors.push(`${where}: "command" must be a non-empty string — skipped`);
        return;
      }
      const type = e["type"];
      if (type !== undefined && type !== "command" && type !== "prompt") {
        errors.push(`${where}: "type" must be "command" or "prompt" — skipped`);
        return;
      }
      const timeout = e["timeout"];
      if (timeout !== undefined && (typeof timeout !== "number" || timeout <= 0)) {
        errors.push(`${where}: "timeout" must be a positive number of seconds — skipped`);
        return;
      }
      const loopLimit = e["loop_limit"];
      if (loopLimit !== undefined && loopLimit !== null && (typeof loopLimit !== "number" || loopLimit < 0)) {
        errors.push(`${where}: "loop_limit" must be a non-negative number or null — skipped`);
        return;
      }
      const matcher = e["matcher"];
      if (matcher !== undefined && typeof matcher !== "string") {
        errors.push(`${where}: "matcher" must be a string regex — skipped`);
        return;
      }
      if (typeof matcher === "string") {
        try {
          new RegExp(matcher);
        } catch {
          errors.push(`${where}: "matcher" is not a valid regex — skipped`);
          return;
        }
      }
      const entry: HookEntry = {
        command: e["command"] as string,
        type: (type as HookEntry["type"]) ?? "command",
        timeout: typeof timeout === "number" ? timeout : undefined,
        loop_limit: loopLimit === undefined ? undefined : (loopLimit as number | null),
        failClosed: e["failClosed"] === true,
        matcher: typeof matcher === "string" ? matcher : undefined,
        model: typeof e["model"] === "string" ? (e["model"] as string) : undefined,
      };
      hooks.push({ entry, source: kind, sourcePath, event: eventName as HookEventName });
    });
  }
  return { hooks, errors };
}

/**
 * Claude-compat adapter. Cursor reads `.claude/settings.json` and
 * `.claude/settings.local.json` alongside its own configs (observed).
 * Claude's schema: `{ hooks: { PreToolUse: [{ matcher, hooks: [{ type, command, timeout }] }] } }`.
 */
const CLAUDE_EVENT_MAP: Record<string, HookEventName> = {
  SessionStart: "sessionStart",
  SessionEnd: "sessionEnd",
  PreToolUse: "preToolUse",
  PostToolUse: "postToolUse",
  PostToolUseFailure: "postToolUseFailure",
  SubagentStart: "subagentStart",
  SubagentStop: "subagentStop",
  UserPromptSubmit: "beforeSubmitPrompt",
  Stop: "stop",
  PreCompact: "preCompact",
  // Notification has no Cursor-side equivalent — dropped (recorded as a note).
};

function adaptClaudeConfig(raw: unknown, kind: HookSourceKind, sourcePath: string): { hooks: LoadedHook[]; errors: string[] } {
  const hooks: LoadedHook[] = [];
  const errors: string[] = [];
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    errors.push(`${sourcePath}: expected a JSON object — skipped`);
    return { hooks, errors };
  }
  const hooksObj = (raw as Record<string, unknown>)["hooks"];
  if (hooksObj === undefined) {
    return { hooks, errors };
  }
  if (hooksObj === null || typeof hooksObj !== "object" || Array.isArray(hooksObj)) {
    errors.push(`${sourcePath}: "hooks" must be an object — skipped`);
    return { hooks, errors };
  }
  for (const [claudeEvent, rawList] of Object.entries(hooksObj as Record<string, unknown>)) {
    const event = CLAUDE_EVENT_MAP[claudeEvent];
    if (!event) {
      errors.push(`${sourcePath}: no Cursor-side equivalent for Claude hook "${claudeEvent}" — skipped`);
      continue;
    }
    if (!Array.isArray(rawList)) {
      errors.push(`${sourcePath}: hooks for "${claudeEvent}" must be an array — skipped`);
      continue;
    }
    rawList.forEach((rawEntry, i) => {
      const where = `${sourcePath}: hooks.${claudeEvent}[${i}]`;
      if (rawEntry === null || typeof rawEntry !== "object" || Array.isArray(rawEntry)) {
        errors.push(`${where}: must be an object — skipped`);
        return;
      }
      const e = rawEntry as Record<string, unknown>;
      const inner = Array.isArray(e["hooks"]) ? (e["hooks"] as unknown[]) : [];
      if (inner.length === 0) {
        errors.push(`${where}: no inner "hooks" array — skipped`);
        return;
      }
      const matcher = typeof e["matcher"] === "string" ? (e["matcher"] as string) : undefined;
      for (const rawInner of inner) {
        if (rawInner === null || typeof rawInner !== "object" || Array.isArray(rawInner)) {
          continue;
        }
        const cmd = (rawInner as Record<string, unknown>)["command"];
        if (typeof cmd !== "string" || cmd.length === 0) {
          continue;
        }
        const timeout = (rawInner as Record<string, unknown>)["timeout"];
        hooks.push({
          entry: {
            command: cmd,
            type: "command",
            timeout: typeof timeout === "number" && timeout > 0 ? timeout : undefined,
            matcher,
          },
          source: kind,
          sourcePath,
          event,
        });
      }
    });
  }
  return { hooks, errors };
}

function readSourceFile(filePath: string): { raw: unknown; parseError?: string } {
  let text: string;
  try {
    text = fs.readFileSync(filePath, "utf8");
  } catch {
    return { raw: undefined };
  }
  try {
    return { raw: JSON.parse(text) as unknown };
  } catch (err) {
    return { raw: undefined, parseError: `${filePath}: invalid JSON (${err instanceof Error ? err.message : String(err)})` };
  }
}

/** Load hooks from every source, in merge order. */
export function loadAllHookSources(workspaceRoots: string[]): SourceLoadResult[] {
  const results: SourceLoadResult[] = [];
  const push = (kind: HookSourceKind, filePath: string, claude = false): void => {
    const { raw, parseError } = readSourceFile(filePath);
    if (raw === undefined && !parseError) {
      results.push({ kind, path: filePath, found: false, hooks: [], errors: [] });
      return;
    }
    if (parseError) {
      results.push({ kind, path: filePath, found: true, hooks: [], errors: [parseError] });
      return;
    }
    const { hooks, errors } = claude
      ? adaptClaudeConfig(raw, kind, filePath)
      : parseAndValidateHooksConfig(raw, kind, filePath);
    results.push({ kind, path: filePath, found: true, hooks, errors });
  };

  // 1. Enterprise.
  push("enterprise", enterprisePath());
  // 2. User.
  for (const dir of USER_DIR_NAMES) {
    push(dir === ".ide-code" ? "user" : "cursor-user-compat", userPath(dir));
  }
  // 3. Project (per workspace folder).
  for (const root of workspaceRoots) {
    for (const dir of PROJECT_DIR_NAMES) {
      push(dir === ".ide-code" ? "project" : "cursor-project-compat", projectPath(root, dir));
    }
  }
  // 4. Claude compat (project-level, observed read alongside).
  for (const root of workspaceRoots) {
    push("claude-compat", path.join(root, ".claude", "settings.json"), true);
    push("claude-local-compat", path.join(root, ".claude", "settings.local.json"), true);
  }
  return results;
}

/** All loaded hooks in merge order, plus every source's errors. */
export function flattenHooks(results: SourceLoadResult[]): { hooks: LoadedHook[]; errors: string[] } {
  const hooks: LoadedHook[] = [];
  const errors: string[] = [];
  for (const r of results) {
    hooks.push(...r.hooks);
    errors.push(...r.errors);
  }
  return { hooks, errors };
}
