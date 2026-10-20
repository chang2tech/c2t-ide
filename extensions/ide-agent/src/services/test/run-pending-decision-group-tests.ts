/**
 * DEV-GAPS-66/W66A tests (`agent-accept-pending-decisions`, node:test).
 *
 * Guards the binary-verbatim pending user-decision GROUP algorithm behind
 * `composer.acceptComposerStep` (workbench.glass.main.js 3.25.9):
 *  - ComposerDataService.getPendingUserDecisionGroup @39965884 (delegates
 *    to the tool former; the fork's HumanReviewService owns the store).
 *  - Tool-former getter @27763492: reverse the pending bubble ids;
 *    RUN_TERMINAL_COMMAND_V2 decisions first; otherwise the leading run
 *    of similar tools (`areToolsSimilar` @27745295, `toolCategories`
 *    @27744379 — one category "file_modification").
 *  - Decision shape @27756684: {toolCallId, clientSideTool, accept, reject,
 *    blocking, startedAt}; accept() = acceptToolCall (approve once).
 *
 * The REAL compiled HumanReviewService is exercised against a minimal
 * `vscode` stub (EventEmitter + getConfiguration) installed via a
 * Module._load hook BEFORE the service module is required.
 *
 * Run after `tsc`:  node --test out/services/test/run-pending-decision-group-tests.js
 */
import { describe, it, before } from "node:test";
import * as assert from "node:assert";

/* ------------------------------------------------------------------ */
/* vscode stub — installed before the service is required.            */
/* ------------------------------------------------------------------ */

class FakeEventEmitter<T> {
  private listeners: Array<(e: T) => void> = [];
  readonly event = (listener: (e: T) => void): { dispose(): void } => {
    this.listeners.push(listener);
    return { dispose: () => undefined };
  };
  fire(e: T): void {
    for (const listener of [...this.listeners]) {
      listener(e);
    }
  }
  dispose(): void {
    this.listeners = [];
  }
}

const vscodeStub = {
  EventEmitter: FakeEventEmitter,
  workspace: {
    getConfiguration: () => ({
      get: <T>(_key: string, fallback?: T): T | undefined => fallback,
    }),
  },
};

type HumanReviewServiceCtor = typeof import("../humanReviewService").HumanReviewService;
let HumanReviewService: HumanReviewServiceCtor;
let areToolsSimilar: typeof import("../humanReviewService").areToolsSimilar;

before(() => {
  // NOTE: `require("module")` — an `import * as Module` namespace wrapper
  // exposes `_load` through a getter only, so patching needs the raw
  // module object (same pattern as run-approval-card-diff-tests.ts).
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const Module = require("node:module") as { _load: (request: string, ...rest: unknown[]) => unknown };
  const origLoad = Module._load.bind(Module);
  Module._load = function (request: string, ...rest: unknown[]): unknown {
    if (request === "vscode") {
      return vscodeStub;
    }
    return origLoad(request, ...rest);
  };
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const mod = require("../humanReviewService") as typeof import("../humanReviewService");
  HumanReviewService = mod.HumanReviewService;
  areToolsSimilar = mod.areToolsSimilar;
});

/** Start an approval that stays pending; returns the (floating) promise. */
function startPending(
  svc: InstanceType<HumanReviewServiceCtor>,
  toolCallId: string,
  clientSideTool: string,
): Promise<unknown> {
  return svc.requestApproval(
    toolCallId,
    clientSideTool,
    ["test"],
    60_000,
    undefined,
    undefined,
    undefined,
    undefined,
    clientSideTool,
  );
}

describe("getPendingUserDecisionGroup (binary @27763492 port)", () => {
  it("returns [] when nothing is pending", () => {
    const svc = new HumanReviewService();
    assert.deepStrictEqual(svc.getPendingUserDecisionGroup(), []);
  });

  it("a single pending approval is the whole group", async () => {
    const svc = new HumanReviewService();
    const p = startPending(svc, "tc-1", "read");
    const group = svc.getPendingUserDecisionGroup();
    assert.strictEqual(group.length, 1);
    assert.strictEqual(group[0].toolCallId, "tc-1");
    assert.strictEqual(group[0].clientSideTool, "read");
    assert.strictEqual(group[0].blocking, true);
    assert.strictEqual(typeof group[0].startedAt, "number");
    svc.settleAllPending();
    await p;
  });

  it("terminal decisions win over everything else (RUN_TERMINAL_COMMAND_V2 first)", async () => {
    const svc = new HumanReviewService();
    const p1 = startPending(svc, "tc-edit", "edit");
    const p2 = startPending(svc, "tc-bash", "bash");
    const group = svc.getPendingUserDecisionGroup();
    assert.deepStrictEqual(group.map((d) => d.toolCallId), ["tc-bash"]);
    svc.settleAllPending();
    await Promise.all([p1, p2]);
  });

  it("all terminal decisions are returned, most recent first", async () => {
    const svc = new HumanReviewService();
    const p1 = startPending(svc, "tc-bash-1", "bash");
    const p2 = startPending(svc, "tc-read", "read");
    const p3 = startPending(svc, "tc-shell-2", "shell_tool_call");
    const group = svc.getPendingUserDecisionGroup();
    assert.deepStrictEqual(group.map((d) => d.toolCallId), ["tc-shell-2", "tc-bash-1"]);
    svc.settleAllPending();
    await Promise.all([p1, p2, p3]);
  });

  it("without terminal decisions, takes the leading run of similar tools (reversed order)", async () => {
    const svc = new HumanReviewService();
    const p1 = startPending(svc, "tc-edit-1", "edit");
    const p2 = startPending(svc, "tc-read-1", "read");
    const p3 = startPending(svc, "tc-read-2", "read");
    // Reversed pending order: read-2, read-1, edit-1 -> group stops at edit.
    const group = svc.getPendingUserDecisionGroup();
    assert.deepStrictEqual(group.map((d) => d.toolCallId), ["tc-read-2", "tc-read-1"]);
    svc.settleAllPending();
    await Promise.all([p1, p2, p3]);
  });

  it("accept() resolves every group member as approve-once and removes it from pending", async () => {
    const svc = new HumanReviewService();
    const p1 = startPending(svc, "tc-bash-1", "bash");
    const p2 = startPending(svc, "tc-bash-2", "bash");
    const group = svc.getPendingUserDecisionGroup();
    assert.strictEqual(group.length, 2);
    for (const decision of group) {
      decision.accept();
    }
    assert.deepStrictEqual(await p1, { optionId: "approve-once" });
    assert.deepStrictEqual(await p2, { optionId: "approve-once" });
    assert.strictEqual(svc.pendingCount(), 0);
  });

  it("reject() resolves the approval as undefined (skip)", async () => {
    const svc = new HumanReviewService();
    const p = startPending(svc, "tc-bash", "bash");
    const group = svc.getPendingUserDecisionGroup();
    group[0].reject();
    assert.strictEqual(await p, undefined);
    assert.strictEqual(svc.pendingCount(), 0);
  });
});

describe("areToolsSimilar (binary @27745295 port)", () => {
  it("identical tools are similar", () => {
    assert.strictEqual(areToolsSimilar("edit", "edit"), true);
    assert.strictEqual(areToolsSimilar("mcp__a__x", "mcp__a__x"), true);
  });

  it("different tools with no shared category are not similar", () => {
    assert.strictEqual(areToolsSimilar("edit", "read"), false);
    assert.strictEqual(areToolsSimilar("read", "glob"), false);
  });
});
