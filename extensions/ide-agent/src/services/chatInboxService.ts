import * as vscode from "vscode";
import { ChatTabService } from "./chatTabService";
import type { ApprovalRequest } from "./humanReviewService";
import type { ClarifyingQuestion } from "../model";

/**
 * ChatInboxService — "what needs attention" aggregator (Cursor Inbox parity).
 *
 * EVIDENCE (Cursor 3.25.9, verified 2026-10-19):
 *  - cursor.com/changelog (via deep-docs-all.md): "Inbox — organizes agents,
 *    PRs in review, what needs attention".
 *  - 3.0 "Glass" changelog (via deep-changelog-timeline.md): "unified agent
 *    inbox (Slack/GitHub/Linear/mobile)".
 *  - Binary (workbench.desktop.main.js / workbench.glass.main.js):
 *      * composer data fields `hasInteractiveChildInboxActivity` and
 *        `interactiveChildInboxLastPresentedKey`;
 *      * `_stampInteractiveChildInboxParent` — a subagent/child completion
 *        stamps the PARENT composer, i.e. inbox activity surfaces on the
 *        composer that needs the user's attention;
 *      * `inboxGateEnabled` → "none" | "background-task" | "file-inbox";
 *      * `_persistCloudChildCompletionToLocalParentInbox` — cloud child
 *        completions surface in the local parent's inbox;
 *      * Agents-window status dots: "needs-attention" → "Needs attention",
 *        "done-unseen" → "Completed, unread", "error" → "Error",
 *        "done-seen" → "Completed".
 *
 * HONEST-DIVERGENCE (2026-10-19):
 *  - No "Inbox" view id / label was found in the 3.25.9 bundle — Cursor's
 *    Inbox surface lives inside its Agents Window, whose exact layout could
 *    not be reversed from the minified bundle. This implements an honest
 *    minimal Inbox: a "needs attention" list over REAL data only.
 *  - "PRs in review" appears only in the changelog bullet; no wiring to the
 *    inbox was found in the binary (UNKNOWN) → NOT implemented here.
 *  - "done-unseen / Completed, unread" dots depend on per-composer
 *    unread-message tracking (`hasUnreadMessages` + last-presented keys),
 *    which this extension's ComposerDataService does not have → NOT
 *    implemented (no fabricated unread state).
 *  - SURFACE = TEAM DESIGN (2026-10-20, audit-fix-queue 2026-10-19 22:35):
 *    the standalone "Chat Inbox" tree view (`ChatInboxTreeProvider`) is the
 *    team's own surface design, NOT a Cursor-parity surface — Cursor has no
 *    standalone Chat Inbox view; its Inbox surface is bound to the Agents
 *    Window. The concept ("what needs attention") is real (evidence above);
 *    the tree-view surface is our interpretation.
 *
 * Sources (all real, never fabricated):
 *  - pending tool-call approvals: HumanReviewService (per-tab composer)
 *  - unanswered clarifying questions: ComposerDataService.getPendingQuestions()
 *  - running agent turns: ComposerDataService.isRunning (per tab)
 */

export type ChatInboxItemKind = "approval" | "question" | "running";

export interface ChatInboxItem {
  kind: ChatInboxItemKind;
  /** The chat tab that needs the user. */
  tabId: string;
  tabTitle: string;
  /** Human-readable line: approval title / question header / tab title. */
  title: string;
  /** Secondary line: approval reason / question body. */
  detail?: string;
  approvalId?: string;
  questionId?: string;
}

export class ChatInboxService implements vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<void>();
  /** Fires whenever the inbox contents may have changed. */
  readonly onDidChange = this.emitter.event;
  private readonly disposables: vscode.Disposable[] = [];
  /** tabId -> approval-event subscription, synced when tabs change. */
  private readonly approvalSubs = new Map<string, vscode.Disposable>();

  constructor(private readonly tabs: ChatTabService) {
    this.disposables.push(
      tabs.onDidChange((event) => {
        // tabsChanged covers tab create/close/rename/switch; composerEvent
        // covers turnState (running), questionAsked/questionAnswered and
        // bubble changes. Approval open/resolve does NOT flow through
        // composer events — each tab's HumanReviewService is subscribed
        // directly (syncApprovalSubscriptions).
        if (event.kind === "tabsChanged") {
          this.syncApprovalSubscriptions();
        }
        this.emitter.fire();
      }),
    );
    this.syncApprovalSubscriptions();
  }

  /** Keep one approval subscription per live tab (tabs come and go). */
  private syncApprovalSubscriptions(): void {
    const live = new Set(this.tabs.listTabs().map((t) => t.id));
    for (const [id, sub] of this.approvalSubs) {
      if (!live.has(id)) {
        sub.dispose();
        this.approvalSubs.delete(id);
      }
    }
    for (const tab of this.tabs.listTabs()) {
      if (!this.approvalSubs.has(tab.id)) {
        this.approvalSubs.set(
          tab.id,
          tab.composer.reviews.onDidChangeApproval(() => this.emitter.fire()),
        );
      }
    }
  }

  /**
   * Every item that needs the user right now, ordered: approvals first,
   * then unanswered questions (both block the agent), then running agents
   * ("organizes agents" — a running agent is not blocked, so it sorts last).
   * Tab creation order is preserved inside each group.
   */
  getItems(): ChatInboxItem[] {
    const items: ChatInboxItem[] = [];
    for (const tab of this.tabs.listTabs()) {
      const approvals: ApprovalRequest[] = tab.composer.reviews.getPendingApprovals();
      for (const request of approvals) {
        items.push({
          kind: "approval",
          tabId: tab.id,
          tabTitle: tab.title,
          title: request.title,
          detail: request.reasons[0],
          approvalId: request.approvalId,
        });
      }
      const questions: ClarifyingQuestion[] = tab.composer.getPendingQuestions();
      for (const question of questions) {
        items.push({
          kind: "question",
          tabId: tab.id,
          tabTitle: tab.title,
          title: question.header || question.question,
          detail: question.header ? question.question : undefined,
          questionId: question.questionId,
        });
      }
    }
    for (const tab of this.tabs.listTabs()) {
      if (tab.composer.isRunning) {
        items.push({
          kind: "running",
          tabId: tab.id,
          tabTitle: tab.title,
          title: tab.title,
        });
      }
    }
    return items;
  }

  /** Approvals + unanswered questions — the "Needs attention" count. */
  get needsAttentionCount(): number {
    let count = 0;
    for (const item of this.getItems()) {
      if (item.kind !== "running") {
        count += 1;
      }
    }
    return count;
  }

  get runningCount(): number {
    let count = 0;
    for (const item of this.getItems()) {
      if (item.kind === "running") {
        count += 1;
      }
    }
    return count;
  }

  dispose(): void {
    for (const sub of this.approvalSubs.values()) {
      sub.dispose();
    }
    this.approvalSubs.clear();
    for (const disposable of this.disposables) {
      disposable.dispose();
    }
  }
}
