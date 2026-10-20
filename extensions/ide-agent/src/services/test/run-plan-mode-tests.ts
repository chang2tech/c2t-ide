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
import { after, describe, it } from "node:test";
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
  commands: (() => {
    // DEV-GAPS-9A: minimal command registry so wiring tests can register a
    // handler and execute it, mirroring vscode.commands semantics. Unknown
    // commands resolve undefined (the previous no-op behavior).
    const registry = new Map<string, (...args: unknown[]) => unknown>();
    return {
      executeCommand: async (id: string, ...args: unknown[]) => {
        const handler = registry.get(id);
        return handler ? handler(...args) : undefined;
      },
      registerCommand: (id: string, handler: (...args: unknown[]) => unknown) => {
        registry.set(id, handler);
        return {
          dispose: () => {
            registry.delete(id);
          },
        };
      },
    };
  })(),
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

/**
 * DEV-GAPS-36: every ComposerDataService created below is tracked so the
 * file-level after() can dispose it. An undisposed composer leaks its
 * CheckpointStorageCompareService scheduler (15 s ref'd activation timer →
 * 10 min ref'd interval chain, per GAPS-25's root cause in
 * checkpointStorageCompare.ts) and its `bun serve` sidecar
 * (IdeCodeEngineAdapter — engineMode defaults to "sidecar", and answering
 * a question while idle starts a real turn via `void runTurn()`): the
 * sidecar's piped stdio keeps the event loop alive, so node:test hangs at
 * file level after all suites pass ("Promise resolution is still pending
 * but the event loop has already resolved"). dispose() is idempotent,
 * stops the checkpoint scheduler (via the GAPS-25
 * this.checkpoints.dispose() cascade) and kills the sidecar (SIGTERM,
 * escalated to SIGKILL).
 */
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
  sessionPermissionsForMode,
} from "../modeService";
import { ComposerDataService, PendingPlan } from "../composerDataService";
import { PLAN_FILE_TELEMETRY, resolvePlanFilePath, PlanFileResolveDeps } from "../planFileService";
import { setSandboxDebugLogging, isSandboxDebugLogging } from "../../sandbox/sandboxService";

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
  // Round B fail-closed (QA-PLANMODE): malformed mcp__ names are DENIED,
  // not ignored. The engine never generates them
  // (McpNames.parseToolName/sanitize), so denying is safe; deny-by-default
  // beats a name-matching arms race. The point of this test is we never
  // crash on bad input.
  it("denies (fail-closed) malformed mcp__ prefixes instead of crashing", () => {
    assert.ok(isMutatingToolAction("mcp__"));
    assert.ok(isMutatingToolAction("mcp____write"));
    assert.ok(isMutatingToolAction("mcp__write"));
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
    return track(new ComposerDataService(undefined));
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

// GAPS-181 (CAT-B port, acceptPlan consumer C2): the core
// `composer.acceptPlan` command path resolves the plan in core and forwards
// the accepted plan here (`ide.acceptPlanFromCore` -> acceptPlanFromCore).
describe("ComposerDataService acceptPlanFromCore (GAPS-181)", () => {
  function freshService(): ComposerDataService {
    calls.warnings.length = 0;
    calls.infos.length = 0;
    calls.errors.length = 0;
    return track(new ComposerDataService(undefined));
  }

  function stubSubmit(svc: ComposerDataService): string[] {
    const submitted: string[] = [];
    (svc as unknown as { submit: (t: string) => void }).submit = (t: string) => {
      submitted.push(t);
    };
    return submitted;
  }

  it("builds from the core-forwarded text, strips the plan-file header, clears the pending plan", async () => {
    const svc = freshService();
    (svc as unknown as { pendingPlan: PendingPlan | null }).pendingPlan = {
      bubbleId: "b1",
      text: "- core step",
      savedPath: "/tmp/plan.md",
      createdAt: Date.now(),
    };
    const submitted = stubSubmit(svc);
    svc.modes.setMode("plan");
    await svc.acceptPlanFromCore("# Plan — 2026-10-20T00:00:00.000Z\n\n- core step");
    assert.strictEqual(svc.modes.getMode(), "agent", "build phase runs in agent mode");
    assert.strictEqual(svc.getPendingPlan(), null, "pending plan cleared");
    assert.strictEqual(submitted.length, 1);
    assert.ok(submitted[0].includes("Implement the following approved plan"));
    assert.ok(submitted[0].includes("- core step"));
    assert.ok(!submitted[0].includes("# Plan —"), "savePlanFile header must be stripped");
  });

  it("builds even when there is no local pending plan (core already consumed the record)", async () => {
    const svc = freshService();
    const submitted = stubSubmit(svc);
    await svc.acceptPlanFromCore("- orphan step");
    assert.strictEqual(submitted.length, 1);
    assert.ok(submitted[0].includes("- orphan step"));
  });

  it("empty or blank forwarded text submits nothing", async () => {
    const svc = freshService();
    const submitted = stubSubmit(svc);
    await svc.acceptPlanFromCore("");
    await svc.acceptPlanFromCore("   \n  ");
    await svc.acceptPlanFromCore("# Plan — 2026-10-20T00:00:00.000Z\n\n");
    assert.strictEqual(submitted.length, 0);
  });

  it("retains the forwarded plan execution data (GAPS-186) when the build starts", async () => {
    const svc = freshService();
    const submitted = stubSubmit(svc);
    assert.strictEqual(svc.getLastAcceptedPlanExecution(), null, "nothing retained before any core accept");
    await svc.acceptPlanFromCore("# Plan — 2026-10-20T00:00:00.000Z\n\n- [ ] core step", {
      planName: "Core Plan",
      planTitle: "Core Plan Title",
      planTodos: [
        { id: "t1", content: "core step", status: "pending" },
        { id: "t2", content: "done step", status: "completed", dependencies: ["t1"] },
      ],
    });
    assert.strictEqual(submitted.length, 1, "build still submits exactly once");
    const execution = svc.getLastAcceptedPlanExecution();
    assert.ok(execution, "execution data retained");
    assert.strictEqual(execution.planName, "Core Plan");
    assert.strictEqual(execution.planTitle, "Core Plan Title");
    assert.deepStrictEqual(execution.planTodos, [
      { id: "t1", content: "core step", status: "pending" },
      { id: "t2", content: "done step", status: "completed", dependencies: ["t1"] },
    ]);
    assert.strictEqual(typeof execution.acceptedAt, "number");
  });

  it("normalizes malformed execution data without breaking the build (GAPS-186)", async () => {
    const svc = freshService();
    const submitted = stubSubmit(svc);
    await svc.acceptPlanFromCore("- step", {
      planName: 42,
      planTitle: null,
      planTodos: [{ content: 42 }, { content: "ok step" }, "junk", null],
    });
    assert.strictEqual(submitted.length, 1);
    const execution = svc.getLastAcceptedPlanExecution();
    assert.ok(execution);
    assert.strictEqual(execution.planName, "");
    assert.strictEqual(execution.planTitle, "");
    assert.deepStrictEqual(execution.planTodos, [{ id: "todo-1", content: "ok step", status: "pending" }]);
    // Absent execution arg (older core build) leaves the record null, no crash.
    const svc2 = freshService();
    stubSubmit(svc2);
    await svc2.acceptPlanFromCore("- step");
    assert.strictEqual(svc2.getLastAcceptedPlanExecution(), null);
  });

  it("a dropped core accept (empty text) records no execution data (GAPS-186)", async () => {
    const svc = freshService();
    stubSubmit(svc);
    await svc.acceptPlanFromCore("", { planName: "X", planTitle: "X", planTodos: [{ id: "t", content: "c", status: "pending" }] });
    await svc.acceptPlanFromCore("   \n  ", { planName: "X", planTitle: "X", planTodos: [] });
    assert.strictEqual(svc.getLastAcceptedPlanExecution(), null);
  });
});

// P1 (QA-PLANMODE Round B, P1-2(b)): session-level deny ruleset for
// read-only modes, passed as `permissions` at session.create by
// IdeCodeEngineAdapter.ensureSession.
describe("sessionPermissionsForMode (session.create permissions ruleset)", () => {
  it("returns undefined for agent and other non-read-only, non-debug modes", () => {
    for (const mode of ["agent", "multitask", "background", "edit"] as const) {
      assert.strictEqual(sessionPermissionsForMode(mode), undefined, `${mode} must send no ruleset`);
    }
  });

  it("returns the debug ask-ruleset for debug (DEV-DEBUG-MULTITASK)", () => {
    const rules = sessionPermissionsForMode("debug");
    assert.ok(Array.isArray(rules) && rules.length > 0, "debug must get a ruleset");
    // autoRun=false: shell/MCP ask for approval; no tool denylist (Cursor parity).
    assert.strictEqual(rules.find((r) => r.action === "shell")?.effect, "ask");
    assert.strictEqual(rules.find((r) => r.action === "mcp__*")?.effect, "ask");
    assert.strictEqual(
      rules.find((r) => r.action === "edit" && r.effect === "deny"),
      undefined,
      "debug must not hard-deny edit (instrumentation + targeted fix need it)",
    );
  });

  it("returns a deny ruleset for plan and chat (ask) modes", () => {
    for (const mode of ["plan", "chat"] as const) {
      const rules = sessionPermissionsForMode(mode);
      assert.ok(Array.isArray(rules) && rules.length > 0, `${mode} must get a ruleset`);
    }
  });

  it("denies the engine's real mutating permission actions", () => {
    const rules = sessionPermissionsForMode("plan")!;
    const deny = new Map(rules.filter((r) => r.effect === "deny").map((r) => [r.action, r.resource]));
    // Grounded in packages/core/src/tool/plugin/*.ts permission.assert calls:
    // write/edit/delete/patch/opencode/plan assert action "edit"; shell
    // asserts "shell"; subagent "subagent"; skill "skill".
    for (const action of ["edit", "shell", "subagent", "skill", "mcp__*"]) {
      assert.ok(deny.has(action), `must deny ${action}`);
      assert.strictEqual(deny.get(action), "*");
    }
  });

  it("keeps read-only tools out of the deny list", () => {
    const rules = sessionPermissionsForMode("plan")!;
    const deniedActions = new Set(rules.filter((r) => r.effect === "deny").map((r) => r.action));
    for (const action of ["read", "glob", "grep", "ls", "webfetch", "websearch", "question", "todo"]) {
      assert.ok(!deniedActions.has(action), `${action} must stay usable in plan mode`);
    }
  });

  it("re-allows the read-only MCP allowlist AFTER the mcp__* deny (engine findLast wins)", () => {
    const rules = sessionPermissionsForMode("plan")!;
    const denyIdx = rules.findIndex((r) => r.action === "mcp__*" && r.effect === "deny");
    assert.ok(denyIdx >= 0, "mcp__* deny must exist");
    const allows = rules.filter((r) => r.effect === "allow");
    assert.ok(allows.length > 0, "allowlist rules must exist");
    for (const r of allows) {
      const idx = rules.indexOf(r);
      assert.ok(idx > denyIdx, `${r.action} allow must come after the mcp__* deny`);
      assert.ok(r.action.startsWith("mcp__"), "allow rules must be mcp-scoped");
    }
    // Spot-check the observation tools the verdict's probes used.
    const allowActions = new Set(allows.map((r) => r.action));
    assert.ok(allowActions.has("mcp__*__read_file"), "mcp read_file must be re-allowed");
    assert.ok(allowActions.has("mcp__*__list_directory"), "mcp list_directory must be re-allowed");
    assert.ok([...allowActions].some((a) => a.includes("get_")), "get_ prefix allow must exist");
  });

  it("every rule has the engine Permission.Rule wire shape", () => {
    for (const mode of ["plan", "chat"] as const) {
      for (const r of sessionPermissionsForMode(mode)!) {
        assert.strictEqual(typeof r.action, "string");
        assert.strictEqual(typeof r.resource, "string");
        assert.ok(r.effect === "allow" || r.effect === "deny", `bad effect ${r.effect}`);
      }
    }
  });
});

// DEV-GAPS-9A: command-wiring tests.
//
// The core `composer.acceptPlan` Action2
// (src/vs/workbench/contrib/composer/browser/composerActions.ts) is a one-line
// delegation — `ICommandService.executeCommand('ide.acceptPlan')` — which this
// extension-host node:test cannot instantiate (a core Action2 needs the full
// workbench module graph). These tests cover the extension side of the same
// wire: the handler registered under that exact command id must run without
// throwing, mirroring the registration in src/extension.ts.
describe("composer.* command wiring (DEV-GAPS-9A)", () => {
  it("ide.acceptPlan (target of core composer.acceptPlan) runs without throwing", async () => {
    const svc = track(new ComposerDataService(undefined));
    // Mirrors extension.ts: case "ide.acceptPlan":
    //   vscode.commands.registerCommand(cmd.id, () => void tabs.activeComposer.acceptPlan())
    // (no pending plan -> acceptPlan shows a notice and submits nothing, never throws).
    const disposable = vscodeStub.commands.registerCommand("ide.acceptPlan", () =>
      svc.acceptPlan(),
    );
    try {
      await assert.doesNotReject(vscodeStub.commands.executeCommand("ide.acceptPlan"));
    } finally {
      disposable.dispose();
    }
  });

  it("ide.acceptPlanFromCore routes the build to the tab that owns the plan (GAPS-181)", async () => {
    // Mirrors extension.ts: case "ide.acceptPlanFromCore" — the handler
    // resolves the tab by id from tabs.listTabs() and calls that tab's
    // composer.acceptPlanFromCore(planText); unknown tabs drop silently.
    const owner = track(new ComposerDataService(undefined));
    const other = track(new ComposerDataService(undefined));
    const submittedOwner: string[] = [];
    const submittedOther: string[] = [];
    (owner as unknown as { submit: (t: string) => void }).submit = (t: string) => {
      submittedOwner.push(t);
    };
    (other as unknown as { submit: (t: string) => void }).submit = (t: string) => {
      submittedOther.push(t);
    };
    const fakeTabs = [
      { id: "tab-owner", composer: owner },
      { id: "tab-other", composer: other },
    ];
    const disposable = vscodeStub.commands.registerCommand(
      "ide.acceptPlanFromCore",
      (tabId?: unknown, planText?: unknown) => {
        if (typeof tabId !== "string" || typeof planText !== "string") {
          return;
        }
        const tab = fakeTabs.find((t) => t.id === tabId);
        if (tab) {
          void tab.composer.acceptPlanFromCore(planText);
        }
      },
    );
    try {
      await vscodeStub.commands.executeCommand("ide.acceptPlanFromCore", "tab-owner", "- routed step");
      assert.strictEqual(submittedOwner.length, 1, "owning tab builds");
      assert.strictEqual(submittedOther.length, 0, "other tabs do not build");
      await assert.doesNotReject(
        vscodeStub.commands.executeCommand("ide.acceptPlanFromCore", "tab-gone", "- lost step"),
      );
      assert.strictEqual(submittedOwner.length, 1, "unknown tab drops silently");
    } finally {
      disposable.dispose();
    }
  });

  it("ide.acceptPlanFromCore forwards the GAPS-186 execution data to the owning tab", async () => {
    // Mirrors extension.ts: case "ide.acceptPlanFromCore" (GAPS-186) — the
    // handler passes the 4th arg (core extraction) through to
    // composer.acceptPlanFromCore(planText, execution); unknown tabs drop
    // silently, data included.
    const owner = track(new ComposerDataService(undefined));
    const submittedOwner: string[] = [];
    (owner as unknown as { submit: (t: string) => void }).submit = (t: string) => {
      submittedOwner.push(t);
    };
    const fakeTabs = [{ id: "tab-owner", composer: owner }];
    const disposable = vscodeStub.commands.registerCommand(
      "ide.acceptPlanFromCore",
      (tabId?: unknown, planText?: unknown, _planUri?: unknown, execution?: unknown) => {
        if (typeof tabId !== "string" || typeof planText !== "string") {
          return;
        }
        const tab = fakeTabs.find((t) => t.id === tabId);
        if (tab) {
          void tab.composer.acceptPlanFromCore(planText, execution);
        }
      },
    );
    try {
      await vscodeStub.commands.executeCommand("ide.acceptPlanFromCore", "tab-owner", "- routed step", "file:///tmp/plan.md", {
        planName: "Routed Plan",
        planTitle: "Routed Plan",
        planTodos: [{ id: "t1", content: "routed step", status: "pending" }],
      });
      assert.strictEqual(submittedOwner.length, 1, "owning tab builds");
      const execution = owner.getLastAcceptedPlanExecution();
      assert.ok(execution, "execution data reached the owning tab");
      assert.strictEqual(execution.planTitle, "Routed Plan");
      assert.strictEqual(execution.planTodos.length, 1);
      await assert.doesNotReject(
        vscodeStub.commands.executeCommand("ide.acceptPlanFromCore", "tab-gone", "- lost step", "file:///tmp/plan.md", { planName: "X", planTitle: "X", planTodos: [] }),
      );
      assert.strictEqual(submittedOwner.length, 1, "unknown tab drops silently, data included");
    } finally {
      disposable.dispose();
    }
  });

  it("ide.toggleSandboxDebugLogging (bridge for core composer.toggleSandboxDebugLogging) flips the flag", async () => {
    // Mirrors extension.ts: case "ide.toggleSandboxDebugLogging":
    //   vscode.commands.registerCommand(cmd.id, (enabled?: boolean) => {
    //     const next = typeof enabled === "boolean" ? enabled : !isSandboxDebugLogging();
    //     setSandboxDebugLogging(next);
    //   })
    const disposable = vscodeStub.commands.registerCommand(
      "ide.toggleSandboxDebugLogging",
      (...args: unknown[]) => {
        const enabled = args[0] as boolean | undefined;
        const next = typeof enabled === "boolean" ? enabled : !isSandboxDebugLogging();
        setSandboxDebugLogging(next);
      },
    );
    try {
      setSandboxDebugLogging(false);
      await assert.doesNotReject(
        vscodeStub.commands.executeCommand("ide.toggleSandboxDebugLogging", true),
      );
      assert.strictEqual(isSandboxDebugLogging(), true, "explicit true enables the flag");
      await assert.doesNotReject(vscodeStub.commands.executeCommand("ide.toggleSandboxDebugLogging"));
      assert.strictEqual(isSandboxDebugLogging(), false, "no-arg call toggles the flag off");
    } finally {
      disposable.dispose();
      setSandboxDebugLogging(false);
    }
  });
});

// DEV-GAPS-16 (ext-plan-files): plan-file runtime resolve + failure telemetry.
describe("planFileService.resolvePlanFilePath (resolve order + telemetry)", () => {
  interface MockFs {
    files: Map<string, string>;
    recreateCalls: string[];
    recreateResult: string | null; // null = throw
    events: Array<{ event: string; source: string; reason?: string }>;
  }
  function mockDeps(m: MockFs, roots: string[] = []): PlanFileResolveDeps {
    return {
      fileUsable: async (p: string) => (m.files.get(p) ?? "").trim().length > 0,
      homedir: () => "/home/mock",
      workspaceRoots: () => roots,
      recreate: async (text: string) => {
        m.recreateCalls.push(text);
        if (m.recreateResult === null) throw new Error("disk full");
        if (m.recreateResult === "") return "";
        const p = `/home/mock/.ide-code/plans/recreated.md`;
        m.files.set(p, `# Plan\n\n${text}\n`);
        return p;
      },
      emit: (event: string, source: string, reason?: string) => {
        m.events.push({ event, source, reason });
      },
    };
  }
  function fresh(): MockFs {
    return { files: new Map(), recreateCalls: [], recreateResult: "recreated", events: [] };
  }

  it("uses the explicit path when it is usable (no fallback, no recreate)", async () => {
    const m = fresh();
    m.files.set("/a/plan.md", "# Plan\n\n- step\n");
    const out = await resolvePlanFilePath(
      { savedPath: "/a/plan.md", text: "- step" },
      mockDeps(m),
    );
    assert.strictEqual(out.path, "/a/plan.md");
    assert.strictEqual(out.source, "explicit");
    assert.strictEqual(m.recreateCalls.length, 0);
    assert.ok(
      m.events.some((e) => e.event === PLAN_FILE_TELEMETRY.fileResolved && e.source === "explicit"),
    );
  });

  it("falls back to workspace .ide-code/plans/<basename> when the explicit path is wrong", async () => {
    const m = fresh();
    const ws = "/ws/.ide-code/plans/plan.md";
    m.files.set(ws, "# Plan\n\n- ws step\n");
    const out = await resolvePlanFilePath(
      { savedPath: "/wrong/place/plan.md", text: "- step" },
      mockDeps(m, ["/ws"]),
    );
    assert.strictEqual(out.path, ws);
    assert.strictEqual(out.source, "workspace");
    assert.strictEqual(m.recreateCalls.length, 0);
    assert.ok(m.events.some((e) => e.event === PLAN_FILE_TELEMETRY.fileResolved && e.source === "workspace"));
  });

  it("falls back to global ~/.ide-code/plans/<basename> when workspace has no match", async () => {
    const m = fresh();
    const g = "/home/mock/.ide-code/plans/plan.md";
    m.files.set(g, "# Plan\n\n- global step\n");
    const out = await resolvePlanFilePath(
      { savedPath: "/wrong/place/plan.md", text: "- step" },
      mockDeps(m, ["/ws-empty"]),
    );
    assert.strictEqual(out.path, g);
    assert.strictEqual(out.source, "global");
  });

  it("treats a corrupt (empty) explicit file as missing and recreates from memory", async () => {
    const m = fresh();
    m.files.set("/a/plan.md", "   \n");
    const out = await resolvePlanFilePath(
      { savedPath: "/a/plan.md", text: "- memory step" },
      mockDeps(m),
    );
    assert.strictEqual(out.path, "/home/mock/.ide-code/plans/recreated.md");
    assert.strictEqual(out.source, "recreated");
    assert.deepStrictEqual(m.recreateCalls, ["- memory step"]);
    assert.ok(m.events.some((e) => e.event === PLAN_FILE_TELEMETRY.fileRecreated));
  });

  it("treats a missing file as missing and recreates from memory", async () => {
    const m = fresh();
    const out = await resolvePlanFilePath(
      { savedPath: "/gone/plan.md", text: "- memory step" },
      mockDeps(m),
    );
    assert.strictEqual(out.source, "recreated");
    assert.ok(out.path !== null);
  });

  it("emits fileResolveFailed with a reason and returns null when recreate also fails", async () => {
    const m = fresh();
    m.recreateResult = "";
    const out = await resolvePlanFilePath(
      { savedPath: "/gone/plan.md", text: "- memory step" },
      mockDeps(m),
    );
    assert.strictEqual(out.path, null);
    assert.strictEqual(out.source, "failed");
    assert.ok(out.reason, "failure must carry a reason");
    assert.ok(m.events.some((e) => e.event === PLAN_FILE_TELEMETRY.fileResolveFailed && !!e.reason));
  });

  it("never throws when recreate throws", async () => {
    const m = fresh();
    m.recreateResult = null;
    const out = await resolvePlanFilePath(
      { savedPath: "/gone/plan.md", text: "- memory step" },
      mockDeps(m),
    );
    assert.strictEqual(out.path, null);
    assert.strictEqual(out.source, "failed");
  });
});

describe("ComposerDataService plan-file resolve telemetry (integration)", () => {
  function freshService(): ComposerDataService {
    calls.warnings.length = 0;
    calls.infos.length = 0;
    calls.errors.length = 0;
    return track(new ComposerDataService(undefined));
  }
  function seedPendingPlan(svc: ComposerDataService, plan: PendingPlan): void {
    (svc as unknown as { pendingPlan: PendingPlan | null }).pendingPlan = plan;
  }

  it("acceptPlan with a corrupt (empty) plan file recreates from memory and fires telemetry", async () => {
    const svc = freshService();
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "planmode-"));
    const corruptFile = path.join(dir, "plan.md");
    await fsp.writeFile(corruptFile, "   \n", "utf-8"); // corrupt: reads back empty
    const home = os.homedir();
    const plansDir = path.join(home, ".ide-code", "plans");
    const before = new Set(await fsp.readdir(plansDir).catch(() => [] as string[]));
    seedPendingPlan(svc, {
      bubbleId: "b1",
      text: "- corrupt recovery step",
      savedPath: corruptFile,
      createdAt: Date.now(),
    });
    const submitted: string[] = [];
    (svc as unknown as { submit: (t: string) => void }).submit = (t: string) => {
      submitted.push(t);
    };
    await svc.acceptPlan();
    assert.strictEqual(submitted.length, 1, "corrupt file must not block the build");
    assert.ok(submitted[0].includes("- corrupt recovery step"));
    const telemetry = svc.getPlanFileTelemetry();
    assert.ok(
      telemetry.some((e) => e.event === "ide.plan.fileRecreated" && e.source === "recreated"),
      "recreate telemetry must fire on corrupt file",
    );
    // Cleanup: the recreated file lives under ~/.ide-code/plans/.
    const files = await fsp.readdir(plansDir).catch(() => [] as string[]);
    for (const f of files.filter((f) => f.startsWith("plan-") && !before.has(f))) {
      await fsp.rm(path.join(plansDir, f), { force: true });
    }
    await fsp.rm(dir, { recursive: true, force: true });
  });
});

describe("plan-producer core bridge (W71B, DEV-GAPS-71)", () => {
  // The live plan producer (extension ComposerDataService) must forward
  // produced/cleared plans into the core IComposerPlanService registry via
  // the ide.recordComposerPlan / ide.clearComposerPlan wire commands.
  // Previously recordPlan was dead code: the core IComposerDataService is
  // deliberately never instantiated and setComposerId was never called.
  function freshService(): ComposerDataService {
    return track(new ComposerDataService(undefined));
  }
  function seedAssistantBubble(svc: ComposerDataService, bubbleId: string, text: string): void {
    svc.bubbles.setBubbleData({
      bubbleId,
      role: "assistant",
      mode: "plan",
      text,
      toolCalls: [],
      createdAt: Date.now(),
    });
  }
  async function capturePlan(svc: ComposerDataService, bubbleId: string): Promise<void> {
    await (
      svc as unknown as { capturePendingPlan: (id: string) => Promise<void> }
    ).capturePendingPlan(bubbleId);
    // The bridge call is fire-and-forget; flush the microtask queue.
    await new Promise((r) => setImmediate(r));
  }
  function clearPlan(svc: ComposerDataService): void {
    (svc as unknown as { clearPendingPlan: () => void }).clearPendingPlan();
  }
  async function planFilesBefore(): Promise<Set<string>> {
    const plansDir = path.join(os.homedir(), ".ide-code", "plans");
    return new Set(await fsp.readdir(plansDir).catch(() => [] as string[]));
  }
  async function cleanupNewPlanFiles(before: Set<string>): Promise<void> {
    const plansDir = path.join(os.homedir(), ".ide-code", "plans");
    const files = await fsp.readdir(plansDir).catch(() => [] as string[]);
    for (const f of files.filter((f) => f.startsWith("plan-") && !before.has(f))) {
      await fsp.rm(path.join(plansDir, f), { force: true });
    }
  }

  it("capturePendingPlan forwards the plan to ide.recordComposerPlan keyed by tab id", async () => {
    const svc = freshService();
    svc.tabId = "tab-9";
    const before = await planFilesBefore();
    const recorded: unknown[][] = [];
    const d = vscodeStub.commands.registerCommand(
      "ide.recordComposerPlan",
      (...args: unknown[]) => {
        recorded.push(args);
      },
    );
    try {
      seedAssistantBubble(svc, "b-1", "# Test plan\n\n- step one");
      await capturePlan(svc, "b-1");
      assert.strictEqual(recorded.length, 1, "bridge must fire exactly once per captured plan");
      const [tabId, bubbleId, uriString, text] = recorded[0];
      assert.strictEqual(tabId, "tab-9");
      assert.strictEqual(bubbleId, "b-1");
      assert.strictEqual(text, "# Test plan\n\n- step one");
      // The stub Uri.file().toString() returns the raw path; production
      // passes a file:// URI string. Either way it must point at the file
      // capturePendingPlan persisted.
      const savedPath = svc.getPendingPlan()?.savedPath;
      assert.ok(savedPath, "plan file must be persisted");
      assert.strictEqual(uriString, savedPath);
    } finally {
      d.dispose();
      await cleanupNewPlanFiles(before);
    }
  });

  it("clearPendingPlan forwards to ide.clearComposerPlan keyed by tab id", async () => {
    const svc = freshService();
    svc.tabId = "tab-9";
    const cleared: unknown[][] = [];
    const d = vscodeStub.commands.registerCommand(
      "ide.clearComposerPlan",
      (...args: unknown[]) => {
        cleared.push(args);
      },
    );
    try {
      clearPlan(svc);
      await new Promise((r) => setImmediate(r));
      assert.deepStrictEqual(cleared, [["tab-9"]]);
    } finally {
      d.dispose();
    }
  });

  it("no tabId -> no bridge calls (unit-test default stays silent)", async () => {
    const svc = freshService(); // tabId unset
    const before = await planFilesBefore();
    const callsMade: string[] = [];
    const d1 = vscodeStub.commands.registerCommand("ide.recordComposerPlan", () => {
      callsMade.push("record");
    });
    const d2 = vscodeStub.commands.registerCommand("ide.clearComposerPlan", () => {
      callsMade.push("clear");
    });
    try {
      seedAssistantBubble(svc, "b-1", "# plan without tab");
      await capturePlan(svc, "b-1");
      assert.ok(svc.getPendingPlan(), "local pending plan still works without a tab id");
      clearPlan(svc);
      await new Promise((r) => setImmediate(r));
      assert.deepStrictEqual(callsMade, []);
    } finally {
      d1.dispose();
      d2.dispose();
      await cleanupNewPlanFiles(before);
    }
  });

  it("empty plan text captures nothing and fires no bridge call", async () => {
    const svc = freshService();
    svc.tabId = "tab-9";
    const recorded: unknown[][] = [];
    const d = vscodeStub.commands.registerCommand(
      "ide.recordComposerPlan",
      (...args: unknown[]) => {
        recorded.push(args);
      },
    );
    try {
      seedAssistantBubble(svc, "b-1", "   \n  ");
      await capturePlan(svc, "b-1");
      assert.strictEqual(recorded.length, 0);
      assert.strictEqual(svc.getPendingPlan(), null);
    } finally {
      d.dispose();
    }
  });
});
