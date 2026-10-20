import * as fs from "node:fs";
import * as path from "node:path";
import { spawn } from "node:child_process";

/**
 * worktrees-json-config — `.cursor/worktrees.json` setup for agent worktrees
 * (GAPS-132, Cursor parity).
 *
 * Evidence (Cursor 3.25.9, `workbench.glass.main.js`, re-verified by GAPS-132;
 * full notes: ide-code-mission `docs/rea/work-notes-gaps132.md`):
 * - Runtime `eiy(...)` at glass@46710083. It looks for
 *   `<worktreePath>/.cursor/worktrees.json` FIRST, then
 *   `<rootWorkspacePath>/.cursor/worktrees.json`; neither → skip silently with
 *   `{hadScript:!1, scriptFailed:!1}`.
 * - Schema registered at glass@43381934 (`vscode://schemas/cursor/worktrees`,
 *   `additionalProperties:!1`): only three keys — `setup-worktree` (generic
 *   fallback), `setup-worktree-unix`, `setup-worktree-windows`. Each value is
 *   either an array of shell commands or a string path to a script file
 *   relative to the JSON file.
 * - Key selection uses the TARGET OS (remote environment OS when present):
 *   Windows → `setup-worktree-windows` ?? `setup-worktree`;
 *   Unix → `setup-worktree-unix` ?? `setup-worktree`.
 * - A string value is a script-file path: absolute (Unix `/…`; Windows
 *   drive-letter or UNC) is used as-is, otherwise resolved relative to the
 *   directory containing the selected JSON file. A non-string value is
 *   flattened by `p4x` (strings kept, arrays recursed, anything else dropped),
 *   then trimmed / empty-filtered.
 * - Commands are combined into ONE script string (builders `c4x`/`u4x` for
 *   command lists, `d4x`/`h4x` for script files — mirrored verbatim below) and
 *   executed in a shell session with cwd = the new worktree. The combined
 *   script `cd`s into the worktree, exports `ROOT_WORKTREE_PATH` =
 *   rootWorkspacePath, and (Unix commands form) sets `$1` = worktreePath.
 *   Unix script files run via `bash '<script>' '<worktreePath>'`.
 * - Timeout `Edu = 300*1e3` ms; on timeout the session is cancelled and the
 *   result is a failure with `Worktree setup script timed out after 300s`.
 * - Output (stdout+stderr) is accumulated keeping only the LAST 2048 chars
 *   (`qZg = 2048`, glass@25950961).
 * - The function NEVER throws: every failure path returns
 *   `{hadScript, scriptFailed, scriptError?, scriptOutput?}` and the caller
 *   continues agent creation (glass@46755597: "Worktree setup script failed
 *   (continuing with agent creation)").
 *
 * Divergence (honest): Cursor runs the script through its shellExecService
 * session (the user/remote shell profile — the exact shell binary is not
 * visible in the binary slices, UNKNOWN). Here the default executor spawns
 * `bash -c` (fallback `sh -c`) on Unix and `powershell.exe -Command` on
 * Windows, which matches the script syntax Cursor generates.
 */

/** Timeout for the whole setup run: `var Edu=300*1e3` (glass@46710083 area). */
export const WORKTREE_SETUP_TIMEOUT_MS = 300 * 1000;

/** Only the last 2048 chars of combined output are kept (`qZg=2048`). */
export const WORKTREE_SETUP_OUTPUT_TAIL_CHARS = 2048;

/** Result shape returned by Cursor's runner — it never throws. */
export interface WorktreeSetupResult {
  hadScript: boolean;
  scriptFailed: boolean;
  scriptError?: string;
  scriptOutput?: string;
}

/** Phase names from `worktreeSetupTypes.js` (glass@25950684). */
export type WorktreeSetupPhase = "runningSetupScript";

export interface WorktreeSetupLog {
  info(message: string, ...args: unknown[]): void;
  error(message: string, ...args: unknown[]): void;
}

const defaultLog: WorktreeSetupLog = {
  info: (m, ...a) => console.log(m, ...a),
  error: (m, ...a) => console.error(m, ...a),
};

/**
 * `p4x` verbatim: flatten a config value into a command list — strings are
 * kept, arrays are recursed into, everything else is dropped.
 */
export function flattenSetupCommands(value: unknown): string[] {
  const out: string[] = [];
  const walk = (v: unknown): void => {
    if (typeof v === "string") {
      out.push(v);
      return;
    }
    if (Array.isArray(v)) {
      for (const item of v) walk(item);
    }
  };
  walk(value);
  return out;
}

export interface SelectedSetupSpec {
  /** The config key that won selection, if any. */
  key?: string;
  /** Command list form (already flattened, not yet trimmed). */
  commands?: string[];
  /** Script-file form (raw string value from the config). */
  scriptValue?: string;
}

/**
 * Key selection exactly as the binary: OS-specific key wins when it is
 * `!== undefined`, otherwise the generic `setup-worktree`. A string value is
 * a script file; any other defined value is flattened into commands.
 */
export function selectSetupSpec(config: Record<string, unknown>, isWindows: boolean): SelectedSetupSpec {
  let value: unknown;
  let key: string | undefined;
  if (isWindows) {
    if (config["setup-worktree-windows"] !== undefined) {
      value = config["setup-worktree-windows"];
      key = "setup-worktree-windows";
    } else if (config["setup-worktree"] !== undefined) {
      value = config["setup-worktree"];
      key = "setup-worktree";
    }
  } else {
    if (config["setup-worktree-unix"] !== undefined) {
      value = config["setup-worktree-unix"];
      key = "setup-worktree-unix";
    } else if (config["setup-worktree"] !== undefined) {
      value = config["setup-worktree"];
      key = "setup-worktree";
    }
  }
  if (key === undefined) return {};
  if (typeof value === "string") return { key, scriptValue: value };
  if (value !== undefined) return { key, commands: flattenSetupCommands(value) };
  return { key };
}

/** Absolute-path test from the binary: Windows drive/UNC, Unix leading `/`. */
export function isAbsoluteSetupScriptPath(p: string, isWindows: boolean): boolean {
  return isWindows ? /^[a-zA-Z]:[\\/]/.test(p) || p.startsWith("\\\\") : p.startsWith("/");
}

/**
 * Resolve a script-file value: absolute → as-is; otherwise relative to the
 * directory containing the config file that was selected (binary:
 * `js(Dc(T), N)` — join of the config URI's dirname with the value).
 */
export function resolveSetupScriptPath(scriptValue: string, configFilePath: string, isWindows: boolean): string {
  if (isAbsoluteSetupScriptPath(scriptValue, isWindows)) return scriptValue;
  return path.resolve(path.dirname(configFilePath), scriptValue);
}

/** `FWn`: single-quote escaping for the Unix script builders. */
export function escapeSetupSingleQuotes(t: string): string {
  return t.replace(/'/g, "'\\''");
}

/** `BWn`: backtick/quote escaping for the Windows script builders. */
export function escapeSetupWindows(t: string): string {
  return t.replace(/`/g, "``").replace(/"/g, '`"');
}

/**
 * `c4x` verbatim: combined Unix script for a command list. Commands are
 * chained with `&&` (a failing command stops the chain), each wrapped in
 * `[worktree-setup] [i] $ …` / `[worktree-setup] [i] done` log lines.
 */
export function buildUnixCommandsScript(opts: {
  worktreePath: string;
  rootWorkspacePath: string;
  commands: string[];
}): string {
  const r = escapeSetupSingleQuotes(opts.worktreePath);
  const s = escapeSetupSingleQuotes(opts.rootWorkspacePath);
  const o = opts.commands
    .map((a, l) => {
      const c = escapeSetupSingleQuotes(a);
      return `printf '%s\\n' '[worktree-setup] [${l}] $ ${c}' && ${a} && printf '%s\\n' '[worktree-setup] [${l}] done'`;
    })
    .join(" && ");
  return `cd '${r}' || { printf '%s\\n' '[worktree-setup] ERROR: Failed to cd to worktree directory'; exit 1; } && export ROOT_WORKTREE_PATH='${s}' && set -- '${r}' && printf '%s\\n' '[worktree-setup] Working directory: '$(pwd) && ${o}`;
}

/** `u4x` verbatim: combined Windows (PowerShell) script for a command list. */
export function buildWindowsCommandsScript(opts: {
  worktreePath: string;
  rootWorkspacePath: string;
  commands: string[];
}): string {
  const r = escapeSetupWindows(opts.worktreePath);
  const s = escapeSetupWindows(opts.rootWorkspacePath);
  const o = opts.commands
    .map((a, l) => {
      const c = escapeSetupWindows(a);
      return `Write-Host "[worktree-setup] [${l}] $ ${c}"; ${a}; if ($LASTEXITCODE -ne $null -and $LASTEXITCODE -ne 0) { Write-Host "[worktree-setup] [${l}] failed with exit code $LASTEXITCODE"; exit $LASTEXITCODE } else { Write-Host "[worktree-setup] [${l}] done" }`;
    })
    .join("; ");
  return `$ErrorActionPreference = 'Stop'; Set-Location -LiteralPath "${r}"; $env:ROOT_WORKTREE_PATH = "${s}"; Write-Host '[worktree-setup] Working directory: ' (Get-Location); ${o}`;
}

/** `d4x` verbatim: Unix script-file invocation (`bash '<script>' '<worktree>'`). */
export function buildUnixScriptFileScript(opts: {
  worktreePath: string;
  rootWorkspacePath: string;
  scriptPath: string;
}): string {
  const r = escapeSetupSingleQuotes(opts.worktreePath);
  const s = escapeSetupSingleQuotes(opts.rootWorkspacePath);
  const o = escapeSetupSingleQuotes(opts.scriptPath);
  return `cd '${r}' || { printf '%s\\n' '[worktree-setup] ERROR: Failed to cd to worktree directory'; exit 1; } && export ROOT_WORKTREE_PATH='${s}' && printf '%s\\n' '[worktree-setup] Executing setup script: ${o}' && bash '${o}' '${r}'`;
}

/** `h4x` verbatim: Windows script-file invocation (`& "<script>" "<worktree>"`). */
export function buildWindowsScriptFileScript(opts: {
  worktreePath: string;
  rootWorkspacePath: string;
  scriptPath: string;
}): string {
  const r = escapeSetupWindows(opts.worktreePath);
  const s = escapeSetupWindows(opts.rootWorkspacePath);
  const o = escapeSetupWindows(opts.scriptPath);
  return `$ErrorActionPreference = 'Stop'; Set-Location -LiteralPath "${r}"; $env:ROOT_WORKTREE_PATH = "${s}"; & "${o}" "${r}"`;
}

/** One running setup execution: resolves with the exit code (null = killed/signalled). */
export interface WorktreeSetupExecution {
  done: Promise<number | null>;
  cancel(): void;
}

export type WorktreeSetupExecutor = (
  script: string,
  cwd: string,
  isWindows: boolean,
  onData: (chunk: string) => void,
) => WorktreeSetupExecution;

/**
 * Default executor: spawn the combined script in a shell with cwd = the new
 * worktree (Cursor: shellExecService `createSession({cwd})` +
 * `execute(session, script, {interactive:!1})`). Unix uses bash (the script
 * syntax is POSIX sh; script files are invoked with `bash` by the builder
 * itself), Windows uses PowerShell (the builders emit PowerShell).
 */
export const defaultWorktreeSetupExecutor: WorktreeSetupExecutor = (script, cwd, isWindows, onData) => {
  const command = isWindows ? "powershell.exe" : fs.existsSync("/bin/bash") ? "/bin/bash" : "/bin/sh";
  const args = isWindows ? ["-NoProfile", "-Command", script] : ["-c", script];
  const child = spawn(command, args, { cwd, env: process.env });
  child.stdout?.on("data", (d: Buffer) => onData(d.toString()));
  child.stderr?.on("data", (d: Buffer) => onData(d.toString()));
  const done = new Promise<number | null>((resolve) => {
    child.on("error", () => resolve(null));
    child.on("close", (code) => resolve(code));
  });
  return {
    done,
    cancel: () => {
      try {
        child.kill("SIGTERM");
      } catch {
        /* already gone */
      }
    },
  };
};

export interface RunWorktreeSetupOptions {
  worktreePath: string;
  rootWorkspacePath: string;
  /** Target OS. Defaults to the local platform (Cursor: remote OS when present). */
  isWindows?: boolean;
  log?: WorktreeSetupLog;
  onPhaseChange?: (phase: WorktreeSetupPhase) => void;
  timeoutMs?: number;
  executor?: WorktreeSetupExecutor;
  /** Injectable for tests; defaults to fs.existsSync. */
  fileExists?: (p: string) => boolean;
  /** Injectable for tests; defaults to fs.readFileSync utf8. */
  readFileText?: (p: string) => string;
}

/**
 * Run the `.cursor/worktrees.json` setup for a freshly created worktree —
 * a faithful port of Cursor's `eiy` (glass@46710083). NEVER throws; every
 * outcome is reported via the returned result, exactly like the binary.
 */
export async function runWorktreeSetup(opts: RunWorktreeSetupOptions): Promise<WorktreeSetupResult> {
  const log = opts.log ?? defaultLog;
  const isWindows = opts.isWindows ?? process.platform === "win32";
  const timeoutMs = opts.timeoutMs ?? WORKTREE_SETUP_TIMEOUT_MS;
  const fileExists = opts.fileExists ?? ((p: string) => fs.existsSync(p));
  const readFileText = opts.readFileText ?? ((p: string) => fs.readFileSync(p, "utf8"));
  const { worktreePath, rootWorkspacePath } = opts;

  const worktreeConfigFile = path.join(worktreePath, ".cursor", "worktrees.json");
  const rootConfigFile = path.join(rootWorkspacePath, ".cursor", "worktrees.json");
  log.info("[worktree-setup] checking config", {
    worktreePath,
    rootWorkspacePath,
    worktreeConfigFile,
    rootConfigFile,
    isTargetWindows: isWindows,
  });

  let commands: string[] | undefined;
  let scriptPath: string | undefined;
  try {
    let configFile: string | undefined;
    if (fileExists(worktreeConfigFile)) configFile = worktreeConfigFile;
    else if (fileExists(rootConfigFile)) configFile = rootConfigFile;
    if (!configFile) {
      log.info("[worktree-setup] no config file found in worktree or root, skipping");
      return { hadScript: false, scriptFailed: false };
    }
    const parsed = JSON.parse(readFileText(configFile)) as Record<string, unknown>;
    const spec = selectSetupSpec(parsed, isWindows);
    if (spec.scriptValue !== undefined) {
      scriptPath = resolveSetupScriptPath(spec.scriptValue, configFile, isWindows);
    } else if (spec.commands !== undefined) {
      commands = spec.commands;
    }
    log.info("[worktree-setup] selected setup spec", {
      key: spec.key,
      hasCommands: !!(commands && commands.length > 0),
      hasScript: !!scriptPath,
      configPath: configFile,
    });
  } catch (err) {
    log.error("[worktree-setup] failed reading config:", err);
    return { hadScript: false, scriptFailed: false };
  }

  if ((!commands || commands.length === 0) && !scriptPath) {
    log.info("[worktree-setup] no setup spec found (commands or script), skipping");
    return { hadScript: false, scriptFailed: false };
  }

  let script: string | undefined;
  if (commands && commands.length > 0) {
    const trimmed = commands.map((c) => c.trim()).filter((c) => !!c);
    if (trimmed.length === 0) {
      log.info("[worktree-setup] no commands to execute after filtering, skipping");
      return { hadScript: false, scriptFailed: false };
    }
    if (isWindows) {
      script = buildWindowsCommandsScript({ worktreePath, rootWorkspacePath, commands: trimmed });
      log.info("[worktree-setup] executing combined Windows script", { worktreePath, scriptLength: script.length });
    } else {
      script = buildUnixCommandsScript({ worktreePath, rootWorkspacePath, commands: trimmed });
      log.info("[worktree-setup] executing combined UNIX script", { worktreePath, scriptLength: script.length });
    }
  } else if (scriptPath) {
    if (isWindows) {
      script = buildWindowsScriptFileScript({ worktreePath, rootWorkspacePath, scriptPath });
      log.info("[worktree-setup] executing Windows setup script file", { worktreePath, scriptLength: script.length, scriptPath });
    } else {
      script = buildUnixScriptFileScript({ worktreePath, rootWorkspacePath, scriptPath });
      log.info("[worktree-setup] executing UNIX setup script file", { worktreePath, scriptLength: script.length, scriptPath });
    }
  }
  if (!script) {
    log.info("[worktree-setup] nothing to execute after normalization, skipping");
    return { hadScript: false, scriptFailed: false };
  }

  opts.onPhaseChange?.("runningSetupScript");

  let output = "";
  let execution: WorktreeSetupExecution | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const startedAt = Date.now();
    execution = (opts.executor ?? defaultWorktreeSetupExecutor)(script, worktreePath, isWindows, (chunk) => {
      output = (output + chunk).slice(-WORKTREE_SETUP_OUTPUT_TAIL_CHARS);
    });
    let timedOut = false;
    const timeoutPromise = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        timedOut = true;
        log.error("[worktree-setup] setup script timed out; cancelling session", { timeoutMs });
        try {
          execution?.cancel();
        } catch (cancelErr) {
          log.error("[worktree-setup] failed cancelling timed-out session:", cancelErr);
        }
        reject(new Error(`Worktree setup script timed out after ${timeoutMs / 1000}s`));
      }, timeoutMs);
    });
    const code = await Promise.race([execution.done, timeoutPromise]);
    void timedOut;
    const durationMs = Date.now() - startedAt;
    log.info("[worktree-setup] setup script finished", { durationMs, exitCode: code, timedOut: false });
    if (code === null) {
      const msg = "Worktree setup script terminated without an exit code (possibly killed by a signal)";
      log.error("[worktree-setup] " + msg);
      return { hadScript: true, scriptFailed: true, scriptError: msg, scriptOutput: output || undefined };
    }
    if (code !== 0) {
      const msg = `Worktree setup script failed with exit code ${code}`;
      log.error("[worktree-setup] " + msg);
      return { hadScript: true, scriptFailed: true, scriptError: msg, scriptOutput: output || undefined };
    }
    return { hadScript: true, scriptFailed: false };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error("[worktree-setup] failed executing setup script:", err);
    return { hadScript: true, scriptFailed: true, scriptError: msg, scriptOutput: output || undefined };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
