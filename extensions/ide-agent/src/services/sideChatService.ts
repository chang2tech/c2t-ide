import * as vscode from "vscode";

/**
 * SideChatService — Cursor "side chat" parity (agent-side-chat).
 *
 * EVIDENCE (docs, cursor.com/docs/agent): "A side chat is a durable agent
 * conversation. It uses the parent thread as hidden reference context and
 * keeps its own transcript."
 *
 * EVIDENCE (binary, Cursor 3.25.6, workbench.glass.main.js): command palette
 * entry name:"side", searchAliases:["btw"], description:"Start a side chat
 * for this conversation". Command IDs: newSideChatAction, openSideChat,
 * openSideChatAgentId, openSideChatTab, openSideChats. State keys:
 * sideChatAvailable, sideChatCreationRejectedReason, sideChatId, sideChatInfo,
 * sideChatSeedTurnCount, sideChatBoundaryInjected.
 *
 * Model: a SideChat is a durable conversation for a tangent — it owns its
 * own transcript, while the parent thread is snapshotted once at creation
 * into `hiddenParentContext` (never rendered in the UI; background reference
 * for the agent only). Creating/activating/closing a side chat never touches
 * the parent tab's transcript.
 *
 * SCOPE: this service owns state + commands. Rendering/focusing the side
 * chat in the workbench and executing agent turns inside it are the host's
 * job (wired by the parent in extension.ts) — the exact surfaces Cursor
 * uses for those are UNKNOWN, so this file injects them as callbacks.
 */

/** One turn in a side chat's own transcript (the only thing the UI shows). */
export interface SideChatTurn {
  role: "human" | "agent";
  text: string;
  createdAt: number;
}

/**
 * Hidden reference context: the parent thread snapshot used as background.
 * Never rendered — the agent sees it as reference context only, keeping the
 * main thread's flow uninterrupted (the docs quote above).
 */
export interface HiddenParentContext {
  /** Parent thread snapshot at creation, oldest → newest. */
  turns: Array<{ role: "human" | "agent"; text: string }>;
  /**
   * How many parent turns were seeded into the reference context. Mirrors
   * Cursor's `sideChatSeedTurnCount` state key. Whether Cursor seeds raw
   * turns or a summary, and what its cap is, is UNKNOWN — we seed up to
   * `maxSeedTurns` raw turns.
   */
  seedTurnCount: number;
  /**
   * Whether a boundary marker separating the parent reference context from
   * the side chat's own transcript was injected. The binary exposes
   * `sideChatBoundaryInjected` as a state key, so the flag exists; the exact
   * marker text/format Cursor injects is UNKNOWN.
   */
  boundaryInjected: boolean;
  capturedAt: number;
}

export interface SideChat {
  id: string;
  /** The chat tab this side chat was spawned from. */
  parentChatId: string;
  /** The side chat's own transcript — independent of the parent's. */
  transcript: SideChatTurn[];
  /** Parent thread snapshot; hidden reference context, never rendered. */
  hiddenParentContext: HiddenParentContext;
  title: string;
  createdAt: number;
}

/** Public summary for lists / QuickPick-style UIs. */
export interface SideChatInfo {
  id: string;
  parentChatId: string;
  title: string;
  turnCount: number;
  seedTurnCount: number;
  active: boolean;
  createdAt: number;
}

export type SideChatEvent =
  | { kind: "sideChatsChanged" }
  | { kind: "sideChatActivated"; id: string }
  | { kind: "turnAppended"; id: string }
  | { kind: "sideChatClosed"; id: string };

/**
 * Command IDs. Cursor binary IDs are noted in comments; we register under
 * our own `ide.*` namespace (same convention as ide.reopenChatTab etc.).
 *
 * NOTE (wiring): Cursor's palette alias for the create command is "btw"
 * (searchAliases:["btw"]). package.json `contributes.commands` is not
 * touched by this file — add the alias there when wiring.
 */
export const SideChatCommands = {
  /** binary: newSideChatAction — "Start a side chat for this conversation" */
  create: "ide.newSideChat",
  /** binary: openSideChat */
  open: "ide.openSideChat",
  /** binary: openSideChatAgentId — exact argument semantics UNKNOWN (see openSideChatForAgent) */
  openByAgentId: "ide.openSideChatAgentId",
  /** binary: openSideChatTab — how Cursor renders it (tab vs sidebar) UNKNOWN; we reveal via the host */
  openTab: "ide.openSideChatTab",
  /** binary: openSideChats — list; QuickPick presentation is the host's job */
  list: "ide.openSideChats",
} as const;

/**
 * Context keys, remapped from Cursor's `sideChat*` state keys into our
 * `ide.*` namespace. Cursor's exact truth conditions for each key are
 * UNKNOWN beyond the key names; documented choices below are ours.
 */
export const SideChatContextKeys = {
  /** binary: sideChatAvailable — true when creation is not currently rejected */
  available: "ide.sideChatAvailable",
  /** binary: sideChatCreationRejectedReason — reason string, or undefined */
  creationRejectedReason: "ide.sideChatCreationRejectedReason",
  /** binary: sideChatId — active side chat id, or undefined */
  activeId: "ide.sideChatId",
  /** binary: sideChatInfo — summary of the active side chat, or undefined */
  activeInfo: "ide.sideChatInfo",
  /** binary: sideChatSeedTurnCount — parent turns seeded into hidden context */
  seedTurnCount: "ide.sideChatSeedTurnCount",
  /** binary: sideChatBoundaryInjected — boundary marker injected */
  boundaryInjected: "ide.sideChatBoundaryInjected",
} as const;

export interface SideChatServiceDeps {
  /**
   * Snapshot the parent chat's transcript (oldest → newest) for the hidden
   * reference context. Called once per side chat, at creation.
   */
  getParentTranscript: (
    parentChatId: string,
  ) => Array<{ role: string; text: string }>;
  /**
   * Bring the side chat into view (implemented by the webview host when
   * wired). Must never throw — the service guards the call.
   */
  revealSideChat: (chat: SideChat) => void;
  /** Resolve the default parent when the caller doesn't pass one. */
  getActiveChatId?: () => string | undefined;
  /** Max parent turns seeded into hidden context. Default 20. */
  maxSeedTurns?: number;
}

/** Per-turn text cap for the hidden snapshot (implementation choice). */
const MAX_SEED_TEXT_CHARS = 8000;

/** Auto-title from the first user message (mirrors ChatTabService). */
function titleFromText(text: string): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  if (oneLine.length <= 28) {
    return oneLine || "Side chat";
  }
  return `${oneLine.slice(0, 28)}…`;
}

let sideChatSeq = 0;

export class SideChatService implements vscode.Disposable {
  private readonly chats = new Map<string, SideChat>();
  private activeId: string | undefined;
  private lastRejection: string | undefined;
  private readonly emitter = new vscode.EventEmitter<SideChatEvent>();
  readonly onDidChange = this.emitter.event;

  constructor(private readonly deps: SideChatServiceDeps) {
    this.syncContext();
  }

  /** The currently active side chat, if any. */
  getActiveSideChat(): SideChat | undefined {
    return this.activeId ? this.chats.get(this.activeId) : undefined;
  }

  getSideChat(id: string): SideChat | undefined {
    return this.chats.get(id);
  }

  get sideChatCount(): number {
    return this.chats.size;
  }

  /** Why the last creation was rejected (undefined when creation is allowed). */
  get creationRejectedReason(): string | undefined {
    return this.lastRejection;
  }

  listSideChats(): SideChatInfo[] {
    return [...this.chats.values()]
      .sort((a, b) => a.createdAt - b.createdAt)
      .map((c) => ({
        id: c.id,
        parentChatId: c.parentChatId,
        title: c.title,
        turnCount: c.transcript.length,
        seedTurnCount: c.hiddenParentContext.seedTurnCount,
        active: c.id === this.activeId,
        createdAt: c.createdAt,
      }));
  }

  /**
   * Start a side chat for a parent conversation.
   *
   * Captures the parent transcript once into `hiddenParentContext` (the
   * "hidden reference context" from the docs evidence) and starts the side
   * chat with its own empty transcript — optionally seeded with the tangent
   * question as the first human turn. The new side chat becomes active and
   * is revealed via the host.
   *
   * Rejects (returns undefined) when no parent chat can be resolved — the
   * `sideChatAvailable` / `sideChatCreationRejectedReason` channel mirrors
   * Cursor's state keys. Cursor's exact rejection conditions are UNKNOWN;
   * ours is minimal: no resolvable parent → rejected.
   */
  createSideChat(opts?: {
    parentChatId?: string;
    seedQuestion?: string;
    title?: string;
  }): SideChat | undefined {
    const parentChatId =
      opts?.parentChatId ?? this.deps.getActiveChatId?.();
    if (!parentChatId) {
      this.rejectCreation("no-active-parent-chat");
      return undefined;
    }
    sideChatSeq += 1;
    const id = `sidechat-${sideChatSeq}`;
    const maxSeed = this.deps.maxSeedTurns ?? 20;
    const turns = this.captureParentContext(parentChatId, maxSeed);
    const seedQuestion = opts?.seedQuestion?.trim();
    const chat: SideChat = {
      id,
      parentChatId,
      transcript: [],
      hiddenParentContext: {
        turns,
        seedTurnCount: turns.length,
        boundaryInjected: true,
        capturedAt: Date.now(),
      },
      title:
        opts?.title?.trim() ||
        (seedQuestion ? titleFromText(seedQuestion) : "Side chat"),
      createdAt: Date.now(),
    };
    this.chats.set(id, chat);
    if (seedQuestion) {
      this.appendTurn(id, "human", seedQuestion);
    }
    this.lastRejection = undefined;
    this.activeId = id;
    this.emitter.fire({ kind: "sideChatsChanged" });
    this.emitter.fire({ kind: "sideChatActivated", id });
    try {
      this.deps.revealSideChat(chat);
    } catch {
      /* reveal must never break creation */
    }
    this.syncContext();
    return chat;
  }

  /**
   * Activate a side chat (defaults to the current active / most recent one)
   * and reveal it via the host. The parent thread is untouched.
   */
  openSideChat(id?: string): boolean {
    const target = id
      ? this.chats.get(id)
      : this.activeId
        ? this.chats.get(this.activeId)
        : [...this.chats.values()].pop();
    if (!target) {
      return false;
    }
    this.activeId = target.id;
    this.emitter.fire({ kind: "sideChatActivated", id: target.id });
    try {
      this.deps.revealSideChat(target);
    } catch {
      /* reveal must never break activation */
    }
    this.syncContext();
    return true;
  }

  /**
   * binary: openSideChatAgentId. The exact meaning of "agent id" in Cursor is
   * UNKNOWN — it may denote the side chat itself or the parent
   * conversation/agent it belongs to. We resolve in that order: direct side
   * chat id first, then the most recent side chat spawned from a parent with
   * that id. Returns false when nothing matches (no creation — that would be
   * inventing behavior).
   */
  openSideChatForAgent(agentId: string): boolean {
    if (!agentId) {
      return false;
    }
    const direct = this.chats.get(agentId);
    if (direct) {
      return this.openSideChat(direct.id);
    }
    let latest: SideChat | undefined;
    for (const c of this.chats.values()) {
      if (
        c.parentChatId === agentId &&
        (!latest || c.createdAt >= latest.createdAt)
      ) {
        latest = c;
      }
    }
    return latest ? this.openSideChat(latest.id) : false;
  }

  /** Append a turn to the side chat's own transcript. */
  appendTurn(id: string, role: "human" | "agent", text: string): boolean {
    const chat = this.chats.get(id);
    const clean = text.trim();
    if (!chat || clean.length === 0) {
      return false;
    }
    chat.transcript.push({ role, text: clean, createdAt: Date.now() });
    // Auto-title from the first human message (mirrors ChatTabService).
    if (chat.title === "Side chat" && role === "human") {
      chat.title = titleFromText(clean);
      this.emitter.fire({ kind: "sideChatsChanged" });
    }
    this.emitter.fire({ kind: "turnAppended", id });
    this.syncContext();
    return true;
  }

  /** Close a side chat. The parent thread is untouched. */
  closeSideChat(id: string): boolean {
    const chat = this.chats.get(id);
    if (!chat) {
      return false;
    }
    this.chats.delete(id);
    if (this.activeId === id) {
      this.activeId = [...this.chats.keys()].pop();
    }
    this.emitter.fire({ kind: "sideChatClosed", id });
    this.syncContext();
    return true;
  }

  private captureParentContext(
    parentChatId: string,
    maxSeed: number,
  ): Array<{ role: "human" | "agent"; text: string }> {
    let raw: Array<{ role: string; text: string }>;
    try {
      raw = this.deps.getParentTranscript(parentChatId) ?? [];
    } catch {
      raw = [];
    }
    return raw
      .slice(-Math.max(0, maxSeed))
      .map((t): { role: "human" | "agent"; text: string } => ({
        // Composer bubbles use "assistant"; the side-chat model uses "agent".
        role: t.role === "agent" || t.role === "assistant" ? "agent" : "human",
        text: t.text.slice(0, MAX_SEED_TEXT_CHARS),
      }))
      .filter((t) => t.text.trim().length > 0);
  }

  private rejectCreation(reason: string): void {
    this.lastRejection = reason;
    this.emitter.fire({ kind: "sideChatsChanged" });
    this.syncContext();
  }

  private setContextKey(key: string, value: unknown): void {
    try {
      void vscode.commands.executeCommand("setContext", key, value);
    } catch {
      /* context sync must never throw */
    }
  }

  /** Sync Cursor's `sideChat*` state keys (remapped under `ide.*`). */
  private syncContext(): void {
    const active = this.activeId ? this.chats.get(this.activeId) : undefined;
    this.setContextKey(
      SideChatContextKeys.available,
      this.lastRejection === undefined,
    );
    this.setContextKey(
      SideChatContextKeys.creationRejectedReason,
      this.lastRejection,
    );
    this.setContextKey(SideChatContextKeys.activeId, active?.id);
    this.setContextKey(
      SideChatContextKeys.activeInfo,
      active
        ? {
            id: active.id,
            parentChatId: active.parentChatId,
            title: active.title,
            turnCount: active.transcript.length,
            seedTurnCount: active.hiddenParentContext.seedTurnCount,
            createdAt: active.createdAt,
          }
        : undefined,
    );
    this.setContextKey(
      SideChatContextKeys.seedTurnCount,
      active?.hiddenParentContext.seedTurnCount ?? 0,
    );
    this.setContextKey(
      SideChatContextKeys.boundaryInjected,
      active?.hiddenParentContext.boundaryInjected ?? false,
    );
  }

  dispose(): void {
    this.chats.clear();
    this.activeId = undefined;
    this.emitter.dispose();
  }
}

export interface SideChatCommandRegistrar {
  service: SideChatService;
  context: vscode.ExtensionContext;
  /**
   * Command registrar. Defaults to `vscode.commands.registerCommand`;
   * inject a fake in unit tests (the shared vscode-stub has no
   * registerCommand surface).
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  registerCommand?: (
    id: string,
    handler: (...args: any[]) => unknown,
  ) => vscode.Disposable;
}

/**
 * Register the side-chat commands under `ide.*` (Cursor binary IDs in
 * `SideChatCommands` comments). Returns the disposables; they are also
 * pushed to `context.subscriptions`.
 *
 * WIRING (for the parent — one line):
 *   registerSideChatCommands({ service: new SideChatService({ getParentTranscript: (id) => chatTabService.listTabs().find(t => t.id === id)?.composer.bubbles.getAllInOrder().map(b => ({ role: b.role, text: b.text ?? "" })) ?? [], revealSideChat: (chat) => { /* host: focus webview on side chat *\/ }, getActiveChatId: () => chatTabService.activeTab.id }), context });
 * …plus add the five `ide.*` ids (and the "btw" palette alias) to package.json `contributes.commands`.
 */
export function registerSideChatCommands(
  registrar: SideChatCommandRegistrar,
): vscode.Disposable[] {
  const { service, context } = registrar;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const register: (
    id: string,
    handler: (...args: any[]) => unknown,
  ) => vscode.Disposable =
    registrar.registerCommand ??
    ((id, handler) => vscode.commands.registerCommand(id, handler));

  const disposables: vscode.Disposable[] = [
    // Start a side chat for the current conversation. Args:
    // (seedQuestion?: string, parentChatId?: string).
    register(SideChatCommands.create, (...args) => {
      const seedQuestion = typeof args[0] === "string" ? args[0] : undefined;
      const parentChatId = typeof args[1] === "string" ? args[1] : undefined;
      const chat = service.createSideChat({ seedQuestion, parentChatId });
      return chat ? chat.id : undefined;
    }),
    // Open a side chat. Args: (sideChatId?: string) — defaults to active/most recent.
    register(SideChatCommands.open, (...args) => {
      const id = typeof args[0] === "string" ? args[0] : undefined;
      return service.openSideChat(id);
    }),
    // Open by agent/parent id (exact Cursor semantics UNKNOWN — see openSideChatForAgent).
    register(SideChatCommands.openByAgentId, (...args) => {
      const agentId = typeof args[0] === "string" ? args[0] : "";
      return service.openSideChatForAgent(agentId);
    }),
    // Open the side chat as a tab (Cursor rendering UNKNOWN — delegates to reveal via host).
    register(SideChatCommands.openTab, (...args) => {
      const id = typeof args[0] === "string" ? args[0] : undefined;
      return service.openSideChat(id);
    }),
    // List side chats for a picker UI (returns SideChatInfo[]; the host shows the QuickPick).
    register(SideChatCommands.list, () => service.listSideChats()),
  ];
  for (const d of disposables) {
    context.subscriptions.push(d);
  }
  return disposables;
}
