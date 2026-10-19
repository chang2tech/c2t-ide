/**
 * Functional tests for Plan mode + mode system (DEV-PLAN-MODE).
 *
 * Covers parity-chat-modes.md (with DIG-DYNAMIC 2026-10-19 runtime
 * corrections: 5 chat modes Agent/Ask/Debug/Multitask/Plan, no Edit mode;
 * palette titles "Open Chat in X Mode") and DIG-AST-EXT's
 * agent.execute_plan.* plan-file persistence semantics.
 *
 * node:test, zero extra deps. The `vscode` module is stubbed via
 * Module._load interception (no node_modules stub needed, nothing ships).
 *
 * Run after `tsc`:  node --test out/services/test/run-plan-mode-tests.js
 */
import { describe, it } from "node:test";
import * as assert from "node:assert";
import Module from "node:module";
import * as os from "node:os";
import * as path from "node:path";
import * as fsp from "node:fs/promises";

// ---- vscode API stub (test-only, never packaged) ----
const calls: { warnings: string[]; infos: string[]; errors: string[] } = {
  warnings: [],
  infos: [],
  errors: [],
};
class StubEventEmitter<T> {
  private listeners: Array<(e: T) => void> = [];
  get event() {
    return (listener: (e: T) => void) => {
      this.listeners.push(listener);
      return { dispose: () => undefined };
    };
  }
  fire(e: T): void {
    for (const l of [...this.listeners]) l(e);
  }
  dispose(): void {
    this.listeners = [];
  }
}
const vscodeStub = {
  EventEmitter: StubEventEmitter,
  window: {
    showWarningMessage: (m: string) => {
      calls.warnings.push(m);
      return Promise.resolve(undefined);
    },
    showInformationMessage: (m: string) => {
      calls.infos.push(m);
      return Promise.resolve(undefined);
    },
    showErrorMessage: (m: string) => {
      calls.errors.push(m);
      return Promise.resolve(undefined);
    },
    createOutputChannel: () => ({
      appendLine: () => undefined,
      dispose: () => undefined,
      show: () => undefined,
      clear: () => undefined,
    }),
  },
  workspace: {
    getConfiguration: () => ({
      get: (_k: string, d: string) => d,
      has: () => false,
      update: async () => undefined,
    }),
    workspaceFolders: undefined,
  },
  Uri: {
    file: (p: string) => ({ fsPath: p, scheme: "file", toString: () => p }),
    joinPath: (base: { fsPath: string }, ...parts: string[]) => ({
      fsPath: [base.fsPath, ...parts].join("/"),
    }),
  },
  commands: {
    executeCommand: async () => undefined,
    registerCommand: () => ({ dispose: () => undefined }),
  },
  calls,
};
const origLoad = (Module as unknown as { _load: Function })._load;
(Module as unknown as { _load: Function })._load = function (
  request: string,
  ...rest: unknown[]
) {
  if (request === "vscode") return vscodeStub;
  return origLoad.call(this, request, ...rest);
};

import {
  MODES,
  DROPDOWN_MODES,
  CYCLE_ORDER,
  READ_ONLY_MODES,
  ModeService,
  cycleMode,
  modeDef,
  wrapPlanPrompt,
  PLAN_MODE_INSTRUCTION,
  isMutatingToolAction,
  isReadOnlyMode,
} from "../modeService";
import { ComposerDataService, PendingPlan } from "../composerDataService";

describe("mode registry (parity-chat-modes.md + DIG-DYNAMIC)", () => {
  it("plan mode has the exact Cursor registry fields", () => {
    const plan = MODES.find((m) => m.id === "plan");
    assert.ok(plan, "plan mode must exist");
    assert.strictEqual(plan.label, "Plan");
    assert.strictEqual(plan.icon, "list-todo");
    assert.strictEqual(plan.color, "yellow");
    assert.strictEqual(plan.placeholder, "Plan changes");
    assert.strictEqual(plan.description, "Generate an implementation plan");
    assert.strictEqual(plan.pickable, true);
    assert.strictEqual(plan.autoRun, false);
    assert.strictEqual(plan.autoFix, false);
    assert.strictEqual(plan.shouldAutoApplyIfNoEditTool, false);
  });

  it('chat wire id stays "chat" but the user-facing label is "Ask"', () => {
    const ask = MODES.find((m) => m.id === "chat");
    assert.ok(ask, "chat wire id must exist");
    assert.strictEqual(ask.label, "Ask");
    assert.notStrictEqual(ask.label, "Chat");
    assert.strictEqual(ask.placeholder, "Ask questions");
    assert.strictEqual(ask.description, "Answer questions without making edits");
  });

  it("dropdown lists exactly plan/debug/multitask/chat (Agent implicit, no Edit)", () => {
    assert.deepStrictEqual(DROPDOWN_MODES, ["plan", "debug", "multitask", "chat"]);
    assert.ok(!DROPDOWN_MODES.includes("agent" as never));
    assert.ok(!DROPDOWN_MODES.includes("edit" as never));
    assert.ok(!DROPDOWN_MODES.includes("background" as never));
  });

  it("Shift+Tab cycle order is Agent → Plan → Debug → Multitask → Ask → Agent", () => {
    assert.deepStrictEqual(CYCLE_ORDER, ["agent", "plan", "debug", "multitask", "chat"]);
    assert.strictEqual(cycleMode("agent"), "plan");
    assert.strictEqual(cycleMode("plan"), "debug");
    assert.strictEqual(cycleMode("debug"), "multitask");
    assert.strictEqual(cycleMode("multitask"), "chat");
    assert.strictEqual(cycleMode("chat"), "agent");
  });

  it("behavioral flags match the binary composerMode.* definitions", () => {
    assert.deepStrictEqual(
      [modeDef("agent").autoRun, modeDef("agent").autoFix, modeDef("agent").shouldAutoApplyIfNoEditTool],
      [true, true, true],
    );
    assert.deepStrictEqual(
      [modeDef("debug").autoRun, modeDef("debug").autoFix, modeDef("debug").shouldAutoApplyIfNoEditTool],
      [false, false, true],
    );
    assert.deepStrictEqual(
      [
        modeDef("multitask").autoRun,
        modeDef("multitask").autoFix,
        modeDef("multitask").shouldAutoApplyIfNoEditTool,
      ],
      [true, false, true],
    );
  });

  it("plan and ask are read-only modes (mutations blocked at the choke point)", () => {
    assert.ok(READ_ONLY_MODES.has("chat"), "ask blocks mutations");
    assert.ok(READ_ONLY_MODES.has("plan"), "plan blocks mutations");
    assert.ok(!READ_ONLY_MODES.has("agent"));
  });
});

describe("ModeService", () => {
  it("invalid mode id defaults to agent (never throws)", () => {
    const svc = new ModeService();
    svc.setMode("plan");
    assert.strictEqual(svc.getMode(), "plan");
    svc.setMode("nope-not-a-mode");
    assert.strictEqual(svc.getMode(), "agent");
    svc.setMode("");
    assert.strictEqual(svc.getMode(), "agent");
  });

  it("reset() returns to agent and fires modeChanged", () => {
    const svc = new ModeService();
    const seen: string[] = [];
    svc.onDidChangeMode((m) => seen.push(m));
    svc.setMode("debug");
    svc.reset();
    assert.strictEqual(svc.getMode(), "agent");
    assert.deepStrictEqual(seen, ["debug", "agent"]);
  });

  it("labelFor returns the user-facing label (Ask, not Chat)", () => {
    const svc = new ModeService();
    assert.strictEqual(svc.labelFor("chat"), "Ask");
    assert.strictEqual(svc.labelFor("plan"), "Plan");
  });
});

describe("wrapPlanPrompt", () => {
  it("prepends the plan-mode instruction and keeps the user prompt", () => {
    const out = wrapPlanPrompt("add dark mode");
    assert.ok(out.includes(PLAN_MODE_INSTRUCTION));
    assert.ok(out.includes("add dark mode"));
    assert.ok(out.includes("Do NOT make any edits"));
  });
});

// P1 (QA-PLANMODE-01): the read-only gate must classify MCP namespaced
// actions (mcp__<server>__<tool>) by their tool segment — bare-name matching
// alone let mcp__fs__write bypass plan/ask mode.
describe("isMutatingToolAction (read-only gate, incl. MCP namespaced)", () => {
  it("blocks bare mutating actions", () => {
    for (const a of ["edit", "write", "patch", "delete", "bash", "shell", "task"]) {
      assert.ok(isMutatingToolAction(a), `${a} must be mutating`);
    }
  });
  it("allows bare read-only actions", () => {
    for (const a of ["read", "glob", "grep", "ls"]) {
      assert.ok(!isMutatingToolAction(a), `${a} must not be mutating`);
    }
  });
  it("blocks mutating MCP tools via the namespaced form", () => {
    assert.ok(isMutatingToolAction("mcp__fs__write"), "mcp__fs__write must be mutating");
    assert.ok(isMutatingToolAction("mcp__shell__bash"), "mcp__shell__bash must be mutating");
    assert.ok(isMutatingToolAction("mcp__x__delete"), "mcp__x__delete must be mutating");
    // case-insensitive, like the bare set
    assert.ok(isMutatingToolAction("MCP__FS__WRITE"));
  });
  it("allows read-only MCP tools", () => {
    assert.ok(!isMutatingToolAction("mcp__fs__read"));
    assert.ok(!isMutatingToolAction("mcp__browser__screenshot"));
  });
  it("ignores malformed mcp__ prefixes instead of crashing", () => {
    assert.ok(!isMutatingToolAction("mcp__"));
    assert.ok(!isMutatingToolAction("mcp____write"));
    assert.ok(!isMutatingToolAction("mcp__write"));
  });
  it("plan and ask are read-only modes", () => {
    assert.ok(isReadOnlyMode("plan"));
    assert.ok(isReadOnlyMode("chat"));
    assert.ok(!isReadOnlyMode("agent"));
  });
});

describe("ComposerDataService plan flow", () => {
  function freshService(): ComposerDataService {
    calls.warnings.length = 0;
    calls.infos.length = 0;
    calls.errors.length = 0;
    return new ComposerDataService(undefined);
  }

  function seedPendingPlan(svc: ComposerDataService, plan: PendingPlan): void {
    (svc as unknown as { pendingPlan: PendingPlan | null }).pendingPlan = plan;
  }

  it("newChat resets a non-default mode back to agent", async () => {
    const svc = freshService();
    const events: string[] = [];
    svc.onDidChange((e) => events.push(e.kind));
    svc.modes.setMode("plan");
    assert.strictEqual(svc.modes.getMode(), "plan");
    const ok = await svc.newChat();
    assert.strictEqual(ok, true);
    assert.strictEqual(svc.modes.getMode(), "agent");
    assert.ok(events.includes("modeChanged"), "webview must be told about the reset");
  });

  it("acceptPlan with no pending plan shows a notice and submits nothing", async () => {
    const svc = freshService();
    const submitted: string[] = [];
    (svc as unknown as { submit: (t: string) => void }).submit = (t: string) => {
      submitted.push(t);
    };
    await svc.acceptPlan();
    assert.strictEqual(submitted.length, 0);
    assert.ok(calls.infos.some((m) => m.includes("no pending plan")));
  });

  it("acceptPlan resolves the plan file, switches to agent, submits the build", async () => {
    const svc = freshService();
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "planmode-"));
    const planFile = path.join(dir, "plan.md");
    await fsp.writeFile(planFile, "# Plan\n\n- step 1\n", "utf-8");
    seedPendingPlan(svc, {
      bubbleId: "b1",
      text: "- step 1",
      savedPath: planFile,
      createdAt: Date.now(),
    });
    const submitted: string[] = [];
    (svc as unknown as { submit: (t: string) => void }).submit = (t: string) => {
      submitted.push(t);
    };
    svc.modes.setMode("plan");
    await svc.acceptPlan();
    assert.strictEqual(svc.modes.getMode(), "agent", "build phase runs in agent mode");
    assert.strictEqual(svc.getPendingPlan(), null, "pending plan cleared");
    assert.strictEqual(submitted.length, 1);
    assert.ok(submitted[0].includes("Implement the following approved plan"));
    assert.ok(submitted[0].includes("- step 1"));
    await fsp.rm(dir, { recursive: true, force: true });
  });

  it("acceptPlan recreates the plan file when it is missing (execute_plan semantics)", async () => {
    const svc = freshService();
    // Snapshot the plans dir BEFORE so cleanup only removes files WE created.
    const home = os.homedir();
    const plansDir = path.join(home, ".ide-code", "plans");
    const before = new Set(await fsp.readdir(plansDir).catch(() => [] as string[]));
    seedPendingPlan(svc, {
      bubbleId: "b1",
      text: "- recreated step",
      savedPath: path.join(os.tmpdir(), "planmode-definitely-missing", "plan.md"),
      createdAt: Date.now(),
    });
    const submitted: string[] = [];
    (svc as unknown as { submit: (t: string) => void }).submit = (t: string) => {
      submitted.push(t);
    };
    await svc.acceptPlan();
    assert.strictEqual(submitted.length, 1, "recreated plan still builds");
    const plan = (svc as unknown as { pendingPlan: PendingPlan | null }).pendingPlan;
    assert.strictEqual(plan, null);
    // The recreated file lives under ~/.ide-code/plans/ — clean up ONLY the
    // files this test created (P2 QA-PLANMODE-01: never rm every plan-* in
    // the user's real plans dir).
    const files = await fsp.readdir(plansDir).catch(() => [] as string[]);
    const ours = files.filter((f) => f.startsWith("plan-") && !before.has(f));
    assert.ok(ours.length > 0, "a plan file must have been recreated");
    for (const f of ours) {
      await fsp.rm(path.join(plansDir, f), { force: true });
    }
  });

  it("discardPlan clears the pending plan without submitting", () => {
    const svc = freshService();
    seedPendingPlan(svc, {
      bubbleId: "b1",
      text: "- step",
      savedPath: "",
      createdAt: Date.now(),
    });
    const submitted: string[] = [];
    (svc as unknown as { submit: (t: string) => void }).submit = (t: string) => {
      submitted.push(t);
    };
    svc.discardPlan();
    assert.strictEqual(svc.getPendingPlan(), null);
    assert.strictEqual(submitted.length, 0);
  });
});
