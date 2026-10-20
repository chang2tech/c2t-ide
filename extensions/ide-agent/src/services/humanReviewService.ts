import * as vscode from "vscode";

/**
 * HumanReviewService — tool-call approval cards.
 * Mirrors Cursor's HumanReviewService: option lists, reason strings,
 * approval ids. The UI (webview) renders the card; this service owns the
 * pending-approval promises the agent turn awaits on.
 */
export interface ApprovalOption {
  id: string;
  label: string;
}

export interface ApprovalRequest {
  approvalId: string;
  toolCallId: string;
  title: string;
  reasons: string[];
  options: ApprovalOption[];
  /**
   * FEATURE-1 (`agent-accept-pending-decisions`, Cursor 3.25.9 parity): the
   * engine tool kind that raised this approval — the fork's analog of the
   * binary's `clientSideTool` on a pending user decision
   * (workbench.glass.main.js @27763492 groups by it). Optional: when absent
   * the decision-group logic falls back to the title.
   */
  clientSideTool?: string;
  /** Epoch ms when the approval was raised (binary decision `startedAt`). */
  startedAt?: number;
}

export type ApprovalResult = { optionId: string } | undefined;

let approvalSeq = 0;

export class HumanReviewService {
  private readonly emitter = new vscode.EventEmitter<ApprovalRequest | undefined>();
  /** Fires with the request when one opens, undefined when it resolves. */
  readonly onDidChangeApproval = this.emitter.event;
  private pending = new Map<string, { request: ApprovalRequest; resolve: (result: ApprovalResult) => void; allowlistKey: string }>();
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  private current: ApprovalRequest | undefined;
  /** Optional sink for shadow-mode decision logging (wired by the host). */
  log?: (line: string) => void;

  /** The currently-open approval request, if any. */
  get currentApproval(): ApprovalRequest | undefined {
    return this.current;
  }

  /**
   * P2 (CX4b): per-approval timeout. An approval the user never answers used
   * to stay pending forever, and the serialized approval chain (XQA-03)
   * queued every later approval behind it — turn 2's approval hung behind
   * turn 1's stale card indefinitely. After `timeoutMs` the approval
   * auto-resolves as undefined (skip): the tool is rejected and the chain
   * unblocks. The card is cleared via the same emitter the manual path uses.
   */
  static readonly DEFAULT_APPROVAL_TIMEOUT_MS = 5 * 60 * 1000;

  /**
   * Smart-mode approval TTL (Cursor parity — deepdig-runtime-approval §1.4:
   * `SMART_MODE_MCP_APPROVAL_TTL_SECONDS = 86400`,
   * `SMART_MODE_SHELL_APPROVAL_TTL_SECONDS = 86400`). An "Approve and
   * allowlist" decision is remembered for 24 hours: the same tool call does
   * not re-prompt within the TTL. Expired entries are swept on read.
   */
  static readonly APPROVAL_TTL_MS = 86_400_000;

  /**
   * Shadow mode (Cursor parity — `smartModeClassifierShadowMode`): the
   * approval evaluation runs but does not enforce — decisions are logged for
   * eval instead of blocking the turn. Enabled via the
   * `ide.agent.approvalShadowMode` setting. In shadow mode every approval
   * auto-resolves as approve-once and the would-be card is recorded to the
   * output channel instead of shown.
   */
  private allowlistStore = new Map<string, { approvedAt: number }>();

  /**
   * P1 (QA-CHATTABS-01): the allowlist key MUST be a stable tool identity —
   * action + resources (e.g. "edit::src/a.ts") — NEVER the per-request
   * toolCallId (`tc-<permission-request-id>`, unique per request). Keying on
   * the request id made "Approve and allowlist" a dead feature: the second
   * identical tool call (new request id) could never match the stored entry.
   * Callers that know the action/resources pass an explicit identity;
   * otherwise the title is used as the (stable) identity.
   */
  private allowlistKey(identity: string): string {
    return identity;
  }

  private sweepAllowlist(now: number): void {
    for (const [key, entry] of this.allowlistStore) {
      if (now - entry.approvedAt >= HumanReviewService.APPROVAL_TTL_MS) {
        this.allowlistStore.delete(key);
      }
    }
  }

  /** True when a fresh (unexpired) allowlist entry covers this tool identity. */
  isAllowlisted(allowlistIdentity: string, now: number = Date.now()): boolean {
    this.sweepAllowlist(now);
    return this.allowlistStore.has(this.allowlistKey(allowlistIdentity));
  }

  /** Whether shadow mode is on (read live so tests can flip the setting). */
  private isShadowMode(): boolean {
    try {
      return (
        vscode.workspace.getConfiguration("ide.agent").get<boolean>("approvalShadowMode", false) === true
      );
    } catch {
      return false;
    }
  }

  requestApproval(
    toolCallId: string,
    title: string,
    reasons: string[],
    timeoutMs: number = HumanReviewService.DEFAULT_APPROVAL_TIMEOUT_MS,
    customOptions?: ApprovalOption[],
    /**
     * P1 (QA-CHATTABS-01): stable allowlist identity for this approval
     * (action + resources, e.g. "edit::src/a.ts"). When omitted the title is
     * used — still stable across requests, unlike the per-request toolCallId.
     */
    allowlistIdentity?: string,
    /**
     * FEATURE-1 (`agent-accept-pending-decisions`): engine tool kind that
     * raised this approval (e.g. "bash", "edit") — stored on the request as
     * `clientSideTool` for the pending-decision group logic.
     */
    clientSideTool?: string,
  ): Promise<ApprovalResult> {
    approvalSeq += 1;
    const approvalId = `approval-${approvalSeq}`;
    // The allowlist key is fixed at request time so the resolve path stores
    // exactly the identity that was checked here.
    const identityKey = this.allowlistKey(allowlistIdentity ?? title);
    const request: ApprovalRequest = {
      approvalId,
      toolCallId,
      title,
      reasons,
      options: customOptions ?? [
        { id: "approve-once", label: "Approve once" },
        { id: "approve-allowlist", label: "Approve and allowlist" },
        { id: "skip", label: "Skip" },
      ],
      ...(clientSideTool !== undefined ? { clientSideTool } : {}),
      startedAt: Date.now(),
    };
    // 24h allowlist TTL: a fresh "Approve and allowlist" decision for the
    // same tool identity auto-resolves without re-showing the card.
    if (this.isAllowlisted(identityKey)) {
      return Promise.resolve({ optionId: "approve-once" });
    }
    // Shadow mode: evaluate (log the would-be card) but do not enforce —
    // auto-approve-once so the turn is never blocked.
    if (this.isShadowMode()) {
      this.log?.(
        `[ide-agent] approval SHADOW (not enforced): "${title}" ` +
          `reasons=[${reasons.join("; ")}] → auto approve-once`,
      );
      return Promise.resolve({ optionId: "approve-once" });
    }
    this.current = request;
    this.emitter.fire(request);
    return new Promise<ApprovalResult>((resolve) => {
      this.pending.set(approvalId, { request, resolve, allowlistKey: identityKey });
      const timer = setTimeout(() => {
        this.timers.delete(approvalId);
        this.resolveApproval(approvalId, undefined);
      }, timeoutMs);
      // A 5-minute timer must not keep the extension host alive on its own.
      if (typeof timer === "object" && timer !== null && typeof (timer as unknown as { unref?: unknown }).unref === "function") {
        (timer as unknown as { unref(): void }).unref();
      }
      this.timers.set(approvalId, timer);
    });
  }

  resolveApproval(approvalId: string, result: ApprovalResult): void {
    const entry = this.pending.get(approvalId);
    if (!entry) {
      return;
    }
    this.resolveEntry(approvalId, entry, result);
  }

  /**
   * P2-4 rework (QA-CHATTABS Round B): resolve a pending approval by the
   * card's toolCallId (`tc-<permission-request-id>`) instead of the
   * internal `approval-N` id. Used when answering a clarifying-question
   * widget: the turn events only carry the card's toolCallId (linked via
   * the questionApproval event), never the approval-N id. No-op when no
   * pending approval matches (card already resolved / timed out).
   */
  resolveApprovalForToolCall(toolCallId: string, result: ApprovalResult): void {
    for (const [approvalId, entry] of this.pending) {
      if (entry.request.toolCallId === toolCallId) {
        this.resolveEntry(approvalId, entry, result);
        return;
      }
    }
  }

  private resolveEntry(
    approvalId: string,
    entry: { request: ApprovalRequest; resolve: (result: ApprovalResult) => void; allowlistKey: string },
    result: ApprovalResult,
  ): void {
    // 24h TTL: an "Approve and allowlist" decision is remembered so the
    // same tool identity does not re-prompt within the TTL.
    if (result?.optionId === "approve-allowlist") {
      this.allowlistStore.set(entry.allowlistKey, { approvedAt: Date.now() });
    }
    const timer = this.timers.get(approvalId);
    if (timer !== undefined) {
      clearTimeout(timer);
      this.timers.delete(approvalId);
    }
    this.pending.delete(approvalId);
    if (this.current?.approvalId === approvalId) {
      this.current = undefined;
    }
    this.emitter.fire(undefined);
    entry.resolve(result);
  }

  /**
   * Settle all pending approvals as undefined (skip). Used when the chat
   * webview is disposed so turns don't hang forever.
   */
  settleAllPending(): void {
    const ids = [...this.pending.keys()];
    for (const id of ids) {
      this.resolveApproval(id, undefined);
    }
  }

  pendingCount(): number {
    return this.pending.size;
  }

  /**
   * FEATURE-1 (`agent-accept-pending-decisions`): the pending user decision
   * GROUP for `composer.acceptComposerStep` — binary-verbatim port of the
   * two layers in workbench.glass.main.js 3.25.9:
   *
   *  - `ComposerDataService.getPendingUserDecisionGroup(handle)` @39965884:
   *    `const e=this.getToolFormer(t); return e?e.getPendingUserDecisionGroup()():[]`
   *    (the fork's review service is the tool-former analog — it owns the
   *    pending-decision store, so the data service delegates here).
   *  - Tool-former getter @27763492:
   *      const t = this.pendingDecisions(),
   *            e = [...t.userInteractionBubbleIds].reverse();
   *      if (e.length === 0) -> latest answerable ASK_QUESTION decision or []
   *      const n = e.map(id => t.pendingDecisions[id])
   *                 .filter(d => d !== void 0 && d.clientSideTool === RUN_TERMINAL_COMMAND_V2);
   *      if (n.length > 0) return n;
   *      const i = []; for (const id of e) { const s = t.pendingDecisions[id];
   *        if (s) if (i.length===0 || areToolsSimilar(last(i).clientSideTool, s.clientSideTool)) i.push(s); else break }
   *      return i
   *  - `areToolsSimilar(t,e)` @27745295:
   *      `if(t===e)return!0; const n=this.getToolCategory(t),i=this.getToolCategory(e);
   *       return n!==void 0&&n===i` with `toolCategories` @27744379 =
   *      `new Map([["file_modification", new Set([EDIT_FILE, EDIT_FILE_V2])]])`.
   *
   * Fork mapping: the pending map's insertion order is the
   * `userInteractionBubbleIds` analog (approvals are appended as the agent
   * raises them); `RUN_TERMINAL_COMMAND_V2` maps to the engine's terminal
   * actions below; the single binary category `file_modification` maps to
   * the fork engine's file-edit action "edit" (the engine emits one action
   * for edits and writes — no EDIT_FILE_V2 analog exists locally, so the
   * set has one member; `areToolsSimilar` itself is ported unchanged).
   *
   * HONEST-DIVERGENCE (ask-question fallback): when no approval decisions
   * are pending the binary falls back to the latest answerable ASK_QUESTION
   * decision whose `accept()` answers with the question UI's current
   * selections. The fork's clarifying questions live in the webview and
   * expose no current-selection state to the host, so there is no honest
   * `accept()` to offer — this returns [] and the command falls through to
   * `acceptNotification()`, exactly like the binary's no-decision path.
   */
  getPendingUserDecisionGroup(): PendingUserDecision[] {
    // [...userInteractionBubbleIds].reverse() — most recent first.
    const ordered = [...this.pending.entries()].reverse();
    if (ordered.length === 0) {
      return [];
    }
    const toDecision = ([approvalId, entry]: [string, { request: ApprovalRequest }]): PendingUserDecision => ({
      toolCallId: entry.request.toolCallId,
      clientSideTool: entry.request.clientSideTool ?? entry.request.title,
      // Fork approvals always block the awaiting turn promise.
      blocking: true,
      startedAt: entry.request.startedAt ?? 0,
      accept: () => this.resolveApproval(approvalId, { optionId: "approve-once" }),
      reject: () => this.resolveApproval(approvalId, undefined),
    });
    // Terminal decisions first (binary RUN_TERMINAL_COMMAND_V2 filter).
    const terminal = ordered.filter(([, entry]) =>
      TERMINAL_ACTIONS.has(entry.request.clientSideTool ?? entry.request.title),
    );
    if (terminal.length > 0) {
      return terminal.map(toDecision);
    }
    // Leading run of similar tools, in reversed (most-recent-first) order.
    const group: PendingUserDecision[] = [];
    for (const pair of ordered) {
      const decision = toDecision(pair);
      if (
        group.length === 0 ||
        areToolsSimilar(group[group.length - 1].clientSideTool, decision.clientSideTool)
      ) {
        group.push(decision);
      } else {
        break;
      }
    }
    return group;
  }
}

/**
 * FEATURE-1: a pending user decision — the fork's shape of the binary's
 * pending-decision item
 * (`{accept,reject,toolCallId,clientSideTool,blocking,startedAt}`,
 * workbench.glass.main.js 3.25.9).
 */
export interface PendingUserDecision {
  readonly toolCallId: string;
  readonly clientSideTool: string;
  readonly blocking: boolean;
  readonly startedAt: number;
  accept(): void;
  reject(): void;
}

/**
 * FEATURE-1: the fork engine's terminal actions — the analog of the
 * binary's `RUN_TERMINAL_COMMAND_V2` clientSideTool, which the binary's
 * grouping filter prioritizes.
 */
const TERMINAL_ACTIONS: ReadonlySet<string> = new Set(["bash", "shell", "shell_tool_call"]);

/**
 * FEATURE-1: binary-verbatim `areToolsSimilar` port
 * (workbench.glass.main.js 3.25.9 @27745295): identical tools are similar;
 * otherwise two tools are similar iff they share a category in
 * `toolCategories` (@27744379 — a single entry, "file_modification":
 * {EDIT_FILE, EDIT_FILE_V2}).
 *
 * Fork mapping: the engine emits a single "edit" action covering both
 * file edits and writes, so the local `file_modification` set has one
 * member. New engine actions that represent file modification get added
 * here as they are documented — the mechanism (same tool OR same
 * category) is the binary's.
 */
const PENDING_DECISION_TOOL_CATEGORIES: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  ["file_modification", new Set(["edit"])],
]);

function pendingDecisionToolCategory(tool: string): string | undefined {
  for (const [category, tools] of PENDING_DECISION_TOOL_CATEGORIES) {
    if (tools.has(tool)) {
      return category;
    }
  }
  return undefined;
}

function areToolsSimilar(a: string, b: string): boolean {
  if (a === b) {
    return true;
  }
  const categoryA = pendingDecisionToolCategory(a);
  return categoryA !== undefined && categoryA === pendingDecisionToolCategory(b);
}
