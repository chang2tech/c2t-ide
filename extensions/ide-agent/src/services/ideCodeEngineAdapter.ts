import * as vscode from "vscode";
import * as fs from "fs";
import * as childProcess from "child_process";
import * as crypto from "crypto";
import * as http from "http";
import * as net from "net";
import * as path from "path";
import { EngineAdapter, EngineModelInfo, ModelRef, TurnContext } from "./agentService";
import { ApprovalResult } from "./humanReviewService";
import { ModeName, ToolCallViewModel, TurnEvent, ClarifyingQuestion } from "../model";
import { isMutatingToolAction, isReadOnlyMode, sessionPermissionsForMode } from "./modeService";
import { parseSse, SseEvent } from "./sseParser";
import { HookService } from "../hooks/hookService";

/**
 * IdeCodeEngineAdapter — the REAL engine adapter.
 *
 * Spawns the ide-code (OpenCode-derived) server as a sidecar process and
 * translates its HTTP/SSE wire protocol into TurnEvents for the chat UI:
 *
 *   spawn:  bun <enginePath>/packages/cli/src/index.ts serve --port <free> --hostname 127.0.0.1
 *   wire:   POST /api/session            → create/reuse session
 *           POST /api/session/:id/prompt → send user turn { text }
 *           GET  /api/event              → SSE stream of session/message/permission events
 *           POST /api/session/:id/permission/:reqID/reply → approval decisions
 *
 * Event → TurnEvent mapping:
 *   message.part.delta (text)            → textDelta
 *   message.part.updated (reasoning)     → thinking
 *   message.part.updated (tool/pending)  → toolCall (new card)
 *   message.part.updated (tool/running)  → toolCallDelta {status: running}
 *   message.part.updated (tool/completed)→ toolCallDelta {status: done, outputPreview}
 *   message.part.updated (tool/error)    → toolCallDelta {status: failed}
 *   permission.asked                     → humanReviewService → permission.reply
 *   session.execution.succeeded|failed   → done
 *   session.error                        → textDelta(error) + done
 */
export interface IdeCodeEngineOptions {
  enginePath: string;
  output: vscode.OutputChannel;
  requestApproval: (
    toolCallId: string,
    title: string,
    reasons: string[],
    /** P1 (QA-CHATTABS-01): stable allowlist identity (action+resources). */
    allowlistIdentity?: string,
  ) => Promise<ApprovalResult>;
  /**
   * P2 (QA-FILE-04): current chat mode, used by the read-only gate in
   * handleApproval. Optional so tests/callers without a mode service keep
   * working (no gate when absent).
   */
  getMode?: () => ModeName;
  /**
   * DEV-HOOKS: Cursor-style agent hooks. The approval path is the blocking
   * choke point: preToolUse + beforeShellExecution/beforeMCPExecution/
   * beforeReadFile run before the approval card; exit code 2 auto-rejects.
   * Optional — the adapter works without it.
   */
  hooks?: HookService;
  /**
   * P2-5 (QA-CHATTABS-01): the owning composer's hook scope — hook stdout
   * produced through this adapter is buffered per tab, never shared.
   */
  hookScope?: string;
}

/** Engine tool id → Cursor-style tool_call name for the UI cards. */
const TOOL_NAME_MAP: Record<string, string> = {
  read: "read_tool_call",
  edit: "edit_tool_call",
  write: "edit_tool_call",
  bash: "shell_tool_call",
  glob: "glob_tool_call",
  grep: "grep_tool_call",
  list: "ls_tool_call",
  todowrite: "update_todos_tool_call",
  todoread: "read_todos_tool_call",
  webfetch: "fetch_tool_call",
  websearch: "web_search_tool_call",
  task: "task_tool_call",
  patch: "apply_agent_diff_tool_call",
  question: "ask_question_tool_call",
};

function toCursorToolName(engineTool: string): string {
  if (engineTool.startsWith("mcp__")) return "mcp_tool_call";
  return TOOL_NAME_MAP[engineTool] ?? `${engineTool}_tool_call`;
}

/**
 * Parse a Cursor-style MCP tool action (mcp__<server>__<tool>).
 * Mirrors the core's McpNames.parseToolName.
 */
function parseMcpAction(action: string): { server: string; tool: string } | undefined {
  if (!action.startsWith("mcp__")) return undefined;
  const parts = action.split("__");
  if (parts.length < 3 || !parts[1]) return undefined;
  return { server: parts[1], tool: parts.slice(2).join("__") };
}

/** Approval-card title: MCP tools render as "MCP: <tool> (<server>)" (Cursor parity). */
function approvalTitle(action: string, resources: string[]): string {
  const mcp = parseMcpAction(action);
  if (mcp) return `MCP: ${mcp.tool} (${mcp.server})`;
  return `${action}${resources.length > 0 ? ` ${resources[0]}` : ""}`;
}

// NOTE: SseEvent + parseSse live in ./sseParser.ts (vscode-free, unit-tested).
// The real engine emits frames as `data: ${JSON.stringify({id,type,data})}`
// with NO `event:` line — the old local parser required `event:` and dropped
// 100% of real server events (QA-FILE-03 P0).

// P2 (QA-04): per-process counter so synthetic toolCallIds can never collide
// within the same millisecond.
let toolCallSeq = 0;

/** HTTP error with the status code attached, so callers can branch on 404 etc. */
export interface HttpStatusError extends Error {
  statusCode: number;
}

function httpError(method: string, pathStr: string, statusCode: number, body: string): HttpStatusError {
  const err = new Error(`${method} ${pathStr} → ${statusCode}: ${body}`) as HttpStatusError;
  err.statusCode = statusCode;
  return err;
}

/**
 * Extract the HTTP status code from an api() rejection, if present.
 * Pure; unit-tested.
 */
export function httpStatusCode(err: unknown): number | undefined {
  if (typeof err === "object" && err !== null && "statusCode" in err) {
    const code = (err as { statusCode: unknown }).statusCode;
    return typeof code === "number" ? code : undefined;
  }
  return undefined;
}

/**
 * Pull the session id out of a session-scoped API path
 * ("/api/session/<id>/...") — undefined for anything else.
 * Pure; unit-tested.
 */
export function sessionIdFromApiPath(pathStr: string): string | undefined {
  const m = /^\/api\/session\/([^/]+)\//.exec(pathStr);
  return m ? m[1] : undefined;
}

export class IdeCodeEngineAdapter implements EngineAdapter {
  private serverProc?: childProcess.ChildProcess;
  private port = 0;
  /** P1 (QA-03): random bearer token for sidecar auth; set at spawn. */
  private authToken?: string;
  private sessions = new Map<string, string>(); // mode → sessionID
  private sseAbort?: AbortController;
  private readonly pendingApprovals = new Map<string, string>(); // requestID → toolCallId
  /**
   * M-03 (model picker): explicit model selection from the picker, or
   * undefined = "auto" (engine default). Passed to session.create for new
   * sessions; existing sessions are switched via POST /api/session/:id/model.
   */
  private selectedModel?: ModelRef;
  private starting: Promise<void> | undefined;
  /**
   * P2 (QA-CHATTABS Round B, R1): set when dispose() runs. ensureServer()
   * refuses to spawn a new sidecar for a dead tab — without this, a submit
   * whose beforeSubmitPrompt hooks resolved after closeTab disposed the
   * composer would respawn the bun process the P1-2 fix had just killed
   * (the leak returned through the back door).
   */
  private disposed = false;
  /**
   * P2 (XQA-03): approval serialization chain. `permission.asked` events are
   * consumed fire-and-forget, so two concurrent events used to orphan the
   * first approval card (HumanReviewService.current was overwritten and the
   * first promise hung until dispose/watchdog). Approvals now run strictly
   * one at a time; the chain can never break on a task failure.
   */
  private approvalChain: Promise<void> = Promise.resolve();

  /** Enqueue an approval task behind any in-flight approval. */
  private enqueueApproval(task: () => Promise<void>): void {
    const run = () =>
      task().catch((err) => {
        this.opts.output.appendLine(
          `[ide-agent] approval task failed: ${err instanceof Error ? err.message : err}`,
        );
      });
    this.approvalChain = this.approvalChain.then(run, run);
  }

  constructor(private readonly opts: IdeCodeEngineOptions) {}

  async *runTurn(ctx: TurnContext): AsyncIterable<TurnEvent> {
    // P0: turn-level watchdog — a hung SSE/engine can never wedge the chat forever.
    // P3 (XQA-03): a single timer drives both the boolean (post-loop error
    // message) and the promise (breaks mergeStreams). It is cleared in the
    // finally block, so no dangling 10-min timer survives a finished turn.
    const TURN_TIMEOUT_MS = 10 * 60 * 1000;
    let timedOut = false;
    let watchdogId: ReturnType<typeof setTimeout> | undefined;
    const timeoutPromise = new Promise<{ timedOut: true }>((resolve) => {
      watchdogId = setTimeout(() => {
        timedOut = true;
        resolve({ timedOut: true });
      }, TURN_TIMEOUT_MS);
    });

    this.turnActive = true;
    // P1 (QA-FILE-01): fresh abort state per turn — abortTurn() sets the flag
    // + resolves abortResolve, finally clears both.
    this.turnAbortRequested = false;
    let resolveAbort: () => void = () => {};
    const abortPromise = new Promise<void>((resolve) => {
      resolveAbort = resolve;
    });
    this.abortResolve = resolveAbort;
    let turnEnd: { done: Promise<void>; cancel: () => void; getFailure: () => unknown } | undefined;
    try {
      await this.ensureServer();
      let sessionID = await this.ensureSession(ctx.mode);
      yield { type: "thinking", bubbleId: ctx.bubbleId, text: "Connecting to ide-code engine…", durationMs: 0 };

      // Start the SSE consumer (shared across turns; resolves per-turn via execution events).
      turnEnd = this.waitForTurnEnd(sessionID);
      let turnDone = turnEnd.done;
      let stream = this.consumeEvents(sessionID, ctx);

      // Send the prompt.
      // P2 (CX4b): the engine may have dropped our session (internal restart /
      // session TTL) — the cached id then 404s. api() already invalidated the
      // stale cache entry, so retry once on a fresh session before failing the
      // turn. Only 404 is retried; anything else (auth, timeout, 500) throws
      // immediately.
      const postPrompt = () =>
        this.api(`POST`, `/api/session/${sessionID}/prompt`, {
          text: ctx.prompt,
          // Browser-tab screenshots: the engine's PromptInput.files accepts
          // {uri, name, description} — the engine reads the PNG as an image
          // part, so the agent literally sees the screenshot.
          ...(ctx.attachments && ctx.attachments.length > 0 ? { files: ctx.attachments } : {}),
          // P1 (QA-PLANMODE Round B, P1-2(b) CORRECTION): the engine's
          // PromptInput.Prompt schema is {text, files, agents, skills} —
          // there is no per-prompt mode/readonly wire field, but the
          // SESSION already carries enforcement: ensureSession passes a
          // deny `permissions` ruleset at session.create for plan/ask
          // modes (session.create natively accepts
          // `permissions: Permission.Ruleset`), and the engine's
          // Permission.evaluate/denied hard-blocks mutating tools with
          // no approval card. The extension-side gate in handleApproval
          // (turn-mode based) remains as a second, belt-and-braces layer
          // for permission.asked flows the ruleset deliberately leaves
          // open (effect "ask").
        });
      try {
        await postPrompt();
      } catch (err) {
        if (httpStatusCode(err) !== 404) {
          throw err;
        }
        this.opts.output.appendLine(
          `[ide-agent] session ${sessionID} gone (404) — retrying the prompt on a fresh session`,
        );
        // Rebind the per-turn listeners to the new session id. waitForTurnEnd's
        // listener was attached synchronously (cancel removes it); the
        // consumeEvents generator body hasn't started yet (iteration begins in
        // mergeStreams below), so its listener was never attached — re-create
        // it for symmetry.
        turnEnd.cancel();
        // P1 (QA-FILE-01): consumeEvents is declared AsyncIterable, but the
        // value is always an AsyncGenerator — cast for the .return() unwind.
        await (stream as unknown as AsyncGenerator<TurnEvent>).return?.(undefined);
        sessionID = await this.ensureSession(ctx.mode);
        turnEnd = this.waitForTurnEnd(sessionID);
        turnDone = turnEnd.done;
        stream = this.consumeEvents(sessionID, ctx);
        await postPrompt();
      }

      // Yield mapped events until the turn completes, times out, or is aborted.
      for await (const event of this.mergeStreams(stream, turnDone, timeoutPromise, abortPromise)) {
        // P1 (QA-FILE-01): Stop pressed — drop out promptly; the abort promise
        // in mergeStreams' race guarantees this loop terminates even with no
        // further engine events.
        if (this.turnAbortRequested) {
          break;
        }
        yield event;
      }

      // P1 (QA-04-VERIFY): this check used to sit inside the loop body, where
      // it was unreachable on the timeout path — mergeStreams breaks its
      // iterator when the timeout fires, so the loop body never re-runs and
      // the turn ended silently. Checking after the loop makes the error visible.
      if (timedOut) {
        yield {
          type: "textDelta",
          bubbleId: ctx.bubbleId,
          delta: "\n\n**Engine error:** turn timed out after 10 minutes with no response.",
        };
      } else if (!this.turnAbortRequested) {
        // QA-FILE-03 follow-up: a failed execution used to end the turn
        // silently. Show the engine's own error instead.
        const failure = turnEnd?.getFailure();
        if (failure !== undefined) {
          const raw = (failure as { message?: unknown })?.message ?? failure;
          const msg = typeof raw === "string" ? raw : JSON.stringify(raw);
          yield {
            type: "textDelta",
            bubbleId: ctx.bubbleId,
            delta: `\n\n**Engine error:** ${msg}`,
          };
        }
      }

      // P2 (QA-04): use a per-turn synthetic server id, NOT the sessionID.
      // The engine wire provides no per-message id; reusing the session id
      // would make every turn's bubble overwrite the same serverToClient index.
      yield {
        type: "reconcile",
        clientBubbleId: ctx.bubbleId,
        serverBubbleId: `srv-${sessionID}-${(toolCallSeq++).toString(36)}`,
      };
      yield { type: "done" };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // P1 (QA-FILE-01): a user-initiated stop must NOT surface as an
      // "Engine error" — the composer appends "Turn stopped by user" itself.
      if (!this.turnAbortRequested) {
        yield { type: "textDelta", bubbleId: ctx.bubbleId, delta: `\n\n**Engine error:** ${message}` };
      }
      yield { type: "done" };
    } finally {
      // P3 (XQA-03): clear the single watchdog timer — no dangling timer.
      if (watchdogId !== undefined) {
        clearTimeout(watchdogId);
        watchdogId = undefined;
      }
      this.turnActive = false;
      // P1 (QA-FILE-01): clear abort state so the next turn starts clean.
      this.turnAbortRequested = false;
      this.abortResolve = undefined;
      // P2 (QA-04): remove the turn-end listener if the turn finished by
      // timeout rather than an SSE execution event.
      turnEnd?.cancel();
      if (this.sseReconnectTimer) {
        clearTimeout(this.sseReconnectTimer);
        this.sseReconnectTimer = undefined;
      }
    }
  }

  /** Spawn the sidecar server on a free loopback port; wait for readiness. */
  private ensureServer(): Promise<void> {
    // P2 (QA-CHATTABS Round B, R1): never spawn for a disposed tab.
    if (this.disposed) {
      return Promise.reject(new Error("engine disposed — refusing to spawn a sidecar for a dead tab"));
    }
    if (this.port) {
      return Promise.resolve();
    }
    if (!this.starting) {
      this.starting = this.startServer();
    }
    return this.starting;
  }

  private async startServer(): Promise<void> {
    const enginePath = this.opts.enginePath;
    // P0 (QA-03): validate enginePath before spawning — must exist and contain
    // the expected engine entry point. Defense in depth alongside machine-scoped config.
    const entry = path.join(enginePath, "packages", "cli", "src", "index.ts");
    if (!fs.existsSync(entry)) {
      throw new Error(
        `[ide-agent] Invalid enginePath: ${enginePath} does not contain packages/cli/src/index.ts. ` +
        `Check the ide.agent.enginePath setting (machine scope).`
      );
    }
    this.port = await freePort();

    // P1 (QA-03): generate a random token; the sidecar requires it via
    // OPENCODE_PASSWORD (HTTP Basic auth, username "opencode").
    this.authToken = crypto.randomBytes(32).toString("hex");
    this.opts.output.appendLine(`[ide-agent] starting engine: bun ${entry} serve --port ${this.port}`);
    this.serverProc = childProcess.spawn("bun", [entry, "serve", "--port", String(this.port), "--hostname", "127.0.0.1"], {
      cwd: enginePath,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, NO_COLOR: "1", OPENCODE_PASSWORD: this.authToken },
    });
    this.serverProc.stdout?.on("data", (d: Buffer) => this.opts.output.append(`[engine] ${d.toString()}`));
    this.serverProc.stderr?.on("data", (d: Buffer) => this.opts.output.append(`[engine:err] ${d.toString()}`));
    this.serverProc.on("exit", (code) => {
      this.opts.output.appendLine(`[ide-agent] engine exited (code ${code}); will respawn on next turn`);
      // P2 (QA-FILE-03): the sidecar dying mid-turn used to leave the turn
      // hanging until the 10-min watchdog — the SSE drop alone never wakes
      // consumeEvents (its notify only fires on parsed events). Push a visible
      // error AND synthesize session.execution.failed for every live session
      // so waitForTurnEnd resolves and the turn ends promptly with the error
      // shown (mergeStreams' drain flushes the queued error before exiting).
      const wasActive = this.turnActive;
      const liveSessions = [...this.sessions.values()];
      this.port = 0;
      this.authToken = undefined;
      this.starting = undefined;
      this.sessions.clear();
      if (wasActive) {
        this.turnFail?.(`engine exited unexpectedly (code ${code})`);
        for (const sid of liveSessions) {
          for (const fn of [...this.listeners]) {
            try {
              fn({ type: "session.execution.failed", data: { sessionID: sid } });
            } catch {
              /* listener errors must not kill the exit handler */
            }
          }
        }
      }
    });

    // Wait for readiness: poll /api/config until 200 (30s cap).
    const deadline = Date.now() + 30_000;
    for (;;) {
      try {
        await this.api("GET", "/api/config");
        this.opts.output.appendLine(`[ide-agent] engine ready on 127.0.0.1:${this.port}`);
        return;
      } catch {
        if (Date.now() > deadline) {
          // P0 fix: reset all spawn state so the next turn retries cleanly
          // instead of trusting a dead port forever.
          this.serverProc?.kill("SIGKILL");
          this.serverProc = undefined;
          this.port = 0;
          this.authToken = undefined;
          this.starting = undefined;
          this.sessions.clear();
          throw new Error("ide-code engine did not become ready within 30s — check the IDE Agent output channel");
        }
        await sleep(400);
      }
    }
  }

  private async ensureSession(mode: ModeName): Promise<string> {
    const cached = this.sessions.get(mode);
    if (cached) {
      return cached;
    }
    // M-03: pass the picker's explicit model selection at creation so the
    // first turn of a new session already runs on the chosen model. Omitted
    // when the selection is "auto" (engine default).
    // P1 (QA-PLANMODE Round B, P1-2(b)): read-only modes (plan/ask) pass a
    // session-level deny ruleset here. session.create natively accepts
    // `permissions: Permission.Ruleset` (protocol/src/groups/session.ts),
    // so this is pure extension-lane: the engine enforces it via
    // Permission.evaluate (findLast — session rules override agent rules)
    // and denied() raises BlockedError with NO Permission.Event.Asked,
    // i.e. mutating tools are hard-blocked with no approval card. This is
    // also the durable fix for the MCP mutating-tool residual bypass:
    // mcp__* is deny-by-default at the engine layer, with a read-only
    // allowlist. Agent mode (and other non-read-only modes) send no
    // permissions — behavior unchanged.
    const permissions = sessionPermissionsForMode(mode);
    const res = await this.api("POST", "/api/session", {
      title: `IDE Agent (${mode})`,
      ...(this.selectedModel ? { model: toWireModelRef(this.selectedModel) } : {}),
      ...(permissions ? { permissions } : {}),
    });
    const sessionID = res.data.id as string;
    // P2 (QA-FILE-03): a missing/non-string id would put "undefined" in every
    // URL, and waitForTurnEnd(undefined) would then match ANY event with no
    // sessionID — cross-session turn-end confusion. Fail fast instead.
    if (typeof sessionID !== "string" || sessionID.length === 0) {
      throw new Error(
        `[ide-agent] engine returned an invalid session id: ${JSON.stringify(res.data).slice(0, 200)}`,
      );
    }
    this.sessions.set(mode, sessionID);
    this.opts.output.appendLine(`[ide-agent] session ${sessionID} (mode ${mode})`);
    // DEV-HOOKS: sessionStart (informational, fire-and-forget).
    if (this.opts.hooks?.hasHooks("sessionStart")) {
      void this.opts.hooks.runHooks("sessionStart", { sessionID, mode }, this.opts.hookScope ?? "").catch(() => {});
    }
    return sessionID;
  }

  /**
   * P2 (CX4b): drop a cached session id the engine has 404'd (internal
   * restart / session TTL). The next ensureSession() creates a fresh one, so
   * one dead session can't fail every subsequent turn until reload.
   */
  private invalidateSession(sessionID: string): void {
    for (const [mode, id] of this.sessions) {
      if (id === sessionID) {
        this.sessions.delete(mode);
        this.opts.output.appendLine(`[ide-agent] dropped stale session ${sessionID} (mode ${mode})`);
      }
    }
  }

  /**
   * M-03 (model picker): list the engine's model catalog.
   * GET /api/model → { data: Model.Info[], location } (Location.response).
   */
  async listModels(): Promise<EngineModelInfo[]> {
    await this.ensureServer();
    const res = await this.api("GET", "/api/model");
    const raw = Array.isArray(res) ? res : Array.isArray(res?.data) ? res.data : [];
    return raw
      .filter((m: any): m is Record<string, unknown> => {
        const r = m as Record<string, unknown>;
        return !!r && typeof r.id === "string" && typeof r.providerID === "string";
      })
      .map((m: Record<string, unknown>) => {
        const id = String(m.id);
        const providerID = String(m.providerID);
        const name = typeof m.name === "string" && m.name.trim().length > 0 ? m.name : id;
        const variant = typeof m.variant === "string" && m.variant.length > 0 ? m.variant : undefined;
        return { id, providerID, name, ...(variant ? { variant } : {}) };
      });
  }

  /**
   * M-03 (model picker): the engine's default model — "the model used when a
   * session has no explicit model selection" (protocol: model.default).
   */
  async getDefaultModel(): Promise<EngineModelInfo | undefined> {
    await this.ensureServer();
    const res = await this.api("GET", "/api/model/default");
    const m = res?.data as Record<string, unknown> | undefined;
    if (!m || typeof m.id !== "string" || typeof m.providerID !== "string") {
      return undefined;
    }
    const id = String(m.id);
    const providerID = String(m.providerID);
    const name = typeof m.name === "string" && m.name.trim().length > 0 ? m.name : id;
    return { id, providerID, name };
  }

  /**
   * M-03 (model picker): switch the model for every live engine session via
   * POST /api/session/:sessionID/model, and record the selection so future
   * sessions are created with it. `ref` undefined = "auto": future sessions
   * are created without an explicit model (engine default); live sessions are
   * switched to the engine default when one is known, otherwise left alone
   * (the wire has no "unset model" — only explicit Model.Ref switches).
   */
  async setModel(ref: ModelRef | undefined): Promise<void> {
    let effective = ref;
    if (!effective) {
      try {
        const def = await this.getDefaultModel();
        effective = def ? { id: def.id, providerID: def.providerID, variant: def.variant } : undefined;
      } catch (err) {
        // Best effort: a failed default lookup must not block the "auto"
        // selection itself (future sessions still get the engine default).
        this.opts.output.appendLine(
          `[ide-agent] model.default lookup failed: ${err instanceof Error ? err.message : err}`,
        );
      }
    }
    this.selectedModel = ref;
    const failures: string[] = [];
    for (const sessionID of this.sessions.values()) {
      if (!effective) {
        continue;
      }
      try {
        await this.api("POST", `/api/session/${encodeURIComponent(sessionID)}/model`, {
          model: toWireModelRef(effective),
        });
        this.opts.output.appendLine(`[ide-agent] session ${sessionID} model → ${effective.providerID}/${effective.id}`);
      } catch (err) {
        failures.push(`${sessionID}: ${err instanceof Error ? err.message : err}`);
      }
    }
    if (failures.length > 0) {
      throw new Error(`model switch failed for ${failures.length} session(s): ${failures.join("; ")}`);
    }
    this.opts.output.appendLine(
      `[ide-agent] model selection: ${ref ? `${ref.providerID}/${ref.id}` : "auto (engine default)"}`,
    );
  }

  /**
   * Resolves when this session's execution ends (succeeded/failed/interrupted).
   * Returns a cancel function — call it if the turn ends by timeout instead of
   * an SSE event, otherwise the listener leaks (P2 QA-04).
   * getFailure() returns the engine's error payload when the turn failed, so
   * runTurn can show WHY instead of ending silently (QA-FILE-03 follow-up).
   */
  private waitForTurnEnd(sessionID: string): {
    done: Promise<void>;
    cancel: () => void;
    getFailure: () => unknown;
  } {
    let check: ((ev: SseEvent) => void) | undefined;
    let failure: unknown;
    const done = new Promise<void>((resolve) => {
      check = (ev: SseEvent) => {
        if (
          ev.data?.sessionID === sessionID &&
          (ev.type === "session.execution.succeeded" ||
            ev.type === "session.execution.failed" ||
            ev.type === "session.execution.interrupted")
        ) {
          if (ev.type === "session.execution.failed") {
            failure = ev.data?.error;
          }
          if (check) {
            this.removeListener(check);
          }
          resolve();
        }
      };
      this.addListener(check);
    });
    return {
      done,
      cancel: () => {
        if (check) {
          this.removeListener(check);
          check = undefined;
        }
      },
      getFailure: () => failure,
    };
  }

  // ---- SSE plumbing -------------------------------------------------------

  private listeners = new Set<(ev: SseEvent) => void>();
  private addListener(fn: (ev: SseEvent) => void): void {
    this.listeners.add(fn);
    // P2 (QA-04): ensureSse is async — a synchronous throw (e.g. aborted
    // signal) would otherwise surface as an unhandled rejection.
    void this.ensureSse().catch((err) => {
      this.sseStarted = false;
      this.opts.output.appendLine(
        `[ide-agent] SSE start failed: ${err instanceof Error ? err.message : err}`,
      );
    });
  }
  private removeListener(fn: (ev: SseEvent) => void): void {
    this.listeners.delete(fn);
  }

  private sseStarted = false;
  private sseReconnectTimer?: NodeJS.Timeout;
  private sseReconnectDelay = 1000;
  /** Set to true while a turn is actively consuming events. */
  private turnActive = false;
  /**
   * P2 (QA-FILE-03): set while a turn is consuming events. The server-exit
   * handler uses it to push a visible "engine exited" error into the turn
   * instead of letting it hang until the 10-min watchdog. Cleared in
   * consumeEvents' finally.
   */
  private turnFail?: (message: string) => void;
  /**
   * P3 (QA-FILE-03): ids that already have a UI card. A tool part arriving
   * directly as running/completed (no pending first) gets a synthesized card
   * instead of an orphan delta. Cleared at the start of every turn.
   */
  private readonly knownToolCalls = new Set<string>();
  /**
   * P1 (QA-FILE-01): Stop button. Set by abortTurn(); resolved so the
   * mergeStreams race exits promptly even when no more engine events arrive
   * (consumeEvents would otherwise block forever on its notify promise).
   * Cleared in runTurn's finally.
   */
  private turnAbortRequested = false;
  private abortResolve?: () => void;

  private async ensureSse(): Promise<void> {
    if (this.sseStarted || !this.port) {
      return;
    }
    this.sseStarted = true;
    this.sseReconnectDelay = 1000;
    this.sseAbort = new AbortController();
    const req = http.request(
      {
        host: "127.0.0.1",
        port: this.port,
        path: "/api/event",
        method: "GET",
        headers: { Accept: "text/event-stream", ...this.authHeaders() },
        signal: this.sseAbort.signal,
      },
      (res) => {
        let buf = "";
        // P2 (QA-04): cap the raw SSE buffer — a stream without event
        // terminators would otherwise grow it without bound.
        const MAX_SSE_BUF = 1 * 1024 * 1024;
        res.on("data", (chunk: Buffer) => {
          buf += chunk.toString();
          if (buf.length > MAX_SSE_BUF) {
            this.opts.output.appendLine(
              `[ide-agent] SSE buffer overflow (${buf.length} bytes, no event terminator) — dropping malformed data`,
            );
            buf = "";
          }
          let idx: number;
          while ((idx = buf.indexOf("\n\n")) >= 0) {
            const raw = buf.slice(0, idx);
            buf = buf.slice(idx + 2);
            const ev = parseSse(raw);
            if (ev) {
              for (const fn of this.listeners) {
                try {
                  fn(ev);
                } catch {
                  /* listener errors must not kill the stream */
                }
              }
            }
          }
        });
        res.on("end", () => {
          this.handleSseDrop("stream ended");
        });
      },
    );
    req.on("error", (err) => {
      this.handleSseDrop(`request error: ${err instanceof Error ? err.message : err}`);
    });
    // P0: stall detection — if no response headers within 30s, destroy and reconnect.
    req.setTimeout(30_000, () => {
      req.destroy(new Error("SSE connection timed out"));
    });
    req.end();
  }

  /** Called when the SSE stream drops. Reconnects with backoff if a turn is active. */
  private handleSseDrop(reason: string): void {
    this.sseStarted = false;
    this.opts.output.appendLine(`[ide-agent] SSE dropped (${reason})`);
    // Wake any consumers blocked in consumeEvents so they don't hang forever.
    // (The turn timeout in runTurn will surface an error if the stream stays down.)
    // P1 (QA-FILE-01): no reconnect when the drop was caused by the user
    // hitting Stop — the next turn restarts SSE through ensureSse anyway.
    if (this.turnActive && !this.turnAbortRequested && this.port) {
      const delay = Math.min(this.sseReconnectDelay, 30_000);
      this.opts.output.appendLine(`[ide-agent] reconnecting SSE in ${delay}ms…`);
      // P3 (QA-FILE-03): clear any pending timer first — error+end double-fire
      // used to schedule two reconnects. The handle is cleared inside the
      // callback so it never goes stale.
      if (this.sseReconnectTimer) {
        clearTimeout(this.sseReconnectTimer);
      }
      this.sseReconnectTimer = setTimeout(() => {
        this.sseReconnectTimer = undefined;
        this.sseReconnectDelay = Math.min(this.sseReconnectDelay * 2, 30_000);
        void this.ensureSse().catch(() => {
          this.sseStarted = false;
        });
      }, delay);
    }
  }

  /**
   * P1 (QA-FILE-01): Stop button — abort the in-flight turn promptly.
   * Resolves the abort promise so mergeStreams exits even with no further
   * engine events, destroys the SSE stream (reconnect is suppressed via
   * turnAbortRequested — the next turn restarts it through ensureSse), and
   * sets the flag runTurn checks between yields. The composer posts the
   * "Turn stopped by user" note itself; the adapter must NOT yield an
   * "Engine error" for a user-initiated stop (see runTurn's catch).
   */
  abortTurn(): void {
    this.turnAbortRequested = true;
    this.abortResolve?.();
    this.abortResolve = undefined;
    if (this.sseReconnectTimer) {
      clearTimeout(this.sseReconnectTimer);
      this.sseReconnectTimer = undefined;
    }
    this.sseAbort?.abort();
    this.sseStarted = false;
  }
  /**
   * Map raw SSE events for one session into TurnEvents.
   * Runs until the turn-end promise resolves.
   */
  private async *consumeEvents(sessionID: string, ctx: TurnContext): AsyncGenerator<TurnEvent, void, unknown> {
    const queue: TurnEvent[] = [];
    // P2 (QA-04): bound the queue — a fast-producing engine must not grow it
    // without bound during a long turn. Drop oldest, count drops.
    const MAX_QUEUE = 1000;
    let droppedEvents = 0;
    const pushEvent = (e: TurnEvent): void => {
      if (queue.length >= MAX_QUEUE) {
        queue.shift();
        droppedEvents++;
        if (droppedEvents === 1 || droppedEvents % 100 === 0) {
          this.opts.output.appendLine(
            `[ide-agent] event queue full (${MAX_QUEUE}) — dropped ${droppedEvents} event(s) so far`,
          );
        }
      }
      queue.push(e);
    };
    let notify: (() => void) | undefined;
    const wake = () => notify?.();
    // P2 (QA-FILE-03): the server-exit handler pushes through here — the
    // visible "engine exited" error must reach the UI even though no SSE
    // event arrives.
    this.turnFail = (message: string) => {
      pushEvent({ type: "textDelta", bubbleId: ctx.bubbleId, delta: `\n\n**Engine error:** ${message}` });
      wake();
    };
    // P3 (QA-FILE-03): fresh per-turn card registry (see knownToolCalls).
    this.knownToolCalls.clear();

    const onEvent = (ev: SseEvent) => {
      const d = ev.data ?? {};
      if (d.sessionID !== sessionID && ev.type !== "permission.asked") {
        return;
      }
      switch (ev.type) {
        // --- Current engine stream (packages/schema/src/session-event.ts) ---
        case "session.text.delta": {
          if (typeof d.delta === "string" && d.delta.length > 0) {
            pushEvent({ type: "textDelta", bubbleId: ctx.bubbleId, delta: d.delta });
            wake();
          }
          break;
        }
        case "session.reasoning.delta": {
          if (typeof d.delta === "string" && d.delta.length > 0) {
            pushEvent({ type: "thinking", bubbleId: ctx.bubbleId, text: d.delta.slice(0, 200), durationMs: 0 });
            wake();
          }
          break;
        }
        case "session.tool.called": {
          // Current schema: { sessionID, assistantMessageID, id, name, input, executed }.
          const toolId = typeof d.id === "string" && d.id.length > 0 ? d.id : `tc-${Date.now().toString(36)}-${(toolCallSeq++).toString(36)}`;
          const name = typeof d.name === "string" ? d.name : "tool";
          if (!this.knownToolCalls.has(toolId)) {
            this.knownToolCalls.add(toolId);
            pushEvent({
              type: "toolCall",
              bubbleId: ctx.bubbleId,
              toolCall: {
                toolCallId: toolId,
                kind: toCursorToolName(name),
                title: summarizeTool(name, d.input),
                status: "pending",
                description: "Waiting for approval",
                outputPreview: "",
                expanded: false,
                filePath: toolInputPath(d.input),
                // Doc-gap A12: clarifying-question widget data.
                question: parseQuestionPayload(name, d.input, toolId),
              },
            });
            wake();
          }
          break;
        }
        case "session.tool.progress": {
          if (typeof d.id === "string" && d.id.length > 0) {
            this.toolDelta(ctx.bubbleId, d.id, typeof d.name === "string" ? d.name : "tool", undefined, {
              status: "running",
              description: "Running…",
            }, pushEvent, wake);
          }
          break;
        }
        case "session.tool.success": {
          if (typeof d.id === "string" && d.id.length > 0) {
            const content = Array.isArray(d.content) ? d.content : [];
            const preview = content
              .map((c: unknown) => (typeof c === "string" ? c : JSON.stringify(c)))
              .join("\n")
              .slice(0, 2000);
            this.toolDelta(ctx.bubbleId, d.id, typeof d.name === "string" ? d.name : "tool", undefined, {
              status: "done",
              description: "Completed",
              outputPreview: preview,
            }, pushEvent, wake);
          }
          break;
        }
        case "session.tool.failed": {
          if (typeof d.id === "string" && d.id.length > 0) {
            const raw = d.error?.message ?? d.error ?? "tool failed";
            this.toolDelta(ctx.bubbleId, d.id, typeof d.name === "string" ? d.name : "tool", undefined, {
              status: "failed",
              description: String(typeof raw === "string" ? raw : JSON.stringify(raw)).slice(0, 500),
            }, pushEvent, wake);
          }
          break;
        }
        // --- V1-compat stream (kept for older engines; not emitted by the
        // current engine, which uses the session.* events above) ---
        case "message.part.delta": {
          if (typeof d.delta === "string" && d.delta.length > 0) {
            pushEvent({ type: "textDelta", bubbleId: ctx.bubbleId, delta: d.delta });
            wake();
          }
          break;
        }
        case "message.part.updated": {
          const part = d.part;
          if (!part) {
            break;
          }
          if (part.type === "reasoning" && typeof part.text === "string") {
            pushEvent({ type: "thinking", bubbleId: ctx.bubbleId, text: part.text.slice(0, 200), durationMs: 0 });
            wake();
          } else if (part.type === "tool") {
            for (const e of this.toolPartToEvents(part, ctx.bubbleId)) {
              pushEvent(e);
            }
            wake();
          }
          break;
        }
        case "permission.asked": {
          if (d.sessionID !== sessionID) {
            break;
          }
          // P2 (XQA-03): serialize — concurrent permission.asked events must
          // not orphan the first approval card. Each approval completes
          // (card resolved + reply sent) before the next one shows.
          // P3 (QA-FILE-03): failures are caught+logged inside enqueueApproval
          // itself, so this fire-and-forget call cannot produce an unhandled
          // rejection.
          this.enqueueApproval(() => this.handleApproval(d, ctx.bubbleId, pushEvent, wake, ctx.mode));
          break;
        }
        case "session.error": {
          // P3 (QA-FILE-03): error variants without .message used to render
          // as "[object Object]" in the UI.
          const raw = d.error?.message ?? d.error ?? "unknown engine error";
          const msg = typeof raw === "string" ? raw : JSON.stringify(raw);
          pushEvent({ type: "textDelta", bubbleId: ctx.bubbleId, delta: `\n\n**Engine error:** ${msg}` });
          wake();
          break;
        }
      }
    };

    this.addListener(onEvent);
    try {
      for (;;) {
        while (queue.length > 0) {
          yield queue.shift()!;
        }
        // Wait for more events or turn end (signalled by the outer merge).
        await new Promise<void>((resolve) => {
          notify = resolve;
          if (queue.length > 0) {
            resolve();
          }
        });
        notify = undefined;
      }
    } finally {
      this.removeListener(onEvent);
      this.turnFail = undefined;
    }
  }

  /**
   * P3 (QA-FILE-03): queue a delta for a current-engine tool id, synthesizing
   * the card first when no `session.tool.called` was seen for it, so the
   * delta always has a card to attach to.
   */
  private toolDelta(
    bubbleId: string,
    toolCallId: string,
    name: string,
    input: unknown,
    delta: Partial<ToolCallViewModel>,
    pushEvent: (e: TurnEvent) => void,
    wake: () => void,
  ): void {
    if (!this.knownToolCalls.has(toolCallId)) {
      this.knownToolCalls.add(toolCallId);
      pushEvent({
        type: "toolCall",
        bubbleId,
        toolCall: {
          toolCallId,
          kind: toCursorToolName(name),
          title: summarizeTool(name, input),
          status: "running",
          description: `Running ${name}…`,
          outputPreview: "",
          expanded: false,
          filePath: toolInputPath(input),
        },
      });
    }
    pushEvent({ type: "toolCallDelta", toolCallId, delta });
    wake();
  }

  /** Merge the event stream with the turn-end signal (or turn timeout). */
  private async *mergeStreams(
    stream: AsyncIterable<TurnEvent>,
    turnDone: Promise<void>,
    timeoutPromise?: Promise<{ timedOut: true }>,
    abortPromise?: Promise<void>,
  ): AsyncIterable<TurnEvent> {
    let done = false;
    void turnDone.then(() => {
      done = true;
    });
    if (timeoutPromise) {
      void timeoutPromise.then(() => {
        done = true;
      });
    }
    // P1 (QA-FILE-01): Stop button — abortPromise resolves when abortTurn()
    // is called, so the loop exits promptly even mid-stream.
    if (abortPromise) {
      void abortPromise.then(() => {
        done = true;
      });
    }
    // P0 (QA-FILE-03): type the iterator explicitly — AsyncIterator lacks the
    // `return` member in this lib, which made cleanup a compile error.
    const it = stream[Symbol.asyncIterator]() as AsyncIterableIterator<TurnEvent>;
    for (;;) {
      if (done) {
        // Drain any events already queued (bounded: 250ms), then stop.
        const deadline = Date.now() + 250;
        for (;;) {
          const remaining = deadline - Date.now();
          if (remaining <= 0) {
            break;
          }
          const next = await Promise.race([
            it.next(),
            new Promise<null>((resolve) => setTimeout(() => resolve(null), remaining)),
          ]);
          if (!next || next.done) {
            break;
          }
          yield next.value;
        }
        break;
      }
      const next = await Promise.race([
        it.next().then((r) => ({ ...r, fromStream: true as const })),
        turnDone.then(() => ({ done: true as const, fromStream: false as const })),
        ...(timeoutPromise
          ? [timeoutPromise.then(() => ({ done: true as const, fromStream: false as const, timedOut: true as const }))]
          : []),
      ]);
      if (!next.fromStream || next.done) {
        break;
      }
      yield (next as { value: TurnEvent }).value;
    }
    if (typeof it.return === "function") {
      await it.return();
    }
  }

  /** Translate one engine ToolPart into toolCall / toolCallDelta events. */
  private *toolPartToEvents(part: any, bubbleId: string): Iterable<TurnEvent> {
    // P2 (QA-04): counter disambiguates the Date.now() fallback so two parts
    // arriving in the same millisecond never share an id.
    const toolCallId: string =
      part.callID ?? part.id ?? `tc-${Date.now().toString(36)}-${(toolCallSeq++).toString(36)}`;
    const cursorName = toCursorToolName(String(part.tool ?? "tool"));
    const state = part.state ?? {};
    const status = state.status as string;

    if (status === "pending") {
      this.knownToolCalls.add(toolCallId);
      const title = summarizeTool(part.tool, state.input);
      const toolCall: ToolCallViewModel = {
        toolCallId,
        kind: cursorName,
        title,
        status: "pending",
        description: "Waiting for approval",
        outputPreview: "",
        expanded: false,
        // Checkpoint file tracking: the tool's target path, so the
        // CheckpointService can snapshot pre-edit state before the tool runs.
        filePath: toolInputPath(state.input),
        // Doc-gap A12: clarifying-question widget data.
        question: parseQuestionPayload(String(part.tool ?? ""), state.input, toolCallId),
      };
      yield { type: "toolCall", bubbleId, toolCall };
    } else if (status === "running" || status === "completed" || status === "error") {
      // P3 (QA-FILE-03): the part skipped `pending` — synthesize the card
      // first so the delta below has something to attach to.
      if (!this.knownToolCalls.has(toolCallId)) {
        this.knownToolCalls.add(toolCallId);
        yield {
          type: "toolCall",
          bubbleId,
          toolCall: {
            toolCallId,
            kind: cursorName,
            title: summarizeTool(part.tool, state.input),
            status: "running",
            description: `Running ${part.tool}…`,
            outputPreview: "",
            expanded: false,
            filePath: toolInputPath(state.input),
          },
        };
      }
      if (status === "running") {
        yield {
          type: "toolCallDelta",
          toolCallId,
          delta: { status: "running", description: state.title ?? `Running ${part.tool}…` },
        };
      } else if (status === "completed") {
        const output = typeof state.output === "string" ? state.output : JSON.stringify(state.output ?? "");
        yield {
          type: "toolCallDelta",
          toolCallId,
          delta: {
            status: "done",
            description: state.title ?? `${part.tool} completed`,
            outputPreview: output.slice(0, 2000),
          },
        };
      } else if (status === "error") {
        yield {
          type: "toolCallDelta",
          toolCallId,
          delta: { status: "failed", description: String(state.error ?? "tool failed").slice(0, 500) },
        };
      }
    }
  }

  /** permission.asked → approval card → reply to the engine. */
  private async handleApproval(
    d: any,
    bubbleId: string,
    pushEvent: (e: TurnEvent) => void,
    wake: () => void,
    turnMode?: ModeName,
  ): Promise<void> {
    // P3 (QA-FILE-03): validate the request id — a missing id would poison the
    // dedup map and put "undefined" in the reply URL.
    //
    // NOTE — QA-FILE-03's P1 ("handleApproval reads wrong fields") is a FALSE
    // POSITIVE, verified 2026-10-19 against the real sources. The suggested
    // fields d.permission/d.patterns exist ONLY in the LEGACY V1 schema
    // (packages/schema/src/v1/permission.ts); packages/schema/AGENTS.md says
    // new/current code must NOT depend on that subtree. The live event
    // manifest (event-manifest.ts → Permission.Event.Definitions from
    // ./permission.ts) emits Permission.Request =
    // { id, sessionID, action, resources, save?, metadata?, source?, message? },
    // built by core/src/permission.ts request(). So d.action / d.resources /
    // d.message are the CORRECT reads. Do NOT "fix" them to permission/patterns.
    const requestID = d.id as unknown;
    if (typeof requestID !== "string" || requestID.length === 0) {
      this.opts.output.appendLine(`[ide-agent] permission.asked with invalid id — skipping approval`);
      return;
    }
    const action: string = d.action ?? "tool";
    const resources: string[] = Array.isArray(d.resources) ? d.resources : [];
    const toolCallId = `tc-${requestID}`;

    // Dedup: skip if this request is already being handled.
    if (this.pendingApprovals.has(requestID)) {
      return;
    }
    this.pendingApprovals.set(requestID, toolCallId);

    // P2 (CX4b-NEW1): the turn may have ended (abort/timeout) while this task
    // waited in the serialized approval chain — never surface an approval card
    // for a dead turn. Drop it so the chain keeps moving and the next turn's
    // approvals don't queue behind a stale card. (Approvals that START while
    // the turn is live but outlive it are settled by the composer's turn-end
    // settleAllPending instead.)
    if (!this.turnActive) {
      this.pendingApprovals.delete(requestID);
      this.opts.output.appendLine(
        `[ide-agent] dropping approval ${requestID} — its turn already ended`,
      );
      return;
    }

    // P2 (QA-FILE-04): chat-mode read-only gate. Cursor's Ask mode advertises
    // "Answer questions without making edits" and enforces it via an allowlist
    // + UI blocks; our "Chat" hint said "read-only" with zero enforcement.
    // This approval handler is the choke point: the engine asked permission,
    // so auto-rejecting here is honored. Mutating tools in read-only modes
    // are rejected without prompting the user.
    // P1 (QA-PLANMODE-01): gate on the TURN's mode, not the live UI mode.
    // The turn captured its mode at submit time; if the user flips the mode
    // mid-turn, in-flight approvals must still be gated by the mode the turn
    // started with. Falls back to the live mode for callers without a turn.
    const mode = turnMode ?? this.opts.getMode?.();
    const blockedByMode = !!mode && isReadOnlyMode(mode) && isMutatingToolAction(action);
    // DEV-HOOKS: blocking tool hooks at the approval choke point (Cursor
    // parity: preToolUse + beforeShellExecution/beforeMCPExecution/
    // beforeReadFile run BEFORE the approval card; exit code 2 auto-rejects
    // the tool call without prompting the user).
    let blockedByHook = false;
    let hookBlockReason: string | undefined;
    if (this.opts.hooks) {
      try {
        const gate = await this.opts.hooks.checkToolGate(action, resources, { sessionID: d.sessionID }, this.opts.hookScope ?? "");
        blockedByHook = gate.blocked;
        hookBlockReason = gate.reason;
      } catch (err) {
        // Hook infra failure must never hang an approval — fail open, log.
        this.opts.output.appendLine(
          `[ide-agent] hook gate error: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    const blocked = blockedByMode || blockedByHook;
    // MCP tools surface their server in the approval card (Cursor parity).
    const mcpAction = parseMcpAction(action);

    // SETTINGS-PARITY: `ide.composer.runMode` (Cursor's Run Modes).
    // autoReview (default): ask before each tool call. allowlist: safe
    // read-only tools auto-run, everything else asks. runEverything: all
    // tools auto-run without asking. Never overrides a block (read-only
    // mode or hook denial always win).
    const runMode = vscode.workspace
      .getConfiguration("ide.composer")
      .get<string>("runMode", "autoReview");
    const READ_ONLY_TOOL_ACTIONS: ReadonlySet<string> = new Set([
      "read",
      "glob",
      "grep",
      "list",
      "ls",
      "todoread",
      "webfetch",
      "websearch",
    ]);
    const autoApprovedByRunMode =
      !blocked &&
      (runMode === "runEverything" ||
        (runMode === "allowlist" && READ_ONLY_TOOL_ACTIONS.has(action.toLowerCase())));

    try {
      // Surface a tool-call card in pending state so the approval has context.
      pushEvent({
        type: "toolCall",
        bubbleId,
        toolCall: {
          toolCallId,
          kind: toCursorToolName(action),
          title: approvalTitle(action, resources),
          status: blocked ? "failed" : "pending",
          description: blockedByMode
            ? `Blocked: "${mode}" mode is read-only — mutating tools are disabled. Switch to Agent mode to allow edits.`
            : blockedByHook
              ? `Blocked by hook: ${hookBlockReason ?? "no reason given"}`
              : autoApprovedByRunMode
                ? `Auto-approved — run mode "${runMode}".`
                : (d.message ?? "The engine requests permission"),
          outputPreview: "",
          expanded: false,
          // Checkpoint file tracking: approval resources usually carry the
          // target path as the first resource.
          filePath:
            typeof resources[0] === "string" && resources[0].length > 0 ? resources[0] : undefined,
        },
      });
      wake();

      let decision: ApprovalResult;
      if (blocked) {
        // Auto-reject without prompting: maps to "reject" in the reply
        // mapping below, so the engine is told the tool call was denied.
        // (blockedByMode = read-only mode gate; blockedByHook = exit-2 hook.)
        decision = { optionId: "skip" };
      } else if (autoApprovedByRunMode) {
        // SETTINGS-PARITY: run mode auto-approves — no card prompt.
        decision = { optionId: "approve-once" };
      } else {
        try {
          // P2-4 rework (QA-CHATTABS Round B): link a question tool's
          // approval card to its question widget. The permission request's
          // source.id is the tool call id (Tool.CallID.make(input.call.id)
          // — the same id published in session.tool.called and used as the
          // widget's toolCallId), so this link is exact even with several
          // questions pending at once. Emitted only when a real card is
          // created (not for auto-approved / blocked / dropped requests —
          // there is no card to link then).
          if (
            action === "question" &&
            typeof d.source?.id === "string" &&
            d.source.id.length > 0
          ) {
            pushEvent({
              type: "questionApproval",
              toolCallId: d.source.id,
              approvalToolCallId: toolCallId,
            });
            wake();
          }
          // P1 (QA-CHATTABS-01): the allowlist identity is the STABLE tool
          // identity — action + sorted resources (e.g. "edit::src/a.ts") —
          // never the per-request toolCallId (`tc-<request-id>` is unique per
          // permission request, so keying on it made "Approve and allowlist"
          // a dead feature). Resources are joined with NUL, not "," — a comma
          // collides ["a,b"] with ["a","b"], and shell resources are full
          // command text where commas are common. NUL cannot appear in a
          // file path (forbidden by the OS on POSIX and Windows) or in
          // command text, so the key is unambiguous.
          const allowlistIdentity = `${action}::${[...new Set(resources)].sort().join("\u0000")}`;
          decision = await this.opts.requestApproval(toolCallId, action, [
            d.message ?? `Permission requested: ${approvalTitle(action, resources)}`,
            ...(mcpAction ? [`MCP server: ${mcpAction.server}`] : []),
            ...resources.slice(0, 3),
          ], allowlistIdentity);
        } catch (err) {
          // Approval UI failed — fail the tool call visibly instead of hanging.
          const message = err instanceof Error ? err.message : String(err);
          pushEvent({
            type: "toolCallDelta",
            toolCallId,
            delta: { status: "failed", description: `Approval failed: ${message}` },
          });
          wake();
          return;
        }
      }

      // Map UI options → engine replies: approve-once → "once", approve-allowlist → "always", skip → "reject".
      const reply = !decision || decision.optionId === "skip" ? "reject" : decision.optionId === "approve-allowlist" ? "always" : "once";

      pushEvent({
        type: "toolCallDelta",
        toolCallId,
        delta:
          reply === "reject"
            ? { status: "failed", description: "Rejected by user" }
            : { status: "running", description: "Approved — running…" },
      });
      wake();

      try {
        await this.api("POST", `/api/session/${d.sessionID}/permission/${requestID}/reply`, { decision: reply });
      } catch (err) {
        // P1: retry once, then fail the turn visibly instead of hanging.
        this.opts.output.appendLine(`[ide-agent] permission reply failed (retrying): ${err instanceof Error ? err.message : err}`);
        try {
          await this.api("POST", `/api/session/${d.sessionID}/permission/${requestID}/reply`, { decision: reply });
        } catch (retryErr) {
          const message = retryErr instanceof Error ? retryErr.message : String(retryErr);
          this.opts.output.appendLine(`[ide-agent] permission reply failed twice: ${message}`);
          pushEvent({
            type: "toolCallDelta",
            toolCallId,
            delta: { status: "failed", description: `Permission reply failed: ${message}` },
          });
          pushEvent({
            type: "textDelta",
            bubbleId,
            delta: "\n\n**Engine error:** could not send approval decision to the engine. The turn cannot continue.",
          });
          wake();
          // P3 (CX4b-NEW2): fail the turn fast. The engine never received our
          // reply, so it will never emit session.execution.* — without this
          // the turn idles until the 10-minute watchdog. wake() flushes the
          // queued error events through the stream; resolving the abort
          // promise breaks the merge loop right after. turnAbortRequested is
          // deliberately NOT set, so this is not misreported as a
          // user-initiated stop.
          this.abortResolve?.();
        }
      }
    } finally {
      this.pendingApprovals.delete(requestID);
    }
  }

  // ---- HTTP helper ----------------------------------------------------------

  /** Authorization headers for sidecar requests (Basic auth with the spawn token). */
  private authHeaders(): Record<string, string> {
    if (!this.authToken) {
      return {};
    }
    const credentials = Buffer.from(`opencode:${this.authToken}`).toString("base64");
    return { Authorization: `Basic ${credentials}` };
  }

  private api(method: "GET" | "POST", pathStr: string, body?: unknown): Promise<any> {
    return new Promise((resolve, reject) => {
      const payload = body === undefined ? undefined : JSON.stringify(body);
      const req = http.request(
        {
          host: "127.0.0.1",
          port: this.port,
          path: pathStr,
          method,
          headers: {
            "Content-Type": "application/json",
            ...(payload ? { "Content-Length": Buffer.byteLength(payload) } : {}),
            ...this.authHeaders(),
          },
        },
        (res) => {
          let data = "";
          // P2 (QA-FILE-03): cap the response body — the SSE path has a 1MB
          // cap but api() accumulated unboundedly; a misbehaving server could
          // OOM the extension host.
          const MAX_API_BODY = 10 * 1024 * 1024;
          let bodyOverflowed = false;
          res.on("data", (c: Buffer) => {
            if (bodyOverflowed) {
              return;
            }
            data += c.toString();
            if (data.length > MAX_API_BODY) {
              bodyOverflowed = true;
              req.destroy(new Error("response body exceeded 10MB cap"));
              reject(new Error(`${method} ${pathStr} → response body exceeded 10MB cap`));
            }
          });
          res.on("end", () => {
            if (bodyOverflowed) {
              return;
            }
            if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
              try {
                resolve(data ? JSON.parse(data) : {});
              } catch (parseErr) {
                // P2 (QA-04): don't swallow malformed JSON into {} — callers
                // then fail with confusing TypeErrors. Log the raw body and
                // reject with a descriptive error instead.
                this.opts.output.appendLine(
                  `[ide-agent] ${method} ${pathStr} returned invalid JSON: ${data.slice(0, 500)}`,
                );
                reject(
                  new Error(
                    `${method} ${pathStr} returned invalid JSON: ${parseErr instanceof Error ? parseErr.message : parseErr}`,
                  ),
                );
              }
            } else {
              // P2 (CX4b): a 404 on a session-scoped path means the engine lost
              // our session (internal restart / session TTL). Drop the stale
              // cache entry now so ensureSession() creates a fresh one instead
              // of failing every subsequent turn until the extension reloads.
              const goneSessionId = sessionIdFromApiPath(pathStr);
              if (res.statusCode === 404 && goneSessionId !== undefined) {
                this.invalidateSession(goneSessionId);
              }
              reject(httpError(method, pathStr, res.statusCode ?? 0, data.slice(0, 300)));
            }
          });
        },
      );
      req.on("error", reject);
      req.setTimeout(30_000, () => req.destroy(new Error("request timed out")));
      if (payload) {
        req.write(payload);
      }
      req.end();
    });
  }

  /** Stop the sidecar (call on extension deactivate). */
  dispose(): void {
    this.disposed = true;
    this.sseAbort?.abort();
    // P2 (QA-04): drop all SSE listeners and cancel any pending reconnect so
    // nothing survives disposal.
    this.listeners.clear();
    if (this.sseReconnectTimer) {
      clearTimeout(this.sseReconnectTimer);
      this.sseReconnectTimer = undefined;
    }
    this.sseStarted = false;
    // P2 (QA-04-VERIFY): escalate to SIGKILL if the sidecar ignores SIGTERM —
    // otherwise a zombie bun survives deactivation holding its port.
    const proc = this.serverProc;
    if (proc) {
      proc.kill("SIGTERM");
      const killTimer = setTimeout(() => {
        if (proc.exitCode === null && !proc.killed) {
          this.opts.output.appendLine("[ide-agent] engine ignored SIGTERM; sending SIGKILL");
          proc.kill("SIGKILL");
        }
      }, 3000);
      // Don't let the timer keep the extension host alive.
      killTimer.unref?.();
      proc.once("exit", () => clearTimeout(killTimer));
    }
    this.serverProc = undefined;
    this.port = 0;
    this.authToken = undefined;
    // P2 (QA-FILE-03): drop the in-flight start promise — a dispose during
    // startup used to leave `starting` pointing at a promise that rejects
    // after a 30s poll against port 0, so the next ensureServer() trusted a
    // dead promise instead of starting fresh.
    this.starting = undefined;
    this.turnActive = false;
    this.turnFail = undefined;
    this.sessions.clear();
  }
}

/**
 * M-03 (model picker): serialize a ModelRef to the wire's Model.Ref shape —
 * { id, providerID, variant? } (variant omitted when absent).
 */
function toWireModelRef(ref: ModelRef): { id: string; providerID: string; variant?: string } {
  return {
    id: ref.id,
    providerID: ref.providerID,
    ...(ref.variant ? { variant: ref.variant } : {}),
  };
}

/**
 * Extract the tool's target file path from its input (path/file field).
 * Used for checkpoint file tracking. Returns undefined for non-file tools.
 */
function toolInputPath(input: any): string | undefined {
  const inp = input as Record<string, unknown> | undefined;
  const p = inp?.["path"];
  if (typeof p === "string" && p.length > 0) {
    return p;
  }
  const f = inp?.["file"];
  if (typeof f === "string" && f.length > 0) {
    return f;
  }
  return undefined;
}

/**
 * Parse the `question` tool's input into a clarifying-question payload
 * (doc-gap A12 — Cursor's clickable question widget). Input shape (from
 * @opencode/schema Question.Prompt): { questions: [{ header, question,
 * options: [{label, description}], multiple? }] }. Returns undefined when the
 * tool isn't `question` or the payload is malformed.
 */
function parseQuestionPayload(
  tool: string,
  input: any,
  toolCallId: string,
): ClarifyingQuestion | undefined {
  if (tool !== "question") {
    return undefined;
  }
  const questions = (input as Record<string, unknown> | undefined)?.["questions"];
  if (!Array.isArray(questions) || questions.length === 0) {
    return undefined;
  }
  const q = questions[0] as Record<string, unknown>;
  if (typeof q["question"] !== "string") {
    return undefined;
  }
  const rawOptions = Array.isArray(q["options"]) ? q["options"] : [];
  const options = rawOptions
    .filter(
      (o): o is Record<string, unknown> => typeof o === "object" && o !== null && typeof o["label"] === "string",
    )
    .map((o, i) => ({
      id: `opt-${i}`,
      label: String(o["label"]),
      description: typeof o["description"] === "string" ? String(o["description"]) : undefined,
    }));
  if (options.length === 0) {
    return undefined;
  }
  return {
    questionId: `q-${toolCallId}`,
    header: typeof q["header"] === "string" ? String(q["header"]) : "Question",
    question: String(q["question"]),
    options,
    multiple: q["multiple"] === true,
    toolCallId,
  };
}

function summarizeTool(tool: string, input: any): string {
  const inp = input as Record<string, unknown> | undefined;
  const target =
    (typeof inp?.["path"] === "string" && inp["path"]) ||
    (typeof inp?.["file"] === "string" && inp["file"]) ||
    (typeof inp?.["pattern"] === "string" && inp["pattern"]) ||
    (typeof inp?.["command"] === "string" && String(inp["command"]).slice(0, 60)) ||
    "";
  return target ? `${tool} ${target}` : tool;
}

function freePort(): Promise<number> {  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      srv.close(() => resolve(typeof addr === "object" && addr ? addr.port : 0));
    });
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
