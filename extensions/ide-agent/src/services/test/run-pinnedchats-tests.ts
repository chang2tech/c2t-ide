/**
 * DEV-PINNED-CHATS tests (node:test, vscode stubbed via ./vscode-stub).
 *
 * Cursor 2.1 parity (cursor.com/changelog/page/13): "In the agent sidebar,
 * pin chats at the top for future reference."
 *
 * Covers:
 *  - ChatTabService.pinChat / unpinChat: state, idempotency, unknown ids,
 *    tabsChanged events.
 *  - compareChatTabs / getTabStates: pinned first in pin order, then time
 *    (creation) order; unpinning returns a chat to time order.
 *  - Persist: pin set written to globalState on pin/unpin/close; restored
 *    for matching ids on service construction; closed tabs drop their pin
 *    entry.
 *
 * Run after `tsc`:  node --test out/services/test/run-pinnedchats-tests.js
 */
import { after, describe, it } from "node:test";
import * as assert from "node:assert";
import "./vscode-stub";
import { ChatTabService, compareChatTabs } from "../chatTabService";

const PINNED_KEY = "ideAgent.pinnedChats";

// W68C: every ChatTabService created below is tracked so the file-level
// after() can dispose it. An undisposed ChatTabService leaves each tab's
// ComposerDataService alive, whose CheckpointService arms a ref'd 15 s
// activation timer (then a re-arming 10 min interval) in
// CheckpointStorageCompareService — that keeps the event loop alive
// forever after all tests pass ("Promise resolution is still pending...").
// dispose() is idempotent; same pattern as run-chattabs-tests.ts.
const trackedDisposables = new Set<{ dispose(): void }>();
function track<T extends { dispose(): void }>(d: T): T {
  trackedDisposables.add(d);
  return d;
}
after(() => {
  for (const d of trackedDisposables) {
    try {
      d.dispose();
    } catch {
      /* teardown must never fail the run */
    }
  }
  trackedDisposables.clear();
});

/** Map-backed Memento so persist round-trips are observable. */
function makeMemento(backing: Map<string, unknown>) {
  return {
    get: (key: string) => backing.get(key),
    update: async (key: string, value: unknown) => {
      backing.set(key, value);
    },
  };
}

function makeContext(store: Map<string, unknown>) {
  return {
    subscriptions: [],
    globalState: makeMemento(store),
    workspaceState: makeMemento(new Map<string, unknown>()),
  } as unknown as import("vscode").ExtensionContext;
}

/**
 * tabSeq is module-level and starts at 0 per test process: every
 * ChatTabService constructor consumes one id ("New chat" tab) and every
 * createTab consumes one more. This file is the only consumer, so we can
 * predict the id of the NEXT created tab — needed to seed the persisted
 * pin set before construction (restore runs in the constructor).
 */
let creations = 0;
function nextTabId(): string {
  return `tab-${creations + 1}`;
}
function makeService(store: Map<string, unknown>): ChatTabService {
  creations += 1;
  return track(new ChatTabService(makeContext(store)));
}
function makeTab(svc: ChatTabService, title?: string) {
  creations += 1;
  return svc.createTab(title ? { title } : {});
}

const flush = () => new Promise<void>((r) => setImmediate(r));

describe("ChatTabService.pinChat / unpinChat", () => {
  it("pins a chat: pinned=true, pinnedAt set, tabsChanged fired", () => {
    const tabs = makeService(new Map());
    const t = makeTab(tabs, "work");
    let changed = 0;
    tabs.onDidChange((e) => {
      if (e.kind === "tabsChanged") {
        changed += 1;
      }
    });
    assert.equal(t.pinned, false);
    assert.equal(tabs.pinChat(t.id), true);
    assert.equal(t.pinned, true);
    assert.ok(typeof t.pinnedAt === "number");
    assert.ok(changed >= 1);
  });

  it("pin is idempotent: re-pinning keeps the original pin position", () => {
    const tabs = makeService(new Map());
    const t = makeTab(tabs, "work");
    assert.equal(tabs.pinChat(t.id), true);
    const firstPinAt = t.pinnedAt;
    t.pinnedAt = 1111; // simulate an earlier pin
    assert.equal(tabs.pinChat(t.id), false);
    assert.equal(t.pinned, true);
    assert.equal(t.pinnedAt, 1111);
    assert.equal(firstPinAt === 1111, false); // sanity: we really changed it
  });

  it("pinChat on an unknown id returns false", () => {
    const tabs = makeService(new Map());
    assert.equal(tabs.pinChat("tab-nope"), false);
  });

  it("unpinChat clears the pin and fires tabsChanged", () => {
    const tabs = makeService(new Map());
    const t = makeTab(tabs, "work");
    tabs.pinChat(t.id);
    let changed = 0;
    tabs.onDidChange((e) => {
      if (e.kind === "tabsChanged") {
        changed += 1;
      }
    });
    assert.equal(tabs.unpinChat(t.id), true);
    assert.equal(t.pinned, false);
    assert.equal(t.pinnedAt, undefined);
    assert.ok(changed >= 1);
  });

  it("unpinChat on an unpinned or unknown id returns false", () => {
    const tabs = makeService(new Map());
    const t = makeTab(tabs, "work");
    assert.equal(tabs.unpinChat(t.id), false);
    assert.equal(tabs.unpinChat("tab-nope"), false);
  });
});

describe("compareChatTabs / getTabStates ordering", () => {
  it("sorts pinned first by pin time, then by creation time", () => {
    const tabs = makeService(new Map());
    const a = tabs.listTabs()[0]!; // initial "New chat"
    const b = makeTab(tabs, "second");
    const c = makeTab(tabs, "third");
    // Pin c first, then b — then force deterministic pin times.
    tabs.pinChat(c.id);
    c.pinnedAt = 3000;
    tabs.pinChat(b.id);
    b.pinnedAt = 1000;
    const order = tabs.getTabStates().map((s) => s.id);
    assert.deepEqual(order, [b.id, c.id, a.id]);
    assert.deepEqual(
      tabs.getTabStates().map((s) => s.pinned),
      [true, true, false],
    );
  });

  it("unpinning returns the chat to time order", () => {
    const tabs = makeService(new Map());
    const a = tabs.listTabs()[0]!;
    const b = makeTab(tabs, "second");
    const c = makeTab(tabs, "third");
    tabs.pinChat(b.id);
    b.pinnedAt = 1000;
    tabs.pinChat(c.id);
    c.pinnedAt = 2000;
    assert.deepEqual(
      tabs.getTabStates().map((s) => s.id),
      [b.id, c.id, a.id],
    );
    tabs.unpinChat(b.id);
    assert.deepEqual(
      tabs.getTabStates().map((s) => s.id),
      [c.id, a.id, b.id],
    );
  });

  it("compareChatTabs is a total order (unpinned ties break by id)", () => {
    const mk = (id: string, createdAt: number, pinned: boolean, pinnedAt?: number) => ({
      id,
      createdAt,
      pinned,
      pinnedAt,
    });
    assert.ok(compareChatTabs(mk("a", 5, true, 9), mk("b", 1, false)) < 0);
    assert.ok(compareChatTabs(mk("a", 5, false), mk("b", 1, true, 9)) > 0);
    assert.ok(compareChatTabs(mk("a", 1, true, 2), mk("b", 9, true, 1)) > 0);
    assert.ok(compareChatTabs(mk("a", 2, false), mk("b", 1, false)) > 0);
    assert.equal(compareChatTabs(mk("a", 1, false), mk("a", 1, false)), 0);
    assert.ok(compareChatTabs(mk("a", 1, false), mk("b", 1, false)) < 0);
  });
});

describe("pinned chats persist via globalState", () => {
  it("writes the pin set on pin and on unpin", async () => {
    const store = new Map<string, unknown>();
    const tabs = makeService(store);
    const t = makeTab(tabs, "work");
    tabs.pinChat(t.id);
    await flush();
    const saved = store.get(PINNED_KEY) as Array<{ id: string; pinnedAt: number }>;
    assert.ok(Array.isArray(saved));
    assert.equal(saved.length, 1);
    assert.equal(saved[0]!.id, t.id);
    assert.equal(saved[0]!.pinnedAt, t.pinnedAt);
    tabs.unpinChat(t.id);
    await flush();
    assert.deepEqual(store.get(PINNED_KEY), []);
  });

  it("restores pins for ids that exist when the service is constructed", () => {
    const store = new Map<string, unknown>();
    const id = nextTabId();
    store.set(PINNED_KEY, [{ id, pinnedAt: 777 }]);
    const tabs = makeService(store);
    const first = tabs.listTabs()[0]!;
    assert.equal(first.id, id);
    assert.equal(first.pinned, true);
    assert.equal(first.pinnedAt, 777);
  });

  it("ignores persisted entries for ids that do not exist (no throw)", () => {
    const store = new Map<string, unknown>();
    store.set(PINNED_KEY, [{ id: "tab-ghost", pinnedAt: 1 }, null, "junk"]);
    const tabs = makeService(store);
    assert.equal(tabs.listTabs().every((t) => !t.pinned), true);
  });

  it("closing a pinned tab drops its entry from the persisted pin set", async () => {
    const store = new Map<string, unknown>();
    const tabs = makeService(store);
    const a = tabs.listTabs()[0]!;
    const b = makeTab(tabs, "work");
    tabs.pinChat(a.id);
    tabs.pinChat(b.id);
    await flush();
    assert.equal((store.get(PINNED_KEY) as unknown[]).length, 2);
    await tabs.closeTab(b.id);
    await flush();
    const saved = store.get(PINNED_KEY) as Array<{ id: string }>;
    assert.deepEqual(
      saved.map((e) => e.id),
      [a.id],
    );
  });

  it("caps the persisted pin set at 75 (Cursor parity: pinnedComposers max 75)", async () => {
    const store = new Map<string, unknown>();
    const tabs = makeService(store);
    const ids: string[] = [];
    for (let i = 0; i < 80; i++) {
      const t = makeTab(tabs, `chat-${i}`);
      assert.equal(tabs.pinChat(t.id), true);
      t.pinnedAt = 1000 + i; // deterministic pin order
      ids.push(t.id);
    }
    // One more pin/unpin cycle so the final persist reflects the deterministic order.
    const extra = makeTab(tabs, "extra");
    tabs.pinChat(extra.id);
    tabs.unpinChat(extra.id);
    await flush();
    const saved = store.get(PINNED_KEY) as Array<{ id: string; pinnedAt: number }>;
    assert.ok(Array.isArray(saved));
    assert.equal(saved.length, 75);
    assert.deepEqual(
      saved.map((e) => e.id),
      ids.slice(0, 75),
    );
  });

  it("never throws when globalState is broken", async () => {
    const bad = {
      subscriptions: [],
      globalState: {
        get: () => {
          throw new Error("boom");
        },
        update: async () => {
          throw new Error("boom");
        },
      },
      workspaceState: { get: () => undefined, update: async () => undefined },
    } as unknown as import("vscode").ExtensionContext;
    creations += 1;
    const tabs = track(new ChatTabService(bad));
    const t = makeTab(tabs, "work");
    assert.equal(tabs.pinChat(t.id), true);
    assert.equal(tabs.unpinChat(t.id), true);
    await tabs.closeTab(t.id);
    await flush();
  });
});
