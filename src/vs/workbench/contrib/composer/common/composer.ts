// IDE-CODE: Migrated from extensions/ide-agent/src/components/composer.ts (CAT-A, pure logic).
import { BubbleData, ModeName } from "./model.js";
import { MODES, DROPDOWN_MODES, modeDef } from "./modeService.js";
import { welcomeBubbleHtml } from "./bubble.js";

/**
 * createComposer — factory building the chat webview (components tier).
 *
 * The renderer implements Cursor's fine-grained store pattern in vanilla JS:
 * a Map keyed by bubbleId with per-bubble DOM patching — no full transcript
 * re-render, no single immutable transcript array. Extension → webview deltas
 * arrive as {type:'bubbles'} / {type:'state'} messages.
 */

function getNonce(): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let nonce = "";
  for (let i = 0; i < 32; i++) {
    nonce += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return nonce;
}

/** M-03: HTML-escape for the TS-side factory (the webview's own esc() lives inside its script scope). */
function escHtml(s: string): string {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Chat UI settings snapshot (mirrors IdeChatUiConfig in extension.ts). */
export interface ComposerUiConfig {
  textSizeScale: number;
  conversationDensity: "compact-all-grouped" | "compact-ungrouped" | "detailed";
  codeBlockWordWrap: boolean;
  showEmptyStateTips: boolean;
  fontSmoothingAntialiased: boolean;
  cmdPFilePicker: boolean;
}

/** DD-CM-2/6 (Cursor 3.25.9 — live CDP + bundle static analysis):
    Cursor morphs the slot empty→voice, text→send, running→stop.
    HONEST DIVERGENCE (2026-10-20): our empty-composer slot shows Cursor's
    voice-chat ENTRY (mic icon, aria-label "Start voice chat",
    data-state="active") — the label/morph is verbatim — but clicking it is
    a deliberate no-op. There is no voice infrastructure in this build: the
    Web Speech API's recognition service is unavailable in Electron
    webviews (tied to the browser vendor's cloud, not to Chromium, and
    Electron ships no speech API key), and this build bundles no mic capture
    or local speech-to-text engine, so a voice button could never work.
    Zero-placeholder policy: no fake "voice unavailable" toast, no promise
    of voice — the entry is present for parity, the click does nothing.
    States:
      - empty composer → voice-chat entry: mic icon,
        aria-label "Start voice chat" (data-state="active"; the button is
        NOT disabled, matching Cursor's observed DOM — click is a no-op)
      - text present   → 12px filled arrow-up (data-state="active",
        aria-label "Send message")
      - turn running   → 20px stop-circle ("xl" icon size, icon component
        kind:"stop", data-state="stop", aria-label "Stop generation")
    All inline SVG (never emoji). The same constants are baked into the
    webview script via JSON.stringify so the morph reuses identical markup
    instead of duplicating the paths. */
const SUBMIT_ICON_SEND =
  '<svg viewBox="0 0 12 12" fill="currentColor" aria-hidden="true"><path d="M6 1.2 10.8 6H7.6v4.8H4.4V6H1.2Z"/></svg>';
const SUBMIT_ICON_VOICE =
  '<svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><rect x="6.2" y="1.5" width="3.6" height="7" rx="1.8" fill="currentColor"/><path d="M4 7a4 4 0 0 0 8 0" stroke="currentColor" stroke-width="1.5"/><path d="M8 11v2.2M5.6 14.2h4.8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>';
/** DD-CM-3 (live CDP, Cursor 3.25.9): the "+" button that opens the unified
    "Add agents, context, tools" menu is a plain plus glyph. */
const ADD_ICON_PLUS =
  '<svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M8 3v10M3 8h10" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>';
const SUBMIT_ICON_STOP =
  '<svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="10" cy="10" r="8" fill="none" stroke="currentColor" stroke-width="2"/><rect x="7" y="7" width="6" height="6" fill="currentColor"/></svg>';

/** DD-CM-4 (live CDP, Cursor 3.25.9): the composer placeholder is a constant
    verbatim string — NOT per-mode. */
const CURSOR_PLACEHOLDER = "Plan, Build, / for skills, @ for context";

const DEFAULT_UI_CONFIG: ComposerUiConfig = {
  textSizeScale: 1,
  conversationDensity: "compact-all-grouped",
  codeBlockWordWrap: false,
  showEmptyStateTips: true,
  fontSmoothingAntialiased: true,
  cmdPFilePicker: true,
};

/** Minimal host-side webview surface (replaces the vscode.Webview type). */
export interface IComposerWebview {
	postMessage(message: unknown): void;
}

/**
 * GAPS-48B — `showMicWhileRunning` decision (Cursor 3.25.9 parity).
 *
 * Exact port of `bmC` from the binary's `voice-toolbar-follow-up-while-running.js`
 * module (workbench.glass.main.js @ byte 29760461, re-verified 2026-10-20):
 * ```
 * function bmC(t){return t.forceMicWhileRunning===!0||t.composerUnifiedMode==="multitask"?!0:t.queueDefaultBehavior==="queue"||t.queueDefaultBehavior==="send"||t.queueDefaultBehavior==="steer"}
 * ```
 * The result feeds the follow-up-while-running voice toolbar as
 * `showMicWhileRunning:Vf` (call site @ ~29846937, prop @ ~29865328):
 * in multitask mode the follow-up-while-running input ALWAYS shows the
 * voice toolbar (mic) instead of the queue/send/steer message buttons.
 *
 * Fork mapping:
 * - `composerUnifiedMode` → the composer unified mode ("multitask" included);
 *   VERIFIED present (modeService.ts unifiedMode enum).
 * - `forceMicWhileRunning` → NO fork equivalent (0 hits in tree, verified
 *   2026-10-20) → treated as false. Marked UNKNOWN: do not invent a setting.
 * - `queueDefaultBehavior` → NO fork equivalent (0 hits in tree, verified
 *   2026-10-20) → treated as unset, so the else-branch is false — which
 *   matches Cursor's own behavior when the setting is unset.
 *
 * Body is intentionally ES5-only: the compiled source is injected verbatim
 * into the webview script via `shouldShowMicWhileRunning.toString()`, so
 * this is the single source of truth for both the TS unit tests and the
 * webview runtime.
 */
export function shouldShowMicWhileRunning(opts: {
	forceMicWhileRunning?: boolean;
	composerUnifiedMode?: string;
	queueDefaultBehavior?: string;
}): boolean {
	if (opts.forceMicWhileRunning === true || opts.composerUnifiedMode === "multitask") {
		return true;
	}
	return opts.queueDefaultBehavior === "queue" ||
		opts.queueDefaultBehavior === "send" ||
		opts.queueDefaultBehavior === "steer";
}

export function createComposer(
  webview: IComposerWebview,
  initialMode: ModeName,
  engineConnected: boolean,
  uiLang: string = "en",
  dir: "ltr" | "rtl" = "ltr",
  /* M-03 (model picker): label baked at render time (escaped); post-render
     changes arrive via {type:'model'} and use textContent (XSS-safe). */
  modelLabel: string = "auto",
  /* SETTINGS-PARITY: chat UI settings baked at render; live changes arrive
     via {type:'uiConfig'}. */
  ui: ComposerUiConfig = DEFAULT_UI_CONFIG,
): string {
  const nonce = getNonce();
  const uiJson = JSON.stringify({ ...DEFAULT_UI_CONFIG, ...ui }).replace(/</g, "\\u003c");
  /* P2 (CX2b): the engine-status hint is baked from the real connection
     state at render time — a permanently static "not connected" hint was
     factually wrong whenever the sidecar engine was live. Post-render
     changes are announced via {type:'engineStatus'} (see below). */
  const engineHintHtml = engineConnected
    ? '<div class="hint" id="engineHint" style="display:none"></div>'
    : '<div class="hint" id="engineHint">Engine not connected — turns run against a scripted stub. Ctrl/Cmd+L new chat · Ctrl/Cmd+I inline prompt.</div>';
  /* P3 (CX2b): language + text direction from the UI locale instead of a
     hardcoded <html lang="en">. */
  const htmlLang = uiLang.replace(/[^a-zA-Z0-9-]/g, "") || "en";
  /* Mode chip + dropdown (Cursor parity, parity-chat-modes §1.5/§6.1):
     the dropdown lists exactly plan/debug/multitask/chat (Ask = wire id
     "chat"); Agent is the implicit default and is not listed. Baked as JSON
     so the webview can render labels, colors and placeholders. */
  const dropdownJson = JSON.stringify(DROPDOWN_MODES.map((id) => modeDef(id))).replace(/</g, "\\u003c");
  const initialModeId: ModeName = MODES.some((m) => m.id === initialMode) ? initialMode : "agent";
  const initialDef = modeDef(initialModeId);
  const modeChipHtml =
    `<button id="modeChip" class="mode-chip mode-${initialDef.color}" aria-haspopup="true" ` +
    `title="Chat mode: ${initialDef.label} — ${initialDef.description}">` +
    `<span class="mode-dot"></span><span id="modeChipLabel">${initialDef.label}</span></button>` +
    `<div class="menu" id="modeMenu" hidden></div>`;
  const planTrayHtml =
    `<div id="planTray" class="plan-tray" hidden>` +
    `<div class="plan-tray-title">Plan ready — review it above, then:</div>` +
    `<div class="plan-tray-actions">` +
    `<button id="acceptPlanBtn" class="plan-accept">Accept Plan &amp; Build</button>` +
    `<button id="discardPlanBtn" class="plan-discard">Discard</button>` +
    `</div></div>`;

  return `<!DOCTYPE html>
<html lang="${htmlLang}" dir="${dir}">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
<style>
  body { font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); color: var(--vscode-foreground); background: var(--vscode-sideBar-background); margin: 0; padding: 8px; display: flex; flex-direction: column; height: 100vh; box-sizing: border-box; }
  header { display: flex; align-items: center; margin-bottom: 8px; }
  header h2 { font-size: 13px; margin: 0; }
  #queueChip { display: none; font-size: 11px; background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); border-radius: 10px; padding: 1px 8px; margin-left: 8px; }
  /* Doc-gap B8: chat tab bar (Cursor parity — one row of tabs above the mode row). */
  #tabBar { display: flex; align-items: center; gap: 2px; overflow-x: auto; padding: 4px 0; border-bottom: 1px solid var(--vscode-panel-border); margin-bottom: 6px; scrollbar-width: thin; }
  .ctab { display: inline-flex; align-items: center; gap: 6px; max-width: 160px; background: transparent; border: 1px solid transparent; border-radius: 6px 6px 0 0; color: var(--vscode-descriptionForeground); font-size: 11px; padding: 4px 6px 4px 10px; cursor: pointer; white-space: nowrap; }
  .ctab:hover { color: var(--vscode-foreground); background: var(--vscode-toolbar-hoverBackground, transparent); }
  .ctab.active { color: var(--vscode-foreground); background: var(--vscode-tab-activeBackground, transparent); border-color: var(--vscode-panel-border); border-bottom-color: transparent; }
  .ctab .t { overflow: hidden; text-overflow: ellipsis; }
  .ctab .spin { width: 10px; height: 10px; border: 1.5px solid var(--vscode-progressBar-background); border-top-color: transparent; border-radius: 50%; animation: ctab-spin 0.8s linear infinite; flex: none; }
  @keyframes ctab-spin { to { transform: rotate(360deg); } }
  .ctab .x { display: none; background: transparent; border: none; color: inherit; cursor: pointer; padding: 1px 3px; border-radius: 4px; font-size: 11px; line-height: 1; }
  .ctab:hover .x, .ctab.active .x { display: inline-block; }
  .ctab .x:hover { background: var(--vscode-toolbar-hoverBackground); color: var(--vscode-foreground); }
  .ctab .qdot { width: 6px; height: 6px; border-radius: 50%; background: var(--vscode-charts-orange, #e8a13c); flex: none; }
  .ctab-rename { width: 110px; font-size: 11px; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-focusBorder); border-radius: 4px; padding: 1px 4px; }
  #newTabBtn { flex: none; background: transparent; border: none; color: var(--vscode-descriptionForeground); cursor: pointer; font-size: 14px; padding: 2px 8px; border-radius: 6px; }
  #newTabBtn:hover { color: var(--vscode-foreground); background: var(--vscode-toolbar-hoverBackground, transparent); }
  /* Doc-gap A14/A15: queue list — queued messages below the transcript, each
     with reorder / delete / send-now controls and an overdue badge. */
  #queueList { display: none; border: 1px solid var(--vscode-panel-border); border-radius: 6px; margin: 6px 0; overflow: hidden; }
  #queueList.has-items { display: block; }
  .qrow { display: flex; align-items: center; gap: 6px; padding: 5px 8px; font-size: 11px; border-top: 1px solid var(--vscode-panel-border); }
  .qrow:first-child { border-top: none; }
  .qrow .qt { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--vscode-foreground); }
  .qrow .overdue { flex: none; font-size: 9px; text-transform: uppercase; letter-spacing: 0.04em; color: var(--vscode-charts-orange, #e8a13c); border: 1px solid var(--vscode-charts-orange, #e8a13c); border-radius: 3px; padding: 0 4px; }
  .qrow button { flex: none; background: transparent; border: 1px solid transparent; border-radius: 4px; color: var(--vscode-descriptionForeground); cursor: pointer; font-size: 11px; padding: 1px 5px; }
  .qrow button:hover:not(:disabled) { color: var(--vscode-foreground); border-color: var(--vscode-panel-border); }
  .qrow button:disabled { opacity: 0.35; cursor: default; }
  .qrow .qsend { color: var(--vscode-textLink-foreground); }
  /* Doc-gap A12: clarifying-question card — the agent's question with clickable options. */
  .qcard { border: 1px solid var(--vscode-panel-border); border-left: 3px solid var(--vscode-charts-blue); border-radius: 6px; margin: 8px 0; padding: 8px 10px; background: var(--vscode-editor-background); }
  .qcard .qh { font-size: 10px; text-transform: uppercase; letter-spacing: 0.05em; color: var(--vscode-descriptionForeground); margin-bottom: 4px; }
  .qcard .qq { font-size: 12px; font-weight: 600; margin-bottom: 8px; }
  .qcard .qo { display: block; width: 100%; text-align: left; background: var(--vscode-button-secondaryBackground, transparent); border: 1px solid var(--vscode-panel-border); border-radius: 6px; color: var(--vscode-foreground); cursor: pointer; font-size: 12px; padding: 6px 10px; margin-bottom: 6px; }
  .qcard .qo:hover:not(:disabled) { border-color: var(--vscode-focusBorder); }
  .qcard .qo:disabled { cursor: default; opacity: 0.75; }
  .qcard .qo.picked { border-color: var(--vscode-focusBorder); background: var(--vscode-list-activeSelectionBackground); color: var(--vscode-list-activeSelectionForeground); }
  .qcard .qo.qsubmit { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border-color: transparent; font-weight: 600; margin-top: 2px; }
  .qcard .qo.qsubmit:hover:not(:disabled) { background: var(--vscode-button-hoverBackground); border-color: transparent; }
  .qcard .qd { display: block; font-size: 11px; font-weight: 400; color: var(--vscode-descriptionForeground); margin-top: 2px; }
  .qcard .qdone { font-size: 11px; color: var(--vscode-descriptionForeground); font-style: italic; }
  #ctxTray { margin-left: auto; font-size: 11px; color: var(--vscode-descriptionForeground); background: transparent; border: 1px solid var(--vscode-panel-border); border-radius: 6px; padding: 2px 8px; cursor: pointer; }
  .mode-row { display: flex; align-items: center; gap: 6px; margin-bottom: 8px; position: relative; }
  .mode-chip { display: inline-flex; align-items: center; gap: 6px; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border); border-radius: 6px; padding: 4px 10px; cursor: pointer; font-size: 12px; }
  .mode-dot { width: 8px; height: 8px; border-radius: 50%; background: var(--vscode-foreground); flex: none; }
  .mode-green .mode-dot { background: #3fb950; }
  .mode-yellow .mode-dot { background: #d29922; }
  .mode-red .mode-dot { background: #f85149; }
  .mode-purple .mode-dot { background: #bc8cff; }
  #modeMenu { position: absolute; top: 100%; left: 0; z-index: 50; min-width: 240px; background: var(--vscode-quickInput-background); border: 1px solid var(--vscode-quickInput-border, var(--vscode-panel-border)); border-radius: 8px; padding: 4px; box-shadow: 0 8px 24px rgba(0,0,0,.35); }
  /* DEV-GAPS-30: the .menu class sets display:none; without this the
     [hidden] attribute toggle on #modeMenu could never show it. */
  #modeMenu[hidden] { display: none; }
  #modeMenu:not([hidden]) { display: block; }
  #modeMenu .menu-section, #addMenu .menu-section { font-size: 11px; color: var(--vscode-descriptionForeground); padding: 4px 8px; text-transform: uppercase; letter-spacing: .04em; }
  #modeMenu .mode-item, #addMenu .mode-item { display: flex; align-items: center; gap: 8px; width: 100%; text-align: left; background: transparent; border: 0; border-radius: 6px; padding: 6px 8px; cursor: pointer; color: var(--vscode-foreground); font-size: 12px; }
  #modeMenu .mode-item:hover, #addMenu .mode-item:hover { background: var(--vscode-list-hoverBackground); }
  #modeMenu .mode-item .mode-dot, #addMenu .mode-item .mode-dot { width: 8px; height: 8px; border-radius: 50%; flex: none; }
  #modeMenu .mode-item .mode-desc, #addMenu .mode-item .mode-desc { display: block; font-size: 11px; color: var(--vscode-descriptionForeground); }
  /* DD-CM-3 (live CDP, Cursor 3.25.9): the "+" button opening the unified
     "Add agents, context, tools" menu is button.ui-icon-button. */
  .ui-icon-button { background: transparent; color: #141414; border: none; border-radius: 6px; padding: 4px; cursor: pointer; display: inline-flex; align-items: center; justify-content: center; }
  .ui-icon-button:hover { background: rgba(20,20,20,0.06); }
  .ui-icon-button svg { width: 16px; height: 16px; display: block; }
  /* The unified add-context menu: opens above the toolbar (the composer box
     is position:relative), same box treatment as the mode dropdown. */
  #addMenu { display: none; position: absolute; bottom: 100%; left: 0; z-index: 50; min-width: 260px; max-width: 320px; max-height: 320px; overflow-y: auto;
    background: var(--vscode-quickInput-background); border: 1px solid var(--vscode-quickInput-border, var(--vscode-panel-border)); border-radius: 8px; padding: 4px; margin-bottom: 4px; box-shadow: 0 8px 24px rgba(0,0,0,.35); }
  .plan-tray { border: 1px solid var(--vscode-panel-border); border-radius: 8px; padding: 8px; margin-bottom: 8px; background: var(--vscode-input-background); }
  .plan-tray-title { font-size: 12px; margin-bottom: 6px; }
  .plan-tray-actions { display: flex; gap: 6px; }
  .plan-accept { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: 0; border-radius: 6px; padding: 5px 12px; cursor: pointer; font-size: 12px; }
  .plan-discard { background: transparent; color: var(--vscode-foreground); border: 1px solid var(--vscode-panel-border); border-radius: 6px; padding: 5px 12px; cursor: pointer; font-size: 12px; }
  /* #modelBtn now lives in the composer toolbar row — styled there. */
  #messages { flex: 1; overflow-y: auto; display: flex; flex-direction: column; gap: 8px; margin-bottom: 8px; }
  .msg { border: 1px solid var(--vscode-panel-border); border-radius: 8px; padding: 8px; word-break: break-word; }
  .msg.user { background: var(--vscode-input-background); align-self: flex-end; max-width: 95%; }
  .msg.assistant { background: transparent; align-self: flex-start; max-width: 95%; }
  .role { font-size: 10px; color: var(--vscode-descriptionForeground); margin-bottom: 4px; }
  .srv { color: var(--vscode-charts-green); margin-left: 4px; }
  .bubble-text { white-space: pre-wrap; }
  /* Issue 2 (QA-FILE-02): streamed markdown rendering. All user/engine
     text is escaped before markup is applied (see renderMarkdown), so
     these elements can only be produced by the renderer itself. */
  .bubble-text p { margin: 0 0 6px; }
  .bubble-text p:last-child { margin-bottom: 0; }
  .bubble-text h1, .bubble-text h2, .bubble-text h3, .bubble-text h4 { margin: 8px 0 4px; line-height: 1.3; }
  .bubble-text h1 { font-size: 15px; }
  .bubble-text h2 { font-size: 14px; }
  .bubble-text h3, .bubble-text h4 { font-size: 13px; }
  .bubble-text ul, .bubble-text ol { margin: 4px 0; padding-left: 20px; }
  .bubble-text li { margin: 2px 0; }
  .bubble-text blockquote { border-left: 2px solid var(--vscode-panel-border); margin: 4px 0; padding: 2px 0 2px 8px; color: var(--vscode-descriptionForeground); }
  .bubble-text code { font-family: var(--vscode-editor-font-family, monospace); font-size: 11px; background: var(--vscode-textCodeBlock-background); border-radius: 3px; padding: 0 4px; }
  .bubble-text pre.md-code { background: var(--vscode-textCodeBlock-background); border: 1px solid var(--vscode-panel-border); border-radius: 6px; padding: 8px; overflow: auto; margin: 6px 0; }
  .bubble-text pre.md-code code { background: transparent; padding: 0; border-radius: 0; white-space: pre; }
  .bubble-text a { color: var(--vscode-textLink-foreground); }
  .bubble-text strong { font-weight: 600; }
  details.thinking { margin-bottom: 6px; border-left: 2px solid var(--vscode-panel-border); padding-left: 8px; }
  details.thinking summary { cursor: pointer; font-size: 11px; color: var(--vscode-descriptionForeground); }
  .thinking-body { font-size: 12px; color: var(--vscode-descriptionForeground); white-space: pre-wrap; }
  .tool-call-card { border: 1px solid var(--vscode-panel-border); border-radius: 6px; margin-top: 6px; overflow: hidden; }
  .tc-head { width: 100%; display: flex; gap: 8px; align-items: center; background: transparent; border: none; color: var(--vscode-foreground); cursor: pointer; padding: 6px 8px; font-size: 12px; text-align: left; }
  .tc-kind { font-size: 10px; color: var(--vscode-descriptionForeground); border: 1px solid var(--vscode-panel-border); border-radius: 4px; padding: 0 5px; }
  .tc-title { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .tc-status { font-size: 10px; border-radius: 10px; padding: 1px 8px; }
  .tc-pending { background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); }
  .tc-running { background: var(--vscode-progressBar-background); color: var(--vscode-button-foreground); }
  .tc-done { background: transparent; color: var(--vscode-charts-green); border: 1px solid var(--vscode-charts-green); }
  .tc-failed { background: transparent; color: var(--vscode-errorForeground); border: 1px solid var(--vscode-errorForeground); }
  .tc-desc { font-size: 11px; color: var(--vscode-descriptionForeground); padding: 0 8px 6px; }
  .tc-output { font-size: 11px; max-height: 120px; overflow: auto; background: var(--vscode-textCodeBlock-background); margin: 0 8px 8px; padding: 6px; border-radius: 4px; white-space: pre-wrap; }
  #approvalCard { display: none; border: 1px solid var(--vscode-inputValidation-warningBorder); background: var(--vscode-inputValidation-warningBackground); border-radius: 8px; padding: 8px; margin-bottom: 8px; }
  #approvalCard h4 { margin: 0 0 4px; font-size: 12px; }
  #approvalCard ul { margin: 4px 0; padding-left: 18px; font-size: 11px; }
  .appr-btns { display: flex; gap: 6px; margin-top: 6px; flex-wrap: wrap; }
  .appr-btns button { font-size: 11px; border-radius: 6px; padding: 4px 10px; cursor: pointer; border: 1px solid var(--vscode-button-border, transparent); }
  .appr-primary { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: none; }
  /* DD-CM-7: chips live INSIDE the single box (Cursor: mention chips are
     Lexical editor nodes; our chips row above the textarea is the closest
     equivalent). The 44px touch-sized chips were wrong for an inline editor
     chip row. Exact Cursor chip metrics are still UNKNOWN (logged-out
     capture could not observe them — flagged for a logged-in pass); these
     are conservative small-pill values. */
  #chips { display: none; gap: 4px; flex-wrap: wrap; }
  #chips.has-chips { display: flex; }
  .chip { font-size: 11px; background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); border-radius: 11px; padding: 0 4px 0 10px; display: inline-flex; align-items: center; gap: 4px; min-height: 22px; max-height: 24px; box-sizing: border-box; }
  .chip button { background: transparent; border: none; color: inherit; cursor: pointer; font-size: 12px; padding: 0; width: 18px; height: 18px; display: inline-flex; align-items: center; justify-content: center; border-radius: 50%; }
  .chip button:hover { background: rgba(0,0,0,.08); }
  /* DD-CM-1/3 (live CDP, Cursor 3.25.9): the composer is ONE box —
     .ai-input-full-input-box — containing the editor AND the toolbar row.
     Tokens: radius 12px, padding 8/10/6/10, bg rgba(252,252,252,.9),
     1px border rgba(20,20,20,.2), flex column, gap 6px, NO focus outline
     (border unchanged on focus). Side margins: body padding 8px + 8px here
     = Cursor's measured 16px. */
  #composer { display: flex; flex-direction: column; position: relative; box-sizing: border-box;
    background: rgba(252,252,252,0.9); border: 1px solid rgba(20,20,20,0.2);
    border-radius: 12px; padding: 8px 10px 6px 10px; margin: 0 8px; }
  /* DEV-GAPS-35 (composer-dom-structure, live CDP Cursor 3.25.9,
     docs/rea/detail-chat-2026-10-19.md §1): Cursor-verbatim structural
     classes agent-prompt-input-root > ui-prompt-input >
     ui-prompt-input__container > ui-prompt-input-editor >
     ui-prompt-input-editor__content. The container is the flex column that
     stacks chips / editor / toolbar with the same 6px gap #composer used
     to have, so the measured layout is unchanged; the editor wrappers are
     transparent (the textarea keeps its own box styling). */
  .ui-prompt-input__container { display: flex; flex-direction: column; gap: 6px; }
  /* DD-CM-3/5: 14px/22px system-ui, #141414 text, caret same color; the box
     owns the background and border, the editor is borderless. Tab is trapped
     in JS (see keydown); Shift+Enter inserts a newline natively; Esc blurs.
     HONEST DIVERGENCE (DEV-GAPS-35, evidence: live CDP DOM,
     docs/rea/detail-chat-2026-10-19.md §1 — Cursor's editor is a TipTap
     ProseMirror rich-text instance
     (div[contenteditable][role=textbox][aria-label="Prompt"],
     .tiptap.ProseMirror.ui-prompt-input-editor__input; mention chips are
     editor nodes, Tab handled internally); ours is a plain <textarea>
     implementing the same keyboard contract — no rich nodes, no IME-aware
     rich selection. A ProseMirror port is out of scope for this DOM-
     structure gap: the webview script is a single inline bundle keyed to
     HTMLTextAreaElement (value / selectionStart / rows autosize / Tab-trap
     / @-mention / slash-menu / chips / Esc / Cmd+K logic); porting would
     mean vendoring TipTap and rewriting all input logic as ProseMirror
     extensions — a full editor re-architecture. The container class chain
     is verbatim; the editor NODE itself diverges. */
  #input { width: 100%; box-sizing: border-box; background: transparent; color: #141414; border: none; border-radius: 0; padding: 0;
    font-family: system-ui, Ubuntu, "Droid Sans", sans-serif; font-size: 14px; line-height: 22px;
    caret-color: #141414; resize: none; }
  #input:focus { outline: none; box-shadow: none; }
  /* DD-CM-4: placeholder at 36% ink + 50% opacity (effective ~18% ink). */
  #input::placeholder { color: rgba(20,20,20,0.36); opacity: 0.5; }
  /* DD-CM-1: bottom toolbar row INSIDE the box — model picker ghost button
     left, submit slot right (Cursor: flex, space-between, gap ~8px). */
  .composer-toolbar { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
  .composer-toolbar-left { display: flex; align-items: center; gap: 6px; min-width: 0; }
  .composer-toolbar-right { display: flex; align-items: center; gap: 6px; }
  /* Cursor's model picker is a ghost button in the toolbar (exact
     label/tooltip verbatim to be confirmed on a logged-in pass). */
  #modelBtn { background: transparent; color: #141414; border: none; border-radius: 6px; padding: 2px 6px; cursor: pointer; font-size: 12px; text-align: left; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  #modelBtn:hover { background: rgba(20,20,20,0.06); }
  /* DD-CM-2/6 (bundle static analysis, Cursor 3.25.9): ONE 24px circle slot
     (data-component="prompt-input-submit-button", data-size="md") that
     morphs empty→voice, text→send, running→stop.
     HONEST DIVERGENCE: Cursor's empty-input entry is a realtime voice-chat
     button; we show the same entry (mic icon, aria-label "Start voice
     chat", data-state="active") but the click is a deliberate no-op — the
     Web Speech API recognition service is unavailable in Electron webviews
     and this build bundles no STT engine, so a voice button could never
     work (see the header comment on SUBMIT_ICON_VOICE; zero-placeholder
     policy: no dead promises, no fake toast). Tokens:
       active   bg #141414 / icon #fcfcfc, hover opacity .9
       stop     bg 8% ink / icon #141414, hover bg 14% + icon 66% ink
     Icon sizes: send 12px (arrow-up), voice 12px (mic), stop 20px. */
  #send.ui-prompt-input-submit-button { width: 24px; height: 24px; flex: none; padding: 0; border: none; border-radius: 9999px; cursor: pointer; display: inline-flex; align-items: center; justify-content: center; }
  #send[data-state="active"] { background: #141414; color: #fcfcfc; }
  #send[data-state="active"]:hover { opacity: 0.9; }
  #send.slot-send svg { width: 12px; height: 12px; display: block; flex: none; }
  #send.slot-voice svg { width: 12px; height: 12px; display: block; flex: none; }
  #send[data-state="stop"] { background: rgba(20,20,20,0.08); color: #141414; }
  #send[data-state="stop"]:hover { background: rgba(20,20,20,0.14); color: rgba(20,20,20,0.66); }
  #send[data-state="stop"] svg { width: 20px; height: 20px; display: block; flex: none; }
  /* GAPS-48B (Cursor 3.25.9 voice-toolbar-follow-up-while-running.js): the
     follow-up-while-running voice toolbar — a second 24px circle slot with
     the voice entry's tokens (active bg #141414 / icon #fcfcfc, 12px mic),
     shown only while a turn runs in multitask mode (bmC → showMicWhileRunning).
     The stop control stays on #send; this button's click is a deliberate
     no-op (HONEST DIVERGENCE: no STT engine / mic capture in this build). */
  #voiceWhileRunning.ui-prompt-input-submit-button { width: 24px; height: 24px; flex: none; padding: 0; border: none; border-radius: 9999px; cursor: pointer; display: none; align-items: center; justify-content: center; background: #141414; color: #fcfcfc; }
  #voiceWhileRunning.ui-prompt-input-submit-button:hover { opacity: 0.9; }
  #voiceWhileRunning.slot-voice svg { width: 12px; height: 12px; display: block; flex: none; }
  /* Mode color accent on the submit slot (Cursor data-color, via YaS):
     plan→yellow, debug→red, chat→green; agent = none. Rendered as a 2px
     ring — the exact YaS rendering was not fully traced in the bundle;
     revisit on a logged-in pass if the ring form is wrong. */
  #send[data-color="plan"][data-state="active"] { box-shadow: 0 0 0 2px #d29922; }
  #send[data-color="debug"][data-state="active"] { box-shadow: 0 0 0 2px #f85149; }
  #send[data-color="chat"][data-state="active"] { box-shadow: 0 0 0 2px #3fb950; }
  .md-code { background: var(--vscode-textCodeBlock-background); border-radius: 4px; padding: 8px; overflow: auto; font-size: 11px; margin: 4px 0; }
  .md-code code { font-family: var(--vscode-editor-font-family, monospace); }
  code.md-inline { background: var(--vscode-textCodeBlock-background); border-radius: 3px; padding: 0 4px; font-size: 11px; }
  .menu { display: none; position: absolute; bottom: 100%; left: 0; right: 0; background: var(--vscode-quickInput-background); border: 1px solid var(--vscode-quickInput-border, var(--vscode-panel-border)); border-radius: 6px; max-height: 180px; overflow-y: auto; z-index: 10; margin-bottom: 4px; }
  .menu button { display: block; width: 100%; text-align: left; background: transparent; border: none; color: var(--vscode-foreground); padding: 6px 10px; cursor: pointer; font-size: 12px; }
  .menu button:hover, .menu button.sel { background: var(--vscode-list-activeSelectionBackground); color: var(--vscode-list-activeSelectionForeground); }
  .menu button.sel { outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px; }
  button:focus-visible, .tc-head:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: 1px; }
  .menu .sub { font-size: 10px; color: var(--vscode-descriptionForeground); display: block; }
  /* @-mention menu rows: kind tag, label highlight, loading/empty states. */
  .menu .kind { font-size: 9px; text-transform: uppercase; letter-spacing: 0.04em; color: var(--vscode-descriptionForeground); border: 1px solid var(--vscode-panel-border); border-radius: 3px; padding: 0 4px; margin-right: 6px; }
  .menu mark { background: var(--vscode-editor-findMatchHighlightBackground); color: inherit; }
  .menu-loading, .menu-empty { font-size: 11px; color: var(--vscode-descriptionForeground); padding: 8px 10px; }
  .chip-sub { font-size: 10px; color: var(--vscode-descriptionForeground); }
  .chip-thumb { width: 56px; height: 34px; object-fit: cover; border-radius: 4px; border: 1px solid var(--vscode-widget-border, #3a3a3a); }
  #ctxPop { display: none; position: absolute; bottom: 100%; right: 0; width: 220px; background: var(--vscode-quickInput-background); border: 1px solid var(--vscode-panel-border); border-radius: 6px; padding: 8px; z-index: 10; margin-bottom: 4px; font-size: 11px; }
  #ctxPop .row { display: flex; justify-content: space-between; margin-bottom: 4px; }
  #ctxPop .bar { height: 4px; background: var(--vscode-progressBar-background); border-radius: 2px; margin: 2px 0 6px; }
  #ctxPop .bar i { display: block; height: 100%; background: var(--vscode-charts-blue); border-radius: 2px; }
  .hint { font-size: 11px; color: var(--vscode-descriptionForeground); margin-top: 6px; }
  /* Cursor parity: per-human-message Restore button (hover-revealed icon,
     aria-label="Restore Checkpoint", no confirmation dialog). */
  .human-message-action-slot { display: flex; justify-content: flex-end; margin-top: 6px; min-height: 22px; }
  .restore-btn { display: none; background: transparent; border: 1px solid transparent; border-radius: 6px; color: var(--vscode-descriptionForeground); cursor: pointer; padding: 3px; line-height: 0; }
  .msg.human:hover .restore-btn, .restore-btn:focus-visible { display: inline-block; }
  .restore-btn:hover { color: var(--vscode-foreground); border-color: var(--vscode-panel-border); background: var(--vscode-toolbar-hoverBackground, transparent); }
  .restore-btn svg { width: 14px; height: 14px; display: block; }
  /* Cursor parity: "checked out" chip after a restore. Clicking it
     re-invokes the restore (revert-after-checkout). */
  .checked-out-chip { display: inline-flex; align-items: center; gap: 6px; font-size: 11px; color: var(--vscode-descriptionForeground); background: transparent; border: 1px dashed var(--vscode-panel-border); border-radius: 12px; padding: 2px 10px; margin-top: 6px; cursor: pointer; }
  .checked-out-chip:hover { color: var(--vscode-foreground); border-style: solid; }
  .checked-out-chip svg { width: 12px; height: 12px; }
  /* P3 (CX2b): RTL layout fixes — dir="rtl" mirrors flex layout
     automatically, but these need explicit handling. */
  html[dir="rtl"] #chips { flex-direction: row-reverse; }
  html[dir="rtl"] .chip { padding: 0 10px 0 4px; }
  html[dir="rtl"] .menu .sub { text-align: right; }
  html[dir="rtl"] .appr-btns { flex-direction: row-reverse; }
  html[dir="rtl"] .bubble-text pre.md-code code { direction: ltr; unicode-bidi: embed; }
  /* SETTINGS-PARITY: chat UI settings (ide.composer.* / ide.general.*). */
  body { font-size: calc(var(--vscode-font-size) * var(--ide-chat-scale, 1)); }
  body.wordwrap .bubble-text pre.md-code code { white-space: pre-wrap; word-break: break-word; }
  body.no-tips .empty-tips { display: none; }
  body.smooth-text { -webkit-font-smoothing: antialiased; }
  body:not(.smooth-text) { -webkit-font-smoothing: auto; }
  .empty-tips { margin-top: 10px; font-size: 11px; color: var(--vscode-descriptionForeground); border-top: 1px solid var(--vscode-panel-border); padding-top: 8px; }
  .empty-tips .tip-label { font-weight: 600; margin-bottom: 4px; }
  /* conversationDensity: grouped tool-call cards. */
  .tc-group { border: 1px solid var(--vscode-panel-border); border-radius: 6px; margin-top: 6px; overflow: hidden; }
  .tc-group-head { width: 100%; display: flex; gap: 8px; align-items: center; background: transparent; border: none; color: var(--vscode-descriptionForeground); cursor: pointer; padding: 6px 8px; font-size: 11px; text-align: left; }
  .tc-group-head:hover { color: var(--vscode-foreground); }
  .tc-group-cards { display: none; }
  .tc-group.open .tc-group-cards { display: block; }
  .tc-group .tool-call-card { border: none; border-top: 1px solid var(--vscode-panel-border); border-radius: 0; margin-top: 0; }
</style>
</head>
<body>
  <header>
    <h2>IDE Agent</h2>
    <span id="queueChip"></span>
    <button id="ctxTray" title="Context usage breakdown">ctx</button>
  </header>
  <div id="tabBar" role="tablist" aria-label="Chat tabs"></div>
  <div class="mode-row" id="modeRow">${modeChipHtml}</div>
  ${planTrayHtml}
  <div id="messages" aria-live="polite" aria-atomic="false">${welcomeBubbleHtml(engineConnected)}</div>
  <div id="queueList" aria-label="Queued messages"></div>
  <div id="approvalCard" role="alertdialog" aria-modal="false" aria-labelledby="approvalTitle" tabindex="-1"></div>
  <!-- DD-CM-1 (Cursor 3.25.9): the composer is ONE 12px-radius box
       (.ai-input-full-input-box) — the toolbar row (model picker + submit
       slot) sits INSIDE the box, not beside it.
       DEV-GAPS-35 (composer-dom-structure, live CDP, detail-chat §1):
       Cursor-verbatim class chain agent-prompt-input-root > ui-prompt-input
       > ui-prompt-input__container > ui-prompt-input-editor >
       ui-prompt-input-editor__content; the input carries Cursor's verbatim
       aria-label "Prompt". The editor node itself stays a plain textarea
       (HONEST DIVERGENCE — Cursor: TipTap ProseMirror contenteditable div;
       see the HONEST DIVERGENCE note above #input). -->
  <div id="composer" class="ai-input-full-input-box agent-prompt-input-root">
    <div class="ui-prompt-input">
      <div class="ui-prompt-input__container">
        <div id="chips" aria-label="Attached context"></div>
        <div class="ui-prompt-input-editor">
          <div class="ui-prompt-input-editor__content">
            <textarea id="input" rows="2" aria-label="Prompt" placeholder="${CURSOR_PLACEHOLDER}"></textarea>
          </div>
        </div>
    <div class="composer-toolbar">
      <div class="composer-toolbar-left">
        <!-- DD-CM-3 (live CDP, Cursor 3.25.9): button.ui-icon-button
             [aria-label="Add agents, context, tools"] — the "+" that opens
             the unified context menu (Modes / Files / Model / MCP). -->
        <button id="addBtn" class="ui-icon-button" aria-label="Add agents, context, tools" title="Add agents, context, tools" aria-haspopup="menu">${ADD_ICON_PLUS}</button>
        <button id="modelBtn" title="Pick model">model: ${escHtml(modelLabel)}</button>
      </div>
      <div class="composer-toolbar-right">
        <!-- GAPS-48B (Cursor 3.25.9 voice-toolbar-follow-up-while-running.js):
             in multitask mode the follow-up-while-running input ALWAYS shows
             the voice toolbar (mic) instead of the queue/send/steer message
             buttons (bmC → showMicWhileRunning). The stop control stays on
             the submit slot (Cursor's toolbar likewise keeps onStopClick).
             HONEST DIVERGENCE: the click is a deliberate no-op — no STT
             engine / mic capture in this build (same policy as the idle
             voice-chat entry). Hidden unless a turn runs in multitask mode. -->
        <button id="voiceWhileRunning" class="ui-prompt-input-submit-button slot-voice" data-component="voice-toolbar-follow-up-while-running" data-size="md" data-state="active" title="Start voice chat" aria-label="Start voice chat" style="display:none">${SUBMIT_ICON_VOICE}</button>
        <!-- DD-CM-2/6: the submit slot is ONE 24px circle button that morphs —
             empty → voice-chat entry ("Start voice chat", data-state="active"),
             text → "Send message" (data-state="active"), running →
             stop-circle ("Stop generation"). HONEST DIVERGENCE: the empty
             state's voice-chat click is a deliberate no-op — this build has
             no STT engine / mic capture (Web Speech API recognition is
             unavailable in Electron webviews), so a real voice chat cannot
             start; zero-placeholder policy forbids faking one. The webview
             script swaps data-state + label + icon as text is typed/cleared
             and turns start/stop. -->
        <button id="send" class="ui-prompt-input-submit-button slot-voice" data-component="prompt-input-submit-button" data-size="md" data-state="active" title="Start voice chat" aria-label="Start voice chat">${SUBMIT_ICON_VOICE}</button>
      </div>
    </div>
    <div class="menu" id="mentionMenu"></div>
    <div class="menu" id="slashMenu"></div>
    <div id="addMenu"></div>
    <div id="ctxPop"></div>
      </div>
    </div>
  </div>
  ${engineHintHtml}
<script type="application/json" id="ide-ui-config">${uiJson}</script>
<script nonce="${nonce}">
(function () {
  var vscodeApi = acquireVsCodeApi();
  var messagesEl = document.getElementById('messages');
  var inputEl = document.getElementById('input');
  var chipsEl = document.getElementById('chips');
  var chips = [];

  /* Cursor / parity: ready handshake — the host replies with the initial
     slash-command palette ({type:'slashCommands'}). Posting here avoids the
     post-before-load race of host-initiated delivery. */
  vscodeApi.postMessage({ type: 'webviewReady' });

  /* ---- fine-grained bubble store: Map keyed by bubbleId, per-bubble patch ---- */
  var store = new Map(); // bubbleId -> { data, el }

  /* SETTINGS-PARITY: chat UI settings (ide.composer.* / ide.general.*).
     Baked into the HTML at render; live changes arrive via {type:'uiConfig'}.
     The ui object is read by card rendering (density) and input handlers (Cmd+P). */
  var ui = { textSizeScale: 1, conversationDensity: 'compact-all-grouped', codeBlockWordWrap: false, showEmptyStateTips: true, fontSmoothingAntialiased: true, cmdPFilePicker: true };
  function applyUiConfig(next) {
    if (!next || typeof next !== 'object') { return; }
    var prevDensity = ui.conversationDensity;
    var changed = false;
    for (var k in ui) {
      if (Object.prototype.hasOwnProperty.call(next, k) && next[k] !== undefined) {
        // WORKER-GAPS-24C: canonicalize the density at the config boundary
        // (legacy "compact-shells"/"compact-grouped" migrate to the 3
        // changelog levels; unknown values fall back to Compact, mirroring
        // Cursor's normalizeDensity + SNv migration). Note the second
        // disjunct: a legacy raw value that canonicalizes to the current
        // value (e.g. "compact-grouped" → "compact-all-grouped") must still
        // count as a change so the body classes are (re-)applied.
        var v = (k === 'conversationDensity') ? canonicalConversationDensity(next[k]) : next[k];
        if (v !== ui[k] || next[k] !== ui[k]) {
          ui[k] = v;
          changed = true;
        }
      }
    }
    if (!changed) { return; }
    document.body.style.setProperty('--ide-chat-scale', String(ui.textSizeScale));
    document.body.classList.toggle('wordwrap', !!ui.codeBlockWordWrap);
    document.body.classList.toggle('no-tips', !ui.showEmptyStateTips);
    document.body.classList.toggle('smooth-text', !!ui.fontSmoothingAntialiased);
    document.body.classList.toggle('density-detailed', ui.conversationDensity === 'detailed');
    document.body.classList.toggle('density-compact-ungrouped', ui.conversationDensity === 'compact-ungrouped');
    document.body.classList.toggle('density-compact-all-grouped', ui.conversationDensity === 'compact-all-grouped');
    // A density change regroups/regroups all rendered tool-call cards.
    if (ui.conversationDensity !== prevDensity && typeof rerenderAllToolCalls === 'function') {
      rerenderAllToolCalls();
    }
  }
  try {
    var baked = JSON.parse(document.getElementById('ide-ui-config').textContent || '{}');
    applyUiConfig(baked);
  } catch (e) { /* keep defaults */ }

  function esc(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  /* ---- issue 2 (QA-FILE-02, P1 parity): lightweight streaming markdown ----
     Cursor renders markdown with code blocks; we rendered plain text.
     XSS-safe by construction: the ENTIRE source is escaped first, and the
     transforms below only inject our own fixed tags. Link hrefs are
     restricted to http(s). Unclosed fences (mid-stream) render as code to
     end-of-text. Handles re-render on every textDelta patch. */
  var MD_CODE_PH = "\uE000";
  var MD_INLINE_PH = "\uE001";
  function inlineMd(s) {
    var codes = [];
    s = s.replace(/\\x60([^\\x60\\n]+)\\x60/g, function (m, c) {
      var i = codes.length;
      codes.push('<code>' + c + '</code>');
      return MD_INLINE_PH + i + MD_INLINE_PH;
    });
    s = s.replace(/\\[([^\\]]+)\\]\\((https?:\\/\\/[^\\s)]+)\\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
    s = s.replace(/\\*\\*([^*]+)\\*\\*/g, '<strong>$1</strong>');
    s = s.replace(/(^|[^*\\w])\\*([^*\\n]+)\\*/g, '$1<em>$2</em>');
    s = s.replace(/~~([^~]+)~~/g, '<del>$1</del>');
    var phRe = new RegExp(MD_INLINE_PH + '(\\\\d+)' + MD_INLINE_PH, 'g');
    s = s.replace(phRe, function (m, i) { return codes[+i]; });
    return s;
  }
  function renderMarkdown(src) {
    var text = esc(String(src == null ? '' : src));
    // 1. Extract fenced code blocks (\\x60\\x60\\x60lang ... \\x60\\x60\\x60), incl. unclosed ones.
    var blocks = [];
    text = text.replace(/\\x60\\x60\\x60(\\w*)\\n?([\\s\\S]*?)(?:\\x60\\x60\\x60|$)/g, function (m, lang, code) {
      var i = blocks.length;
      blocks.push(
        '<pre class="md-code"><code' + (lang ? ' data-lang="' + lang + '"' : '') + '>' +
        code.replace(/\\n$/, '') + '</code></pre>');
      return MD_CODE_PH + i + MD_CODE_PH;
    });
    // 2. Block-level: headings, lists, blockquotes, paragraphs.
    var mdLines = text.split('\\n');
    var html = '';
    var listOpen = false;
    var para = [];
    function flushPara() {
      if (para.length) { html += '<p>' + para.map(inlineMd).join('<br>') + '</p>'; para = []; }
    }
    function closeList() { if (listOpen) { html += '</ul>'; listOpen = false; } }
    var fenceLineRe = new RegExp('^' + MD_CODE_PH + '\\\\d+' + MD_CODE_PH + '$');
    for (var i = 0; i < mdLines.length; i++) {
      var line = mdLines[i];
      if (fenceLineRe.test(line)) { flushPara(); closeList(); html += line; continue; }
      var h = line.match(/^(#{1,4})\\s+(.*)$/);
      if (h) { flushPara(); closeList(); html += '<h' + h[1].length + '>' + inlineMd(h[2]) + '</h' + h[1].length + '>'; continue; }
      var li = line.match(/^[-*]\\s+(.*)$/);
      if (li) { flushPara(); if (!listOpen) { html += '<ul>'; listOpen = true; } html += '<li>' + inlineMd(li[1]) + '</li>'; continue; }
      var q = line.match(/^&gt;\\s?(.*)$/);
      if (q) { flushPara(); closeList(); html += '<blockquote>' + inlineMd(q[1]) + '</blockquote>'; continue; }
      if (/^\\s*$/.test(line)) { flushPara(); closeList(); continue; }
      para.push(line);
    }
    flushPara(); closeList();
    // 3. Restore code blocks.
    var blockRe = new RegExp(MD_CODE_PH + '(\\\\d+)' + MD_CODE_PH, 'g');
    return html.replace(blockRe, function (m, i) { return blocks[+i]; });
  }
  function toolCallCardEl(tc) {
    var card = document.createElement('div');
    card.className = 'tool-call-card';
    card.setAttribute('data-toolcall', tc.toolCallId);
    // P2 (QA-FILE-01): ARIA on the webview's local tool-call card copy.
    var outId = 'tc-out-' + String(tc.toolCallId).replace(/[^a-zA-Z0-9_-]/g, '-');
    card.innerHTML =
      '<button class="tc-head" aria-expanded="' + (tc.expanded ? 'true' : 'false') + '"' +
        ' aria-controls="' + outId + '" aria-label="Toggle tool call output: ' + esc(tc.title) + '">' +
        '<span class="tc-kind">' + esc(tc.kind) + '</span>' +
        '<span class="tc-title">' + esc(tc.title) + '</span>' +
        '<span class="tc-status tc-' + tc.status + '">' + statusLabel(tc.status) + '</span>' +
      '</button>' +
      '<div class="tc-desc">' + esc(tc.description) + '</div>' +
      (tc.outputPreview ? '<pre class="tc-output" id="' + outId + '">' + esc(tc.outputPreview) + '</pre>' : '');
    var head = card.querySelector('.tc-head');
    var out = card.querySelector('.tc-output');
    if (out) { out.style.display = tc.expanded ? '' : 'none'; }
    head.addEventListener('click', function () {
      if (out) {
        var hidden = out.style.display === 'none';
        out.style.display = hidden ? '' : 'none';
        head.setAttribute('aria-expanded', hidden ? 'true' : 'false');
      }
    });
    return card;
  }

  function patchToolCall(card, tc) {
    card.setAttribute('data-status', tc.status);
    var statusEl = card.querySelector('.tc-status');
    statusEl.className = 'tc-status tc-' + tc.status;
    statusEl.textContent = statusLabel(tc.status);
    card.querySelector('.tc-desc').textContent = tc.description;
    // P2 (QA-FILE-01): keep aria-expanded in sync with the card's expanded state.
    var head = card.querySelector('.tc-head');
    if (head) { head.setAttribute('aria-expanded', tc.expanded ? 'true' : 'false'); }
    var out = card.querySelector('.tc-output');
    // SETTINGS-PARITY: detailed density keeps output visible.
    var showOut = tc.expanded || (typeof densityDetailed === 'function' && densityDetailed());
    if (tc.outputPreview) {
      if (!out) {
        out = document.createElement('pre');
        out.className = 'tc-output';
        var outId = head ? head.getAttribute('aria-controls') : null;
        if (outId) { out.id = outId; }
        out.style.display = showOut ? '' : 'none';
        card.appendChild(out);
      }
      out.textContent = tc.outputPreview;
      out.style.display = showOut ? '' : 'none';
    } else if (out) { out.remove(); }
  }

  /* WORKER-GAPS-24C — conversationDensity (mirrors
     cursor.composer.conversationDensity; Cursor 3.25.6 binary evidence,
     workbench.glass.main.js):
     - conversation-density.js: normalizeDensity passes through detailed |
       compact-shells | compact-ungrouped | compact-grouped |
       compact-all-grouped; "verbose"→"detailed", "minimal"→"compact-all-grouped",
       anything else→"compact-all-grouped" (fallback).
     - Glass settings migration (SNv): legacy "compact-shells"→Balanced
       ("compact-ungrouped"), legacy "compact-grouped"→Compact
       ("compact-all-grouped"). Applied here at the config boundary so the
       renderer only ever sees the 3 changelog levels.
     - Predicates mirror the binary: isCompact (dCa), isGrouped (xvi),
       isMostCompact (Srp).
     Rendering (changelog page/7 "Compact chat responses" + step-layout.js):
     - Compact (compact-all-grouped): concise rows, minimal tool traces —
       ALL consecutive tool-call cards collapse into one toggleable group
       (binary ZvS→"all": the grouping mode for the most-compact density,
       so mixed edit/shell runs stay in one group).
     - Balanced (compact-ungrouped): important intermediate steps — cards
       collapsed (click to expand), NO grouping.
     - Detailed: near-complete step-by-step — cards render expanded with
       tool output visible. */
  function normalizeConversationDensity(v) {
    switch (v) {
      case 'detailed': case 'compact-shells': case 'compact-ungrouped':
      case 'compact-grouped': case 'compact-all-grouped': return v;
      case 'verbose': return 'detailed';
      case 'minimal': return 'compact-all-grouped';
      default: return 'compact-all-grouped';
    }
  }
  function canonicalConversationDensity(v) {
    var n = normalizeConversationDensity(v);
    // Legacy 5-option preview values → 3 changelog levels (binary SNv map).
    if (n === 'compact-shells') { return 'compact-ungrouped'; }
    if (n === 'compact-grouped') { return 'compact-all-grouped'; }
    return n;
  }
  function densityIsCompact() { var d = ui.conversationDensity; return d === 'compact-ungrouped' || d === 'compact-grouped' || d === 'compact-all-grouped'; }
  function densityIsGrouped() { var d = ui.conversationDensity; return d === 'compact-grouped' || d === 'compact-all-grouped'; }
  function densityIsMostCompact() { return ui.conversationDensity === 'compact-all-grouped'; }
  function densityGrouped() { return densityIsMostCompact(); }
  function densityDetailed() { return ui.conversationDensity === 'detailed'; }

  /* P2 (WORKER-GAPS-24C): these were referenced but never defined — any
     bubble render threw a ReferenceError. Local copies kept in sync with
     bubble.ts roleLabel/statusLabel. */
  function roleLabel(role) {
    switch (role) {
      case 'human': return 'You';
      case 'assistant': return 'IDE Agent';
      case 'tool': return 'Tool';
      case 'system': return 'System';
      default: return String(role == null ? '' : role);
    }
  }
  function statusLabel(status) {
    switch (status) {
      case 'pending': return 'pending';
      case 'running': return 'running';
      case 'done': return 'done';
      case 'failed': return 'failed';
      default: return 'unknown';
    }
  }

  function toolCallGroupEl() {
    var g = document.createElement('div');
    g.className = 'tc-group';
    g.setAttribute('data-tcgroup', '1');
    var head = document.createElement('button');
    head.type = 'button';
    head.className = 'tc-group-head';
    head.setAttribute('aria-expanded', 'false');
    var cards = document.createElement('div');
    cards.className = 'tc-group-cards';
    head.addEventListener('click', function () {
      var open = g.classList.toggle('open');
      head.setAttribute('aria-expanded', open ? 'true' : 'false');
      updateGroupHead(g);
    });
    g.appendChild(head);
    g.appendChild(cards);
    updateGroupHead(g);
    return g;
  }

  function updateGroupHead(g) {
    var cards = g.querySelector('.tc-group-cards');
    var n = cards ? cards.childElementCount : 0;
    var head = g.querySelector('.tc-group-head');
    if (!head) { return; }
    var open = g.classList.contains('open');
    head.textContent = (open ? '▾ ' : '▸ ') + n + ' tool call' + (n === 1 ? '' : 's');
    head.setAttribute('aria-label', n + ' tool calls — toggle group');
  }

  /** Append a tool-call card, grouping per conversationDensity. */
  function appendToolCallCard(toolsEl, tc) {
    var renderTc = (densityDetailed() && !tc.expanded) ? Object.assign({}, tc, { expanded: true }) : tc;
    var card = toolCallCardEl(renderTc);
    // WORKER-GAPS-24C: at Compact (most-compact) density, ALL consecutive
    // tool-call cards share one toggleable group — binary ZvS→"all" keeps
    // mixed edit/shell runs in one group at this density.
    if (densityIsMostCompact()) {
      var last = toolsEl.lastElementChild;
      var group =
        last && last.getAttribute && last.getAttribute('data-tcgroup') === '1' ? last : null;
      if (!group) {
        group = toolCallGroupEl();
        toolsEl.appendChild(group);
      }
      group.querySelector('.tc-group-cards').appendChild(card);
      updateGroupHead(group);
      return card;
    }
    toolsEl.appendChild(card);
    return card;
  }

  /** Re-render every bubble's tool-call section (used when density changes). */
  function rerenderAllToolCalls() {
    store.forEach(function (entry) {
      var toolsEl = entry.el.querySelector('.tool-calls');
      if (!toolsEl) { return; }
      toolsEl.innerHTML = '';
      var tcs = entry.data.toolCalls || [];
      for (var i = 0; i < tcs.length; i++) { appendToolCallCard(toolsEl, tcs[i]); }
    });
  }

  /** Drop group wrappers left empty by card removal. */
  function pruneEmptyGroups(toolsEl) {
    var groups = toolsEl.querySelectorAll('[data-tcgroup]');
    for (var i = groups.length - 1; i >= 0; i--) {
      var cards = groups[i].querySelector('.tc-group-cards');
      if (cards && cards.childElementCount === 0) { groups[i].remove(); }
      else { updateGroupHead(groups[i]); }
    }
  }

  var thinkTimers = {};
  function renderThinking(container, bubble) {
    var old = container.querySelector('details.thinking');
    if (old) { old.remove(); }
    if (!bubble.thinking) { return; }
    var det = document.createElement('details');
    det.className = 'thinking';
    if (!bubble.thinking.done) { det.open = true; }
    var sum = document.createElement('summary');
    var body = document.createElement('div');
    body.className = 'thinking-body';
    body.textContent = bubble.thinking.text;
    det.appendChild(sum);
    det.appendChild(body);
    function tick() {
      // P2 (QA-FILE-01): guard — durationMs may be undefined on done events; NaN would render.
      var ms = bubble.thinking.done ? (bubble.thinking.durationMs || 0) : (Date.now() - thinkStart);
      sum.textContent = 'thinking (' + (ms / 1000).toFixed(1) + 's)' + (bubble.thinking.done ? '' : ' …');
    }
    var thinkStart = Date.now() - (bubble.thinking.done ? (bubble.thinking.durationMs || 0) : 0);
    tick();
    var key = bubble.bubbleId;
    if (thinkTimers[key]) { clearInterval(thinkTimers[key]); }
    if (!bubble.thinking.done) {
      thinkTimers[key] = setInterval(function () {
        if (bubble.thinking && !bubble.thinking.done) { tick(); }
        else { clearInterval(thinkTimers[key]); tick(); }
      }, 200);
    }
    var textEl = container.querySelector('.bubble-text');
    container.insertBefore(det, textEl);
  }

  function bubbleEl(bubble) {
    var wrap = document.createElement('div');
    wrap.className = 'msg ' + bubble.role;
    wrap.setAttribute('data-bubble', bubble.bubbleId);
    var role = document.createElement('div');
    role.className = 'role';
    role.textContent = roleLabel(bubble.role) + (bubble.serverBubbleId ? ' ✓' : '');
    var text = document.createElement('div');
    text.className = 'bubble-text';
    // renderMarkdown(src) returns an XSS-safe HTML string (source escaped first).
    text.innerHTML = renderMarkdown(bubble.text);
    var tools = document.createElement('div');
    tools.className = 'tool-calls';
    for (var i = 0; i < bubble.toolCalls.length; i++) {
      appendToolCallCard(tools, bubble.toolCalls[i]);
    }
    wrap.appendChild(role);
    wrap.appendChild(text);
    wrap.appendChild(tools);
    // Cursor parity: per-human-message Restore button in the
    // human-message-action-slot (hover-revealed icon, aria-label="Restore
    // Checkpoint", no confirmation dialog). Click posts restoreCheckpoint to
    // the host, which calls revertToCheckpoint(bubbleId) immediately.
    if (bubble.role === 'human') {
      var slot = document.createElement('div');
      slot.className = 'human-message-action-slot';
      var rbtn = document.createElement('button');
      rbtn.className = 'restore-btn';
      rbtn.setAttribute('aria-label', 'Restore Checkpoint');
      rbtn.setAttribute('title', 'Restore Checkpoint');
      rbtn.innerHTML = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M13.5 8a5.5 5.5 0 1 1-1.6-3.9"/><path d="M13.7 1.8v3h-3"/></svg>';
      rbtn.addEventListener('click', function (e) {
        e.stopPropagation();
        if (e.nativeEvent && e.nativeEvent.stopImmediatePropagation) { e.nativeEvent.stopImmediatePropagation(); }
        vscodeApi.postMessage({ type: 'restoreCheckpoint', bubbleId: bubble.bubbleId });
      });
      slot.appendChild(rbtn);
      wrap.appendChild(slot);
    }
    renderThinking(wrap, bubble);
    return wrap;
  }

  /* P2 (QA-FILE-01): autoscroll only when the user is already near the
     bottom — scrolling up pauses auto-follow instead of yanking them back. */
  var autoFollow = true;
  messagesEl.addEventListener('scroll', function () {
    var gap = messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight;
    autoFollow = gap < 48;
  });
  function maybeAutoscroll() {
    if (autoFollow) { messagesEl.scrollTop = messagesEl.scrollHeight; }
  }

  function patchBubble(bubble) {
    var entry = store.get(bubble.bubbleId);
    if (!entry) {
      var el = bubbleEl(bubble);
      store.set(bubble.bubbleId, { data: bubble, el: el });
      messagesEl.appendChild(el);
    } else {
      entry.data = bubble;
      var el2 = entry.el;
      el2.querySelector('.bubble-text').innerHTML = renderMarkdown(bubble.text);
      el2.querySelector('.role').textContent = roleLabel(bubble.role) + (bubble.serverBubbleId ? ' ✓' : '');
      renderThinking(el2, bubble);
      var toolsEl = el2.querySelector('.tool-calls');
      var seen = {};
      for (var i = 0; i < bubble.toolCalls.length; i++) {
        var tc = bubble.toolCalls[i];
        seen[tc.toolCallId] = true;
        // P2 (QA-FILE-01): CSS.escape — toolCallId is engine-supplied data.
        var card = toolsEl.querySelector('[data-toolcall="' + CSS.escape(tc.toolCallId) + '"]');
        if (card) { patchToolCall(card, tc); }
        else { appendToolCallCard(toolsEl, tc); }
      }
      var cards = toolsEl.querySelectorAll('[data-toolcall]');
      for (var j = cards.length - 1; j >= 0; j--) {
        if (!seen[cards[j].getAttribute('data-toolcall')]) { cards[j].remove(); }
      }
      pruneEmptyGroups(toolsEl);
    }
    maybeAutoscroll();
  }

  function resetBubbles(bubbles) {
    for (var k in thinkTimers) { clearInterval(thinkTimers[k]); }
    thinkTimers = {};
    clearCheckedOutChip();
    store.clear();
    messagesEl.innerHTML = ${JSON.stringify(welcomeBubbleHtml(engineConnected))};
    for (var i = 0; i < bubbles.length; i++) { patchBubble(bubbles[i]); }
  }

  /* ---- Cursor parity: "checked out" chip after a restore ----
     The host posts checkpointRestored after revertToCheckpoint succeeds.
     The chip renders on the target human bubble; clicking it re-invokes
     the restore (Cursor's "revert-after-checkout"). */
  var checkedOutBubbleId = null;
  function clearCheckedOutChip() {
    if (checkedOutBubbleId !== null) {
      var prev = store.get(checkedOutBubbleId);
      if (prev && prev.el) {
        var old = prev.el.querySelector('.checked-out-chip');
        if (old) { old.remove(); }
      }
      checkedOutBubbleId = null;
    }
  }
  function showCheckedOutChip(bubbleId) {
    clearCheckedOutChip();
    checkedOutBubbleId = bubbleId;
    var entry = store.get(bubbleId);
    if (!entry || !entry.el) { return; }
    var chip = document.createElement('button');
    chip.className = 'checked-out-chip';
    chip.setAttribute('aria-label', 'Checked out at this message. Activate to restore again.');
    chip.innerHTML = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M13.5 8a5.5 5.5 0 1 1-1.6-3.9"/><path d="M13.7 1.8v3h-3"/></svg><span>Checked out</span>';
    chip.addEventListener('click', function (e) {
      e.stopPropagation();
      vscodeApi.postMessage({ type: 'restoreCheckpoint', bubbleId: bubbleId });
    });
    entry.el.appendChild(chip);
  }

  /* ---- approval card ---- */
  var approvalCard = document.getElementById('approvalCard');
  function showApproval(req) {
    approvalCard.style.display = 'block';
    approvalCard.innerHTML = '';
    var h = document.createElement('h4');
    h.id = 'approvalTitle';
    h.textContent = 'Approval needed: ' + req.title;
    approvalCard.appendChild(h);
    var ul = document.createElement('ul');
    req.reasons.forEach(function (r) {
      var li = document.createElement('li');
      li.textContent = r;
      ul.appendChild(li);
    });
    approvalCard.appendChild(ul);
    var btns = document.createElement('div');
    btns.className = 'appr-btns';
    req.options.forEach(function (opt, idx) {
      var b = document.createElement('button');
      b.textContent = opt.label;
      if (idx === 0) { b.className = 'appr-primary'; }
      b.addEventListener('click', function () {
        vscodeApi.postMessage({ type: 'approvalResolve', approvalId: req.approvalId, optionId: opt.id });
      });
      btns.appendChild(b);
    });
    approvalCard.appendChild(btns);
    // P2 (QA-FILE-01): move focus to the card so keyboard users land on it.
    approvalCard.focus();
  }
  function clearApproval() {
    // P2 (QA-FILE-01): if focus was inside the card (showApproval moved it
    // there), return it to the input instead of stranding it in the emptied
    // card — keyboard flow continues without an extra Tab hunt.
    var focusInCard = approvalCard.contains(document.activeElement);
    approvalCard.style.display = 'none';
    approvalCard.innerHTML = '';
    if (focusInCard) { inputEl.focus(); }
  }

  /* ---- @-mention system (Cursor parity: docs/rea/parity-at-mentions.md) ----
     The webview cannot query VS Code state, so @ queries go to the host:
       post {type:'mentionQuery', requestId, query} → host replies
       {type:'mentionItems', requestId, items, isLoading}.
     Selected items become chips (full mention item + uuid); on submit the
     host resolves each chip to its real context block (resolveMentionContext)
     before the prompt reaches the engine. Providers without backing data
     (docs/past-chats/mcp/canvas/pr-diff) honestly return [] — the menu only
     ever shows real, resolvable items. */
  var mentionMenu = document.getElementById('mentionMenu');
  var slashMenu = document.getElementById('slashMenu');
  var mentionReqId = 0;
  var mentionPending = 0; // requestId of the latest in-flight query
  var mentionLastQuery = '';
  var mentionQueryTimer = null;

  function mentionUuid() {
    return 'm-' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
  }

  /* Trigger mechanics (spec §1.2): @ at string start, after whitespace, or
     after (; the query runs to end of line, capped at 120 chars. */
  function detectMentionTrigger(value, caret) {
    var upto = value.slice(0, caret == null ? value.length : caret);
    var at = upto.lastIndexOf('@');
    if (at < 0) { return null; }
    if (at > 0) {
      var prev = upto[at - 1];
      if (prev !== ' ' && prev !== '\\t' && prev !== '\\n' && prev !== '(') { return null; }
    }
    var lineEnd = upto.indexOf('\\n', at);
    var raw = (lineEnd === -1 ? upto : upto.slice(0, lineEnd)).slice(at + 1);
    if (raw.length > 120) { raw = raw.slice(0, 120); }
    return { at: at, query: raw };
  }

  /* Query highlight on the menu label (spec §2 row rendering). */
  function highlightQuery(label, query) {
    var q = String(query).trim().split(/\\s+/).filter(Boolean)[0] || '';
    if (!q) { return esc(label); }
    var idx = String(label).toLowerCase().indexOf(q.toLowerCase());
    if (idx < 0) { return esc(label); }
    return esc(label.slice(0, idx)) + '<mark>' + esc(label.slice(idx, idx + q.length)) + '</mark>' + esc(label.slice(idx + q.length));
  }

  function renderMentionItems(items, isLoading, query) {
    mentionMenu.innerHTML = '';
    if (isLoading) {
      var l = document.createElement('div');
      l.className = 'menu-loading';
      l.textContent = 'Loading…';
      mentionMenu.appendChild(l);
    }
    (items || []).forEach(function (it) {
      var b = document.createElement('button');
      b.type = 'button';
      var sub = it.secondaryText || it.description || '';
      b.innerHTML = '<span class="kind">' + esc(it.mentionType || '') + '</span>' +
        '<b>@' + highlightQuery(it.label, query) + '</b>' +
        (sub ? '<span class="sub">' + esc(sub) + '</span>' : '');
      b.title = it.description || it.rawText || '';
      b.addEventListener('click', function () { insertMention(it); });
      // mousedown preventDefault keeps input focus so the click lands.
      b.addEventListener('mousedown', function (e) { e.preventDefault(); });
      mentionMenu.appendChild(b);
    });
    if (!isLoading && !(items || []).length) {
      var e = document.createElement('div');
      e.className = 'menu-empty';
      e.textContent = 'No matches';
      mentionMenu.appendChild(e);
    }
    mentionMenu.style.display = 'block';
    slashMenu.style.display = 'none';
    resetMenuSel();
  }

  /* Host → webview: menu items for the pending @ query (stale replies dropped). */
  function onMentionItems(msg) {
    if (msg.requestId !== mentionPending) { return; }
    renderMentionItems(msg.items, msg.isLoading === true, mentionLastQuery);
  }

  function requestMentionItems(query) {
    var id = ++mentionReqId;
    mentionPending = id;
    mentionLastQuery = query;
    vscodeApi.postMessage({ type: 'mentionQuery', requestId: id, query: query });
  }

  function onMentionInput() {
    var trig = detectMentionTrigger(inputEl.value, inputEl.selectionStart);
    if (!trig) { closeMenus(); return; }
    if (mentionQueryTimer) { clearTimeout(mentionQueryTimer); }
    // Show the menu immediately with a loading row (spec §1.3); items arrive async.
    renderMentionItems([], true, trig.query);
    (function (q) {
      mentionQueryTimer = setTimeout(function () { requestMentionItems(q); }, 80);
    })(trig.query);
  }

  /* Spec §3 insert behavior: chip node {id, uuid, label, rawText, plainText?,
     mentionType, secondaryText, payload}, then a trailing space. */
  function insertMention(item) {
    /* P3 (CX2b): dedupe by stable item id — selecting the same mention twice
       must not push a duplicate chip. */
    if (!chips.some(function (c) { return c.id === item.id; })) {
      chips.push({
        uuid: mentionUuid(),
        id: item.id,
        label: item.label,
        rawText: item.rawText,
        plainText: item.plainText,
        mentionType: item.mentionType,
        secondaryText: item.secondaryText,
        payload: item.payload
      });
      renderChips();
    }
    var trig = detectMentionTrigger(inputEl.value, inputEl.selectionStart);
    if (trig) {
      var v = inputEl.value;
      var cut = trig.at + 1 + trig.query.length;
      var next = v.slice(0, trig.at) + v.slice(cut);
      if (next[trig.at] !== ' ') {
        next = next.slice(0, trig.at) + ' ' + next.slice(trig.at);
      }
      inputEl.value = next;
      inputEl.selectionStart = inputEl.selectionEnd = trig.at + 1;
    }
    closeMenus();
    // The mention insert changed the content → re-morph the submit slot.
    updateSubmitButton();
    inputEl.focus();
  }

  /* Spec §4.3: programmatic removal by uuid. */
  function removeMention(remUuid) {
    chips = chips.filter(function (c) { return c.uuid !== remUuid; });
    renderChips();
    inputEl.focus();
  }

  function renderChips() {
    chipsEl.innerHTML = '';
    // DD-CM-7: the chips row lives inside the single composer box and is
    // hidden entirely when there are no chips.
    chipsEl.classList.toggle('has-chips', chips.length > 0);
    chips.forEach(function (c) {
      var s = document.createElement('span');
      s.className = 'chip';
      // Spec §4.1: chip node attributes.
      s.setAttribute('data-id', c.id || '');
      s.setAttribute('data-label', c.label || '');
      s.setAttribute('data-mention-suggestion-char', '@');
      s.setAttribute('data-uuid', c.uuid || '');
      var lab = document.createElement('span');
      lab.className = 'chip-label';
      // Image chips (browser screenshots) render a thumbnail preview.
      if (c.mentionType === 'image' && c.payload && c.payload.dataUrl) {
        var thumb = document.createElement('img');
        thumb.className = 'chip-thumb';
        thumb.src = c.payload.dataUrl;
        thumb.alt = '';
        thumb.setAttribute('aria-hidden', 'true');
        s.appendChild(thumb);
      }
      lab.textContent = '@' + (c.label || '') + ' ';
      // Spec §4.2: clickable chips (file → open, code → reveal, …).
      lab.style.cursor = 'pointer';
      (function (chip) {
        lab.addEventListener('click', function () {
          vscodeApi.postMessage({ type: 'openMention', chip: chip });
        });
      })(c);
      s.appendChild(lab);
      if (c.secondaryText) {
        var sec = document.createElement('span');
        sec.className = 'chip-sub';
        sec.textContent = c.secondaryText;
        s.appendChild(sec);
      }
      var x = document.createElement('button');
      x.type = 'button';
      x.className = 'chip-x';
      x.textContent = '×';
      // Spec §4.3: × control — role=button, aria-label; Enter/Space removes.
      x.setAttribute('role', 'button');
      x.setAttribute('tabindex', '0');
      x.setAttribute('aria-label', 'Remove @' + (c.label || '') + ' mention');
      x.setAttribute('data-mention-remove', 'true');
      (function (u) {
        x.addEventListener('click', function (e) { e.stopPropagation(); removeMention(u); });
        x.addEventListener('keydown', function (e) {
          if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); removeMention(u); }
        });
      })(c.uuid);
      s.appendChild(x);
      chipsEl.appendChild(s);
    });
  }
  function closeMenus() {
    mentionMenu.style.display = 'none';
    slashMenu.style.display = 'none';
    /* DD-CM-3: the unified add-context menu closes with the rest. */
    if (typeof addMenu !== 'undefined' && addMenu) { addMenu.style.display = 'none'; }
    /* Cursor / parity: dropping the palette also drops its trigger state and
       the ARIA selection pointer (spec §4.3/§4.5). */
    slashState = null;
    inputEl.removeAttribute('aria-activedescendant');
  }
  /* P2 (CX2b): clicking outside the menus / context popup dismisses them.
     Menu-item, input and trigger clicks are skipped via containment checks
     so toggle flows (e.g. ctxTray) aren't immediately undone by bubbling. */
  document.addEventListener('click', function (e) {
    var t = e.target;
    if (t instanceof Node) {
      if (!mentionMenu.contains(t) && !slashMenu.contains(t) && t !== inputEl) { closeMenus(); }
      if (!ctxPop.contains(t) && !ctxTray.contains(t)) { ctxPop.style.display = 'none'; }
    }
  });
  /* ---- menu keyboard navigation (ArrowUp/ArrowDown/Enter + .sel) ---- */
  var menuSelIdx = 0;
  function visibleMenu() {
    if (mentionMenu.style.display === 'block') return mentionMenu;
    if (slashMenu.style.display === 'block') return slashMenu;
    return null;
  }
  function applyMenuSel() {
    var menu = visibleMenu();
    if (!menu) return;
    var btns = menu.querySelectorAll('button');
    for (var i = 0; i < btns.length; i++) {
      btns[i].classList.toggle('sel', i === menuSelIdx);
    }
    var sel = btns[menuSelIdx];
    if (sel && sel.scrollIntoView) sel.scrollIntoView({ block: 'nearest' });
    /* Spec §4.5: listbox semantics — track the selected option for AT. */
    if (menu === slashMenu && sel && sel.id) {
      inputEl.setAttribute('aria-activedescendant', sel.id);
    } else {
      inputEl.removeAttribute('aria-activedescendant');
    }
  }
  function resetMenuSel() { menuSelIdx = 0; applyMenuSel(); }
  inputEl.addEventListener('input', function () {
    // DETAIL-CHAT §5: every keystroke re-morphs the submit slot.
    updateSubmitButton();
    var v = inputEl.value;
    if (detectMentionTrigger(v, inputEl.selectionStart)) {
      onMentionInput();
      return;
    }
    /* Cursor / parity (§4.1): '/' anywhere in the input (token start) opens
       the palette anchored at the trigger; query = text after '/' up to the
       caret. Selecting inserts '/name ' at the trigger — the host parses the
       leading '/name args…' on submit (spec §5). */
    var caretPos = inputEl.selectionStart == null ? v.length : inputEl.selectionStart;
    var slPos = findSlashTrigger(v, caretPos);
    if (slPos >= 0) {
      slashState = { pos: slPos };
      var cmds = rankSlashItems(v.slice(slPos + 1, caretPos), SLASH_ITEMS);
      if (cmds.length) {
        renderSlashMenu(cmds);
        slashMenu.style.display = 'block';
        mentionMenu.style.display = 'none';
        resetMenuSel();
        return;
      }
    }
    slashState = null;
    closeMenus();
  });

  /* ---- slash commands (Cursor / parity, parity-slash-commands.md §4) ----
     Palette items are fed by the host ({type:'slashCommands'}). Selecting
     inserts '/name ' at the trigger position (plain-text equivalent of
     Cursor's commandNode chip); the host parses the leading '/name args…'
     on submit and dispatches (spec §5). */
  var SLASH_ITEMS = [];
  var slashState = null; // {pos} — trigger index of the open palette, or null

  /* Fuzzy scorer — kept behaviorally equal to slashRegistry.ts fuzzyScore:
     exact name 100, name prefix 80, name subsequence 60, alias/keyword
     prefix 40, alias/keyword subsequence 30, description includes 10. */
  function slashIsSubseq(hay, needle) {
    var j = 0;
    for (var i = 0; i < hay.length && j < needle.length; i++) {
      if (hay[i] === needle[j]) { j++; }
    }
    return j === needle.length;
  }
  function slashFuzzyScore(q, item) {
    var query = q.trim().toLowerCase();
    if (!query) { return 1; }
    var name = String(item.name || '').toLowerCase();
    if (name === query) { return 100; }
    if (name.indexOf(query) === 0) { return 80; }
    if (slashIsSubseq(name, query)) { return 60; }
    var words = [];
    (item.aliases || []).forEach(function (a) { words.push(String(a)); });
    (item.keywords || []).forEach(function (k) { words.push(String(k)); });
    for (var i = 0; i < words.length; i++) {
      if (words[i].toLowerCase().indexOf(query) === 0) { return 40; }
    }
    for (var j = 0; j < words.length; j++) {
      if (slashIsSubseq(words[j].toLowerCase(), query)) { return 30; }
    }
    if (String(item.description || '').toLowerCase().indexOf(query) >= 0) { return 10; }
    return 0;
  }
  function rankSlashItems(query, items) {
    var q = query.trim();
    if (!q) {
      // Host pre-sorts by MRU for the empty query (spec §4.2).
      return items.slice();
    }
    var scored = [];
    for (var i = 0; i < items.length; i++) {
      var s = slashFuzzyScore(q, items[i]);
      if (s > 0) { scored.push({ item: items[i], score: s, idx: i }); }
    }
    scored.sort(function (a, b) {
      if (b.score !== a.score) { return b.score - a.score; }
      var ra = a.item.mruRank == null ? 9007199254740991 : a.item.mruRank;
      var rb = b.item.mruRank == null ? 9007199254740991 : b.item.mruRank;
      if (ra !== rb) { return ra - rb; }
      if (a.item.name < b.item.name) { return -1; }
      if (a.item.name > b.item.name) { return 1; }
      return a.idx - b.idx;
    });
    return scored.map(function (s) { return s.item; });
  }

  /* Caret-aware trigger: the last '/' at/before the caret that starts a
     token (string start or whitespace before it) with no whitespace between
     the '/' and the caret. Returns the '/' index, or -1 when absent. */
  function findSlashTrigger(v, caret) {
    for (var i = caret - 1; i >= 0; i--) {
      var ch = v[i];
      if (ch === '/') {
        if (i === 0 || /\\s/.test(v[i - 1])) { return i; }
        return -1;
      }
      if (/\\s/.test(ch)) { return -1; }
    }
    return -1;
  }

  function insertSlashCommand(c) {
    if (!slashState) { return; }
    var v = inputEl.value;
    var caret = inputEl.selectionStart == null ? v.length : inputEl.selectionStart;
    var before = v.slice(0, slashState.pos);
    var after = v.slice(caret);
    var insert = '/' + c.name + ' ';
    inputEl.value = before + insert + after;
    var np = before.length + insert.length;
    inputEl.selectionStart = inputEl.selectionEnd = np;
    slashState = null;
    closeMenus();
    // The palette insert changed the content → re-morph the submit slot.
    updateSubmitButton();
    inputEl.focus();
  }

  function renderSlashMenu(items) {
    slashMenu.innerHTML = '';
    slashMenu.setAttribute('role', 'listbox');
    slashMenu.setAttribute('aria-label', 'Slash commands');
    items.forEach(function (c, idx) {
      var b = document.createElement('button');
      b.setAttribute('role', 'option');
      b.id = 'slash-opt-' + idx;
      var tag = c.type === 'skill' ? '<span class="tag">skill</span>' : '';
      b.innerHTML = '<b>/' + esc(c.name) + '</b>' + tag +
        '<span class="sub">' + esc(c.description || '') + '</span>';
      b.addEventListener('click', function () { insertSlashCommand(c); });
      /* Spec §4.3: hover sets the selection (same as the mention menu). */
      b.addEventListener('mouseenter', function () {
        menuSelIdx = idx;
        applyMenuSel();
      });
      slashMenu.appendChild(b);
    });
  }

  /* Spec §4.1 paste: '/name args' → longest-prefix command match (our names
     never contain spaces, so the token must equal a known name), inserted as
     '/name ' + the remainder as plain text. */
  inputEl.addEventListener('paste', function (e) {
    var cd = e.clipboardData;
    if (!cd) { return; }
    var text = cd.getData('text/plain') || cd.getData('text') || '';
    if (!text || text.charAt(0) !== '/') { return; }
    var tok = /^\\/([A-Za-z0-9_/-]+)/.exec(text);
    if (!tok) { return; }
    var item = null;
    for (var i = 0; i < SLASH_ITEMS.length; i++) {
      if (String(SLASH_ITEMS[i].name).toLowerCase() === tok[1].toLowerCase()) {
        item = SLASH_ITEMS[i];
        break;
      }
    }
    if (!item) { return; }
    e.preventDefault();
    var v = inputEl.value;
    var caret = inputEl.selectionStart == null ? v.length : inputEl.selectionStart;
    var end = inputEl.selectionEnd == null ? caret : inputEl.selectionEnd;
    var rest = text.slice(tok[0].length).replace(/^\\s+/, '');
    var insert = '/' + item.name + ' ' + rest;
    inputEl.value = v.slice(0, caret) + insert + v.slice(end);
    var np = caret + insert.length;
    inputEl.selectionStart = inputEl.selectionEnd = np;
    /* Re-run the input handler so the palette state refreshes. */
    inputEl.dispatchEvent(new Event('input', { bubbles: true }));
  });

  /* ---- image attachments (agent-image-files-disk-convention) ----
     Pasting or dropping an image into the composer sends it to the host as
     a data URL ({type:'addUserImage'}); the host saves it to disk
     (<workspace>/.ide-code/attachments/ or ~/.ide-code/attachments/) and
     replies with {type:'addImageContext', filePath, ...} which renders the
     image chip. Images are NEVER inlined as base64 in the engine context —
     the <image_files> XML block lists the disk paths instead (see
     common/imageAttachments.ts). */
  var IMAGE_MIME_RE = /^image\\/(png|jpeg|webp|gif)$/;
  var IMAGE_DATA_URL_CAP = 21 * 1024 * 1024; // ~15MB decoded + base64 overhead
  function postUserImage(file) {
    if (!file || !IMAGE_MIME_RE.test(file.type || '')) { return; }
    var reader = new FileReader();
    reader.onload = function () {
      var dataUrl = String(reader.result || '');
      if (!dataUrl || dataUrl.length > IMAGE_DATA_URL_CAP) { return; }
      vscodeApi.postMessage({ type: 'addUserImage', dataUrl: dataUrl, fileName: file.name || 'image' });
    };
    reader.onerror = function () { /* ignore unreadable files */ };
    try { reader.readAsDataURL(file); } catch (e) { /* ignore */ }
  }
  function firstImageFile(list) {
    if (!list) { return null; }
    for (var i = 0; i < list.length; i++) {
      if (IMAGE_MIME_RE.test(list[i].type || '')) { return list[i]; }
    }
    return null;
  }
  inputEl.addEventListener('paste', function (e) {
    var img = firstImageFile(e.clipboardData && e.clipboardData.files);
    if (!img) { return; }
    e.preventDefault();
    postUserImage(img);
  });
  inputEl.addEventListener('drop', function (e) {
    var img = firstImageFile(e.dataTransfer && e.dataTransfer.files);
    if (!img) { return; }
    e.preventDefault();
    postUserImage(img);
  });

  /* ---- context-usage tray ----
     P3 (QA-FILE-01): the old hardcoded percentages (and the +2% bump per
     submit) were fabricated. No data is shown until the engine reports real
     figures via {type:'ctxUsage', sources:[{name,pct}]}. */
  var ctxTray = document.getElementById('ctxTray');
  var ctxPop = document.getElementById('ctxPop');
  var ctxSources = null;
  function renderCtx() {
    if (!ctxSources) {
      ctxTray.textContent = 'ctx';
      ctxPop.innerHTML = '<b>Context usage</b><div class="hint">No data yet — connect the engine for real figures.</div>';
      return;
    }
    var total = ctxSources.reduce(function (a, s) { return a + s.pct; }, 0);
    ctxTray.textContent = 'ctx ' + total + '%';
    ctxPop.innerHTML = '<b>Context usage</b>' + ctxSources.map(function (s) {
      return '<div class="row"><span>' + esc(s.name) + '</span><span>' + s.pct + '%</span></div>' +
        '<div class="bar"><i style="width:' + Math.min(100, s.pct * 4) + '%"></i></div>';
    }).join('') + '<div class="hint">Figures reported by the engine.</div>';
  }
  ctxTray.addEventListener('click', function () {
    ctxPop.style.display = ctxPop.style.display === 'block' ? 'none' : 'block';
  });
  renderCtx();

  /* ---- queue chip ---- */
  var queueChip = document.getElementById('queueChip');
  function renderQueue(n) {
    // P1 (QA-FILE-01): '' falls back to the stylesheet's display:none — use an explicit value.
    if (n > 0) { queueChip.style.display = 'inline-block'; queueChip.textContent = n + ' queued'; }
    else { queueChip.style.display = 'none'; }
  }

  /* ---- doc-gap B8: chat tab bar ---- */
  var tabBarEl = document.getElementById('tabBar');
  function renderTabs(tabs) {
    tabs = tabs || [];
    tabBarEl.innerHTML = '';
    tabs.forEach(function (t) {
      var b = document.createElement('button');
      b.className = 'ctab' + (t.active ? ' active' : '');
      b.setAttribute('role', 'tab');
      b.setAttribute('aria-selected', t.active ? 'true' : 'false');
      b.title = t.title + (t.running ? ' (running)' : '') + (t.queuedCount ? ' (' + t.queuedCount + ' queued)' : '');
      var inner = '<span class="t">' + esc(t.title) + '</span>';
      if (t.running) { inner += '<span class="spin" aria-hidden="true"></span>'; }
      // A background tab waiting on approval shows a dot (Cursor parity).
      if (t.approvalPending) { inner += '<span class="qdot" title="Waiting for approval"></span>'; }
      else if (t.queuedCount && !t.active) { inner += '<span class="qdot" title="' + t.queuedCount + ' queued"></span>'; }
      inner += '<span class="x" aria-hidden="true">×</span>';
      b.innerHTML = inner;
      b.addEventListener('click', function (e) {
        var x = e.target.closest ? e.target.closest('.x') : null;
        if (x || (e.target.className && String(e.target.className).indexOf('x') >= 0)) {
          e.stopPropagation();
          vscodeApi.postMessage({ type: 'closeTab', tabId: t.id });
        } else {
          vscodeApi.postMessage({ type: 'switchTab', tabId: t.id });
        }
      });
      // Double-click renames (inline input; Enter commits, Esc cancels).
      b.addEventListener('dblclick', function (e) {
        e.stopPropagation();
        var input = document.createElement('input');
        input.className = 'ctab-rename';
        input.value = t.title;
        input.setAttribute('aria-label', 'Rename chat tab');
        b.innerHTML = '';
        b.appendChild(input);
        input.focus();
        input.select();
        var done = false;
        function commit(save) {
          if (done) { return; }
          done = true;
          if (save && input.value.trim()) {
            vscodeApi.postMessage({ type: 'renameTab', tabId: t.id, title: input.value });
          } else {
            renderTabs(tabs);
          }
        }
        input.addEventListener('keydown', function (ke) {
          if (ke.key === 'Enter') { commit(true); }
          else if (ke.key === 'Escape') { commit(false); }
          ke.stopPropagation();
        });
        input.addEventListener('blur', function () { commit(true); });
      });
      tabBarEl.appendChild(b);
    });
    var plus = document.createElement('button');
    plus.id = 'newTabBtn';
    plus.textContent = '+';
    plus.title = 'New chat tab';
    plus.setAttribute('aria-label', 'New chat tab');
    plus.addEventListener('click', function () {
      vscodeApi.postMessage({ type: 'newTab' });
    });
    tabBarEl.appendChild(plus);
  }

  /* ---- doc-gap A14/A15: queue list ---- */
  var queueListEl = document.getElementById('queueList');
  function renderQueueList(items) {
    items = items || [];
    queueListEl.innerHTML = '';
    queueListEl.classList.toggle('has-items', items.length > 0);
    items.forEach(function (m, idx) {
      var row = document.createElement('div');
      row.className = 'qrow';
      var label = document.createElement('span');
      label.className = 'qt';
      var text = String(m.text || '');
      label.textContent = text.length > 140 ? text.slice(0, 140) + '…' : text;
      label.title = text;
      row.appendChild(label);
      if (m.overdue) {
        var od = document.createElement('span');
        od.className = 'overdue';
        od.textContent = 'overdue';
        od.title = 'Queued over 5 minutes — will run as a follow-up on the next turn (Cursor overdue-steer rule)';
        row.appendChild(od);
      }
      function mkBtn(txt, title, fn, disabled) {
        var b = document.createElement('button');
        b.textContent = txt;
        b.title = title;
        if (disabled) { b.disabled = true; }
        b.addEventListener('click', fn);
        row.appendChild(b);
        return b;
      }
      mkBtn('↑', 'Move up', function () {
        vscodeApi.postMessage({ type: 'queueMove', id: m.id, direction: -1 });
      }, idx === 0);
      mkBtn('↓', 'Move down', function () {
        vscodeApi.postMessage({ type: 'queueMove', id: m.id, direction: 1 });
      }, idx === items.length - 1);
      var send = mkBtn('Send now', 'Run this message at the next opportunity, ahead of the queue', function () {
        vscodeApi.postMessage({ type: 'queueSendNow', id: m.id });
      }, false);
      send.className = 'qsend';
      mkBtn('✕', 'Remove from queue', function () {
        vscodeApi.postMessage({ type: 'queueRemove', id: m.id });
      }, false);
      queueListEl.appendChild(row);
    });
  }

  /* ---- doc-gap A12: clarifying-question widget ---- */
  function renderQuestion(q) {
    // One pending question at a time per card; the host tracks it by questionId.
    var card = document.createElement('div');
    card.className = 'qcard';
    card.setAttribute('data-question', q.questionId);
    card.setAttribute('role', 'group');
    card.setAttribute('aria-label', 'Clarifying question: ' + q.question);
    var h = document.createElement('div');
    h.className = 'qh';
    h.textContent = q.header || 'Question';
    card.appendChild(h);
    var qq = document.createElement('div');
    qq.className = 'qq';
    qq.textContent = q.question;
    card.appendChild(qq);
    (q.options || []).forEach(function (opt) {
      var b = document.createElement('button');
      b.className = 'qo';
      b.setAttribute('data-option', opt.id);
      var lab = document.createElement('span');
      lab.textContent = opt.label;
      b.appendChild(lab);
      if (opt.description) {
        var d = document.createElement('span');
        d.className = 'qd';
        d.textContent = opt.description;
        b.appendChild(d);
      }
      b.addEventListener('click', function () {
        if (q.multiple === true) {
          // P2 (QA-CHATTABS-X2): multi-select — toggle the option, do NOT
          // submit yet. The combined answer goes out via the Done button
          // below; the question stays pending until then.
          var on = b.classList.toggle('picked');
          b.setAttribute('aria-pressed', on ? 'true' : 'false');
          return;
        }
        // Single-select: disable all options immediately (exactly-once answer).
        var btns = card.querySelectorAll('.qo');
        for (var i = 0; i < btns.length; i++) { btns[i].disabled = true; }
        b.classList.add('picked');
        vscodeApi.postMessage({ type: 'answerQuestion', questionId: q.questionId, optionId: opt.id });
      });
      card.appendChild(b);
    });
    if (q.multiple === true) {
      // P2 (QA-CHATTABS-X2): multi-select submit — all toggled options go
      // out together; the host removes the question only after this.
      var doneBtn = document.createElement('button');
      doneBtn.className = 'qo qsubmit';
      doneBtn.textContent = 'Done — send selected';
      doneBtn.addEventListener('click', function () {
        var picked = [];
        var sel = card.querySelectorAll('.qo.picked');
        for (var i = 0; i < sel.length; i++) {
          var oid = sel[i].getAttribute('data-option');
          if (oid) { picked.push(oid); }
        }
        if (picked.length === 0) { return; } // nothing selected — ignore
        var btns = card.querySelectorAll('.qo');
        for (var j = 0; j < btns.length; j++) { btns[j].disabled = true; }
        vscodeApi.postMessage({ type: 'answerQuestion', questionId: q.questionId, optionIds: picked });
      });
      card.appendChild(doneBtn);
    }
    messagesEl.appendChild(card);
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }
  function markQuestionAnswered(questionId) {
    var card = messagesEl.querySelector('[data-question="' + String(questionId).replace(/"/g, '') + '"]');
    if (!card) { return; }
    var btns = card.querySelectorAll('.qo');
    for (var i = 0; i < btns.length; i++) { btns[i].disabled = true; }
    var done = document.createElement('div');
    done.className = 'qdone';
    done.textContent = 'Answered — the agent continues with your answer.';
    card.appendChild(done);
  }
  function clearQuestions() {
    var cards = messagesEl.querySelectorAll('.qcard');
    for (var i = 0; i < cards.length; i++) { cards[i].remove(); }
  }

  /* GAPS-48B (Cursor 3.25.9 voice-toolbar-follow-up-while-running.js, bmC):
     the follow-up-while-running input shows the voice toolbar (mic) instead
     of the queue/send/steer message buttons whenever shouldShowMicWhileRunning
     is true — always in multitask mode. currentUnifiedMode tracks the live
     mode (host posts {type:'mode'}; initialized from the baked initial mode).
     The decision function is injected from the TS single source of truth. */
  var currentUnifiedMode = ${JSON.stringify(initialModeId)};
  var shouldShowMicWhileRunning = ${shouldShowMicWhileRunning.toString()};
  var voiceWhileRunningBtn = document.getElementById('voiceWhileRunning');
  function updateVoiceWhileRunning() {
    var show = turnRunning && shouldShowMicWhileRunning({ composerUnifiedMode: currentUnifiedMode });
    voiceWhileRunningBtn.style.display = show ? 'inline-flex' : 'none';
  }
  voiceWhileRunningBtn.addEventListener('click', function () {
    /* HONEST DIVERGENCE — same policy as the idle voice-chat entry: the mic
       is rendered for Cursor parity but the click is a deliberate no-op.
       This build has no STT engine and no mic capture, and the Web Speech
       API recognition service is unavailable in Electron webviews, so a
       voice button could never work. The stop control stays on the submit
       slot (Cursor's voice toolbar likewise keeps onStopClick wired while
       the turn runs), so stopping a multitask turn is never lost. */
  });

  /* ---- turn running state: the Stop morph owns the submit slot ---- */
  var sendBtn = document.getElementById('send');
  var turnRunning = false;
  // Enter-twice steer window (ms): two Enters this close while a turn runs
  // submit as "Send now" instead of queueing.
  var lastEnterAt = 0;
  /* ---- submit-slot morph (DD-CM-2/6 — verified live on Cursor 3.25.9) ----
     The slot is ONE 24px circle button (class
     ui-prompt-input-submit-button, data-size="md") whose data-state + icon
     morph with the composer content; the stop state is the SAME button, not
     a separate control.
     HONEST DIVERGENCE: Cursor's empty-input entry is a realtime voice-chat
     button. We render the same entry (mic icon, aria-label "Start voice
     chat", data-state="active" — verbatim) but the click is a deliberate
     no-op: this build has no STT engine and no mic capture, and the Web
     Speech API's recognition service is unavailable in Electron webviews
     (tied to the browser vendor's cloud, not to Chromium — Electron ships
     no speech API key), so a voice button could never work.
     Zero-placeholder policy: no fake "voice unavailable" toast, no promise
     of voice — the entry is present for parity, the click does nothing.
       input empty      → voice-chat entry: mic icon,
                          aria-label="Start voice chat" (data-state="active";
                          click = deliberate no-op)
       input non-empty  → 12px arrow-up, aria-label="Send message"
                          (data-state="active")
       turn running     → stop-circle, aria-label="Stop generation"
                          (data-state="stop"); clicking stops the turn.
     "Empty" = no non-whitespace text. Chips alone (e.g. an attached
     selection with no text) keep the voice entry — submit() refuses
     empty text anyway, so the two stay consistent. */
  var SUBMIT_ICON_SEND = ${JSON.stringify(SUBMIT_ICON_SEND)};
  var SUBMIT_ICON_VOICE = ${JSON.stringify(SUBMIT_ICON_VOICE)};
  var SUBMIT_ICON_STOP = ${JSON.stringify(SUBMIT_ICON_STOP)};
  function composerHasText() {
    return inputEl.value.trim().length > 0;
  }
  function applySubmitSlot(kind) {
    // kind: 'voice' | 'send' | 'stop'
    var icon, label, title, state, slotClass, btnDisabled;
    if (kind === 'stop') {
      icon = SUBMIT_ICON_STOP; label = 'Stop generation'; title = 'Stop generation';
      state = 'stop'; slotClass = 'slot-stop'; btnDisabled = false;
    } else if (kind === 'send') {
      icon = SUBMIT_ICON_SEND; label = 'Send message'; title = 'Send message';
      state = 'active'; slotClass = 'slot-send'; btnDisabled = false;
    } else {
      icon = SUBMIT_ICON_VOICE; label = 'Start voice chat'; title = 'Start voice chat';
      state = 'active'; slotClass = 'slot-voice'; btnDisabled = false;
    }
    sendBtn.innerHTML = icon;
    sendBtn.setAttribute('aria-label', label);
    sendBtn.setAttribute('title', title);
    sendBtn.setAttribute('data-state', state);
    sendBtn.disabled = btnDisabled;
    sendBtn.classList.remove('slot-send', 'slot-voice', 'slot-stop');
    sendBtn.classList.add(slotClass);
  }
  function updateSubmitButton() {
    if (turnRunning) { applySubmitSlot('stop'); return; }
    applySubmitSlot(composerHasText() ? 'send' : 'voice');
  }
  function setTurnRunning(running) {
    turnRunning = !!running;
    /* A finished turn re-morphs the slot to the current input content
       (e.g. back to the voice-chat entry when the input is empty). */
    updateSubmitButton();
    /* GAPS-48B: the follow-up-while-running voice toolbar (mic) appears
       only while a turn runs — and, per bmC, always in multitask mode. */
    updateVoiceWhileRunning();
  }
  // Initial paint: the composer starts empty → the voice-chat entry.
  updateSubmitButton();

  /* ---- mode chip + dropdown (Cursor parity, parity-chat-modes §1.5/§6.1) ---- */
  var MODE_DEFS = ${dropdownJson};
  var ALL_MODE_DEFS = (function () {
    var map = {};
    for (var k = 0; k < MODE_DEFS.length; k++) { map[MODE_DEFS[k].id] = MODE_DEFS[k]; }
    /* Agent is the implicit default — not in the dropdown, but the chip must
       render it with its label/placeholder. */
    map['agent'] = { id: 'agent', label: 'Agent', color: 'default', placeholder: 'Plan, Build, / for skills, @ for context', description: 'Plan, search, make edits, run commands' };
    return map;
  })();
  var modeChip = document.getElementById('modeChip');
  var modeChipLabel = document.getElementById('modeChipLabel');
  var modeMenu = document.getElementById('modeMenu');
  function defForMode(mode) { return ALL_MODE_DEFS[mode] || ALL_MODE_DEFS['agent']; }
  function renderModeMenu() {
    var html = '<div class="menu-section">Modes</div>';
    for (var k = 0; k < MODE_DEFS.length; k++) {
      var d = MODE_DEFS[k];
      html += '<button class="mode-item" data-mode="' + d.id + '">' +
        '<span class="mode-dot" style="background:' + modeColorHex(d.color) + '"></span>' +
        '<span><span>' + esc(d.label) + '</span>' +
        '<span class="mode-desc">' + esc(d.description) + '</span></span></button>';
    }
    modeMenu.innerHTML = html;
    var items = modeMenu.querySelectorAll('.mode-item');
    for (var q = 0; q < items.length; q++) {
      (function (btn) {
        btn.addEventListener('click', function () {
          modeMenu.hidden = true;
          vscodeApi.postMessage({ type: 'setMode', mode: btn.getAttribute('data-mode') });
        });
      })(items[q]);
    }
  }
  function modeColorHex(color) {
    return color === 'green' ? '#3fb950' : color === 'yellow' ? '#d29922' :
      color === 'red' ? '#f85149' : color === 'purple' ? '#bc8cff' : 'var(--vscode-foreground)';
  }
  renderModeMenu();
  modeChip.addEventListener('click', function (e) {
    e.stopPropagation();
    modeMenu.hidden = !modeMenu.hidden;
  });
  document.addEventListener('click', function (e) {
    if (!modeMenu.hidden && !document.getElementById('modeRow').contains(e.target)) {
      modeMenu.hidden = true;
    }
  });
  /* ---- "Add agents, context, tools" unified menu (DD-CM-3 — live CDP,
     Cursor 3.25.9, detail-chat §3) ----
     button.ui-icon-button[aria-label="Add agents, context, tools"] opens one
     menu with verbatim sections:
       Modes: Plan — "Generate an implementation plan" ·
              Debug — "Pinpoint the root cause of an issue" ·
              Multitask — "Orchestrate multiple subagents in parallel" ·
              Ask — "Answer questions without making edits"
              (NO "Agent" item — Agent is the implicit default, per CDP)
       Files · Model (current picker label) · MCP
     Intents: mode items post {type:'setMode'} (same path as the mode
     dropdown); Files opens the @-file picker (openFilePicker); Model posts
     {type:'openModelPicker'} (same as the model button); MCP queries the
     @-mention MCP scope — the provider honestly returns [] when no servers
     are connected, so the menu shows "No matches" instead of fake servers. */
  var addBtn = document.getElementById('addBtn');
  var addMenu = document.getElementById('addMenu');
  function currentModelPickerLabel() {
    var t = document.getElementById('modelBtn').textContent || '';
    return t.replace(/^model:\s*/, '') || 'auto';
  }
  function renderAddMenu() {
    var html = '<div class="menu-section">Modes</div>';
    for (var k = 0; k < MODE_DEFS.length; k++) {
      var d = MODE_DEFS[k];
      html += '<button class="mode-item" data-mode="' + d.id + '">' +
        '<span class="mode-dot" style="background:' + modeColorHex(d.color) + '"></span>' +
        '<span><span>' + esc(d.label) + '</span>' +
        '<span class="mode-desc">' + esc(d.description) + '</span></span></button>';
    }
    html += '<div class="menu-section">Files</div>' +
      '<button class="mode-item" data-intent="files"><span><span>Files</span></span></button>' +
      '<div class="menu-section">Model</div>' +
      '<button class="mode-item" data-intent="model"><span><span>' + esc(currentModelPickerLabel()) + '</span></span></button>' +
      '<div class="menu-section">MCP</div>' +
      '<button class="mode-item" data-intent="mcp"><span><span>MCP</span></span></button>';
    addMenu.innerHTML = html;
    var items = addMenu.querySelectorAll('.mode-item');
    for (var q = 0; q < items.length; q++) {
      (function (btn) {
        btn.addEventListener('click', function () {
          addMenu.style.display = 'none';
          var mode = btn.getAttribute('data-mode');
          if (mode) {
            vscodeApi.postMessage({ type: 'setMode', mode: mode });
            return;
          }
          var intent = btn.getAttribute('data-intent');
          if (intent === 'files') { openFilePicker(); }
          else if (intent === 'model') { vscodeApi.postMessage({ type: 'openModelPicker' }); }
          else if (intent === 'mcp') { requestMentionItems('mcp '); inputEl.focus(); }
        });
      })(items[q]);
    }
  }
  addBtn.addEventListener('click', function (e) {
    e.stopPropagation();
    renderAddMenu();
    addMenu.style.display = addMenu.style.display === 'block' ? 'none' : 'block';
  });
  document.addEventListener('click', function (e) {
    if (addMenu.style.display === 'block' && !addMenu.contains(e.target) && e.target !== addBtn) {
      addMenu.style.display = 'none';
    }
  });
  var CURSOR_PLACEHOLDER = ${JSON.stringify(CURSOR_PLACEHOLDER)};
  function setActiveMode(mode) {
    var d = defForMode(mode);
    /* GAPS-48B: track the live unified mode so the follow-up-while-running
       voice toolbar decision (bmC: multitask → always show mic) follows
       mode switches mid-turn. Unknown ids fall back to 'agent' via defForMode. */
    currentUnifiedMode = (d && d.id) || 'agent';
    updateVoiceWhileRunning();
    modeChipLabel.textContent = d.label;
    modeChip.className = 'mode-chip mode-' + d.color;
    modeChip.title = 'Chat mode: ' + d.label + ' — ' + d.description;
    /* DD-CM-4 (live CDP): the placeholder is the constant verbatim string —
       NOT per-mode (the per-mode placeholders were stale for 3.25.9). */
    inputEl.setAttribute('placeholder', CURSOR_PLACEHOLDER);
    /* Mode color accent on the submit slot (Cursor data-color via YaS):
       plan→yellow, debug→red, chat→green; agent = none. */
    if (mode === 'plan' || mode === 'debug' || mode === 'chat') {
      sendBtn.setAttribute('data-color', mode);
    } else {
      sendBtn.removeAttribute('data-color');
    }
  }
  /* Shift+Tab from the chat input cycles the mode (Cursor parity §3.1). */
  inputEl.addEventListener('keydown', function (e) {
    if (e.key === 'Tab' && e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey) {
      e.preventDefault();
      vscodeApi.postMessage({ type: 'cycleMode' });
    }
  });

  /* ---- plan tray (Cursor plan-mode parity: review → Accept / Discard) ---- */
  var planTray = document.getElementById('planTray');
  document.getElementById('acceptPlanBtn').addEventListener('click', function () {
    vscodeApi.postMessage({ type: 'acceptPlan' });
  });
  document.getElementById('discardPlanBtn').addEventListener('click', function () {
    planTray.hidden = true;
    vscodeApi.postMessage({ type: 'discardPlan' });
  });

  /* ---- submit ---- */
  // K-17 (Cursor parity): prompt history — ArrowUp/ArrowDown recall previous prompts.
  var history = [];
  var historyIdx = -1;
  var savedDraft = '';
  function resetHistoryNav() { historyIdx = -1; savedDraft = ''; }
  function navigateHistory(dir, e) {
    if (!history.length) { return; }
    var val = inputEl.value;
    var caret = inputEl.selectionStart == null ? val.length : inputEl.selectionStart;
    var firstNl = val.indexOf('\\n');
    var lastNl = val.lastIndexOf('\\n');
    var onFirstLine = firstNl === -1 || caret <= firstNl;
    var onLastLine = lastNl === -1 || caret > lastNl;
    // Only hijack the arrow when the caret is at the boundary line;
    // otherwise let it move the caret inside the multiline input.
    if (dir < 0 && !onFirstLine) { return; }
    if (dir > 0 && !onLastLine) { return; }
    e.preventDefault();
    if (historyIdx === -1) { savedDraft = val; historyIdx = history.length; }
    historyIdx += dir;
    if (historyIdx < 0) { historyIdx = 0; }
    if (historyIdx >= history.length) {
      historyIdx = -1;
      inputEl.value = savedDraft;
    } else {
      inputEl.value = history[historyIdx];
    }
    inputEl.selectionStart = inputEl.selectionEnd = inputEl.value.length;
    // History recall changes the content → re-morph the submit slot.
    updateSubmitButton();
  }
  function submit(opts) {
    opts = opts || {};
    var text = inputEl.value.trim();
    if (!text) { return; }
    var parts = [];
    chips.forEach(function (c) {
      // The @label stays in the visible prompt text (Cursor's rawText);
      // the chip's real context block is resolved host-side from mentions.
      parts.push('@' + (c.label || ''));
    });
    parts.push(text);
    /* sendMode routes the message while a turn is running (Enter → default,
       Send button → manual, Alt+Enter → queue, Cmd/Ctrl+Enter or Enter-twice
       → sendNow = bypass the queue, delivered at the next opportunity). */
    vscodeApi.postMessage({ type: 'submit', text: parts.join('\\n\\n'), fullContext: !!opts.fullContext, mentions: chips, sendMode: opts.sendMode || 'default' });
    history.push(text);
    resetHistoryNav();
    inputEl.value = '';
    chips = [];
    renderChips();
    closeMenus();
    // The composer is empty again → morph the slot back to the voice-chat entry.
    updateSubmitButton();
    // P1 (QA-FILE-01): show Stop while the turn runs; the host reports
    // {type:'turnState', running} when it starts and finishes.
    setTurnRunning(true);
  }
  sendBtn.addEventListener('click', function () {
    /* DD-CM-6: while a turn runs the SAME slot shows the stop-circle —
       clicking it stops the turn (Cursor's stop path). */
    if (turnRunning) { vscodeApi.postMessage({ type: 'stopTurn' }); return; }
    if (composerHasText()) {
      submit({ fullContext: false, sendMode: 'manual' });
      return;
    }
    /* Empty + not running: the slot shows Cursor's voice-chat entry
       (aria-label "Start voice chat") — HONEST DIVERGENCE, the click is a
       deliberate no-op. This build has no STT engine and no mic capture,
       and the Web Speech API recognition service is unavailable in
       Electron webviews, so no voice button can work. Never post a dead
       voice message to the host, and never fake it with a toast. */
  });
  /* SETTINGS-PARITY (ide.composer.cmdPFilePicker2): Cmd/Ctrl+P opens the
     file picker in the composer, without typing '@'. */
  function openFilePicker() {
    requestMentionItems('file ');
    inputEl.focus();
  }
  inputEl.addEventListener('keydown', function (e) {
    var menu = visibleMenu();
    /* Spec §4.3: arrows move (wrap), Enter or Tab (no Shift) activates,
       Shift+Tab does NOT activate, Escape is not consumed by the menu. */
    if (menu && (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'Enter' || (e.key === 'Tab' && !e.shiftKey))) {
      var btns = menu.querySelectorAll('button');
      if (btns.length) {
        e.preventDefault();
        if (e.key === 'ArrowDown') { menuSelIdx = (menuSelIdx + 1) % btns.length; }
        else if (e.key === 'ArrowUp') { menuSelIdx = (menuSelIdx - 1 + btns.length) % btns.length; }
        else { btns[menuSelIdx].click(); return; }
        applyMenuSel();
        return;
      }
    }
    /* DD-CM-5 (live CDP, Cursor 3.25.9): Tab is trapped in the editor — it
       never moves focus out of the input. (With a mention/slash menu open,
       Tab activates the selected row — handled above.) Shift+Tab still
       cycles the chat mode (separate listener below). */
    if (e.key === 'Tab' && !e.shiftKey) { e.preventDefault(); }
    // P2 (QA-FILE-01): don't submit while an IME composition is in progress.
    // Enter submits (default queue behavior); Alt+Enter always queues (Cursor parity).
    // Cmd/Ctrl+Enter bypasses the queue — delivered at the next opportune time
    // without interrupting the turn (docs/agent: "Cmd+Enter sends immediately
    // bypassing the queue"). Enter-twice while a turn runs is the same
    // "Send now" steer.
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      if (e.altKey) { submit({ sendMode: 'queue' }); }
      else if (e.metaKey || e.ctrlKey) { submit({ sendMode: 'sendNow' }); }
      else {
        var now = Date.now();
        // Enter-twice steer: two Enters within 600ms while a turn runs.
        if (turnRunning && now - lastEnterAt < 600 && inputEl.value.trim()) {
          lastEnterAt = 0;
          submit({ sendMode: 'sendNow' });
        } else {
          lastEnterAt = now;
          submit({ sendMode: 'default' });
        }
      }
    }
    // SETTINGS-PARITY (ide.composer.cmdPFilePicker2): Cmd/Ctrl+P opens the
    // file picker in the composer.
    if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && (e.key === 'p' || e.key === 'P')) {
      if (ui.cmdPFilePicker) {
        e.preventDefault();
        openFilePicker();
      }
    }
    /* DD-CM-5: Esc blurs the composer (live CDP, Cursor 3.25.9). */
    if (e.key === 'Escape') { closeMenus(); resetHistoryNav(); inputEl.blur(); }
    // K-17: prompt history navigation (skipped while a menu is open — handled above).
    if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') && !e.isComposing) {
      navigateHistory(e.key === 'ArrowUp' ? -1 : 1, e);
    }
  });
  inputEl.addEventListener('focus', function () { vscodeApi.postMessage({ type: 'inputFocus', focused: true }); });
  inputEl.addEventListener('blur', function () { vscodeApi.postMessage({ type: 'inputFocus', focused: false }); });
  document.getElementById('modelBtn').addEventListener('click', function () {
    vscodeApi.postMessage({ type: 'openModelPicker' });
  });

  /* ---- extension → webview messages ---- */
  window.addEventListener('message', function (event) {
    var msg = event.data;
    switch (msg.type) {
      case 'state':
        resetBubbles(msg.bubbles || []);
        // A full resync (tab switch / re-resolve) drops stale queue rows and
        // question cards — the host re-posts live state right after.
        renderQueueList([]);
        clearQuestions();
        break;
      case 'newChat':
        // P1 (CX1b): the host started a fresh chat — bubbles/queue/checkpoints
        // are already reset host-side (bubblesReset + queueChanged fired first).
        // Reset the remaining webview-local composer state: @-mention chips,
        // the input draft, open menus, context-usage figures and history nav.
        // (resetBubbles deliberately does NOT touch these — it only owns the
        // message list — so a transcript-only reset leaves the composer intact.)
        chips.length = 0;
        renderChips();
        inputEl.value = '';
        closeMenus();
        // New chat clears the draft → the slot morphs back to the voice-chat entry.
        updateSubmitButton();
        ctxSources = null;
        renderCtx();
        resetHistoryNav();
        renderQueueList([]);
        clearQuestions();
        /* Plan mode parity: a new chat resets the mode to agent (host also
           resets ModeService) and drops any pending plan tray. */
        setActiveMode('agent');
        document.getElementById('planTray').hidden = true;
        break;
      case 'bubbles':
        (msg.bubbles || []).forEach(patchBubble);
        break;
      case 'approval':
        if (msg.request) { showApproval(msg.request); } else { clearApproval(); }
        break;
      case 'queue':
        renderQueue(msg.length || 0);
        renderQueueList(msg.items);
        break;
      case 'tabs':
        renderTabs(msg.tabs);
        break;
      case 'question':
        if (msg.question) { renderQuestion(msg.question); }
        break;
      case 'questionAnswered':
        markQuestionAnswered(msg.questionId);
        break;
      case 'mode':
        setActiveMode(msg.mode);
        break;
      case 'planReady':
        /* A plan-mode turn completed — show the review tray. */
        document.getElementById('planTray').hidden = false;
        break;
      case 'planCleared':
        document.getElementById('planTray').hidden = true;
        break;
      case 'prefill':
        // K-14: terminal AI command — host prefills the input, user reviews and sends.
        if (typeof msg.text === 'string') {
          inputEl.value = msg.text;
          resetHistoryNav();
          // Prefilled text → the slot morphs to "Send message".
          updateSubmitButton();
          inputEl.focus();
        }
        break;
      case 'focusInput':
        // DEV-KEYBOARD-FIX: Ctrl+I "Focus Chat Input" (Cursor parity) — the
        // host reveals the chat surface first, then asks the webview to move
        // DOM focus into the composer input.
        inputEl.focus();
        break;
      case 'addSelectionContext':
        // K-07: host attaches the current editor selection as a chip.
        // Shaped as a real mention chip so the host resolves it through
        // resolveMentionContext (selectionContext payload) on submit.
        if (msg.label) {
          var label = String(msg.label);
          var content = typeof msg.content === 'string' ? msg.content : undefined;
          /* P3 (CX2b): dedup — the same selection attached twice used to
             push a duplicate chip. */
          var dup = chips.some(function (c) { return c.id === 'selection:' + label; });
          if (!dup) {
            chips.push({
              uuid: mentionUuid(),
              id: 'selection:' + label,
              label: label,
              rawText: label,
              mentionType: 'code',
              secondaryText: 'selection',
              payload: { case: 'selectionContext', label: label, content: content || '' }
            });
            renderChips();
          }
          inputEl.focus();
        }
        break;
      case 'addImageContext':
        // Browser tab: host attaches a captured screenshot as an image chip.
        // The PNG is saved on disk (msg.filePath); msg.dataUrl is only the
        // thumbnail preview. On submit the host resolves the chip to a real
        // engine file attachment (PromptInput.files) — the agent sees the
        // image. The webview is untrusted: filePath must be a plain path.
        if (typeof msg.filePath === 'string' && msg.filePath.length > 0 && msg.filePath.length <= 1024) {
          var imgLabel = typeof msg.label === 'string' && msg.label ? String(msg.label) : 'Browser screenshot';
          var imgDup = chips.some(function (c) { return c.id === 'image:' + msg.filePath; });
          if (!imgDup) {
            chips.push({
              uuid: mentionUuid(),
              id: 'image:' + msg.filePath,
              label: imgLabel,
              rawText: imgLabel,
              mentionType: 'image',
              secondaryText: 'screenshot',
              payload: {
                case: 'imageContext',
                label: imgLabel,
                filePath: String(msg.filePath),
                dataUrl: typeof msg.dataUrl === 'string' ? String(msg.dataUrl).slice(0, 8 * 1024 * 1024) : ''
              }
            });
            renderChips();
          }
          inputEl.focus();
        }
        break;
      case 'turnState':
        // P1 (QA-FILE-01): host reports turn start/finish — drives Stop/Send.
        setTurnRunning(msg.running === true);
        break;
      case 'checkpointRestored':
        // Cursor parity: restore done → webview shows the "checked out" chip
        // on the target human bubble.
        if (typeof msg.bubbleId === 'string') { showCheckedOutChip(msg.bubbleId); }
        break;
      case 'ctxUsage':
        if (Array.isArray(msg.sources)) { ctxSources = msg.sources; renderCtx(); }
        break;
      case 'mentionItems':
        // @-mention system: host resolved the pending @ query.
        onMentionItems(msg);
        break;
      case 'slashCommands':
        /* Cursor / parity: host pushes the palette registry (builtins +
           custom commands + skills, MRU-ordered for the empty query). */
        if (Array.isArray(msg.items)) { SLASH_ITEMS = msg.items; }
        break;
      case 'engineStatus':
        /* P2 (CX2b): host announces engine connection state changes
           post-render — the baked hint at render time covers the initial
           state, but a live transition (e.g. sidecar comes up/down) must
           be reflected instead of leaving a stale hint. */
        var engineHint = document.getElementById('engineHint');
        if (engineHint) {
          var connected = msg.connected === true;
          engineHint.style.display = connected ? 'none' : '';
          if (!connected) {
            engineHint.textContent =
              typeof msg.text === 'string' && msg.text ? msg.text :
              'Engine not connected — turns run against a scripted stub. Ctrl/Cmd+L new chat · Ctrl/Cmd+I inline prompt.';
          }
        }
        /* Zero-placeholder: the welcome bubble's demo-engine sentence must
           follow the same live state — it is only true while the stub runs. */
        var welcomeNote = document.getElementById('welcomeEngineNote');
        if (welcomeNote) {
          var welcomeConnected = msg.connected === true;
          welcomeNote.hidden = welcomeConnected;
          if (!welcomeConnected && !welcomeNote.textContent) {
            welcomeNote.textContent = ' Turns run against a scripted demo engine until the IDE Code engine is connected.';
          }
        }
        break;
      case 'uiConfig':
        /* SETTINGS-PARITY: live chat UI settings from the host. */
        applyUiConfig(msg.ui);
        break;
        break;
      case 'model':
        /* M-03 (model picker): host announces selection changes — the button
           always shows the current model honestly. textContent is XSS-safe. */
        var modelBtn = document.getElementById('modelBtn');
        if (modelBtn) {
          var label = typeof msg.label === 'string' && msg.label ? msg.label : 'auto';
          modelBtn.textContent = 'model: ' + label;
        }
        break;
    }
  });
})();
</script>
</body>
</html>`;
}
