import * as vscode from "vscode";
import { ChatInboxService, ChatInboxItem } from "./chatInboxService";

/**
 * ChatInboxTreeProvider — renders ChatInboxService into the
 * `ideAgent.inboxView` tree view ("Inbox" in the IDE Agent activity bar).
 *
 * HONEST-DIVERGENCE (2026-10-20, DEV-GAPS-50; audit chat-inbox-surface):
 * This STANDALONE tree-view surface is the TEAM'S OWN DESIGN, not a
 * Cursor-parity surface. Cursor has no standalone Chat Inbox view — its
 * Inbox surface is bound to the Agents Window, whose exact layout could not
 * be reversed from the minified 3.25.9 bundle. Only the CONCEPT ("what needs
 * attention") is real Cursor parity; the tree-view presentation here is our
 * interpretation. See full evidence + divergence notes in
 * chatInboxService.ts.
 *
 * Sections mirror the concept evidence: "Needs attention" (pending approvals
 * + unanswered clarifying questions — both block the agent) and "Running"
 * (agents currently working — Cursor changelog "organizes agents").
 * Counts in section labels come from the real services, never fabricated.
 * Clicking an item reveals the chat tab that needs the user.
 */

export type InboxTreeNode =
  | { node: "section"; key: "attention" | "running"; label: string }
  | { node: "item"; item: ChatInboxItem }
  | { node: "empty" };

export class ChatInboxTreeProvider implements vscode.TreeDataProvider<InboxTreeNode>, vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<InboxTreeNode | undefined>();
  readonly onDidChangeTreeData = this.emitter.event;
  private readonly disposable: vscode.Disposable;

  constructor(private readonly inbox: ChatInboxService) {
    this.disposable = inbox.onDidChange(() => this.emitter.fire(undefined));
  }

  getTreeItem(node: InboxTreeNode): vscode.TreeItem {
    if (node.node === "section") {
      const item = new vscode.TreeItem(node.label, vscode.TreeItemCollapsibleState.Expanded);
      item.contextValue = "ideAgent.inboxSection";
      return item;
    }
    if (node.node === "empty") {
      const item = new vscode.TreeItem("All caught up — nothing needs attention.");
      item.contextValue = "ideAgent.inboxEmpty";
      return item;
    }
    const { item } = node;
    const treeItem = new vscode.TreeItem(item.title, vscode.TreeItemCollapsibleState.None);
    treeItem.description = item.tabTitle;
    if (item.detail) {
      treeItem.tooltip = item.detail;
    }
    treeItem.contextValue = `ideAgent.inboxItem.${item.kind}`;
    treeItem.iconPath =
      item.kind === "approval"
        ? new vscode.ThemeIcon("shield")
        : item.kind === "question"
          ? new vscode.ThemeIcon("question")
          : new vscode.ThemeIcon("sync~spin");
    treeItem.command = {
      command: "ideAgent.inbox.revealTab",
      title: "Go to chat tab",
      arguments: [item.tabId],
    };
    return treeItem;
  }

  getChildren(node?: InboxTreeNode): vscode.ProviderResult<InboxTreeNode[]> {
    if (!node) {
      const attention = this.inbox.needsAttentionCount;
      const running = this.inbox.runningCount;
      if (attention === 0 && running === 0) {
        return [{ node: "empty" }];
      }
      const sections: InboxTreeNode[] = [];
      if (attention > 0) {
        sections.push({ node: "section", key: "attention", label: `Needs attention (${attention})` });
      }
      if (running > 0) {
        sections.push({ node: "section", key: "running", label: `Running (${running})` });
      }
      return sections;
    }
    if (node.node === "section") {
      const items = this.inbox.getItems();
      if (node.key === "attention") {
        return items.filter((i) => i.kind !== "running").map((i) => ({ node: "item", item: i }) as InboxTreeNode);
      }
      return items.filter((i) => i.kind === "running").map((i) => ({ node: "item", item: i }) as InboxTreeNode);
    }
    return [];
  }

  dispose(): void {
    this.disposable.dispose();
    this.emitter.dispose();
  }
}
