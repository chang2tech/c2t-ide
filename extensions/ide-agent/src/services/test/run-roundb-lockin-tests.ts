/**
 * Round B lock-in tests (REVERIFY-P3, RB-X3).
 *
 * These 7 fixes were verified correct by 4/4 QA voices but had ZERO tests —
 * they would regress silently. Each test below locks in the fixed behavior.
 *
 * Run after `tsc`: node --test out/services/test/run-roundb-lockin-tests.js
 */
import { describe, it } from "node:test";
import * as assert from "node:assert";
import "./vscode-stub";
import { isMutatingToolAction } from "../modeService";
import { ComposerDataService } from "../composerDataService";

/* ---------- 7. isMutatingToolAction with REAL compound names ---------- */
// The exact blind spot Round B flagged: the old test used synthetic
// 1-segment names (mcp__fs__write). Real MCP tools are compound
// (mcp__filesystem__write_file). The fail-closed classifier must deny
// ALL mcp__* except the read-only allowlist.
describe("lock-in: isMutatingToolAction with real compound MCP names", () => {
  it("denies real-world mutating compound names", () => {
    for (const name of [
      "mcp__filesystem__write_file",
      "mcp__filesystem__edit_file",
      "mcp__git__git_commit",
      "mcp__git__git_push",
      "mcp__shell__execute_command",
      "mcp__database__execute_sql",
    ]) {
      assert.ok(isMutatingToolAction(name), `${name} must be mutating (fail-closed)`);
    }
  });

  it("allows real-world read-only compound names on the allowlist", () => {
    for (const name of [
      "mcp__filesystem__read_file",
      "mcp__filesystem__read_text_file",
      "mcp__filesystem__list_directory",
      "mcp__filesystem__directory_tree",
      "mcp__memory__read_graph",
    ]) {
      assert.ok(!isMutatingToolAction(name), `${name} must be read-only`);
    }
  });

  it("denies malformed mcp__ names (no parseable server/tool)", () => {
    for (const name of ["mcp__", "mcp__onlyserver", "MCP__", "mcp__a__"]) {
      assert.ok(isMutatingToolAction(name), `${name} must be denied (fail-closed)`);
    }
  });
});

/* ---------- 4. pendingInterruptSends cap ---------- */
describe("lock-in: pendingInterruptSends cap", () => {
  it("caps at 10 entries, dropping oldest first", () => {
    const composer = new ComposerDataService(undefined, undefined);
    const priv = composer as unknown as {
      pushInterruptSend(e: { text: string }): void;
      pendingInterruptSends: Array<{ text: string }>;
    };
    for (let i = 0; i < 15; i++) {
      priv.pushInterruptSend({ text: `msg-${i}` });
    }
    assert.strictEqual(priv.pendingInterruptSends.length, 10, "must cap at 10");
    assert.strictEqual(priv.pendingInterruptSends[0]!.text, "msg-5", "oldest must drop first (FIFO)");
    assert.strictEqual(priv.pendingInterruptSends[9]!.text, "msg-14", "newest must be kept");
  });
});

/* ---------- 5. isDraining guard on revertToCheckpoint ---------- */
describe("lock-in: isDraining guard on revertToCheckpoint", () => {
  it("refuses while draining", async () => {
    const composer = new ComposerDataService(undefined, undefined);
    // Simulate draining state via the private depth counter.
    const priv = composer as unknown as { drainDepth: number };
    priv.drainDepth = 1;
    const result = await composer.revertToCheckpoint("b1");
    assert.deepStrictEqual(result, [], "must return [] while draining, not restore files");
    priv.drainDepth = 0;
  });
});
