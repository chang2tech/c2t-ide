/**
 * Round B lock-in tests (REVERIFY-P3, RB-X3).
 *
 * These 7 fixes were verified correct by 4/4 QA voices but had ZERO tests —
 * they would regress silently. Each test below locks in the fixed behavior.
 *
 * Run after `tsc`: node --test out/services/test/run-roundb-lockin-tests.js
 */
import { after, describe, it } from "node:test";
import * as assert from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import "./vscode-stub";
import { vscodeStub, windowStub } from "./vscode-stub";
import { isMutatingToolAction } from "../modeService";
import { buildAllowlistIdentity } from "../ideCodeEngineAdapter";
import { ComposerDataService } from "../composerDataService";
import { MentionService, type MentionChip } from "../mentionService";
import { browserCaptureDir } from "../../browser/chromium";
import {
  reconcileAllTabsWithAllowlist,
  reconcileSelectionWithAllowlist,
} from "../../extension";
import type { ChatTabService } from "../chatTabService";
import { autoSelection, selectionKind } from "../modelService";
import type { ModelSelection } from "../modelService";

/**
 * DEV-GAPS-36: every ComposerDataService created below is tracked so the
 * file-level after() can dispose it. An undisposed composer leaks its
 * CheckpointStorageCompareService scheduler (15 s ref'd activation timer →
 * 10 min ref'd interval chain, per GAPS-25's root cause in
 * checkpointStorageCompare.ts) and its `bun serve` sidecar
 * (IdeCodeEngineAdapter — engineMode defaults to "sidecar"): the sidecar's
 * piped stdio keeps the event loop alive, so node:test hangs at file level
 * after all suites pass ("Promise resolution is still pending but the event
 * loop has already resolved"). dispose() is idempotent, stops the
 * checkpoint scheduler (via the GAPS-25 this.checkpoints.dispose()
 * cascade) and kills the sidecar (SIGTERM, escalated to SIGKILL).
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

/* ---------- 4. interrupt-send staging (reworked 2026-10-19) ----------
 * DIG-CONTINUOUS debunked the fabricated 10-entry cap (Cursor has no
 * interrupt-sends queue at all): stop-and-send = abort-then-submit via a
 * single slot; steers overflow into the unbounded message queue. */
describe("lock-in: interrupt-send staging (single slot, uncapped)", () => {
  it("stages the first steer in the slot; further steers overflow to the queue — nothing drops", () => {
    const composer = track(new ComposerDataService(undefined, undefined));
    const priv = composer as unknown as {
      stageInterruptSend(e: { text: string }, opts: { interrupt: boolean }): void;
      pendingInterruptSend: { text: string } | undefined;
    };
    for (let i = 0; i < 15; i++) {
      priv.stageInterruptSend({ text: `msg-${i}` }, { interrupt: false });
    }
    assert.strictEqual(priv.pendingInterruptSend!.text, "msg-0", "first steer staged in the slot");
    assert.strictEqual(composer.queue.length, 14, "the rest overflow into the unbounded queue");
    assert.deepStrictEqual(
      composer.queue.getItems().map((m) => m.text),
      Array.from({ length: 14 }, (_, i) => `msg-${i + 1}`),
      "overflow preserves order",
    );
  });

  it("an interrupt supersedes a staged steer (latest wins, never queued)", () => {
    const composer = track(new ComposerDataService(undefined, undefined));
    const priv = composer as unknown as {
      stageInterruptSend(e: { text: string }, opts: { interrupt: boolean }): void;
      pendingInterruptSend: { text: string } | undefined;
    };
    priv.stageInterruptSend({ text: "steer" }, { interrupt: false });
    priv.stageInterruptSend({ text: "interrupt!" }, { interrupt: true });
    assert.strictEqual(priv.pendingInterruptSend!.text, "interrupt!");
    assert.strictEqual(composer.queue.length, 0, "interrupts never touch the queue");
  });
});

/* ---------- 5. isDraining guard on revertToCheckpoint ---------- */
describe("lock-in: isDraining guard on revertToCheckpoint", () => {
  it("refuses while draining", async () => {
    const composer = track(new ComposerDataService(undefined, undefined));
    // Simulate draining state via the private depth counter.
    const priv = composer as unknown as { drainDepth: number };
    priv.drainDepth = 1;
    const result = await composer.revertToCheckpoint("b1");
    assert.deepStrictEqual(result, [], "must return [] while draining, not restore files");
    priv.drainDepth = 0;
  });
});

/* ---------- 1+2. Round B modelpicker fixes (extension.ts privates) ----------
 * The vscode stub's getConfiguration always returns the default, but the
 * reconcile helpers read `ide.agent.enabledModels`, so these describes
 * install a tiny settable overlay for the config and restore the original
 * afterwards. The overlay with an empty map behaves exactly like the stub. */
const ideAgentConfig = new Map<string, unknown>();
const stubWorkspace = vscodeStub.workspace as unknown as {
  getConfiguration: (section?: string) => { get: (key: string, def?: unknown) => unknown };
};
const originalGetConfiguration = stubWorkspace.getConfiguration;
stubWorkspace.getConfiguration = (section?: string) => ({
  get: (key: string, def?: unknown) => {
    const full = section ? `${section}.${key}` : key;
    return ideAgentConfig.has(full) ? ideAgentConfig.get(full) : def;
  },
});
after(() => {
  stubWorkspace.getConfiguration = originalGetConfiguration;
  ideAgentConfig.clear();
});
function setEnabledModelsForTest(models: string[]): void {
  ideAgentConfig.set("ide.agent.enabledModels", models);
}
function explicitSelection(providerID: string, id: string, label: string): ModelSelection {
  return { kind: "explicit", label, ref: { id, providerID } };
}
/** Minimal tab: a mutable model selection + an engine adapter spy. */
function makeFakeTab(
  id: string,
  initial: ModelSelection,
  opts?: { setModelImpl?: (model: unknown) => Promise<void> },
) {
  let selection = initial;
  const setModelCalls: unknown[] = [];
  const composer = {
    models: {
      getSelection: () => selection,
      setSelection: (s: ModelSelection) => {
        selection = s;
      },
    },
    getEngineAdapter: () => ({
      setModel: async (model: unknown) => {
        setModelCalls.push(model);
        if (opts?.setModelImpl) {
          await opts.setModelImpl(model);
        }
      },
    }),
  };
  return {
    tab: { id, title: `Tab ${id}`, composer, createdAt: Date.now(), pinned: false },
    composer,
    setModelCalls,
    getSelection: () => selection,
  };
}

/* ---------- 1. multi-tab reconcileAllTabsWithAllowlist (RB-X3 item 1) ----------
 * Round B P1 (QA-MODELPICKER Round-B): disabling a model while tab B was in
 * the background left tab B's engine on the disabled model — each tab owns an
 * independent selectedModel + engine adapter and switchTab doesn't
 * re-validate — burning real money on tab B's next turn. The fix reconciles
 * EVERY tab's selection (not just the active tab's) and reports the previous
 * label of each changed tab for honest reporting. */
describe("lock-in: reconcileAllTabsWithAllowlist reconciles EVERY tab", () => {
  it("resets background tabs stuck on a disabled model and reports their previous labels", async () => {
    setEnabledModelsForTest(["openai/gpt-5"]);
    const a = makeFakeTab("tab-a", explicitSelection("openai", "gpt-5", "GPT-5"));
    const b = makeFakeTab("tab-b", explicitSelection("anthropic", "claude-x", "Claude X"));
    const c = makeFakeTab("tab-c", autoSelection());
    const tabs = { listTabs: () => [a.tab, b.tab, c.tab] } as unknown as ChatTabService;

    const changed = await reconcileAllTabsWithAllowlist(tabs);

    // Only the background tab on the disabled model changed — with its
    // previous label reported for the honest "which tabs were affected" UI.
    assert.deepStrictEqual(changed, [{ tabId: "tab-b", previousLabel: "Claude X" }]);
    // The engine is switched to auto FIRST (best effort), then the UI.
    assert.deepStrictEqual(b.setModelCalls, [undefined]);
    assert.strictEqual(selectionKind(b.getSelection()), "auto");
    // The enabled explicit selection is untouched...
    assert.strictEqual(selectionKind(a.getSelection()), "explicit");
    assert.deepStrictEqual(a.setModelCalls, []);
    // ...and virtual selectors are never "disabled" by the allowlist.
    assert.strictEqual(selectionKind(c.getSelection()), "auto");
    assert.deepStrictEqual(c.setModelCalls, []);
  });

  it("returns [] and touches nothing when every tab is already allowed", async () => {
    setEnabledModelsForTest([]); // empty allowlist = all models enabled
    const a = makeFakeTab("tab-a", explicitSelection("anthropic", "claude-x", "Claude X"));
    const tabs = { listTabs: () => [a.tab] } as unknown as ChatTabService;

    const changed = await reconcileAllTabsWithAllowlist(tabs);

    assert.deepStrictEqual(changed, []);
    assert.strictEqual(selectionKind(a.getSelection()), "explicit");
    assert.deepStrictEqual(a.setModelCalls, []);
  });
});

/* ---------- 2. reconcile engine-failure warning reword (RB-X3 item 2) ----------
 * Round B P2 (verdict-modelpicker, 2/3): the old warning "New turns may still
 * use the disabled model" was misleading. When setModel fails on the live
 * session, the CURRENT live session keeps the disabled model but NEW sessions
 * are safe — the reworded warning must say exactly that. */
describe("lock-in: reconcile engine-failure warning distinguishes live vs new sessions", () => {
  it("shows the reworded warning — never the old misleading wording", async () => {
    setEnabledModelsForTest(["openai/gpt-5"]);
    const t = makeFakeTab(
      "tab-x",
      explicitSelection("anthropic", "claude-x", "Claude X"),
      {
        setModelImpl: async () => {
          throw new Error("engine exploded");
        },
      },
    );
    windowStub.consumeWarning(); // clear anything recorded earlier

    const changed = await reconcileSelectionWithAllowlist(
      t.composer as unknown as ComposerDataService,
    );

    assert.strictEqual(changed, true);
    const warning = windowStub.consumeWarning();
    assert.ok(warning, "must warn when the live-session engine switch fails");
    assert.ok(
      warning!.includes("live session"),
      `warning must name the failed live session, got: ${warning}`,
    );
    assert.ok(
      warning!.includes("New sessions are safe"),
      `warning must say new sessions are safe, got: ${warning}`,
    );
    assert.ok(
      !warning!.includes("New turns may still use"),
      `old misleading wording must be gone, got: ${warning}`,
    );
    // Best effort: even though the engine switch failed, the UI still falls
    // back to auto so it never points at a model the user disabled.
    assert.strictEqual(selectionKind(t.getSelection()), "auto");
  });
});

/* ---------- 3. allowlist identity NUL separator (RB-X3 item 3) ----------
 * P1 (QA-CHATTABS-01): the old allowlist key joined resources with "," —
 * ["a,b"] and ["a","b"] collided into the SAME key, and shell resources are
 * full command text where commas are common. The fix (ideCodeEngineAdapter.ts
 * buildAllowlistIdentity) joins with NUL, which cannot appear in a file path
 * (forbidden by the OS on POSIX and Windows) or in command text, so the key
 * is unambiguous. These lock in: (a) the exact comma collision stays fixed;
 * (b) other special chars (| : / ,) survive join/split; (c) round-trip. */
describe("lock-in: buildAllowlistIdentity NUL separator", () => {
  it('distinguishes ["echo a,b"] from ["echo a","b"] — the exact comma collision', () => {
    const one = buildAllowlistIdentity("bash", ["echo a,b"]);
    const two = buildAllowlistIdentity("bash", ["echo a", "b"]);
    assert.notStrictEqual(one, two, "a comma inside a resource must not collide with two resources");
    // Why the old separator was unsafe: both joined to "echo a,b".
    assert.strictEqual(
      ["echo a,b"].join(","),
      ["echo a", "b"].join(","),
      "comma-join collides — the precondition that forced NUL",
    );
  });

  it("survives | : / and commas common in shell command text", () => {
    const a = buildAllowlistIdentity("edit", ["src/a|b.ts", "C:/x:y/z.ts"]);
    const b = buildAllowlistIdentity("edit", ["src/a", "b.ts", "C:/x:y/z.ts"]);
    assert.notStrictEqual(a, b, "splitting on a special char must not create a phantom resource");
    const c = buildAllowlistIdentity("bash", ["ls | grep foo", "rm -rf /tmp/x,y"]);
    const d = buildAllowlistIdentity("bash", ["ls ", " grep foo", "rm -rf /tmp/x", "y"]);
    assert.notStrictEqual(c, d, "pipeline/comma in command text must not collide");
  });

  it("round-trips: split on NUL recovers the deduped, sorted resources", () => {
    const resources = ["src/z.ts", "src/a.ts", "src/a.ts", "src/m.ts"];
    const identity = buildAllowlistIdentity("write", resources);
    assert.ok(identity.startsWith("write::"), "identity is action::resources");
    const recovered = identity.slice("write::".length).split("\u0000");
    assert.deepStrictEqual(recovered, ["src/a.ts", "src/m.ts", "src/z.ts"]);
  });

  it("is order- and dupe-insensitive but action-sensitive", () => {
    assert.strictEqual(
      buildAllowlistIdentity("bash", ["b", "a"]),
      buildAllowlistIdentity("bash", ["a", "b", "a"]),
      "same set in any order with dupes must be one identity",
    );
    assert.notStrictEqual(
      buildAllowlistIdentity("edit", ["a"]),
      buildAllowlistIdentity("write", ["a"]),
      "different actions must be different identities",
    );
  });
});

/* ---------- 6. typeof-guard filePath in extractFileAttachments (RB-X3 item 6) ----------
 * P3 (QA-MODELPICKER Round-B): filePath round-trips through the UNTRUSTED
 * webview, and isMentionChip (mentionMatch.ts) doesn't validate it. Before
 * the guard, path.resolve(12345) threw a TypeError outside every try/catch
 * and killed the whole submit. The fix skips non-string filePaths instead
 * of throwing — and keeps the capture-dir containment for real strings. */
describe("lock-in: extractFileAttachments typeof-guard filePath", () => {
  const svc = new MentionService();

  function imageChip(filePath: unknown): MentionChip {
    return {
      id: "chip-1",
      label: "screenshot",
      rawText: "@browser",
      uuid: "uuid-1",
      mentionType: "browser",
      payload: { case: "imageContext", label: "screenshot", filePath, dataUrl: "" },
    } as unknown as MentionChip;
  }

  it("rejects forged non-string filePaths without throwing (the 5 audit probes)", () => {
    for (const bad of [12345, null, undefined, {}, []] as unknown[]) {
      let result: unknown;
      assert.doesNotThrow(() => {
        result = svc.extractFileAttachments([imageChip(bad)]);
      }, `filePath ${String(bad)} must not throw`);
      assert.deepStrictEqual(result, [], `filePath ${String(bad)} must be skipped, not attached`);
    }
  });

  it("rejects string filePaths outside the capture dir (containment holds)", () => {
    const result = svc.extractFileAttachments([imageChip(path.join(os.tmpdir(), "evil.png"))]);
    assert.deepStrictEqual(result, [], "paths outside the capture dir are never attachments");
  });

  it("accepts a real string filePath inside the capture dir", () => {
    const dir = browserCaptureDir();
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `lockin-test-${process.pid}.png`);
    // Minimal PNG bytes: non-empty and far under the 15MB attachment cap.
    const png = Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
      0x49, 0x48, 0x44, 0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
      0x08, 0x02, 0x00, 0x00, 0x00, 0x90, 0x77, 0x53, 0xde,
    ]);
    fs.writeFileSync(file, png);
    try {
      const result = svc.extractFileAttachments([imageChip(file)]);
      assert.strictEqual(result.length, 1, "a valid capture must become exactly one attachment");
      assert.strictEqual(result[0].uri, `file://${path.resolve(file)}`);
      assert.strictEqual(result[0].name, path.basename(file));
      assert.strictEqual(result[0].description, "screenshot");
    } finally {
      fs.unlinkSync(file);
    }
  });
});
