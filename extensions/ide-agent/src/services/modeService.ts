import * as vscode from "vscode";
import { ModeName } from "../model";
import { parseToolName } from "../mcp/names";

/**
 * ModeService — owns the unifiedMode enum and its mapping.
 *
 * Runtime truth (Cursor 3.25.9, verified live via CDP 2026-10-19):
 * exactly 5 chat modes — Agent / Ask / Debug / Multitask / Plan.
 * "Edit" is NOT a chat mode: it is the Cmd+K inline-edit flow's internal
 * mode value (used by InlineEditService when it submits to the engine).
 * "Background" is a separate composer kind (cloud/background agents), not
 * a chat mode. "Triage" is a REGISTERED built-in mode (the binary seeds it
 * in modes4, migration v121 inserts it right after agent, id is protected,
 * actionId "composerMode.triage") but is NOT user-selectable: Cursor's
 * getAllModes() drops it (and "spec") from the picker list, so no
 * composerMode.triage command is registered and no palette command
 * "Open Chat in Triage Mode" exists in the binary (0 hits). All are kept
 * as enum values for compat but are never listed in the picker, the
 * palette, or the Shift+Tab cycle.
 *
 * Two parallel representations (static REA, parity-chat-modes.md):
 *  1. UI dropdown config — label/icon/color/placeholder/description per mode
 *     (binary `dNg` array; all strings spot-verified).
 *  2. Behavioral flags — autoRun / autoFix / shouldAutoApplyIfNoEditTool
 *     (binary `composerMode.*` definitions; !0=true, !1=false).
 *
 * Wire ids never change: `chat` stays `chat` even though the user-facing
 * name is "Ask" (post-0.46 rename; runtime-verified in the palette).
 */
export interface ModeDef {
  id: ModeName;
  /** User-facing label ("Ask", not "Chat"). */
  label: string;
  /** Codicon-ish icon id from Cursor's registry. */
  icon: string;
  /** Mode accent color (CSS class suffix). */
  color: "default" | "green" | "yellow" | "red" | "purple";
  /** Chat input placeholder while this mode is active. */
  placeholder: string;
  /** One-line description (mode picker / palette). */
  description: string;
  /** Listed in the mode dropdown (Cursor lists exactly plan/debug/multitask/chat). */
  pickable: boolean;
  // --- behavioral flags (composerMode.* definitions) ---
  autoRun: boolean;
  autoFix: boolean;
  shouldAutoApplyIfNoEditTool: boolean;
}

export const MODES: ModeDef[] = [
  {
    id: "agent",
    label: "Agent",
    icon: "infinity",
    color: "default",
    // Runtime-observed (3.25.9, logged-out agent panel): "Plan, Build, / for skills, @ for context"
    placeholder: "Plan, Build, / for skills, @ for context",
    description: "Plan, search, make edits, run commands",
    pickable: false, // implicit default — not in the dropdown, but in the Shift+Tab cycle
    autoRun: true,
    autoFix: true,
    shouldAutoApplyIfNoEditTool: true,
  },
  // Registered but NOT selectable (agent-mode-triage, Cursor parity).
  // The binary seeds triage in modes4 (migration v121 inserts it right
  // after agent), protects the id, and resolves it via getMode() — but
  // getAllModes() drops it from the picker list, so no composerMode.triage
  // command is registered and it is not in the Shift+Tab cycle.
  // Behavioral flags verbatim from the binary seed def (3.25.6 @16322050):
  // autoRun !0, autoFix !1, shouldAutoApplyIfNoEditTool !1.
  {
    id: "triage",
    label: "Triage",
    icon: "rocket",
    color: "default", // OURS — binary only defines --composer-mode-triage-text (theme-controlled)
    placeholder: "Coordinate long-horizon tasks", // OURS — binary seed has no placeholder
    description: "Coordinate long-horizon tasks with delegated subagents",
    pickable: false,
    autoRun: true,
    autoFix: false,
    shouldAutoApplyIfNoEditTool: false,
  },
  {
    id: "plan",
    label: "Plan",
    icon: "list-todo",
    color: "yellow",
    placeholder: "Plan changes",
    description: "Generate an implementation plan",
    pickable: true,
    autoRun: false,
    autoFix: false,
    shouldAutoApplyIfNoEditTool: false,
  },
  {
    id: "debug",
    label: "Debug",
    icon: "bug",
    color: "red",
    placeholder: "Debug issues",
    description: "Pinpoint the root cause of an issue",
    pickable: true,
    autoRun: false,
    autoFix: false,
    shouldAutoApplyIfNoEditTool: true,
  },
  {
    id: "multitask",
    label: "Multitask",
    icon: "circles",
    color: "purple",
    placeholder: "Coordinate tasks",
    description: "Orchestrate multiple subagents in parallel",
    pickable: true,
    autoRun: true,
    autoFix: false,
    shouldAutoApplyIfNoEditTool: true,
  },
  {
    id: "chat",
    label: "Ask",
    icon: "chat",
    color: "green",
    placeholder: "Ask questions",
    description: "Answer questions without making edits",
    pickable: true,
    autoRun: false,
    autoFix: true,
    shouldAutoApplyIfNoEditTool: false,
  },
  // Not chat modes (runtime-verified 3.25.9): kept as enum values for compat.
  // "edit" is the Cmd+K inline-edit flow's internal mode value (submitted by
  // InlineEditService); "background" is a separate composer kind.
  {
    id: "edit",
    label: "Edit",
    icon: "edit",
    color: "default",
    placeholder: "Manual inline-style edits",
    description: "Internal: Cmd+K inline-edit flow (not a chat mode)",
    pickable: false,
    autoRun: false,
    autoFix: false,
    shouldAutoApplyIfNoEditTool: false,
  },
  {
    id: "background",
    label: "Background",
    icon: "cloud",
    color: "default",
    placeholder: "Run as a background agent",
    description: "Internal: background/cloud agent composer kind (not a chat mode)",
    pickable: false,
    autoRun: true,
    autoFix: false,
    shouldAutoApplyIfNoEditTool: true,
  },
];

/** Modes shown in the mode dropdown (Cursor's `odv`: plan/debug/multitask/chat). */
export const DROPDOWN_MODES: ModeName[] = ["plan", "debug", "multitask", "chat"];

/**
 * Shift+Tab cycle order (Cursor's `Jxs`): Agent → Plan → Debug →
 * Multitask → Ask → Agent → … Agent is the `undefined`/default slot.
 */
export const CYCLE_ORDER: ModeName[] = ["agent", "plan", "debug", "multitask", "chat"];

export function cycleMode(current: ModeName): ModeName {
  const idx = CYCLE_ORDER.indexOf(current);
  if (idx === -1) {
    return "agent";
  }
  return CYCLE_ORDER[(idx + 1) % CYCLE_ORDER.length];
}

export function modeDef(mode: ModeName): ModeDef {
  return MODES.find((m) => m.id === mode) ?? MODES[0];
}

export function isPickableMode(mode: ModeName): boolean {
  return modeDef(mode).pickable;
}

/**
 * Modes that may not execute mutating tools. Ask is read-only Q&A
 * ("Answer questions without making edits"); Plan researches and plans
 * but never implements — mutations are blocked at the approval choke
 * point (IdeCodeEngineAdapter.handleApproval) for both.
 */
export const READ_ONLY_MODES: ReadonlySet<ModeName> = new Set<ModeName>(["chat", "plan"]);

/** Engine tool actions that mutate the workspace/machine. Lowercase ids. */
export const MUTATING_TOOL_ACTIONS: ReadonlySet<string> = new Set<string>([
  "edit",
  "write",
  "patch",
  "delete",
  "bash",
  "shell",
  "sh",
  "exec",
  "run",
  "todowrite",
  "task", // subagent tasks can do anything, including edits
]);

export function isReadOnlyMode(mode: ModeName): boolean {
  return READ_ONLY_MODES.has(mode);
}

/**
 * MCP tool-name segments (the `<tool>` part of `mcp__<server>__<tool>`) that
 * are strictly read-only. Grounded in the canonical MCP servers (filesystem,
 * git, fetch, memory, playwright/browser): observation-only tools whose names
 * cannot perform writes, deletes, or command execution. Mirrored in the
 * engine's explore agent (`packages/core/src/indexing/explore.ts`).
 *
 * Fail-closed: in read-only modes (plan/ask) EVERY `mcp__*` tool is treated
 * as mutating EXCEPT these names (see `isMutatingToolAction`). Unknown or
 * future MCP tools are denied by default — the deliberate trade-off the
 * Round B verdicts mandated (deny-by-default beats a name-matching arms
 * race, since real MCP tool names are compound like `write_file`).
 */
export const READ_ONLY_MCP_TOOL_NAMES: ReadonlySet<string> = new Set<string>([
  // file/content observation (filesystem server)
  "read",
  "read_file",
  "read_text_file",
  "read_media_file",
  "read_multiple_files",
  "read_resource",
  "list_directory",
  "list_directory_with_sizes",
  "list_allowed_directories",
  "list_resources",
  "list_resource_templates",
  "directory_tree",
  "search",
  "search_files",
  "get_file_info",
  // knowledge observation (memory server)
  "read_graph",
  "search_nodes",
  "open_nodes",
  // browser observation (playwright/browser server)
  "screenshot",
  "snapshot",
  "browser_screenshot",
  "browser_snapshot",
  // web content (fetch server)
  "fetch",
  // version-control observation (git server)
  "git_status",
  "git_log",
  "git_diff",
  "git_diff_unstaged",
  "git_diff_staged",
  "git_show",
]);

/**
 * Read-only MCP tool-name prefixes (`get_*` per the Round B remediation).
 * A tool named `get_<anything>` is observation-shaped; combined with the
 * fail-closed default above, the residual risk is a server deliberately
 * misnaming a mutating tool — accepted and documented.
 */
export const READ_ONLY_MCP_TOOL_PREFIXES: ReadonlyArray<string> = ["get_"];

export function isMutatingToolAction(action: string): boolean {
  const lower = action.toLowerCase();
  if (MUTATING_TOOL_ACTIONS.has(lower)) return true;
  // P1 (QA-PLANMODE Round B residual): fail-closed for MCP namespaced tools.
  // The old strip-prefix + exact-match-bare-segment logic let real compound
  // tool names (`mcp__filesystem__write_file`, `mcp__git__git_commit`)
  // bypass the read-only gate. Now EVERY `mcp__*` name is mutating in
  // read-only modes unless its tool segment is on the read-only allowlist
  // above. Malformed `mcp__` names (no parseable server/tool) are denied too
  // — the engine never generates them (McpNames.parseToolName/sanitize),
  // so denying is safe.
  if (lower.startsWith("mcp__")) {
    const parsed = parseToolName(lower);
    if (!parsed) return true;
    const tool = parsed.tool.toLowerCase();
    if (READ_ONLY_MCP_TOOL_NAMES.has(tool)) return false;
    return !READ_ONLY_MCP_TOOL_PREFIXES.some((prefix) => tool.startsWith(prefix));
  }
  return false;
}

/**
 * One entry of the engine's `Permission.Ruleset` wire shape
 * (`Permission.Rule = { action, resource, effect }` in
 * `@opencode/schema/permission`). The extension posts plain JSON to
 * `session.create`, so this stays a local structural type rather than
 * importing the engine's schema package.
 */
export interface SessionPermissionRule {
  action: string;
  resource: string;
  effect: "allow" | "deny" | "ask";
}

/**
 * P1 (QA-PLANMODE Round B, P1-2(b)): session-level deny ruleset for
 * read-only modes (plan/ask). Passed as `permissions` in the
 * `session.create` payload by IdeCodeEngineAdapter.ensureSession — pure
 * extension-lane, no engine-side schema work needed: the engine's
 * `Permission.evaluate` uses `findLast`, so session rules override agent
 * rules, and `denied()` raises `BlockedError` with NO `Permission.Event.Asked`
 * (hard block, no approval card). Session permissions ALSO narrow tool
 * discovery (`session/context.ts`), so the model never even sees the tools.
 *
 * Grounded in the engine's actual permission actions (not tool names):
 * write/edit/delete/patch/opencode/plan-create all assert action `"edit"`;
 * shell asserts `"shell"`; subagent `"subagent"`; skill `"skill"`; MCP tools
 * assert the full compound name (`mcp__<server>__<tool>`), so a `mcp__*`
 * glob denies them all. The read-only MCP allowlist (same source of truth
 * as `isMutatingToolAction`) is appended AFTER the blanket deny — findLast
 * means later rules win, so `mcp__filesystem__read_file` stays allowed.
 *
 * Deliberately NOT denied: read/glob/grep/ls (research), webfetch/websearch,
 * question (clarifying questions are the point of plan mode), todo tracking,
 * and coordination tools (communicate/await/switchmode/summary).
 *
 * Agent mode, multitask mode (and every other non-read-only,
 * non-debug mode) returns undefined — the session is created exactly as
 * before, with no permissions payload.
 */
export function sessionPermissionsForMode(mode: ModeName): SessionPermissionRule[] | undefined {
  if (isReadOnlyMode(mode)) return readOnlyModeRules();
  // DIG-DEBUG-MULTITASK (DEV-DEBUG-MULTITASK): debug gets its own ruleset —
  // autoRun=false (shell/MCP ask for approval) without a tool denylist,
  // mirroring Cursor's behavioral (not tool-list) debug restrictions.
  if (mode === "debug") return debugModeRules();
  // "triage" intentionally falls through to undefined: Cursor registers the
  // triage def (enabledTools allowlist [TASK_V2, APPLY_AGENT_DIFF], recorded
  // in customModes.ts) but exposes NO UI path that activates it, so there is
  // no session to gate. If a triage activation path is ever added, enforce
  // the allowlist here instead of inventing behavior now.
  return undefined;
}

/**
 * Extracted verbatim from sessionPermissionsForMode (QA-PLANMODE Round B,
 * P1-2(b)): session-level deny ruleset for read-only modes (plan/ask).
 */
function readOnlyModeRules(): SessionPermissionRule[] {
  const rules: SessionPermissionRule[] = [
    // File mutation (covers write/edit/delete/patch/opencode/plan tools).
    { action: "edit", resource: "*", effect: "deny" },
    // Command execution.
    { action: "shell", resource: "*", effect: "deny" },
    // Subagents and skills can do anything — fail-closed in read-only modes.
    { action: "subagent", resource: "*", effect: "deny" },
    { action: "skill", resource: "*", effect: "deny" },
    // MCP tools: deny-by-default (durable fix for the Round B residual
    // bypass — real MCP names are compound like `write_file`, so a
    // name-matching arms race loses; deny the namespace instead).
    { action: "mcp__*", resource: "*", effect: "deny" },
  ];
  // Read-only MCP allowlist. MUST stay after the mcp__* deny: the engine's
  // findLast picks the last matching rule, so these re-allow observation
  // tools like mcp__filesystem__read_file / mcp__*__get_*.
  for (const tool of READ_ONLY_MCP_TOOL_NAMES) {
    rules.push({ action: `mcp__*__${tool}`, resource: "*", effect: "allow" });
  }
  for (const prefix of READ_ONLY_MCP_TOOL_PREFIXES) {
    rules.push({ action: `mcp__*__${prefix}*`, resource: "*", effect: "allow" });
  }
  return rules;
}

/**
 * Debug-mode session ruleset (DEV-DEBUG-MULTITASK, spec
 * dig-debug-multitask-2026-10-19 §3).
 *
 * Cursor's debug mode has NO client-side tool denylist — its restrictions
 * are behavioral: autoRun=false gates shell/MCP behind approval, while the
 * 6-step debug loop (hypotheses → instrumentation → repro → analyze →
 * targeted fix → cleanup) lives in the system prompt. We mirror that:
 * shell and MCP calls resolve to effect "ask" (the engine raises
 * Permission.Event.Asked → the user sees an approval card) instead of
 * auto-running. File reads — and file EDITS — stay un-gated: autoRun never
 * gates file edits (Cursor staff-confirmed), and Debug's own loop REQUIRES
 * edits (instrumentation, then the targeted fix, then cleanup). The
 * read-only MCP observation allowlist is re-allowed after the mcp__* ask,
 * mirroring the plan/ask structure (engine findLast: later rules win).
 *
 * Deliberate choice (zero-placeholder policy): a hard session-level deny on
 * "edit" would make Debug's documented loop impossible — the mode would be
 * a label again. The investigation discipline (read-only-first, multiple
 * hypotheses, no fix without user confirmation) is enforced by the debug
 * system instruction (buildDebugInstruction) instead.
 */
function debugModeRules(): SessionPermissionRule[] {
  const rules: SessionPermissionRule[] = [
    // autoRun=false: shell commands need approval in Debug mode.
    { action: "shell", resource: "*", effect: "ask" },
    // autoRun=false: MCP calls need approval in Debug mode.
    { action: "mcp__*", resource: "*", effect: "ask" },
  ];
  // Observation tools flow without a card (same source of truth as
  // isMutatingToolAction). MUST stay after the mcp__* ask.
  for (const tool of READ_ONLY_MCP_TOOL_NAMES) {
    rules.push({ action: `mcp__*__${tool}`, resource: "*", effect: "allow" });
  }
  for (const prefix of READ_ONLY_MCP_TOOL_PREFIXES) {
    rules.push({ action: `mcp__*__${prefix}*`, resource: "*", effect: "allow" });
  }
  return rules;
}

/**
 * Plan-mode system instruction. Prepended to the user prompt by
 * ComposerDataService when the turn runs in plan mode, so the agent
 * researches and produces an editable checklist instead of implementing.
 * (Cursor docs: plan mode = clarifying questions → codebase research →
 * plan creation → user review/edit → click-to-build.)
 */
export const PLAN_MODE_INSTRUCTION = [
  "You are in Plan Mode. Your job is to RESEARCH and PLAN — not to implement.",
  "Rules:",
  "1. Read and explore the codebase as needed (read-only tools are fine).",
  "2. If the request is ambiguous, ask clarifying questions first.",
  "3. Produce the plan as a markdown checklist with concrete, ordered steps,",
  "   each step naming the files it touches.",
  "4. Do NOT make any edits, run commands, or create files.",
  "5. End your response with the complete plan checklist.",
].join("\n");

/**
 * Wraps a user prompt for a plan-mode turn. Pure function — unit-tested.
 */
export function wrapPlanPrompt(prompt: string): string {
  return `${PLAN_MODE_INSTRUCTION}\n\n---\n\nUser request:\n${prompt}`;
}

// ---------------------------------------------------------------------------
// Debug mode (DEV-DEBUG-MULTITASK, spec dig-debug-multitask-2026-10-19 §3).
// ---------------------------------------------------------------------------

/**
 * Debug session config — our equivalent of Cursor's
 * `agent.v1.DebugModeConfig{log_path, server_endpoint, session_id}`
 * ([BIN] in the spec). Our wire has no proto field for this, so the config
 * is embedded in the debug system instruction (buildDebugInstruction):
 * the model learns where to POST instrumentation logs, and the NDJSON
 * ingest server (DebugServerService) writes them to logPath.
 */
export interface DebugModeConfig {
  /** Absolute path of the per-session NDJSON log file. */
  logPath: string;
  /** `http://127.0.0.1:<port>/ingest/<targetId>` — POST NDJSON here. */
  serverEndpoint: string;
  /** Debug session id (matches the log file name). */
  sessionId: string;
}

/**
 * Builds the Debug-mode system instruction: the 6-step debug loop from the
 * official Cursor docs (dig-debug-multitask §3.7), with the live
 * DebugModeConfig interpolated. Pure function — unit-tested.
 *
 * Honest divergence: Cursor composes the exact debug prompt server-side
 * into `aiserver.v1.ExplicitContext.mode_specific_context`; the binary
 * never reveals the text. This instruction implements the DOCUMENTED
 * behavior (the 6 steps) instead of guessing at their wording.
 */
export function buildDebugInstruction(config?: DebugModeConfig): string {
  const ingestBlock = config?.serverEndpoint
    ? [
        `Instrumentation endpoint: POST NDJSON log lines to ${config.serverEndpoint}`,
        `  (one JSON object per line: {"ts": <epoch ms>, "level": "info|warn|error", "msg": "...", "file": "<path>", "line": <n>})`,
        `Logs are also persisted to: ${config.logPath} (session "${config.sessionId}") — read that file to analyze what you collected.`,
      ].join("\n")
    : "The instrumentation log server is unavailable for this turn — have the instrumented code append plain JSON lines to a log file under the workspace instead, and read that file back to analyze.";
  return [
    "You are in Debug Mode. Your job is to PINPOINT THE ROOT CAUSE of the reported issue — not to guess-and-patch.",
    "",
    "Follow the debug loop in order:",
    "1. EXPLORE (read-only first): read the relevant code, tests, and recent changes. Make NO edits yet.",
    "2. HYPOTHESIZE: state 2-4 concrete, falsifiable hypotheses about the root cause BEFORE touching code.",
    "3. INSTRUMENT: add lightweight log statements that expose runtime evidence for your hypotheses:",
    ingestBlock,
    "   Then ask the user to REPRODUCE the issue, giving them the exact steps.",
    "4. ANALYZE: read the collected logs and name which hypothesis the runtime evidence supports.",
    "   If the evidence is inconclusive, instrument further — never guess.",
    "5. FIX (user confirmation required): present the root-cause explanation and the targeted fix",
    "   (a few lines) FIRST, and apply it only after the user confirms.",
    "6. VERIFY + CLEAN UP: have the user re-run the repro steps; once the fix is confirmed,",
    "   REMOVE ALL instrumentation you added. Leaving log statements behind is a bug.",
    "",
    "Rules:",
    "- Investigate before you edit: the first edit you make is instrumentation, never the fix.",
    "- Shell commands and MCP calls will ask the user for approval (autoRun is off in Debug mode); file reads flow freely.",
    "- Best for: reproducible-but-mysterious bugs, race conditions/timing issues, perf/memory problems, regressions.",
  ].join("\n");
}

/**
 * Wraps a user prompt for a debug-mode turn. Pure function — unit-tested.
 */
export function wrapDebugPrompt(prompt: string, config?: DebugModeConfig): string {
  return `${buildDebugInstruction(config)}\n\n---\n\nIssue to debug:\n${prompt}`;
}

/**
 * Keywords that auto-switch the composer to Debug mode on submit
 * (spec §3.6/§5 [BIN]: `shouldSuggestDebugMode` matches substrings
 * "debug"/"bug"/"debugging"; skipped when >1 model is selected — our
 * model picker is single-select, so that guard is vacuous here).
 * Pure function — unit-tested.
 */
const DEBUG_MODE_KEYWORDS = ["debug", "bug", "debugging"];

export function shouldSuggestDebugMode(text: string): boolean {
  const lower = text.toLowerCase();
  return DEBUG_MODE_KEYWORDS.some((k) => lower.includes(k));
}
/**
 * Plan-mode auto-suggest keywords — VERBATIM from Cursor 3.25.9
 * (workbench.glass.main.js, composerUtilsService.shouldSuggestPlanMode).
 *
 * The binary matches case-insensitively by substring against the composer
 * text, and ALSO suggests when the text contains a sentence terminator
 * ([.!?]+) or has >= 35 words (see shouldSuggestPlanMode below).
 *
 * 241 unique keywords, multilingual (EN/ES/FR/PT/ZH+pinyin/HI/AR/BN/RU/JA+
 * romaji). Deduplicated from the binary array (which repeats "plan" and
 * "roadmap"). NOTE: the binary list contains NO Vietnamese keywords —
 * adding vi keywords ("kế hoạch", "thiết kế"...) would be OUR heuristic,
 * not Cursor parity, so it is deliberately NOT done here.
 */
export const PLAN_MODE_SUGGEST_KEYWORDS: ReadonlyArray<string> = [
  "plan",
  "planning",
  "refactor",
  "migrate",
  "restructure",
  "design",
  "architect",
  "spec",
  "specify",
  "outline",
  "draft",
  "blueprint",
  "proposal",
  "roadmap",
  "strategy",
  "approach",
  "steps",
  "checklist",
  "timeline",
  "milestones",
  "phased",
  "staged",
  "rollout",
  "implementation",
  "execution",
  "workflow",
  "scope",
  "estimate",
  "breakdown",
  "todo",
  "acceptance criteria",
  "definition of done",
  "计划",
  "重构",
  "迁移",
  "重组",
  "设计",
  "方案",
  "路线图",
  "步骤",
  "草案",
  "蓝图",
  "策略",
  "工作流",
  "时间表",
  "阶段性",
  "执行",
  "范围",
  "估算",
  "任务分解",
  "验收标准",
  "完成定义",
  "jihua",
  "chonggou",
  "qianyi",
  "chongzu",
  "sheji",
  "fangan",
  "luxiantu",
  "buzhou",
  "caoan",
  "lantu",
  "celue",
  "gongzuoliu",
  "shijianbiao",
  "jieduanxing",
  "zhixing",
  "fanwei",
  "gusun",
  "renwufenjie",
  "yanshoubiaozhun",
  "wanchengdingyi",
  "योजना",
  "पुनर्गठन",
  "स्थानांतरण",
  "पुनर्संरचना",
  "रूपरेखा",
  "डिज़ाइन",
  "खाका",
  "कार्ययोजना",
  "समयरेखा",
  "रणनीति",
  "कार्यान्वयन",
  "चरणबद्ध",
  "नक्शा",
  "अनुमान",
  "विभाजन",
  "स्वीकृति मापदंड",
  "पूर्णता परिभाषा",
  "planificar",
  "planificación",
  "refactorización",
  "migrar",
  "reestructurar",
  "diseñar",
  "especificar",
  "hoja de ruta",
  "borrador",
  "pasos",
  "estrategia",
  "implementación",
  "ejecución",
  "flujo de trabajo",
  "cronograma",
  "etapas",
  "estimación",
  "desglose",
  "criterios de aceptación",
  "definición de hecho",
  "planifier",
  "refactoriser",
  "migrer",
  "restructurer",
  "concevoir",
  "spécifier",
  "feuille de route",
  "brouillon",
  "étapes",
  "stratégie",
  "mise en œuvre",
  "exécution",
  "flux de travail",
  "calendrier",
  "phases",
  "estimation",
  "décomposition",
  "critères d'acceptation",
  "définition de terminé",
  "خطة",
  "تخطيط",
  "إعادة هيكلة",
  "ترحيل",
  "إعادة تصميم",
  "تصميم",
  "مخطط",
  "خارطة طريق",
  "مسودة",
  "خطوات",
  "استراتيجية",
  "تنفيذ",
  "جدول زمني",
  "مراحل",
  "تقدير",
  "نطاق",
  "انهيار المهام",
  "معايير القبول",
  "تعريف الاكتمال",
  "পরিকল্পনা",
  "পুনর্গঠন",
  "স্থানান্তর",
  "নকশা",
  "রূপরেখা",
  "রোডম্যাপ",
  "খসড়া",
  "ধাপ",
  "কৌশল",
  "সময়সূচী",
  "বাস্তবায়ন",
  "পর্যায়",
  "আনুমানিক",
  "পরিসর",
  "কাজের প্রবাহ",
  "গ্রহণযোগ্যতার মানদণ্ড",
  "সম্পূর্ণতার সংজ্ঞা",
  "planejar",
  "planejamento",
  "refatorar",
  "reestruturar",
  "desenhar",
  "roteiro",
  "rascunho",
  "estratégia",
  "implementação",
  "execução",
  "fluxo de trabalho",
  "fases",
  "estimativa",
  "escopo",
  "decomposição",
  "critérios de aceitação",
  "definição de concluído",
  "план",
  "планировать",
  "рефакторинг",
  "миграция",
  "реструктуризация",
  "архитектура",
  "спецификация",
  "дорожная карта",
  "черновик",
  "шаги",
  "стратегия",
  "реализация",
  "исполнение",
  "рабочий процесс",
  "график",
  "этапы",
  "оценка",
  "объем",
  "разделение задач",
  "критерии приёмки",
  "определение готовности",
  "計画",
  "リファクタリング",
  "移行",
  "再構築",
  "設計",
  "仕様",
  "仕様書",
  "ロードマップ",
  "戦略",
  "実装",
  "実行",
  "ワークフロー",
  "タイムライン",
  "段階的",
  "見積もり",
  "範囲",
  "分解",
  "受け入れ基準",
  "完了の定義",
  "keikaku",
  "rifakutaringu",
  "ikou",
  "saikouchiku",
  "sekkei",
  "shiyou",
  "shiyousho",
  "roodomaapu",
  "soun",
  "senryaku",
  "jissou",
  "jikkou",
  "waakufurou",
  "taimurain",
  "dankaiteki",
  "mitsumori",
  "han'i",
  "bunkai",
  "ukeire kijun",
  "kanryou no teigi",
];
/**
 * Plan-mode auto-suggest heuristic — EXACT port of Cursor 3.25.9's
 * `composerUtilsService.shouldSuggestPlanMode`
 * (workbench.glass.main.js; see PLAN_MODE_SUGGEST_KEYWORDS above).
 *
 * Binary logic:
 *   1. empty/whitespace-only text → false (and the binary additionally
 *      requires a "plan" mode to exist — vacuously true here: ModeService
 *      always registers plan);
 *   2. lowercased text contains any keyword as a SUBSTRING → true;
 *   3. text contains >= 1 sentence terminator ([.!?]+) → true;
 *   4. text has >= 35 whitespace-separated words → true.
 *
 * Cursor shows this as a `mode_nudge` composer notification ("Plan Mode",
 * click switches mode, dismiss = opt-out) and ONLY on the first message of
 * a conversation (binary: fullConversationHeadersOnly.length===0 &&
 * plan===void 0). The webview mirrors those gates (see composer.ts).
 * Pure function — unit-tested.
 */
export function shouldSuggestPlanMode(text: string): boolean {
  if (!text || text.trim().length === 0) {
    return false;
  }
  const lower = text.toLowerCase();
  if (PLAN_MODE_SUGGEST_KEYWORDS.some((k) => lower.includes(k))) {
    return true;
  }
  if ((text.match(/[.!?]+/g) || []).length >= 1) {
    return true;
  }
  const words = text.trim().split(/\s+/).filter((w) => w.length > 0);
  return words.length >= 35;
}


// ---------------------------------------------------------------------------
// Multitask mode (DEV-DEBUG-MULTITASK, spec dig-debug-multitask-2026-10-19 §4).
// ---------------------------------------------------------------------------

/**
 * Default cap on concurrently running subagents in Multitask mode —
 * our stand-in for Cursor's `agent.v1.AgentHostLocalSubagentLimits{
 * max_running }` (the configured default is server/experiment-driven and
 * not in the binary, so we pick a value that fits this machine).
 */
export const MULTITASK_MAX_RUNNING = 4;

/**
 * Multitask-mode system instruction: orchestration posture. Our engine has
 * no server-side subagent fan-out, so the EXTENSION orchestrates the real
 * flow itself (MultitaskService): decompose the request → one git worktree
 * per subtask (unique filesystem-safe branch, no "/") → parallel engine
 * worker sessions capped at MULTITASK_MAX_RUNNING (4) → each worker reports
 * branch + summary → the composer runs a synthesis turn over the results.
 * Pure function — unit-tested.
 *
 * Fallback note kept: if orchestration cannot start (no git repo, decompose
 * produced no subtasks), the turn degrades to the engine's `subagent` tool
 * with `background: true` — parallel dispatch without per-worker worktree
 * isolation.
 */
export const MULTITASK_MODE_INSTRUCTION = [
  "You are in Multitask Mode. You are an ORCHESTRATOR — you do not implement everything yourself.",
  "",
  "The extension orchestrates the real multitask flow for you:",
  "1. DECOMPOSE the request into 2-6 independent subtasks that can run in parallel.",
  "   Subtasks must not touch the same files; if two pieces of work share files,",
  "   merge them into one subtask.",
  "2. Each subtask gets its own git worktree under a unique branch (no '/'), and a",
  `   dedicated worker agent session runs inside that worktree. At most ${MULTITASK_MAX_RUNNING} workers run at once; the rest queue.`,
  "3. Every worker reports back its branch name, a short summary, and the files it changed.",
  "4. When workers complete, SYNTHESIZE: resolve conflicts, wire the pieces together,",
  "   and present the combined result with the branch/worktree paths so the user can review and merge.",
  "5. While workers run, do NOT duplicate their work — summarize what was launched",
  "   and what is pending. If a subtask fails, retry it once with a narrower scope.",
  "",
  "Fallback: if orchestration cannot start (no git repository, or the request does not",
  "split into subtasks), dispatch with the `subagent` tool using `background: true` —",
  "parallel dispatch without per-worker worktree isolation — and keep subtasks file-disjoint.",
].join("\n");

/**
 * Wraps a user prompt for a multitask-mode turn. Pure function — unit-tested.
 */
export function wrapMultitaskPrompt(prompt: string): string {
  return `${MULTITASK_MODE_INSTRUCTION}\n\n---\n\nRequest to orchestrate:\n${prompt}`;
}

/**
 * ModeService — per-chat mode state. One instance is owned by each
 * ComposerDataService (i.e. per chat tab), never shared globally.
 * Cursor stores mode as `unifiedMode` in per-composer data; an absent
 * mode resolves to agent (the default).
 */
export class ModeService {
  private current: ModeName = "agent";
  private readonly emitter = new vscode.EventEmitter<ModeName>();
  readonly onDidChangeMode = this.emitter.event;

  getMode(): ModeName {
    return this.current;
  }

  /**
   * Invalid mode ids default to "agent" (Cursor: "Composer unifiedMode
   * invalid; defaulting to agent"). Never throws on bad input.
   */
  setMode(mode: string): void {
    const next = (MODES.some((m) => m.id === mode) ? mode : "agent") as ModeName;
    if (next === this.current) {
      return;
    }
    this.current = next;
    this.emitter.fire(next);
  }

  /** New chat → back to the default mode (agent). */
  reset(): void {
    this.setMode("agent");
  }

  labelFor(mode: ModeName): string {
    return modeDef(mode).label;
  }

  defFor(mode: ModeName): ModeDef {
    return modeDef(mode);
  }
}

// ---------------------------------------------------------------------------
// Custom-mode runtime (GAPS-46D — agent-custom-modes).
//
// Binary evidence (Cursor 3.25.9, workbench.glass.main.js):
//   - `activeCustomMode` / `committedCustomMode` / `pendingExitedCustomMode`
//     on composer data; `customModeIntent` enter/exit with
//     `modeOverride:CUSTOM`; `customModeSessionId`; `turnsInMode`.
//   - Badge appearance: `Ncs({icon:"icon"in t?t.icon:void 0,
//     colorId:"color"in t?t.color:void 0})`, defaulting to
//     `{icon:"lightning",colorId:"default"}`.
//   - Skill-file-vanished notification (verbatim):
//     `'${label}' mode couldn't be applied — its skill file may have been
//     renamed or removed. Message sent without it.`
// Docs (cursor.com/docs/agent/prompting, verified 2026-10-20):
//   - "Inside a mode, the skill stays in context on every turn, even as the
//     agent works for hours, until you exit the mode."
//   - "the optional `icon` and `color` frontmatter fields style the mode's
//     badge."
//   - Entry: pick the skill from the `/` menu and press Option+Enter /
//     Alt+Enter (Mac) or Alt+Enter (Windows), or "Use as Mode" on the skill
//     entry. "Any skill with a valid frontmatter block can back a mode."
//   - "Custom Modes are available in the Agents Window and the CLI."
//
// HONEST DIVERGENCES:
//   - The exact per-turn injection envelope is minified (UNKNOWN); the
//     observable behavior — skill content present in the agent's context on
//     every turn while the mode is active — is what we mirror, using the
//     same envelope shape as the plan-mode wrapper.
//   - Custom modes ride as an `activeCustomMode` overlay on the composer
//     (unifiedMode unchanged), exactly like the binary.
// ---------------------------------------------------------------------------

/** Skill data needed to enter a custom mode. */
export interface CustomModeSkillSource {
  name: string;
  /** Full SKILL.md content (frontmatter + body). */
  content: string;
  filePath: string;
  icon?: string;
  color?: string;
}

/**
 * The active custom-mode session on a composer — the extension-tier mirror
 * of the binary's composer-data fields (`activeCustomMode`,
 * `customModeSessionId`, `turnsInMode`).
 */
export interface CustomModeSession {
  /** Binary `customModeSessionId` — unique per activation. */
  sessionId: string;
  /** Local mode id (`custom-mode:<skill-name>`). */
  modeId: string;
  /** Display label (the skill name). */
  label: string;
  skillName: string;
  /** Skill body with frontmatter stripped — injected every turn. */
  skillBody: string;
  skillFilePath: string;
  icon?: string;
  color?: string;
  /** Binary `turnsInMode` — incremented on every submitted turn. */
  turnsInMode: number;
}

/** Binary default badge appearance when frontmatter has no icon/color. */
export const CUSTOM_MODE_DEFAULT_ICON = "lightning";
export const CUSTOM_MODE_DEFAULT_COLOR_ID = "default";

/** Strip a leading `---` YAML frontmatter block; returns the body as-is otherwise. */
export function stripSkillFrontmatter(raw: string): string {
  const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  return m ? raw.slice(m[0].length) : raw;
}

/**
 * Create a custom-mode session from a skill. Requires a valid frontmatter
 * block with a name (docs: "Any skill with a valid frontmatter block can
 * back a mode") — returns null when the skill has no name.
 */
export function createCustomModeSession(
  skill: CustomModeSkillSource,
  idFactory?: () => string,
): CustomModeSession | null {
  const name = skill.name.trim();
  if (!name) {
    return null;
  }
  const makeId =
    idFactory ??
    (() => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`);
  return {
    sessionId: makeId(),
    modeId: `custom-mode:${name.toLowerCase()}`,
    label: name,
    skillName: name,
    skillBody: stripSkillFrontmatter(skill.content).trim(),
    skillFilePath: skill.filePath,
    ...(skill.icon !== undefined ? { icon: skill.icon } : {}),
    ...(skill.color !== undefined ? { color: skill.color } : {}),
    turnsInMode: 0,
  };
}

/**
 * Pure increment of `turnsInMode` (binary `FEk`: `{...n, turnsInMode:
 * n.turnsInMode + 1}`). Returns a new session object.
 */
export function incrementCustomModeTurns(session: CustomModeSession): CustomModeSession {
  return { ...session, turnsInMode: session.turnsInMode + 1 };
}

/**
 * Wrap the engine-bound prompt so the skill stays in context on every turn
 * while the mode is active (docs: "the skill stays in context on every
 * turn"). Injected into the engine-bound prompt only — never the displayed
 * human bubble — mirroring the plan-mode wrapper.
 */
export function wrapCustomModePrompt(session: CustomModeSession, prompt: string): string {
  const body = session.skillBody;
  const header = `[Custom mode: ${session.label}]`;
  return body ? `${header}\n${body}\n\n---\n\nUser request:\n${prompt}` : prompt;
}

/**
 * Badge appearance for the chat-input badge (binary `Ncs()`): frontmatter
 * icon/color, falling back to the binary's defaults.
 */
export function customModeBadgeAppearance(session: CustomModeSession): {
  icon: string;
  colorId: string;
} {
  return {
    icon: session.icon?.trim() || CUSTOM_MODE_DEFAULT_ICON,
    colorId: session.color?.trim() || CUSTOM_MODE_DEFAULT_COLOR_ID,
  };
}

/**
 * Binary-verbatim notification shown when the mode's skill file vanished
 * between turns: `'<label>' mode couldn't be applied — its skill file may
 * have been renamed or removed. Message sent without it.`
 */
export function buildSkillMissingNotification(label: string): string {
  return `'${label}' mode couldn't be applied \u2014 its skill file may have been renamed or removed. Message sent without it.`;
}

/**
 * Per-turn preflight decision for an active custom mode. Pure — the caller
 * supplies whether the skill file still exists on disk.
 */
export function planCustomModeTurn(
  session: CustomModeSession,
  skillFileExists: boolean,
): { skillBody: string | null; dropped: boolean } {
  if (!skillFileExists) {
    return { skillBody: null, dropped: true };
  }
  return { skillBody: session.skillBody, dropped: false };
}
