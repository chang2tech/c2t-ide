/**
 * Subagent preview tray — Cursor `glass.openSubagentPreviewInAgentsTray` parity.
 *
 * Binary evidence (Cursor 3.25.x):
 * - 3.25.6 glass bundle (`workbench.glass.main.js`):
 *   `Ir({id:"openSubagentPreviewInAgentsTray",
 *        title:"Open subagent preview in agents tray",
 *        icon:"plus", glassCategory:"Agent", f1:!1, run:...})`
 *   Args schema (zod, `eAx`):
 *   `Ge.object({composerId:Ge.string(), name:Ge.string(),
 *     initialPrompt:Ge.string().optional(),
 *     initialPromptTaskToolCallId:Ge.string().optional(),
 *     environment:Jxx.optional()})`
 *   The handler `safeParse`s the args and emits
 *   `{type:"openSubagentPreviewInAgentsTrayRequested",
 *     payload:{composerId, name, initialPrompt, initialPromptTaskToolCallId,
 *       environment}}` on the glass event bus; the Agents Window tray UI
 *   consumes the event and opens the subagent preview.
 * - 3.25.9 desktop bundle (`workbench.desktop.main.js`): 4
 *   `executeCommand("glass.openSubagentPreviewInAgentsTray", {...})` call
 *   sites — the subagent tool-card "open" action (spawned subagent), clicking
 *   a subagent bubble/entry in the parent chat (glass), and the
 *   `glass.tryOpenSubagentPreviewById` fallback chain
 *   (`tryOpenSubagentPreviewById` → `openSubagentPreviewInAgentsTray` →
 *   `openAgentById`). Environment is `"cloud"|"local"`
 *   (`environment:wc(o)?"cloud":"local"`).
 *
 * Our analog: `ide.openSubagentPreviewInAgentsTray` (extension command,
 * palette-hidden like Cursor's f1:!1). The handler validates args against
 * Cursor's schema, opens/focuses the Agents Window (the "agents tray"
 * surface — via `ide.openAgentsWindow` → `ide.openOrFocusGlassWindow`, the
 * Cursor `cursor.openOrFocusGlassWindow` analog), records the request in the
 * preview tracker, and emits `openSubagentPreviewInAgentsTrayRequested`
 * (Cursor's verbatim event name) for tray consumers.
 *
 * HONEST-DIVERGENCE: Cursor's tray is a React surface inside its glass
 * (Agents) window fed by a cross-window synced event bus. Our fork has the
 * glass window mechanism (`ide.openOrFocusGlassWindow`) but not the glass
 * React tray UI, and extension-host events are per-window — so the event
 * emitted here reaches in-window consumers only. The tracker
 * (`getRequestedPreviews`) is the data source the future tray UI reads;
 * the event name and payload shape match Cursor's so the UI can subscribe
 * unchanged. Call sites (subagent tool-card open action, subagent bubble
 * click) will be wired once client-side subagent composer IDs exist — our
 * subagents currently run engine-side via the task tool with no client
 * composerId to pass.
 */

import { EventEmitter } from "node:events";

/** Cursor's command id, namespaced to our extension (`glass.*` → `ide.*`). */
export const OPEN_SUBAGENT_PREVIEW_IN_AGENTS_TRAY_COMMAND =
  "ide.openSubagentPreviewInAgentsTray";

/** Cursor's title, verbatim (3.25.6 glass bundle). */
export const OPEN_SUBAGENT_PREVIEW_TITLE = "Open subagent preview in agents tray";

/**
 * Cursor's event name, verbatim. Emitted on the (window-local) event bus
 * with the validated args as payload — the same contract the Agents Window
 * tray UI subscribes to in Cursor.
 */
export const SUBAGENT_PREVIEW_REQUESTED_EVENT =
  "openSubagentPreviewInAgentsTrayRequested";

/** `agentsWindowOpenSource` value used when routing a preview request. */
export const SUBAGENT_PREVIEW_WINDOW_SOURCE = "subagent_preview_tray";

/** Cursor's `Jxx` environment enum: `"cloud"|"local"`. */
export type SubagentPreviewEnvironment = "cloud" | "local";

/**
 * Args for `ide.openSubagentPreviewInAgentsTray`.
 * Mirrors Cursor's zod schema `eAx` field-for-field.
 */
export interface SubagentPreviewArgs {
  /** The subagent's composer/agent id. */
  composerId: string;
  /** Display name shown in the tray (Cursor falls back to "Subagent"). */
  name: string;
  /** Optional prompt to seed the preview with. */
  initialPrompt?: string;
  /** Tool-call id that spawned the subagent (for attribution). */
  initialPromptTaskToolCallId?: string;
  /** Where the subagent runs. */
  environment?: SubagentPreviewEnvironment;
}

/**
 * Validates raw command args against Cursor's schema.
 * Returns the normalized args, or null when they fail validation
 * (Cursor's `safeParse` failure → the handler does nothing).
 */
export function parseSubagentPreviewArgs(
  raw: unknown,
): SubagentPreviewArgs | null {
  if (typeof raw !== "object" || raw === null) {
    return null;
  }
  const o = raw as Record<string, unknown>;
  if (typeof o.composerId !== "string" || o.composerId.length === 0) {
    return null;
  }
  if (typeof o.name !== "string" || o.name.length === 0) {
    return null;
  }
  const args: SubagentPreviewArgs = {
    composerId: o.composerId,
    name: o.name,
  };
  if (o.initialPrompt !== undefined) {
    if (typeof o.initialPrompt !== "string") {
      return null;
    }
    args.initialPrompt = o.initialPrompt;
  }
  if (o.initialPromptTaskToolCallId !== undefined) {
    if (typeof o.initialPromptTaskToolCallId !== "string") {
      return null;
    }
    args.initialPromptTaskToolCallId = o.initialPromptTaskToolCallId;
  }
  if (o.environment !== undefined) {
    if (o.environment !== "cloud" && o.environment !== "local") {
      return null;
    }
    args.environment = o.environment;
  }
  return args;
}

/** A preview request recorded for the tray UI. */
export interface SubagentPreviewEntry extends SubagentPreviewArgs {
  /** When the preview was requested (ms since epoch). */
  requestedAt: number;
}

export interface SubagentPreviewDeps {
  executeCommand: (
    command: string,
    args?: unknown,
  ) => Promise<unknown> | unknown;
  /** Clock for entry timestamps (injectable for tests). */
  now?: () => number;
}

/**
 * Owns subagent-preview requests. Emits
 * `openSubagentPreviewInAgentsTrayRequested` (Cursor's event) and keeps the
 * ordered request list the tray UI renders.
 */
export class SubagentPreviewService extends EventEmitter {
  private readonly executeCommand: SubagentPreviewDeps["executeCommand"];
  private readonly now: () => number;
  private readonly entries: SubagentPreviewEntry[] = [];

  constructor(deps: SubagentPreviewDeps) {
    super();
    this.executeCommand = deps.executeCommand;
    this.now = deps.now ?? Date.now;
  }

  /**
   * Handles `ide.openSubagentPreviewInAgentsTray`.
   * Returns true when the request was accepted (Cursor's handler returns
   * truthy on success), false when args fail validation.
   */
  async requestPreview(rawArgs: unknown): Promise<boolean> {
    const args = parseSubagentPreviewArgs(rawArgs);
    if (!args) {
      return false;
    }
    // The preview lives in the Agents Window ("agents tray") — open/focus
    // it first, mirroring Cursor's agents-window surface routing.
    await this.executeCommand("ide.openAgentsWindow", {
      agentsWindowOpenSource: SUBAGENT_PREVIEW_WINDOW_SOURCE,
    });
    const entry: SubagentPreviewEntry = { ...args, requestedAt: this.now() };
    this.entries.push(entry);
    this.emit(SUBAGENT_PREVIEW_REQUESTED_EVENT, args);
    return true;
  }

  /** Ordered preview requests, oldest first — the tray UI's data source. */
  getRequestedPreviews(): readonly SubagentPreviewEntry[] {
    return this.entries;
  }

  /** Latest request for a composer, if any. */
  getPreviewFor(composerId: string): SubagentPreviewEntry | undefined {
    for (let i = this.entries.length - 1; i >= 0; i--) {
      if (this.entries[i].composerId === composerId) {
        return this.entries[i];
      }
    }
    return undefined;
  }

  dispose(): void {
    this.removeAllListeners();
    this.entries.length = 0;
  }
}
