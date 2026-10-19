import { BubbleData, ToolCallStatus } from "../model";

/**
 * Bubble view-model helpers (components tier).
 * The webview script owns live rendering with per-bubble DOM patching;
 * these helpers carry shared labels so both sides speak the same
 * view-model language.
 *
 * NOTE (issue 1, QA-FILE-02): bubbleHtml/toolCallCardHtml were deleted —
 * they were dead code never imported by the live renderer, and
 * toolCallCardHtml interpolated data-status unescaped (latent XSS).
 * The webview builds tool-call cards in composer.ts with escaping.
 *
 * Accessibility: all first-paint HTML carries ARIA semantics (roles,
 * labels, expanded states). The webview script (composer.ts) must keep
 * aria-expanded in sync when toggling tool-call cards at runtime.
 */

/** User-visible role labels — consistent title case (QA-02 P2 fix). */
export function roleLabel(role: BubbleData["role"]): string {
  switch (role) {
    case "human":
      return "You";
    case "assistant":
      return "IDE Agent";
    case "tool":
      return "Tool";
    case "system":
      return "System";
  }
}

/** User-visible status labels. Issue 7 (QA-FILE-02): unknown statuses get a
 * safe fallback instead of falling off the switch. */
export function statusLabel(status: ToolCallStatus): string {
  switch (status) {
    case "pending":
      return "pending";
    case "running":
      return "running";
    case "done":
      return "done";
    case "failed":
      return "failed";
    default:
      return "unknown";
  }
}

/** First-paint welcome bubble, rendered extension-side. */
export function welcomeBubbleHtml(): string {
  // SETTINGS-PARITY (ide.composer.showEmptyStateTips, mirrors
  // cursor.composer.showEmptyStateTips): rotating tips on the empty screen.
  // The webview hides the whole block via body.no-tips when disabled.
  const tips = [
    "Tip: press @ to attach files, folders, or terminal output as context.",
    "Tip: type / to see slash commands like /worktree and /summarize.",
    "Tip: Alt+Enter queues a message while the agent is working; Cmd+Enter stops it and sends immediately.",
    "Tip: hover any of your messages to restore the workspace to that checkpoint.",
    "Tip: press Ctrl+P in the chat input to pick a file without typing @.",
  ];
  const tip = tips[new Date().getDate() % tips.length];
  return `<div class="msg assistant" data-bubble="welcome" role="article" aria-label="Message from IDE Agent">
    <div class="role" aria-hidden="true">IDE Agent</div>
    <div class="bubble-text">Welcome to IDE Agent. Pick a mode, attach context with @, run a slash command with /, then Send. Turns run against a scripted demo engine until the IDE Code engine is connected.</div>
    <div class="empty-tips"><div class="tip-label">Did you know?</div><div>${tip}</div></div>
    <div class="tool-calls"></div>
  </div>`;
}
