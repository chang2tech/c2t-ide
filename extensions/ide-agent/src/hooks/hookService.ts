/**
 * hookService — HookService orchestrates the 21 verified Cursor hook events.
 *
 * Responsibilities:
 *  - load/refresh hooks.json from every source (hookLoader)
 *  - runHooks(event, extras): matcher filtering → sequential execution →
 *    decision merge (deny > ask > allow), user/agent message concat,
 *    followup last-wins, stdout → context additions, execution log
 *  - checkToolGate(action, resources, ctx): the blocking choke point used by
 *    the engine adapter's approval path (preToolUse + beforeShellExecution +
 *    beforeMCPExecution + beforeReadFile + subagentStart for task tools)
 *  - pending context additions drained by the composer into the next prompt
 *
 * No vscode import — the log sink, workspace roots and app version are
 * injected, so the whole service is unit-testable with node:test.
 */

import { randomUUID } from "crypto";
import { flattenHooks, loadAllHookSources } from "./hookLoader";
import { expandArguments, runHookProcess } from "./hookRunner";
import {
  ExecutionLogEntry,
  HookDecision,
  HookEventName,
  HookPayload,
  HookResult,
  isKnownEvent,
  LoadedHook,
  MATCHER_FIELDS,
  SourceLoadResult,
} from "./hookTypes";

/** Evaluates prompt-type hooks. Injected; the default skips honestly. */
export type PromptEvaluator = (
  prompt: string,
  model?: string,
) => Promise<{ ok: boolean; reason?: string }>;

export interface HookServiceOptions {
  workspaceRoots: string[];
  appVersion: string;
  /** Line sink for the execution log (e.g. an OutputChannel). */
  log: (line: string) => void;
  extraEnv?: Record<string, string>;
  promptEvaluator?: PromptEvaluator;
  userEmail?: string;
  transcriptPath?: string;
  conversationId?: string;
}

export interface ToolGateContext {
  sessionID?: string;
  /** Raw shell command text (for beforeShellExecution matcher). */
  command?: string;
}

export interface ToolGateResult {
  blocked: boolean;
  reason?: string;
  /** Follow-up context the hooks produced (appended to the turn). */
  contextAdditions: string[];
}

const DECISION_RANK: Record<HookDecision, number> = { allow: 1, ask: 2, deny: 3 };

/** Events whose deny decision can actually block something. */
const BLOCKING_EVENTS: ReadonlySet<HookEventName> = new Set([
  "preToolUse",
  "beforeShellExecution",
  "beforeMCPExecution",
  "beforeReadFile",
  "beforeSubmitPrompt",
  "subagentStart",
  // A deny from a stop/subagentStop hook blocks the stop itself — the turn
  // continues with the hook's followup_message (up to loop_limit).
  "stop",
  "subagentStop",
]);

function isShellAction(action: string): boolean {
  return /^(bash|shell|sh|zsh|fish|pwsh|powershell|cmd)(_|$)/i.test(action);
}

function isMcpAction(action: string): boolean {
  return action.startsWith("mcp__");
}

function parseMcpAction(action: string): { server: string; tool: string } | undefined {
  const m = /^mcp__([^_]+)__(.+)$/.exec(action);
  return m ? { server: m[1], tool: m[2] } : undefined;
}

export class HookService {
  private sources: SourceLoadResult[] = [];
  private hooks: LoadedHook[] = [];
  private configErrors: string[] = [];
  private readonly execLog: ExecutionLogEntry[] = [];
  /**
   * P2 (QA-CHATTABS-01): hook stdout is buffered PER SCOPE (one scope per
   * chat-tab composer), not in a single shared array. A shared buffer let
   * tab A's post-tool hook stdout leak into tab B's turn prompt when two
   * tabs ran turns concurrently. Composers pass their stable scope id to
   * runHooks()/checkToolGate() and drain only their own scope.
   * Each scope's buffer is capped so un-drained scopes can't grow forever.
   */
  private readonly pendingContext = new Map<string, string[]>();
  private static readonly MAX_CONTEXT_PER_SCOPE = 200;
  private readonly conversationId: string;
  private generationSeq = 0;

  constructor(private readonly opts: HookServiceOptions) {
    this.conversationId = opts.conversationId ?? randomUUID();
    this.refresh();
  }

  /** (Re)load all config sources. */
  refresh(): void {
    this.sources = loadAllHookSources(this.opts.workspaceRoots);
    const { hooks, errors } = flattenHooks(this.sources);
    this.hooks = hooks;
    this.configErrors = errors;
    if (errors.length > 0) {
      this.logLine(`hooks: ${errors.length} config problem(s):`);
      for (const e of errors) {
        this.logLine(`  ! ${e}`);
      }
    }
    this.logLine(
      `hooks: loaded ${hooks.length} hook(s) from ${this.sources.filter((s) => s.found).length} config file(s).`,
    );
  }

  getConfigErrors(): string[] {
    return [...this.configErrors];
  }

  getLoadedHookCount(): number {
    return this.hooks.length;
  }

  /** Fast path: skip runHooks entirely when nothing is configured. */
  hasHooks(event: HookEventName): boolean {
    return this.hooks.some((h) => h.event === event);
  }

  /**
   * Effective follow-up loop limit for `stop`/`subagentStop`: the max of the
   * entries' loop_limit (default 5); a null entry means unlimited.
   */
  getLoopLimit(event: HookEventName): number {
    const entries = this.hooks.filter((h) => h.event === event);
    if (entries.length === 0) {
      return 5;
    }
    let max = 5;
    for (const h of entries) {
      const l = h.entry.loop_limit;
      if (l === null) {
        return Infinity;
      }
      if (typeof l === "number" && l > max) {
        max = l;
      }
    }
    return max;
  }

  getExecutionLog(): ExecutionLogEntry[] {
    return [...this.execLog];
  }

  /**
   * Drain hook stdout accumulated for the agent's context.
   * P2 (QA-CHATTABS-01): scoped — each chat tab drains only its own
   * composer's scope, so hook output never crosses tabs.
   */
  drainContextAdditions(scope: string = ""): string[] {
    const buf = this.pendingContext.get(scope);
    if (!buf || buf.length === 0) {
      return [];
    }
    this.pendingContext.delete(scope);
    return buf;
  }

  /** Tag hook stdout with the caller's scope (per-tab isolation). */
  private appendContextAddition(scope: string, line: string): void {
    let buf = this.pendingContext.get(scope);
    if (!buf) {
      buf = [];
      this.pendingContext.set(scope, buf);
    }
    buf.push(line);
    if (buf.length > HookService.MAX_CONTEXT_PER_SCOPE) {
      buf.splice(0, buf.length - HookService.MAX_CONTEXT_PER_SCOPE);
    }
  }

  private logLine(line: string): void {
    try {
      this.opts.log(`[hooks] ${line}`);
    } catch {
      /* log sink must never break hook flow */
    }
  }

  private record(entry: Omit<ExecutionLogEntry, "at">): void {
    this.execLog.push({ ...entry, at: Date.now() });
    if (this.execLog.length > 500) {
      this.execLog.splice(0, this.execLog.length - 500);
    }
    const short = entry.command.length > 60 ? entry.command.slice(0, 60) + "…" : entry.command;
    this.logLine(
      `${entry.event} [${entry.source}] "${short}" → exit=${entry.exitCode ?? "n/a"}${entry.timedOut ? " TIMEOUT" : ""} decision=${entry.decision} ${entry.durationMs}ms${entry.note ? ` (${entry.note})` : ""}`,
    );
  }

  private buildPayload(event: HookEventName, extras: Record<string, unknown> = {}): HookPayload {
    return {
      conversation_id: this.conversationId,
      generation_id: `gen-${++this.generationSeq}`,
      hook_event_name: event,
      cursor_version: this.opts.appVersion,
      workspace_roots: this.opts.workspaceRoots,
      user_email: this.opts.userEmail,
      transcript_path: this.opts.transcriptPath,
      ...extras,
    };
  }

  private matches(entry: LoadedHook, payload: HookPayload): boolean {
    const matcher = entry.entry.matcher;
    if (!matcher) {
      return true;
    }
    const field = MATCHER_FIELDS[entry.event];
    const value = field ? payload[field] : undefined;
    if (typeof value !== "string") {
      return true; // no matcher field for this event — run it
    }
    try {
      return new RegExp(matcher).test(value);
    } catch {
      return true; // loader validates; be permissive on the impossible
    }
  }

  private async evaluatePromptHook(hook: LoadedHook, payload: HookPayload): Promise<{ ok: boolean; reason?: string; skipped: boolean }> {
    const evaluator = this.opts.promptEvaluator;
    if (!evaluator) {
      return {
        ok: true,
        skipped: true,
        reason: "prompt-type hook skipped: no LLM evaluator wired (HookServiceOptions.promptEvaluator)",
      };
    }
    const prompt = expandArguments(hook.entry.command, payload);
    try {
      const r = await evaluator(prompt, hook.entry.model);
      return { ok: r.ok, reason: r.reason, skipped: false };
    } catch (err) {
      return { ok: !hook.entry.failClosed, reason: `prompt evaluator failed: ${err instanceof Error ? err.message : String(err)}`, skipped: false };
    }
  }

  /**
   * Run all hooks registered for `event` whose matcher passes.
   * Sequential, in config merge order.
   *
   * P2 (QA-CHATTABS-01): `scope` tags any context additions this run
   * produces so each chat tab's composer only ever drains its own output.
   */
  async runHooks(event: HookEventName, extras: Record<string, unknown> = {}, scope: string = ""): Promise<HookResult> {
    if (!isKnownEvent(event)) {
      throw new Error(`HookService: unknown hook event "${event}" — refusing to invent events`);
    }
    const result: HookResult = {
      blocked: false,
      decision: "allow",
      userMessages: [],
      agentMessages: [],
      followupMessages: [],
      contextAdditions: [],
      pluginPaths: [],
      outcomes: [],
    };
    const candidates = this.hooks.filter((h) => h.event === event);
    if (candidates.length === 0) {
      return result;
    }
    const payload = this.buildPayload(event, extras);
    const blocking = BLOCKING_EVENTS.has(event);

    for (const hook of candidates) {
      if (!this.matches(hook, payload)) {
        continue;
      }
      if (hook.entry.type === "prompt") {
        const pr = await this.evaluatePromptHook(hook, payload);
        this.record({
          event,
          source: `${hook.source}:${hook.sourcePath}`,
          command: hook.entry.command,
          exitCode: null,
          timedOut: false,
          decision: pr.ok ? "allow" : "deny",
          durationMs: 0,
          note: pr.skipped ? pr.reason : `prompt-hook evaluated by LLM (ok=${pr.ok})`,
        });
        if (!pr.ok) {
          result.decision = "deny";
          if (blocking) {
            result.blocked = true;
            result.blockReason = pr.reason ?? `Prompt hook denied the action.`;
          }
        }
        continue;
      }
      const outcome = await runHookProcess(hook, payload, {
        cwd: this.opts.workspaceRoots[0] ?? process.cwd(),
        appVersion: this.opts.appVersion,
        extraEnv: this.opts.extraEnv,
      });
      result.outcomes.push(outcome);
      this.record({
        event,
        source: `${hook.source}:${hook.sourcePath}`,
        command: hook.entry.command,
        exitCode: outcome.exitCode,
        timedOut: outcome.timedOut,
        decision: outcome.decision,
        durationMs: outcome.durationMs,
        note: outcome.reason,
      });

      // Merge: deny > ask > allow.
      if (DECISION_RANK[outcome.decision] > DECISION_RANK[result.decision]) {
        result.decision = outcome.decision;
      }
      if (outcome.userMessage) {
        result.userMessages.push(outcome.userMessage);
      }
      if (outcome.agentMessage) {
        result.agentMessages.push(outcome.agentMessage);
      }
      // followup_message: last-wins.
      if (outcome.followupMessage) {
        result.followupMessages = [outcome.followupMessage];
      }
      if (outcome.pluginPaths) {
        result.pluginPaths.push(...outcome.pluginPaths);
      }
      // Raw stdout (non-JSON) flows into the agent's context.
      if (outcome.stdout.trim().length > 0 && !looksLikeJsonBlob(outcome.stdout)) {
        result.contextAdditions.push(outcome.stdout);
        this.appendContextAddition(scope, outcome.stdout);
      }
      // Enforcement only on blocking events.
      if (outcome.blocks) {
        if (blocking) {
          result.blocked = true;
          result.blockReason = outcome.reason;
        } else {
          this.logLine(`${event}: hook wanted to block, but "${event}" is not a blocking event — recorded only.`);
        }
      }
    }
    return result;
  }

  /**
   * The blocking choke point for tool execution, called from the engine
   * adapter's approval path BEFORE the approval card / auto-approve.
   * Fires preToolUse plus the specialized before* event for the tool kind.
   *
   * P2 (QA-CHATTABS-01): `scope` is threaded through so hook stdout lands in
   * the calling composer's buffer, not a shared one.
   */
  async checkToolGate(action: string, resources: string[], ctx: ToolGateContext = {}, scope: string = ""): Promise<ToolGateResult> {
    const mcp = parseMcpAction(action);
    const toolForMatcher = mcp ? `MCP:${mcp.tool}` : action;
    const baseExtras: Record<string, unknown> = {
      tool: toolForMatcher,
      action,
      resources,
      sessionID: ctx.sessionID,
    };
    const contextAdditions: string[] = [];

    // preToolUse always fires (matcher: tool type, incl. MCP:<tool>).
    const pre = await this.runHooks("preToolUse", baseExtras, scope);
    contextAdditions.push(...pre.contextAdditions);
    if (pre.blocked) {
      return { blocked: true, reason: pre.blockReason, contextAdditions };
    }

    // Specialized before* event for the tool kind.
    let specialized: HookResult | undefined;
    if (isShellAction(action)) {
      specialized = await this.runHooks("beforeShellExecution", {
        ...baseExtras,
        command: ctx.command ?? resources.join(" "),
      }, scope);
    } else if (mcp) {
      specialized = await this.runHooks("beforeMCPExecution", {
        ...baseExtras,
        mcpServer: mcp.server,
        mcpTool: mcp.tool,
      }, scope);
    } else if (action === "read") {
      specialized = await this.runHooks("beforeReadFile", {
        ...baseExtras,
        file: resources[0] ?? "",
      }, scope);
    } else if (action === "task") {
      // The engine's task tool dispatches subagents — this is the real
      // subagentStart trigger in this extension (no other subagent infra).
      specialized = await this.runHooks("subagentStart", {
        ...baseExtras,
        subagentType: resources[0] ?? "general",
      }, scope);
    }
    if (specialized) {
      contextAdditions.push(...specialized.contextAdditions);
      if (specialized.blocked) {
        return { blocked: true, reason: specialized.blockReason, contextAdditions };
      }
      // "ask" escalates: the caller must show the approval card instead of
      // auto-allowing. Surface it as a non-blocking signal.
      if (specialized.decision === "ask" || pre.decision === "ask") {
        contextAdditions.push("[hooks] a hook returned \"ask\" — escalate to user approval.");
      }
    } else if (pre.decision === "ask") {
      contextAdditions.push("[hooks] a hook returned \"ask\" — escalate to user approval.");
    }
    return { blocked: false, contextAdditions };
  }
}

/** True when stdout is exactly a JSON decision blob (not context text). */
function looksLikeJsonBlob(stdout: string): boolean {
  const t = stdout.trim();
  if (!t.startsWith("{") || !t.endsWith("}")) {
    return false;
  }
  try {
    const v = JSON.parse(t) as Record<string, unknown>;
    return (
      typeof v === "object" && v !== null &&
      ("decision" in v || "reason" in v || "followup_message" in v || "pluginPaths" in v)
    );
  } catch {
    return false;
  }
}
