/**
 * DEV-GAPS-12 (agent-shell-approval-keyboard-flow) tests — node:test with
 * the local vscode stub.
 *
 * Guards Cursor parity (workbench.glass.main.js 3.25.9 class registrations +
 * keybindingService.softDispatch match; dissect-ai-agent.md §5):
 *  1. Keybinding map: Enter -> approvePendingShellToolDecision (run),
 *     Shift+Enter -> approvePendingShellToolDecisionAllowlist,
 *     Escape -> skipPendingShellToolDecision, Shift+Backspace ->
 *     cancelTerminalToolCall. Command ids are Cursor's verbatim `composer.*`
 *     ids.
 *  2. Shell-approval detection: only the `bash` engine action counts as a
 *     shell-tool approval (Cursor's RUN_TERMINAL_COMMAND_V2).
 *  3. Allowlist persists PER COMMAND: the allowlist key is the stable tool
 *     identity (action + command text), never the per-request toolCallId —
 *     a second, different toolCallId for the same command auto-resolves,
 *     while a different command still prompts.
 *  4. cancelTerminalToolCall runtime: rejecting a pending shell approval
 *     resolves it as skip (engine sees "reject"); cancelling a running
 *     terminal tool call sends Ctrl+C, marks the bubble cancelled and
 *     rejects the awaiting turn.
 *
 * Run after `tsc`:
 *   node --test out/services/test/run-shell-approval-keyboard-tests.js
 */
import { describe, it, before } from "node:test";
import * as assert from "node:assert";
import "./vscode-stub";
import { vscodeStub } from "./vscode-stub";
import {
  SHELL_TOOL_ACTION,
  SHELL_APPROVAL_KEYBINDINGS,
  isShellToolApproval,
  shellDecisionToOptionId,
  shellApprovalKeyState,
} from "../shellApprovalKeyboard";
import { HumanReviewService } from "../humanReviewService";
import { TerminalService } from "../terminalService";

/* ------------------------------------------------------------------ */
/* 1. Keybinding -> command map (binary-verbatim)                      */
/* ------------------------------------------------------------------ */

describe("shell-approval keyboard map", () => {
  it("maps exactly the four Cursor keybindings to the four composer.* commands", () => {
    const expected: Array<[string, string]> = [
      ["Enter", "composer.approvePendingShellToolDecision"],
      ["Shift+Enter", "composer.approvePendingShellToolDecisionAllowlist"],
      ["Escape", "composer.skipPendingShellToolDecision"],
      ["Shift+Backspace", "composer.cancelTerminalToolCall"],
    ];
    assert.strictEqual(SHELL_APPROVAL_KEYBINDINGS.length, expected.length);
    for (const [key, command] of expected) {
      const entry = SHELL_APPROVAL_KEYBINDINGS.find((e) => e.key === key);
      assert.ok(entry, `missing keybinding for ${key}`);
      assert.strictEqual(entry.command, command);
    }
  });

  it("decisions map to the approval-card option ids", () => {
    assert.strictEqual(shellDecisionToOptionId("run"), "approve-once");
    assert.strictEqual(shellDecisionToOptionId("allowlist"), "approve-allowlist");
    assert.strictEqual(shellDecisionToOptionId("skip"), "skip");
  });
});

/* ------------------------------------------------------------------ */
/* 2. Shell-approval detection                                         */
/* ------------------------------------------------------------------ */

describe("isShellToolApproval", () => {
  it("treats the bash engine action as the shell tool", () => {
    assert.strictEqual(SHELL_TOOL_ACTION, "bash");
    assert.ok(isShellToolApproval({ title: "bash" }));
  });

  it("rejects non-shell approvals", () => {
    for (const title of ["edit", "read", "write", "glob", "mcp__server__tool"]) {
      assert.ok(!isShellToolApproval({ title }), title);
    }
  });

  it("shellApprovalKeyState is only live for pending shell approvals", () => {
    assert.deepStrictEqual(shellApprovalKeyState(undefined), {
      pending: false,
      allowlist: false,
    });
    assert.deepStrictEqual(
      shellApprovalKeyState({ title: "edit" } as never),
      { pending: false, allowlist: false },
    );
    assert.deepStrictEqual(
      shellApprovalKeyState({ title: "bash" } as never),
      { pending: true, allowlist: true },
    );
  });
});

/* ------------------------------------------------------------------ */
/* 3. Allowlist persists per command (stable identity, not toolCallId) */
/* ------------------------------------------------------------------ */

describe("shell approval allowlist is per-command", () => {
  it("a second toolCallId for the same command auto-resolves", async () => {
    const reviews = new HumanReviewService();
    const p1 = reviews.requestApproval(
      "tc-first",
      "bash",
      ["run npm test"],
      60_000,
      undefined,
      "bash::npm test",
    );
    const req = reviews.currentApproval;
    assert.ok(req, "expected a pending approval card");
    reviews.resolveApproval(req.approvalId, { optionId: "approve-allowlist" });
    const first = await p1;
    assert.deepStrictEqual(first, { optionId: "approve-allowlist" });

    // Same command, brand-new toolCallId: no card, auto approve-once.
    const second = await reviews.requestApproval(
      "tc-second",
      "bash",
      ["run npm test"],
      60_000,
      undefined,
      "bash::npm test",
    );
    assert.deepStrictEqual(second, { optionId: "approve-once" });
    assert.strictEqual(reviews.pendingCount(), 0);
  });

  it("a different command still prompts", async () => {
    const reviews = new HumanReviewService();
    const p1 = reviews.requestApproval(
      "tc-a",
      "bash",
      ["run npm test"],
      60_000,
      undefined,
      "bash::npm test",
    );
    reviews.resolveApproval(reviews.currentApproval!.approvalId, {
      optionId: "approve-allowlist",
    });
    await p1;

    let prompted = false;
    const p2 = reviews.requestApproval(
      "tc-b",
      "bash",
      ["run npm run build"],
      60_000,
      undefined,
      "bash::npm run build",
    );
    // A pending card means the allowlist did NOT cover this command.
    prompted = reviews.pendingCount() === 1;
    assert.ok(prompted, "different command must still prompt");
    reviews.resolveApproval(reviews.currentApproval!.approvalId, {
      optionId: "skip",
    });
    const decision = await p2;
    assert.deepStrictEqual(decision, { optionId: "skip" });
  });

  it("skip does not allowlist", async () => {
    const reviews = new HumanReviewService();
    const p1 = reviews.requestApproval(
      "tc-x",
      "bash",
      ["run npm test"],
      60_000,
      undefined,
      "bash::npm test",
    );
    reviews.resolveApproval(reviews.currentApproval!.approvalId, {
      optionId: "skip",
    });
    await p1;
    assert.ok(!reviews.isAllowlisted("bash::npm test"));
  });
});

/* ------------------------------------------------------------------ */
/* 4. cancelTerminalToolCall runtime                                    */
/* ------------------------------------------------------------------ */

describe("cancelTerminalToolCall runtime", () => {
  // Fake vscode terminal + composer, installed before the tests run.
  const sentText: string[] = [];
  const composerCalls: Array<{ method: string; args: unknown[] }> = [];
  const fakeComposer = {
    postTerminalRun: (cmd: string) => {
      composerCalls.push({ method: "postTerminalRun", args: [cmd] });
      return "bubble-1";
    },
    updateTerminalOutput: (bubbleId: string, text: string) => {
      composerCalls.push({ method: "updateTerminalOutput", args: [bubbleId, text] });
    },
    finishTerminalRun: (
      bubbleId: string,
      exitCode: number,
      elapsedMs: number,
      timedOut: boolean,
      cancelled: boolean,
    ) => {
      composerCalls.push({
        method: "finishTerminalRun",
        args: [bubbleId, exitCode, elapsedMs, timedOut, cancelled],
      });
    },
  };
  const fakeTerminal = {
    creationOptions: { shellPath: "/bin/bash" },
    sendText: (text: string) => {
      sentText.push(text);
    },
  };

  before(() => {
    const w = vscodeStub.window as unknown as Record<string, unknown>;
    w.createTerminal = () => fakeTerminal;
    w.onDidWriteTerminalData = () => ({ dispose: () => undefined });
    w.onDidCloseTerminal = () => ({ dispose: () => undefined });
  });

  it("cancelActiveRun returns false when nothing is running", () => {
    const terminal = new TerminalService(() => fakeComposer as never);
    assert.strictEqual(terminal.cancelActiveRun(), false);
  });

  it("cancelActiveRun interrupts the run: Ctrl+C, bubble cancelled, turn rejected", async () => {
    sentText.length = 0;
    composerCalls.length = 0;
    const terminal = new TerminalService(() => fakeComposer as never);
    // Drive execInBackground directly: runBackgroundCommand() catches the
    // rejection internally (showing an error message), while the raw promise
    // is what the awaiting agent turn observes.
    const raw = (
      terminal as unknown as {
        execInBackground(cmd: string): Promise<void>;
      }
    ).execInBackground("npm test");

    assert.strictEqual(terminal.cancelActiveRun(), true);
    // Ctrl+C (U+0003) went to the terminal.
    assert.ok(
      sentText.some((t) => t.includes("\u0003")),
      `expected Ctrl+C in sent text: ${JSON.stringify(sentText)}`,
    );
    // Bubble marked cancelled (not timed out).
    const finish = composerCalls.find((c) => c.method === "finishTerminalRun");
    assert.ok(finish, "expected finishTerminalRun");
    assert.strictEqual(finish.args[3], false, "timedOut must be false");
    assert.strictEqual(finish.args[4], true, "cancelled must be true");
    // The awaiting turn observes the cancellation.
    await assert.rejects(raw, /cancelled by user/);
    // setContext tracked the running state transitions.
    const setContextCalls = (
      vscodeStub.commands.calls as Array<{ command: string; args: unknown[] }>
    ).filter((c) => c.command === "setContext" && c.args[0] === "ideAgent.terminalToolCallRunning");
    assert.ok(
      setContextCalls.some((c) => c.args[1] === true),
      "expected terminalToolCallRunning=true on run start",
    );
    assert.ok(
      setContextCalls.some((c) => c.args[1] === false),
      "expected terminalToolCallRunning=false after cancel",
    );
  });

  it("rejecting a pending shell approval resolves it as skip", async () => {
    const reviews = new HumanReviewService();
    const p = reviews.requestApproval(
      "tc-shell-1",
      "bash",
      ["run npm test"],
      60_000,
      undefined,
      "bash::npm test",
    );
    // The ide.cancelTerminalToolCall handler's pending-decision branch:
    const pendingShell = reviews
      .getPendingApprovals()
      .filter(isShellToolApproval);
    assert.strictEqual(pendingShell.length, 1);
    for (const req of pendingShell) {
      reviews.resolveApproval(req.approvalId, { optionId: "skip" });
    }
    const decision = await p;
    assert.deepStrictEqual(decision, { optionId: "skip" });
    // Non-shell approvals are untouched by the cancel path.
    const p2 = reviews.requestApproval("tc-edit-1", "edit", ["edit a.ts"], 60_000);
    assert.strictEqual(
      reviews.getPendingApprovals().filter(isShellToolApproval).length,
      0,
    );
    reviews.resolveApproval(reviews.currentApproval!.approvalId, { optionId: "skip" });
    await p2;
  });
});
