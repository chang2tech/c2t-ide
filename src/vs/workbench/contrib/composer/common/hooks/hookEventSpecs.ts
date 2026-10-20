// IDE-CODE (DEV-GAPS-34, hooks-21-events): verbatim 21-event definitions.
//
// Parity source: cursor.com/docs/hooks (fetched 2026-10-20). Every event
// name below is copied verbatim from that page. Trigger descriptions quote
// the docs; `triggerSite` is where OUR codebase fires the event.
//
// Node-free (common/): pure data + payload builders, unit-testable with
// node:test.

import { HookEventName, KNOWN_EVENTS } from "./hookTypes.js";

export type HookEventCategory = "agent" | "tab" | "app";

export interface HookEventSpec {
  /** Verbatim event name from cursor.com/docs/hooks. */
  name: HookEventName;
  category: HookEventCategory;
  /** What the docs say fires the event (paraphrase of the docs page). */
  docsTrigger: string;
  /** Where this repo fires it (file, relative to the fork root). */
  triggerSite: string;
  /**
   * Whether a deny decision can block the gated action here.
   * Docs: permission hooks (preToolUse, beforeShellExecution,
   * beforeMCPExecution, beforeReadFile, beforeTabFileRead, subagentStart)
   * block on deny/exit-2; beforeSubmitPrompt blocks on continue=false;
   * stop/subagentStop deny blocks the stop and the followup_message
   * continues the turn. Everything else is observational.
   */
  blocking: boolean;
  /** Docs payload input fields (event-specific, beyond the base fields). */
  payloadFields: string[];
  /** Docs payload output fields the hook may return. */
  outputFields: string[];
  /** Docs matcher description, verbatim where given. */
  matcher?: string;
}

const spec = (
  name: HookEventName,
  category: HookEventCategory,
  docsTrigger: string,
  triggerSite: string,
  blocking: boolean,
  payloadFields: string[],
  outputFields: string[],
  matcher?: string,
): HookEventSpec => ({
  name,
  category,
  docsTrigger,
  triggerSite,
  blocking,
  payloadFields,
  outputFields,
  matcher,
});

/**
 * The 21 hook events, verbatim from cursor.com/docs/hooks:
 * 18 agent hooks + 2 tab hooks + 1 app-lifecycle hook.
 */
export const HOOK_EVENT_SPECS: Record<HookEventName, HookEventSpec> = {
  sessionStart: spec(
    "sessionStart",
    "agent",
    "Called when a new composer conversation is created. Fire-and-forget; the agent loop does not wait for a blocking response.",
    "src/vs/workbench/contrib/composer/electron-browser/ideCodeEngineAdapter.ts (ensureSession)",
    false,
    ["session_id", "is_background_agent", "composer_mode?"],
    ["env?", "additional_context?"],
  ),
  sessionEnd: spec(
    "sessionEnd",
    "agent",
    "Called when a composer conversation ends. Fire-and-forget; the response is logged but not used.",
    "src/vs/workbench/contrib/composer/electron-browser/composerDataService.ts (dispose)",
    false,
    ["session_id", "reason", "duration_ms", "is_background_agent", "final_status", "error_message?"],
    [],
  ),
  preToolUse: spec(
    "preToolUse",
    "agent",
    "Called before any tool execution. Generic hook that fires for all tool types (Shell, Read, Write, MCP, Task, etc.).",
    "src/vs/workbench/contrib/composer/electron-browser/hooks/hookService.ts (checkToolGate)",
    true,
    [],
    ["permission", "user_message?", "agent_message?", "updated_input?"],
    "Filter by tool type. Values include Shell, Read, Write, Grep, Delete, Task, and MCP tools using the MCP:<tool_name> format.",
  ),
  postToolUse: spec(
    "postToolUse",
    "agent",
    "Called after successful tool execution. Useful for auditing, analytics, and injecting context.",
    "src/vs/workbench/contrib/composer/electron-browser/composerDataService.ts (firePostToolHooks)",
    false,
    ["duration", "tool_output"],
    ["updated_mcp_tool_output?", "additional_context?"],
    "Filter by tool type (same values as preToolUse).",
  ),
  postToolUseFailure: spec(
    "postToolUseFailure",
    "agent",
    "Called when a tool fails, times out, or is denied. Useful for error tracking and recovery logic.",
    "src/vs/workbench/contrib/composer/electron-browser/composerDataService.ts (firePostToolHooks)",
    false,
    ["error_message", "failure_type", "duration", "is_interrupt"],
    ["additional_context?"],
    "Filter by tool type (same values as preToolUse).",
  ),
  subagentStart: spec(
    "subagentStart",
    "agent",
    "Called before spawning a subagent (Task tool). Can allow or deny subagent creation.",
    "src/vs/workbench/contrib/composer/electron-browser/hooks/hookService.ts (checkToolGate, task tools)",
    true,
    ["subagent_id", "subagent_type", "task", "parent_conversation_id", "tool_call_id", "subagent_model", "is_parallel_worker", "git_branch?"],
    ["permission", "user_message?"],
    "The matcher runs against the subagent type (e.g. explore, shell, generalPurpose).",
  ),
  subagentStop: spec(
    "subagentStop",
    "agent",
    "Called when a subagent completes, errors, or is aborted. Can trigger follow-up actions.",
    "src/vs/workbench/contrib/composer/electron-browser/composerDataService.ts (firePostToolHooks, task tools)",
    true,
    ["subagent_type", "status", "task", "description", "summary", "duration_ms", "message_count", "tool_call_count", "loop_count", "modified_files", "agent_transcript_path?"],
    ["followup_message?"],
    "Filter by subagent type (generalPurpose, explore, shell, etc.).",
  ),
  beforeShellExecution: spec(
    "beforeShellExecution",
    "agent",
    "Control shell commands. Return a permission decision.",
    "src/vs/workbench/contrib/composer/electron-browser/hooks/hookService.ts (checkToolGate, shell tools)",
    true,
    [],
    ["permission", "user_message?", "agent_message?"],
    "The matcher runs against the shell command string.",
  ),
  afterShellExecution: spec(
    "afterShellExecution",
    "agent",
    "Fires after a shell command executes; useful for auditing or collecting metrics from command output.",
    "src/vs/workbench/contrib/composer/electron-browser/composerDataService.ts (firePostToolHooks, shell tools)",
    false,
    ["command", "output", "duration", "sandbox"],
    [],
    "Filter by the shell command text; the matcher is matched against the full command string.",
  ),
  beforeMCPExecution: spec(
    "beforeMCPExecution",
    "agent",
    "Called before any MCP tool is executed. Return a permission decision.",
    "src/vs/workbench/contrib/composer/electron-browser/hooks/hookService.ts (checkToolGate, mcp__* tools)",
    true,
    ["tool_name", "tool_input", "mcp_server_name", "mcp_server_url?", "url?", "command?"],
    ["permission", "user_message?", "agent_message?"],
  ),
  afterMCPExecution: spec(
    "afterMCPExecution",
    "agent",
    "Fires after an MCP tool executes; includes the tool's input parameters and full JSON result.",
    "src/vs/workbench/contrib/composer/electron-browser/composerDataService.ts (firePostToolHooks, mcp tools)",
    false,
    ["tool_name", "tool_input", "mcp_server_name", "mcp_server_url?", "result_json", "duration"],
    [],
  ),
  beforeReadFile: spec(
    "beforeReadFile",
    "agent",
    "Called before Agent reads a file. Use for access control to block sensitive files from being sent to the model.",
    "src/vs/workbench/contrib/composer/electron-browser/hooks/hookService.ts (checkToolGate, read tools)",
    true,
    ["file_path", "content", "attachments"],
    ["permission", "user_message?"],
    "Matched against the value `Read`.",
  ),
  afterFileEdit: spec(
    "afterFileEdit",
    "agent",
    "Fires after the Agent edits a file; useful for formatters or accounting of agent-written code.",
    "src/vs/workbench/contrib/composer/electron-browser/composerDataService.ts (firePostToolHooks, edit tools)",
    false,
    [],
    [],
    "Matched against the value `Write`.",
  ),
  beforeSubmitPrompt: spec(
    "beforeSubmitPrompt",
    "agent",
    "Called right after user hits send but before backend request. Can prevent submission.",
    "src/vs/workbench/contrib/composer/electron-browser/composerDataService.ts (submitWithHooks)",
    true,
    [],
    ["continue", "user_message?"],
    "Matched against the value `UserPromptSubmit`.",
  ),
  preCompact: spec(
    "preCompact",
    "agent",
    "Called before context window compaction/summarization occurs. Observational hook that cannot block or modify the compaction behavior.",
    "src/vs/workbench/contrib/composer/electron-browser/ideCodeEngineAdapter.ts (summarization gate)",
    false,
    ["trigger", "context_usage_percent", "context_tokens", "context_window_size", "message_count", "messages_to_compact", "is_first_compaction"],
    ["user_message?"],
  ),
  stop: spec(
    "stop",
    "agent",
    "Called when the agent loop ends. Can optionally auto-submit a follow-up user message to keep iterating.",
    "src/vs/workbench/contrib/composer/electron-browser/composerDataService.ts (runStopHooks)",
    true,
    ["loop_count"],
    ["followup_message?"],
    "Matched against the value `Stop`.",
  ),
  afterAgentResponse: spec(
    "afterAgentResponse",
    "agent",
    "Called after the agent has completed an assistant message.",
    "src/vs/workbench/contrib/composer/electron-browser/composerDataService.ts (runStopHooks)",
    false,
    [],
    [],
    "Matched against the value `AgentResponse`.",
  ),
  afterAgentThought: spec(
    "afterAgentThought",
    "agent",
    "Called after the agent completes a thinking block. Useful for observing the agent's reasoning process.",
    "src/vs/workbench/contrib/composer/electron-browser/composerDataService.ts (applyEvent, thinking)",
    false,
    ["text", "duration_ms?"],
    [],
    "Matched against the value `AgentThought`.",
  ),
  beforeTabFileRead: spec(
    "beforeTabFileRead",
    "tab",
    "Called before Tab (inline completions) reads a file. Enable redaction or access control before Tab accesses file contents. Does not include `attachments` (Tab doesn't use prompt attachments).",
    "src/vs/workbench/contrib/inlineCompletions/browser/ideTab/provider.ts (provideInlineCompletions)",
    true,
    ["file_path", "content"],
    ["permission", "user_message?"],
    "Matched against the value `TabRead`.",
  ),
  afterTabFileEdit: spec(
    "afterTabFileEdit",
    "tab",
    "Called after Tab (inline completions) edits a file. Useful for formatters or auditing of Tab-written code. Includes detailed edit information: `range`, `old_line`, and `new_line`.",
    "src/vs/workbench/contrib/inlineCompletions/browser/ideTab/accept.ts (fireAfterTabFileEdit)",
    false,
    ["range", "old_line", "new_line"],
    [],
    "Matched against the value `TabWrite`.",
  ),
  workspaceOpen: spec(
    "workspaceOpen",
    "app",
    "Fires once when Cursor opens a workspace and again on every workspace folder change. Skipped when the window has zero workspace folders. Runs in the Cursor desktop app and CLI.",
    "extensions/ide-agent/src/extension.ts (activate + onDidChangeWorkspaceFolders) — the live hooks owner; the core workbench migration has no app-level HookService instance yet, so the event stays here until the core owns hooks.",
    false,
    [],
    ["pluginPaths?"],
  ),
};

/** The 21 verbatim event names, in docs order — must equal KNOWN_EVENTS. */
export const SPEC_EVENT_NAMES: readonly HookEventName[] = KNOWN_EVENTS;

/** Fail-fast invariant: the spec table covers exactly the 21 known events. */
export function assertSpecsComplete(): void {
  const keys = Object.keys(HOOK_EVENT_SPECS).sort();
  const known = [...KNOWN_EVENTS].sort();
  if (keys.length !== known.length || keys.some((k, i) => k !== known[i])) {
    throw new Error(
      `HOOK_EVENT_SPECS drifted from KNOWN_EVENTS: [${keys.join(",")}] vs [${known.join(",")}]`,
    );
  }
}

export type SessionEndReason =
  | "completed"
  | "aborted"
  | "error"
  | "window_close"
  | "user_close";

/**
 * Build the docs payload extras for sessionEnd.
 * Docs input: session_id, reason, duration_ms, is_background_agent,
 * final_status, error_message?.
 */
export function buildSessionEndExtras(opts: {
  sessionId: string;
  reason: SessionEndReason;
  durationMs: number;
  finalStatus: string;
  errorMessage?: string;
}): Record<string, unknown> {
  const extras: Record<string, unknown> = {
    session_id: opts.sessionId,
    reason: opts.reason,
    duration_ms: opts.durationMs,
    is_background_agent: false,
    final_status: opts.finalStatus,
  };
  if (opts.errorMessage) {
    extras["error_message"] = opts.errorMessage;
  }
  return extras;
}

/**
 * Build the docs payload extras for preCompact.
 * Docs input: trigger ("auto"|"manual"), context_usage_percent,
 * context_tokens, context_window_size, message_count, messages_to_compact,
 * is_first_compaction. Only fields we actually know are emitted — unknown
 * numbers are omitted, never fabricated.
 */
export function buildPreCompactExtras(opts: {
  trigger: "auto" | "manual";
  isFirstCompaction: boolean;
  contextUsagePercent?: number;
  contextTokens?: number;
  contextWindowSize?: number;
  messageCount?: number;
  messagesToCompact?: number;
}): Record<string, unknown> {
  const extras: Record<string, unknown> = {
    trigger: opts.trigger,
    is_first_compaction: opts.isFirstCompaction,
  };
  if (typeof opts.contextUsagePercent === "number") {
    extras["context_usage_percent"] = opts.contextUsagePercent;
  }
  if (typeof opts.contextTokens === "number") {
    extras["context_tokens"] = opts.contextTokens;
  }
  if (typeof opts.contextWindowSize === "number") {
    extras["context_window_size"] = opts.contextWindowSize;
  }
  if (typeof opts.messageCount === "number") {
    extras["message_count"] = opts.messageCount;
  }
  if (typeof opts.messagesToCompact === "number") {
    extras["messages_to_compact"] = opts.messagesToCompact;
  }
  return extras;
}

/** Build the docs payload extras for sessionStart. */
export function buildSessionStartExtras(opts: {
  sessionId: string;
  composerMode: string;
}): Record<string, unknown> {
  return {
    session_id: opts.sessionId,
    is_background_agent: false,
    composer_mode: opts.composerMode,
  };
}
