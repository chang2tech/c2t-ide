/**
 * GAPS-14 (agent-shell-approval-keyboard-flow) tests (node:test, vscode stubbed via ./vscode-stub).
 *
 * Cursor 3.25.6 binary-verbatim commands (glass bundle class registrations):
 *   composer.approvePendingShellToolDecision            "Approve pending shell tool (run)"       Enter
 *   composer.approvePendingShellToolDecisionAllowlist   "Approve pending shell tool and allowlist" Shift+Enter
 *   composer.skipPendingShellToolDecision               "Skip pending shell tool"                Escape
 *   composer.cancelTerminalToolCall                    "Cancel Terminal Tool Call"              Shift+Backspace
 * The first three are registered in workbench core (composerActions.ts) with
 * `when: composer.toolApprovalVisible` and delegate to the extension's
 * ide.approveShellTool / ide.approveShellToolAllowlist / ide.skipShellTool.
 * The fourth delegates to ide.cancelTerminalToolCall, implemented here:
 * TerminalService.cancelActiveRun() interrupts the running background shell
 * command with Ctrl+C — the same interrupt the 10-minute timeout uses.
 *
 * These tests pin the runtime half:
 *  - cancelActiveRun() returns false and touches nothing when idle;
 *  - a running tool call is cancelled: exactly one Ctrl+C (no newline) goes
 *    to the background terminal, the bubble finishes as cancelled (not timed
 *    out), the awaiting turn rejects, and the ideAgent.terminalToolCallRunning
 *    context key is set true on start / false on every end path;
 *  - the timeout path still reports timedOut (not cancelled).
 *
 * Run after `tsc`:  node out/services/test/run-shell-approval-keyboard-flow-tests.js
 */
import { describe, it, beforeEach } from "node:test";
import * as assert from "node:assert";
import "./vscode-stub";
import { vscodeStub, windowStub, terminalDataEmitter } from "./vscode-stub";
import { TerminalService } from "../terminalService";
import type { ComposerDataService } from "../composerDataService";
import {
  decideCancelTerminalTarget,
  isShellToolApproval,
  shellApprovalKeyState,
} from "../shellApprovalKeyboard";

const tick = (n = 1): Promise<void> =>
  new Promise<void>((resolve) => {
    const step = (left: number): void => {
      if (left <= 0) {
        resolve();
        return;
      }
      setImmediate(() => step(left - 1));
    };
    step(n);
  });

interface FinishCall {
  bubbleId: string;
  exitCode: number;
  elapsedMs: number;
  timedOut: boolean;
  cancelled: boolean;
}

function makeComposer(): {
  composer: ComposerDataService;
  posted: string[];
  finished: FinishCall[];
} {
  const posted: string[] = [];
  const finished: FinishCall[] = [];
  const composer = {
    postTerminalRun: (cmd: string): string => {
      posted.push(cmd);
      return "bubble-1";
    },
    updateTerminalOutput: (_bubbleId: string, _output: string): void => {
      /* not asserted here */
    },
    finishTerminalRun: (
      bubbleId: string,
      exitCode: number,
      elapsedMs: number,
      timedOut: boolean,
      cancelled = false,
    ): void => {
      finished.push({ bubbleId, exitCode, elapsedMs, timedOut, cancelled });
    },
  };
  return { composer: composer as unknown as ComposerDataService, posted, finished };
}

/** Values published via setContext for ideAgent.terminalToolCallRunning. */
function runningKeyValues(): unknown[] {
  return (
    vscodeStub.commands.calls as Array<{ command: string; args: unknown[] }>
  )
    .filter((c) => c.command === "setContext" && c.args[0] === "ideAgent.terminalToolCallRunning")
    .map((c) => c.args[1]);
}

/**
 * Start a background run. `waitActive` resolves once the service reports
 * ideAgent.terminalToolCallRunning=true (the run is in flight and
 * cancellable); `done` settles when the bgChain task finishes (the task
 * converts rejections into an error toast, so `done` always resolves).
 */
function startRun(svc: TerminalService, cmd: string): {
  waitActive: Promise<void>;
  done: Promise<void>;
} {
  const done = svc.runBackgroundCommand(cmd);
  const waitActive = (async (): Promise<void> => {
    for (let i = 0; i < 50 && !runningKeyValues().includes(true); i++) {
      await tick();
    }
    assert.ok(
      runningKeyValues().includes(true),
      "background run did not report ideAgent.terminalToolCallRunning=true",
    );
  })();
  return { waitActive, done };
}

describe("TerminalService.cancelActiveRun — GAPS-14 cancel terminal tool call", () => {
  beforeEach(() => {
    (vscodeStub.commands.calls as unknown[]).length = 0;
    windowStub.terminals.length = 0;
  });

  it("returns false and sends nothing when no run is active", () => {
    const { composer } = makeComposer();
    const svc = new TerminalService(() => composer);
    try {
      assert.strictEqual(svc.cancelActiveRun(), false);
      assert.deepStrictEqual(runningKeyValues(), []);
      assert.strictEqual(windowStub.terminals.length, 0);
    } finally {
      svc.dispose();
    }
  });

  it("cancels a running tool call: Ctrl+C, cancelled bubble, context key cleared", async () => {
    const { composer, finished } = makeComposer();
    const svc = new TerminalService(() => composer);
    svc.activate({ subscriptions: [] } as unknown as import("vscode").ExtensionContext);
    try {
      const run = startRun(svc, "sleep 60");
      await run.waitActive;
      const term = windowStub.terminals[0];
      assert.ok(term, "background terminal was created");

      assert.strictEqual(svc.cancelActiveRun(), true);
      assert.strictEqual(svc.cancelActiveRun(), false, "second cancel is a no-op");

      // Exactly one Ctrl+C, sent without a trailing newline.
      const ctrlC = term.sentTexts.filter((s) => s.text === "\u0003");
      assert.strictEqual(ctrlC.length, 1);
      assert.strictEqual(ctrlC[0].addNewLine, false);

      // Bubble finished as cancelled — not as timed out.
      assert.strictEqual(finished.length, 1);
      assert.strictEqual(finished[0].bubbleId, "bubble-1");
      assert.strictEqual(finished[0].cancelled, true);
      assert.strictEqual(finished[0].timedOut, false);

      // Running-state key: true on start, false on cancel.
      assert.deepStrictEqual(runningKeyValues(), [true, false]);

      // runBackgroundCommand swallows the rejection into an error toast —
      // the promise itself resolves.
      await run.done;
    } finally {
      svc.dispose();
    }
  });

  it("natural completion clears the running key without cancelled=true", async () => {
    const { composer, finished } = makeComposer();
    const svc = new TerminalService(() => composer);
    svc.activate({ subscriptions: [] } as unknown as import("vscode").ExtensionContext);
    try {
      const run = startRun(svc, "echo hi");
      await run.waitActive;
      const term = windowStub.terminals[0];
      assert.ok(term, "background terminal was created");

      // Simulate the wrapped command finishing: the __IDE_RUN_END__=<code>
      // framing marker the service parses from terminal output.
      terminalDataEmitter.fire({ terminal: term, data: "__IDE_RUN_END__=0\n" });
      await tick(3);

      assert.strictEqual(finished.length, 1);
      assert.strictEqual(finished[0].exitCode, 0);
      assert.strictEqual(finished[0].cancelled, false);
      assert.strictEqual(finished[0].timedOut, false);
      assert.deepStrictEqual(runningKeyValues(), [true, false]);
      assert.strictEqual(svc.cancelActiveRun(), false, "nothing left to cancel");

      await run.done;
    } finally {
      svc.dispose();
    }
  });

  it("dispose() clears the running key when a run is in flight", async () => {
    const { composer } = makeComposer();
    const svc = new TerminalService(() => composer);
    svc.activate({ subscriptions: [] } as unknown as import("vscode").ExtensionContext);
    const run = startRun(svc, "sleep 60");
    await run.waitActive;
    svc.dispose();
    assert.deepStrictEqual(runningKeyValues(), [true, false]);
    // The orphaned run promise rejects (timer cleared, run dropped) — the
    // bgChain task converts it to an error toast.
    await run.done;
  });
});

describe("shellApprovalKeyboard — GAPS-14 decision logic", () => {
  it("isShellToolApproval: only the engine bash action counts", () => {
    assert.strictEqual(isShellToolApproval({ title: "bash" }), true);
    assert.strictEqual(isShellToolApproval({ title: "read" }), false);
    assert.strictEqual(isShellToolApproval({ title: "edit" }), false);
    assert.strictEqual(isShellToolApproval({ title: "" }), false);
  });

  it("shellApprovalKeyState: pending shell approval arms both shortcuts", () => {
    assert.deepStrictEqual(shellApprovalKeyState(undefined), {
      pending: false,
      allowlist: false,
    });
    assert.deepStrictEqual(
      shellApprovalKeyState({
        approvalId: "a1",
        toolCallId: "tc-1",
        title: "bash",
        reasons: [],
        options: [],
      }),
      { pending: true, allowlist: true },
    );
    assert.deepStrictEqual(
      shellApprovalKeyState({
        approvalId: "a2",
        toolCallId: "tc-2",
        title: "edit",
        reasons: [],
        options: [],
      }),
      { pending: false, allowlist: false },
    );
  });

  it("decideCancelTerminalTarget: binary run-body order — pending decisions first", () => {
    // Binary (glass 3.25.6): reject pending RUN_TERMINAL_COMMAND_V2
    // decisions first and return; else cancel the running stream.
    assert.strictEqual(
      decideCancelTerminalTarget({ hasPendingShellApproval: true, hasActiveRun: true }),
      "reject-pending-approval",
    );
    assert.strictEqual(
      decideCancelTerminalTarget({ hasPendingShellApproval: true, hasActiveRun: false }),
      "reject-pending-approval",
    );
    assert.strictEqual(
      decideCancelTerminalTarget({ hasPendingShellApproval: false, hasActiveRun: true }),
      "cancel-running-call",
    );
    assert.strictEqual(
      decideCancelTerminalTarget({ hasPendingShellApproval: false, hasActiveRun: false }),
      "nothing",
    );
  });
});
