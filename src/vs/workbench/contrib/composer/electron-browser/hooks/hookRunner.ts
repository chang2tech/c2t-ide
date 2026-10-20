// IDE-CODE: Migrated from extensions/ide-agent/src/hooks/hookRunner.ts (CAT-A, pure logic).
/**
 * hookRunner — executes one hook entry as a child process.
 *
 * Exit-code semantics (parity with Cursor, spec §C4):
 *   0            → allow (unless stdout JSON says deny/ask)
 *   2            → BLOCK the action. Verbatim message when no reason given:
 *                  `Hook "<cmd>" blocked this action (exit code 2) but provided no reason.`
 *   other non-0  → fail-open (action proceeds) UNLESS failClosed: true.
 *   timeout/spawn error → failure; failClosed decides block vs allow.
 *
 * Hook stdout JSON (optional, when stdout parses as JSON):
 *   { "decision": "deny"|"ask"|"allow", "reason": "...",
 *     "user_message": "...", "agent_message": "...",
 *     "followup_message": "...", "pluginPaths": [...] }
 * Raw stdout is always returned so callers can append it to context.
 *
 * Pure node: child_process only. No vscode import.
 */

import { spawn } from "child_process";
import { HookDecision, HookPayload, HookRunOutcome, LoadedHook } from "../../common/hooks/hookTypes.js";

const MAX_OUTPUT_BYTES = 64 * 1024;
const MAX_CONTEXT_BYTES = 4 * 1024;
const DEFAULT_TIMEOUT_SEC = 30;

export interface RunnerOptions {
  /** Working directory for the hook process (a workspace root). */
  cwd: string;
  /** App version reported as cursor_version. */
  appVersion: string;
  /** Extra env injected alongside the CURSOR_* contract. */
  extraEnv?: Record<string, string>;
}

interface StdoutDecision {
  decision?: unknown;
  reason?: unknown;
  user_message?: unknown;
  agent_message?: unknown;
  followup_message?: unknown;
  pluginPaths?: unknown;
}

function parseStdoutJson(stdout: string): StdoutDecision | undefined {
  const trimmed = stdout.trim();
  if (!trimmed.startsWith("{")) {
    return undefined;
  }
  try {
    return JSON.parse(trimmed) as StdoutDecision;
  } catch {
    return undefined;
  }
}

function asDecision(value: unknown): HookDecision | undefined {
  return value === "deny" || value === "ask" || value === "allow" ? value : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function asStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const out = value.filter((v): v is string => typeof v === "string" && v.length > 0);
  return out.length > 0 ? out : undefined;
}

export function buildHookEnv(payload: HookPayload, extraEnv?: Record<string, string>): Record<string, string> {
  const projectDir = payload.workspace_roots[0] ?? process.cwd();
  const env: Record<string, string> = {
    ...process.env,
    // Cursor's hook env contract (compat — user hooks may read these).
    CURSOR_PROJECT_DIR: projectDir,
    CURSOR_VERSION: payload.cursor_version,
    CURSOR_USER_EMAIL: payload.user_email ?? "",
    CURSOR_TRANSCRIPT_PATH: payload.transcript_path ?? "",
    CURSOR_CODE_REMOTE: "0",
    CLAUDE_PROJECT_DIR: projectDir,
    // Rebrand equivalents for new hooks.
    IDE_CODE_PROJECT_DIR: projectDir,
    IDE_CODE_VERSION: payload.cursor_version,
    IDE_CODE_HOOK_EVENT: payload.hook_event_name,
    ...extraEnv,
  };
  // Drop undefined-valued keys (process.env spread can include them).
  for (const k of Object.keys(env)) {
    if (env[k] === undefined) {
      delete env[k];
    }
  }
  return env as Record<string, string>;
}

export function buildHookInput(payload: HookPayload): string {
  return JSON.stringify(payload);
}

/** Substitute $ARGUMENTS in prompt-type hooks with the JSON payload. */
export function expandArguments(template: string, payload: HookPayload): string {
  return template.split("$ARGUMENTS").join(buildHookInput(payload));
}

export async function runHookProcess(
  hook: LoadedHook,
  payload: HookPayload,
  opts: RunnerOptions,
): Promise<HookRunOutcome> {
  const startedAt = Date.now();
  const timeoutMs = Math.max(1, (hook.entry.timeout ?? DEFAULT_TIMEOUT_SEC) * 1000);
  const env = buildHookEnv(payload, opts.extraEnv);

  const base: Omit<HookRunOutcome, "exitCode" | "timedOut" | "decision" | "reason" | "blocks" | "durationMs"> = {
    hook,
    stdout: "",
    stderr: "",
  };

  // Prompt-type hooks are LLM-evaluated, not spawned. The runner marks them
  // for the service's prompt evaluator; the command string is the template.
  if (hook.entry.type === "prompt") {
    return {
      ...base,
      exitCode: null,
      timedOut: false,
      decision: "allow",
      reason: "prompt-type hook — evaluated by the HookService prompt evaluator, not spawned",
      blocks: false,
      durationMs: Date.now() - startedAt,
    };
  }

  return new Promise<HookRunOutcome>((resolve) => {
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;

    const finish = (exitCode: number | null): void => {
      if (settled) {
        return;
      }
      settled = true;
      const durationMs = Date.now() - startedAt;
      const parsed = parseStdoutJson(stdout);
      const jsonDecision = parsed ? asDecision(parsed.decision) : undefined;
      const reason =
        asString(parsed?.reason) ??
        (stderr.trim().length > 0 ? stderr.trim().slice(0, 500) : undefined);

      let decision: HookDecision = jsonDecision ?? "allow";
      let blocks = false;
      let finalReason = reason;

      if (exitCode === 2) {
        // Exit code 2 = block/deny, always.
        decision = "deny";
        blocks = true;
        finalReason =
          reason ??
          `Hook "${hook.entry.command}" blocked this action (exit code 2) but provided no reason.`;
      } else if (exitCode !== 0) {
        // Any other non-zero (or signal/null from timeout/spawn failure):
        // fail-open unless failClosed.
        if (hook.entry.failClosed) {
          decision = "deny";
          blocks = true;
          finalReason =
            reason ??
            `Hook "${hook.entry.command}" failed (exit ${exitCode ?? "signal"}) and failClosed is set — action blocked.`;
        } else if (timedOut) {
          finalReason = reason ?? `Hook "${hook.entry.command}" timed out after ${hook.entry.timeout ?? DEFAULT_TIMEOUT_SEC}s — allowed (fail-open).`;
        }
      }

      // A JSON {"decision":"deny"} blocks even with exit 0 — the hook asked
      // for a deny explicitly. ("ask" only escalates; enforcement of deny
      // happens for blocking events in HookService.)
      if (decision === "deny" && !blocks) {
        blocks = true;
        finalReason = finalReason ?? `Hook "${hook.entry.command}" returned {"decision":"deny"}.`;
      }
      // Raw stdout always flows back so callers can append it to context.
      const contextStdout = stdout.length > MAX_CONTEXT_BYTES ? stdout.slice(0, MAX_CONTEXT_BYTES) + "\n…[truncated]" : stdout;

      resolve({
        ...base,
        exitCode,
        timedOut,
        decision,
        reason: finalReason,
        blocks,
        stdout: contextStdout,
        stderr: stderr.length > MAX_OUTPUT_BYTES ? stderr.slice(0, MAX_OUTPUT_BYTES) : stderr,
        durationMs,
        followupMessage: parsed ? asString(parsed.followup_message) : undefined,
        userMessage: parsed ? asString(parsed.user_message) : undefined,
        agentMessage: parsed ? asString(parsed.agent_message) : undefined,
        pluginPaths: parsed ? asStringArray(parsed.pluginPaths) : undefined,
      });
    };

    let child;
    try {
      child = spawn(hook.entry.command, {
        shell: true,
        cwd: opts.cwd,
        env,
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (err) {
      // Synchronous spawn failure (extremely rare) — fail-open unless failClosed.
      const failClosed = hook.entry.failClosed === true;
      resolve({
        ...base,
        exitCode: null,
        timedOut: false,
        decision: failClosed ? "deny" : "allow",
        reason: `Hook "${hook.entry.command}" could not start: ${err instanceof Error ? err.message : String(err)}`,
        blocks: failClosed,
        durationMs: Date.now() - startedAt,
      });
      return;
    }

    const timer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill("SIGKILL");
      } catch {
        /* already gone */
      }
    }, timeoutMs);
    // Don't let the timer keep the process alive on its own.
    if (typeof timer.unref === "function") {
      timer.unref();
    }

    child.stdout?.on("data", (d: Buffer) => {
      if (stdout.length < MAX_OUTPUT_BYTES) {
        stdout += d.toString("utf8");
      }
    });
    child.stderr?.on("data", (d: Buffer) => {
      if (stderr.length < MAX_OUTPUT_BYTES) {
        stderr += d.toString("utf8");
      }
    });
    child.on("error", () => {
      clearTimeout(timer);
      finish(null);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      finish(code);
    });

    try {
      // DEV-GAPS-34: a hook that exits without reading stdin (the canonical
      // `exit 2` guard script) raises async EPIPE on this stream — without
      // an 'error' listener that becomes an uncaught exception. Swallow it;
      // the close handler still finishes the outcome.
      child.stdin?.on("error", () => {});
      child.stdin?.write(buildHookInput(payload));
      child.stdin?.end();
    } catch {
      /* stdin broken — the close handler still finishes */
    }
  });
}
