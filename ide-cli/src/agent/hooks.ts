/**
 * hooks.ts — agent lifecycle hooks.
 *
 * Config: ~/.ide-code/hooks.json merged with ./.ide-code/hooks.json
 * (project file runs AFTER the global file). Format:
 *
 *   {
 *     "sessionStart":   ["notify-send 'agent started'"],
 *     "sessionEnd":     ["notify-send 'agent done'"],
 *     "stop":           ["my-stop-checker"],
 *     "preCompaction":  ["echo compacting >> log"],
 *     "subagentStart":  [],
 *     "subagentEnd":    []
 *   }
 *
 * Each command runs via `sh -c` with IDE_CODE_HOOK_EVENT,
 * IDE_CODE_SESSION_ID, IDE_CODE_MODE and IDE_CODE_CWD in the environment.
 * A `stop` hook may request exactly one follow-up turn by printing a line
 * of JSON: {"followUp": "<text>"} (follow-up loops are capped at 3).
 */

import * as childProcess from "child_process";
import * as fs from "fs";
import * as path from "path";
import { configDir, readJsonFile } from "./store";

export type HookEvent =
  | "sessionStart"
  | "sessionEnd"
  | "stop"
  | "preCompaction"
  | "subagentStart"
  | "subagentEnd";

export const HOOK_EVENTS: readonly HookEvent[] = [
  "sessionStart",
  "sessionEnd",
  "stop",
  "preCompaction",
  "subagentStart",
  "subagentEnd",
];

export interface LoadedHooks {
  commands: Record<HookEvent, string[]>;
  warnings: string[];
}

function normalizeFile(raw: unknown, origin: string, warnings: string[]): Record<HookEvent, string[]> {
  const out: Record<HookEvent, string[]> = {
    sessionStart: [],
    sessionEnd: [],
    stop: [],
    preCompaction: [],
    subagentStart: [],
    subagentEnd: [],
  };
  if (raw === undefined || raw === null) {
    return out;
  }
  if (typeof raw !== "object" || Array.isArray(raw)) {
    warnings.push(`${origin}: expected a JSON object, ignoring file`);
    return out;
  }
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!(HOOK_EVENTS as readonly string[]).includes(key)) {
      warnings.push(`${origin}: unknown hook event ${JSON.stringify(key)} — ignored`);
      continue;
    }
    const event = key as HookEvent;
    if (typeof value === "string") {
      out[event].push(value);
    } else if (Array.isArray(value) && value.every((v) => typeof v === "string")) {
      out[event].push(...(value as string[]));
    } else {
      warnings.push(`${origin}: hook ${JSON.stringify(key)} must be a string or string[] — ignored`);
    }
  }
  return out;
}

/**
 * Load hooks: global ~/.ide-code/hooks.json, then <projectDir>/.ide-code/hooks.json.
 * Project commands run after global ones for the same event.
 */
export function loadHooks(projectDir: string): LoadedHooks {
  const warnings: string[] = [];
  const commands: Record<HookEvent, string[]> = {
    sessionStart: [],
    sessionEnd: [],
    stop: [],
    preCompaction: [],
    subagentStart: [],
    subagentEnd: [],
  };
  const globalFile = path.join(configDir(), "hooks.json");
  if (fs.existsSync(globalFile)) {
    const parsed = readJsonFile<unknown>(globalFile, undefined);
    const norm = normalizeFile(parsed, globalFile, warnings);
    for (const e of HOOK_EVENTS) {
      commands[e].push(...norm[e]);
    }
  }
  const projectFile = path.join(projectDir, ".ide-code", "hooks.json");
  if (fs.existsSync(projectFile)) {
    const parsed = readJsonFile<unknown>(projectFile, undefined);
    const norm = normalizeFile(parsed, projectFile, warnings);
    for (const e of HOOK_EVENTS) {
      commands[e].push(...norm[e]);
    }
  }
  return { commands, warnings };
}

export interface HookEnv {
  sessionID?: string;
  mode?: string;
  cwd?: string;
}

export type HookSpawn = (
  cmd: string,
  args: string[],
  opts: childProcess.SpawnOptions,
) => childProcess.ChildProcess;

export interface RunHookOptions {
  spawn?: HookSpawn;
  timeoutMs?: number;
  /** Called per command with (event, command, stdout, stderr, exitCode). */
  log?: (msg: string) => void;
}

const DEFAULT_HOOK_TIMEOUT_MS = 30_000;

function runOne(
  spawnFn: HookSpawn,
  command: string,
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve) => {
    const child = spawnFn("sh", ["-c", command], {
      stdio: ["ignore", "pipe", "pipe"],
      env,
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const done = (code: number) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        resolve({ stdout, stderr, code });
      }
    };
    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        /* already dead */
      }
      done(124);
    }, timeoutMs);
    child.stdout?.on("data", (c: Buffer) => {
      stdout += c.toString();
    });
    child.stderr?.on("data", (c: Buffer) => {
      stderr += c.toString();
    });
    child.on("error", () => done(127));
    child.on("close", (code) => done(code ?? 1));
  });
}

/**
 * Run every command registered for `event`, in order. Returns the list of
 * stdout outputs (used by the stop hook's follow-up detection). A failing
 * command is reported via `log` but never throws — hooks must not break
 * the agent turn.
 */
export async function runHookEvent(
  hooks: LoadedHooks | undefined,
  event: HookEvent,
  env: HookEnv,
  opts: RunHookOptions = {},
): Promise<string[]> {
  const outputs: string[] = [];
  const list = hooks?.commands[event] ?? [];
  if (list.length === 0) {
    return outputs;
  }
  const spawnFn = opts.spawn ?? childProcess.spawn;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_HOOK_TIMEOUT_MS;
  const hookEnv: NodeJS.ProcessEnv = {
    ...process.env,
    IDE_CODE_HOOK_EVENT: event,
    ...(env.sessionID ? { IDE_CODE_SESSION_ID: env.sessionID } : {}),
    ...(env.mode ? { IDE_CODE_MODE: env.mode } : {}),
    ...(env.cwd ? { IDE_CODE_CWD: env.cwd } : {}),
  };
  for (const command of list) {
    const res = await runOne(spawnFn, command, hookEnv, timeoutMs);
    outputs.push(res.stdout);
    if (res.code !== 0 && opts.log) {
      const tail = res.stderr.trim().split("\n").pop() ?? "";
      opts.log(
        `[hook ${event}] ${JSON.stringify(command)} exited ${res.code}${tail ? `: ${tail}` : ""}`,
      );
    }
  }
  return outputs;
}

/**
 * A stop hook requests a follow-up turn by printing one JSON line:
 *   {"followUp": "<text>"}
 * Returns the text, or undefined when no hook asked for a follow-up.
 */
export function parseStopFollowUp(stdouts: string[]): string | undefined {
  for (const out of stdouts) {
    for (const line of out.split("\n")) {
      const t = line.trim();
      if (!t.startsWith("{")) {
        continue;
      }
      try {
        const obj = JSON.parse(t) as { followUp?: unknown };
        if (obj && typeof obj.followUp === "string" && obj.followUp.trim().length > 0) {
          return obj.followUp.trim();
        }
      } catch {
        /* not JSON — keep scanning */
      }
    }
  }
  return undefined;
}
