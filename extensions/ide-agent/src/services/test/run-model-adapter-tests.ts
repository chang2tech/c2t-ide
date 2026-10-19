/**
 * IdeCodeEngineAdapter.setModel semantics tests (node:test).
 *
 * Pins the contract that pickModel / cycleModel / manageModels rely on:
 * `setModel(undefined)` = "auto" — clears the recorded selection so future
 * sessions are created without an explicit model (engine default), and must
 * NOT throw when the engine is unreachable (the default-model lookup is
 * best-effort). A regression here would let the engine keep burning a model
 * the user disabled.
 *
 * Run after `tsc`:  node out/services/test/run-model-adapter-tests.mjs
 */
import "./vscode-stub";
import { describe, it } from "node:test";
import * as assert from "node:assert";
import * as vscode from "vscode";
import { IdeCodeEngineAdapter } from "../ideCodeEngineAdapter";

function makeAdapter(): IdeCodeEngineAdapter {
  // Bogus enginePath: ensureServer() throws fast on the existsSync guard,
  // so getDefaultModel() inside setModel(undefined) fails best-effort
  // without ever spawning a process.
  return new IdeCodeEngineAdapter({
    enginePath: "/nonexistent-engine-path-for-tests",
    output: vscode.window.createOutputChannel("test") as vscode.OutputChannel,
    requestApproval: async () => undefined,
  });
}

function selectedModelOf(adapter: IdeCodeEngineAdapter): unknown {
  return (adapter as unknown as { selectedModel?: unknown }).selectedModel;
}

describe("IdeCodeEngineAdapter.setModel(undefined) = auto", () => {
  it("records an explicit ref", async () => {
    const adapter = makeAdapter();
    const ref = { id: "m1", providerID: "p1" };
    await adapter.setModel(ref);
    assert.deepStrictEqual(selectedModelOf(adapter), ref);
  });

  it("clears the selection to undefined (engine default) without throwing", async () => {
    const adapter = makeAdapter();
    await adapter.setModel({ id: "m1", providerID: "p1" });
    assert.notStrictEqual(selectedModelOf(adapter), undefined);
    // No sessions exist and the engine is unreachable — this must still
    // resolve (default-model lookup failure is best-effort) and leave the
    // recorded selection cleared so future sessions get the engine default.
    await adapter.setModel(undefined);
    assert.strictEqual(selectedModelOf(adapter), undefined);
  });

  it("round-trips: ref -> auto -> ref", async () => {
    const adapter = makeAdapter();
    const ref = { id: "m2", providerID: "p2", variant: "thinking" };
    await adapter.setModel(ref);
    await adapter.setModel(undefined);
    assert.strictEqual(selectedModelOf(adapter), undefined);
    await adapter.setModel(ref);
    assert.deepStrictEqual(selectedModelOf(adapter), ref);
  });
});
