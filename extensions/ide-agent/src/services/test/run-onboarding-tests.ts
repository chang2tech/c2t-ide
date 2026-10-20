/**
 * DEV-GAPS-5-ONBOARDING tests (node:test, vscode stubbed via ./vscode-stub).
 *
 * Covers OnboardingChecklistService + OnboardingChecklistTreeProvider:
 *  - Fresh state: 7 default items (OUR OWN list — Cursor does not publish
 *    its items), all pending, snapshot allDone=false, remaining=7.
 *  - completeItem / uncompleteItem / dismissItem mutate state, persist to
 *    globalState under `ide.onboarding.checklist.v1`, fire onDidChange,
 *    and ignore unknown ids (return false).
 *  - resetChecklist restores the full pending list and fires onDidChange.
 *  - Persistence merge: a second service instance over the same globalState
 *    store reloads flags; stale/unknown stored ids are dropped; state with
 *    a wrong version or shape is ignored (treated as fresh).
 *  - reportSnapshot returns total/completed/dismissed/remaining/allDone and
 *    the item list; nothing leaves the machine (no sends asserted — the
 *    service holds no network surface at all).
 *  - Tree provider: pending items first (in default order), completed items
 *    after, a dismissed-count header when items were dismissed, and a
 *    single "done" node once every item is completed or dismissed.
 *
 * Run after `tsc`:  node --test out/services/test/run-onboarding-tests.js
 */
import { describe, it } from "node:test";
import * as assert from "node:assert";
import "./vscode-stub";
import {
  OnboardingChecklistService,
  ONBOARDING_CHECKLIST_STATE_KEY,
  OnboardingChecklistItem,
} from "../onboardingChecklistService";
import { OnboardingChecklistTreeProvider, OnboardingTreeNode } from "../onboardingChecklistTreeProvider";

/** In-memory globalState shared across service instances in a test. */
function makeContext() {
  const store = new Map<string, unknown>();
  return {
    context: {
      subscriptions: [],
      globalState: {
        get: (key: string) => store.get(key),
        update: async (key: string, value: unknown) => {
          store.set(key, value);
        },
      },
      workspaceState: { get: () => undefined, update: async () => undefined },
    } as unknown as import("vscode").ExtensionContext,
    store,
  };
}

function ids(items: OnboardingChecklistItem[]): string[] {
  return items.map((i) => i.id);
}

describe("OnboardingChecklistService", () => {
  it("starts with the 7 default items, all pending", () => {
    const { context } = makeContext();
    const svc = new OnboardingChecklistService(context);
    try {
      const items = svc.listItems();
      assert.strictEqual(items.length, 7);
      assert.ok(items.every((i) => !i.completed && !i.dismissed));
      // Ordered by `order`.
      assert.deepStrictEqual(
        items.map((i) => i.order),
        [0, 1, 2, 3, 4, 5, 6],
      );
      assert.strictEqual(svc.allDone, false);
      const snap = svc.reportSnapshot();
      assert.strictEqual(snap.total, 7);
      assert.strictEqual(snap.completed, 0);
      assert.strictEqual(snap.dismissed, 0);
      assert.strictEqual(snap.remaining, 7);
      assert.strictEqual(snap.allDone, false);
      assert.strictEqual(snap.items.length, 7);
    } finally {
      svc.dispose();
    }
  });

  it("completeItem persists flags and fires onDidChange; ignores unknown ids", async () => {
    const { context, store } = makeContext();
    const svc = new OnboardingChecklistService(context);
    let fires = 0;
    const sub = svc.onDidChange(() => fires++);
    try {
      const first = svc.listItems()[0]!;
      assert.strictEqual(await svc.completeItem(first.id), true);
      assert.strictEqual(fires, 1);
      assert.strictEqual(svc.listItems()[0]!.completed, true);

      const stored = store.get(ONBOARDING_CHECKLIST_STATE_KEY) as {
        version: number;
        items: Record<string, { completed: boolean; dismissed: boolean }>;
      };
      assert.strictEqual(stored.version, 1);
      assert.strictEqual(stored.items[first.id]!.completed, true);

      assert.strictEqual(await svc.completeItem("no-such-item"), false);
      assert.strictEqual(fires, 1, "unknown ids must not fire change events");
    } finally {
      sub.dispose();
      svc.dispose();
    }
  });

  it("uncompleteItem and dismissItem round-trip; dismissed items leave visibleItems", async () => {
    const { context } = makeContext();
    const svc = new OnboardingChecklistService(context);
    try {
      const [a, b] = svc.listItems();
      await svc.completeItem(a!.id);
      assert.strictEqual(await svc.uncompleteItem(a!.id), true);
      assert.strictEqual(svc.listItems()[0]!.completed, false);

      await svc.dismissItem(b!.id);
      assert.strictEqual(svc.listItems()[1]!.dismissed, true);
      assert.deepStrictEqual(ids(svc.visibleItems()), ids(svc.listItems().slice(0, 1)).concat(ids(svc.listItems().slice(2))));
      assert.strictEqual(svc.reportSnapshot().dismissed, 1);
      assert.strictEqual(svc.reportSnapshot().remaining, 6);
      assert.strictEqual(await svc.dismissItem("no-such-item"), false);
      assert.strictEqual(await svc.uncompleteItem("no-such-item"), false);
    } finally {
      svc.dispose();
    }
  });

  it("allDone becomes true when every item is completed or dismissed", async () => {
    const { context } = makeContext();
    const svc = new OnboardingChecklistService(context);
    try {
      const items = svc.listItems();
      for (const item of items.slice(0, 5)) {
        await svc.completeItem(item.id);
      }
      for (const item of items.slice(5)) {
        await svc.dismissItem(item.id);
      }
      assert.strictEqual(svc.allDone, true);
      const snap = svc.reportSnapshot();
      assert.strictEqual(snap.allDone, true);
      assert.strictEqual(snap.remaining, 0);
      assert.strictEqual(snap.completed, 5);
      assert.strictEqual(snap.dismissed, 2);
    } finally {
      svc.dispose();
    }
  });

  it("resetChecklist restores the full pending list and fires onDidChange", async () => {
    const { context, store } = makeContext();
    const svc = new OnboardingChecklistService(context);
    let fires = 0;
    const sub = svc.onDidChange(() => fires++);
    try {
      const first = svc.listItems()[0]!;
      await svc.completeItem(first.id);
      assert.strictEqual(fires, 1);
      await svc.resetChecklist();
      assert.strictEqual(fires, 2);
      assert.ok(svc.listItems().every((i) => !i.completed && !i.dismissed));
      assert.strictEqual(svc.allDone, false);
      const stored = store.get(ONBOARDING_CHECKLIST_STATE_KEY) as { items: Record<string, unknown> };
      assert.deepStrictEqual(stored.items, {}, "persisted flags are cleared on reset");
    } finally {
      sub.dispose();
      svc.dispose();
    }
  });

  it("flags reload on a new instance over the same store; stale ids and bad state are ignored", async () => {
    const { context, store } = makeContext();
    const svc = new OnboardingChecklistService(context);
    try {
      const [a, b] = svc.listItems();
      await svc.completeItem(a!.id);
      await svc.dismissItem(b!.id);
    } finally {
      svc.dispose();
    }

    // Inject a stale unknown id into persisted state — it must be dropped.
    const stored = store.get(ONBOARDING_CHECKLIST_STATE_KEY) as {
      version: number;
      items: Record<string, { completed: boolean; dismissed: boolean }>;
    };
    stored.items["ghost-from-the-past"] = { completed: true, dismissed: false };

    const svc2 = new OnboardingChecklistService(context);
    try {
      const [a2, b2] = svc2.listItems();
      assert.strictEqual(a2!.completed, true, "completed flag survives reload");
      assert.strictEqual(b2!.dismissed, true, "dismissed flag survives reload");
      assert.strictEqual(svc2.listItems().length, 7, "stale stored ids are not listed");
    } finally {
      svc2.dispose();
    }
  });

  it("corrupt persisted state is treated as fresh (never throws)", () => {
    const { context, store } = makeContext();
    store.set(ONBOARDING_CHECKLIST_STATE_KEY, { version: 999, items: "junk" });
    const svc = new OnboardingChecklistService(context);
    try {
      assert.strictEqual(svc.listItems().length, 7);
      assert.strictEqual(svc.allDone, false);
    } finally {
      svc.dispose();
    }
    store.set(ONBOARDING_CHECKLIST_STATE_KEY, null);
    const svc2 = new OnboardingChecklistService(context);
    try {
      assert.strictEqual(svc2.listItems().length, 7);
    } finally {
      svc2.dispose();
    }
  });
});

describe("OnboardingChecklistTreeProvider", () => {
  it("lists pending items first (default order), then completed, then a dismissed header", async () => {
    const { context } = makeContext();
    const svc = new OnboardingChecklistService(context);
    const provider = new OnboardingChecklistTreeProvider(svc);
    try {
      const items = svc.listItems();
      await svc.completeItem(items[2]!.id);
      await svc.dismissItem(items[5]!.id);

      const roots = provider.getChildren() as OnboardingTreeNode[];
      const pendingNodes = roots.filter((n) => n.node === "item" && !n.item.completed);
      const completedNodes = roots.filter((n) => n.node === "item" && n.item.completed);
      const header = roots.find((n) => n.node === "dismissedHeader");
      assert.deepStrictEqual(
        ids(pendingNodes.map((n) => (n as { item: OnboardingChecklistItem }).item)),
        [items[0]!.id, items[1]!.id, items[3]!.id, items[4]!.id, items[6]!.id],
      );
      assert.deepStrictEqual(
        ids(completedNodes.map((n) => (n as { item: OnboardingChecklistItem }).item)),
        [items[2]!.id],
      );
      assert.ok(header && header.node === "dismissedHeader" && header.count === 1);

      // Tree items carry the complete command and a checkbox state.
      const treeItem = provider.getTreeItem(pendingNodes[0]!);
      assert.strictEqual(treeItem.contextValue, "ideAgent.onboardingItem");
      assert.strictEqual(treeItem.command!.command, "ide.onboarding.completeItem");
      assert.deepStrictEqual(treeItem.command!.arguments, [items[0]!.id]);
      assert.strictEqual((treeItem as { checkboxState?: number }).checkboxState, 0);

      const doneTreeItem = provider.getTreeItem(completedNodes[0]!);
      assert.strictEqual((doneTreeItem as { checkboxState?: number }).checkboxState, 1);
    } finally {
      provider.dispose();
      svc.dispose();
    }
  });

  it("shows a single done node once every item is completed or dismissed", async () => {
    const { context } = makeContext();
    const svc = new OnboardingChecklistService(context);
    const provider = new OnboardingChecklistTreeProvider(svc);
    try {
      for (const item of svc.listItems()) {
        await svc.completeItem(item.id);
      }
      const roots = provider.getChildren() as OnboardingTreeNode[];
      assert.strictEqual(roots.length, 1);
      assert.strictEqual(roots[0]!.node, "done");
      const treeItem = provider.getTreeItem(roots[0]!);
      assert.strictEqual(treeItem.contextValue, "ideAgent.onboardingDone");
    } finally {
      provider.dispose();
      svc.dispose();
    }
  });

  it("fires onDidChangeTreeData when the service changes", async () => {
    const { context } = makeContext();
    const svc = new OnboardingChecklistService(context);
    const provider = new OnboardingChecklistTreeProvider(svc);
    let fires = 0;
    const sub = provider.onDidChangeTreeData(() => fires++);
    try {
      await svc.completeItem(svc.listItems()[0]!.id);
      assert.strictEqual(fires, 1);
    } finally {
      sub.dispose();
      provider.dispose();
      svc.dispose();
    }
  });
});
