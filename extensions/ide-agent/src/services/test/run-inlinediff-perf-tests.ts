/**
 * Inline-diff performance-protection tests (node:test, vscode stubbed via ./vscode-stub).
 *
 * Locks in Cursor parity (dig-continuous-inline-edit-2026-10-19, binary
 * evidence — Cursor 3.25.9 glass bundle):
 * - `ide.inlineDiff.enablePerformanceProtection` (default true) +
 *   `ide.inlineDiff.maxDecorations` (default 100, from experiment
 *   `inline_diff_performance_config.maxDecorations`).
 * - The suppression decision mirrors the binary: `s &&
 *   this.changes.length > o` — strictly greater-than; no suppression when
 *   protection is disabled.
 * - Over the threshold the user gets the "too many changes" warning with a
 *   "Don't show again" action, persisted under the verbatim warning id
 *   `ide.inlineDiff.tooManyChangesWarning` (Cursor's `neverShowAgain` id —
 *   the public VS Code API has no `neverShowAgain` option, so the dismissal
 *   is stored in extension globalState).
 *
 * Run after `tsc`:  node out/services/test/run-inlinediff-perf-tests.js
 */
import { describe, it } from "node:test";
import * as assert from "node:assert";
import "./vscode-stub";
import { windowStub } from "./vscode-stub";
import * as vscode from "vscode";
import {
  INLINE_DIFF_MAX_DECORATIONS_DEFAULT,
  INLINE_DIFF_TOO_MANY_CHANGES_WARNING_ID,
  readInlineDiffPerfConfig,
  shouldSuppressInlineDiffDecorations,
  showInlineDiffTooManyChangesWarning,
  type InlineDiffPerfProtection,
} from "../inlineEditService";

const PROTECTED: InlineDiffPerfProtection = {
  enablePerformanceProtection: true,
  maxDecorations: 100,
};
const UNPROTECTED: InlineDiffPerfProtection = {
  enablePerformanceProtection: false,
  maxDecorations: 100,
};

/** Fake WorkspaceConfiguration: values map, everything else falls to `def`. */
const cfgOf = (values: Record<string, unknown>) =>
  ({
    get: (key: string, def?: unknown) => (key in values ? values[key] : def),
  }) as unknown as Pick<vscode.WorkspaceConfiguration, "get">;

/** Minimal Memento backed by a Map. */
function fakeMemento(store = new Map<string, unknown>()): vscode.Memento {
  return {
    keys: () => [...store.keys()],
    get: <T>(key: string, defaultValue?: T): T | undefined =>
      (store.has(key) ? (store.get(key) as T) : defaultValue),
    update: async (key: string, value: unknown): Promise<void> => {
      if (value === undefined) store.delete(key);
      else store.set(key, value);
    },
  };
}

function drainWarning(): { message: string | undefined; items: string[] } {
  return { message: windowStub.consumeWarning(), items: windowStub.consumeWarningItems() };
}

describe("inline-diff perf protection — suppression decision (binary: s && changes.length > o)", () => {
  it("suppresses when changes exceed maxDecorations (101 > 100)", () => {
    assert.strictEqual(shouldSuppressInlineDiffDecorations(101, PROTECTED), true);
    assert.strictEqual(shouldSuppressInlineDiffDecorations(10_000, PROTECTED), true);
  });

  it("does NOT suppress at exactly maxDecorations (boundary is strictly >)", () => {
    assert.strictEqual(shouldSuppressInlineDiffDecorations(100, PROTECTED), false);
  });

  it("does NOT suppress when protection is disabled, however many changes", () => {
    assert.strictEqual(shouldSuppressInlineDiffDecorations(500, UNPROTECTED), false);
    assert.strictEqual(shouldSuppressInlineDiffDecorations(10_000, UNPROTECTED), false);
  });

  it("respects a custom maxDecorations", () => {
    const custom = { enablePerformanceProtection: true, maxDecorations: 50 };
    assert.strictEqual(shouldSuppressInlineDiffDecorations(51, custom), true);
    assert.strictEqual(shouldSuppressInlineDiffDecorations(50, custom), false);
  });

  it("zero changes never suppress", () => {
    assert.strictEqual(shouldSuppressInlineDiffDecorations(0, PROTECTED), false);
  });
});

describe("readInlineDiffPerfConfig — defaults mirror Cursor (true / 100)", () => {
  it("defaults to enabled + 100 when nothing is configured", () => {
    assert.deepStrictEqual(readInlineDiffPerfConfig(cfgOf({})), {
      enablePerformanceProtection: true,
      maxDecorations: 100,
    });
  });

  it("reads configured values", () => {
    assert.deepStrictEqual(
      readInlineDiffPerfConfig(
        cfgOf({ enablePerformanceProtection: false, maxDecorations: 42 }),
      ),
      { enablePerformanceProtection: false, maxDecorations: 42 },
    );
  });

  it("the default-threshold constant is 100 (from inline_diff_performance_config)", () => {
    assert.strictEqual(INLINE_DIFF_MAX_DECORATIONS_DEFAULT, 100);
  });
});

describe("too-many-changes warning (neverShowAgain analog)", () => {
  it("warns with the change count and offers a \"Don't show again\" action", async () => {
    drainWarning();
    await showInlineDiffTooManyChangesWarning(150, fakeMemento());
    const { message, items } = drainWarning();
    assert.ok(
      message && /150 changes/.test(message),
      `warning must name the change count, got: ${message}`,
    );
    assert.ok(
      items.includes("Don't show again"),
      `warning must offer "Don't show again", got: ${JSON.stringify(items)}`,
    );
  });

  it("choosing \"Don't show again\" persists under the verbatim warning id", async () => {
    const store = new Map<string, unknown>();
    windowStub.nextWarningChoice = "Don't show again";
    await showInlineDiffTooManyChangesWarning(150, fakeMemento(store));
    assert.strictEqual(
      store.get(INLINE_DIFF_TOO_MANY_CHANGES_WARNING_ID),
      true,
      "dismissal must persist under ide.inlineDiff.tooManyChangesWarning",
    );
  });

  it("a dismissed warning is never shown again", async () => {
    drainWarning();
    const store = new Map<string, unknown>([[INLINE_DIFF_TOO_MANY_CHANGES_WARNING_ID, true]]);
    await showInlineDiffTooManyChangesWarning(150, fakeMemento(store));
    const { message } = drainWarning();
    assert.strictEqual(message, undefined, "no warning after dismissal");
  });

  it("closing the warning without choosing keeps it showing next time", async () => {
    const store = new Map<string, unknown>();
    const memento = fakeMemento(store);
    windowStub.nextWarningChoice = undefined; // user closed it
    await showInlineDiffTooManyChangesWarning(150, memento);
    drainWarning();
    await showInlineDiffTooManyChangesWarning(150, memento);
    const { message } = drainWarning();
    assert.ok(message, "warning must show again when not explicitly dismissed");
    assert.strictEqual(store.get(INLINE_DIFF_TOO_MANY_CHANGES_WARNING_ID), undefined);
  });
});
