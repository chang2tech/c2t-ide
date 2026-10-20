/**
 * DEV-SIDE-CHAT tests (node:test, vscode stubbed via ./vscode-stub).
 *
 * Covers:
 *  - SideChatService.createSideChat: hidden parent context snapshot
 *    (seed cap), own empty transcript, auto-title, active + reveal,
 *    context-key sync (ide.sideChat* — remapped from Cursor's sideChat*
 *    state keys).
 *  - Creation rejection: no resolvable parent → undefined +
 *    ide.sideChatAvailable=false + ide.sideChatCreationRejectedReason set;
 *    next success clears the rejection.
 *  - appendTurn / openSideChat / openSideChatForAgent / closeSideChat,
 *    including the UNKNOWN-semantics fallbacks documented in the service.
 *  - Durability: the hidden snapshot is frozen at creation; later parent
 *    turns don't leak in, and the side transcript stays independent.
 *  - registerSideChatCommands: registers exactly the 5 ide.* ids
 *    (Cursor binary ids in comments), pushes disposables to
 *    context.subscriptions, handlers work end-to-end.
 *
 * Run after `tsc`:  node --test out/services/test/run-side-chat-tests.js
 */
import "./vscode-stub";
import { vscodeStub } from "./vscode-stub";
import { describe, it, beforeEach } from "node:test";
import * as assert from "node:assert";
import type * as vscode from "vscode";
import {
  SideChatService,
  SideChatCommands,
  SideChatContextKeys,
  registerSideChatCommands,
} from "../sideChatService";
import type {
  SideChat,
  SideChatEvent,
  SideChatServiceDeps,
} from "../sideChatService";

// ---------------------------------------------------------------------------
// Test-local vscode.command surface augmentation.
// The shared vscode-stub has no registerCommand; we add it at runtime here
// (no edit to the stub file). This also exercises the service's default
// `vscode.commands.registerCommand` path in registerSideChatCommands.
// ---------------------------------------------------------------------------
const registered = new Map<string, (...args: unknown[]) => unknown>();
(
  vscodeStub.commands as unknown as {
    registerCommand: (
      id: string,
      handler: (...args: unknown[]) => unknown,
    ) => vscode.Disposable;
  }
).registerCommand = (id, handler) => {
  registered.set(id, handler);
  return { dispose: () => { registered.delete(id); } };
};

type SetContextCall = { command: string; args: unknown[] };

function setContextMap(): Map<string, unknown> {
  const m = new Map<string, unknown>();
  for (const c of vscodeStub.commands.calls as SetContextCall[]) {
    if (c.command === "setContext" && typeof c.args[0] === "string") {
      m.set(c.args[0] as string, c.args[1]);
    }
  }
  return m;
}

function clearCommandCalls(): void {
  (vscodeStub.commands.calls as unknown[]).length = 0;
}

function fakeContext(): vscode.ExtensionContext {
  return {
    subscriptions: [] as vscode.Disposable[],
  } as unknown as vscode.ExtensionContext;
}

interface DepsBundle {
  deps: SideChatServiceDeps;
  parentTurns: Array<{ role: string; text: string }>;
  revealed: SideChat[];
  events: SideChatEvent[];
}

function makeDeps(overrides?: Partial<SideChatServiceDeps>): DepsBundle {
  const parentTurns = Array.from({ length: 25 }, (_, i) => ({
    role: i % 2 === 0 ? "human" : "assistant",
    text: `parent turn ${i}`,
  }));
  const revealed: SideChat[] = [];
  const events: SideChatEvent[] = [];
  const deps: SideChatServiceDeps = {
    // Return copies so the "frozen snapshot" test can mutate the source.
    getParentTranscript: (_id: string) => parentTurns.map((t) => ({ ...t })),
    revealSideChat: (c: SideChat) => {
      revealed.push(c);
    },
    getActiveChatId: () => "tab-1",
    ...overrides,
  };
  return { deps, parentTurns, revealed, events };
}

function makeService(bundle: DepsBundle): SideChatService {
  const svc = new SideChatService(bundle.deps);
  svc.onDidChange((e) => bundle.events.push(e));
  return svc;
}

beforeEach(() => {
  clearCommandCalls();
  registered.clear();
});

describe("SideChatService.createSideChat — hidden parent context + own transcript", () => {
  it("captures the parent thread as hidden context, capped at maxSeedTurns", () => {
    const b = makeDeps();
    const svc = makeService(b);
    clearCommandCalls();
    const chat = svc.createSideChat({ parentChatId: "tab-1" });
    assert.ok(chat);
    assert.equal(chat.parentChatId, "tab-1");
    // 25 parent turns, default cap 20 → last 20 seeded.
    assert.equal(chat.hiddenParentContext.seedTurnCount, 20);
    assert.equal(chat.hiddenParentContext.turns.length, 20);
    assert.equal(chat.hiddenParentContext.turns[0]!.text, "parent turn 5");
    assert.equal(chat.hiddenParentContext.turns[19]!.text, "parent turn 24");
    // Assistant role normalized to "agent" in our model.
    // Seeded turns are parent turns 5..24; turn 5 was "assistant" → "agent",
    // turn 6 was "human" → "human".
    assert.equal(chat.hiddenParentContext.turns[0]!.role, "agent");
    assert.equal(chat.hiddenParentContext.turns[1]!.role, "human");
    assert.equal(chat.hiddenParentContext.boundaryInjected, true);
    // Own transcript starts empty.
    assert.deepEqual(chat.transcript, []);
    assert.equal(chat.title, "Side chat");
    // New side chat becomes active and is revealed via the host.
    assert.equal(svc.getActiveSideChat()?.id, chat.id);
    assert.deepEqual(
      b.revealed.map((c) => c.id),
      [chat.id],
    );
    const kinds = b.events.map((e) => e.kind);
    assert.ok(kinds.includes("sideChatsChanged"));
    assert.ok(kinds.includes("sideChatActivated"));
  });

  it("respects a custom maxSeedTurns", () => {
    const b = makeDeps({ maxSeedTurns: 5 });
    const svc = makeService(b);
    const chat = svc.createSideChat({ parentChatId: "tab-1" });
    assert.ok(chat);
    assert.equal(chat.hiddenParentContext.seedTurnCount, 5);
    assert.equal(chat.hiddenParentContext.turns[0]!.text, "parent turn 20");
  });

  it("seeds the tangent question as the first human turn and auto-titles", () => {
    const b = makeDeps();
    const svc = makeService(b);
    const chat = svc.createSideChat({
      seedQuestion: "Why is the sky blue?",
    });
    assert.ok(chat);
    assert.equal(chat.parentChatId, "tab-1"); // via getActiveChatId
    assert.equal(chat.transcript.length, 1);
    assert.equal(chat.transcript[0]!.role, "human");
    assert.equal(chat.transcript[0]!.text, "Why is the sky blue?");
    assert.equal(chat.title, "Why is the sky blue?");
  });

  it("syncs Cursor's sideChat* state keys (remapped under ide.*)", () => {
    const b = makeDeps();
    const svc = makeService(b);
    clearCommandCalls();
    const chat = svc.createSideChat({
      parentChatId: "tab-1",
      seedQuestion: "tangent?",
    });
    assert.ok(chat);
    const ctx = setContextMap();
    assert.equal(ctx.get(SideChatContextKeys.available), true);
    assert.equal(ctx.get(SideChatContextKeys.creationRejectedReason), undefined);
    assert.equal(ctx.get(SideChatContextKeys.activeId), chat.id);
    const info = ctx.get(SideChatContextKeys.activeInfo) as {
      id: string;
      turnCount: number;
      seedTurnCount: number;
    };
    assert.equal(info.id, chat.id);
    assert.equal(info.turnCount, 1);
    assert.equal(info.seedTurnCount, 20);
    assert.equal(ctx.get(SideChatContextKeys.seedTurnCount), 20);
    assert.equal(ctx.get(SideChatContextKeys.boundaryInjected), true);
  });

  it("survives a throwing getParentTranscript (seeds nothing, still creates)", () => {
    const b = makeDeps({
      getParentTranscript: () => {
        throw new Error("boom");
      },
    });
    const svc = makeService(b);
    const chat = svc.createSideChat({ parentChatId: "tab-1" });
    assert.ok(chat);
    assert.equal(chat.hiddenParentContext.seedTurnCount, 0);
    assert.deepEqual(chat.hiddenParentContext.turns, []);
  });
});

describe("SideChatService.createSideChat — rejection channel", () => {
  it("rejects when no parent chat can be resolved", () => {
    const b = makeDeps({ getActiveChatId: () => undefined });
    const svc = makeService(b);
    clearCommandCalls();
    const chat = svc.createSideChat({});
    assert.equal(chat, undefined);
    assert.equal(svc.creationRejectedReason, "no-active-parent-chat");
    assert.equal(svc.sideChatCount, 0);
    const ctx = setContextMap();
    assert.equal(ctx.get(SideChatContextKeys.available), false);
    assert.equal(
      ctx.get(SideChatContextKeys.creationRejectedReason),
      "no-active-parent-chat",
    );
  });

  it("a later success clears the rejection", () => {
    const b = makeDeps({ getActiveChatId: () => undefined });
    const svc = makeService(b);
    assert.equal(svc.createSideChat({}), undefined);
    const chat = svc.createSideChat({ parentChatId: "tab-1" });
    assert.ok(chat);
    assert.equal(svc.creationRejectedReason, undefined);
    const ctx = setContextMap();
    assert.equal(ctx.get(SideChatContextKeys.available), true);
    assert.equal(ctx.get(SideChatContextKeys.creationRejectedReason), undefined);
  });
});

describe("SideChatService — transcript, open, close", () => {
  it("appendTurn grows only the side transcript and auto-titles once", () => {
    const b = makeDeps();
    const svc = makeService(b);
    const chat = svc.createSideChat({ parentChatId: "tab-1" });
    assert.ok(chat);
    b.events.length = 0;
    assert.equal(
      svc.appendTurn(chat.id, "human", "hello world this is a longer message for title"),
      true,
    );
    assert.equal(chat.transcript.length, 1);
    assert.equal(chat.title, "hello world this is a longer…");
    assert.equal(svc.appendTurn(chat.id, "agent", "answer"), true);
    assert.equal(chat.transcript.length, 2);
    // Second human turn does not re-title.
    assert.equal(svc.appendTurn(chat.id, "human", "another question here"), true);
    assert.equal(chat.title, "hello world this is a longer…");
    assert.ok(
      b.events.some((e) => e.kind === "turnAppended" && e.id === chat.id),
    );
    // Empty text and unknown ids are rejected.
    assert.equal(svc.appendTurn(chat.id, "human", "   "), false);
    assert.equal(svc.appendTurn("nope", "human", "x"), false);
  });

  it("openSideChat activates, reveals, and updates ide.sideChatId", () => {
    const b = makeDeps();
    const svc = makeService(b);
    const a = svc.createSideChat({ parentChatId: "tab-1", title: "A" });
    const c = svc.createSideChat({ parentChatId: "tab-1", title: "B" });
    assert.ok(a && c);
    assert.equal(svc.getActiveSideChat()?.id, c.id);
    b.revealed.length = 0;
    clearCommandCalls();
    assert.equal(svc.openSideChat(a.id), true);
    assert.equal(svc.getActiveSideChat()?.id, a.id);
    assert.deepEqual(
      b.revealed.map((x) => x.id),
      [a.id],
    );
    assert.equal(setContextMap().get(SideChatContextKeys.activeId), a.id);
    // Unknown id → false, active unchanged.
    assert.equal(svc.openSideChat("nope"), false);
    assert.equal(svc.getActiveSideChat()?.id, a.id);
  });

  it("openSideChat() with no args re-opens the active side chat", () => {
    const b = makeDeps();
    const svc = makeService(b);
    const chat = svc.createSideChat({ parentChatId: "tab-1" });
    assert.ok(chat);
    assert.equal(svc.openSideChat(), true);
    assert.equal(svc.getActiveSideChat()?.id, chat.id);
  });

  it("openSideChatForAgent resolves side-chat id, then parent id (latest)", () => {
    const b = makeDeps();
    const svc = makeService(b);
    const first = svc.createSideChat({ parentChatId: "tab-1", title: "first" });
    const second = svc.createSideChat({ parentChatId: "tab-1", title: "second" });
    const other = svc.createSideChat({ parentChatId: "tab-2", title: "other" });
    assert.ok(first && second && other);
    // Direct side-chat id.
    assert.equal(svc.openSideChatForAgent(first.id), true);
    assert.equal(svc.getActiveSideChat()?.id, first.id);
    // Parent id → most recent side chat spawned from it.
    assert.equal(svc.openSideChatForAgent("tab-1"), true);
    assert.equal(svc.getActiveSideChat()?.id, second.id);
    // Unknown / empty → false.
    assert.equal(svc.openSideChatForAgent("nope"), false);
    assert.equal(svc.openSideChatForAgent(""), false);
  });

  it("closeSideChat removes the chat; active falls back; parent untouched", () => {
    const b = makeDeps();
    const svc = makeService(b);
    const a = svc.createSideChat({ parentChatId: "tab-1", title: "A" });
    const c = svc.createSideChat({ parentChatId: "tab-1", title: "B" });
    assert.ok(a && c);
    b.events.length = 0;
    assert.equal(svc.closeSideChat("nope"), false);
    assert.equal(svc.closeSideChat(a.id), true);
    assert.equal(svc.getSideChat(a.id), undefined);
    assert.equal(svc.getActiveSideChat()?.id, c.id);
    assert.ok(
      b.events.some((e) => e.kind === "sideChatClosed" && e.id === a.id),
    );
    // Closing the active chat falls back to the remaining one, then none.
    assert.equal(svc.closeSideChat(c.id), true);
    assert.equal(svc.getActiveSideChat(), undefined);
    assert.equal(svc.openSideChat(), false);
    assert.equal(
      setContextMap().get(SideChatContextKeys.activeId),
      undefined,
    );
  });

  it("listSideChats returns creation-order summaries", () => {
    const b = makeDeps();
    const svc = makeService(b);
    const a = svc.createSideChat({ parentChatId: "tab-1", title: "A" });
    const c = svc.createSideChat({ parentChatId: "tab-2", title: "B" });
    assert.ok(a && c);
    svc.appendTurn(c.id, "human", "q");
    const list = svc.listSideChats();
    assert.equal(list.length, 2);
    assert.equal(list[0]!.id, a.id);
    assert.equal(list[0]!.active, false);
    assert.equal(list[1]!.id, c.id);
    assert.equal(list[1]!.active, true);
    assert.equal(list[1]!.turnCount, 1);
    assert.equal(list[1]!.parentChatId, "tab-2");
    assert.equal(list[1]!.seedTurnCount, 20);
  });
});

describe("SideChatService — durability of the hidden context", () => {
  it("the snapshot is frozen at creation; later parent turns never leak in", () => {
    const b = makeDeps();
    const svc = makeService(b);
    const chat = svc.createSideChat({ parentChatId: "tab-1" });
    assert.ok(chat);
    // Parent keeps talking after the side chat was spawned…
    b.parentTurns.push({ role: "human", text: "parent turn 25 (later)" });
    b.parentTurns.push({ role: "assistant", text: "parent turn 26 (later)" });
    // …but the hidden context still holds exactly the creation-time seed.
    assert.equal(chat.hiddenParentContext.turns.length, 20);
    assert.equal(
      chat.hiddenParentContext.turns[19]!.text,
      "parent turn 24",
    );
    // And the side transcript is fully independent of the parent.
    svc.appendTurn(chat.id, "human", "tangent question");
    assert.equal(chat.transcript.length, 1);
    assert.equal(b.parentTurns.length, 27);
  });
});

describe("registerSideChatCommands", () => {
  it("registers exactly the 5 ide.* ids and pushes disposables to subscriptions", () => {
    const b = makeDeps();
    const svc = makeService(b);
    const context = fakeContext();
    const disposables = registerSideChatCommands({ service: svc, context });
    assert.equal(disposables.length, 5);
    assert.equal(context.subscriptions.length, 5);
    assert.deepEqual(
      [...registered.keys()].sort(),
      Object.values(SideChatCommands).sort(),
    );
    for (const d of disposables) {
      d.dispose();
    }
  });

  it("handlers work end-to-end: create / list / open / openByAgentId / openTab", () => {
    const b = makeDeps();
    const svc = makeService(b);
    registerSideChatCommands({ service: svc, context: fakeContext() });

    const create = registered.get(SideChatCommands.create)!;
    const list = registered.get(SideChatCommands.list)!;
    const open = registered.get(SideChatCommands.open)!;
    const openByAgentId = registered.get(SideChatCommands.openByAgentId)!;
    const openTab = registered.get(SideChatCommands.openTab)!;

    // create with seed question; parent resolved via getActiveChatId.
    const id = create("Why is the sky blue?") as string;
    assert.ok(id.startsWith("sidechat-"));
    assert.equal(svc.getSideChat(id)?.title, "Why is the sky blue?");

    // create with explicit parent id as 2nd arg.
    const id2 = create("second tangent", "tab-9") as string;
    assert.equal(svc.getSideChat(id2)?.parentChatId, "tab-9");

    // list returns both summaries.
    const infos = list() as Array<{ id: string }>;
    assert.equal(infos.length, 2);

    // open by side-chat id.
    assert.equal(open(id), true);
    assert.equal(svc.getActiveSideChat()?.id, id);

    // openByAgentId with a parent id opens its latest side chat.
    assert.equal(openByAgentId("tab-9"), true);
    assert.equal(svc.getActiveSideChat()?.id, id2);
    assert.equal(openByAgentId("unknown-parent"), false);

    // openTab delegates to open.
    assert.equal(openTab(id), true);
    assert.equal(svc.getActiveSideChat()?.id, id);
    assert.equal(openTab("nope"), false);
  });

  it("ide.newSideChat returns undefined when creation is rejected", () => {
    const b = makeDeps({ getActiveChatId: () => undefined });
    const svc = makeService(b);
    registerSideChatCommands({ service: svc, context: fakeContext() });
    const create = registered.get(SideChatCommands.create)!;
    assert.equal(create("question with no parent"), undefined);
    assert.equal(svc.creationRejectedReason, "no-active-parent-chat");
  });

  it("disposing a registration removes the command", () => {
    const b = makeDeps();
    const svc = makeService(b);
    const disposables = registerSideChatCommands({
      service: svc,
      context: fakeContext(),
    });
    assert.ok(registered.has(SideChatCommands.list));
    disposables[4]!.dispose();
    assert.ok(!registered.has(SideChatCommands.list));
  });
});
