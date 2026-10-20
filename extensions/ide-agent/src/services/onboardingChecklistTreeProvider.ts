import * as vscode from "vscode";
import { OnboardingChecklistService, OnboardingChecklistItem } from "./onboardingChecklistService";

/**
 * OnboardingChecklistTreeProvider — renders OnboardingChecklistService into
 * the `ideAgent.onboardingChecklist` tree view ("Onboarding" in the IDE Agent
 * activity bar).
 *
 * Each pending item gets a checkbox (complete/uncheck via
 * `onDidChangeCheckboxState` on the owning TreeView) plus inline context-menu
 * commands for complete and dismiss. Once every item is completed or
 * dismissed the view shows a single "all done" node instead of an empty
 * list; the view itself can be hidden via the `ide.onboarding.showChecklist`
 * setting (the view contribution is gated on that config).
 *
 * HONEST-DIVERGENCE: Cursor's actual onboarding checklist UI could not be
 * reversed from the 3.25.9 bundle (no docs describe it), so the exact
 * layout here is our own minimal rendering of the verified contract:
 * listable, completable, dismissible items.
 */

export type OnboardingTreeNode =
  | { node: "item"; item: OnboardingChecklistItem }
  | { node: "done" }
  | { node: "dismissedHeader"; count: number };

const doneNode: OnboardingTreeNode = { node: "done" };

export class OnboardingChecklistTreeProvider
  implements vscode.TreeDataProvider<OnboardingTreeNode>, vscode.Disposable
{
  private readonly emitter = new vscode.EventEmitter<OnboardingTreeNode | undefined>();
  readonly onDidChangeTreeData = this.emitter.event;
  private readonly disposable: vscode.Disposable;

  constructor(private readonly checklist: OnboardingChecklistService) {
    this.disposable = checklist.onDidChange(() => this.emitter.fire(undefined));
  }

  dispose(): void {
    this.disposable.dispose();
    this.emitter.dispose();
  }

  getTreeItem(node: OnboardingTreeNode): vscode.TreeItem {
    if (node.node === "done") {
      const item = new vscode.TreeItem("You're all set — onboarding complete!");
      item.contextValue = "ideAgent.onboardingDone";
      item.iconPath = new vscode.ThemeIcon("check-all");
      return item;
    }
    if (node.node === "dismissedHeader") {
      const item = new vscode.TreeItem(`Dismissed (${node.count})`);
      item.contextValue = "ideAgent.onboardingDismissedHeader";
      item.iconPath = new vscode.ThemeIcon("eye-closed");
      return item;
    }
    const { item: check } = node;
    const treeItem = new vscode.TreeItem(check.title, vscode.TreeItemCollapsibleState.None);
    treeItem.description = check.description;
    treeItem.tooltip = check.description;
    treeItem.contextValue = "ideAgent.onboardingItem";
    treeItem.iconPath = new vscode.ThemeIcon(check.completed ? "check" : "circle-outline");
    const checkboxState = (vscode as { TreeItemCheckboxState?: typeof vscode.TreeItemCheckboxState })
      .TreeItemCheckboxState;
    if (checkboxState) {
      treeItem.checkboxState = check.completed ? checkboxState.Checked : checkboxState.Unchecked;
    }
    treeItem.command = {
      command: "ide.onboarding.completeItem",
      title: "Mark onboarding item complete",
      arguments: [check.id],
    };
    return treeItem;
  }

  getChildren(node?: OnboardingTreeNode): vscode.ProviderResult<OnboardingTreeNode[]> {
    if (node) {
      return [];
    }
    const items = this.checklist.listItems();
    const pending = items.filter((i) => !i.completed && !i.dismissed);
    const completed = items.filter((i) => i.completed && !i.dismissed);
    const dismissed = items.filter((i) => i.dismissed);
    if (pending.length === 0 && completed.length === 0 && dismissed.length === 0) {
      // Cannot happen with the current defaults (7 items), but stay honest.
      return [doneNode];
    }
    if (pending.length === 0) {
      return [doneNode];
    }
    const nodes: OnboardingTreeNode[] = pending.map((item) => ({ node: "item", item }) as OnboardingTreeNode);
    for (const item of completed) {
      nodes.push({ node: "item", item });
    }
    if (dismissed.length > 0) {
      nodes.push({ node: "dismissedHeader", count: dismissed.length });
    }
    return nodes;
  }
}
