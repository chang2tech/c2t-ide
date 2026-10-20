// IDE-CODE: Migrated from extensions/ide-agent/src/hooks/hookTypes.ts (CAT-A, pure logic).
/**
 * hookTypes — Cursor-style agent Hooks: types and the verified 21-event inventory.
 *
 * Parity source: cursor.com/docs/hooks (fetched 2026-10-20 — the page lists
 * exactly 21 events: 18 agent + 2 tab + 1 app-lifecycle; see HOOK_EVENT_SPECS
 * in ./hookEventSpecs.ts for the verbatim list). An earlier REA note claimed
 * "22 events", but its own itemized list summed to 21 — the official docs are
 * authoritative. No 22nd event is invented here (see KNOWN_EVENTS).
 */

/** The 21 hook events OBSERVED in the Cursor 3.25.6 bundle. Do not add more. */
export const KNOWN_EVENTS = [
  // Agent hooks (18)
  "sessionStart",
  "sessionEnd",
  "preToolUse",
  "postToolUse",
  "postToolUseFailure",
  "subagentStart",
  "subagentStop",
  "beforeShellExecution",
  "afterShellExecution",
  "beforeMCPExecution",
  "afterMCPExecution",
  "beforeReadFile",
  "afterFileEdit",
  "beforeSubmitPrompt",
  "preCompact",
  "stop",
  "afterAgentResponse",
  "afterAgentThought",
  // Tab hooks (2)
  "beforeTabFileRead",
  "afterTabFileEdit",
  // App lifecycle (1)
  "workspaceOpen",
] as const;

export type HookEventName = (typeof KNOWN_EVENTS)[number];

export function isKnownEvent(name: string): name is HookEventName {
  return (KNOWN_EVENTS as readonly string[]).includes(name);
}

/** A single hook entry from hooks.json. */
export interface HookEntry {
  /** Shell command to run. */
  command: string;
  /**
   * "command" (default) — run the command, exit code decides.
   * "prompt" — LLM-evaluated hook: the command string is a prompt template
   * ($ARGUMENTS is replaced with the JSON payload); it must return
   * `{ "ok": boolean, "reason"?: string }`.
   */
  type?: "command" | "prompt";
  /** Timeout in seconds (default 30). */
  timeout?: number;
  /**
   * Max follow-up turns for `stop`/`subagentStop` (default 5).
   * `null` = unlimited.
   */
  loop_limit?: number | null;
  /** When true, ANY hook failure (non-zero exit, timeout, spawn error) blocks instead of allowing. */
  failClosed?: boolean;
  /** Regex matched against the event-specific field (see MATCHER_FIELDS). */
  matcher?: string;
  /** Optional model override for prompt-type hooks. */
  model?: string;
}

/** Event → the payload field the entry's `matcher` regex is tested against. */
export const MATCHER_FIELDS: Record<string, string> = {
  subagentStart: "subagentType",
  beforeShellExecution: "command",
  preToolUse: "tool",
  beforeSubmitPrompt: "submitKind",
  stop: "stopKind",
};

/**
 * Docs matcher table (cursor.com/docs/hooks, "Available matchers by hook",
 * verbatim). `field` = the payload field the regex tests; `constant` = the
 * fixed value the regex tests for events whose matcher is documented as a
 * constant (e.g. beforeReadFile is "Matched against the value `Read`").
 * Events not listed here have no documented matcher (sessionStart,
 * sessionEnd, preCompact, beforeMCPExecution, afterMCPExecution,
 * workspaceOpen) — a matcher on those runs the hook unconditionally.
 *
 * NOTE: the `field` names are OUR payload keys (e.g. `subagentType`), which
 * is what the trigger sites put in the payload; the docs describe the VALUES
 * ("runs against the subagent type"), not the JSON key spelling.
 */
export const HOOK_MATCHER_SPECS: Record<
  HookEventName,
  { field?: string; constant?: string }
> = {
  sessionStart: {},
  sessionEnd: {},
  preToolUse: { field: "tool" },
  postToolUse: { field: "tool" },
  postToolUseFailure: { field: "tool" },
  subagentStart: { field: "subagentType" },
  subagentStop: { field: "subagentType" },
  beforeShellExecution: { field: "command" },
  afterShellExecution: { field: "command" },
  beforeMCPExecution: {},
  afterMCPExecution: {},
  beforeReadFile: { constant: "Read" },
  afterFileEdit: { constant: "Write" },
  beforeSubmitPrompt: { constant: "UserPromptSubmit" },
  preCompact: {},
  stop: { constant: "Stop" },
  afterAgentResponse: { constant: "AgentResponse" },
  afterAgentThought: { constant: "AgentThought" },
  beforeTabFileRead: { constant: "TabRead" },
  afterTabFileEdit: { constant: "TabWrite" },
  workspaceOpen: {},
};

/**
 * Resolve the string a hook entry's `matcher` regex is tested against.
 * Returns undefined when there is no documented matcher value for the
 * event (or the field is absent) — callers treat that as "run the hook".
 */
export function getHookMatcherValue(
  event: HookEventName,
  payload: Record<string, unknown>,
): string | undefined {
  const spec = HOOK_MATCHER_SPECS[event];
  if (!spec) {
    return undefined;
  }
  if (spec.field) {
    const v = payload[spec.field];
    return typeof v === "string" ? v : undefined;
  }
  return spec.constant;
}

/** A validated hooks.json file. */
export interface HooksConfigFile {
  version?: number;
  hooks: Partial<Record<HookEventName, HookEntry[]>>;
}

/** Where a hook entry came from (merge order = array order). */
export type HookSourceKind =
  | "enterprise"
  | "user"
  | "project"
  | "cursor-user-compat"
  | "cursor-project-compat"
  | "claude-compat"
  | "claude-local-compat";

export interface LoadedHook {
  entry: HookEntry;
  source: HookSourceKind;
  sourcePath: string;
  event: HookEventName;
}

/** One config source's load result. Bad sources never kill the others. */
export interface SourceLoadResult {
  kind: HookSourceKind;
  path: string;
  found: boolean;
  hooks: LoadedHook[];
  /** Per-source validation errors (mirrors Cursor's `hooksConfigErrors`). */
  errors: string[];
}

/** Base input contract sent to every hook (stdin JSON + $ARGUMENTS). */
export interface HookPayload {
  conversation_id?: string;
  generation_id?: string;
  model?: string;
  model_id?: string;
  model_params?: unknown[];
  hook_event_name: HookEventName;
  cursor_version: string;
  workspace_roots: string[];
  user_email?: string;
  transcript_path?: string;
  /** Event-specific extras (tool, command, file, prompt, ...). */
  [key: string]: unknown;
}

export type HookDecision = "deny" | "ask" | "allow";

/** What one hook execution produced. */
export interface HookRunOutcome {
  hook: LoadedHook;
  exitCode: number | null;
  timedOut: boolean;
  /** Effective decision after exit-code semantics + stdout JSON. */
  decision: HookDecision;
  /** Human-readable reason (JSON reason, stderr, or the verbatim exit-2 text). */
  reason?: string;
  stdout: string;
  stderr: string;
  durationMs: number;
  /** True when this hook alone blocks the gated action. */
  blocks: boolean;
  /** followup_message from the hook's stdout JSON (stop/subagentStop). */
  followupMessage?: string;
  /** user_message from the hook's stdout JSON (concatenated across hooks). */
  userMessage?: string;
  /** agent_message from the hook's stdout JSON (concatenated across hooks). */
  agentMessage?: string;
  /** pluginPaths from the hook's stdout JSON (workspaceOpen). */
  pluginPaths?: string[];
}

/** Aggregated result of running all matching hooks for one event. */
export interface HookResult {
  blocked: boolean;
  blockReason?: string;
  /** Merged decision across hooks: deny > ask > allow. */
  decision: HookDecision;
  /** Concatenated user_message fields. */
  userMessages: string[];
  /** Concatenated agent_message fields. */
  agentMessages: string[];
  /** Last-wins followup_message (stop/subagentStop follow-ups). */
  followupMessages: string[];
  /** Raw hook stdout to append to the agent's context (capped). */
  contextAdditions: string[];
  pluginPaths: string[];
  outcomes: HookRunOutcome[];
}

/** One line for the execution log view (`_addExecutionLogEntry` parity). */
export interface ExecutionLogEntry {
  at: number;
  event: HookEventName;
  source: string;
  command: string;
  exitCode: number | null;
  timedOut: boolean;
  decision: HookDecision;
  durationMs: number;
  note?: string;
}
