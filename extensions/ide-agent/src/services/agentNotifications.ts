/**
 * GAPS-152 (`agent-notification-actions`): agent OS notifications —
 * producers (turn completed / pending decision) and the notification
 * command handlers, ported from Cursor 3.25.9 (workbench.desktop.main.js;
 * full dissect in ide-code-mission/docs/rea/work-notes-gaps152.md).
 *
 * Layering (same as the binary): producers build the binary's verbatim
 * `showNotification` payload and hand it to the workbench's
 * system-notification service — here the core bridge command
 * `composer.showAgentSystemNotification` (src/vs/workbench/contrib/
 * composer/browser/agentNotificationActions.ts), which shows a real OS
 * notification via IHostService.showToast (Electron Notification in the
 * main process) and routes the click / Accept / Reject back to the
 * payload's commands. The three `composer.*FromNotification` commands
 * are registered in core (CommandsRegistry, binary @29946768) and
 * delegate to the `ide.*FromNotification` runtime handlers implemented
 * by {@link AgentNotificationService} below.
 *
 * The pure payload builders in this file mirror
 * src/vs/workbench/contrib/composer/common/agentNotifications.ts (the
 * two compile units cannot import each other; same precedent as
 * chime.ts, which exists in both core and this extension).
 */
import { TERMINAL_ACTIONS } from "./permissionsFileService";
import type { ApprovalRequest, PendingUserDecision } from "./humanReviewService";

/* ------------------------------------------------------------------ */
/* Verbatim ids + payload types (mirror of core common copy).          */
/* ------------------------------------------------------------------ */

export const OPEN_COMPOSER_FROM_NOTIFICATION_COMMAND_ID = "composer.openComposerFromNotification";
export const ACCEPT_PENDING_FROM_NOTIFICATION_COMMAND_ID = "composer.acceptPendingFromNotification";
export const REJECT_PENDING_FROM_NOTIFICATION_COMMAND_ID = "composer.rejectPendingFromNotification";
export const SHOW_AGENT_SYSTEM_NOTIFICATION_COMMAND_ID = "composer.showAgentSystemNotification";

export interface AgentNotificationCommandAction {
  readonly commandId: string;
  readonly args?: unknown;
}

export interface AgentSystemNotificationRequest {
  readonly title: string;
  readonly body: string;
  readonly silent?: boolean;
  readonly urgency?: string;
  readonly clickAction?: AgentNotificationCommandAction;
  readonly actions?: readonly { readonly type: "button"; readonly text: string }[];
  readonly actionCommands?: Readonly<Record<number, AgentNotificationCommandAction>>;
  readonly dedupeKey?: string;
}

/** Binary `jR_` @18585962 — click routing to the parent for subagents. */
export function routeNotificationComposerId(composerId: string, subagentParentComposerId?: string): string {
  const parent = subagentParentComposerId?.trim();
  return parent ? parent : composerId;
}

/** Binary handler arg rule (desk@29946768): `typeof t=="string" ? t : t?.composerId`. */
export function parseNotificationComposerId(arg: unknown): string | undefined {
  if (typeof arg === "string") {
    return arg ? arg : undefined;
  }
  if (arg !== null && typeof arg === "object") {
    const composerId = (arg as { composerId?: unknown }).composerId;
    return typeof composerId === "string" && composerId ? composerId : undefined;
  }
  return undefined;
}

export function parseNotificationSource(arg: unknown): string | undefined {
  if (arg !== null && typeof arg === "object") {
    const source = (arg as { source?: unknown }).source;
    return typeof source === "string" && source ? source : undefined;
  }
  return undefined;
}

/** Verbatim completed-turn payload (desk@31367250). */
export function buildCompletedNotification(input: {
  readonly composerId: string;
  readonly name?: string;
  readonly source?: string;
}): AgentSystemNotificationRequest {
  const name = input.name?.trim() ? input.name : undefined;
  return {
    title: name ? `Done \u2022 ${name}` : "Agent complete",
    body: "Open Cursor to view the agent's output.",
    silent: true,
    clickAction: {
      commandId: OPEN_COMPOSER_FROM_NOTIFICATION_COMMAND_ID,
      args:
        input.source !== undefined
          ? { composerId: input.composerId, source: input.source }
          : { composerId: input.composerId },
    },
  };
}

export type PendingNotificationToolKind = "terminal" | "edit" | "delete" | "mcp" | "question" | "other";

export interface PendingActionNotificationInfo {
  readonly title: string;
  readonly body: string;
  readonly toolType: PendingNotificationToolKind | undefined;
}

/** Binary basename: `l.split("/").pop() || l.split("\\").pop() || l`. */
function pendingBasename(path: string): string {
  return path.split("/").pop() || path.split("\\").pop() || path;
}

/** Verbatim port of `getPendingActionNotificationInfo()` (desk@31367568). */
export function getPendingActionNotificationInfo(input: {
  readonly kind: PendingNotificationToolKind;
  readonly groupCount: number;
  readonly command?: string;
  readonly relativePath?: string;
  readonly mcpToolName?: string;
  readonly questionPrompt?: string;
}): PendingActionNotificationInfo {
  let title = "Approve pending action";
  let body = "Return to Cursor to review and approve.";
  let toolType: PendingNotificationToolKind | undefined = undefined;
  switch (input.kind) {
    case "terminal": {
      const command = input.command;
      if (command) {
        const trimmed = command.trim().slice(0, 140);
        title = "Approve terminal command";
        body = `Approval required to run: ${trimmed}${command.length > 140 ? "..." : ""}`;
        toolType = "terminal";
      }
      break;
    }
    case "edit": {
      toolType = "edit";
      if (input.groupCount === 1) {
        title = "Approve file edit";
        body = input.relativePath
          ? `Approval required to edit: ${pendingBasename(input.relativePath)}`
          : "Return to Cursor to review and approve file changes.";
      } else {
        title = `Approve ${input.groupCount} file edits`;
        body = `Return to Cursor to review and approve ${input.groupCount} file changes.`;
      }
      break;
    }
    case "delete": {
      toolType = "delete";
      title = "Approve file deletion";
      body = input.relativePath
        ? `Approval required to delete: ${pendingBasename(input.relativePath)}`
        : "Return to Cursor to review and approve file deletion.";
      break;
    }
    case "mcp": {
      toolType = "mcp";
      title = "Approve MCP tool";
      body = input.mcpToolName
        ? `Approval required for MCP tool: ${input.mcpToolName}`
        : "Return to Cursor to review and approve the MCP tool execution.";
      break;
    }
    case "question": {
      toolType = "question";
      const prompt = input.questionPrompt?.trim() ? input.questionPrompt.trim() : "";
      title = prompt ? `Input needed \u2022 ${prompt}` : "Input needed";
      body = "Open Cursor to answer the agent's questions.";
      break;
    }
    default:
      break;
  }
  return { title, body, toolType };
}

/** Verbatim pending-decision payload (desk@31370281). */
export function buildPendingNotification(input: {
  readonly composerId: string;
  readonly clickComposerId?: string;
  readonly info: PendingActionNotificationInfo;
  readonly silent: boolean;
}): AgentSystemNotificationRequest {
  return {
    title: input.info.title,
    body: input.info.body,
    urgency: "critical",
    silent: input.silent,
    clickAction: {
      commandId: OPEN_COMPOSER_FROM_NOTIFICATION_COMMAND_ID,
      args: { composerId: input.clickComposerId ?? input.composerId },
    },
    actions: [
      { type: "button", text: "Accept" },
      { type: "button", text: "Reject" },
    ],
    actionCommands: {
      0: { commandId: ACCEPT_PENDING_FROM_NOTIFICATION_COMMAND_ID, args: { composerId: input.composerId } },
      1: { commandId: REJECT_PENDING_FROM_NOTIFICATION_COMMAND_ID, args: { composerId: input.composerId } },
    },
  };
}

/* ------------------------------------------------------------------ */
/* Fork classification: ApprovalRequest -> binary pending-info input.  */
/* ------------------------------------------------------------------ */

/**
 * Map a fork approval request onto the binary's pending-info branches.
 * The binary reads the pending decision's `clientSideTool` + bubble
 * params; the fork's equivalents (see humanReviewService.ts):
 *  - terminal: `clientSideTool` in TERMINAL_ACTIONS ("bash"/"shell"/
 *    "shell_tool_call"); the command text is the approval title's
 *    resource suffix (approvalTitle = `${action} ${resources[0]}`,
 *    ideCodeEngineAdapter.ts) — undefined when the title carries none,
 *    which lands on the binary's generic branch exactly like a binary
 *    decision whose bubble params have no `command`.
 *  - edit: engine action "edit"; the path is the same title suffix.
 *  - delete: engine has no dedicated delete action today; the names
 *    "delete"/"delete_file" are mapped to the binary DELETE_FILE branch
 *    so a future engine action lands correctly.
 *  - mcp: `clientSideTool` = `mcp__<server>__<tool>` (parseMcpAction);
 *    the tool name is the part after the server segment.
 *  - everything else: the binary's default copy.
 * ASK_QUESTION decisions never enter the fork's pending group (the
 * questions live in the webview — W66A divergence), so the "question"
 * branch is only reachable through the shared builder, not from here.
 */
export function classifyPendingRequest(request: Pick<ApprovalRequest, "title" | "clientSideTool">): {
  readonly kind: PendingNotificationToolKind;
  readonly command?: string;
  readonly relativePath?: string;
  readonly mcpToolName?: string;
} {
  // Same identity fallback as the group algorithm (W66A): the stored
  // clientSideTool, else the title's first token (`approvalTitle` is
  // `${action} ${resource}`, so the first token IS the action for
  // legacy requests created without a stored identity).
  const tool = request.clientSideTool ?? request.title.split(" ")[0] ?? request.title;
  const suffix = request.title.startsWith(`${tool} `) ? request.title.slice(tool.length + 1) : undefined;
  if (TERMINAL_ACTIONS.has(tool)) {
    return { kind: "terminal", command: suffix };
  }
  if (tool.startsWith("mcp__")) {
    const parts = tool.split("__");
    const mcpToolName = parts.length >= 3 && parts[2] ? parts.slice(2).join("__") : undefined;
    return { kind: "mcp", mcpToolName };
  }
  if (tool === "edit") {
    return { kind: "edit", relativePath: suffix };
  }
  if (tool === "delete" || tool === "delete_file") {
    return { kind: "delete", relativePath: suffix };
  }
  return { kind: "other" };
}

/**
 * GAPS-165: classify a pending-group DECISION (the binary reads the
 * bubble params of `group[0]` via `getBubbleDataByToolCallId`). The
 * decision's `title` is the fork's params source; its `clientSideTool`
 * is the group's RESOLVED identity — the stored `clientSideTool`, or,
 * for legacy requests created without one, the full approval title
 * (humanReviewService's toDecision fallback). In the legacy case
 * (identity === title) the stored value was undefined, so hand
 * classifyPendingRequest that undefined and let it derive the action
 * from the title's first token, exactly as it does for a raw legacy
 * request. (When a stored identity exists and equals the title, the
 * title carries no resource suffix, so both readings coincide.)
 */
export function classifyPendingDecision(decision: Pick<PendingUserDecision, "title" | "clientSideTool">): {
  readonly kind: PendingNotificationToolKind;
  readonly command?: string;
  readonly relativePath?: string;
  readonly mcpToolName?: string;
} {
  const stored = decision.clientSideTool !== decision.title ? decision.clientSideTool : undefined;
  return classifyPendingRequest({ title: decision.title, clientSideTool: stored });
}

/* ------------------------------------------------------------------ */
/* Service: producers + notification command handlers.                 */
/* ------------------------------------------------------------------ */

/** The tab/composer surface the handlers need (ChatTabService-shaped). */
export interface NotificationTab {
  readonly id: string;
  readonly title: string;
  readonly queuedCount: number;
  getPendingUserDecisionGroup(): PendingUserDecision[];
}

/** Minimal structural shape of a ChatTabService ChatTab (avoids a cycle). */
export interface ChatTabLike {
  readonly id: string;
  readonly title: string;
  readonly composer: {
    readonly queue: { readonly length: number };
    getPendingUserDecisionGroup(): PendingUserDecision[];
  };
}

/** Adapt a chat tab to the notification surface (live getters, no snapshot). */
export function toNotificationTab(tab: ChatTabLike): NotificationTab {
  return {
    id: tab.id,
    get title() {
      return tab.title;
    },
    get queuedCount() {
      return tab.composer.queue.length;
    },
    getPendingUserDecisionGroup: () => tab.composer.getPendingUserDecisionGroup(),
  };
}

export interface AgentNotificationDeps {
  /** vscode.commands.executeCommand — used ONLY for the core bridge. */
  executeCommand(id: string, ...args: unknown[]): Promise<unknown>;
  /** vscode.window.state.focused (binary: hostService.hasFocus). */
  isWindowFocused(): boolean;
  /** `ide.composer.systemNotificationsEnabled` (binary gate `?? !1`). */
  systemNotificationsEnabled(): boolean;
  getTab(composerId: string): NotificationTab | undefined;
  /** Switch to the tab and reveal/focus its chat surface. */
  openTab(composerId: string): Promise<void>;
  log?(line: string): void;
}

/** The fork's placeholder tab title ≙ the binary's empty composer name. */
const UNTITLED_TAB_TITLE = "New chat";

export class AgentNotificationService {
  constructor(private readonly deps: AgentNotificationDeps) {}

  private async show(request: AgentSystemNotificationRequest): Promise<boolean> {
    try {
      return (await this.deps.executeCommand(SHOW_AGENT_SYSTEM_NOTIFICATION_COMMAND_ID, request)) === true;
    } catch {
      // Bridge unavailable (core contribution not loaded yet): the
      // notification is skipped, never faked through another surface.
      return false;
    }
  }

  /**
   * Producer A — binary `onChatStreamFinished` (desk@31367250), called
   * from ComposerDataService.afterTurnCompleted (clean finishes only,
   * which is the fork's `status==="completed"` evidence). Gate order is
   * the binary's: enabled → window unfocused → suppression (YOh).
   * YOh branches with no fork analog (foreground-tools-running,
   * background-subagents-running, goal-continuing, composer-archived,
   * subagent-turn) are honestly absent — the fork has no archived
   * composers, no subagent turns and no goal continuation; the two
   * branches the fork CAN evaluate (queued-messages) are evaluated.
   * Badge/updateBadge + scheduleAutoClear are out of GAPS-152 scope
   * (GAPS-125 dispatch note defers them to a later wave).
   */
  async notifyTurnCompleted(tab: NotificationTab): Promise<boolean> {
    if (!this.deps.systemNotificationsEnabled()) {
      return false;
    }
    if (this.deps.isWindowFocused()) {
      return false;
    }
    if (tab.queuedCount > 0) {
      // YOh "queued-messages": a queued follow-up means the agent is
      // not really done from the user's point of view.
      return false;
    }
    const name = tab.title !== UNTITLED_TAB_TITLE ? tab.title : undefined;
    return this.show(buildCompletedNotification({ composerId: tab.id, name }));
  }

  /**
   * Producer B — binary `onAddPendingAction` (desk@31370281), called
   * when a tab's approval request opens. Gate order is the binary's:
   * window unfocused FIRST → blocking group non-empty → enabled.
   * (The binary re-checks `getIsBlockingUserDecision`; the fork's
   * pending group only contains blocking decisions — every fork
   * approval blocks its turn, humanReviewService.ts — so a non-empty
   * group is the same evidence.) `silent` is the binary's
   * `createdFromLocalScheduledTask !== void 0`: the fork has no
   * local-scheduled-task composers, so it is false.
   * Subagent click routing (jR_): fork tabs have no subagent parent
   * link, so the routed id equals the raw id.
   * Copy source (GAPS-165, QA-160 NEEDS-FIX P2): the binary's
   * `getPendingActionNotificationInfo()` takes NO request argument —
   * it classifies `getPendingUserDecisionGroup()[0]`, the decision
   * heading the group (desk@31367568), and `onAddPendingAction`'s own
   * argument is never used for copy. `request` below is therefore
   * only the trigger that woke this producer (kept for signature
   * parity with the call site); the copy comes from `group[0]`.
   */
  async notifyPendingDecision(tab: NotificationTab, request: ApprovalRequest): Promise<boolean> {
    void request;
    if (this.deps.isWindowFocused()) {
      return false;
    }
    const group = tab.getPendingUserDecisionGroup();
    if (group.length === 0) {
      return false;
    }
    if (!this.deps.systemNotificationsEnabled()) {
      return false;
    }
    const info = getPendingActionNotificationInfo({
      ...classifyPendingDecision(group[0]),
      groupCount: group.length,
    });
    return this.show(
      buildPendingNotification({
        composerId: tab.id,
        clickComposerId: routeNotificationComposerId(tab.id),
        info,
        silent: false,
      }),
    );
  }

  /**
   * Handler — binary `composer.openComposerFromNotification`
   * (desk@29946768): no id → return; otherwise open the composer.
   * Fork mapping: `openComposer(a)` = switch to the tab and reveal its
   * chat surface. The binary's Best-of-N branch (focus the window ONLY
   * when the composer is a Best-of-N parent/sub or has subcomposers)
   * has no fork analog — the fork has no Best-of-N tabs — so every
   * known id takes the open path; an unknown id is a no-op (the tab was
   * closed after the notification fired). The glass branch
   * (`glass.openAgentById`) does not apply: the fork's chat surface IS
   * its agent surface.
   */
  async openComposerFromNotification(arg: unknown): Promise<void> {
    const composerId = parseNotificationComposerId(arg);
    if (!composerId) {
      return;
    }
    if (!this.deps.getTab(composerId)) {
      this.deps.log?.(`[agent-notifications] open: unknown composer ${composerId}`);
      return;
    }
    await this.deps.openTab(composerId);
  }

  /**
   * Handler — binary `composer.acceptPendingFromNotification`
   * (desk@29946768): for every decision of the composer's pending
   * group, accept it. The binary prefers the terminal/MCP review
   * models' RUN selection and falls back to `acceptToolCall`; the
   * fork's decisions expose a single `accept()` (approve-once
   * resolution of the pending approval — the acceptToolCall analog;
   * the review models live in the chat webview, the same mapping
   * W66A made for composer.acceptComposerStep).
   */
  async acceptPendingFromNotification(arg: unknown): Promise<void> {
    const composerId = parseNotificationComposerId(arg);
    if (!composerId) {
      return;
    }
    const tab = this.deps.getTab(composerId);
    if (!tab) {
      return;
    }
    for (const decision of tab.getPendingUserDecisionGroup()) {
      decision.accept();
    }
  }

  /**
   * Handler — binary `composer.rejectPendingFromNotification`
   * (desk@29946768): reject every decision of the group, then walk
   * subcomposers via `Apa` and reject theirs too. The fork has no
   * TASK_V2 subcomposer bubbles (Apa's walk finds nothing to visit),
   * so only the group's own decisions are rejected — the Apa branch
   * is an honest no-op here, not a missing step.
   */
  async rejectPendingFromNotification(arg: unknown): Promise<void> {
    const composerId = parseNotificationComposerId(arg);
    if (!composerId) {
      return;
    }
    const tab = this.deps.getTab(composerId);
    if (!tab) {
      return;
    }
    for (const decision of tab.getPendingUserDecisionGroup()) {
      decision.reject();
    }
  }
}
