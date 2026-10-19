import * as vscode from "vscode";
import { ModeName } from "../model";

/**
 * ModeService — owns the unifiedMode enum and its mapping.
 *
 * Runtime truth (Cursor 3.25.9, verified live via CDP 2026-10-19):
 * exactly 5 chat modes — Agent / Ask / Debug / Multitask / Plan.
 * "Edit" is NOT a chat mode: it is the Cmd+K inline-edit flow's internal
 * mode value (used by InlineEditService when it submits to the engine).
 * "Background" is a separate composer kind (cloud/background agents), not
 * a chat mode. Both are kept as enum values for compat but are never
 * listed in the picker, the palette, or the Shift+Tab cycle.
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

export function isMutatingToolAction(action: string): boolean {
  const lower = action.toLowerCase();
  if (MUTATING_TOOL_ACTIONS.has(lower)) return true;
  // P1 (QA-PLANMODE-01): MCP tool actions are Cursor-namespaced
  // (mcp__<server>__<tool>) and never match the bare set above — a mutating
  // MCP tool (e.g. mcp__fs__write) would bypass the plan/ask read-only gate.
  // Classify by the tool segment; read-only MCP tools (mcp__fs__read,
  // mcp__browser__screenshot) stay allowed.
  if (lower.startsWith("mcp__")) {
    const parts = lower.split("__");
    if (parts.length >= 3 && parts[1]) {
      const tool = parts.slice(2).join("__");
      return MUTATING_TOOL_ACTIONS.has(tool);
    }
  }
  return false;
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
