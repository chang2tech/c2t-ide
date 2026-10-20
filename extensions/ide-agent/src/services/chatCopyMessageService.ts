import * as vscode from "vscode";
import type { ComposerDataService } from "./composerDataService";

/**
 * chatCopyMessageService — per-message "Copy Message" (Cursor parity).
 *
 * Binary evidence (Cursor 3.25.6, static grep, title recovery):
 *   message action `{label:'Copy Message',
 *     onSelect: clipboardService.writeText + trackEvent('composer.copy_message')
 *     + toast 'Message copied to clipboard'}`
 *
 * The three verbatim values — label, telemetry event name and toast text —
 * are preserved exactly:
 *  - LABEL = 'Copy Message' (webview hover button in the per-message
 *    action slot, components/composer.ts `bubbleEl`).
 *  - TELEMETRY_EVENT = 'composer.copy_message' — logged to the "IDE Agent"
 *    output channel as `[telemetry] composer.copy_message`, the fork's
 *    established convention for binary trackEvent calls (no analytics
 *    backend exists; see `newAgent`'s telemetry channel).
 *  - TOAST = 'Message copied to clipboard'.
 *
 * What is copied: the bubble's RAW MARKDOWN source (`BubbleData.text` is
 * the chunked-streamed markdown source) — the matrix dev note says copy
 * the markdown, not the rendered plain text.
 */
export const COPY_MESSAGE_LABEL = "Copy Message";
export const COPY_MESSAGE_TELEMETRY_EVENT = "composer.copy_message";
export const COPY_MESSAGE_TOAST = "Message copied to clipboard";

/** Seam over the host APIs so node:test can inject stubs. */
export interface ChatCopyMessageSeam {
  writeClipboardText(text: string): Promise<void> | Thenable<void>;
  showInformationMessage(message: string): void;
  trackEvent(eventName: string): void;
}

/** Thrown when the bubble cannot be resolved — keeps the flow total. */
export class CopyMessageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CopyMessageError";
  }
}

/**
 * Copy one chat message to the clipboard (Cursor
 * `composer.copy_message` parity). Resolves the bubble by id from the
 * composer's store, copies its raw markdown source, fires the binary's
 * telemetry event and shows the verbatim toast.
 *
 * Returns true when the copy happened; false when the bubble is unknown
 * or has no text (in which case an informational message tells the user
 * what happened — Cursor shows no equivalent, but silently dropping a
 * click is worse).
 */
export async function copyBubbleMessageToClipboard(
  composer: ComposerDataService,
  bubbleId: string,
  seam: ChatCopyMessageSeam,
): Promise<boolean> {
  const bubble = composer.bubbles.getBubbleData(bubbleId);
  const text = bubble?.text ?? "";
  if (text.length === 0) {
    void seam.showInformationMessage(
      "IDE Agent: that message has no text to copy.",
    );
    return false;
  }
  try {
    await seam.writeClipboardText(text);
  } catch (err) {
    const m = err instanceof Error ? err.message : String(err);
    void seam.showInformationMessage(
      `IDE Agent: could not copy the message — ${m}`,
    );
    return false;
  }
  seam.trackEvent(COPY_MESSAGE_TELEMETRY_EVENT);
  void seam.showInformationMessage(COPY_MESSAGE_TOAST);
  return true;
}

let copyMessageTelemetryChannel: vscode.OutputChannel | undefined;

/**
 * Production telemetry sink: the fork logs binary trackEvent payloads to
 * the "IDE Agent" output channel (see `newAgentTelemetryChannel` in
 * extension.ts for the same convention) — inspectable, no fake backend.
 */
export function trackCopyMessageEvent(): void {
  if (!copyMessageTelemetryChannel) {
    copyMessageTelemetryChannel = vscode.window.createOutputChannel("IDE Agent");
  }
  copyMessageTelemetryChannel.appendLine(`[telemetry] ${COPY_MESSAGE_TELEMETRY_EVENT}`);
}

/**
 * Production seam for the two chat surfaces (sidebar chat view and the
 * chat editor tab). The caller binds the composer + bubbleId.
 */
export function makeCopyMessageSeam(): ChatCopyMessageSeam {
  return {
    writeClipboardText: (text: string) => vscode.env.clipboard.writeText(text),
    showInformationMessage: (message: string) => {
      void vscode.window.showInformationMessage(message);
    },
    trackEvent: () => {
      trackCopyMessageEvent();
    },
  };
}
