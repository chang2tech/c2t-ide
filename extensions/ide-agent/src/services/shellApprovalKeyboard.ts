import type { ApprovalRequest } from "./humanReviewService";

/**
 * DEV-GAPS-12 (agent-shell-approval-keyboard-flow) — shell-tool approval
 * keyboard flow, Cursor parity.
 *
 * Binary evidence (workbench.glass.main.js 3.25.9, Cursor's own ids):
 *   - `composer.approvePendingShellToolDecision` — "Approve pending shell
 *     tool (run)", f1, keybinding Enter, weight 600,
 *     when `!isGlass && composerShellToolPendingKeybindingsActive`
 *   - `composer.approvePendingShellToolDecisionAllowlist` — "Approve pending
 *     shell tool and allowlist", f1, keybinding Shift+Enter, weight 600,
 *     when `!isGlass && composerShellToolAllowlistShortcutActive`
 *   - `composer.skipPendingShellToolDecision` — "Skip pending shell tool",
 *     f1, keybinding Escape, weight 600,
 *     when `!isGlass && composerShellToolPendingKeybindingsActive`
 *   - `composer.cancelTerminalToolCall` — "Cancel Terminal Tool Call",
 *     keybinding Shift+Backspace, weight 600,
 *     when `composerFocused || focusedView =~ /^workbench.panel.aichat.view/`
 *   - Notification-card focus model: the focused prompt input's keydown
 *     handler runs `keybindingService.softDispatch(event, target)` and, when
 *     Enter resolves to one of the three decision commands, suppresses the
 *     default Enter behavior so the keybinding approves instead of
 *     submitting. The card defers to the keybinding service rather than
 *     hard-coding Enter, so user keybinding customizations are respected.
 *
 * The workbench-core side (src/vs/workbench/contrib/composer/browser/
 * composerActions.ts) owns the keybindings, like Cursor; this module is the
 * extension-host half — pure, testable decision logic shared by the
 * `ide.approveShellTool` / `ide.approveShellToolAllowlist` /
 * `ide.skipShellTool` / `ide.cancelTerminalToolCall` command handlers.
 */

/**
 * Engine tool id for shell commands. The engine adapter's TOOL_NAME_MAP maps
 * `bash` -> `shell_tool_call` for the UI cards; the approval request title
 * carries the raw engine action (`bash`). This is the stable identity of a
 * shell-tool approval — Cursor's RUN_TERMINAL_COMMAND_V2 equivalent.
 */
export const SHELL_TOOL_ACTION = "bash";

/** True when a pending approval is for a shell tool call. */
export function isShellToolApproval(
  request: Pick<ApprovalRequest, "title">,
): boolean {
  return request.title === SHELL_TOOL_ACTION;
}

export type ShellApprovalDecision = "run" | "allowlist" | "skip" | "cancel";

/**
 * Binary-verbatim keyboard map: key label -> workbench-core command id.
 * Asserted by run-shell-approval-keyboard-tests.ts.
 */
export const SHELL_APPROVAL_KEYBINDINGS: ReadonlyArray<{
  /** Human-readable key label, matching Cursor's keybinding inventory. */
  key: string;
  /** Workbench-core command id (Cursor's own `composer.*` ids). */
  command: string;
  decision: ShellApprovalDecision;
}> = [
  {
    key: "Enter",
    command: "composer.approvePendingShellToolDecision",
    decision: "run",
  },
  {
    key: "Shift+Enter",
    command: "composer.approvePendingShellToolDecisionAllowlist",
    decision: "allowlist",
  },
  {
    key: "Escape",
    command: "composer.skipPendingShellToolDecision",
    decision: "skip",
  },
  {
    key: "Shift+Backspace",
    command: "composer.cancelTerminalToolCall",
    decision: "cancel",
  },
];

/**
 * Map a keyboard-flow decision to the HumanReviewService option id.
 * Cursor's terminal review options are RUN/SKIP/ALLOWLIST_COMMANDS; our
 * approval cards use approve-once / approve-allowlist / skip.
 */
export function shellDecisionToOptionId(
  decision: "run" | "allowlist" | "skip",
): "approve-once" | "approve-allowlist" | "skip" {
  switch (decision) {
    case "run":
      return "approve-once";
    case "allowlist":
      return "approve-allowlist";
    case "skip":
      return "skip";
  }
}

/**
 * Context-key state for the shell-approval keyboard flow, derived from the
 * active tab's current approval request.
 *
 * Cursor computes `composerShellToolPendingKeybindingsActive` per composer
 * (V1v selector): a blocking pending user decision whose bubble review model
 * is in REQUESTED status for the terminal tool. Our approvals are inherently
 * blocking (the turn awaits the promise) and single-card, so pending =
 * current approval exists and is a shell-tool approval.
 *
 * `composerShellToolAllowlistShortcutActive` additionally requires
 * non-empty `candidatesForAllowlist` and no full-auto-run. For a terminal
 * tool the command itself is always a candidate, and an allowlisted identity
 * never shows a card (requestApproval auto-resolves), so a pending shell
 * approval implies the allowlist shortcut is available.
 */
export function shellApprovalKeyState(
  request: ApprovalRequest | undefined,
): { pending: boolean; allowlist: boolean } {
  const pending = request !== undefined && isShellToolApproval(request);
  return { pending, allowlist: pending };
}

/**
 * What `composer.cancelTerminalToolCall` (Shift+Backspace) should do, in
 * Cursor's binary run-body order (glass bundle 3.25.6, verified
 * 2026-10-20): reject pending RUN_TERMINAL_COMMAND_V2 decisions FIRST and
 * return; else cancel the running terminal stream.
 *
 * Pure so the order is unit-testable; the `ide.cancelTerminalToolCall`
 * handler in extension.ts applies the decision.
 */
export type CancelTerminalTarget =
  | "reject-pending-approval"
  | "cancel-running-call"
  | "nothing";

export function decideCancelTerminalTarget(opts: {
  /** A shell-tool approval card is currently pending. */
  hasPendingShellApproval: boolean;
  /** A terminal tool call is currently running. */
  hasActiveRun: boolean;
}): CancelTerminalTarget {
  if (opts.hasPendingShellApproval) {
    return "reject-pending-approval";
  }
  if (opts.hasActiveRun) {
    return "cancel-running-call";
  }
  return "nothing";
}
