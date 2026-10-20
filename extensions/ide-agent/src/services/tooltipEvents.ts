import * as vscode from "vscode";

/**
 * GAPS-176 (queue entry #32, phần còn lại D2 của GAPS-170): extension-host
 * side of the tooltip-pipeline chat producers.
 *
 * The core tooltipService (workbench `contrib/composer`) consumes a global
 * event stream; the fork's chat lives in this extension (webview + hosts),
 * so chat events reach the core through the fork-local bridge command
 * `composer.tooltip.registerEvent` (registered in core
 * `browser/tooltipActions.ts` — the same bridge GAPS-170 already used for
 * `chat.submit` and `terminal.cmdk.submit`).
 *
 * Event names are NOT invented here: they are the verbatim names from
 * Cursor 3.25.9's pipeline configs (`tooltipPipelines.js`, desk@957248 —
 * see ide-code-mission work-notes-gaps170.md Slice 1 and
 * work-notes-gaps176.md Slice 1 for the per-event evidence, including
 * which binary producers are UNKNOWN).
 */

/** Fork-local bridge command id (registered in core tooltipActions.ts). */
export const TOOLTIP_REGISTER_EVENT_COMMAND = "composer.tooltip.registerEvent";

/**
 * Events the chat WEBVIEW is allowed to report. The webview posts
 * `{ type: "tooltipEvent", event }`; hosts forward ONLY these names, so a
 * webview message can never inject an arbitrary pipeline event (e.g. a
 * `*.cmdk.submit` disable event) into the core service.
 *
 * - `chat.type` — user typing in the chat input (webview gates on
 *   `isTrusted` + `inputType`, see components/composer.ts).
 * - `chat.paste` — a paste into the chat input (binary: chat editor paste
 *   handler, desk@24719855).
 * - `chat.copy.codeblock.manual` — manual copy with the selection inside a
 *   transcript codeblock (binary: clipboard handleCopy when
 *   `editor.isChatCodeblock`, desk@23596167).
 * - `chat.insert_selection.editor.non_empty` /
 *   `chat.insert_selection.terminal.empty` — a selection chip was actually
 *   inserted by the Add to Chat flow (see services/addToChat.ts for the
 *   source flag and work-notes-gaps176.md for the `.empty` UNKNOWN).
 */
export const WEBVIEW_TOOLTIP_EVENTS: ReadonlySet<string> = new Set([
  "chat.type",
  "chat.paste",
  "chat.copy.codeblock.manual",
  "chat.insert_selection.editor.non_empty",
  "chat.insert_selection.terminal.empty",
]);

/**
 * Fire-and-forget bridge call. A missing/failing bridge (core not loaded)
 * must NEVER break the chat flow, so sync throws and async rejections are
 * swallowed here — the tooltip pipeline is best-effort telemetry-shaped
 * state, exactly like the binary's 1 ms race in `registerEvent`.
 */
export function emitTooltipEvent(event: string): void {
  try {
    void Promise.resolve(
      vscode.commands.executeCommand(TOOLTIP_REGISTER_EVENT_COMMAND, event),
    ).catch(() => undefined);
  } catch {
    /* best-effort only */
  }
}

/**
 * Forward one webview-reported tooltip event if (and only if) it is on the
 * allowlist. Returns whether the event was forwarded, for tests.
 */
export function forwardWebviewTooltipEvent(event: unknown): boolean {
  if (typeof event !== "string" || !WEBVIEW_TOOLTIP_EVENTS.has(event)) {
    return false;
  }
  emitTooltipEvent(event);
  return true;
}
