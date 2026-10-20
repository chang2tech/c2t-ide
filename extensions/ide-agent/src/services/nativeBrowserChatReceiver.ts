/**
 * DEV-GAPS-55: receiver for the native browser → IDE Agent chat bridge.
 *
 * The fork's native Integrated Browser (WebContentsView tab) forwards chat
 * attachments via the `ide.browserAttachToChat` command (sender:
 * `browserEditorChatFeatures.ts`, `toIdeBrowserChatAttachment` — the single
 * source of truth for the kind set). This module is the pure, vscode-free
 * dispatch logic for those payloads so it can be unit-tested in node:test.
 * The real host wiring (chat host, captures dir, composer) lives in
 * extension.ts, which calls `dispatchNativeBrowserChatAttachment`.
 *
 * Attachment kinds and their receiver semantics:
 *  - element / screenshot / areaScreenshot / fullPageScreenshot / consoleLogs:
 *    pre-existing kinds — image chips and selection-context chips.
 *  - voiceInput: Design Mode mic transcript (entry id
 *    `browser-voice-input-*`, kind 'generic', value = transcript string).
 *    REA spec (design-mode-voice): "Mic stays available during agent runs;
 *    queue changes by voice" — while a turn runs (or the drain window is
 *    open) the transcript is queued behind the in-flight request; when idle
 *    it is submitted as a normal user message immediately — exactly the
 *    workbench `queueVoiceTranscript` semantics (isVoiceInput + Queued).
 *    `preserveFocus`: the sender never yanks focus away from the browser,
 *    and the extension host must not either (see extension.ts focus logic).
 *  - designAnnotation: annotated PNG from Design Mode drawing (entry id
 *    `browser-design-annotation-*`, kind 'image', value = PNG bytes) →
 *    attached as an image chip. The region list travels as a companion
 *    generic entry (`browser-design-annotation-text-*`), which the sender
 *    maps to kind 'element' — it lands as text context through the element
 *    path below.
 */

/** Mirrors IIdeBrowserChatAttachment['kind'] in browserEditorChatFeatures.ts. */
export const NATIVE_BROWSER_CHAT_ATTACHMENT_KINDS = [
  "element",
  "screenshot",
  "areaScreenshot",
  "fullPageScreenshot",
  "consoleLogs",
  "voiceInput",
  "designAnnotation",
] as const;

export type NativeBrowserChatAttachmentKind =
  (typeof NATIVE_BROWSER_CHAT_ATTACHMENT_KINDS)[number];

/** JSON-serializable payload the `ide.browserAttachToChat` command receives. */
export interface NativeBrowserChatAttachment {
  kind: NativeBrowserChatAttachmentKind;
  name: string;
  text: string;
  imageBase64?: string;
  imageMimeType?: string;
  url?: string;
}

/** Host-side dependencies the dispatch logic needs; supplied by extension.ts. */
export interface NativeBrowserChatReceiverDeps {
  /** Post a selection-context chip (`addSelectionContext` webview message). */
  postSelectionContext(label: string, content: string): void;
  /**
   * Persist base64 PNG bytes and post an image-context chip
   * (`addImageContext` webview message), like the webview-tab screenshot flow.
   */
  saveBrowserImage(imageBase64: string, label: string): void;
  /**
   * True while the active composer has a turn running or is draining
   * follow-up turns (a drain must be treated like a running turn — a submit
   * landing in the drain window must not start a concurrent runTurn).
   */
  isAgentTurnActive(): boolean;
  /**
   * Submit a user message on the active composer. `queue: true` → sendMode
   * "queue" (queued behind the in-flight turn); `queue: false` → sendMode
   * "default" (starts a turn immediately when idle).
   */
  submitPrompt(text: string, opts: { queue: boolean }): void;
}

/**
 * Dispatch one native-browser chat attachment payload. Unknown or malformed
 * payloads are ignored (the sender and the extension version can drift).
 */
export function dispatchNativeBrowserChatAttachment(
  deps: NativeBrowserChatReceiverDeps,
  payload: NativeBrowserChatAttachment | null | undefined,
): void {
  if (!payload || typeof payload.kind !== "string") {
    return;
  }
  const label = payload.name || "Browser attachment";
  switch (payload.kind) {
    case "element":
      deps.postSelectionContext(`Element: ${label}`, payload.text || "");
      if (payload.imageBase64) {
        deps.saveBrowserImage(payload.imageBase64, `Element screenshot: ${label}`);
      }
      break;
    case "screenshot":
    case "areaScreenshot":
    case "fullPageScreenshot":
      if (payload.imageBase64) {
        deps.saveBrowserImage(payload.imageBase64, label);
      }
      break;
    case "consoleLogs":
      deps.postSelectionContext("Console Logs", payload.text || "");
      break;
    case "voiceInput": {
      // DEV-GAPS-55: transcript arrives as typed text. Queue while the agent
      // runs; send immediately when idle. Never focuses the chat surface —
      // the user is mid-dictation in the browser (preserveFocus).
      const transcript = (payload.text || "").trim();
      if (transcript) {
        deps.submitPrompt(transcript, { queue: deps.isAgentTurnActive() });
      }
      break;
    }
    case "designAnnotation":
      // DEV-GAPS-55: annotated PNG → image chip. The region list arrives as
      // a companion 'element' payload and lands as text context there.
      if (payload.imageBase64) {
        deps.saveBrowserImage(payload.imageBase64, label);
      } else if (payload.text) {
        deps.postSelectionContext(label, payload.text);
      }
      break;
    default:
      // Forward-compatible: ignore kinds a newer sender may introduce.
      break;
  }
}
