/**
 * tui.ts — interactive terminal loop for the agent CLI.
 *
 * All engine/permission policy lives in cli.ts; this module owns only the
 * readline loop, the in-memory turn log (for /rewind and /context), and
 * Ctrl+C semantics:
 *   - Ctrl+C during a turn aborts the turn (a second Ctrl+C exits)
 *   - Ctrl+C on an idle prompt exits immediately
 *   - Ctrl+D exits
 *
 * Slash commands themselves live in slash.ts; this module builds the
 * SlashRuntime from TuiDeps and delegates to handleSlashCommand.
 */

import * as readline from "readline";
import {
  isReadOnlyAction,
  type PermissionDecision,
  type PermissionRequest,
} from "./engine";
import type { DiscoveredSkill } from "./skills";
import {
  handleSlashCommand,
  parseSlashCommand as parseSlash,
  type SlashCommand,
  type SlashRuntime,
  type TurnLogEntry,
} from "./slash";

export type AgentMode = "agent" | "plan" | "ask";

export type TurnEndKind = "succeeded" | "failed" | "interrupted";

export interface TurnResult {
  text: string;
  endKind: TurnEndKind;
  failure?: unknown;
}

export interface TurnRenderHooks {
  onTextDelta(delta: string): void;
  onToolCall(info: { id: string; name: string; status: string }): void;
  onNotice(msg: string): void;
}

/** Result of resolving one skill for /skill. */
export interface SkillAttachment {
  /** SKILL.md content, present when the skill resolved. */
  content?: string;
  /** Human-readable reason, present when it did not. */
  error?: string;
}

/**
 * Yes/no prompt with a countdown: resolves true only on an explicit
 * "y"/"yes" before the timeout, otherwise false (auto-reject). Used for
 * mode-switch approvals — user-typed /plan|/ask and agent-requested
 * mode switches — matching Cursor's 15-second auto-reject.
 */
export function timedConfirm(
  rl: readline.Interface,
  prompt: string,
  timeoutMs: number,
  err: NodeJS.WritableStream,
): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const done = (value: boolean): void => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        resolve(value);
      }
    };
    const secs = Math.max(1, Math.round(timeoutMs / 1000));
    const timer = setTimeout(() => {
      err.write(`\n(auto-rejected: no answer within ${secs}s)\n`);
      done(false);
    }, timeoutMs);
    // Never keep the process alive just for the countdown.
    (timer as unknown as { unref?: () => void }).unref?.();
    rl.question(`${prompt} [y/N] (auto-rejects in ${secs}s): `, (answer: string) => {
      const a = answer.trim().toLowerCase();
      done(a === "y" || a === "yes");
    });
  });
}

/** Timeout for mode-switch approvals (matches Cursor's 15s). */
export const MODE_SWITCH_TIMEOUT_MS = 15_000;

export interface TuiDeps {
  out: NodeJS.WritableStream;
  err: NodeJS.WritableStream;
  input?: NodeJS.ReadableStream;
  isTTY: boolean;
  initialPrompt?: string;
  getMode(): AgentMode;
  setMode(mode: AgentMode): Promise<void>;
  setModel(name: string): Promise<string | undefined>;
  statusLine(): string;
  /** Skills discovered for this working directory (for /skills and /skill). */
  listSkills(): Pick<DiscoveredSkill, "name" | "description">[];
  /** Resolve one skill by name; the caller attaches its content one-shot. */
  attachSkill(name: string): Promise<SkillAttachment>;
  /** Auto-approve policy (--force/--yolo, --approve-mcps, --auto-review, tool lists). undefined = needs a decision. */
  autoDecidePermission(req: PermissionRequest): Promise<PermissionDecision | undefined>;
  /**
   * Run one turn. `promptPermission` is the TUI's own terminal prompt
   * (it owns the readline instance, so the prompt must go through it).
   */
  runTurnWith(
    text: string,
    render: TurnRenderHooks,
    promptPermission: (req: PermissionRequest) => Promise<PermissionDecision>,
  ): Promise<TurnResult>;
  /**
   * Run one turn on a throwaway read-only session, then delete it.
   * The main session's history is never touched (backs /btw).
   */
  runReadOnlyTurn(
    text: string,
    render: TurnRenderHooks,
    promptPermission: (req: PermissionRequest) => Promise<PermissionDecision>,
  ): Promise<TurnResult>;
  abortTurn(): void;
  isTurnActive(): boolean;
  close(): void;
  /** Session id of the current mode's session, if one exists yet. */
  currentSessionID(): string | undefined;
  /** Branch the current session; attaches the new session to the current mode. */
  forkCurrentSession(): Promise<{ from: string; to: string }>;
  /**
   * Verify `id` against the engine and attach it to the current mode.
   * Throws when the engine no longer has the session.
   */
  attachSession(id: string): Promise<string>;
  /** Record the current session in the persistent registry. */
  detachCurrentSession(): Promise<{ id: string; title: string }>;
  /** Raw GET /api/config — used to probe for an MCP server list. */
  getEngineConfig(): Promise<unknown>;
  listModels(): Promise<import("./engine").EngineModelInfo[]>;
  /** Compact the current session via the engine (backs /summarize). Returns the session id. */
  compactCurrentSession(): Promise<string>;
  getAutoReview(): boolean;
  setAutoReview(on: boolean): void;
  getTrust(): boolean;
  setTrust(on: boolean): void;
}

/** Re-exported for compatibility (tests import it from here). */
export type { SlashCommand };
export { parseSlash as parseSlashCommand };

export async function startInteractiveTui(deps: TuiDeps): Promise<number> {
  const rl = readline.createInterface({
    input: deps.input ?? process.stdin,
    output: deps.out,
    prompt: "ide-code> ",
    terminal: true,
  });

  let turnActive = false;
  let sigintDuringTurn = false;
  let exiting = false;
  const turnLog: TurnLogEntry[] = [];
  /** Skill staged by /skill — prepended to the next main-session turn, one-shot. */
  let pendingSkill: { name: string; content: string } | undefined;

  const exit = (code: number): void => {
    if (exiting) {
      return;
    }
    exiting = true;
    rl.close();
    deps.close();
    process.exitCode = code;
  };

  rl.on("SIGINT", () => {
    if (turnActive) {
      if (sigintDuringTurn) {
        deps.err.write("\nInterrupted.\n");
        exit(130);
        return;
      }
      sigintDuringTurn = true;
      deps.abortTurn();
      deps.err.write("\n[turn aborted — press Ctrl+C again to exit]\n");
      return;
    }
    deps.out.write("\n");
    exit(0);
  });
  // Line queue: 'line' events can fire before the consumer loop starts
  // (e.g. piped stdin arriving during the initial turn), so buffer them
  // from the moment the interface is created.
  const lineQueue: string[] = [];
  let lineResolve: ((line: string | undefined) => void) | undefined;
  let rlClosed = false;
  rl.on("line", (line: string) => {
    if (lineResolve) {
      const r = lineResolve;
      lineResolve = undefined;
      r(line);
    } else {
      lineQueue.push(line);
    }
  });

  rl.on("close", () => {
    rlClosed = true;
    if (lineResolve) {
      const r = lineResolve;
      lineResolve = undefined;
      r(undefined);
    }
    // EOF: never cut off lines that already arrived or a turn that is still
    // running — the main loop drains the queue first and then observes
    // rlClosed. Exiting here is only safe when there is nothing left to do.
    if (lineQueue.length === 0 && !turnActive) {
      exit(0);
    }
  });

  async function nextLine(): Promise<string | undefined> {
    if (lineQueue.length > 0) {
      return lineQueue.shift();
    }
    if (rlClosed) {
      return undefined;
    }
    return new Promise((resolve) => {
      lineResolve = resolve;
    });
  }

  const render: TurnRenderHooks = {
    onTextDelta: (delta) => deps.out.write(delta),
    onToolCall: (info) =>
      deps.err.write(`\n[tool ${info.name} — ${info.status}]\n`),
    onNotice: (msg) => deps.err.write(`${msg}\n`),
  };

  async function runOneTurn(text: string): Promise<void> {
    turnActive = true;
    sigintDuringTurn = false;
    let toolCalls = 0;
    const countingRender: TurnRenderHooks = {
      ...render,
      onToolCall: (info) => {
        toolCalls += 1;
        render.onToolCall(info);
      },
    };
    // A skill staged via /skill is attached one-shot to this turn only.
    let effectiveText = text;
    if (pendingSkill) {
      const { name, content } = pendingSkill;
      pendingSkill = undefined;
      const safeName = name.replace(/"/g, "&quot;");
      effectiveText = `<skill name="${safeName}">\n${content}\n</skill>\n\n${text}`;
      deps.err.write(`[skill "${name}" attached to this turn]\n`);
    }
    try {
      const result = await deps.runTurnWith(effectiveText, countingRender, (req) =>
        promptPermissionOnRl(rl, req),
      );
      turnLog.push({
        n: turnLog.length + 1,
        promptPreview: text.slice(0, 120),
        at: Date.now(),
        endKind: result.endKind,
        toolCalls,
      });
      deps.out.write("\n");
      if (result.endKind === "failed") {
        const msg =
          result.failure instanceof Error
            ? result.failure.message
            : typeof result.failure === "string"
              ? result.failure
              : "turn failed";
        deps.err.write(`error: turn failed: ${msg}\n`);
      } else if (result.endKind === "interrupted") {
        deps.err.write("error: turn interrupted\n");
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      deps.err.write(`error: ${msg}\n`);
    } finally {
      turnActive = false;
    }
  }

  const runtime: SlashRuntime = {
    out: deps.out,
    err: deps.err,
    getMode: deps.getMode,
    setMode: deps.setMode,
    setModel: deps.setModel,
    statusLine: deps.statusLine,
    autoDecidePermission: deps.autoDecidePermission,
    promptPermission: (req) => promptPermissionOnRl(rl, req),
    runTurnWith: deps.runTurnWith,
    runReadOnlyTurn: deps.runReadOnlyTurn,
    withTurnActive: async (fn) => {
      turnActive = true;
      sigintDuringTurn = false;
      try {
        return await fn();
      } finally {
        turnActive = false;
      }
    },
    currentSessionID: deps.currentSessionID,
    forkCurrentSession: deps.forkCurrentSession,
    attachSession: deps.attachSession,
    detachCurrentSession: deps.detachCurrentSession,
    getEngineConfig: deps.getEngineConfig,
    listModels: deps.listModels,
    compactCurrentSession: deps.compactCurrentSession,
    getAutoReview: deps.getAutoReview,
    setAutoReview: deps.setAutoReview,
    getTrust: deps.getTrust,
    setTrust: deps.setTrust,
    listSkills: deps.listSkills,
    attachSkill: deps.attachSkill,
    setPendingSkill: (name, content) => {
      pendingSkill = { name, content };
    },
    getTurnLog: () => turnLog,
    confirmModeSwitch: async (mode) =>
      timedConfirm(rl, `switch to ${mode} mode?`, MODE_SWITCH_TIMEOUT_MS, deps.err),
  };

  async function handleSlash(sc: SlashCommand): Promise<void> {
    const action = await handleSlashCommand(sc, runtime);
    if (action === "exit") {
      exit(0);
    }
  }

  /**
   * Full permission decision for the TUI: auto-approve flags first, then a
   * prompt on the loop's own readline when it is a TTY, then the non-TTY
   * fail-safe (deny mutating actions, approve read-only ones).
   */
  async function promptPermissionOnRl(
    promptRl: readline.Interface,
    req: PermissionRequest,
  ): Promise<PermissionDecision> {
    const auto = await deps.autoDecidePermission(req);
    if (auto) {
      return auto;
    }
    // Agent-requested mode switches get a 15-second countdown and
    // auto-reject when left unattended, matching Cursor ("Timed
    // mode-switch approvals"). Explicit auto-approve flags above still win.
    if (req.action.toLowerCase() === "switchmode" && deps.isTTY && !rlClosed) {
      const target = req.message ?? req.action;
      deps.err.write(`\nThe agent requests a mode switch — ${target}\n`);
      const ok = await timedConfirm(promptRl, "approve the mode switch?", MODE_SWITCH_TIMEOUT_MS, deps.err);
      return ok ? "once" : "reject";
    }
    if (!deps.isTTY || rlClosed) {
      return isReadOnlyAction(req.action) ? "once" : "reject";
    }
    const target =
      req.message ?? [req.action, ...req.resources].filter(Boolean).join(" ");
    deps.err.write(`\nPermission requested — ${target}\n`);
    return new Promise((resolve) => {
      const ask = () => {
        promptRl.question("[y]es / [n]o / [a]lways: ", (answer: string) => {
          const a = answer.trim().toLowerCase();
          if (a === "y" || a === "yes") {
            resolve("once");
          } else if (a === "n" || a === "no") {
            resolve("reject");
          } else if (a === "a" || a === "always") {
            resolve("always");
          } else {
            ask();
          }
        });
      };
      ask();
    });
  }

  if (deps.initialPrompt && deps.initialPrompt.length > 0) {
    await runOneTurn(deps.initialPrompt);
    if (exiting) {
      return Number(process.exitCode ?? 0);
    }
  }

  for (;;) {
    if (!rlClosed) {
      rl.prompt();
    }
    const line = await nextLine();
    if (line === undefined) {
      break;
    }
    const sc = parseSlash(line);
    if (sc) {
      await handleSlash(sc);
    } else if (line.trim().length > 0) {
      await runOneTurn(line.trim());
    }
    if (exiting) {
      break;
    }
  }
  return Number(process.exitCode ?? 0);
}
