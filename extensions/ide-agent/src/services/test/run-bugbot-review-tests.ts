/**
 * DEV-GAPS-10 (bugbot-editor-review-cta) tests — updated by WORKER-GAPS-44C
 * to the WORKER-GAPS-42D binary-verbatim correction (Cursor 3.25.9).
 *
 * `cursor.runEditorBugbot` reviews the REPO BRANCH at headRef — never the
 * active editor file (the old "review the current file" flow was a
 * misreading of the binary and has been removed from the service).
 *
 * - Command id is binary-verbatim `cursor.runEditorBugbot`.
 * - Gate: killswitch engaged OR the `autoRunBugbotOnCommit` storage flag
 *   off → silent return (binary-verbatim).
 * - Telemetry is binary-verbatim `bug_bot.run_ide_bug_finder`
 *   {entrypoint:"auto-run-on-commit"}.
 * - The review goes through the REAL composer submit path (not fabricated).
 *
 * Run after `tsc`:  node out/services/test/run-bugbot-review-tests.js
 */
import { describe, it } from "node:test";
import * as assert from "node:assert";
import "./vscode-stub";
import { vscodeStub, windowStub } from "./vscode-stub";
import {
  BUGBOT_RUN_EDITOR_REVIEW_COMMAND_ID,
  BUGBOT_RUN_EDITOR_REVIEW_TITLE,
  BUGBOT_RUN_IDE_BUG_FINDER_EVENT,
  BUGBOT_ENTRYPOINT_AUTO_RUN_ON_COMMIT,
  BUGBOT_AUTO_RUN_STORAGE_KEY,
  BugbotReviewTelemetry,
  BugbotReviewHistory,
  buildCommitReviewPrompt,
  registerBugbotReviewCommand,
  runBugbotAutoReview,
} from "../bugbotReviewService";
import type { BugbotAutoReviewDeps } from "../bugbotReviewService";

// --- extend the shared stub (local to this file; the shared stub file is
// left untouched so other workers' tests are unaffected) ---
const stubAny = vscodeStub as unknown as Record<string, unknown>;
const commandsAny = vscodeStub.commands as unknown as Record<string, unknown>;
const registered = new Map<string, (...args: unknown[]) => unknown>();
commandsAny["registerCommand"] = (id: string, handler: (...args: unknown[]) => unknown) => {
  registered.set(id, handler);
  return { dispose: () => registered.delete(id) };
};
const telemetryCalls: Array<{ eventName: string; data: unknown }> = [];
const senderCalls: Array<{ eventName: string; data: unknown }> = [];
(stubAny["env"] as Record<string, unknown>)["createTelemetryLogger"] = (_sender: {
  sendEventData: (eventName: string, data?: unknown) => void;
}) => {
  const sender = _sender;
  return {
    logUsage: (eventName: string, data?: unknown) => {
      telemetryCalls.push({ eventName, data });
      sender.sendEventData(eventName, data);
      senderCalls.push({ eventName, data });
    },
    logError: () => undefined,
    onDidChangeEnableStates: () => ({ dispose: () => undefined }),
    isUsageEnabled: true,
    isErrorsEnabled: true,
    dispose: () => undefined,
  };
};
const windowAny = windowStub as unknown as Record<string, unknown>;
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

function makeGlobalState(flag: boolean) {
  const store = new Map<string, unknown>([[BUGBOT_AUTO_RUN_STORAGE_KEY, flag]]);
  return {
    get: (key: string, def?: unknown) =>
      store.has(key) ? store.get(key) : def,
    update: (key: string, value: unknown) => {
      store.set(key, value);
      return Promise.resolve();
    },
  } as unknown as import("vscode").Memento;
}

function autoReviewDeps(
  overrides: Partial<BugbotAutoReviewDeps> & { flag?: boolean } = {},
) {
  const submitted: string[] = [];
  const sinkLines: string[] = [];
  const { flag = true, ...rest } = overrides;
  const deps: BugbotAutoReviewDeps = {
    globalState: makeGlobalState(flag),
    isKillswitchEngaged: () => false,
    telemetry: new BugbotReviewTelemetry((l) => sinkLines.push(l)),
    getChangedFiles: async (_root: string, commit: string) =>
      commit === "empty000" ? [] : ["src/a.ts", "src/b.ts"],
    submitReview: (prompt: string) => {
      submitted.push(prompt);
    },
    resolveRepoRoot: () => "/repo",
    showInfo: (m: string) => infos.push(m),
    showWarning: (m: string) => warnings.push(m),
    showError: (m: string) => errors.push(m),
    history: new BugbotReviewHistory(),
    sink: (l: string) => sinkLines.push(l),
    ...rest,
  };
  return { deps, submitted, sinkLines };
}

function reset() {
  registered.clear();
  telemetryCalls.length = 0;
  senderCalls.length = 0;
  infos.length = 0;
  warnings.length = 0;
  errors.length = 0;
}

describe("run-bugbot-review-tests", { concurrency: 1 }, () => {
describe("bugbot-auto-review — binary-verbatim identifiers", { concurrency: 1 }, () => {
  it("command id is verbatim `cursor.runEditorBugbot`", () => {
    assert.strictEqual(BUGBOT_RUN_EDITOR_REVIEW_COMMAND_ID, "cursor.runEditorBugbot");
  });

  it("telemetry event name is verbatim `bug_bot.run_ide_bug_finder`", () => {
    assert.strictEqual(BUGBOT_RUN_IDE_BUG_FINDER_EVENT, "bug_bot.run_ide_bug_finder");
  });

  it("entrypoint constant is verbatim `auto-run-on-commit`", () => {
    assert.strictEqual(BUGBOT_ENTRYPOINT_AUTO_RUN_ON_COMMIT, "auto-run-on-commit");
  });

  it("registers the verbatim command id on the extension host", () => {
    reset();
    const { composer } = makeComposer();
    const d = registerBugbotReviewCommand(
      { subscriptions: [] } as unknown as import("vscode").ExtensionContext,
      () => composer,
    );
    assert.ok(registered.has("cursor.runEditorBugbot"), "expected cursor.runEditorBugbot to be registered");
    d.dispose();
    assert.ok(!registered.has("cursor.runEditorBugbot"), "dispose should unregister");
  });

  it("title constant documents the inferred title (HONEST-DIVERGENCE)", () => {
    assert.strictEqual(BUGBOT_RUN_EDITOR_REVIEW_TITLE, "Run Bugbot Review on Latest Commit");
  });
});

describe("bugbot-auto-review — binary-verbatim gate", { concurrency: 1 }, () => {
  it("killswitch engaged → silent return, no submit, no telemetry", async () => {
    reset();
    const { deps, submitted, sinkLines } = autoReviewDeps({
      isKillswitchEngaged: () => true,
    });
    await runBugbotAutoReview(
      { fsPath: "/repo" } as unknown as import("vscode").Uri,
      "abc1234567",
      deps,
    );
    assert.deepStrictEqual(submitted, []);
    assert.strictEqual(telemetryCalls.length, 0);
    assert.deepStrictEqual(infos, []);
    assert.deepStrictEqual(warnings, []);
    assert.deepStrictEqual(errors, []);
    assert.ok(sinkLines.some((l) => /suppressed/.test(l)));
  });

  it("storage flag off → silent return, no submit, no telemetry", async () => {
    reset();
    const { deps, submitted, sinkLines } = autoReviewDeps({ flag: false });
    await runBugbotAutoReview(
      { fsPath: "/repo" } as unknown as import("vscode").Uri,
      "abc1234567",
      deps,
    );
    assert.deepStrictEqual(submitted, []);
    assert.strictEqual(telemetryCalls.length, 0);
    assert.ok(sinkLines.some((l) => /autoRunBugbotOnCommit is off/.test(l)));
  });
});

describe("bugbot-auto-review — handler behavior", { concurrency: 1 }, () => {
  it("enabled → submits the repo-branch review at headRef + verbatim telemetry", async () => {
    reset();
    const { composer, submitted } = makeComposer();
    const { deps, sinkLines } = autoReviewDeps({
      submitReview: (prompt: string) => {
        composer.submit(prompt);
      },
    });
    const history = new BugbotReviewHistory();
    deps.history = history;
    await runBugbotAutoReview(
      { fsPath: "/repo" } as unknown as import("vscode").Uri,
      "abc1234567",
      deps,
    );
    assert.strictEqual(submitted.length, 1);
    assert.ok(submitted[0].includes("abc1234"), "prompt must reference the commit");
    assert.ok(submitted[0].includes("src/a.ts"), "prompt must list changed files");
    assert.strictEqual(telemetryCalls.length, 1);
    assert.strictEqual(telemetryCalls[0].eventName, "bug_bot.run_ide_bug_finder");
    assert.deepStrictEqual(telemetryCalls[0].data, {
      entrypoint: "auto-run-on-commit",
    });
    assert.ok(
      sinkLines.some((l) => l.includes("bug_bot.run_ide_bug_finder")),
      "telemetry must reach the local sink",
    );
    assert.strictEqual(history.latest()?.kind, "commit");
    assert.strictEqual(history.latest()?.target, "/repo @ abc1234");
    assert.ok(
      infos.some((m) => /review submitted for commit abc1234/.test(m)),
      "non-blocking info expected",
    );
  });

  it("rootUri omitted → falls back to resolveRepoRoot", async () => {
    reset();
    const { deps, submitted } = autoReviewDeps();
    await runBugbotAutoReview(undefined, "abc1234567", deps);
    assert.strictEqual(submitted.length, 1);
    assert.ok(submitted[0].includes("abc1234"));
  });

  it("no repository anywhere → warning, no submit (telemetry still logged)", async () => {
    reset();
    const { deps, submitted } = autoReviewDeps({ resolveRepoRoot: () => undefined });
    await runBugbotAutoReview(undefined, "abc1234567", deps);
    assert.deepStrictEqual(submitted, []);
    assert.strictEqual(telemetryCalls.length, 1, "run telemetry precedes the root check");
    assert.ok(warnings.some((m) => /no repository found/.test(m)));
  });

  it("empty headRef → reviews HEAD", async () => {
    reset();
    const { deps, submitted } = autoReviewDeps();
    const history = new BugbotReviewHistory();
    deps.history = history;
    await runBugbotAutoReview(
      { fsPath: "/repo" } as unknown as import("vscode").Uri,
      "",
      deps,
    );
    assert.strictEqual(submitted.length, 1);
    assert.strictEqual(history.latest()?.target, "/repo @ HEAD");
  });

  it("submit throw → error message, watcher-style survival (no throw)", async () => {
    reset();
    const { deps, submitted } = autoReviewDeps({
      submitReview: () => {
        throw new Error("engine down");
      },
    });
    await runBugbotAutoReview(
      { fsPath: "/repo" } as unknown as import("vscode").Uri,
      "abc1234567",
      deps,
    );
    assert.deepStrictEqual(submitted, []);
    assert.ok(errors.some((m) => /could not start the review/.test(m)));
    assert.ok(errors.some((m) => /engine down/.test(m)));
  });

  it("registered handler submits the repo-branch review at headRef", async () => {
    reset();
    const { composer, submitted } = makeComposer();
    registerBugbotReviewCommand(
      {
        subscriptions: [],
        globalState: makeGlobalState(true),
      } as unknown as import("vscode").ExtensionContext,
      () => composer,
    );
    const handler = registered.get("cursor.runEditorBugbot");
    assert.ok(handler, "handler registered");
    await handler(
      { fsPath: "/w" } as unknown as import("vscode").Uri,
      "abc1234567",
    );
    assert.strictEqual(submitted.length, 1);
    assert.ok(submitted[0].includes("abc1234"), "prompt must reference the commit");
  });
});

describe("buildCommitReviewPrompt", { concurrency: 1 }, () => {
  it("references the commit and changed files, asks for a report (no fake results)", () => {
    const p = buildCommitReviewPrompt(["src/a.ts", "src/b.ts"], "abc1234567");
    assert.ok(p.includes("abc1234"));
    assert.ok(p.includes("src/a.ts"));
    assert.ok(/report/i.test(p), "should ask the agent to report findings");
    assert.ok(!/no bugs found/i.test(p), "must not fabricate a review result");
  });
});

});
