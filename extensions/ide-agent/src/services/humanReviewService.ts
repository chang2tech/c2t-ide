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
}
