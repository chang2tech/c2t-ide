import * as vscode from "vscode";
import type { CursorPermissionsPolicy } from "./permissionsFileService";
import { matchesFileAllowlist, TERMINAL_ACTIONS } from "./permissionsFileService";
import { buildShellAllowlistLabel } from "./shellAllowlistLabel";

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

/**
 * GAPS-12 (approval-card-diff) — Cursor parity: file-edit approvals carry
 * `approvalDetails: { type: "fileEdit", isNewFile, diffString }` with a
 * unified diff at context 2 (binary evidence:
 * docs/rea/deepdig-runtime-approval-2026-10-19.md §3.11, §5, §6 — matrix
 * `approval-card-diff`: "unified diff (context 2) in file-edit approval
 * card"). diffString is the engine-computed patch trimmed to 2 context
 * lines; the card renders it verbatim. Absent for non-file-edit approvals.
 */
export interface ApprovalDetails {
  type: "fileEdit";
  isNewFile: boolean;
  diffString: string;
}

export interface ApprovalRequest {
  approvalId: string;
  toolCallId: string;
  title: string;
  reasons: string[];
  options: ApprovalOption[];
  approvalDetails?: ApprovalDetails;
  /**
   * DEV-GAPS-66/W66A (`agent-accept-pending-decisions`): the engine tool
   * identity backing this approval (e.g. "bash", "edit", "mcp__srv__tool")
   * — the fork's analog of the binary's `clientSideTool` on a pending
   * user decision (workbench.glass.main.js 3.25.9, tool-former
   * `pendingDecisions` entries @27756684:
   * `{decide,toolCallId,clientSideTool,accept,reject,blocking,startedAt}`).
   * Stored (not derived from the display title — MCP approvals render a
   * derived "MCP: <tool> (<server>)" title while their identity stays
   * `mcp__<server>__<tool>`), and used only by the pending-decision group
   * algorithm. Absent for requests created before this field existed.
   */
  clientSideTool?: string;
  /** Engine request time (Date.now()); mirrors the binary decision's `startedAt`. */
  startedAt?: number;
}

/**
 * DEV-GAPS-66/W66A: a pending user decision exposed for
 * `composer.acceptComposerStep` — mirrors the binary decision shape
 * (`{accept,reject,toolCallId,clientSideTool,blocking,startedAt}`,
 * workbench.glass.main.js 3.25.9 @27756684/@27759416).
 */
export interface PendingUserDecision {
  /** The engine tool-call id this decision blocks on. */
  readonly toolCallId: string;
  /** Engine tool identity (e.g. "bash", "edit", "mcp__srv__tool"). */
  readonly clientSideTool: string;
  /**
   * GAPS-165: the backing approval's title (`${action} ${resource}`).
   * The binary decision carries no title — its notification copy reads
   * the bubble params via `getBubbleDataByToolCallId(toolCallId)`
   * (desk@31367568); the fork has no bubble-params store, and the
   * approval title is where the fork keeps exactly those params (the
   * terminal command / edit path — see classifyPendingRequest in
   * agentNotifications.ts). Exposed so the pending-action notification
   * can classify from the group's FIRST decision, as the binary does.
   */
  readonly title: string;
  /** Whether the decision blocks the turn until answered. */
  readonly blocking: boolean;
  /** Engine request time (Date.now()). */
  readonly startedAt: number;
  /** Approve once — resolves the pending approval with `approve-once`. */
  accept(): void;
  /**
   * Skip — resolves the pending approval with undefined (the fork's
   * skip). The binary command only ever calls `accept()` on the group;
   * `reject()` exists for decision-shape parity.
   */
  reject(): void;
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
   * MCP/tool allowlist: an "Approve and allowlist" decision is remembered
   * indefinitely — entries never expire. A fabricated 24h TTL (citing
   * "deepdig-runtime-approval §1.4: SMART_MODE_MCP_APPROVAL_TTL_SECONDS =
   * 86400") was DEBUNKED by DIG-CONTINUOUS (headline #6): Cursor's
   * `mcpAllowedTools` entries in the 3.25.9 bundle carry no timestamps and
   * there is no expiry sweep anywhere. This is now a plain set with no
   * expiry, matching Cursor's `mcpAllowedTools` (no TTL).
   */
  private allowlistStore = new Set<string>();

  /**
   * DEV-GAPS-10 (rex-004): `.cursor/permissions.json` policy, applied here —
   * the single approval choke point. Set by ChatTabService.setFilePermissions
   * (all tabs); undefined = no file policy (default behavior).
   *
   * approvalMode mapping to the existing run modes (ide.composer.runMode):
   * - "unrestricted" → runEverything: every approval auto-resolves approve-once.
   * - "manual" (Ask Every Time) → autoReview: every tool call asks — all
   *   auto-approvals (stored allowlist AND file allowlists) are bypassed.
   * - "allowlist" (default) → allowlist: file mcpAllowlist/terminalAllowlist
   *   patterns auto-approve, the rest follow the normal flow.
   */
  private filePermissions: CursorPermissionsPolicy | undefined;

  /** Apply (or clear, with undefined) the `.cursor/permissions.json` policy. */
  setFilePermissions(policy: CursorPermissionsPolicy | undefined): void {
    this.filePermissions = policy;
  }

  /** The active `.cursor/permissions.json` policy, if any. */
  getFilePermissions(): CursorPermissionsPolicy | undefined {
    return this.filePermissions;
  }

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

  /** True when the allowlist covers this tool identity (entries never expire). */
  isAllowlisted(allowlistIdentity: string, _now: number = Date.now()): boolean {
    return this.allowlistStore.has(this.allowlistKey(allowlistIdentity));
  }

  /**
   * Shadow mode (Cursor's `smart_mode_classifier_shadow_mode` — binary evidence:
   * workbench.glass.main.js 3.25.9 offsets 984622 (client feature-flag registry
   * entry `smart_mode_classifier_shadow_mode:{client:!0,default:!1}`) and
   * 37516979 (aiserver.v1.RunInferencePostToolReminder bool field); same
   * contexts in 3.25.6 at offsets 984579 and 37507686. NOTE the earlier
   * camelCase spelling `smartModeClassifierShadowMode` in this comment had
   * ZERO hits in either binary — corrected 2026-10-20).
   * HONEST-DIVERGENCE: in Cursor this is a server-controlled feature flag plus
   * an aiserver protocol field, not a local VS Code config key. Here it is a
   * local eval toggle named after the real Cursor concept. The approval
   * evaluation runs but does not enforce — decisions are logged for eval
   * instead of blocking the turn. Enabled via the
   * `ide.agent.smart_mode_classifier_shadow_mode` setting. In shadow mode
   * every approval auto-resolves as approve-once and the would-be card is
   * recorded to the output channel instead of shown.
   */
  private isShadowMode(): boolean {
    try {
      return (
        vscode.workspace.getConfiguration("ide.agent").get<boolean>("smart_mode_classifier_shadow_mode", false) === true
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
     * GAPS-12 (approval-card-diff): optional file-edit diff payload
     * (engine patch trimmed to context 2). Rendered verbatim by the
     * approval card; omitted for non-file-edit approvals.
     */
    approvalDetails?: ApprovalDetails,
    /**
     * GAPS-22B (review-labels-always-run-construction): shell/terminal
     * approval candidate command labels. When non-empty, the default
     * "approve-allowlist" option label is built Cursor-verbatim via
     * buildShellAllowlistLabel (binary `ycp`): `Always Run '<first>'` for
     * one command, `Always Run '<first>' + N` for several. Mirrors
     * `ycp(l?.allowlistCandidates?.map(ZpS))` where `ZpS(t) => t.label`.
     * Non-shell approvals pass nothing and keep the generic labels — their
     * per-option strings resolve via Cursor's `Ev` nls enum client-side,
     * which is not statically resolvable and is not fabricated here.
     */
    allowlistCandidates?: readonly string[],
    /**
     * DEV-GAPS-66/W66A (`agent-accept-pending-decisions`): the engine tool
     * identity for this approval (e.g. "bash", "edit", "mcp__srv__tool") —
     * stored on the request as `clientSideTool` for the pending-decision
     * group algorithm. The engine adapter passes its `action` verbatim; the
     * stub engine passes the tool-call kind. Omitted for legacy callers.
     */
    clientSideTool?: string,
  ): Promise<ApprovalResult> {
    approvalSeq += 1;
    const approvalId = `approval-${approvalSeq}`;
    // The allowlist key is fixed at request time so the resolve path stores
    // exactly the identity that was checked here.
    const identityKey = this.allowlistKey(allowlistIdentity ?? title);
    // GAPS-22B: shell approvals label the allowlist button Cursor-verbatim
    // (binary `ycp` → `rt?.fullLabel`). The honest fallback stays
    // "Approve and allowlist" — Cursor's per-option button strings resolve
    // via the `Ev` nls enum client-side and are not statically resolvable.
    const allowlistOptionLabel =
      buildShellAllowlistLabel(allowlistCandidates)?.fullLabel ?? "Approve and allowlist";
    const request: ApprovalRequest = {
      approvalId,
      toolCallId,
      title,
      reasons,
      options: customOptions ?? [
        { id: "approve-once", label: "Approve once" },
        { id: "approve-allowlist", label: allowlistOptionLabel },
        { id: "skip", label: "Skip" },
      ],
      ...(approvalDetails ? { approvalDetails } : {}),
      ...(clientSideTool !== undefined ? { clientSideTool } : {}),
      // Binary decision `startedAt: Date.now()` (3.25.9 @27756684).
      startedAt: Date.now(),
    };
    // DEV-GAPS-10 (rex-004): `.cursor/permissions.json` policy — evaluated
    // FIRST, before the stored allowlist, because approvalMode "manual"
    // (Ask Every Time) must bypass even stored allowlist entries, and
    // "unrestricted" must auto-approve regardless of any other state.
    // (Shadow mode below still only affects the card path — an
    // auto-approved tool never reaches it.)
    const fileMode = this.filePermissions?.approvalMode;
    if (fileMode === "unrestricted") {
      return Promise.resolve({ optionId: "approve-once" });
    }
    if (fileMode !== "manual") {
      if (this.filePermissions && matchesFileAllowlist(this.filePermissions, identityKey)) {
        return Promise.resolve({ optionId: "approve-once" });
      }
      // Allowlisted identities never expire: an "Approve and allowlist"
      // decision for the same tool identity auto-resolves without re-showing
      // the card.
      if (this.isAllowlisted(identityKey)) {
        return Promise.resolve({ optionId: "approve-once" });
      }
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
    // An "Approve and allowlist" decision is remembered indefinitely
    // (no expiry — Cursor's mcpAllowedTools has no TTL) so the same tool
    // identity does not re-prompt.
    if (result?.optionId === "approve-allowlist") {
      this.allowlistStore.add(entry.allowlistKey);
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
   * All currently-pending approval requests (the agent turn awaits each).
   * Used by the Chat Inbox ("what needs attention") to list real pending
   * approvals across chat tabs — read-only snapshot, no fabricated state.
   */
  getPendingApprovals(): ApprovalRequest[] {
    return [...this.pending.values()].map((entry) => entry.request);
  }

  /**
   * DEV-GAPS-66/W66A (`agent-accept-pending-decisions`): the pending user
   * decision GROUP for `composer.acceptComposerStep` — binary-verbatim port
   * of the two layers in workbench.glass.main.js 3.25.9:
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
   * actions (`TERMINAL_ACTIONS`: "bash"/"shell"/"shell_tool_call"); the
   * single binary category `file_modification` maps to the fork engine's
   * file-edit action "edit" (the engine emits one action for edits and
   * writes — no EDIT_FILE_V2 analog exists locally, so the set has one
   * member; `areToolsSimilar` itself is ported unchanged).
   *
   * HONEST-DIVERGENCE (ask-question fallback): when no approval decisions
   * are pending the binary falls back to the latest answerable ASK_QUESTION
   * decision whose `accept()` answers with the question UI's current
   * selections. The fork's clarifying questions
   * (ComposerDataService.pendingQuestions) live in the webview and expose
   * no current-selection state to the host, so there is no honest
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
      title: entry.request.title,
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
 * DEV-GAPS-66/W66A: binary-verbatim `areToolsSimilar` port
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

export function areToolsSimilar(a: string, b: string): boolean {
  if (a === b) {
    return true;
  }
  const categoryA = pendingDecisionToolCategory(a);
  const categoryB = pendingDecisionToolCategory(b);
  return categoryA !== undefined && categoryA === categoryB;
}
