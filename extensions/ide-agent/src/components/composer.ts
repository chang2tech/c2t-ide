import * as vscode from "vscode";
import { BubbleData, ModeName } from "../model";
import { MODES, DROPDOWN_MODES, modeDef } from "../services/modeService";
import { welcomeBubbleHtml } from "./bubble";

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

const DEFAULT_UI_CONFIG: ComposerUiConfig = {
  textSizeScale: 1,
  conversationDensity: "compact-all-grouped",
  codeBlockWordWrap: false,
  showEmptyStateTips: true,
  fontSmoothingAntialiased: true,
  cmdPFilePicker: true,
};

export function createComposer(
  webview: vscode.Webview,
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
  const initialDef = modeDef(MODES.some((m) => m.id === initialMode) ? initialMode : "agent");
  const initialPlaceholder = initialDef.placeholder;
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
  #modeMenu .menu-section { font-size: 11px; color: var(--vscode-descriptionForeground); padding: 4px 8px; text-transform: uppercase; letter-spacing: .04em; }
  #modeMenu .mode-item { display: flex; align-items: center; gap: 8px; width: 100%; text-align: left; background: transparent; border: 0; border-radius: 6px; padding: 6px 8px; cursor: pointer; color: var(--vscode-foreground); font-size: 12px; }
  #modeMenu .mode-item:hover { background: var(--vscode-list-hoverBackground); }
  #modeMenu .mode-item .mode-dot { width: 8px; height: 8px; border-radius: 50%; flex: none; }
  #modeMenu .mode-item .mode-desc { display: block; font-size: 11px; color: var(--vscode-descriptionForeground); }
  .plan-tray { border: 1px solid var(--vscode-panel-border); border-radius: 8px; padding: 8px; margin-bottom: 8px; background: var(--vscode-input-background); }
  .plan-tray-title { font-size: 12px; margin-bottom: 6px; }
  .plan-tray-actions { display: flex; gap: 6px; }
  .plan-accept { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: 0; border-radius: 6px; padding: 5px 12px; cursor: pointer; font-size: 12px; }
  .plan-discard { background: transparent; color: var(--vscode-foreground); border: 1px solid var(--vscode-panel-border); border-radius: 6px; padding: 5px 12px; cursor: pointer; font-size: 12px; }
  #modelBtn { margin-bottom: 8px; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border); border-radius: 6px; padding: 4px 10px; cursor: pointer; font-size: 12px; text-align: left; }
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
  #chips { display: flex; gap: 4px; flex-wrap: wrap; margin-bottom: 6px; }
  .chip { font-size: 11px; background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); border-radius: 22px; padding: 0 4px 0 12px; display: inline-flex; align-items: center; gap: 4px; min-height: 44px; box-sizing: border-box; }
  .chip button { background: transparent; border: none; color: inherit; cursor: pointer; font-size: 14px; padding: 0; min-width: 44px; min-height: 44px; display: inline-flex; align-items: center; justify-content: center; border-radius: 50%; }
  #composer { display: flex; gap: 6px; position: relative; }
  #input { flex: 1; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border); border-radius: 6px; padding: 6px; font-family: inherit; font-size: 12px; resize: none; }
  #send { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: none; border-radius: 6px; padding: 6px 14px; cursor: pointer; }
  #send.hidden { display: none; }
  #stop { display: none; background: transparent; color: var(--vscode-errorForeground); border: 1px solid var(--vscode-errorForeground); border-radius: 6px; padding: 6px 14px; cursor: pointer; }
  #stop.visible { display: inline-block; }
  .md-code { background: var(--vscode-textCodeBlock-background); border-radius: 4px; padding: 8px; overflow: auto; font-size: 11px; margin: 4px 0; }
  .md-code code { font-family: var(--vscode-editor-font-family, monospace); }
  code.md-inline { background: var(--vscode-textCodeBlock-background); border-radius: 3px; padding: 0 4px; font-size: 11px; }
  .menu { display: none; position: absolute; bottom: 100%; left: 0; right: 0; background: var(--vscode-quickInput-background); border: 1px solid var(--vscode-quickInput-border, var(--vscode-panel-border)); border-radius: 6px; max-height: 180px; overflow-y: auto; z-index: 10; margin-bottom: 4px; }
  .menu button { display: block; width: 100%; text-align: left; background: transparent; border: none; color: var(--vscode-foreground); padding: 6px 10px; cursor: pointer; font-size: 12px; }
  .menu button:hover, .menu button.sel { background: var(--vscode-list-activeSelectionBackground); color: var(--vscode-list-activeSelectionForeground); }
  .menu button.sel { outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px; }
  button:focus-visible, #input:focus-visible, .tc-head:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: 1px; }
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
  html[dir="rtl"] .chip { padding: 0 12px 0 4px; }
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
  <button id="modelBtn" title="Pick model">model: ${escHtml(modelLabel)}</button>
  <div id="messages" aria-live="polite" aria-atomic="false">${welcomeBubbleHtml()}</div>
  <div id="queueList" aria-label="Queued messages"></div>
  <div id="approvalCard" role="alertdialog" aria-modal="false" aria-labelledby="approvalTitle" tabindex="-1"></div>
  <div id="chips"></div>
  <div id="composer">
    <textarea id="input" rows="2" aria-label="Chat input" placeholder="${escHtml(initialPlaceholder)}"></textarea>
    <button id="send" title="Send (Enter)">Send</button>
    <button id="stop" title="Stop the running turn">Stop</button>
    <div class="menu" id="mentionMenu"></div>
    <div class="menu" id="slashMenu"></div>
    <div id="ctxPop"></div>
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
      if (Object.prototype.hasOwnProperty.call(next, k) && next[k] !== undefined && next[k] !== ui[k]) {
        ui[k] = next[k];
        changed = true;
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
    s = s.replace(/\x60([^\x60\n]+)\x60/g, function (m, c) {
      var i = codes.length;
      codes.push('<code>' + c + '</code>');
      return MD_INLINE_PH + i + MD_INLINE_PH;
    });
    s = s.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
    s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    s = s.replace(/(^|[^*\w])\*([^*\n]+)\*/g, '$1<em>$2</em>');
    s = s.replace(/~~([^~]+)~~/g, '<del>$1</del>');
    var phRe = new RegExp(MD_INLINE_PH + '(\d+)' + MD_INLINE_PH, 'g');
    s = s.replace(phRe, function (m, i) { return codes[+i]; });
    return s;
  }
  function renderMarkdown(src) {
    var text = esc(String(src == null ? '' : src));
    // 1. Extract fenced code blocks (\x60\x60\x60lang ... \x60\x60\x60), incl. unclosed ones.
    var blocks = [];
    text = text.replace(/\x60\x60\x60(\w*)\n?([\s\S]*?)(?:\x60\x60\x60|$)/g, function (m, lang, code) {
      var i = blocks.length;
      blocks.push(
        '<pre class="md-code"><code' + (lang ? ' data-lang="' + lang + '"' : '') + '>' +
        code.replace(/\n$/, '') + '</code></pre>');
      return MD_CODE_PH + i + MD_CODE_PH;
    });
    // 2. Block-level: headings, lists, blockquotes, paragraphs.
    var mdLines = text.split('\n');
    var html = '';
    var listOpen = false;
    var para = [];
    function flushPara() {
      if (para.length) { html += '<p>' + para.map(inlineMd).join('<br>') + '</p>'; para = []; }
    }
    function closeList() { if (listOpen) { html += '</ul>'; listOpen = false; } }
    var fenceLineRe = new RegExp('^' + MD_CODE_PH + '\d+' + MD_CODE_PH + '$');
    for (var i = 0; i < mdLines.length; i++) {
      var line = mdLines[i];
      if (fenceLineRe.test(line)) { flushPara(); closeList(); html += line; continue; }
      var h = line.match(/^(#{1,4})\s+(.*)$/);
      if (h) { flushPara(); closeList(); html += '<h' + h[1].length + '>' + inlineMd(h[2]) + '</h' + h[1].length + '>'; continue; }
      var li = line.match(/^[-*]\s+(.*)$/);
      if (li) { flushPara(); if (!listOpen) { html += '<ul>'; listOpen = true; } html += '<li>' + inlineMd(li[1]) + '</li>'; continue; }
      var q = line.match(/^&gt;\s?(.*)$/);
      if (q) { flushPara(); closeList(); html += '<blockquote>' + inlineMd(q[1]) + '</blockquote>'; continue; }
      if (/^\s*$/.test(line)) { flushPara(); closeList(); continue; }
      para.push(line);
    }
    flushPara(); closeList();
    // 3. Restore code blocks.
    var blockRe = new RegExp(MD_CODE_PH + '(\d+)' + MD_CODE_PH, 'g');
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

  /* SETTINGS-PARITY (ide.composer.conversationDensity, mirrors
     cursor.composer.conversationDensity): how tool-call cards are displayed.
     - detailed: cards render expanded (output visible).
     - compact-ungrouped: cards collapsed, click to expand (previous default).
     - compact-all-grouped: consecutive shell/edit cards collapse into one
       toggleable group card. */
  var GROUPABLE_KIND_RE = /shell|edit|apply_agent_diff/;
  function densityGrouped() { return ui.conversationDensity === 'compact-all-grouped'; }
  function densityDetailed() { return ui.conversationDensity === 'detailed'; }

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
    if (densityGrouped() && GROUPABLE_KIND_RE.test(tc.kind || '')) {
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
    messagesEl.innerHTML = ${JSON.stringify(welcomeBubbleHtml())};
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
      if (prev !== ' ' && prev !== '\t' && prev !== '\n' && prev !== '(') { return null; }
    }
    var lineEnd = upto.indexOf('\n', at);
    var raw = (lineEnd === -1 ? upto : upto.slice(0, lineEnd)).slice(at + 1);
    if (raw.length > 120) { raw = raw.slice(0, 120); }
    return { at: at, query: raw };
  }

  /* Query highlight on the menu label (spec §2 row rendering). */
  function highlightQuery(label, query) {
    var q = String(query).trim().split(/\s+/).filter(Boolean)[0] || '';
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
        if (i === 0 || /\s/.test(v[i - 1])) { return i; }
        return -1;
      }
      if (/\s/.test(ch)) { return -1; }
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
    var tok = /^\/([A-Za-z0-9_/-]+)/.exec(text);
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
    var rest = text.slice(tok[0].length).replace(/^\s+/, '');
    var insert = '/' + item.name + ' ' + rest;
    inputEl.value = v.slice(0, caret) + insert + v.slice(end);
    var np = caret + insert.length;
    inputEl.selectionStart = inputEl.selectionEnd = np;
    /* Re-run the input handler so the palette state refreshes. */
    inputEl.dispatchEvent(new Event('input', { bubbles: true }));
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

  /* ---- turn running state: Stop button <-> Send button ---- */
  var sendBtn = document.getElementById('send');
  var stopBtn = document.getElementById('stop');
  var turnRunning = false;
  // Enter-twice steer window (ms): two Enters this close while a turn runs
  // submit as "Send now" instead of queueing.
  var lastEnterAt = 0;
  function setTurnRunning(running) {
    turnRunning = !!running;
    stopBtn.classList.toggle('visible', running);
    sendBtn.classList.toggle('hidden', running);
  }
  stopBtn.addEventListener('click', function () {
    vscodeApi.postMessage({ type: 'stopTurn' });
  });

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
  function setActiveMode(mode) {
    var d = defForMode(mode);
    modeChipLabel.textContent = d.label;
    modeChip.className = 'mode-chip mode-' + d.color;
    modeChip.title = 'Chat mode: ' + d.label + ' — ' + d.description;
    /* Per-mode input placeholder (parity-chat-modes §1.6; verbatim from the
       Cursor 3.25.9 binary — DIG-DYNAMIC). */
    inputEl.setAttribute('placeholder', d.placeholder);
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
    var firstNl = val.indexOf('\n');
    var lastNl = val.lastIndexOf('\n');
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
    vscodeApi.postMessage({ type: 'submit', text: parts.join('\n\n'), fullContext: !!opts.fullContext, mentions: chips, sendMode: opts.sendMode || 'default' });
    history.push(text);
    resetHistoryNav();
    inputEl.value = '';
    chips = [];
    renderChips();
    closeMenus();
    // P1 (QA-FILE-01): show Stop while the turn runs; the host reports
    // {type:'turnState', running} when it starts and finishes.
    setTurnRunning(true);
  }
  sendBtn.addEventListener('click', function () { submit({ fullContext: false, sendMode: 'manual' }); });
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
    if (e.key === 'Escape') { closeMenus(); resetHistoryNav(); }
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
          inputEl.focus();
        }
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
