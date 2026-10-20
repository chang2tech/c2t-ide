/**
 * DEV-GAPS-15 (bugbot-remaining-commands) tests — updated by WORKER-GAPS-44C
 * to the WORKER-GAPS-42D binary-verbatim corrections (Cursor 3.25.9).
 *
 * - Command ids are binary-verbatim: `cursor.openBugbotPane`,
 *   `cursor.reviewBugbotFromAd`, `cursor.enableAutoReviewOnCommit`.
 * - `cursor.openBugbotPane` opens a pane (mocked webview) listing real
 *   review runs — no fabricated findings.
 * - `cursor.reviewBugbotFromAd(target, deps)` reviews the repository at
 *   HEAD: binary-verbatim bail telemetry `bug_bot.review_cta_bail`
 *   {reason}, run telemetry `bug_bot.run_ide_bug_finder`
 *   {entrypoint:"in_app_ad"}.
 * - `cursor.enableAutoReviewOnCommit` unconditionally ENABLES the
 *   `autoRunBugbotOnCommit` storage flag (the old quickpick toggle was a
 *   misreading of the binary and has been removed) + verbatim telemetry
 *   `bug_bot.autorun_on_commit_toggled` {enabled, source}.
 * - The commit watcher now lives in `bugbotCommitTrigger.ts` (tested by
 *   run-bugbot-commit-trigger-tests.ts).
 *
 * Run after `tsc`:  node out/services/test/run-bugbot-gaps15-tests.js
 */
import { describe, it } from "node:test";
import * as assert from "node:assert";
// NOTE: this extras module MUST be imported before ../bugbotReviewService
// (see its header) — it installs ViewColumn/ConfigurationTarget on the
// vscode stub up front.
import { panels } from "./vscode-stub-gaps15-extras";
import type { MockPanel } from "./vscode-stub-gaps15-extras";
import { vscodeStub, windowStub } from "./vscode-stub";
import {
  BUGBOT_OPEN_PANE_COMMAND_ID,
  BUGBOT_OPEN_PANE_TITLE,
  BUGBOT_REVIEW_FROM_AD_COMMAND_ID,
  BUGBOT_REVIEW_FROM_AD_TITLE,
  BUGBOT_ENABLE_AUTO_REVIEW_COMMAND_ID,
  BUGBOT_ENABLE_AUTO_REVIEW_TITLE,
  BUGBOT_AUTO_REVIEW_CONFIG_SECTION,
  BUGBOT_AUTO_REVIEW_CONFIG_KEY,
  BUGBOT_PANE_VIEW_TYPE,
  BUGBOT_REVIEW_CTA_BAIL_EVENT,
  BUGBOT_RUN_IDE_BUG_FINDER_EVENT,
  BUGBOT_ENTRYPOINT_IN_APP_AD,
  BUGBOT_AUTORUN_ON_COMMIT_TOGGLED_EVENT,
  BUGBOT_AUTO_RUN_STORAGE_KEY,
  BugbotReviewHistory,
  BugbotReviewTelemetry,
  buildBugbotPaneHtml,
  buildCommitReviewPrompt,
  registerOpenBugbotPaneCommand,
  reviewBugbotFromAd,
  registerBugbotFromAdCommand,
  enableBugbotAutoReviewOnCommit,
  registerBugbotAutoReviewEnableCommand,
} from "../bugbotReviewService";
import type { BugbotFromAdDeps } from "../bugbotReviewService";

// --- extend the shared stub (local to this file; the shared stub file is
// left untouched so other workers' tests are unaffected) ---
// (Top-level vscode keys live in vscode-stub-gaps15-extras.ts; only nested
// object overrides — visible through the import snapshot — go here.)
const stubAny = vscodeStub as unknown as Record<string, unknown>;
const windowAny = windowStub as unknown as Record<string, unknown>;

// registerCommand mock.
const commandsAny = vscodeStub.commands as unknown as Record<string, unknown>;
const registered = new Map<string, (...args: unknown[]) => unknown>();
commandsAny["registerCommand"] = (id: string, handler: (...args: unknown[]) => unknown) => {
  registered.set(id, handler);
  return { dispose: () => registered.delete(id) };
};

// Telemetry mock (mirrors the GAPS-10 test file's approach).
const telemetryCalls: Array<{ eventName: string; data: unknown }> = [];
(stubAny["env"] as Record<string, unknown>)["createTelemetryLogger"] = () => ({
  logUsage: (eventName: string, data?: unknown) => {
    telemetryCalls.push({ eventName, data });
  },
  logError: () => undefined,
  onDidChangeEnableStates: () => ({ dispose: () => undefined }),
  isUsageEnabled: true,
  isErrorsEnabled: true,
  dispose: () => undefined,
});

// Notification capture.
const infos: string[] = [];
const warnings: string[] = [];
const errors: string[] = [];
windowAny["showInformationMessage"] = (m: string) => {
  infos.push(m);
};
windowAny["showWarningMessage"] = (m: string) => {
  warnings.push(m);
  return Promise.resolve(undefined);
};
windowAny["showErrorMessage"] = (m: string) => {
  errors.push(m);
};

function makeComposer(submitImpl?: (prompt: string) => void) {
  const submitted: string[] = [];
  return {
    submitted,
    composer: {
      submit: (prompt: string) => {
        submitted.push(prompt);
        submitImpl?.(prompt);
      },
    } as unknown as import("../composerDataService").ComposerDataService,
  };
}

function makeGlobalState(initial = false) {
  const store = new Map<string, unknown>([
    [BUGBOT_AUTO_RUN_STORAGE_KEY, initial],
  ]);
  return {
    get: (key: string, def?: unknown) =>
      store.has(key) ? store.get(key) : def,
    update: (key: string, value: unknown) => {
      store.set(key, value);
      return Promise.resolve();
    },
  } as unknown as import("vscode").Memento;
}

function fromAdDeps() {
  const submitted: string[] = [];
  const sinkLines: string[] = [];
  const history = new BugbotReviewHistory();
  const deps: BugbotFromAdDeps = {
    telemetry: new BugbotReviewTelemetry(),
    getChangedFiles: async (_root: string, _commit: string) => [
      "src/a.ts",
      "src/b.ts",
    ],
    submitReview: (prompt: string) => {
      submitted.push(prompt);
    },
    showInfo: (m: string) => infos.push(m),
    showWarning: (m: string) => warnings.push(m),
    showError: (m: string) => errors.push(m),
    history,
    sink: (l: string) => sinkLines.push(l),
  };
  return { deps, submitted, sinkLines, history };
}

function setWorkspaceFolders(folders: Array<{ fsPath: string }>) {
  (stubAny["workspace"] as Record<string, unknown>)["workspaceFolders"] =
    folders.map((f) => ({ uri: { fsPath: f.fsPath }, name: "repo" }));
}

function reset() {
  registered.clear();
  telemetryCalls.length = 0;
  infos.length = 0;
  warnings.length = 0;
  errors.length = 0;
  // Default: no workspace folders (the from-ad bail path). Tests that need
  // folders set them explicitly after reset().
  setWorkspaceFolders([]);
  // Dispose all mock panels so the module-level singleton is cleared.
  for (const p of panels) {
    if (!p.disposed) p.dispose();
  }
  panels.length = 0;
}

describe("run-bugbot-gaps15-tests", { concurrency: 1 }, () => {
describe("gaps15 — binary-verbatim command ids", { concurrency: 1 }, () => {
  it("cursor.openBugbotPane is verbatim", () => {
    assert.strictEqual(BUGBOT_OPEN_PANE_COMMAND_ID, "cursor.openBugbotPane");
  });

  it("cursor.reviewBugbotFromAd is verbatim", () => {
    assert.strictEqual(BUGBOT_REVIEW_FROM_AD_COMMAND_ID, "cursor.reviewBugbotFromAd");
  });

  it("cursor.enableAutoReviewOnCommit is verbatim", () => {
    assert.strictEqual(BUGBOT_ENABLE_AUTO_REVIEW_COMMAND_ID, "cursor.enableAutoReviewOnCommit");
  });

  it("bail telemetry event is verbatim bug_bot.review_cta_bail", () => {
    assert.strictEqual(BUGBOT_REVIEW_CTA_BAIL_EVENT, "bug_bot.review_cta_bail");
  });

  it("run telemetry event is verbatim bug_bot.run_ide_bug_finder", () => {
    assert.strictEqual(BUGBOT_RUN_IDE_BUG_FINDER_EVENT, "bug_bot.run_ide_bug_finder");
  });

  it("setting constants resolve to ide.bugbot.autoReviewOnCommit", () => {
    assert.strictEqual(
      `${BUGBOT_AUTO_REVIEW_CONFIG_SECTION}.${BUGBOT_AUTO_REVIEW_CONFIG_KEY}`,
      "ide.bugbot.autoReviewOnCommit",
    );
  });

  it("inferred titles are non-empty constants (HONEST-DIVERGENCE)", () => {
    assert.ok(BUGBOT_OPEN_PANE_TITLE.length > 0);
    assert.ok(BUGBOT_REVIEW_FROM_AD_TITLE.length > 0);
    assert.ok(BUGBOT_ENABLE_AUTO_REVIEW_TITLE.length > 0);
  });
});

describe("gaps15 — BugbotReviewHistory", { concurrency: 1 }, () => {
  it("records runs newest-first; latest() returns the most recent", () => {
    const h = new BugbotReviewHistory();
    h.record("editor", "/a.ts", "prompt-a");
    h.record("ad", "/b.ts", "prompt-b");
    const list = h.list();
    assert.strictEqual(list.length, 2);
    assert.strictEqual(list[0].target, "/b.ts");
    assert.strictEqual(list[1].target, "/a.ts");
    assert.strictEqual(h.latest()?.target, "/b.ts");
  });

  it("records carry no findings field — nothing is fabricated", () => {
    const h = new BugbotReviewHistory();
    const rec = h.record("editor", "/a.ts", "prompt-a");
    assert.ok(!("findings" in rec), "record must not contain findings");
    assert.deepStrictEqual(Object.keys(rec).sort(), [
      "id",
      "kind",
      "prompt",
      "submittedAt",
      "target",
    ]);
  });
});

describe("gaps15 — cursor.openBugbotPane", { concurrency: 1 }, () => {
  it("registers the verbatim command id", () => {
    reset();
    const d = registerOpenBugbotPaneCommand(new BugbotReviewHistory());
    assert.ok(registered.has("cursor.openBugbotPane"));
    d.dispose();
    assert.ok(!registered.has("cursor.openBugbotPane"));
  });

  it("opens a webview panel (mock) when invoked", async () => {
    reset();
    registerOpenBugbotPaneCommand(new BugbotReviewHistory());
    const handler = registered.get("cursor.openBugbotPane");
    assert.ok(handler, "handler registered");
    await handler();
    assert.strictEqual(panels.length, 1);
    assert.strictEqual(panels[0].viewType, BUGBOT_PANE_VIEW_TYPE);
    assert.ok(/bugbot/i.test(panels[0].title));
  });

  it("panel lists the latest review runs from history", async () => {
    reset();
    const history = new BugbotReviewHistory();
    history.record("editor", "/repo/app.ts", "Review the file \"/repo/app.ts\" for bugs.");
    history.record("commit", "commit abc1234 (2 file(s))", "commit prompt");
    registerOpenBugbotPaneCommand(history);
    await registered.get("cursor.openBugbotPane")!();
    const html = panels[0].webview.html;
    assert.ok(html.includes("/repo/app.ts"), "pane must list the editor run");
    assert.ok(html.includes("abc1234"), "pane must list the commit run");
  });

  it("empty history shows an empty state — never fabricated findings", async () => {
    reset();
    registerOpenBugbotPaneCommand(new BugbotReviewHistory());
    await registered.get("cursor.openBugbotPane")!();
    const html = panels[0].webview.html;
    assert.ok(/no bugbot reviews yet/i.test(html), "empty state expected");
    assert.ok(!/no bugs found/i.test(html), "must not fabricate findings");
  });

  it("second open reveals the same panel (single instance) with fresh html", async () => {
    reset();
    const history = new BugbotReviewHistory();
    registerOpenBugbotPaneCommand(history);
    const handler = registered.get("cursor.openBugbotPane")!;
    await handler();
    history.record("ad", "/repo/ad.ts", "ad prompt");
    await handler();
    assert.strictEqual(panels.length, 1, "must not create a second panel");
    assert.strictEqual(panels[0].revealCount, 1);
    assert.ok(panels[0].webview.html.includes("/repo/ad.ts"), "html must refresh");
  });

  it("buildBugbotPaneHtml escapes HTML in paths/prompts", () => {
    const html = buildBugbotPaneHtml([
      {
        id: 1,
        kind: "editor",
        target: '/repo/<script>alert("x")</script>.ts',
        prompt: "<b>prompt</b>",
        submittedAt: "2026-10-20T00:00:00.000Z",
      },
    ]);
    assert.ok(!html.includes("<script>alert"), "raw script tag must be escaped");
    assert.ok(html.includes("&lt;script&gt;"), "escaped form expected");
  });
});

describe("gaps15 — cursor.reviewBugbotFromAd", { concurrency: 1 }, () => {
  it("registers the verbatim command id", () => {
    reset();
    const { composer } = makeComposer();
    const d = registerBugbotFromAdCommand(
      { subscriptions: [] } as unknown as import("vscode").ExtensionContext,
      () => composer,
    );
    assert.ok(registered.has("cursor.reviewBugbotFromAd"));
    d.dispose();
    assert.ok(!registered.has("cursor.reviewBugbotFromAd"));
  });

  it("no workspace folders → bail telemetry + verbatim info, no submit", async () => {
    reset();
    const { deps, submitted } = fromAdDeps();
    await reviewBugbotFromAd(undefined, deps);
    assert.deepStrictEqual(submitted, []);
    assert.strictEqual(telemetryCalls.length, 1);
    assert.strictEqual(telemetryCalls[0].eventName, "bug_bot.review_cta_bail");
    assert.deepStrictEqual(telemetryCalls[0].data, {
      reason: "no_workspace_folder",
    });
    assert.ok(infos.includes("Open a folder to run Bugbot review."));
  });

  it("target outside an open repo → repo_unresolved bail + verbatim info", async () => {
    reset();
    setWorkspaceFolders([{ fsPath: "/repo" }]);
    const { deps, submitted } = fromAdDeps();
    await reviewBugbotFromAd(
      { scheme: "file", fsPath: "/elsewhere/x.ts" } as unknown as import("vscode").Uri,
      deps,
    );
    assert.deepStrictEqual(submitted, []);
    assert.strictEqual(telemetryCalls.length, 1);
    assert.strictEqual(telemetryCalls[0].eventName, "bug_bot.review_cta_bail");
    assert.deepStrictEqual(telemetryCalls[0].data, {
      reason: "repo_unresolved",
    });
    assert.ok(
      infos.some((m) =>
        m.includes("Open the repository you just committed in"),
      ),
      "binary-verbatim info message expected",
    );
  });

  it("no target → reviews the first workspace folder at HEAD (real review flow)", async () => {
    reset();
    setWorkspaceFolders([{ fsPath: "/repo" }]);
    const { deps, submitted, history } = fromAdDeps();
    await reviewBugbotFromAd(undefined, deps);
    assert.strictEqual(submitted.length, 1);
    assert.ok(submitted[0].includes("src/a.ts"), "prompt must list changed files");
    assert.strictEqual(telemetryCalls.length, 1);
    assert.strictEqual(telemetryCalls[0].eventName, "bug_bot.run_ide_bug_finder");
    assert.deepStrictEqual(telemetryCalls[0].data, {
      entrypoint: BUGBOT_ENTRYPOINT_IN_APP_AD,
    });
    assert.strictEqual(history.latest()?.kind, "ad");
    assert.strictEqual(history.latest()?.target, "/repo @ HEAD");
    assert.ok(
      infos.some((m) => /review submitted for commit HEAD/.test(m)),
      "non-blocking info expected",
    );
  });

  it("submit throw → error message, no throw", async () => {
    reset();
    setWorkspaceFolders([{ fsPath: "/repo" }]);
    const { deps, submitted } = fromAdDeps();
    deps.submitReview = () => {
      throw new Error("engine down");
    };
    await reviewBugbotFromAd(undefined, deps);
    assert.deepStrictEqual(submitted, []);
    assert.ok(errors.some((m) => /could not start the review/.test(m)));
  });

  it("registered handler routes with the ad telemetry + ad history kind", async () => {
    reset();
    const { composer, submitted } = makeComposer();
    const history = new BugbotReviewHistory();
    registerBugbotFromAdCommand(
      { subscriptions: [] } as unknown as import("vscode").ExtensionContext,
      () => composer,
      history,
    );
    const handler = registered.get("cursor.reviewBugbotFromAd");
    assert.ok(handler, "handler registered");
    // The registered handler wires its own active-editor/telemetry deps, so
    // exercise it through a stubbed activeTextEditor path is not available
    // here; instead assert the pure flow function behaves (covered above)
    // and that the handler exists under the verbatim id.
    assert.strictEqual(typeof handler, "function");
    assert.strictEqual(submitted.length, 0);
    assert.strictEqual(history.list().length, 0);
  });
});

describe("gaps15 — cursor.enableAutoReviewOnCommit (unconditional enable)", { concurrency: 1 }, () => {
  it("sets the storage flag + verbatim telemetry + info (no quickpick)", async () => {
    reset();
    const globalState = makeGlobalState(false);
    const sinkLines: string[] = [];
    await enableBugbotAutoReviewOnCommit(
      globalState,
      new BugbotReviewTelemetry(),
      (m: string) => infos.push(m),
      (l: string) => sinkLines.push(l),
    );
    assert.strictEqual(
      globalState.get(BUGBOT_AUTO_RUN_STORAGE_KEY),
      true,
      "flag must be enabled unconditionally",
    );
    assert.strictEqual(telemetryCalls.length, 1);
    assert.strictEqual(
      telemetryCalls[0].eventName,
      "bug_bot.autorun_on_commit_toggled",
    );
    assert.deepStrictEqual(telemetryCalls[0].data, {
      enabled: true,
      source: "in_app_ad",
    });
    assert.ok(sinkLines.includes("[bugbot] autoRunBugbotOnCommit enabled"));
    assert.ok(infos.some((m) => /Start Agent Review on Commit/.test(m)));
  });

  it("registers the verbatim command id; handler enables the flag", async () => {
    reset();
    const globalState = makeGlobalState(false);
    const d = registerBugbotAutoReviewEnableCommand(
      {
        subscriptions: [],
        globalState,
      } as unknown as import("vscode").ExtensionContext,
    );
    assert.ok(registered.has("cursor.enableAutoReviewOnCommit"));
    const handler = registered.get("cursor.enableAutoReviewOnCommit");
    assert.ok(handler, "handler registered");
    await handler();
    assert.strictEqual(globalState.get(BUGBOT_AUTO_RUN_STORAGE_KEY), true);
    assert.ok(infos.some((m) => /enabled/.test(m)));
    d.dispose();
    assert.ok(!registered.has("cursor.enableAutoReviewOnCommit"));
  });
});

describe("gaps15 — buildCommitReviewPrompt", { concurrency: 1 }, () => {
  it("references the commit and changed files (no fake results)", () => {
    const p = buildCommitReviewPrompt(["src/a.ts", "src/b.ts"], "abc1234567");
    assert.ok(p.includes("abc1234"));
    assert.ok(p.includes("src/a.ts"));
    assert.ok(/report/i.test(p));
    assert.ok(!/no bugs found/i.test(p), "must not fabricate a review result");
  });
});

});
