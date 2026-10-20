import * as vscode from "vscode";
import { BubbleData, ModeName } from "../model";
import { MODES, DROPDOWN_MODES, modeDef, PLAN_MODE_SUGGEST_KEYWORDS } from "../services/modeService";
import { markdownTableWebviewScript } from "../services/markdownTableService";
import { unreadDividerWebviewScript } from "./unreadDivider";
import { welcomeBubbleHtml } from "./bubble";

/**
 * GAPS-3-MODESUI / Task 4 — composer status pills above the prompt.
 *
 * Binary evidence (Cursor 3.25.9, workbench.glass.main.js):
 * - queue pill: `data-component="glass-queue-pill"`, label "Queued" + count
 *   badge (Qwt), visible iff queue count > 0 (`available: Nf>0`), click
 *   toggles the queue tray.
 * - canvas pill: `data-component="glass-canvas-pill"`, label "Canvas"
 *   (i18n glass.agentPanel.canvasPreview.anchor), visible iff activeCanvas
 *   is set, click toggles expanded, X clears the canvas.
 * - debug pill: `data-component="glass-debug-repro-pill"`, label "Debug"
 *   (i18n glass.agentPanel.debugReproPill.label), anchors the debug
 *   reproduction tray; title "Reproduction steps" / "Reproduction steps
 *   are waiting for you" + needs-attention indicator while pending.
 * - goal pill: `data-component="glass-goal-pill"`, label "Goal"
 *   (i18n glass.goalTray.pill), visible iff a goal is set
 *   (`available: r!==void 0`), click toggles, tray auto-opens.
 * - plan pill: `data-component="glass-plan-pill"`, label "Plan"
 *   (i18n glass.agentPanel.planPill.label), visible while a plan is
 *   pending review, click toggles, X dismisses.
 *
 * The webview mirrors this logic in renderPills() (inside the script
 * string below); this pure TS version is the unit-testable source of
 * truth for visibility. Exact Cursor pill ORDER and metrics are UNKNOWN
 * (minified React); our order is plan → debug → canvas → goal → queue.
 */
export type ComposerPillKind = "plan" | "debug" | "canvas" | "goal" | "queue";

export interface ComposerPillState {
  /** A plan is pending review (plan tray visible). */
  planPending: boolean;
  /** Debug repro tray is available (debug mode with repro state). */
  debugReproActive: boolean;
  /** A canvas is attached to the composer. */
  canvasActive: boolean;
  /** A goal is set on the composer. */
  goalActive: boolean;
  /** Number of queued messages. */
  queueCount: number;
}

export function visibleComposerPills(s: ComposerPillState): ComposerPillKind[] {
  const out: ComposerPillKind[] = [];
  if (s.planPending) out.push("plan");
  if (s.debugReproActive) out.push("debug");
  if (s.canvasActive) out.push("canvas");
  if (s.goalActive) out.push("goal");
  if (s.queueCount > 0) out.push("queue");
  return out;
}

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
  /** Max conversation width in px (mirrors cursor.composer.chatMaxWidth). */
  chatMaxWidth: number;
}

/** DD-CM-2/6 (Cursor 3.25.9 — live CDP + bundle static analysis):
    Cursor morphs the slot empty→voice, text→send, running→stop.
    HONEST DIVERGENCE (2026-10-19): our empty-composer slot shows a
    DISABLED send button instead of Cursor's realtime voice-chat entry.
    The Web Speech API's recognition service is unavailable in Electron
    webviews — it is tied to the browser vendor's cloud, not to Chromium,
    and Electron ships no speech API key — and this build bundles no mic
    capture or local speech-to-text engine, so a voice button could never
    work. Zero-placeholder policy: no dead buttons — the slot is visibly
    disabled until text is typed.
    States:
      - empty composer → disabled send arrow: 12px filled arrow-up,
        aria-label "Send message" (data-state="disabled", 6% ink bg /
        36% ink icon, cursor not-allowed)
      - text present   → 12px filled arrow-up (data-state="active",
        aria-label "Send message")
      - turn running   → 20px stop-circle ("xl" icon size, icon component
        kind:"stop", data-state="stop", aria-label "Stop generation")
    All inline SVG (never emoji). The same constants are baked into the
    webview script via JSON.stringify so the morph reuses identical markup
    instead of duplicating the paths. */
const SUBMIT_ICON_SEND =
  '<svg viewBox="0 0 12 12" fill="currentColor" aria-hidden="true"><path d="M6 1.2 10.8 6H7.6v4.8H4.4V6H1.2Z"/></svg>';
const SUBMIT_ICON_STOP =
  '<svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="10" cy="10" r="8" fill="none" stroke="currentColor" stroke-width="2"/><rect x="7" y="7" width="6" height="6" fill="currentColor"/></svg>';

/** DEV-GAPS-19 (2026-10-20): "+" glyph for the "Add agents, context, tools"
    button (DETAIL-CHAT §3: `button.ui-icon-button`). Inline SVG, never emoji. */
const ADD_CONTEXT_ICON =
  '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><path d="M8 3v10M3 8h10"/></svg>';

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
  /* CHAT-WIDTH: our 900px default (Cursor canonical default UNKNOWN —
     see services/chatWidthService.ts). */
  chatMaxWidth: 900,
};

export function createComposer(
  webview: vscode.Webview,
  initialMode: ModeName,
  engineConnected: boolean,
  uiLang: string = "en",
  dir: "ltr" | "rtl" = "ltr",
  /* M-03 (model picker): label baked at render time (escaped); post-render
     changes arrive via {type:'model'} and use textContent (XSS-safe). */
  modelLabel: string = "Auto",
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
  /* GAPS-3-MODESUI / Task 3: the binary-verbatim plan-suggest keyword list
     (modeService.PLAN_MODE_SUGGEST_KEYWORDS), baked so the webview can run
     the same heuristic without a host round-trip. */
  const planKeywordsJson = JSON.stringify(PLAN_MODE_SUGGEST_KEYWORDS).replace(/</g, "\\u003c");
  const initialDef = modeDef(MODES.some((m) => m.id === initialMode) ? initialMode : "agent");
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
    /* DEV-GAPS-77 (W77D): Cursor `glass.copy-plan-markdown` parity — the plan
       tab header's `onCopyAsMarkdown` action (binary PlanTabContent, 3.25.9
       @32802481). The fork's plan review surface is this tray, so the action
       lives here: host copies the pending plan markdown with the
       binary-verbatim toast/log flow. */
    `<button id="copyPlanMarkdownBtn" class="plan-copy" title="Copy plan markdown">Copy as Markdown</button>` +
    `</div></div>`;
  /* GAPS-157 (plan-find-in-plan): the plan find bar — Cursor's glass plan
     tab renders the generic rich-text find bar with
     data-component="plan-tab-find-bar" (config D2_ @32788864, zIndex 2).
     The fork's plan surface is this tray + the plan bubble in the
     transcript, so the bar is an overlay sibling (same shell as the chat
     find bar), shown only while a pending plan exists. Icons are inline
     SVG — never emoji (quality gate). */
  const planFindBarHtml =
    `<div id="planFindBar" class="find-bar plan-find-bar" hidden role="search" aria-label="Find in Plan" data-component="plan-tab-find-bar">` +
    `<input id="planFindInput" class="find-input" type="text" placeholder="Find in Plan" aria-label="Find in Plan" autocomplete="off" spellcheck="false">` +
    `<span id="planFindCount" class="find-count" aria-live="polite"></span>` +
    `<button id="planFindPrev" class="find-nav" title="Previous match (Shift+Enter)" aria-label="Previous match"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 10l4-4 4 4"/></svg></button>` +
    `<button id="planFindNext" class="find-nav" title="Next match (Enter)" aria-label="Next match"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 6l4 4 4-4"/></svg></button>` +
    `<button id="planFindClose" class="find-nav" title="Close (Escape)" aria-label="Close Plan Find"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8"/></svg></button>` +
    `</div>`;
  /* GAPS-46D (agent-custom-modes): active-mode badge in the chat input
     (binary custom-mode-actions.react.js; docs: "the optional `icon` and
     `color` frontmatter fields style the mode's badge"). Rendered by
     renderCustomModeBadge() below. */
  const customModeBadgeHtml =
    `<div id="customModeBadge" class="cm-badge" hidden>` +
    `<span class="cm-badge-icon" id="cmBadgeIcon" aria-hidden="true"></span>` +
    `<span class="cm-badge-label" id="cmBadgeLabel"></span>` +
    `<button id="cmBadgeExit" class="cm-badge-x" title="Exit custom mode" aria-label="Exit custom mode">&times;</button>` +
    `</div>`;
  /* markdown-table-expand-copy: the browser half of markdownTableService is
     interpolated into the webview <script> below. Its output is unit-tested
     to contain no backticks / ${ so this template literal stays intact. */
  const tableHoverScript = markdownTableWebviewScript();
  /* composer-unread-divider: the browser half of unreadDivider.ts is
     interpolated into the webview <script> below (same pattern as the table
     hover script). Its output is unit-tested to contain no backticks / ${ so
     this template literal stays intact. */
  const unreadDividerScript = unreadDividerWebviewScript();

  return `<!DOCTYPE html>
<html lang="${htmlLang}" dir="${dir}">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
<style>
  body { font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); color: var(--vscode-foreground); background: var(--vscode-sideBar-background); margin: 0; padding: 8px; display: flex; flex-direction: column; height: 100vh; box-sizing: border-box; position: relative; }
  header { display: flex; align-items: center; margin-bottom: 8px; }
  header h2 { font-size: 13px; margin: 0; }
  #queueChip { display: none; font-size: 11px; background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); border-radius: 10px; padding: 1px 8px; margin-left: 8px; }
  /* DEV-GAPS-32 cloud-run-on-picker (Cursor 3.25.9 live CDP, DETAIL-CHAT §7):
     Agents-window IDE/Cloud tab switcher (BUTTON with SPAN "IDE" / SPAN
     "Cloud") plus the "Run on" picker shown on the Cloud tab — 3 verbatim
     options (Cloud / This Computer / Remote Machine) and the verbatim
     sandbox description. */
  #runEnvSwitcher { display: inline-flex; margin-left: auto; background: var(--vscode-editorWidget-background, var(--vscode-sideBar-background)); border: 1px solid var(--vscode-panel-border); border-radius: 999px; padding: 2px; gap: 2px; }
  .run-env-btn { background: transparent; border: 0; border-radius: 999px; color: var(--vscode-descriptionForeground); cursor: pointer; font-size: 11px; padding: 2px 10px; line-height: 1.4; }
  .run-env-btn:hover { color: var(--vscode-foreground); }
  .run-env-btn.active { background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); font-weight: 600; }
  .run-on-section { border: 1px solid var(--vscode-panel-border); border-radius: 8px; padding: 10px 12px; margin-bottom: 8px; background: var(--vscode-editor-background); }
  .run-on-title { font-size: 11px; text-transform: uppercase; letter-spacing: .04em; color: var(--vscode-descriptionForeground); margin-bottom: 8px; }
  .run-on-options { display: flex; gap: 6px; }
  .run-on-option { flex: 1; background: transparent; border: 1px solid var(--vscode-panel-border); border-radius: 6px; color: var(--vscode-foreground); cursor: pointer; font-size: 12px; padding: 6px 8px; text-align: center; }
  .run-on-option:hover { border-color: var(--vscode-focusBorder); }
  .run-on-option.selected { border-color: var(--vscode-focusBorder); background: var(--vscode-list-activeSelectionBackground, transparent); }
  .run-on-note { font-size: 11px; color: var(--vscode-descriptionForeground); margin-top: 8px; }
  .run-on-unavailable { font-size: 11px; color: var(--vscode-charts-orange, #e8a13c); margin-top: 8px; }
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
  .ctab .pin { flex: none; width: 10px; height: 10px; color: var(--vscode-descriptionForeground); }
  .ctab-rename { width: 110px; font-size: 11px; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-focusBorder); border-radius: 4px; padding: 1px 4px; }
  /* Cursor 2.1 pin parity: tab-bar context menu (Pin chat / Unpin chat). */
  #tabCtxMenu { position: fixed; z-index: 100; min-width: 150px; background: var(--vscode-quickInput-background); border: 1px solid var(--vscode-quickInput-border, var(--vscode-panel-border)); border-radius: 6px; padding: 4px; box-shadow: 0 8px 24px rgba(0,0,0,.35); }
  #tabCtxMenu button { display: block; width: 100%; text-align: left; background: transparent; border: 0; border-radius: 4px; padding: 6px 10px; cursor: pointer; color: var(--vscode-foreground); font-size: 12px; }
  #tabCtxMenu button:hover { background: var(--vscode-list-hoverBackground); }
  #newTabBtn { flex: none; background: transparent; border: none; color: var(--vscode-descriptionForeground); cursor: pointer; font-size: 14px; padding: 2px 8px; border-radius: 6px; }
  #newTabBtn:hover { color: var(--vscode-foreground); background: var(--vscode-toolbar-hoverBackground, transparent); }
  /* Doc-gap A14/A15: queue list — queued messages below the transcript, each
     with reorder / delete / send-now controls. */
  #queueList { display: none; border: 1px solid var(--vscode-panel-border); border-radius: 6px; margin: 6px 0; overflow: hidden; }
  #queueList.has-items { display: block; }
  .qrow { display: flex; align-items: center; gap: 6px; padding: 5px 8px; font-size: 11px; border-top: 1px solid var(--vscode-panel-border); }
  .qrow:first-child { border-top: none; }
  .qrow .qt { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--vscode-foreground); }
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
  /* CONTEXT RING (Cursor 3.25.9 parity): the ring sits NEXT TO the prompt input
     (docs: "The context ring next to your prompt input shows how full the
     window is at a glance"). Binary hooks: 'contextUsageRing' (4),
     '.context-usage-tray' (16). HONEST-DIVERGENCE: Cursor's exact ring hue and
     geometry are minified (UNKNOWN) — 22px SVG ring, theme accent arc, and a
     rounded-% center label (binary 34950129: percent=Math.round(...)). */
  .context-usage-ring { width: 24px; height: 24px; flex: none; padding: 0; border: none; border-radius: 9999px; background: transparent; cursor: pointer; display: inline-flex; align-items: center; justify-content: center; }
  .context-usage-ring:hover { background: var(--vscode-toolbar-hoverBackground); }
  .context-usage-ring:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: 1px; }
  .context-usage-ring text { font-size: 7.5px; fill: var(--vscode-descriptionForeground); text-anchor: middle; dominant-baseline: central; }
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
  /* DEV-GAPS-19 (2026-10-20): the "+" add-context button + menu (Cursor
     3.25.9 live CDP, DETAIL-CHAT §3). The menu opens UPWARD from the
     toolbar, so it anchors to the toolbar-left row (position:relative). */
  .composer-toolbar-left { position: relative; }
  .add-context-btn { display: inline-flex; align-items: center; justify-content: center; width: 24px; height: 24px; flex: none; padding: 0; border: 0; border-radius: 6px; background: transparent; color: var(--vscode-foreground); cursor: pointer; }
  .add-context-btn svg { width: 16px; height: 16px; }
  .add-context-btn:hover { background: var(--vscode-toolbar-hoverBackground); }
  #addContextMenu { position: absolute; bottom: 100%; left: 0; margin-bottom: 4px; z-index: 60; min-width: 260px; background: var(--vscode-quickInput-background); border: 1px solid var(--vscode-quickInput-border, var(--vscode-panel-border)); border-radius: 8px; padding: 4px; box-shadow: 0 8px 24px rgba(0,0,0,.35); }
  #addContextMenu .menu-section { font-size: 11px; color: var(--vscode-descriptionForeground); padding: 4px 8px; text-transform: uppercase; letter-spacing: .04em; }
  #addContextMenu .ac-item { display: flex; align-items: center; gap: 8px; width: 100%; text-align: left; background: transparent; border: 0; border-radius: 6px; padding: 6px 8px; cursor: pointer; color: var(--vscode-foreground); font-size: 12px; }
  #addContextMenu .ac-item:hover { background: var(--vscode-list-hoverBackground); }
  #addContextMenu .ac-item .mode-dot { width: 8px; height: 8px; border-radius: 50%; flex: none; }
  #addContextMenu .ac-item .ac-label { display: block; }
  #addContextMenu .ac-item .ac-desc { display: block; font-size: 11px; color: var(--vscode-descriptionForeground); }
  #addContextMenu .ac-item .ac-sub { margin-left: auto; font-size: 11px; color: var(--vscode-descriptionForeground); flex: none; }
  .plan-tray { border: 1px solid var(--vscode-panel-border); border-radius: 8px; padding: 8px; margin-bottom: 8px; background: var(--vscode-input-background); }
  .plan-tray-title { font-size: 12px; margin-bottom: 6px; }
  .plan-tray-actions { display: flex; gap: 6px; }
  /* GAPS-46D (agent-custom-modes): active custom-mode badge.
     HONEST-DIVERGENCE: Cursor's exact badge palette is minified (UNKNOWN);
     colorId maps onto the theme palette conservatively. */
  .cm-badge { display: inline-flex; align-items: center; gap: 6px; font-size: 11px;
    line-height: 1; border: 1px solid var(--vscode-focusBorder); border-radius: 12px;
    padding: 4px 6px 4px 10px; margin: 0 8px 6px; max-width: 280px;
    background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); }
  .cm-badge[hidden] { display: none; }
  .cm-badge .cm-badge-icon { display: inline-flex; flex: none; }
  .cm-badge .cm-badge-icon svg { width: 12px; height: 12px; }
  .cm-badge .cm-badge-label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 600; }
  .cm-badge .cm-badge-x { background: transparent; border: none; color: inherit; cursor: pointer;
    font-size: 12px; line-height: 1; padding: 0 2px; border-radius: 50%; }
  .cm-badge .cm-badge-x:hover { background: rgba(0,0,0,.12); }
  .cm-badge[data-color="yellow"] { border-color: var(--vscode-charts-yellow, #e5c07b); }
  .cm-badge[data-color="red"] { border-color: var(--vscode-charts-red, #d16969); }
  .cm-badge[data-color="green"] { border-color: var(--vscode-charts-green, #73c991); }
  .cm-badge[data-color="purple"] { border-color: var(--vscode-charts-purple, #c586c0); }
  .cm-badge[data-color="blue"] { border-color: var(--vscode-charts-blue, #4fc1ff); }
  .cm-badge[data-color="orange"] { border-color: var(--vscode-charts-orange, #e8a13c); }
  /* GAPS-46D: "Use as Mode" row action on skill entries in the / menu. */
  .menu button { position: relative; }
  .slash-use-mode { position: absolute; right: 8px; top: 50%; transform: translateY(-50%);
    font-size: 10px; color: var(--vscode-textLink-foreground);
    border: 1px solid var(--vscode-panel-border); border-radius: 8px; padding: 1px 7px; cursor: pointer; }
  .slash-use-mode:hover { border-color: var(--vscode-focusBorder); }
  .slash-use-mode:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: 1px; }
  .plan-accept { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: 0; border-radius: 6px; padding: 5px 12px; cursor: pointer; font-size: 12px; }
  .plan-discard { background: transparent; color: var(--vscode-foreground); border: 1px solid var(--vscode-panel-border); border-radius: 6px; padding: 5px 12px; cursor: pointer; font-size: 12px; }
  /* DEV-DEBUG-HOLD-UI (spec D5): Debug Logs block — header "Debug Logs" +
     count badge, empty state "Waiting for log entries...", time+message
     lines in monospace 11px, Proceed / Mark fixed actions. Visible only in
     debug mode (hidden attribute). */
  .debug-logs { border: 1px solid var(--vscode-panel-border); border-radius: 8px; margin-bottom: 8px; background: var(--vscode-input-background); overflow: hidden; }
  .debug-logs-header { display: flex; align-items: center; gap: 8px; padding: 6px 10px; border-bottom: 1px solid var(--vscode-panel-border); }
  .debug-logs-title { font-size: 12px; font-weight: 600; }
  .debug-logs-count { font-size: 11px; background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); border-radius: 10px; padding: 1px 8px; }
  .debug-logs-body { max-height: 220px; overflow-y: auto; padding: 6px 10px; }
  .debug-logs-empty { font-size: 11px; color: var(--vscode-descriptionForeground); padding: 8px 0; }
  /* Waiting indicator: pulsing dot while the agent waits for the repro. */
  .debug-logs-empty[data-waiting="true"]::before { content: ""; display: inline-block; width: 6px; height: 6px; border-radius: 50%; background: var(--vscode-progressBar-background); margin-right: 6px; animation: debug-wait-pulse 1.2s ease-in-out infinite; }
  @keyframes debug-wait-pulse { 0%, 100% { opacity: 0.35; } 50% { opacity: 1; } }
  .debug-log-line { display: flex; gap: 8px; font-family: var(--vscode-editor-font-family, monospace); font-size: 11px; line-height: 1.5; padding: 1px 0; }
  .debug-log-time { color: var(--vscode-descriptionForeground); flex: none; }
  .debug-log-message { white-space: pre-wrap; word-break: break-word; }
  .debug-logs-actions { display: flex; gap: 6px; padding: 8px 10px; border-top: 1px solid var(--vscode-panel-border); }
  .debug-proceed { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: 0; border-radius: 6px; padding: 5px 12px; cursor: pointer; font-size: 12px; }
  .debug-mark-fixed { background: transparent; color: var(--vscode-foreground); border: 1px solid var(--vscode-panel-border); border-radius: 6px; padding: 5px 12px; cursor: pointer; font-size: 12px; }
  /* #modelBtn now lives in the composer toolbar row — styled there. */
  #messages { flex: 1; overflow-y: auto; display: flex; flex-direction: column; gap: 8px; margin-bottom: 8px;
    /* CHAT-WIDTH (ide.composer.chatMaxWidth): max-width comes from the
       --ide-chat-max-width var set by applyUiConfig (baked config at render
       + live {type:'uiConfig'} updates on setting change). width:100%
       keeps narrow panels filled; align-self:center centres the column in
       the flex-column body when it is narrower than the panel. */
    width: 100%; max-width: var(--ide-chat-max-width, 900px); align-self: center; }
  /* FIND-IN-CHAT (ide.findInChat): the VS Code native find widget cannot
     search inside a webview, so the chat owns its own overlay find bar
     (Cursor parity: Cmd/Ctrl+F while the chat is focused shows a find
     overlay over the transcript). Anchored to body (position: relative). */
  .find-bar { position: absolute; top: 40px; right: 10px; z-index: 60; display: flex; align-items: center; gap: 2px; background: var(--vscode-editorWidget-background, var(--vscode-sideBar-background)); border: 1px solid var(--vscode-editorWidget-border, var(--vscode-panel-border)); border-radius: 6px; padding: 4px 6px; box-shadow: 0 4px 14px rgba(0,0,0,.28); }
  .find-bar[hidden] { display: none; }
  /* GAPS-157 (plan-find-in-plan): the plan find bar sits above the chat
     find bar if both are ever forced open (the core when-clauses keep
     them mutually exclusive in practice). */
  .plan-find-bar { z-index: 61; }
  .find-nav[disabled] { opacity: .4; cursor: default; }
  .find-nav[disabled]:hover { background: transparent; }
  /* GAPS-131 mention-link-toolbar: CSS verbatim from Cursor 3.25.9
     workbench.desktop.main.css (offset 1240870): .mention-link-toolbar-item
     and .fade-in are byte-for-byte; the toolbar shell styles are applied
     inline by the renderer in the binary (position fixed, z-index 100001,
     display flex, align-items center, gap 2px, padding 2px, border-radius
     4px, background var(--vscode-editor-background), 1px solid theme
     border) and are mirrored here as a class for the webview DOM. */
  .mention-link-toolbar { position: fixed; z-index: 100001; display: flex; align-items: center; gap: 2px; padding: 2px; border-radius: 4px; background-color: var(--vscode-editor-background); border: 1px solid var(--vscode-editorWidget-border, var(--vscode-panel-border)); }
  .mention-link-toolbar[hidden] { display: none; }
  .mention-link-toolbar-backdrop { position: fixed; top: 0; left: 0; bottom: 0; right: 0; z-index: 100000; }
  .mention-link-toolbar-backdrop[hidden] { display: none; }
  .mention-link-toolbar-item { align-items: center; border-radius: 2px; cursor: pointer; display: flex; font-size: 10px; gap: 4px; padding: 2px 4px; }
  .mention-link-toolbar-item:hover { background-color: rgba(0,0,0,.2); }
  .mention-link-toolbar-item svg { display: block; }
  .fade-in { animation: fade-in .3s ease-in-out; }
  @keyframes fade-in { 0% { opacity: 0; } to { opacity: 1; } }
  .find-input { width: 170px; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border, var(--vscode-panel-border)); border-radius: 4px; padding: 3px 6px; font-size: 12px; outline: none; }
  .find-input:focus { border-color: var(--vscode-focusBorder); }
  .find-count { font-size: 11px; color: var(--vscode-descriptionForeground); min-width: 56px; text-align: center; white-space: nowrap; user-select: none; }
  .find-nav { background: transparent; border: none; color: var(--vscode-foreground); cursor: pointer; border-radius: 4px; padding: 3px; display: inline-flex; align-items: center; justify-content: center; }
  .find-nav:hover { background: var(--vscode-toolbar-hoverBackground); }
  .find-nav svg { width: 14px; height: 14px; display: block; }
  mark.find-match { background: var(--vscode-editor-findMatchBackground, rgba(234,179,8,.45)); color: inherit; border-radius: 2px; padding: 0 1px; }
  mark.find-match.find-current { background: var(--vscode-editor-findMatchHighlightBackground, rgba(249,115,22,.6)); outline: 1px solid var(--vscode-focusBorder, #007fd4); }
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
  /* markdown-table-expand-copy (markdownTableService): rendered GFM tables,
     hover toolbar, and the full-size expand modal. */
  .bubble-text table.md-table { border-collapse: collapse; margin: 6px 0; font-size: 12px; }
  .bubble-text table.md-table th, .bubble-text table.md-table td { border: 1px solid var(--vscode-panel-border); padding: 4px 10px; text-align: left; }
  .bubble-text table.md-table thead th { background: var(--vscode-editor-inactiveSelectionBackground, rgba(128,128,128,.12)); font-weight: 600; }
  .bubble-text table.md-table a { color: var(--vscode-textLink-foreground); }
  .md-table-wrap { position: relative; overflow-x: auto; margin: 6px 0; }
  .md-table-wrap > table.md-table { margin: 0; }
  .md-table-toolbar { position: absolute; top: 4px; right: 4px; display: none; gap: 4px; align-items: center; background: var(--vscode-editorWidget-background, var(--vscode-sideBar-background)); border: 1px solid var(--vscode-panel-border); border-radius: 6px; padding: 3px; box-shadow: 0 4px 14px rgba(0,0,0,.25); z-index: 5; }
  .md-table-wrap:hover .md-table-toolbar, .md-table-wrap:focus-within .md-table-toolbar { display: flex; }
  .md-table-btn { font-size: 11px; background: transparent; border: 0; border-radius: 4px; color: var(--vscode-foreground); padding: 3px 8px; cursor: pointer; white-space: nowrap; }
  .md-table-btn:hover { background: var(--vscode-toolbar-hoverBackground); }
  .md-table-menu { position: absolute; top: 100%; right: 0; margin-top: 2px; background: var(--vscode-quickInput-background); border: 1px solid var(--vscode-panel-border); border-radius: 6px; padding: 4px; box-shadow: 0 8px 24px rgba(0,0,0,.35); z-index: 6; min-width: 190px; }
  .md-table-menuitem { display: block; width: 100%; text-align: left; font-size: 12px; background: transparent; border: 0; border-radius: 4px; color: var(--vscode-foreground); padding: 6px 10px; cursor: pointer; white-space: nowrap; }
  .md-table-menuitem:hover { background: var(--vscode-list-hoverBackground); }
  .md-table-modal-overlay { position: fixed; inset: 0; background: rgba(0,0,0,.55); z-index: 1000; display: flex; align-items: center; justify-content: center; padding: 24px; box-sizing: border-box; }
  .md-table-modal-panel { background: var(--vscode-editor-background); border: 1px solid var(--vscode-panel-border); border-radius: 8px; max-width: min(1100px, 94vw); max-height: 88vh; width: max-content; min-width: 320px; display: flex; flex-direction: column; box-shadow: 0 24px 64px rgba(0,0,0,.5); }
  .md-table-modal-bar { display: flex; align-items: center; justify-content: space-between; padding: 10px 14px; border-bottom: 1px solid var(--vscode-panel-border); }
  .md-table-modal-title { font-size: 13px; font-weight: 600; }
  .md-table-modal-close { background: transparent; border: 0; color: var(--vscode-foreground); font-size: 16px; cursor: pointer; border-radius: 4px; padding: 2px 8px; }
  .md-table-modal-close:hover { background: var(--vscode-toolbar-hoverBackground); }
  .md-table-modal-body { padding: 14px; overflow: auto; }
  .md-table-modal-body table.md-table { table-layout: fixed; width: 100%; margin: 0; border-collapse: collapse; font-size: 12px; }
  .md-table-modal-body table.md-table th, .md-table-modal-body table.md-table td { border: 1px solid var(--vscode-panel-border); padding: 6px 10px; overflow-wrap: anywhere; word-break: break-word; vertical-align: top; }
  .md-table-modal-body table.md-table thead th { background: var(--vscode-editor-inactiveSelectionBackground, rgba(128,128,128,.12)); }
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
  /* GAPS-12 (approval-card-diff): unified diff of the proposed file edit
     (context 2, Cursor parity). Scrolls instead of truncating so large
     diffs stay fully reviewable; colors come from the theme's diff
     palette, never hardcoded. */
  .appr-diff { margin: 6px 0; max-height: 220px; overflow: auto; background: var(--vscode-textCodeBlock-background); border: 1px solid var(--vscode-panel-border); border-radius: 6px; padding: 6px 0; font-family: var(--vscode-editor-font-family, monospace); font-size: 11px; line-height: 1.45; }
  .appr-diff .adl { padding: 0 8px; white-space: pre-wrap; overflow-wrap: anywhere; }
  .appr-diff .adl-add { background: var(--vscode-diffEditor-insertedLineBackground); color: var(--vscode-diffEditorOverview-insertedForeground); }
  .appr-diff .adl-del { background: var(--vscode-diffEditor-removedLineBackground); color: var(--vscode-diffEditorOverview-removedForeground); }
  .appr-diff .adl-hunk, .appr-diff .adl-file { color: var(--vscode-descriptionForeground); }
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
  #composer { display: flex; flex-direction: column; gap: 6px; position: relative; box-sizing: border-box;
    background: rgba(252,252,252,0.9); border: 1px solid rgba(20,20,20,0.2);
    border-radius: 12px; padding: 8px 10px 6px 10px; margin: 0 8px; }
  /* DD-CM-3/5: 14px/22px system-ui, #141414 text, caret same color; the box
     owns the background and border, the editor is borderless. Tab is trapped
     in JS (see keydown); Shift+Enter inserts a newline natively; Esc blurs.
     HONEST DIVERGENCE: Cursor's editor is a Lexical rich-text instance
     (mention chips as editor nodes, Tab handled internally); ours is a plain
     textarea implementing the same keyboard contract — no rich nodes, no
     IME-aware rich selection. */
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
     morphs empty→disabled-send, text→send, running→stop.
     HONEST DIVERGENCE: Cursor shows a realtime voice-chat entry when the
     input is empty; we show a disabled send button (see the header comment
     on SUBMIT_ICON_SEND — the Web Speech API recognition service is
     unavailable in Electron webviews and this build bundles no STT engine,
     so a voice button could never work). Tokens:
       active   bg #141414 / icon #fcfcfc, hover opacity .9
       disabled bg 6% ink / icon 36% ink, cursor not-allowed
       stop     bg 8% ink / icon #141414, hover bg 14% + icon 66% ink
     Icon sizes: send 12px (arrow-up), stop 20px. */
  #send.ui-prompt-input-submit-button { width: 24px; height: 24px; flex: none; padding: 0; border: none; border-radius: 9999px; cursor: pointer; display: inline-flex; align-items: center; justify-content: center; }
  #send[data-state="active"] { background: #141414; color: #fcfcfc; }
  #send[data-state="active"]:hover { opacity: 0.9; }
  #send.slot-send svg { width: 12px; height: 12px; display: block; flex: none; }
  #send[data-state="disabled"] { background: rgba(20,20,20,0.06); color: rgba(20,20,20,0.36); cursor: not-allowed; }
  #send[data-state="disabled"] svg { width: 12px; height: 12px; display: block; flex: none; }
  #send[data-state="stop"] { background: rgba(20,20,20,0.08); color: #141414; }
  #send[data-state="stop"]:hover { background: rgba(20,20,20,0.14); color: rgba(20,20,20,0.66); }
  #send[data-state="stop"] svg { width: 20px; height: 20px; display: block; flex: none; }
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
  #ctxPop { display: none; position: absolute; bottom: 100%; right: 0; width: 260px; background: var(--vscode-quickInput-background); border: 1px solid var(--vscode-panel-border); border-radius: 6px; padding: 8px; z-index: 10; margin-bottom: 4px; font-size: 11px; }
  #ctxPop .row { display: flex; align-items: center; gap: 6px; padding: 2px 4px; border-radius: 3px; margin-bottom: 1px; }
  #ctxPop .row.hl { background: var(--vscode-list-hoverBackground); }
  #ctxPop .dot { width: 8px; height: 8px; border-radius: 50%; flex: none; }
  #ctxPop .nm { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  #ctxPop .tk { color: var(--vscode-descriptionForeground); font-variant-numeric: tabular-nums; }
  #ctxPop .pc { width: 34px; text-align: right; font-variant-numeric: tabular-nums; }
  /* Stacked category bar (Cursor parity: 8 segments, one per category). */
  #ctxBar { display: flex; height: 6px; border-radius: 3px; overflow: hidden; background: var(--vscode-progressBar-background); margin: 6px 0 8px; }
  #ctxBar .seg { height: 100%; min-width: 0; transition: filter 0.12s; }
  #ctxBar .seg.hl { filter: brightness(1.6); outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px; }
  #ctxPop .total { display: flex; justify-content: space-between; color: var(--vscode-descriptionForeground); border-top: 1px solid var(--vscode-panel-border); margin-top: 6px; padding-top: 6px; font-variant-numeric: tabular-nums; }
  #ctxPop .ctx-view-report { margin-top: 8px; width: 100%; padding: 4px 8px; background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); border: 1px solid var(--vscode-panel-border); border-radius: 4px; cursor: pointer; font-size: 11px; }
  #ctxPop .ctx-view-report:hover { background: var(--vscode-button-secondaryHoverBackground, var(--vscode-button-secondaryBackground)); }
  /* GAPS-167: full context usage report panel (fork surface for Cursor's
     canvas report — see renderCtxReport). Fixed overlay over the chat. */
  #ctxReport { position: fixed; inset: 0; overflow-y: auto; z-index: 60; background: var(--vscode-editor-background); color: var(--vscode-editor-foreground); padding: 20px 16px 32px; box-sizing: border-box; font-size: 13px; }
  #ctxReport .ctxr-inner { max-width: 748px; margin: 0 auto; }
  #ctxReport .ctxr-eyebrow { font-size: 13px; color: var(--vscode-descriptionForeground); }
  #ctxReport .ctxr-title { font-size: 24px; line-height: 30px; margin-top: 6px; cursor: pointer; }
  #ctxReport .ctxr-close { float: right; background: none; border: none; color: var(--vscode-descriptionForeground); font-size: 16px; cursor: pointer; padding: 4px 8px; }
  #ctxReport .ctxr-meta { display: flex; gap: 24px; margin: 20px 0 4px; flex-wrap: wrap; }
  #ctxReport .ctxr-meta .k { font-size: 13px; color: var(--vscode-descriptionForeground); }
  #ctxReport .ctxr-meta .v { font-size: 15px; font-variant-numeric: tabular-nums; margin-top: 2px; }
  #ctxReport .ctxr-intro { color: var(--vscode-descriptionForeground); margin-top: 16px; line-height: 19px; }
  #ctxReport .ctxr-donut { display: flex; justify-content: center; padding: 16px 0; }
  #ctxReport .ctxr-callout { border: 1px solid var(--vscode-panel-border); border-left: 3px solid var(--vscode-editorWarning-foreground, #E5C07B); border-radius: 6px; padding: 10px 12px; margin: 10px 0; line-height: 19px; }
  #ctxReport .ctxr-callout .t { font-weight: 600; margin-bottom: 4px; }
  #ctxReport .ctxr-explorer-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin: 18px 0 8px; }
  #ctxReport .ctxr-explorer-title { font-size: 24px; line-height: 30px; }
  #ctxReport .ctxr-btn { padding: 4px 10px; background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: none; border-radius: 4px; cursor: pointer; font-size: 12px; }
  #ctxReport .ctxr-btn.ghost { background: none; color: var(--vscode-editor-foreground); }
  #ctxReport .ctxr-btn.ghost:hover { background: var(--vscode-list-hoverBackground); }
  #ctxReport .ctxr-cat { border-top: 1px solid var(--vscode-panel-border); }
  #ctxReport .ctxr-cat-head { display: flex; align-items: center; gap: 8px; width: 100%; background: none; border: none; color: inherit; cursor: pointer; padding: 8px 4px; font-size: 13px; text-align: left; min-height: 36px; box-sizing: border-box; }
  #ctxReport .ctxr-cat-head:hover { background: var(--vscode-list-hoverBackground); }
  #ctxReport .ctxr-cat-head .nm { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  #ctxReport .ctxr-cat-head .ct { color: var(--vscode-descriptionForeground); }
  #ctxReport .ctxr-cat-head .tk { font-variant-numeric: tabular-nums; color: var(--vscode-descriptionForeground); }
  #ctxReport .ctxr-dot { width: 10px; height: 10px; border-radius: 3px; flex: none; }
  #ctxReport .ctxr-help { color: var(--vscode-descriptionForeground); padding: 0 4px 8px 22px; line-height: 18px; }
  #ctxReport .ctxr-item-head { display: flex; align-items: center; gap: 8px; width: 100%; background: none; border: none; color: inherit; cursor: pointer; padding: 6px 4px 6px 22px; font-size: 12px; text-align: left; box-sizing: border-box; }
  #ctxReport .ctxr-item-head:hover { background: var(--vscode-list-hoverBackground); }
  #ctxReport .ctxr-item-head .nm { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  #ctxReport .ctxr-item-head .tk { font-variant-numeric: tabular-nums; color: var(--vscode-descriptionForeground); }
  #ctxReport .ctxr-item-body { white-space: pre-wrap; word-break: break-word; color: var(--vscode-descriptionForeground); font-size: 12px; line-height: 17px; padding: 2px 8px 10px 40px; max-height: 300px; overflow-y: auto; }
  #ctxReport .ctxr-turn { padding: 4px 0 4px 22px; font-size: 12px; color: var(--vscode-descriptionForeground); font-weight: 600; }
  .hint { font-size: 11px; color: var(--vscode-descriptionForeground); margin-top: 6px; }
  /* GAPS-3-MODESUI / Task 3 — Plan Mode auto-suggest nudge. Cursor 3.25.9
     shows this as a mode_nudge composer notification ("Plan Mode", click =
     switch mode, dismiss = opt-out; binary composerNotificationService).
     Our webview equivalent: a slim non-blocking banner above the prompt
     with Switch / Dismiss. Never blocks typing. */
  .plan-nudge { display: flex; align-items: center; gap: 8px; margin: 0 8px 6px; padding: 6px 10px;
    background: var(--vscode-input-background); border: 1px solid var(--vscode-panel-border);
    border-radius: 8px; font-size: 12px; }
  .plan-nudge[hidden] { display: none; }
  .plan-nudge-dot { width: 8px; height: 8px; border-radius: 50%; background: #d29922; flex: none; }
  .plan-nudge-text { flex: 1; color: var(--vscode-foreground); }
  .plan-nudge-switch { background: var(--vscode-button-background); color: var(--vscode-button-foreground);
    border: none; border-radius: 6px; padding: 4px 12px; cursor: pointer; font-size: 12px; }
  .plan-nudge-switch:hover { background: var(--vscode-button-hoverBackground); }
  .plan-nudge-dismiss { background: transparent; color: var(--vscode-descriptionForeground);
    border: 1px solid transparent; border-radius: 6px; padding: 4px 8px; cursor: pointer; font-size: 12px; }
  .plan-nudge-dismiss:hover { color: var(--vscode-foreground); border-color: var(--vscode-panel-border); }
  /* GAPS-3-MODESUI / Task 4 — status pills above the prompt. Binary
     (Cursor 3.25.9, workbench.glass.main.js): the agent panel renders
     anchored pills above the prompt input — glass-queue-pill ("Queued" +
     count, queue>0), glass-canvas-pill ("Canvas", activeCanvas set),
     glass-debug-repro-pill ("Debug", debug repro tray available),
     glass-goal-pill ("Goal", goal set), glass-plan-pill ("Plan",
     pending plan). data-component values below are verbatim from the
     binary. Exact Cursor pill metrics are UNKNOWN (minified CSS-in-JS);
     these are conservative small-pill values matching our composer. */
  .composer-pills { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; margin: 0 8px 6px; }
  .composer-pills[hidden] { display: none; }
  .cpill { display: inline-flex; align-items: center; gap: 6px; font-size: 11px; line-height: 1;
    background: var(--vscode-badge-background); color: var(--vscode-badge-foreground);
    border: 1px solid var(--vscode-panel-border); border-radius: 12px; padding: 4px 6px 4px 10px;
    cursor: pointer; max-width: 220px; }
  .cpill:hover { border-color: var(--vscode-focusBorder); }
  .cpill:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: 1px; }
  .cpill .cpill-label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .cpill .cpill-count { font-size: 10px; background: var(--vscode-button-background);
    color: var(--vscode-button-foreground); border-radius: 8px; padding: 1px 6px; }
  .cpill .cpill-x { background: transparent; border: none; color: inherit; cursor: pointer;
    font-size: 12px; line-height: 1; padding: 0 2px; border-radius: 50%; }
  .cpill .cpill-x:hover { background: rgba(0,0,0,.12); }
  /* Binary: the debug repro pill shows a needs-attention indicator while
     reproduction steps are waiting for the user. */
  .cpill[data-attention="true"] { border-color: var(--vscode-charts-orange, #e8a13c); }
  .cpill .cpill-dot { width: 6px; height: 6px; border-radius: 50%;
    background: var(--vscode-charts-orange, #e8a13c); flex: none; }
  .cpill[aria-expanded="true"] { border-color: var(--vscode-focusBorder); }
  /* Brief highlight when the queue pill is clicked (scroll target). */
  #queueList.queue-flash { outline: 1px solid var(--vscode-focusBorder); outline-offset: 1px; }
  /* Cursor parity: per-human-message Restore button (hover-revealed icon,
     aria-label="Restore Checkpoint", no confirmation dialog). */
  .human-message-action-slot { display: flex; justify-content: flex-end; margin-top: 6px; min-height: 22px; }
  .restore-btn { display: none; background: transparent; border: 1px solid transparent; border-radius: 6px; color: var(--vscode-descriptionForeground); cursor: pointer; padding: 3px; line-height: 0; }
  .msg.human:hover .restore-btn, .restore-btn:focus-visible { display: inline-block; }
  .restore-btn:hover { color: var(--vscode-foreground); border-color: var(--vscode-panel-border); background: var(--vscode-toolbar-hoverBackground, transparent); }
  .restore-btn svg { width: 14px; height: 14px; display: block; }
  /* Cursor parity — per-message "Fork Chat" (binary 3.25.9: jav in
     AgentTranscriptTurnActions.js — tooltip "Fork Chat", "split" icon,
     tertiary tone, "Forking chat" busy label). Hover-revealed on human AND
     assistant bubbles, in the same action slot as Restore. */
  .fork-btn { display: none; background: transparent; border: 1px solid transparent; border-radius: 6px; color: var(--vscode-descriptionForeground); cursor: pointer; padding: 3px; line-height: 0; margin-left: 2px; }
  .msg:hover .fork-btn, .fork-btn:focus-visible, .fork-btn.forking { display: inline-block; }
  .fork-btn:hover { color: var(--vscode-foreground); border-color: var(--vscode-panel-border); background: var(--vscode-toolbar-hoverBackground, transparent); }
  .fork-btn svg { width: 14px; height: 14px; display: block; }
  .fork-btn.forking svg { animation: ctab-spin 0.9s linear infinite; }
  .fork-btn:disabled { cursor: default; opacity: 0.7; }
  /* DEV-GAPS-73 (chat-copy-message): per-message "Copy Message" (binary
     3.25.6: label 'Copy Message' + trackEvent('composer.copy_message') +
     toast 'Message copied to clipboard'). Hover-revealed on human AND
     assistant bubbles, same slot as Restore/Fork. The copy flash swaps
     in a "copied" confirmation glyph (webview-local affordance). */
  .copy-btn { display: none; background: transparent; border: 1px solid transparent; border-radius: 6px; color: var(--vscode-descriptionForeground); cursor: pointer; padding: 3px; line-height: 0; margin-left: 2px; }
  .msg:hover .copy-btn, .copy-btn:focus-visible, .copy-btn.copied { display: inline-block; }
  .copy-btn:hover { color: var(--vscode-foreground); border-color: var(--vscode-panel-border); background: var(--vscode-toolbar-hoverBackground, transparent); }
  .copy-btn svg { width: 14px; height: 14px; display: block; }
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
    <!-- DEV-GAPS-32 cloud-run-on-picker (Cursor 3.25.9 live CDP, DETAIL-CHAT §7):
         IDE/Cloud tab switcher — BUTTON with SPAN "IDE" / SPAN "Cloud". -->
    <div id="runEnvSwitcher" role="group" aria-label="Run environment">
      <button class="run-env-btn active" id="runEnvIde" aria-pressed="true"><span>IDE</span></button>
      <button class="run-env-btn" id="runEnvCloud" aria-pressed="false"><span>Cloud</span></button>
    </div>
  </header>
  <!-- DEV-GAPS-32 cloud-run-on-picker: the "Run on" section is shown when the
       Cloud tab is active. Options + description are Cursor's verbatim labels
       (DETAIL-CHAT §7; binary: "Run on" and "Remote Machine" hit in
       workbench.glass.main.js). -->
  <section id="runOnSection" class="run-on-section" hidden aria-label="Run on">
    <div class="run-on-title">Run on</div>
    <div class="run-on-options" role="radiogroup" aria-label="Run on">
      <button class="run-on-option" data-runon="cloud" role="radio" aria-checked="false"><span>Cloud</span></button>
      <button class="run-on-option selected" data-runon="this-computer" role="radio" aria-checked="true"><span>This Computer</span></button>
      <button class="run-on-option" data-runon="remote-machine" role="radio" aria-checked="false"><span>Remote Machine</span></button>
    </div>
    <div class="run-on-note">Cloud agents work from a clone of your repo in a secure sandbox.</div>
    <div class="run-on-unavailable" id="runOnUnavailable" hidden></div>
  </section>
  <div id="tabBar" role="tablist" aria-label="Chat tabs"></div>
  <div class="mode-row" id="modeRow">${modeChipHtml}</div>
  ${planTrayHtml}
  ${planFindBarHtml}
  ${customModeBadgeHtml}
  <div id="messages" aria-live="polite" aria-atomic="false">${welcomeBubbleHtml(engineConnected)}</div>
  <!-- FIND-IN-CHAT: overlay find bar (ide.findInChat / ide.hideFindInChat).
       Hidden until the host posts {type:'showFindInChat'}. Icons are inline
       SVG — never emoji (quality gate). -->
  <div id="findBar" class="find-bar" hidden role="search" aria-label="Find in chat">
    <input id="findInput" class="find-input" type="text" placeholder="Find in chat" aria-label="Find in chat" autocomplete="off" spellcheck="false">
    <span id="findCount" class="find-count" aria-live="polite"></span>
    <button id="findPrev" class="find-nav" title="Previous match (Shift+Enter)" aria-label="Previous match"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 10l4-4 4 4"/></svg></button>
    <button id="findNext" class="find-nav" title="Next match (Enter)" aria-label="Next match"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 6l4 4 4-4"/></svg></button>
    <button id="findClose" class="find-nav" title="Close (Escape)" aria-label="Close find"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8"/></svg></button>
  </div>
  <!-- GAPS-131 MENTION-LINK-TOOLBAR (cursor.mentionLinkToolbar): backdrop
       + floating toolbar for a link chip in the composer input. Structure
       mirrors the binary template (desk 40171210): two
       .mention-link-toolbar-item rows, first Open (Codicon linkExternal),
       second Unlink (Codicon close); icons here are inline SVG (the
       webview has no codicon font) drawn at the binary 10px size.
       Hidden until the host posts {type:'showMentionLinkToolbar'}. -->
  <div id="mentionLinkBackdrop" class="mention-link-toolbar-backdrop" hidden></div>
  <div id="mentionLinkToolbar" class="mention-link-toolbar fade-in" hidden role="toolbar" aria-label="Mention Link Toolbar">
    <div class="mention-link-toolbar-item" id="mentionLinkOpen" role="button" aria-label="Open"><svg width="10" height="10" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10.5 2.5h3v3M13.5 2.5l-5 5M12 9.5V12a1.5 1.5 0 0 1-1.5 1.5h-7A1.5 1.5 0 0 1 2 12V5A1.5 1.5 0 0 1 3.5 3.5H6"/></svg>Open</div>
    <div class="mention-link-toolbar-item" id="mentionLinkUnlink" role="button" aria-label="Unlink"><svg width="10" height="10" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8"/></svg>Unlink</div>
  </div>
  <!-- DEV-DEBUG-HOLD-UI (spec D5): Debug Logs block — shown only in debug
       mode; populated by {type:'debugLogLine'}/{type:'debugLogHistory'} and
       toggled by {type:'debugState'}. Placed after the last bubble so the
       Proceed / Mark fixed buttons sit under the latest assistant message. -->
  <div id="debugLogs" class="debug-logs" hidden>
    <div class="debug-logs-header">
      <span class="debug-logs-title">Debug Logs</span>
      <span class="debug-logs-count" id="debugLogsCount" hidden></span>
    </div>
    <div class="debug-logs-body" id="debugLogsBody">
      <div class="debug-logs-empty" id="debugLogsEmpty">Waiting for log entries...</div>
    </div>
    <div class="debug-logs-actions">
      <button id="debugProceedBtn" class="debug-proceed">Proceed</button>
      <button id="debugMarkFixedBtn" class="debug-mark-fixed">Mark fixed</button>
    </div>
  </div>
  <div id="queueList" aria-label="Queued messages"></div>
  <div id="approvalCard" role="alertdialog" aria-modal="false" aria-labelledby="approvalTitle" tabindex="-1"></div>
  <!-- GAPS-3-MODESUI / Task 3: Plan Mode auto-suggest nudge (binary:
       mode_nudge composer notification). Shown while typing complex-task
       keywords on the first message; Switch posts setMode=plan, Dismiss
       hides it for the session. -->
  <div id="planNudge" class="plan-nudge" hidden>
    <span class="plan-nudge-dot" aria-hidden="true"></span>
    <span class="plan-nudge-text">Switch to Plan Mode?</span>
    <button id="planNudgeSwitch" class="plan-nudge-switch">Switch</button>
    <button id="planNudgeDismiss" class="plan-nudge-dismiss" aria-label="Dismiss plan mode suggestion">Dismiss</button>
  </div>
  <!-- GAPS-3-MODESUI / Task 4: status pills above the prompt (Cursor 3.25.9
       parity — see CSS comment for the binary evidence). Rendered by
       renderPills() from live composer state; hidden when empty. -->
  <div id="composerPills" class="composer-pills" hidden aria-label="Composer status"></div>
  <!-- DD-CM-1 (Cursor 3.25.9): the composer is ONE 12px-radius box
       (.ai-input-full-input-box) — the toolbar row (model picker + submit
       slot) sits INSIDE the box, not beside it. -->
  <div id="composer" class="ai-input-full-input-box">
    <div id="chips" aria-label="Attached context"></div>
    <textarea id="input" rows="2" aria-label="Chat input" placeholder="${CURSOR_PLACEHOLDER}"></textarea>
    <div class="composer-toolbar">
      <div class="composer-toolbar-left">
        <!-- DEV-GAPS-19 (2026-10-20): "+" button (Cursor 3.25.9 live CDP,
             DETAIL-CHAT §3: button.ui-icon-button[aria-label="Add agents,
             context, tools"]) — opens the Modes / Files / Model / MCP menu. -->
        <button id="addContextBtn" class="ui-icon-button add-context-btn" title="Add agents, context, tools" aria-label="Add agents, context, tools">${ADD_CONTEXT_ICON}</button>
        <div class="menu" id="addContextMenu" hidden></div>
        <button id="modelBtn" title="Pick model">model: ${escHtml(modelLabel)}</button>
      </div>
      <div class="composer-toolbar-right">
        <!-- CONTEXT RING (Cursor 3.25.9 parity): the ring sits next to the
             prompt input (docs-pinned). Click opens the breakdown tray;
             the % is Math.round'd (binary 34950129). -->
        <button id="ctxRing" class="context-usage-ring" title="Context usage — click for breakdown" aria-label="Context usage: no data yet"><svg viewBox="0 0 22 22" width="22" height="22" aria-hidden="true"><circle cx="11" cy="11" r="8.5" fill="none" stroke="var(--vscode-editorWidget-border)" stroke-width="2.5"></circle><circle id="ctxRingArc" cx="11" cy="11" r="8.5" fill="none" stroke="var(--vscode-progressBar-background)" stroke-width="2.5" stroke-linecap="round" stroke-dasharray="53.41" stroke-dashoffset="53.41" transform="rotate(-90 11 11)"></circle><text id="ctxRingPct" x="11" y="11.5">–</text></svg></button>
        <!-- DD-CM-2/6: the submit slot is ONE 24px circle button that morphs —
             empty → disabled send ("Send message", data-state="disabled"),
             text → "Send message" (data-state="active"), running →
             stop-circle ("Stop generation"). HONEST DIVERGENCE: Cursor shows
             a realtime voice-chat entry when empty; we show a disabled send
             button — the Web Speech API recognition service is unavailable
             in Electron webviews and this build bundles no STT engine, so a
             voice button could never work (zero-placeholder policy: no dead
             buttons). The webview script swaps data-state + label + icon as
             text is typed/cleared and turns start/stop. -->
        <button id="send" class="ui-prompt-input-submit-button slot-send" data-component="prompt-input-submit-button" data-size="md" data-state="disabled" title="Send message" aria-label="Send message" disabled>${SUBMIT_ICON_SEND}</button>
      </div>
    </div>
    <div class="menu" id="mentionMenu"></div>
    <div class="menu" id="slashMenu"></div>
    <div id="ctxPop" class="context-usage-tray"></div>
  </div>
  <div id="ctxReport" hidden></div>
  ${engineHintHtml}
<script type="application/json" id="ide-ui-config">${uiJson}</script>
<script nonce="${nonce}">
(function () {
${tableHoverScript}
${unreadDividerScript}
  /* composer-unread-divider: the unread divider + jump pill implementation
     above is injected from unreadDivider.ts (single source of truth). */
  var vscodeApi = acquireVsCodeApi();
  /* GAPS-176 (tooltip pipelines, work-notes-gaps176.md): report chat
     interaction events to the host, which forwards an allowlist to the
     core tooltipService via the 'composer.tooltip.registerEvent' bridge.
     Fire-and-forget: a failed post must never break chat behavior. */
  function postTooltipEvent(event) {
    try { vscodeApi.postMessage({ type: 'tooltipEvent', event: event }); } catch (err) { /* best-effort */ }
  }
  var messagesEl = document.getElementById('messages');
  /* composer-unread-divider (Cursor 3.25.9 parity): mount the unread divider
     + "N New Messages" jump pill onto the transcript container. New bubbles
     appended while the user is scrolled up are marked unread; the pill jumps
     back to the newest message. See patchBubble / resetBubbles below. */
  var unreadDivider = (typeof ideMountUnreadDivider === 'function')
    ? ideMountUnreadDivider(messagesEl)
    : null;
  var suppressUnreadDivider = false;
  var inputEl = document.getElementById('input');
  var chipsEl = document.getElementById('chips');
  var chips = [];
  /* DEV-GAPS-32 cloud-run-on-picker (Cursor 3.25.9 live CDP, DETAIL-CHAT §7):
     IDE/Cloud tab switcher + "Run on" picker. Option labels and the sandbox
     description are Cursor's verbatim strings. Behavior:
     - IDE tab → composer as usual (the "Run on" section is hidden).
     - Cloud tab → shows the "Run on" section.
     - "This Computer" is the default: agents run locally on this machine and
       it is the only option that can actually execute in this build.
     - HONEST DIVERGENCE: "Cloud" and "Remote Machine" have no backend infra
       in this build, so picking one does NOT fake a cloud run — it shows a
       plain-language unavailable notice and leaves the effective target at
       "This Computer". */
  var runOnSectionEl = document.getElementById('runOnSection');
  var runOnUnavailableEl = document.getElementById('runOnUnavailable');
  var runEnvIdeBtn = document.getElementById('runEnvIde');
  var runEnvCloudBtn = document.getElementById('runEnvCloud');
  var runOnOptionEls = Array.prototype.slice.call(document.querySelectorAll('.run-on-option'));
  var runOnTarget = 'this-computer';
  var RUN_ON_UNSUPPORTED = {
    'cloud': 'Cloud execution is not available in this build yet \u2014 the run stays on This Computer.',
    'remote-machine': 'Remote Machine execution is not available in this build yet \u2014 the run stays on This Computer.'
  };
  function setRunEnv(env) {
    var cloud = env === 'cloud';
    runEnvIdeBtn.className = 'run-env-btn' + (cloud ? '' : ' active');
    runEnvIdeBtn.setAttribute('aria-pressed', String(!cloud));
    runEnvCloudBtn.className = 'run-env-btn' + (cloud ? ' active' : '');
    runEnvCloudBtn.setAttribute('aria-pressed', String(cloud));
    runOnSectionEl.hidden = !cloud;
  }
  function setRunOnTarget(target) {
    if (target !== 'this-computer') {
      /* No cloud infra in this build — report honestly instead of faking. */
      runOnUnavailableEl.textContent = RUN_ON_UNSUPPORTED[target] || RUN_ON_UNSUPPORTED['cloud'];
      runOnUnavailableEl.hidden = false;
      target = 'this-computer';
    } else {
      runOnUnavailableEl.hidden = true;
    }
    runOnTarget = target;
    runOnOptionEls.forEach(function (el) {
      var selected = el.getAttribute('data-runon') === target;
      el.className = 'run-on-option' + (selected ? ' selected' : '');
      el.setAttribute('aria-checked', String(selected));
    });
  }
  runEnvIdeBtn.addEventListener('click', function () { setRunEnv('ide'); });
  runEnvCloudBtn.addEventListener('click', function () { setRunEnv('cloud'); });
  runOnOptionEls.forEach(function (el) {
    el.addEventListener('click', function () { setRunOnTarget(el.getAttribute('data-runon')); });
  });
  /* DEV-DEBUG-HOLD-UI: the webview's current chat mode — drives the Debug
     Logs block visibility and Enter-on-empty = proceed. Kept in sync by
     setActiveMode (host {type:'mode'} messages + newChat reset). */
  var webviewMode = ${JSON.stringify(MODES.some((m) => m.id === initialMode) ? initialMode : "agent")};

  /* GAPS-3-MODESUI / Task 3 — Plan Mode auto-suggest. Binary evidence
     (Cursor 3.25.9, composerUtilsService.shouldSuggestPlanMode): the
     keyword list is baked above (PLAN_SUGGEST_KEYWORDS); the matcher below
     mirrors modeService.shouldSuggestPlanMode exactly (substring on the
     lowercased text, sentence-terminator, >= 35 words). Cursor shows this
     as a mode_nudge notification only on the FIRST message of a
     conversation, never in plan mode, and the suggestion is consumed once
     per session (dismiss/switch). The webview mirrors those gates. */
  var PLAN_SUGGEST_KEYWORDS = ${planKeywordsJson};
  var planNudgeEl = document.getElementById('planNudge');
  /* Session-consumed: once dismissed (or switched), the nudge never shows
     again until a new chat. Reset on {type:'newChat'}. */
  var planNudgeDismissed = false;
  function webviewShouldSuggestPlanMode(text) {
    if (!text || !text.trim()) { return false; }
    var lower = text.toLowerCase();
    for (var i = 0; i < PLAN_SUGGEST_KEYWORDS.length; i++) {
      if (lower.indexOf(PLAN_SUGGEST_KEYWORDS[i]) >= 0) { return true; }
    }
    var terms = text.match(/[.!?]+/g);
    if (terms && terms.length >= 1) { return true; }
    var words = text.trim().split(/\s+/).filter(function (w) { return w.length > 0; });
    return words.length >= 35;
  }
  /* Binary gate: the nudge only fires before the first human message
     (Cursor: fullConversationHeadersOnly.length===0 && plan===void 0).
     The welcome bubble is static HTML, not in the store, so the store only
     holds real bubbles. */
  function hasHumanMessages() {
    var found = false;
    store.forEach(function (entry) {
      if (entry && entry.data && entry.data.role === 'human') { found = true; }
    });
    return found;
  }
  function updatePlanNudge() {
    var show = !planNudgeDismissed &&
      webviewMode !== 'plan' &&
      !hasHumanMessages() &&
      webviewShouldSuggestPlanMode(inputEl.value);
    planNudgeEl.hidden = !show;
  }
  document.getElementById('planNudgeSwitch').addEventListener('click', function () {
    /* Consumed: switching marks the suggestion used (Cursor sets
       planModeSuggestionUsed on accept). The host's setMode path runs
       ModeService.setMode('plan'). */
    planNudgeDismissed = true;
    updatePlanNudge();
    vscodeApi.postMessage({ type: 'setMode', mode: 'plan' });
    inputEl.focus();
  });
  document.getElementById('planNudgeDismiss').addEventListener('click', function () {
    /* Cursor: dismiss = opt-out (composer.suggested_mode_switch.opt_out);
       the nudge stays gone for the session. */
    planNudgeDismissed = true;
    updatePlanNudge();
    inputEl.focus();
  });

  /* GAPS-3-MODESUI / Task 4 — status pills above the prompt. Visibility
     mirrors the TS-side visibleComposerPills(); per-pill binary evidence is
     documented on that function. State sources:
       plan   — planTray visibility (pending plan; host {type:'planReady'}).
       debug  — debug mode; attention style while waiting for the repro.
       canvas — {type:'canvasState'} from the host (no canvas feature exists
                yet, so this stays hidden until one lands).
       goal   — {type:'goalState'} from the host (no goal feature exists
                yet, so this stays hidden until one lands).
       queue  — {type:'queue'} length (existing messageQueueService feed). */
  var pillsEl = document.getElementById('composerPills');
  var pillCanvas = null;   // {path,label} | null
  var pillGoal = null;     // {objective,paused} | null
  var pillQueueCount = 0;
  var pillExpanded = { plan: false, debug: false, canvas: false, goal: false, queue: false };
  function pillEl(kind, dataComponent, label, title, ariaLabel) {
    /* The pill is a div[role=button] (not a nested <button>) so the inner
       dismiss <button> stays valid HTML. Keyboard: Enter/Space activates. */
    var b = document.createElement('div');
    b.className = 'cpill';
    b.setAttribute('role', 'button');
    b.setAttribute('tabindex', '0');
    b.setAttribute('data-component', dataComponent);
    b.setAttribute('aria-expanded', pillExpanded[kind] ? 'true' : 'false');
    if (title) { b.title = title; }
    b.setAttribute('aria-label', ariaLabel || label);
    var lab = document.createElement('span');
    lab.className = 'cpill-label';
    lab.textContent = label;
    b.appendChild(lab);
    return b;
  }
  function pillOnActivate(p, fn) {
    p.addEventListener('click', fn);
    p.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        fn();
      }
    });
  }
  function pillCountBadge(n) {
    var s = document.createElement('span');
    s.className = 'cpill-count';
    s.textContent = String(n);
    return s;
  }
  function pillCloseBtn(label, onClose) {
    var x = document.createElement('button');
    x.type = 'button';
    x.className = 'cpill-x';
    x.setAttribute('aria-label', label);
    x.textContent = '×';
    x.addEventListener('click', function (e) {
      e.stopPropagation();
      onClose();
    });
    return x;
  }
  function renderPills() {
    pillsEl.innerHTML = '';
    var kinds = [];
    /* TS-side visibleComposerPills() is the testable mirror of this list. */
    var planPending = !document.getElementById('planTray').hidden;
    var debugActive = webviewMode === 'debug';
    if (planPending) { kinds.push('plan'); }
    if (debugActive) { kinds.push('debug'); }
    if (pillCanvas) { kinds.push('canvas'); }
    if (pillGoal) { kinds.push('goal'); }
    if (pillQueueCount > 0) { kinds.push('queue'); }
    pillsEl.hidden = kinds.length === 0;
    if (kinds.length === 0) { return; }
    kinds.forEach(function (kind) {
      var p;
      if (kind === 'plan') {
        /* Binary: glass-plan-pill, label "Plan"; click toggles the tray,
           X dismisses (our Discard path). */
        p = pillEl('plan', 'glass-plan-pill', 'Plan', 'Pending plan — click to collapse/expand');
        pillOnActivate(p, function () {
          var tray = document.getElementById('planTray');
          tray.hidden = !tray.hidden;
          pillExpanded.plan = !tray.hidden;
          p.setAttribute('aria-expanded', pillExpanded.plan ? 'true' : 'false');
        });
        p.appendChild(pillCloseBtn('Dismiss plan', function () {
          document.getElementById('planTray').hidden = true;
          pillExpanded.plan = false;
          vscodeApi.postMessage({ type: 'discardPlan' });
          renderPills();
        }));
      } else if (kind === 'debug') {
        /* Binary: glass-debug-repro-pill, label "Debug"; title + attention
           indicator while repro steps are waiting for the user. */
        var waiting = debugWaitingForUser === true;
        p = pillEl('debug', 'glass-debug-repro-pill', 'Debug',
          waiting ? 'Reproduction steps are waiting for you' : 'Reproduction steps');
        if (waiting) {
          p.setAttribute('data-attention', 'true');
          var dot = document.createElement('span');
          dot.className = 'cpill-dot';
          dot.setAttribute('aria-hidden', 'true');
          p.insertBefore(dot, p.firstChild);
        }
        pillOnActivate(p, function () {
          pillExpanded.debug = !pillExpanded.debug;
          p.setAttribute('aria-expanded', pillExpanded.debug ? 'true' : 'false');
          var logs = document.getElementById('debugLogs');
          if (logs) { logs.scrollIntoView({ block: 'nearest' }); }
        });
      } else if (kind === 'canvas') {
        /* Binary: glass-canvas-pill, label "Canvas", title = canvas path;
           click toggles expanded, X clears the canvas. */
        p = pillEl('canvas', 'glass-canvas-pill', 'Canvas', pillCanvas.path || 'Canvas');
        pillOnActivate(p, function () {
          pillExpanded.canvas = !pillExpanded.canvas;
          p.setAttribute('aria-expanded', pillExpanded.canvas ? 'true' : 'false');
          /* No canvas surface exists yet — the host ignores this until the
             canvas feature lands (host default: break). */
          vscodeApi.postMessage({ type: 'canvasPillToggle', collapsed: !pillExpanded.canvas });
        });
        p.appendChild(pillCloseBtn('Remove canvas', function () {
          pillCanvas = null;
          pillExpanded.canvas = false;
          vscodeApi.postMessage({ type: 'clearCanvas' });
          renderPills();
        }));
      } else if (kind === 'goal') {
        /* Binary: glass-goal-pill, label "Goal", title = goal objective;
           click toggles. */
        p = pillEl('goal', 'glass-goal-pill', 'Goal',
          (pillGoal && pillGoal.objective) || 'Goal',
          'Goal' + (pillGoal && pillGoal.objective ? ': ' + pillGoal.objective : ''));
        /* Binary: no attention indicator on the goal pill; paused state
           shows in the tray header ("Goal paused"), which we don't render. */
        pillOnActivate(p, function () {
          pillExpanded.goal = !pillExpanded.goal;
          p.setAttribute('aria-expanded', pillExpanded.goal ? 'true' : 'false');
          vscodeApi.postMessage({ type: 'goalPillToggle', expanded: pillExpanded.goal });
        });
      } else if (kind === 'queue') {
        /* Binary: glass-queue-pill, label "Queued" + trailing count,
           aria "Queued N", visible iff N>0; click opens the queue tray. */
        p = pillEl('queue', 'glass-queue-pill', 'Queued', 'Queued messages — click to view',
          'Queued ' + pillQueueCount);
        p.appendChild(pillCountBadge(pillQueueCount));
        pillOnActivate(p, function () {
          pillExpanded.queue = !pillExpanded.queue;
          p.setAttribute('aria-expanded', pillExpanded.queue ? 'true' : 'false');
          var ql = document.getElementById('queueList');
          if (ql) {
            ql.scrollIntoView({ block: 'nearest' });
            ql.classList.remove('queue-flash');
            /* Force reflow so the flash replays on repeat clicks. */
            void ql.offsetWidth;
            ql.classList.add('queue-flash');
          }
        });
      }
      if (p) { pillsEl.appendChild(p); }
    });
  }

  /* Cursor / parity: ready handshake — the host replies with the initial
     slash-command palette ({type:'slashCommands'}). Posting here avoids the
     post-before-load race of host-initiated delivery. */
  vscodeApi.postMessage({ type: 'webviewReady' });

  /* ---- fine-grained bubble store: Map keyed by bubbleId, per-bubble patch ---- */
  var store = new Map(); // bubbleId -> { data, el }

  /* SETTINGS-PARITY: chat UI settings (ide.composer.* / ide.general.*).
     Baked into the HTML at render; live changes arrive via {type:'uiConfig'}.
     The ui object is read by card rendering (density) and input handlers (Cmd+P). */
  var ui = { textSizeScale: 1, conversationDensity: 'compact-all-grouped', codeBlockWordWrap: false, showEmptyStateTips: true, fontSmoothingAntialiased: true, cmdPFilePicker: true, chatMaxWidth: 900 };
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
    /* CHAT-WIDTH: apply ide.composer.chatMaxWidth to the conversation
       container (#messages reads --ide-chat-max-width). Defensive clamp
       here too — the host clamps via normalizeChatWidth, but the webview
       must never render a broken layout even if a future message path
       bypasses the host. Re-runs on every {type:'uiConfig'} (setting
       change) without needing a webview reload. */
    var chatW = Number(ui.chatMaxWidth);
    if (!isFinite(chatW)) { chatW = 900; }
    chatW = Math.max(600, Math.min(1600, Math.round(chatW)));
    document.body.style.setProperty('--ide-chat-max-width', chatW + 'px');
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

  /* GAPS-3-MODESUI (latent-bug fix): roleLabel was imported at the TS
     module scope (bubble.ts) but called inside this IIFE — a
     ReferenceError in the real webview on every new bubble. Local copy
     kept in sync with bubble.ts roleLabel ("You"/"IDE Agent"/"Tool"/
     "System"). */
  function webviewRoleLabel(role) {
    return role === 'human' ? 'You' : role === 'assistant' ? 'IDE Agent' :
      role === 'tool' ? 'Tool' : 'System';
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
    /* markdown-table-expand-copy: extract GFM tables BEFORE escaping, using
       the same placeholder pattern as fenced code blocks below.
       mdTableBlockHtml + MD_TABLE_PH are installed on globalThis by the
       injected markdownTableService script; the typeof guards keep this a
       no-op if that injection ever fails to load. */
    var tableBlocks = [];
    var tablePh = (typeof MD_TABLE_PH === 'string') ? MD_TABLE_PH : '\uE003';
    var rawLines = String(src == null ? '' : src).split('\\n');
    var noTableLines = [];
    for (var tblIdx = 0; tblIdx < rawLines.length; tblIdx++) {
      var tbl = (typeof mdTableBlockHtml === 'function') ? mdTableBlockHtml(rawLines, tblIdx) : null;
      if (tbl) {
        tableBlocks.push(tbl.html);
        noTableLines.push(tablePh + (tableBlocks.length - 1) + tablePh);
        tblIdx = tbl.next;
      } else {
        noTableLines.push(rawLines[tblIdx]);
      }
    }
    var text = esc(noTableLines.join('\\n'));
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
    var tableLineRe = new RegExp('^' + tablePh + '\\\\d+' + tablePh + '$');
    var fenceLineRe = new RegExp('^' + MD_CODE_PH + '\\\\d+' + MD_CODE_PH + '$');
    for (var i = 0; i < mdLines.length; i++) {
      var line = mdLines[i];
      if (fenceLineRe.test(line)) { flushPara(); closeList(); html += line; continue; }
      if (tableLineRe.test(line)) { flushPara(); closeList(); html += line; continue; }
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
    var tableBlockRe = new RegExp(tablePh + '(\\\\d+)' + tablePh, 'g');
    return html
      .replace(blockRe, function (m, i) { return blocks[+i]; })
      .replace(tableBlockRe, function (m, i) { return tableBlocks[+i]; });
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
       (binary ZvS→"all"; shouldBreakGroup never fires for the most-compact
       density, so mixed edit/shell runs stay in one group).
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

  /* P2 (WORKER-GAPS-24C): statusLabel was referenced but never defined —
     any tool-call card render threw a ReferenceError. Kept in sync with
     the TS-side statusLabel (pending/running/done/failed/unknown). */
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
    // tool-call cards share one toggleable group — Cursor's shouldBreakGroup
    // never splits mixed edit/shell runs at this density (binary ZvS → "all").
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
    role.textContent = webviewRoleLabel(bubble.role) + (bubble.serverBubbleId ? ' ✓' : '');
    var text = document.createElement('div');
    text.className = 'bubble-text';
    // renderMarkdown(src) returns an XSS-safe HTML string (source escaped first).
    text.innerHTML = renderMarkdown(bubble.text);
    // markdown-table-expand-copy: hover toolbar on rendered markdown tables.
    if (typeof ideInitTableHover === 'function') { ideInitTableHover(text); }
    var tools = document.createElement('div');
    tools.className = 'tool-calls';
    for (var i = 0; i < bubble.toolCalls.length; i++) {
      appendToolCallCard(tools, bubble.toolCalls[i]);
    }
    wrap.appendChild(role);
    wrap.appendChild(text);
    wrap.appendChild(tools);
    // Cursor parity (binary 3.25.9 + 3.25.6): per-message turn actions in the
    // human-message-action-slot (hover-revealed icons, no confirmation):
    //  - Copy Message (human AND assistant messages): posts copyMessage.
    //  - Restore Checkpoint (human messages): posts restoreCheckpoint.
    //  - Fork Chat (human AND assistant messages): jav component in
    //    AgentTranscriptTurnActions.js (tooltip "Fork Chat", icon "split",
    //    busy label "Forking chat") + command composer.duplicateChat
    //    ({sourceComposerId, bubbleId}) — branch a new chat from this
    //    message; posts forkChatFromBubble to the host.
    if (bubble.role === 'human' || bubble.role === 'assistant') {
      var slot = document.createElement('div');
      slot.className = 'human-message-action-slot';
      // DEV-GAPS-73 (chat-copy-message): per-message "Copy Message"
      // (binary 3.25.6 verbatim label). Copies the bubble's raw markdown
      // source; the host shows the binary's 'Message copied to clipboard'
      // toast and logs trackEvent('composer.copy_message').
      var cbtn = document.createElement('button');
      cbtn.className = 'copy-btn';
      cbtn.setAttribute('aria-label', 'Copy Message');
      cbtn.setAttribute('title', 'Copy Message');
      cbtn.innerHTML = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="5.5" y="5.5" width="8" height="8" rx="1.5"/><path d="M10.5 5.5v-2a1 1 0 0 0-1-1h-6a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h2"/></svg>';
      cbtn.addEventListener('click', function (e) {
        e.stopPropagation();
        if (e.nativeEvent && e.nativeEvent.stopImmediatePropagation) { e.nativeEvent.stopImmediatePropagation(); }
        if (cbtn.classList.contains('copied')) { return; }
        vscodeApi.postMessage({ type: 'copyMessage', bubbleId: bubble.bubbleId });
        // Webview-local confirmation flash (the host's toast arrives
        // through VS Code's notification UI, not the webview).
        cbtn.classList.add('copied');
        cbtn.innerHTML = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2.5 8.5l3.5 3.5 7.5-8"/></svg>';
        setTimeout(function () {
          cbtn.classList.remove('copied');
          cbtn.innerHTML = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="5.5" y="5.5" width="8" height="8" rx="1.5"/><path d="M10.5 5.5v-2a1 1 0 0 0-1-1h-6a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h2"/></svg>';
        }, 1200);
      });
      slot.appendChild(cbtn);
      if (bubble.role === 'human') {
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
      }
      var fbtn = document.createElement('button');
      fbtn.className = 'fork-btn';
      fbtn.setAttribute('aria-label', 'Fork chat');
      fbtn.setAttribute('title', 'Fork Chat');
      fbtn.innerHTML = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 3.6v2.2"/><path d="M8 5.8c0 2.4-3 2.4-3.8 5.4"/><path d="M8 5.8c0 2.4 3 2.4 3.8 5.4"/><circle cx="8" cy="2.4" r="1.2"/><circle cx="4.2" cy="12.5" r="1.2"/><circle cx="11.8" cy="12.5" r="1.2"/></svg>';
      fbtn.addEventListener('click', function (e) {
        e.stopPropagation();
        if (e.nativeEvent && e.nativeEvent.stopImmediatePropagation) { e.nativeEvent.stopImmediatePropagation(); }
        if (fbtn.disabled) { return; }
        fbtn.disabled = true;
        fbtn.classList.add('forking');
        fbtn.setAttribute('aria-label', 'Forking chat');
        vscodeApi.postMessage({ type: 'forkChatFromBubble', bubbleId: bubble.bubbleId });
        // A successful fork resyncs the transcript (resetBubbles rebuilds
        // this element) — the timeout only fires when the fork failed
        // host-side (error toast) so the button never stays stuck busy.
        setTimeout(function () {
          fbtn.disabled = false;
          fbtn.classList.remove('forking');
          fbtn.setAttribute('aria-label', 'Fork chat');
        }, 3000);
      });
      slot.appendChild(fbtn);
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

  /* ---- JUMP BETWEEN USER MESSAGES (DEV-GAPS-119, chat-jump-messages-kbd) ----
     Cursor 3.25.9 parity, CONFIRMED in the binary (work-notes-gaps119):
     the glass commands jumpToNextUserMessage / jumpToPrevUserMessage /
     scrollAgentPanelToTop / scrollAgentPanelToBottom (glass @45371395,
     Cmd/Ctrl+Up/Down and Cmd/Ctrl+Shift+Up/Down) emit
     jumpToNextUserMessageRequested / jumpToPrevUserMessageRequested /
     agentPanelScrollToEdgeRequested, and the transcript implements the
     jump in composerReactTranscriptCommands.js (glass @25908293, desk
     @28640600): targets are the HUMAN rows only; next = first target with
     absoluteTop > scrollTop + 2; prev = last target with
     absoluteTop < scrollTop - 2; then scrollTo({kind:'row',
     edgeOffsetPx:0}) — here messagesEl.scrollTop is set to the row's
     absoluteTop (its top edge aligns with the viewport top). No
     wrap-around: past either end the jump is a no-op. scrollToEdge is the
     binary's scrollBy("document", direction): -1 = very top, +1 = very
     bottom. The pure-TS mirror of this algorithm lives in
     services/chatJumpMessages.ts (unit-tested). */
  function humanMessageTargets() {
    var rows = messagesEl.querySelectorAll('.msg.human');
    var base = messagesEl.getBoundingClientRect().top - messagesEl.scrollTop;
    var targets = [];
    for (var i = 0; i < rows.length; i++) {
      targets.push({ el: rows[i], absoluteTop: rows[i].getBoundingClientRect().top - base });
    }
    return targets;
  }
  function jumpToHumanMessage(direction) {
    var targets = humanMessageTargets();
    var st = messagesEl.scrollTop;
    var target = null;
    var i;
    if (direction > 0) {
      for (i = 0; i < targets.length; i++) {
        if (targets[i].absoluteTop > st + 2) { target = targets[i]; break; }
      }
    } else {
      for (i = 0; i < targets.length; i++) {
        if (targets[i].absoluteTop < st - 2) { target = targets[i]; }
      }
    }
    if (target) { messagesEl.scrollTop = target.absoluteTop; }
  }
  function scrollMessagesToEdge(direction) {
    messagesEl.scrollTop = direction < 0 ? 0 : Math.max(0, messagesEl.scrollHeight - messagesEl.clientHeight);
  }

  function patchBubble(bubble) {
    var entry = store.get(bubble.bubbleId);
    if (!entry) {
      var el = bubbleEl(bubble);
      store.set(bubble.bubbleId, { data: bubble, el: el });
      messagesEl.appendChild(el);
      /* composer-unread-divider: notify the unread tracker that a new row was
         appended (it decides from live scroll metrics whether the user was
         following the bottom). Suppressed during resetBubbles history replay. */
      if (unreadDivider && !suppressUnreadDivider) {
        unreadDivider.messageAppended(bubble.bubbleId, el);
      }
    } else {
      entry.data = bubble;
      var el2 = entry.el;
      var bubbleTextEl = el2.querySelector('.bubble-text');
      bubbleTextEl.innerHTML = renderMarkdown(bubble.text);
      // markdown-table-expand-copy: hover toolbar on rendered markdown tables.
      if (typeof ideInitTableHover === 'function') { ideInitTableHover(bubbleTextEl); }
      el2.querySelector('.role').textContent = webviewRoleLabel(bubble.role) + (bubble.serverBubbleId ? ' ✓' : '');
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
    // FIND-IN-CHAT: the update branch rewrites .bubble-text innerHTML, which
    // destroys <mark> highlights — refresh the search while the bar is open.
    scheduleFindRefresh();
    // GAPS-157: same churn destroys plan find marks inside the plan bubble.
    schedulePlanFindRefresh();
    maybeAutoscroll();
  }

  function resetBubbles(bubbles) {
    for (var k in thinkTimers) { clearInterval(thinkTimers[k]); }
    thinkTimers = {};
    clearCheckedOutChip();
    store.clear();
    messagesEl.innerHTML = ${JSON.stringify(welcomeBubbleHtml(engineConnected))};
    // FIND-IN-CHAT: a full transcript reset destroys any <mark> highlights —
    // drop them so find state never points at detached nodes.
    findClearMarks();
    findUpdateCount();
    // GAPS-157: same for the plan find marks (the plan bubble is part of
    // the transcript; its element is re-resolved on the next search).
    planFindClearMarks();
    if (planFindOpen) { planFindUpdateCount(); }
    /* composer-unread-divider: a full reset replays history — the replayed
       rows are not "new unread" messages, so suppress tracking and drop any
       stale marker. The container ends at the bottom (auto-follow). */
    suppressUnreadDivider = true;
    for (var i = 0; i < bubbles.length; i++) { patchBubble(bubbles[i]); }
    suppressUnreadDivider = false;
    if (unreadDivider) { unreadDivider.clear(); }
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
  /* GAPS-14 (agent-shell-approval-keyboard-flow): the currently displayed
     approval request — powers the card's keyboard flow below. Cursor's
     shell-tool approval card answers Enter (run) / Shift+Enter (run +
     allowlist) / Esc (skip); its card is a terminal widget whose keystrokes
     reach the workbench via keybindingService.softDispatch. Our card is a
     webview (the keybinding service never sees webview keystrokes), so the
     same flow is implemented at the card itself. */
  var currentApprovalRequest = null;
  approvalCard.addEventListener('keydown', function (e) {
    if (!currentApprovalRequest) { return; }
    var optId = null;
    if (e.key === 'Enter' && !e.shiftKey) { optId = 'approve-once'; }
    else if (e.key === 'Enter' && e.shiftKey) { optId = 'approve-allowlist'; }
    else if (e.key === 'Escape') { optId = 'skip'; }
    if (!optId) { return; }
    // A focused button keeps native Enter/Space activation — the keydown
    // would otherwise resolve the approval twice (resolveApproval is
    // idempotent, but the double message is noise).
    if (e.target && e.target.tagName === 'BUTTON') { return; }
    // Only options this request actually offers are reachable by keyboard:
    // shell approvals offer approve-once / approve-allowlist / skip; other
    // approval kinds (custom option ids) ignore these keys.
    var opts = currentApprovalRequest.options || [];
    var found = null;
    for (var i = 0; i < opts.length; i++) {
      if (opts[i] && opts[i].id === optId) { found = opts[i]; break; }
    }
    if (!found) { return; }
    e.preventDefault();
    vscodeApi.postMessage({ type: 'approvalResolve', approvalId: currentApprovalRequest.approvalId, optionId: found.id });
  });
  /* GAPS-12 (approval-card-diff): file-edit approvals carry
     approvalDetails.diffString — the engine's unified diff trimmed to
     context 2 on the host (Cursor parity:
     deepdig-runtime-approval-2026-10-19.md §3.11). Rendered verbatim
     (per-line DOM with textContent, so patch content can never inject
     markup); a diff with no hunks renders nothing. */
  function approvalDiffHasHunks(patch) {
    return /^@@ -\\d/m.test(patch);
  }
  function renderApprovalDiff(patch) {
    var wrap = document.createElement('div');
    wrap.className = 'appr-diff';
    wrap.setAttribute('role', 'group');
    wrap.setAttribute('aria-label', 'Proposed change');
    var rawLines = patch.split('\\n');
    for (var i = 0; i < rawLines.length; i++) {
      var rawLine = rawLines[i];
      // A trailing newline yields one empty string — not a diff line.
      if (i === rawLines.length - 1 && rawLine === '') { break; }
      var line = document.createElement('div');
      var first = rawLine.charAt(0);
      if (rawLine.indexOf('@@') === 0) { line.className = 'adl adl-hunk'; }
      else if (/^---(\\s|$)/.test(rawLine) || /^\\+\\+\\+(\\s|$)/.test(rawLine)) { line.className = 'adl adl-file'; }
      else if (first === '+') { line.className = 'adl adl-add'; }
      else if (first === '-') { line.className = 'adl adl-del'; }
      else { line.className = 'adl'; }
      line.textContent = rawLine === '' ? ' ' : rawLine;
      wrap.appendChild(line);
    }
    return wrap;
  }
  function showApproval(req) {
    currentApprovalRequest = req;
    approvalCard.style.display = 'block';
    approvalCard.innerHTML = '';
    var h = document.createElement('h4');
    h.id = 'approvalTitle';
    h.textContent = 'Approval needed: ' + req.title;
    approvalCard.appendChild(h);
    /* GAPS-12: the proposed-change diff goes right under the title so the
       reviewer sees what they are approving first. Position within the card
       is ours — the binary pins the diff's presence and context (2), not its
       exact placement. */
    var details = req.approvalDetails;
    if (details && typeof details.diffString === 'string' && approvalDiffHasHunks(details.diffString)) {
      approvalCard.appendChild(renderApprovalDiff(details.diffString));
    }
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
    currentApprovalRequest = null;
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
        lab.addEventListener('click', function (ev) {
          /* GAPS-131: link chips open the mention-link toolbar instead
             of a direct target (Cursor call site, desk 24666605: the
             renderer executes cursor.mentionLinkToolbar with
             x = rect.left, y = rect.bottom + 2, link = the URL; the
             host runs the command, which posts the show message back).
             The rect is the chip element, the fork analog of the
             binary mention node element. */
          /* GAPS-143 (NF-2, divergence D5 in mentionLinkToolbar.ts):
             the binary activation guard (desk pre-24666605) refuses to
             open when the input is readonly, or when the input does not
             contain focus AND the mention is not mention-clickable AND
             the click is not in the remove region. Only the readonly
             leg maps onto this webview: do not open when the composer
             textarea (#input, inputEl) is readOnly or disabled — the
             element's real DOM properties (no fork code sets them
             today, so this is a no-op until a surface does; it is not
             an invented model flag). The focus/clickable/remove-region
             legs do NOT map 1-1 and are deliberately not faked here:
             chips live OUTSIDE the textarea (D4) and the label is not
             focusable, so a focus-containment check would block nearly
             every legitimate click; chip labels are always clickable
             by construction; and the remove control is a separate
             chip-x button element, never a region of the label. */
          if (chip.mentionType === 'link' && chip.payload && chip.payload.url) {
            if (inputEl.readOnly || inputEl.disabled) { return; }
            var chipEl = ev.currentTarget && ev.currentTarget.closest ? ev.currentTarget.closest('.chip') : null;
            var rect = (chipEl || ev.currentTarget).getBoundingClientRect();
            vscodeApi.postMessage({ type: 'mentionLinkToolbar', x: rect.left, y: rect.bottom + 2, link: chip.payload.url, uuid: chip.uuid });
            return;
          }
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
    /* DEV-GAPS-19: the "+" add-context menu is a palette too — Esc / a new
       trigger dismisses it (declared with var below, assigned before any
       closeMenus call at runtime). */
    if (typeof addContextMenu !== 'undefined' && addContextMenu) { addContextMenu.hidden = true; }
    /* Cursor / parity: dropping the palette also drops its trigger state and
       the ARIA selection pointer (spec §4.3/§4.5). */
    slashState = null;
    inputEl.removeAttribute('aria-activedescendant');
  }
  /* P2 (CX2b): clicking outside the menus / context popup dismisses them.
     Menu-item, input and trigger clicks are skipped via containment checks
     so toggle flows (e.g. the ctxRing tray toggle) aren't immediately undone by bubbling. */
  document.addEventListener('click', function (e) {
    var t = e.target;
    if (t instanceof Node) {
      if (!mentionMenu.contains(t) && !slashMenu.contains(t) && t !== inputEl) { closeMenus(); }
      if (!ctxPop.contains(t) && !ctxRing.contains(t)) { ctxPop.style.display = 'none'; }
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
  inputEl.addEventListener('input', function (e) {
    /* GAPS-176: 'chat.type' — REAL user typing only. The paste handler
       below re-dispatches a synthetic 'input' (isTrusted=false), and a
       genuine paste fires 'input' with inputType 'insertFromPaste' —
       both are excluded so one paste = one 'chat.paste' event, never a
       paste+type pair. */
    if (e && e.isTrusted && e.inputType !== 'insertFromPaste' && e.inputType !== 'insertFromDrop') {
      postTooltipEvent('chat.type');
    }
    // DETAIL-CHAT §5: every keystroke re-morphs the submit slot.
    updateSubmitButton();
    /* DEV-GAPS-119: keep the host's ideAgent.chatInputEmpty key current. */
    reportInputEmpty();
    /* GAPS-3-MODESUI / Task 3: re-evaluate the plan-mode nudge on every
       keystroke (non-blocking; never interferes with mention/slash). */
    updatePlanNudge();
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
  /* GAPS-46D: the items currently rendered in the slash menu (ranked), so
     the keydown handler can detect a selected skill for Alt+Enter. */
  var slashMenuItems = [];

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
    /* GAPS-46D: remember the ranked items so the keydown handler can tell a
       selected skill apart (Alt+Enter = "Use as Mode"). */
    slashMenuItems = items;
    slashMenu.setAttribute('role', 'listbox');
    slashMenu.setAttribute('aria-label', 'Slash commands');
    items.forEach(function (c, idx) {
      var b = document.createElement('button');
      b.setAttribute('role', 'option');
      b.id = 'slash-opt-' + idx;
      var tag = c.type === 'skill' ? '<span class="tag">skill</span>' : '';
      b.innerHTML = '<b>/' + esc(c.name) + '</b>' + tag +
        '<span class="sub">' + esc(c.description || '') + '</span>';
      /* GAPS-46D (agent-custom-modes): docs — "You can also select Use as
         Mode from the skill entry." Row action, kept outside the insert
         button's activation (stopPropagation). */
      if (c.type === 'skill') {
        var modeAction = document.createElement('span');
        modeAction.className = 'slash-use-mode';
        modeAction.setAttribute('role', 'button');
        modeAction.setAttribute('tabindex', '0');
        modeAction.setAttribute('title', 'Use this skill as a custom mode (Alt+Enter)');
        modeAction.textContent = 'Use as Mode';
        var useAsMode = function (ev) {
          ev.stopPropagation();
          ev.preventDefault();
          slashState = null;
          closeMenus();
          inputEl.focus();
          vscodeApi.postMessage({ type: 'useSkillAsMode', name: c.name });
        };
        modeAction.addEventListener('click', useAsMode);
        modeAction.addEventListener('keydown', function (ev) {
          if (ev.key === 'Enter' || ev.key === ' ') { useAsMode(ev); }
        });
        b.appendChild(modeAction);
      }
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
    /* GAPS-176: 'chat.paste' — the binary emits it on the chat paste
       event before any content handling (desk@24719855), so every paste
       into the chat input counts exactly once, whatever branch below
       (link chip / slash / plain) handles it. */
    postTooltipEvent('chat.paste');
    var text = cd.getData('text/plain') || cd.getData('text') || '';
    /* GAPS-131: paste auto-parse (Cursor desk 24723930) — a lone URL
       under 2000 chars, pasted while no mention/slash menu is open,
       becomes a link mention chip instead of raw text (the binary
       creates a link mention node and calls insertLink({url, uuid})).
       isAutoParseLinkText / insertLinkMention live in the
       MENTION-LINK-TOOLBAR section below (function declarations hoist). */
    if (text && isAutoParseLinkText(text) && mentionMenu.style.display !== 'block' && slashMenu.style.display !== 'block') {
      e.preventDefault();
      insertLinkMention(text.replace(/^\\s+|\\s+$/g, ''));
      return;
    }
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

  /* ---- context-usage ring + breakdown tray ----
     Cursor 3.25.9 parity (binary: contextUsageRing, .context-usage-tray;
     docs: "The context ring next to your prompt input shows how full the
     window is at a glance. Click the ring to open the breakdown tray...
     Hover a segment in the bar or a row in the list to highlight that
     category."). The host pushes {type:'ctxUsage',
     sources:[{name,tokens,pct}], totalTokens, windowPct} — 8 canonical
     categories computed from REAL data (see contextUsageService.ts honesty
     contract). Token figures are host-side chars/4 ESTIMATES (the engine
     reports no usage over the wire); engine-side categories honestly report
     0. Hovering a bar segment highlights its list row and vice versa. */
  var ctxRing = document.getElementById('ctxRing');
  var ctxPop = document.getElementById('ctxPop');
  var ctxSources = null;
  var ctxTotalTokens = 0;
  var ctxWindowPct = null;
  /* GAPS-183: denominator behind windowPct — the active model's real
     contextTokenLimit from the host's engine catalog (host falls back to
     200k only when it cannot resolve one). Null until the host sends it. */
  var ctxContextWindowTokens = null;
  /* 8 distinguishable segment colors, one per canonical category order.
     HONEST-DIVERGENCE: Cursor's exact tray colors are minified (UNKNOWN). */
  var CTX_COLORS = ['#4FC1FF', '#73C991', '#E5C07B', '#C586C0', '#D16969', '#56B6C2', '#D19A66', '#9ECE6A'];
  /* 2*pi*8.5 — the ring SVG's circle circumference (binary: ring shows
     Math.round'd percent, offset 34950129). */
  var CTX_RING_C = 53.41;
  function fmtTok(n) {
    n = Math.round(n || 0);
    if (n >= 1000000) { return (n / 1000000).toFixed(1) + 'M'; }
    if (n >= 1000) { return (n / 1000).toFixed(1) + 'k'; }
    return String(n);
  }
  /* Ring fill + center % label (binary: percent=Math.round(percentFloat ?? percent)). */
  function renderCtxRing() {
    var arc = document.getElementById('ctxRingArc');
    var pctEl = document.getElementById('ctxRingPct');
    if (!arc || !pctEl) { return; }
    if (ctxSources == null || ctxWindowPct == null) {
      arc.setAttribute('stroke-dashoffset', String(CTX_RING_C));
      pctEl.textContent = '–';
      ctxRing.setAttribute('aria-label', 'Context usage: no data yet');
      ctxRing.title = 'Context usage — click for breakdown';
      return;
    }
    var p = Math.max(0, Math.min(100, ctxWindowPct));
    arc.setAttribute('stroke-dashoffset', String((CTX_RING_C * (1 - p / 100)).toFixed(2)));
    pctEl.textContent = String(Math.round(p));
    ctxRing.setAttribute('aria-label', 'Context usage: ' + Math.round(p) + '% of window (' + fmtTok(ctxTotalTokens) + ' tokens). Click for breakdown.');
    ctxRing.title = 'Context usage: ' + fmtTok(ctxTotalTokens) + ' tokens (' + Math.round(p) + '% of window) — click for breakdown';
  }
  function renderCtx() {
    /* Tray body; the ring is rendered separately by renderCtxRing(). */
    if (!ctxSources) {
      ctxPop.innerHTML = '<b>Context usage</b><div class="hint">No data yet — send a message to see the live breakdown.</div>' +
        '<button class="ctx-view-report" id="ctxViewReport">View Report</button>';
      wireCtxViewReport();
      return;
    }
    var bar = '<div id="ctxBar">' + ctxSources.map(function (s, i) {
      var w = Math.max(0, Math.min(100, s.pct || 0));
      return '<span class="seg" data-i="' + i + '" style="width:' + w + '%;background:' + CTX_COLORS[i % CTX_COLORS.length] + '" title="' + esc(s.name) + ' ' + w + '%"></span>';
    }).join('') + '</div>';
    var rows = ctxSources.map(function (s, i) {
      var c = CTX_COLORS[i % CTX_COLORS.length];
      return '<div class="row" data-i="' + i + '"><span class="dot" style="background:' + c + '"></span>' +
        '<span class="nm">' + esc(s.name) + '</span>' +
        '<span class="tk">' + fmtTok(s.tokens) + '</span>' +
        '<span class="pc">' + (s.pct || 0) + '%</span></div>';
    }).join('');
    ctxPop.innerHTML = '<b>Context usage</b>' + bar + rows +
      /* Tray summary mirrors the binary tray's used/size Tokens summary
         (GAPS-167 desk@28074033) once the host sends the real window size. */
      '<div class="total"><span>Total (est.)</span><span>' + fmtTok(ctxTotalTokens) +
      (ctxContextWindowTokens ? ' / ' + fmtTok(ctxContextWindowTokens) : '') + ' tokens</span></div>' +
      '<div class="hint">Estimates from host-observed data; 0 = not measurable on the client.</div>' +
      '<button class="ctx-view-report" id="ctxViewReport">View Report</button>';
    wireCtxViewReport();
    /* Hover sync: segment ↔ row highlight both ways. */
    var segs = ctxPop.querySelectorAll('#ctxBar .seg');
    function hl(i, on) {
      if (segs[i]) { segs[i].classList.toggle('hl', on); }
      var r = ctxPop.querySelector('.row[data-i="' + i + '"]');
      if (r) { r.classList.toggle('hl', on); }
    }
    segs.forEach(function (seg) {
      var i = +seg.getAttribute('data-i');
      seg.addEventListener('mouseenter', function () { hl(i, true); });
      seg.addEventListener('mouseleave', function () { hl(i, false); });
    });
    ctxPop.querySelectorAll('.row[data-i]').forEach(function (row) {
      var i = +row.getAttribute('data-i');
      row.addEventListener('mouseenter', function () { hl(i, true); });
      row.addEventListener('mouseleave', function () { hl(i, false); });
    });
  }
  ctxRing.addEventListener('click', function (e) {
    /* Stop propagation: the document click-closer below must not immediately
       re-hide the tray it just opened. */
    e.stopPropagation();
    var open = ctxPop.style.display === 'block';
    if (!open) { renderCtx(); }
    ctxPop.style.display = open ? 'none' : 'block';
  });
  renderCtxRing();

  /* ---- GAPS-167: context usage report (Cursor canvas report parity) ----
     Cursor 3.25.9: the context tray's "View Report" button opens a canvas
     report (COPY block desk@22095564; producer desk@28059533). The fork
     has no canvas surface (agent-canvas still DISCOVERED), so the report
     renders as a panel in this webview from the host-built payload
     ({type:'ctxUsageReport'} — same data shape as the binary's
     ContextUsageCanvasData; totals are the ring's REAL host estimates).
     All COPY strings below are verbatim from the binary canvas source;
     category help text arrives in the payload is NOT included — the
     webview keeps its own verbatim copy keyed by category id. */
  var CTXR_COPY = {
    eyebrow: 'Context Usage Report', donutCaption: 'Full',
    explorerTitle: 'Context Explorer', debugButton: 'Debug with Agent',
    expandAll: 'Expand All', collapseAll: 'Collapse All', openChat: 'Open Chat',
    emptyState: 'No context breakdown loaded yet.',
    contextFullTitle: 'Context window is getting full',
    incompleteReportTitle: 'Some items could not be loaded',
    incompleteReportBody: 'Part of this conversation was not available when the report was built. The category totals are complete; reopen the report to try loading the missing items.',
    metaRepository: 'Repository', metaContextSize: 'Context size', metaTokensUsed: 'Tokens used',
    intro: 'The context window contains everything your agent sees on a single turn. This includes Cursor\u2019s own instructions, any relevant files, the tools it can access, and the conversation itself. The agent reads all of this each turn, and it can only hold so much. As the context window fills up, the agent has less room to reason, replies can slow down, and older details may be dropped to make space. Some of what\u2019s here is set up by Cursor and some is yours to control.',
    explorerIntro: 'The categories below show what\u2019s in your agent\u2019s context window, sorted by how many tokens it\u2019s using right now.'
  };
  var CTXR_HELP = {
    system_prompt: 'The system prompt is the set of instructions Cursor provides to an agent at the start of every chat. It defines the agent\u2019s tone, sets ground rules, and outlines how it should use tools.',
    tools: 'Tool definitions describe everything the agent can do, such as reading files, running commands, or searching the web. Tool definitions help the agent know what its options are, and Cursor manages this for you.',
    rules: 'Rules are standing instructions the agent follows each turn. Use them to define style conventions, security best practices, or general context for how your project fits together. Keep rules focused and lightweight to avoid bloat.',
    skills: 'Skills are reusable prompts for common tasks. The agent can invoke skills automatically when they\u2019re appropriate, or you can trigger them yourself via a slash command. Use skills when you notice yourself spelling out the same steps over and over.',
    mcp: 'MCP servers connect the agent to outside services like workplace messengers, issue trackers, and design tools. Each additional MCP occupies some of the context window, so it\u2019s worth keeping them to just the ones you need.',
    subagents: 'Subagents are focused helpers the main agent can delegate tasks to, in order to complete big jobs in parallel. This workflow can help free up context in the main agent, since it doesn\u2019t need to occupy itself with every detail.',
    summarized_conversation: 'Conversations are automatically summarized into a short recap when they get too long. This helps the main agent free up context and maintain space for the task at hand.',
    conversation: 'This is the running back-and-forth of your chat: your prompts, the agent\u2019s replies, and the tool calls in between. It\u2019s normal for the conversation to grow quite large as you work, and Cursor will periodically summarize it to free up space.',
    uncategorized: 'This covers tokens that don\u2019t fall neatly into the buckets above.'
  };
  var CTXR_HELP_FALLBACK = 'How much of the context window this category used on the last agent turn.';
  /* Binary host color names (desk@~28060500) → hex approximations for the
     webview (the canvas resolves names through the host theme — UNKNOWN
     exact hexes, HONEST-DIVERGENCE). */
  var CTXR_COLOR_HEX = { gray: '#9E9E9E', purple: '#B180D7', green: '#73C991', yellow: '#E5C07B', cyan: '#56B6C2', pink: '#E06C9F', blue: '#4FC1FF', orange: '#D19A66', red: '#D16969' };
  function ctxrFmtCount(n) { return Math.round(n || 0).toLocaleString('en-US'); }
  function ctxrFmtLabel(n) { return '~' + ctxrFmtCount(n); }
  function wireCtxViewReport() {
    var b = document.getElementById('ctxViewReport');
    if (b) {
      b.addEventListener('click', function (e) {
        e.stopPropagation();
        ctxPop.style.display = 'none';
        vscodeApi.postMessage({ type: 'openContextUsageReport' });
      });
    }
  }
  var ctxReportEl = document.getElementById('ctxReport');
  var ctxrOpenCats = {};
  var ctxrOpenItems = {};
  var ctxrData = null;
  function closeCtxReport() { ctxReportEl.hidden = true; ctxrData = null; }
  function renderCtxReport(report) {
    ctxrData = report;
    ctxrOpenCats = {};
    ctxrOpenItems = {};
    if (report && report.categories) {
      /* Canvas: every top-level category starts expanded on first load. */
      report.categories.forEach(function (c) { ctxrOpenCats[c.id] = true; });
    }
    paintCtxReport();
    ctxReportEl.hidden = false;
    ctxReportEl.scrollTop = 0;
  }
  function paintCtxReport() {
    var report = ctxrData;
    var chatName = (report && report.composerChatName && report.composerChatName.trim()) || 'Untitled Chat';
    var head = '<div class="ctxr-inner">' +
      '<button class="ctxr-close" id="ctxrClose" aria-label="Close">\u00d7</button>' +
      '<div class="ctxr-eyebrow">' + esc(CTXR_COPY.eyebrow) + '</div>' +
      '<div class="ctxr-title" id="ctxrTitle" role="link" tabindex="0" title="' + esc(CTXR_COPY.openChat) + '" aria-label="' + esc(CTXR_COPY.openChat) + '">' + esc(chatName) + '</div>';
    if (!report || !report.categories || report.categories.length === 0) {
      ctxReportEl.innerHTML = head + '<div class="ctxr-intro">' + esc(CTXR_COPY.emptyState) + '</div></div>';
      wireCtxReportChrome();
      return;
    }
    var cats = report.categories;
    var size = report.contextWindowSize || 0;
    var used = report.totalTokensUsed || 0;
    var pctFull = size > 0 ? (used / size) * 100 : 0;
    var pctLabel = Math.round(pctFull) + '%';
    var meta = '<div class="ctxr-meta">' +
      (report.repository ? '<div><div class="k">' + esc(CTXR_COPY.metaRepository) + '</div><div class="v">' + esc(report.repository) + '</div></div>' : '') +
      '<div><div class="k">' + esc(CTXR_COPY.metaContextSize) + '</div><div class="v">' + esc(report.contextWindowLabel) + '</div></div>' +
      '<div><div class="k">' + esc(CTXR_COPY.metaTokensUsed) + '</div><div class="v">' + esc(report.totalTokensLabel) + '</div></div></div>';
    /* Donut: SVG arcs per category over a track ring (canvas semantics:
       center = percent + "Full" caption; aria-label verbatim pattern). */
    var R = 52, C = 2 * Math.PI * R, off = 0, arcs = '';
    cats.forEach(function (c) {
      var frac = size > 0 ? (c.tokens || 0) / size : 0;
      var len = Math.max(0, frac * C);
      var hex = CTXR_COLOR_HEX[c.color] || CTXR_COLOR_HEX.gray;
      arcs += '<circle cx="60" cy="60" r="' + R + '" fill="none" stroke="' + hex + '" stroke-width="12" stroke-dasharray="' + len.toFixed(2) + ' ' + C.toFixed(2) + '" stroke-dashoffset="' + (-off).toFixed(2) + '" transform="rotate(-90 60 60)"><title>' + esc(c.label) + ' ' + ctxrFmtCount(c.tokens) + '</title></circle>';
      off += len;
    });
    var donut = '<div class="ctxr-donut"><svg width="120" height="120" role="img" aria-label="Context usage: ' + esc(pctLabel) + ' of the window used">' +
      '<circle cx="60" cy="60" r="' + R + '" fill="none" stroke="var(--vscode-progressBar-background)" stroke-width="12"></circle>' + arcs +
      '<text x="60" y="60" text-anchor="middle" dominant-baseline="central" fill="var(--vscode-editor-foreground)" font-size="24">' + esc(pctLabel) + '</text>' +
      '<text x="60" y="82" text-anchor="middle" fill="var(--vscode-descriptionForeground)" font-size="11">' + esc(CTXR_COPY.donutCaption) + '</text></svg></div>';
    var callouts = '';
    if (report.incompleteReport) {
      callouts += '<div class="ctxr-callout"><div class="t">' + esc(CTXR_COPY.incompleteReportTitle) + '</div><div>' + esc(CTXR_COPY.incompleteReportBody) + '</div></div>';
    }
    if (pctFull >= 80 && cats.length > 0) {
      var largest = cats[0];
      callouts += '<div class="ctxr-callout"><div class="t">' + esc(CTXR_COPY.contextFullTitle) + '</div><div>' +
        esc(largest.label) + ' is your largest bucket at ' + ctxrFmtCount(largest.tokens) + ' tokens. Summarizing the conversation or starting a new chat usually frees the most room. Expand categories below to find the biggest individual items.</div></div>';
    }
    var itemsByCat = {};
    (report.items || []).forEach(function (it) {
      (itemsByCat[it.categoryId] = itemsByCat[it.categoryId] || []).push(it);
    });
    var turnsById = {};
    (report.conversationTurns || []).forEach(function (t) { turnsById[t.id] = t; });
    var allOpen = cats.every(function (c) { return ctxrOpenCats[c.id]; });
    var sections = cats.map(function (c, ci) {
      var items = itemsByCat[c.id] || [];
      var open = !!ctxrOpenCats[c.id];
      var hex = CTXR_COLOR_HEX[c.color] || CTXR_COLOR_HEX.gray;
      var h = '<div class="ctxr-cat"><button class="ctxr-cat-head" data-cat="' + esc(c.id) + '">' +
        '<span>' + (open ? '▾' : '▸') + '</span><span class="ctxr-dot" style="background:' + hex + '"></span>' +
        '<span class="nm">' + esc(c.label) + '</span>' +
        (items.length ? '<span class="ct">' + items.length + '</span>' : '') +
        '<span class="tk">' + ctxrFmtLabel(c.tokens) + (ci === 0 ? ' tokens' : '') + '</span></button>';
      if (open) {
        h += '<div class="ctxr-help">' + esc(CTXR_HELP[c.id] || CTXR_HELP_FALLBACK) + '</div>';
        var renderItem = function (it) {
          var io = !!ctxrOpenItems[it.id];
          var est = (typeof it.estimatedTokens === 'number' && it.estimatedTokens > 0) ? it.estimatedTokens : Math.max(0, Math.round((it.text || '').length / 4));
          var s = '<button class="ctxr-item-head" data-item="' + esc(it.id) + '"><span>' + (io ? '▾' : '▸') + '</span>' +
            '<span class="nm">' + esc(it.label) + '</span><span class="tk">' + ctxrFmtLabel(est) + '</span></button>';
          if (io && it.text) { s += '<div class="ctxr-item-body">' + esc(it.text) + '</div>'; }
          return s;
        };
        if (c.id === 'conversation' && report.conversationTurns && report.conversationTurns.length) {
          var byId = {};
          items.forEach(function (it) { byId[it.id] = it; });
          report.conversationTurns.forEach(function (t) {
            h += '<div class="ctxr-turn">' + esc(t.title) + '</div>';
            t.itemIds.forEach(function (id) { if (byId[id]) { h += renderItem(byId[id]); } });
          });
        } else {
          items.forEach(function (it) { h += renderItem(it); });
        }
      }
      return h + '</div>';
    }).join('');
    ctxReportEl.innerHTML = head + meta +
      '<div class="ctxr-intro">' + esc(CTXR_COPY.intro) + '</div>' + donut + callouts +
      '<div class="ctxr-explorer-head"><span class="ctxr-explorer-title">' + esc(CTXR_COPY.explorerTitle) + '</span>' +
      '<span><button class="ctxr-btn ghost" id="ctxrToggleAll">' + (allOpen ? esc(CTXR_COPY.collapseAll) : esc(CTXR_COPY.expandAll)) + '</button> ' +
      '<button class="ctxr-btn" id="ctxrDebug">' + esc(CTXR_COPY.debugButton) + '</button></span></div>' +
      '<div class="ctxr-intro" style="margin-top:0">' + esc(CTXR_COPY.explorerIntro) + '</div>' +
      '<div class="hint">Estimates from host-observed data (chars/4); categories the engine owns server-side are not measurable on the client and are omitted.</div>' +
      sections + '</div>';
    wireCtxReportChrome();
    ctxReportEl.querySelectorAll('.ctxr-cat-head').forEach(function (b) {
      b.addEventListener('click', function () {
        var id = b.getAttribute('data-cat');
        ctxrOpenCats[id] = !ctxrOpenCats[id];
        paintCtxReport();
      });
    });
    ctxReportEl.querySelectorAll('.ctxr-item-head').forEach(function (b) {
      b.addEventListener('click', function () {
        var id = b.getAttribute('data-item');
        ctxrOpenItems[id] = !ctxrOpenItems[id];
        paintCtxReport();
      });
    });
    var toggleAll = document.getElementById('ctxrToggleAll');
    if (toggleAll) {
      toggleAll.addEventListener('click', function () {
        var next = !(ctxrData && ctxrData.categories.every(function (c) { return ctxrOpenCats[c.id]; }));
        (ctxrData ? ctxrData.categories : []).forEach(function (c) { ctxrOpenCats[c.id] = next; });
        paintCtxReport();
      });
    }
    var debugBtn = document.getElementById('ctxrDebug');
    if (debugBtn) {
      debugBtn.addEventListener('click', function () {
        vscodeApi.postMessage({ type: 'debugContextUsage' });
        closeCtxReport();
      });
    }
  }
  function wireCtxReportChrome() {
    var close = document.getElementById('ctxrClose');
    if (close) { close.addEventListener('click', closeCtxReport); }
    var title = document.getElementById('ctxrTitle');
    if (title) {
      /* Canvas: title click dispatches openAgent for the source chat. The
         fork report already lives in that chat — "Open Chat" closes the
         report back to it (HONEST-DIVERGENCE). */
      title.addEventListener('click', closeCtxReport);
      title.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); closeCtxReport(); }
      });
    }
  }

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
    hideTabCtxMenu();
    tabs.forEach(function (t) {
      var b = document.createElement('button');
      b.className = 'ctab' + (t.active ? ' active' : '');
      b.setAttribute('role', 'tab');
      b.setAttribute('aria-selected', t.active ? 'true' : 'false');
      b.title = t.title + (t.pinned ? ' (pinned)' : '') + (t.running ? ' (running)' : '') + (t.queuedCount ? ' (' + t.queuedCount + ' queued)' : '');
      var inner = '<span class="t">' + esc(t.title) + '</span>';
      // Cursor 2.1 pin parity: pinned chats show a pin at the top of the list.
      if (t.pinned) { inner += '<span class="pin" title="Pinned chat">' + PIN_SVG + '</span>'; }
      if (t.running) { inner += '<span class="spin" aria-hidden="true"></span>'; }
      // DEV-ORANGE-DOT (chat-orange-dot, cursor.com/changelog/0-48-x):
      // "When a tab is awaiting your input, you'll see an orange dot on that
      // tab." Awaiting input covers approval requests AND clarifying
      // questions (both block the agent's turn on the user), on any tab —
      // the host now ships both flags in the tab list (ChatTabState).
      if (t.approvalPending || t.questionPending) { inner += '<span class="qdot" title="Waiting for your input"></span>'; }
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
      // Cursor 2.1 pin parity: right-click menu (Pin chat / Unpin chat).
      b.addEventListener('contextmenu', function (e) {
        e.preventDefault();
        e.stopPropagation();
        showTabCtxMenu(e.clientX, e.clientY, t);
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

  /* Cursor 2.1 pin parity: right-click context menu on a tab-bar tab. */
  var PIN_SVG = '<svg viewBox="0 0 16 16" width="10" height="10" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><circle cx="11" cy="5" r="2.4"/><path d="M9.3 6.7 4.2 11.8"/><path d="M3.2 12.8l1.2 1.2"/></svg>';
  function hideTabCtxMenu() {
    var m = document.getElementById('tabCtxMenu');
    if (m && m.parentNode) { m.parentNode.removeChild(m); }
  }
  function showTabCtxMenu(x, y, t) {
    hideTabCtxMenu();
    var menu = document.createElement('div');
    menu.id = 'tabCtxMenu';
    menu.setAttribute('role', 'menu');
    var item = document.createElement('button');
    item.textContent = t.pinned ? 'Unpin chat' : 'Pin chat';
    item.setAttribute('role', 'menuitem');
    item.addEventListener('click', function () {
      hideTabCtxMenu();
      vscodeApi.postMessage({ type: t.pinned ? 'unpinTab' : 'pinTab', tabId: t.id });
    });
    menu.appendChild(item);
    document.body.appendChild(menu);
    // Keep the menu fully on-screen.
    var rect = menu.getBoundingClientRect();
    menu.style.left = Math.max(4, Math.min(x, window.innerWidth - rect.width - 4)) + 'px';
    menu.style.top = Math.max(4, Math.min(y, window.innerHeight - rect.height - 4)) + 'px';
  }
  document.addEventListener('click', function () { hideTabCtxMenu(); });
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape') { hideTabCtxMenu(); } });

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
     HONEST DIVERGENCE: Cursor shows its realtime voice-chat entry when the
     input is empty. We show a
     DISABLED send button when the input is empty instead. The Web Speech
     API's recognition service is unavailable in Electron webviews (tied to
     the browser vendor's cloud, not to Chromium — Electron ships no speech
     API key), and this build bundles no mic capture or local STT engine,
     so a voice button could never work. Zero-placeholder policy: no dead
     buttons — a visibly disabled send slot, never a promise of voice.
       input empty      → disabled send arrow, aria-label="Send message"
                          (data-state="disabled"; the button also carries the
                          disabled attribute, so the click can't happen)
       input non-empty  → 12px arrow-up, aria-label="Send message"
                          (data-state="active")
       turn running     → stop-circle, aria-label="Stop generation"
                          (data-state="stop"); clicking stops the turn.
     "Empty" = no non-whitespace text. Chips alone (e.g. an attached
     selection with no text) keep the disabled state — submit() refuses
     empty text anyway, so the two stay consistent. */
  var SUBMIT_ICON_SEND = ${JSON.stringify(SUBMIT_ICON_SEND)};
  var SUBMIT_ICON_STOP = ${JSON.stringify(SUBMIT_ICON_STOP)};
  function composerHasText() {
    return inputEl.value.trim().length > 0;
  }
  function applySubmitSlot(kind) {
    // kind: 'disabled' | 'send' | 'stop'
    var icon, label, title, state, slotClass, btnDisabled;
    if (kind === 'stop') {
      icon = SUBMIT_ICON_STOP; label = 'Stop generation'; title = 'Stop generation';
      state = 'stop'; slotClass = 'slot-stop'; btnDisabled = false;
    } else if (kind === 'send') {
      icon = SUBMIT_ICON_SEND; label = 'Send message'; title = 'Send message';
      state = 'active'; slotClass = 'slot-send'; btnDisabled = false;
    } else {
      icon = SUBMIT_ICON_SEND; label = 'Send message'; title = 'Send message';
      state = 'disabled'; slotClass = 'slot-send'; btnDisabled = true;
    }
    sendBtn.innerHTML = icon;
    sendBtn.setAttribute('aria-label', label);
    sendBtn.setAttribute('title', title);
    sendBtn.setAttribute('data-state', state);
    sendBtn.disabled = btnDisabled;
    sendBtn.classList.remove('slot-send', 'slot-stop');
    sendBtn.classList.add(slotClass);
  }
  function updateSubmitButton() {
    if (turnRunning) { applySubmitSlot('stop'); return; }
    applySubmitSlot(composerHasText() ? 'send' : 'disabled');
  }
  function setTurnRunning(running) {
    turnRunning = !!running;
    /* A finished turn re-morphs the slot to the current input content
       (e.g. back to the disabled send state when the input is empty). */
    updateSubmitButton();
  }
  // Initial paint: the composer starts empty → disabled send.
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

  /* ---- DEV-GAPS-19 (2026-10-20): "+" add-context menu (Cursor 3.25.9 live
     CDP, DETAIL-CHAT §3; feature-matrix composer-add-context-menu) ----
     Sections verbatim: Modes (Plan/Debug/Multitask/Ask each with its
     description verbatim — labels/descriptions come from the same MODE_DEFS
     the mode dropdown uses), then Files, Model (current model), MCP.
     No "Agent" row — Agent is the implicit default (same as Cursor).
     Actions:
       mode item → {type:'setMode', mode} (same message the mode dropdown posts)
       Files → opens the @-mention picker scoped to files (mention "files"
               scope = file+folder kinds, see mentionMatch.ts SCOPES)
       Model → {type:'openModelPicker'} (identical to the #modelBtn click)
       MCP → opens the @-mention picker scoped to "mcp" — that picker IS the
             MCP tools list surface; with no MCP servers configured it honestly
             shows no matches (mentionService mcpProvider). */
  var addCtxModelLabel = ${JSON.stringify(modelLabel)};
  var addContextBtn = document.getElementById('addContextBtn');
  var addContextMenu = document.getElementById('addContextMenu');
  function renderAddContextMenu() {
    var html = '<div class="menu-section">Modes</div>';
    for (var k = 0; k < MODE_DEFS.length; k++) {
      var d = MODE_DEFS[k];
      html += '<button class="ac-item" data-ac-mode="' + d.id + '">' +
        '<span class="mode-dot" style="background:' + modeColorHex(d.color) + '"></span>' +
        '<span><span class="ac-label">' + esc(d.label) + '</span>' +
        '<span class="ac-desc">' + esc(d.description) + '</span></span></button>';
    }
    html += '<button class="ac-item" data-ac-action="files"><span><span class="ac-label">Files</span></span></button>';
    html += '<button class="ac-item" data-ac-action="model"><span><span class="ac-label">Model</span></span><span class="ac-sub">' + esc(addCtxModelLabel) + '</span></button>';
    html += '<button class="ac-item" data-ac-action="mcp"><span><span class="ac-label">MCP</span></span></button>';
    addContextMenu.innerHTML = html;
    var items = addContextMenu.querySelectorAll('.ac-item');
    for (var q = 0; q < items.length; q++) {
      (function (btn) {
        btn.addEventListener('click', function () {
          addContextMenu.hidden = true;
          var m = btn.getAttribute('data-ac-mode');
          var a = btn.getAttribute('data-ac-action');
          if (m) {
            vscodeApi.postMessage({ type: 'setMode', mode: m });
          } else if (a === 'files') {
            openMentionScope('files');
          } else if (a === 'mcp') {
            openMentionScope('mcp');
          } else if (a === 'model') {
            vscodeApi.postMessage({ type: 'openModelPicker' });
          }
        });
      })(items[q]);
    }
  }
  renderAddContextMenu();
  /* Open the @-mention picker programmatically, pre-scoped to a mention kind
     word (files → file/folder, mcp → MCP tools). The "@<scope> " token goes
     through the same detectMentionTrigger/onMentionInput path as typing "@"
     by hand, so host handling ({type:'mentionQuery'} → {type:'mentionItems'})
     is untouched. */
  function openMentionScope(scopeWord) {
    closeMenus();
    var v = inputEl.value;
    var caret = inputEl.selectionStart == null ? v.length : inputEl.selectionStart;
    var pad = (caret === 0 || /[\s(]/.test(v.charAt(caret - 1))) ? '' : ' ';
    var tok = '@' + scopeWord + ' ';
    inputEl.value = v.slice(0, caret) + pad + tok + v.slice(caret);
    var pos = caret + pad.length + tok.length;
    inputEl.selectionStart = inputEl.selectionEnd = pos;
    inputEl.focus();
    onMentionInput();
    updateSubmitButton();
  }
  addContextBtn.addEventListener('click', function (e) {
    e.stopPropagation();
    addContextMenu.hidden = !addContextMenu.hidden;
  });
  document.addEventListener('click', function (e) {
    if (!addContextMenu.hidden && !addContextMenu.contains(e.target) && e.target !== addContextBtn) {
      addContextMenu.hidden = true;
    }
  });
  var CURSOR_PLACEHOLDER = ${JSON.stringify(CURSOR_PLACEHOLDER)};
  function setActiveMode(mode) {
    webviewMode = mode;
    var d = defForMode(mode);
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
    renderDebugLogs();
    /* GAPS-3-MODESUI: mode change re-evaluates the plan nudge (hidden in
       plan mode) and the status pills (debug pill follows the mode). */
    updatePlanNudge();
    renderPills();
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
  /* DEV-GAPS-77 (W77D): Cursor "glass.copy-plan-markdown" parity - plan tab
     header "onCopyAsMarkdown" (binary 3.25.9 @32802481). The host runs the
     binary-verbatim copy/toast/log flow (planCopyService.ts). */
  document.getElementById('copyPlanMarkdownBtn').addEventListener('click', function () {
    vscodeApi.postMessage({ type: 'copyPlanMarkdown' });
  });

  /* ---- custom-mode badge (GAPS-46D, agent-custom-modes) ----
     Active custom mode shows a badge in the chat input (binary
     custom-mode-actions.react.js; docs: "the optional icon and color
     frontmatter fields style the mode's badge"), with an exit button.
     HONEST-DIVERGENCE: Cursor's icon set is minified (UNKNOWN); we render
     a lightning bolt for the default "lightning" icon and a generic spark
     otherwise. */
  var customModeState = null; // {label, icon, colorId, turnsInMode} | null
  var cmBadgeEl = document.getElementById('customModeBadge');
  var cmBadgeIcon = document.getElementById('cmBadgeIcon');
  var cmBadgeLabel = document.getElementById('cmBadgeLabel');
  var CM_LIGHTNING_SVG = '<svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M9 1L3 9h4l-1 6 7-9H9l0-5z"/></svg>';
  var CM_SPARK_SVG = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><path d="M8 1l1.8 4.7L14.5 7l-4.7 1.8L8 13.5l-1.8-4.7L1.5 7l4.7-1.3L8 1z"/></svg>';
  function renderCustomModeBadge() {
    var active = !!customModeState;
    cmBadgeEl.hidden = !active;
    if (!active) { return; }
    cmBadgeLabel.textContent = customModeState.label;
    cmBadgeLabel.title = 'Custom mode: ' + customModeState.label + ' — skill stays in context until you exit';
    cmBadgeIcon.innerHTML = customModeState.icon === 'lightning' ? CM_LIGHTNING_SVG : CM_SPARK_SVG;
    cmBadgeIcon.title = 'icon: ' + customModeState.icon;
    /* data-color drives the border tint; unknown colorIds fall back to the
       default border (no data-color attr). */
    var knownColors = ['yellow', 'red', 'green', 'purple', 'blue', 'orange'];
    if (knownColors.indexOf(customModeState.colorId) >= 0) {
      cmBadgeEl.setAttribute('data-color', customModeState.colorId);
    } else {
      cmBadgeEl.removeAttribute('data-color');
    }
  }
  document.getElementById('cmBadgeExit').addEventListener('click', function () {
    cmBadgeEl.hidden = true;
    customModeState = null;
    vscodeApi.postMessage({ type: 'exitCustomMode' });
  });

  /* ---- Debug Logs block (spec D5) ---- */
  /* The host drives this via {type:'debugLogLine'} (live NDJSON lines),
     {type:'debugLogHistory'} (buffered history, replaces rendered lines),
     and {type:'debugState'} (show/hide + waiting indicator). Visible only
     when the chat mode is debug. */
  var debugLogsEl = document.getElementById('debugLogs');
  var debugLogsBody = document.getElementById('debugLogsBody');
  var debugLogsEmpty = document.getElementById('debugLogsEmpty');
  var debugLogsCount = document.getElementById('debugLogsCount');
  var debugLines = [];
  var debugWaitingForUser = false;
  /* Matches the controller's forwarded-history cap. */
  var DEBUG_MAX_LINES = 100;
  function renderDebugLogs() {
    var active = webviewMode === 'debug';
    debugLogsEl.hidden = !active;
    if (!active) { return; }
    debugLogsEmpty.setAttribute('data-waiting', debugWaitingForUser ? 'true' : 'false');
    var n = debugLines.length;
    debugLogsCount.hidden = n === 0;
    debugLogsCount.textContent = String(n);
    debugLogsEmpty.style.display = n === 0 ? '' : 'none';
  }
  /* One NDJSON line → a time + message row (monospace 11px). The exact
     instrumentation schema is UNKNOWN (spec §7) — we accept
     {ts|time|timestamp, msg|message} and fall back to the raw line. */
  function debugLogRow(line) {
    var time = '';
    var message = line;
    try {
      var obj = JSON.parse(line);
      if (obj && typeof obj === 'object') {
        var t = obj.ts != null ? obj.ts : (obj.time != null ? obj.time : obj.timestamp);
        if (t != null) {
          var d = new Date(typeof t === 'number' ? t : String(t));
          time = isNaN(d.getTime()) ? String(t) : d.toTimeString().slice(0, 8);
        }
        var m = obj.msg != null ? obj.msg : obj.message;
        message = m != null ? String(m) : line;
      }
    } catch (e) { /* not JSON — show the raw line */ }
    var row = document.createElement('div');
    row.className = 'debug-log-line';
    var tEl = document.createElement('span');
    tEl.className = 'debug-log-time';
    tEl.textContent = time;
    var mEl = document.createElement('span');
    mEl.className = 'debug-log-message';
    mEl.textContent = message;
    row.appendChild(tEl);
    row.appendChild(mEl);
    return row;
  }
  function trimDebugLogRows() {
    var rows = debugLogsBody.querySelectorAll('.debug-log-line');
    while (rows.length > DEBUG_MAX_LINES) {
      rows[0].parentNode.removeChild(rows[0]);
      rows = debugLogsBody.querySelectorAll('.debug-log-line');
    }
  }
  function appendDebugLogLine(line) {
    debugLines.push(line);
    if (debugLines.length > DEBUG_MAX_LINES) { debugLines = debugLines.slice(-DEBUG_MAX_LINES); }
    debugLogsBody.appendChild(debugLogRow(line));
    trimDebugLogRows();
    renderDebugLogs();
  }
  function setDebugLogHistory(lines) {
    debugLines = lines.slice(-DEBUG_MAX_LINES);
    var rows = debugLogsBody.querySelectorAll('.debug-log-line');
    for (var i = 0; i < rows.length; i++) { rows[i].parentNode.removeChild(rows[i]); }
    debugLines.forEach(function (l) { debugLogsBody.appendChild(debugLogRow(l)); });
    renderDebugLogs();
  }
  function resetDebugLogs() {
    debugLines = [];
    debugWaitingForUser = false;
    setDebugLogHistory([]);
  }
  document.getElementById('debugProceedBtn').addEventListener('click', function () {
    vscodeApi.postMessage({ type: 'debugProceed' });
  });
  document.getElementById('debugMarkFixedBtn').addEventListener('click', function () {
    vscodeApi.postMessage({ type: 'debugMarkFixed' });
  });
  renderDebugLogs();

  /* ---- submit ---- */
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
    inputEl.value = '';
    chips = [];
    renderChips();
    closeMenus();
    // The composer is empty again → morph the slot back to the disabled send state.
    updateSubmitButton();
    /* GAPS-3-MODESUI / Task 3: the draft is gone — the nudge has nothing to
       evaluate (the arriving human bubble also hides it via hasHumanMessages). */
    updatePlanNudge();
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
    }
    /* Empty + not running: the slot is a disabled send button (see
       applySubmitSlot) — the click cannot happen in a real webview, and
       here it is a deliberate no-op. The voice entry was REMOVED 2026-10-19:
       the Web Speech API recognition service is unavailable in Electron
       webviews and this build bundles no mic capture or STT engine, so no
       voice button can work. Never post a dead voice message to the host. */
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
        else {
          /* GAPS-46D (agent-custom-modes): Alt+Enter (Option+Enter on Mac)
             on a selected SKILL in the / menu = "Use as Mode" (docs:
             "Pick the skill from the '/' menu and press Option+Enter
             Alt+Enter (Mac) or Alt+Enter (Windows)"). Only when the slash
             menu is open and the selected row is a skill — bare-input
             Alt+Enter keeps its queue meaning. */
          var selSkill = menu === slashMenu && e.altKey && e.key === 'Enter'
            ? slashMenuItems[menuSelIdx]
            : null;
          if (selSkill && selSkill.type === 'skill') {
            slashState = null;
            closeMenus();
            inputEl.focus();
            vscodeApi.postMessage({ type: 'useSkillAsMode', name: selSkill.name });
            return;
          }
          btns[menuSelIdx].click(); return;
        }
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
      /* DEV-DEBUG-HOLD-UI (spec D5): in debug mode, Enter on an EMPTY input
         submits the proceed instruction instead of doing nothing (Cursor's
         Enter-on-empty = proceed). Gated on not-generating, mirroring the
         binary's "last AI bubble is open, not generating" condition. */
      if (!inputEl.value.trim() && chips.length === 0 && webviewMode === 'debug' && !turnRunning) {
        vscodeApi.postMessage({ type: 'debugProceed' });
        return;
      }
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
    if (e.key === 'Escape') { closeMenus(); inputEl.blur(); }
  });
  /* GAPS-176: 'chat.copy.codeblock.manual' — the fork's transcript
     codeblocks are plain <pre class="md-code"> (renderMarkdown) with NO
     copy button, so the only true counterpart of the binary's handleCopy
     in a chat codeblock editor (desk@23596167) is a manual copy whose
     selection anchor sits inside one. The per-message Copy Message
     button copies a whole bubble's markdown — NOT a codeblock copy —
     so it deliberately does not emit here. */
  document.addEventListener('copy', function () {
    try {
      var sel = document.getSelection ? document.getSelection() : null;
      var node = sel && sel.anchorNode ? sel.anchorNode : null;
      var el = node ? (node.nodeType === 1 ? node : node.parentElement) : null;
      if (el && el.closest && el.closest('pre.md-code')) {
        postTooltipEvent('chat.copy.codeblock.manual');
      }
    } catch (err) { /* best-effort — never break copy */ }
  });
  inputEl.addEventListener('focus', function () { vscodeApi.postMessage({ type: 'inputFocus', focused: true }); });
  inputEl.addEventListener('blur', function () { vscodeApi.postMessage({ type: 'inputFocus', focused: false }); });
  /* DEV-GAPS-119 (chat-jump-messages-kbd): report prompt emptiness so the
     host can set the ideAgent.chatInputEmpty context key — the fork
     analog of Cursor's glassPromptInputEmpty (glass @23559271), the
     last conjunct of the jump keybindings' when-clause
     (!inputFocus || glassPromptInputEmpty). Reported on every edit
     (the 'input' listener below), on reset paths, and once at startup. */
  function reportInputEmpty() { vscodeApi.postMessage({ type: 'inputEmpty', empty: inputEl.value.length === 0 }); }
  reportInputEmpty();
  document.getElementById('modelBtn').addEventListener('click', function () {
    vscodeApi.postMessage({ type: 'openModelPicker' });
  });

  /* ---- FIND-IN-CHAT (ide.findInChat / ide.hideFindInChat) ----
     The VS Code native find widget cannot search inside a webview, so the
     chat owns its own find bar. Behavior: the host posts
     {type:'showFindInChat'} (Ctrl/Cmd+F while the chat surface is focused —
     keybinding lives in workbench core composerActions.ts, when-clause
     disjoint from the editor's editorTextFocus, so no conflict) and
     {type:'hideFindInChat'} (Escape). The bar searches the rendered
     transcript (#messages), wraps every match in <mark class="find-match">,
     shows "n / m", and Enter / Shift+Enter (or the chevron buttons) move
     the current match with scrollIntoView. Escape closes and returns DOM
     focus to the composer input.
     Note on Cursor parity: Cursor 3.25.x opens a find overlay in the
     composer panel on Cmd/Ctrl+F; its exact match-rendering internals were
     not dissected, so the highlight/jump behavior here follows the
     editor-find conventions users expect. */
  var findBarEl = document.getElementById('findBar');
  var findInputEl = document.getElementById('findInput');
  var findCountEl = document.getElementById('findCount');
  var findPrevBtn = document.getElementById('findPrev');
  var findNextBtn = document.getElementById('findNext');
  var findCloseBtn = document.getElementById('findClose');
  var findOpen = false;
  var findMarks = [];   // <mark> elements wrapping the current highlights
  var findCurrent = -1; // index into findMarks
  var findRefreshTimer = null;

  function findClearMarks() {
    for (var mi = 0; mi < findMarks.length; mi++) {
      var mk = findMarks[mi];
      var parent = mk.parentNode;
      if (parent) {
        // Unwrap: move the matched text back out of the <mark>.
        while (mk.firstChild) { parent.insertBefore(mk.firstChild, mk); }
        parent.removeChild(mk);
      }
    }
    findMarks = [];
    findCurrent = -1;
  }

  function findUpdateCount() {
    if (!findInputEl.value) {
      findCountEl.textContent = '';
    } else if (findMarks.length === 0) {
      findCountEl.textContent = 'No results';
    } else {
      findCountEl.textContent = (findCurrent + 1) + ' / ' + findMarks.length;
    }
  }

  function findGoTo(i, scroll) {
    if (findMarks.length === 0) { return; }
    var n = findMarks.length;
    var next = ((i % n) + n) % n;
    if (findCurrent >= 0 && findCurrent < n && findMarks[findCurrent]) {
      findMarks[findCurrent].classList.remove('find-current');
    }
    findCurrent = next;
    var mark = findMarks[next];
    mark.classList.add('find-current');
    if (scroll !== false) { mark.scrollIntoView({ block: 'nearest' }); }
    findUpdateCount();
  }

  function findRun(restoreIndex) {
    var prev = (restoreIndex && findCurrent >= 0) ? findCurrent : -1;
    findClearMarks();
    var q = findInputEl.value;
    if (q) {
      var ql = q.toLowerCase();
      var walker = document.createTreeWalker(messagesEl, NodeFilter.SHOW_TEXT, {
        acceptNode: function (node) {
          var p = node.parentNode;
          if (p && (p.tagName === 'SCRIPT' || p.tagName === 'STYLE')) {
            return NodeFilter.FILTER_REJECT;
          }
          return NodeFilter.FILTER_ACCEPT;
        }
      });
      var textNodes = [];
      var tn;
      while ((tn = walker.nextNode())) { textNodes.push(tn); }
      for (var ti = 0; ti < textNodes.length; ti++) {
        var node = textNodes[ti];
        var lower = (node.nodeValue || '').toLowerCase();
        var from = 0;
        var pos;
        var cur = node;
        var consumed = 0; // chars of the original node already split into cur
        while ((pos = lower.indexOf(ql, from)) !== -1) {
          var matchNode = cur.splitText(pos - consumed);
          var afterNode = matchNode.splitText(q.length);
          var mark = document.createElement('mark');
          mark.classList.add('find-match');
          var mp = matchNode.parentNode;
          mp.insertBefore(mark, matchNode);
          mark.appendChild(matchNode);
          findMarks.push(mark);
          cur = afterNode;
          consumed = pos + q.length;
          from = pos + q.length;
        }
      }
    }
    findUpdateCount();
    if (findMarks.length > 0) {
      findGoTo(prev >= 0 ? Math.min(prev, findMarks.length - 1) : 0, !restoreIndex);
    }
  }

  function findShow() {
    findOpen = true;
    findBarEl.hidden = false;
    // DEV-GAPS-29: report to the host so it can set the verbatim context
    // key 'composerFindWidgetFocused' (gates composer.find.hide/next/previous).
    // GAPS-134: inputFocused:true — findShow() focuses the find input
    // synchronously below, so the host can also set the pane-level keys
    // 'glassChatFindBarVisible' / 'glassChatFindInputFocused'.
    vscodeApi.postMessage({ type: 'findBarState', open: true, inputFocused: true });
    // Keep the previous query; reselect it for quick replacement.
    findInputEl.focus();
    findInputEl.select();
    if (findInputEl.value) { findRun(false); }
    else { findUpdateCount(); }
  }

  function findHide() {
    findOpen = false;
    vscodeApi.postMessage({ type: 'findBarState', open: false, inputFocused: false });
    if (findRefreshTimer) { clearTimeout(findRefreshTimer); findRefreshTimer = null; }
    findClearMarks();
    findBarEl.hidden = true;
    // Editor-find parity: the query is KEPT across close/reopen (reopening
    // reselects it); only the highlights and the count are dropped.
    findCountEl.textContent = '';
    inputEl.focus();
  }

  /* Bubble churn (streaming edits, tool-call updates) rewrites
     .bubble-text innerHTML, which destroys our <mark> wrappers — refresh
     the search (trailing debounce) while the bar is open. */
  function scheduleFindRefresh() {
    if (!findOpen) { return; }
    if (findRefreshTimer) { clearTimeout(findRefreshTimer); }
    findRefreshTimer = setTimeout(function () {
      findRefreshTimer = null;
      if (findOpen) { findRun(true); }
    }, 250);
  }

  findInputEl.addEventListener('input', function () { findRun(false); });
  // GAPS-134: keep the host's 'glassChatFindInputFocused' key truthful as
  // focus moves between the find input and the rest of the bar (the
  // pane-level nextChatFindMatch/previousChatFindMatch keybindings require
  // bar-visible AND input-focused, binary when ADn && RDn).
  findInputEl.addEventListener('focus', function () {
    if (findOpen) { vscodeApi.postMessage({ type: 'findBarState', open: true, inputFocused: true }); }
  });
  findInputEl.addEventListener('blur', function () {
    if (findOpen) { vscodeApi.postMessage({ type: 'findBarState', open: true, inputFocused: false }); }
  });
  findInputEl.addEventListener('keydown', function (e) {
    if (e.key === 'Enter') {
      e.preventDefault();
      findGoTo(findCurrent + (e.shiftKey ? -1 : 1));
    } else if (e.key === 'F3') {
      // DEV-GAPS-29: binary composer.find.next/previous chords (F3 / Shift+F3)
      // while the widget is focused — webview keys don't reach the workbench
      // keybinding system, so handle them here too.
      e.preventDefault();
      findGoTo(findCurrent + (e.shiftKey ? -1 : 1));
    } else if (e.key === 'Escape') {
      // Webviews do not forward keys to the workbench keybinding system,
      // so Escape inside the find input is handled here (the host
      // ide.hideFindInChat covers Escape when the surface — not the bar —
      // has focus).
      e.preventDefault();
      findHide();
    } else if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && (e.key === 'f' || e.key === 'F')) {
      // Ctrl/Cmd+F inside the find input reselects the query (editor parity).
      e.preventDefault();
      findInputEl.select();
    }
  });
  findNextBtn.addEventListener('click', function () { findGoTo(findCurrent + 1); });
  findPrevBtn.addEventListener('click', function () { findGoTo(findCurrent - 1); });
  findCloseBtn.addEventListener('click', function () { findHide(); });

  /* ---- PLAN-FIND (GAPS-157, plan-find-in-plan: ide.showPlanFind /
     ide.hidePlanFind / ide.findNextInPlan / ide.findPreviousInPlan) ----
     Cursor 3.25.9 glass: the pane-level family showPlanFind /
     hidePlanFind / nextPlanFindMatch / previousPlanFindMatch (weight
     256, core composerActions.ts) emits planFindRequested /
     planFindCloseRequested / planFindNextMatchRequested /
     planFindPreviousMatchRequested on the glass event bus; the plan
     tab's generic rich-text find bar (config D2_ @32788864,
     data-component "plan-tab-find-bar") searches the plan editor's
     TipTap document: case-insensitive substring matches over text
     nodes, every match decorated, the current match selected +
     scrolled into view, next/previous wrap around, and next/previous
     are hard no-ops when there are no matches (SearchPlugin
     selectNextRichTextSearchResult returns false when
     !query || matches.length===0); the bar's count label is
     "N of M", or "0 of 0" for a non-empty query with no matches, and
     its nav buttons are disabled while total===0.
     Fork surface (HONEST-DIVERGENCE D-P6 in core composerActions.ts):
     there is no plan tab — the pending plan's content is the plan-mode
     assistant bubble in the transcript, identified exactly by the
     host's PendingPlan.bubbleId (posted with {type:'planReady'}), and
     bubbles carry data-bubble="<bubbleId>". This bar therefore reuses
     the FIND-IN-CHAT TreeWalker/<mark> machinery scoped to that one
     bubble element (resolved fresh on every search so re-renders are
     survived). When the bubble cannot be resolved (no bubbleId, or the
     bubble element is gone from the DOM) the scope is an EMPTY
     no-match root: the result is 0 matches ("0 of 0", nav disabled),
     exactly like the binary searching an empty plan document.
     GAPS-169 (NF-1, correcting GAPS-157/QA-164): the scope must NOT
     fall back to the tray element — the tray DOES hold text (the
     "Plan ready — review it above, then:" title and the "Accept Plan
     & Build" / "Discard" / "Copy as Markdown" buttons,
     planTrayHtml above), so searching it would match and highlight
     tray chrome that is not plan content. Matches outside the plan
     bubble are NEVER highlighted — that scoping is the point of the
     family.
     The bar reports {type:'planFindBarState', open, inputFocused} so
     the host maintains the verbatim context keys
     glassPlanFindBarVisible / glassFindInputFocused (binary @23559865 /
     @23559425). In the binary the GENERIC key MX is set/deleted by the
     bar container's focus/blur; here the input's focus/blur reports it
     and the nav buttons return focus to the input, which keeps the key
     truthful for the one focusable text field the bar has. */
  var planFindBarEl = document.getElementById('planFindBar');
  var planFindInputEl = document.getElementById('planFindInput');
  var planFindCountEl = document.getElementById('planFindCount');
  var planFindPrevBtn = document.getElementById('planFindPrev');
  var planFindNextBtn = document.getElementById('planFindNext');
  var planFindCloseBtn = document.getElementById('planFindClose');
  var planFindOpen = false;
  var planFindMarks = [];   // <mark> elements inside the plan bubble only
  // GAPS-169 (NF-2b): one entry per MATCH (binary Uqp count), each entry
  // the list of <mark> elements highlighting that match. Non-overlapping
  // matches have exactly one mark; overlapping matches (advance o+1)
  // share atomic segment marks — see planFindRun.
  var planFindMatchGroups = [];
  var planFindCurrent = -1; // index into planFindMatchGroups
  var planFindRefreshTimer = null;
  var planBubbleId = null;  // PendingPlan.bubbleId from {type:'planReady'}

  /* GAPS-169: the search scope. Returns the plan bubble element, or
     null — the no-match root — when there is no bubbleId or the bubble
     is no longer in the DOM. Deliberately NEVER the tray (NF-1: the
     tray's own chrome text must not be searched; see the header note). */
  function planFindScopeRoot() {
    if (planBubbleId) {
      var found = null;
      (function walk(node) {
        if (found || !node) { return; }
        if (node.getAttribute && node.getAttribute('data-bubble') === planBubbleId) { found = node; return; }
        var kids = node.children || [];
        for (var i = 0; i < kids.length; i++) { walk(kids[i]); }
      })(messagesEl);
      if (found) { return found; }
    }
    return null;
  }

  /* GAPS-169 (NF-2a): port of the binary's adk (SearchPlugin, glass
     @15057542). The binary's ldk applies adk to EVERY text node that
     contains both "[" and "](" — code spans/blocks included, with no
     node-type distinction — splitting the text into segments: text
     outside a markdown link keeps its offsets, and inside a link ONLY
     capture group 1 (the link text, startOffset = index of "[" + 1)
     survives; the URL and the []( ) syntax are excluded from search.
     The link pattern is the binary's JKr (glass @15059682), implemented
     by the manual scanner in this function (see its comment):
     /(?<!\\)\[([^\]]+)\]\(((?:[^()]|\([^)]*\))+)\)/g
     Returns [{text, startOffset}] covering the searchable parts of
     the text in order (the whole text as one segment when no link
     syntax is present). */
  function planFindSegments(text) {
    if (text.indexOf('[') === -1 || text.indexOf('](') === -1) {
      return [{ text: text, startOffset: 0 }];
    }
    // Manual scanner implementing JKr's semantics exactly (a regex
    // literal would need quadruple escaping inside this template
    // literal; charCode 92 is the backslash for the (?<!...) guard):
    // a link is [linkText](url) where linkText is 1+ chars with no
    // ']', the '[' is not preceded by a backslash, and url is 1+
    // units of either a non-paren char or a ( ... ) group whose
    // content has no ')', closed by a final ')'. A failed parse at a
    // '[' advances the scan by one char, like the /g regex exec loop.
    var segs = [];
    var n = 0;
    var i = 0;
    while (i < text.length) {
      var linked = false;
      if (text.charAt(i) === '[' && (i === 0 || text.charCodeAt(i - 1) !== 92)) {
        var close = text.indexOf(']', i + 1);
        if (close > i + 1 && text.charAt(close + 1) === '(') {
          var j = close + 2;
          var consumedAny = false;
          var ok = false;
          while (j < text.length) {
            var c = text.charAt(j);
            if (c === '(') {
              var endGrp = text.indexOf(')', j + 1);
              if (endGrp === -1) { break; }
              j = endGrp + 1;
              consumedAny = true;
            } else if (c === ')') {
              ok = consumedAny;
              break;
            } else {
              j++;
              consumedAny = true;
            }
          }
          if (ok) {
            if (i > n) { segs.push({ text: text.slice(n, i), startOffset: n }); }
            segs.push({ text: text.slice(i + 1, close), startOffset: i + 1 });
            n = j + 1;
            i = j + 1;
            linked = true;
          }
        }
      }
      if (!linked) { i++; }
    }
    if (n < text.length) { segs.push({ text: text.slice(n), startOffset: n }); }
    return segs;
  }

  /* GAPS-169: port of the binary's ldk+Uqp match scan (glass
     @15057542+): for each adk segment, case-insensitive substring
     search (Uqp lowercases the segment text; the query arrives
     lowercased from ldk) advancing s = o + 1 after each hit — so
     OVERLAPPING matches count, exactly like the binary ("aa" in
     "aaa" = 2 matches). Returns [{start, end}] offsets into the
     ORIGINAL text node, in ascending order. Matches never cross a
     segment boundary (the binary searches segment by segment too). */
  function planFindMatchRanges(text, ql) {
    var ranges = [];
    var segs = planFindSegments(text);
    for (var si = 0; si < segs.length; si++) {
      var segLower = segs[si].text.toLowerCase();
      var s = 0;
      var o;
      while ((o = segLower.indexOf(ql, s)) !== -1) {
        ranges.push({ start: segs[si].startOffset + o, end: segs[si].startOffset + o + ql.length });
        s = o + 1; // Uqp advance: s = o + 1 (NOT o + query length)
      }
    }
    return ranges;
  }

  function planFindClearMarks() {
    for (var mi = 0; mi < planFindMarks.length; mi++) {
      var mk = planFindMarks[mi];
      var parent = mk.parentNode;
      if (parent) {
        while (mk.firstChild) { parent.insertBefore(mk.firstChild, mk); }
        parent.removeChild(mk);
      }
    }
    planFindMarks = [];
    planFindMatchGroups = [];
    planFindCurrent = -1;
  }

  function planFindUpdateCount() {
    // Binary label (generic find bar): "N of M" / "0 of 0" / "".
    // GAPS-169: M is the MATCH count (planFindMatchGroups, binary Uqp
    // count), which exceeds the <mark> element count only for
    // overlapping matches (atomic segments, see planFindRun).
    if (planFindMatchGroups.length === 0) {
      planFindCountEl.textContent = planFindInputEl.value ? '0 of 0' : '';
    } else {
      planFindCountEl.textContent = (planFindCurrent + 1) + ' of ' + planFindMatchGroups.length;
    }
    // Binary: navigationDisabled = (total===0).
    var noMatches = planFindMatchGroups.length === 0;
    planFindNextBtn.disabled = noMatches;
    planFindPrevBtn.disabled = noMatches;
  }

  function planFindGoTo(i, scroll) {
    // Binary: no matches → hard no-op (SearchPlugin returns false).
    if (planFindMatchGroups.length === 0) { return; }
    var n = planFindMatchGroups.length;
    var next = ((i % n) + n) % n;
    if (planFindCurrent >= 0 && planFindCurrent < n && planFindMatchGroups[planFindCurrent]) {
      var prevGroup = planFindMatchGroups[planFindCurrent];
      for (var pg = 0; pg < prevGroup.length; pg++) { prevGroup[pg].classList.remove('find-current'); }
    }
    planFindCurrent = next;
    var group = planFindMatchGroups[next];
    for (var gm = 0; gm < group.length; gm++) { group[gm].classList.add('find-current'); }
    if (scroll !== false && group.length > 0) { group[0].scrollIntoView({ block: 'nearest' }); }
    planFindUpdateCount();
  }

  function planFindRun(restoreIndex) {
    var prev = (restoreIndex && planFindCurrent >= 0) ? planFindCurrent : -1;
    planFindClearMarks();
    var q = planFindInputEl.value;
    if (q) {
      var ql = q.toLowerCase();
      var root = planFindScopeRoot();
      // GAPS-169 (NF-1): root === null is the no-match scope (bubble
      // unresolved) — skip the walk entirely: 0 matches, no highlights
      // anywhere (in particular not on the plan tray's chrome text).
      if (root) {
        var walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
          acceptNode: function (node) {
            var p = node.parentNode;
            if (p && (p.tagName === 'SCRIPT' || p.tagName === 'STYLE')) {
              return NodeFilter.FILTER_REJECT;
            }
            return NodeFilter.FILTER_ACCEPT;
          }
        });
        var textNodes = [];
        var tn;
        while ((tn = walker.nextNode())) { textNodes.push(tn); }
        for (var ti = 0; ti < textNodes.length; ti++) {
          var node = textNodes[ti];
          var text = node.nodeValue || '';
          // GAPS-169: match ranges via the ldk/Uqp/adk port above
          // (markdown-link URL exclusion + advance o+1 overlap scan).
          var ranges = planFindMatchRanges(text, ql);
          if (ranges.length === 0) { continue; }
          var hasOverlap = false;
          for (var ri = 1; ri < ranges.length; ri++) {
            if (ranges[ri].start < ranges[ri - 1].end) { hasOverlap = true; break; }
          }
          if (!hasOverlap) {
            // Common path (identical to the pre-169 wrapping): one
            // <mark> per match, split sequentially through the node.
            var cur = node;
            var consumed = 0;
            for (var mi2 = 0; mi2 < ranges.length; mi2++) {
              var matchNode = cur.splitText(ranges[mi2].start - consumed);
              var afterNode = matchNode.splitText(ranges[mi2].end - ranges[mi2].start);
              var mark = document.createElement('mark');
              mark.classList.add('find-match');
              var mp = matchNode.parentNode;
              mp.insertBefore(mark, matchNode);
              mark.appendChild(matchNode);
              planFindMarks.push(mark);
              planFindMatchGroups.push([mark]);
              cur = afterNode;
              consumed = ranges[mi2].end;
            }
          } else {
            // Overlapping matches (NF-2b): crossing [start,end)
            // intervals cannot each be a single <mark> element in a
            // DOM tree, so highlight ATOMIC segments — split the node
            // at every match boundary and wrap each covered atom; a
            // match's group is the list of its atom marks. Same
            // visual result as the binary's overlapping ProseMirror
            // decorations (the shared atom carries both matches), and
            // the match count/navigation use the groups (Uqp count).
            var bounds = [0, text.length];
            for (var bi = 0; bi < ranges.length; bi++) {
              bounds.push(ranges[bi].start);
              bounds.push(ranges[bi].end);
            }
            bounds.sort(function (a, b) { return a - b; });
            var groups = [];
            for (var gi = 0; gi < ranges.length; gi++) { groups.push([]); }
            var acur = node;
            var aconsumed = 0;
            for (var ai = 0; ai + 1 < bounds.length; ai++) {
              var a0 = bounds[ai];
              var a1 = bounds[ai + 1];
              if (a1 <= a0) { continue; }
              var atomNode = acur.splitText(a0 - aconsumed);
              var aAfter = atomNode.splitText(a1 - a0);
              var covering = [];
              for (var ci = 0; ci < ranges.length; ci++) {
                if (ranges[ci].start <= a0 && a1 <= ranges[ci].end) { covering.push(ci); }
              }
              if (covering.length > 0) {
                var amark = document.createElement('mark');
                amark.classList.add('find-match');
                var amp = atomNode.parentNode;
                amp.insertBefore(amark, atomNode);
                amark.appendChild(atomNode);
                planFindMarks.push(amark);
                for (var cj = 0; cj < covering.length; cj++) { groups[covering[cj]].push(amark); }
              }
              acur = aAfter;
              aconsumed = a1;
            }
            for (var gj = 0; gj < groups.length; gj++) { planFindMatchGroups.push(groups[gj]); }
          }
        }
      }
    }
    planFindUpdateCount();
    if (planFindMatchGroups.length > 0) {
      // Binary: a fresh query selects the FIRST match (currentIndex 0).
      planFindGoTo(prev >= 0 ? Math.min(prev, planFindMatchGroups.length - 1) : 0, !restoreIndex);
    }
  }

  function planFindShow() {
    planFindOpen = true;
    planFindBarEl.hidden = false;
    // Binary consumer (PlanTabContent Yt @32802787): set bar visible,
    // focusAndSelect the find input. The report lets the host set
    // glassPlanFindBarVisible + glassFindInputFocused.
    vscodeApi.postMessage({ type: 'planFindBarState', open: true, inputFocused: true });
    planFindInputEl.focus();
    planFindInputEl.select();
    if (planFindInputEl.value) { planFindRun(false); }
    else { planFindUpdateCount(); }
  }

  function planFindHide() {
    planFindOpen = false;
    vscodeApi.postMessage({ type: 'planFindBarState', open: false, inputFocused: false });
    if (planFindRefreshTimer) { clearTimeout(planFindRefreshTimer); planFindRefreshTimer = null; }
    planFindClearMarks();
    planFindBarEl.hidden = true;
    // Binary close returns focus to the plan editor; the fork's plan
    // surface lives in the chat webview, so focus returns to the
    // composer input (same as findHide). Query is kept across
    // close/reopen (editor parity, like the chat bar).
    planFindCountEl.textContent = '';
    inputEl.focus();
  }

  /* Plan bubble churn (streaming edits) rewrites .bubble-text
     innerHTML, which destroys our <mark> wrappers — refresh while open
     (trailing debounce, same as the chat find bar). */
  function schedulePlanFindRefresh() {
    if (!planFindOpen) { return; }
    if (planFindRefreshTimer) { clearTimeout(planFindRefreshTimer); }
    planFindRefreshTimer = setTimeout(function () {
      planFindRefreshTimer = null;
      if (planFindOpen) { planFindRun(true); }
    }, 250);
  }

  planFindInputEl.addEventListener('input', function () { planFindRun(false); });
  planFindInputEl.addEventListener('focus', function () {
    if (planFindOpen) { vscodeApi.postMessage({ type: 'planFindBarState', open: true, inputFocused: true }); }
  });
  planFindInputEl.addEventListener('blur', function () {
    if (planFindOpen) { vscodeApi.postMessage({ type: 'planFindBarState', open: true, inputFocused: false }); }
  });
  planFindInputEl.addEventListener('keydown', function (e) {
    if (e.key === 'Enter') {
      // Core nextPlanFindMatch/previousPlanFindMatch chords (Enter /
      // Shift+Enter) — webview keys don't reach the workbench
      // keybinding system, so they are handled here too. NO F3: the
      // binary plan family has no F3 chord (unlike chat find).
      e.preventDefault();
      planFindGoTo(planFindCurrent + (e.shiftKey ? -1 : 1));
    } else if (e.key === 'Escape') {
      e.preventDefault();
      planFindHide();
    } else if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && (e.key === 'f' || e.key === 'F')) {
      e.preventDefault();
      planFindInputEl.select();
    } else if ((e.ctrlKey || e.metaKey) && !e.altKey && (e.key === 'g' || e.key === 'G')) {
      // Binary generic find bar internal chord: Ctrl/Cmd+G = next,
      // Shift+Ctrl/Cmd+G = previous (bar keydown handler, not a
      // command keybinding).
      e.preventDefault();
      planFindGoTo(planFindCurrent + (e.shiftKey ? -1 : 1));
    }
  });
  planFindNextBtn.addEventListener('click', function () { planFindGoTo(planFindCurrent + 1); planFindInputEl.focus(); });
  planFindPrevBtn.addEventListener('click', function () { planFindGoTo(planFindCurrent - 1); planFindInputEl.focus(); });
  planFindCloseBtn.addEventListener('click', function () { planFindHide(); });

  /* ---- MENTION-LINK-TOOLBAR (GAPS-131, cursor.mentionLinkToolbar) ----
     Binary mechanism (Cursor 3.25.9, work-notes-gaps131): clicking a
     link-type mention in the composer input executes the command with
     {x: rect.left, y: rect.bottom + 2, link, onRemove}; the overlay
     service holds the payload as state plus a Promise that resolves on
     close; the toolbar renders a full-screen backdrop (z-index 100000,
     click closes) and the toolbar itself (z-index 100001) at (x, y)
     with two items: Open (openerService.open(link), then close) and
     Unlink (onRemove(), then close). The fork host mirrors the service
     (mentionLinkToolbar.ts) and posts show/hide messages here; this
     webview owns the DOM, the chips and the input, so it also performs
     the onRemove semantics: insert the URL as plain text at the caret,
     remove the chip, refocus the input (binary: insertText(link),
     mention node remove, removeLink(key), focus).
     GAPS-143: the chip-label click that requests this toolbar carries
     the NF-2 guard (see renderChips; divergence D5 in
     mentionLinkToolbar.ts), and the hosts close the controller on
     surface teardown/re-resolve (NF-1) — this webview needs no teardown
     code of its own: its DOM dies with the surface, and the host-side
     close resolves the promise and clears the controller state. */
  var mentionLinkBackdropEl = document.getElementById('mentionLinkBackdrop');
  var mentionLinkToolbarEl = document.getElementById('mentionLinkToolbar');
  var mentionLinkOpenEl = document.getElementById('mentionLinkOpen');
  var mentionLinkUnlinkEl = document.getElementById('mentionLinkUnlink');
  var mentionLinkCurrent = null; // {x, y, link, uuid} while the toolbar is open

  /* Mirror of the host predicate (services/mentionLinkToolbar.ts):
     single whitespace-free token, URL-parseable, http/https, raw paste
     under 2000 chars (binary desk 24723930: length < 2e3 + URL check;
     the binary exact URL predicate is UNKNOWN — see D3 in the notes). */
  function isAutoParseLinkText(text) {
    if (!text || text.length >= 2000) { return false; }
    var trimmed = text.replace(/^\\s+|\\s+$/g, '');
    if (!trimmed || /\\s/.test(trimmed)) { return false; }
    var parsed;
    try { parsed = new URL(trimmed); } catch (err) { return false; }
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  }

  /* Binary insertLink({url, uuid}): the pasted URL becomes a link chip.
     Deduped by stable id like insertMention; the chip label is the URL
     (the binary mention node text is the URL itself). */
  function insertLinkMention(url) {
    var id = 'link:' + url;
    if (!chips.some(function (c) { return c.id === id; })) {
      chips.push({
        uuid: mentionUuid(),
        id: id,
        label: url,
        rawText: url,
        mentionType: 'link',
        payload: { case: 'linkSelection', url: url }
      });
      renderChips();
    }
    updateSubmitButton();
    inputEl.focus();
  }

  function showMentionLinkToolbar(payload) {
    if (!payload || typeof payload.link !== 'string') { return; }
    mentionLinkCurrent = payload;
    mentionLinkToolbarEl.style.left = payload.x + 'px';
    mentionLinkToolbarEl.style.top = payload.y + 'px';
    mentionLinkBackdropEl.hidden = false;
    mentionLinkToolbarEl.hidden = false;
  }

  /* notify=true posts mentionLinkToolbarClose so the host resolves the
     pending command promise (binary closeMentionLinkToolbar). Host-
     initiated hides pass notify=false to avoid an echo loop. */
  function hideMentionLinkToolbar(notify) {
    if (!mentionLinkCurrent) { return; }
    mentionLinkCurrent = null;
    mentionLinkBackdropEl.hidden = true;
    mentionLinkToolbarEl.hidden = true;
    if (notify) { vscodeApi.postMessage({ type: 'mentionLinkToolbarClose' }); }
  }

  mentionLinkBackdropEl.addEventListener('click', function () { hideMentionLinkToolbar(true); });
  mentionLinkOpenEl.addEventListener('click', function () {
    if (!mentionLinkCurrent) { return; }
    var link = mentionLinkCurrent.link;
    /* Binary: openerService.open(link) then close. The host owns the
       opener in the fork, and its open case also closes the toolbar
       host-side; hide locally without the close echo. */
    mentionLinkCurrent = null;
    mentionLinkBackdropEl.hidden = true;
    mentionLinkToolbarEl.hidden = true;
    vscodeApi.postMessage({ type: 'mentionLinkToolbarOpen', link: link });
  });
  mentionLinkUnlinkEl.addEventListener('click', function () {
    if (!mentionLinkCurrent) { return; }
    var cur = mentionLinkCurrent;
    /* Binary onRemove semantics: insertText(link) at the caret, remove
       the mention, refocus — then close (which posts the close). */
    var v = inputEl.value;
    var caret = inputEl.selectionStart == null ? v.length : inputEl.selectionStart;
    var end = inputEl.selectionEnd == null ? caret : inputEl.selectionEnd;
    inputEl.value = v.slice(0, caret) + cur.link + v.slice(end);
    var np = caret + cur.link.length;
    chips = chips.filter(function (c) { return c.uuid !== cur.uuid; });
    renderChips();
    hideMentionLinkToolbar(true);
    inputEl.focus();
    inputEl.selectionStart = inputEl.selectionEnd = np;
    updateSubmitButton();
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
        /* A resync may bring human bubbles → re-evaluate the nudge gate. */
        updatePlanNudge();
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
        /* DEV-GAPS-119: the cleared draft is an empty prompt again. */
        reportInputEmpty();
        closeMenus();
        /* GAPS-46D: a new chat drops the custom mode (host clears it too). */
        customModeState = null;
        renderCustomModeBadge();
        // New chat clears the draft → the slot morphs back to the disabled send state.
        updateSubmitButton();
        /* Context ring: a new chat resets every figure — the host re-pushes
           live data (forced emit) right after this reset. */
        ctxSources = null;
        ctxTotalTokens = 0;
        ctxWindowPct = null;
        renderCtxRing();
        ctxPop.style.display = 'none';
        renderQueueList([]);
        clearQuestions();
        /* Plan mode parity: a new chat resets the mode to agent (host also
           resets ModeService) and drops any pending plan tray. */
        setActiveMode('agent');
        document.getElementById('planTray').hidden = true;
        /* DEV-DEBUG-HOLD-UI: a new chat drops the debug wait + log lines. */
        resetDebugLogs();
        /* GAPS-3-MODESUI: a new chat is a new nudge session (dismissed
           resets) and clears pill state. */
        planNudgeDismissed = false;
        updatePlanNudge();
        pillCanvas = null;
        pillGoal = null;
        pillQueueCount = 0;
        pillExpanded = { plan: false, debug: false, canvas: false, goal: false, queue: false };
        renderPills();
        break;
      case 'bubbles':
        (msg.bubbles || []).forEach(patchBubble);
        /* A human bubble may have arrived → re-evaluate the nudge gate. */
        updatePlanNudge();
        break;
      case 'approval':
        if (msg.request) { showApproval(msg.request); } else { clearApproval(); }
        break;
      case 'restoreInput':
        /* GAPS-11B (agent-abort-restore-query): Cursor parity — the host
           fired restorePrompt after a user Stop (its
           abortAgentAndRestoreQuery). Put the aborted turn's prompt back
           into the input so the user can edit and resubmit; caret goes to
           the end and the submit slot re-morphs to Send. Only refill when
           the input is empty — the user may have typed a follow-up while
           the turn was running, and that draft must never be clobbered. */
        if (typeof msg.text === 'string' && msg.text && !inputEl.value.trim()) {
          inputEl.value = msg.text;
          inputEl.selectionStart = inputEl.selectionEnd = inputEl.value.length;
          updateSubmitButton();
          /* DEV-GAPS-119: the restored draft makes the prompt non-empty. */
          reportInputEmpty();
          inputEl.focus();
        }
        break;
      case 'queue':
        renderQueue(msg.length || 0);
        renderQueueList(msg.items);
        /* GAPS-3-MODESUI / Task 4: the queued pill mirrors the queue count
           (binary: glass-queue-pill visible iff N>0). */
        pillQueueCount = msg.length || 0;
        renderPills();
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
        /* GAPS-157: the host posts the plan's bubbleId (PendingPlan.
           bubbleId) — the plan find bar scopes its search to exactly
           that bubble's element. */
        planBubbleId = (typeof msg.bubbleId === 'string' && msg.bubbleId) ? msg.bubbleId : null;
        pillExpanded.plan = false;
        renderPills();
        break;
      case 'planCleared':
        document.getElementById('planTray').hidden = true;
        /* GAPS-157: no pending plan → no plan find surface; close the
           bar if it was open (its context keys follow via the hide
           report) and forget the scope. */
        planBubbleId = null;
        if (planFindOpen) { planFindHide(); }
        pillExpanded.plan = false;
        renderPills();
        break;
      case 'customMode':
        /* GAPS-46D (agent-custom-modes): host pushes the active custom-mode
           session (or null after exit) → render the chat-input badge. */
        customModeState = msg.active || null;
        renderCustomModeBadge();
        break;
      case 'debugLogLine':
        // DEV-DEBUG-HOLD-UI (spec D5): live NDJSON line from the ingest server.
        if (typeof msg.line === 'string') { appendDebugLogLine(msg.line); }
        renderPills();
        break;
      case 'debugLogHistory':
        // DEV-DEBUG-HOLD-UI: buffered history (capped at 100) — replaces
        // rendered lines; live lines keep appending after.
        if (Array.isArray(msg.lines)) {
          setDebugLogHistory(msg.lines.filter(function (l) { return typeof l === 'string'; }));
        }
        renderPills();
        break;
      case 'debugState':
        // DEV-DEBUG-HOLD-UI (spec D4/D5): show/hide the block + waiting
        // indicator. Visibility follows the chat mode ('mode' messages);
        // waitingForUser drives the indicator + Proceed/Mark fixed affordance.
        debugWaitingForUser = msg.waitingForUser === true;
        renderDebugLogs();
        /* GAPS-3-MODESUI / Task 4: the debug pill's attention style follows
           the waiting state. */
        renderPills();
        break;
      case 'prefill':
        // K-14: terminal AI command — host prefills the input, user reviews and sends.
        if (typeof msg.text === 'string') {
          inputEl.value = msg.text;
          // Prefilled text → the slot morphs to "Send message".
          updateSubmitButton();
          /* GAPS-3-MODESUI / Task 3: prefilled text may hit the keywords. */
          updatePlanNudge();
          inputEl.focus();
        }
        break;
      case 'canvasState':
        /* GAPS-3-MODESUI / Task 4: host announces canvas attach/detach.
           No canvas feature exists yet — this stays null until one lands. */
        (function () {
          var c = msg.canvas;
          pillCanvas = (c && typeof c === 'object')
            ? { path: typeof c.path === 'string' ? c.path : '', label: typeof c.label === 'string' ? c.label : 'Canvas' }
            : null;
          if (!pillCanvas) { pillExpanded.canvas = false; }
          renderPills();
        })();
        break;
      case 'goalState':
        /* GAPS-3-MODESUI / Task 4: host announces goal set/cleared.
           No goal feature exists yet — this stays null until one lands. */
        (function () {
          var g = msg.goal;
          pillGoal = (g && typeof g === 'object')
            ? { objective: typeof g.objective === 'string' ? g.objective : '', paused: g.paused === true }
            : null;
          if (!pillGoal) { pillExpanded.goal = false; }
          renderPills();
        })();
        break;
      case 'focusInput':
        // DEV-KEYBOARD-FIX: Ctrl+I "Focus Chat Input" (Cursor parity) — the
        // host reveals the chat surface first, then asks the webview to move
        // DOM focus into the composer input.
        inputEl.focus();
        break;
      case 'openAddContextMenu':
        // DEV-GAPS-76 / W76D-R: host trigger for ide.openAddContextMenu
        // (binary composer.openAddContextMenu -> triggerAddContextMenu).
        // Opens the add-context ("+") menu — same render the "+" button
        // uses — but always opens (never toggles shut): a host trigger is
        // an explicit open request, like Cursor's triggerAddContextMenu.
        renderAddContextMenu();
        addContextMenu.hidden = false;
        break;
      case 'showFindInChat':
        // FIND-IN-CHAT (ide.findInChat): show the overlay find bar over the
        // transcript. Posted by the host when Ctrl/Cmd+F fires on the chat
        // surface (workbench core delegates composer.findInChat here).
        findShow();
        break;
      case 'hideFindInChat':
        // FIND-IN-CHAT (ide.hideFindInChat): hide the bar, return focus to
        // the composer input. Posted by the host on Escape (chat surface
        // focused); Escape inside the find input is handled locally.
        findHide();
        break;
      case 'findNextInChat':
        // DEV-GAPS-29 (binary composer.find.next, F3/Enter): advance to the
        // next match. Fires via the core keybinding when the bar is open but
        // DOM focus has left the find input (when the input has focus, its
        // own keydown handler covers Enter/F3).
        findGoTo(findCurrent + 1);
        break;
      case 'findPreviousInChat':
        // DEV-GAPS-29 (binary composer.find.previous, Shift+F3/Shift+Enter).
        findGoTo(findCurrent - 1);
        break;
      case 'showFindInPlan':
        // GAPS-157 (ide.showPlanFind): show the plan find bar over the
        // pending plan. Posted by the host when Ctrl/Cmd+F fires with a
        // plan tray visible (workbench core delegates showPlanFind here,
        // the fork port of the binary's planFindRequested event).
        planFindShow();
        break;
      case 'hideFindInPlan':
        // GAPS-157 (ide.hidePlanFind): hide the bar, return focus to the
        // composer input (the binary's planFindCloseRequested consumer
        // returns focus to the plan editor; see planFindHide).
        planFindHide();
        break;
      case 'findNextInPlan':
        // GAPS-157 (binary nextPlanFindMatch, Enter): advance to the
        // next plan match. Fires via the core keybinding when the bar
        // is open but DOM focus has left the find input (when the input
        // has focus, its own keydown handler covers Enter).
        planFindGoTo(planFindCurrent + 1);
        break;
      case 'findPreviousInPlan':
        // GAPS-157 (binary previousPlanFindMatch, Shift+Enter).
        planFindGoTo(planFindCurrent - 1);
        break;
      case 'showMentionLinkToolbar':
        // GAPS-131 (cursor.mentionLinkToolbar): the host controller
        // (uiOverlayService mirror) posts the payload the core command
        // received — render the Open/Unlink toolbar at (x, y).
        showMentionLinkToolbar(msg);
        break;
      case 'hideMentionLinkToolbar':
        // GAPS-131: external close (a newer show replaced this surface,
        // tab teardown) — hide without posting a close echo.
        hideMentionLinkToolbar(false);
        break;
      case 'jumpToNextUserMessageRequested':
        // DEV-GAPS-119 (chat-jump-messages-kbd): binary-verbatim event of
        // the glass command jumpToNextUserMessage (Cmd/Ctrl+Down) —
        // scroll the transcript to the next own (human) message.
        jumpToHumanMessage(1);
        break;
      case 'jumpToPrevUserMessageRequested':
        // DEV-GAPS-119: binary-verbatim event of jumpToPrevUserMessage
        // (Cmd/Ctrl+Up).
        jumpToHumanMessage(-1);
        break;
      case 'agentPanelScrollToEdgeRequested':
        // DEV-GAPS-119: binary-verbatim event of scrollAgentPanelToTop /
        // scrollAgentPanelToBottom (Cmd/Ctrl+Shift+Up/Down);
        // payload.direction -1 = top, +1 = bottom.
        if (msg.payload && (msg.payload.direction === -1 || msg.payload.direction === 1)) {
          scrollMessagesToEdge(msg.payload.direction);
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
            /* GAPS-176: 'chat.insert_selection.*' — emitted HERE, at the
               actual chip insertion (a deduped re-attach inserts nothing
               and emits nothing), and only for Add to Chat posts, which
               are the ones carrying tooltipInsertSource (see
               services/addToChat.ts). Editor inserts from that flow are
               always a non-empty selection; the terminal variant name is
               the only one in the binary's pipeline config (the
               empty/non_empty qualifier's semantics are UNKNOWN —
               work-notes-gaps176.md). */
            if (msg.tooltipInsertSource === 'editor') {
              postTooltipEvent('chat.insert_selection.editor.non_empty');
            } else if (msg.tooltipInsertSource === 'terminal') {
              postTooltipEvent('chat.insert_selection.terminal.empty');
            }
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
        if (Array.isArray(msg.sources)) {
          ctxSources = msg.sources;
          ctxTotalTokens = msg.totalTokens || 0;
          ctxWindowPct = typeof msg.windowPct === 'number' ? msg.windowPct : null;
          ctxContextWindowTokens = typeof msg.contextWindowTokens === 'number' && msg.contextWindowTokens > 0 ? msg.contextWindowTokens : null;
          /* Ring always re-renders (the % label); the tray only when open. */
          renderCtxRing();
          if (ctxPop.style.display === 'block') { renderCtx(); }
        }
        break;
      case 'ctxUsageReport':
        /* GAPS-167: host-built context usage report → render the panel. */
        renderCtxReport(msg.report || null);
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
           always shows the current model honestly. textContent is XSS-safe.
           DEV-GAPS-19: keep the "+" menu's Model row in sync too. */
        var modelBtn = document.getElementById('modelBtn');
        /* DEV-GAPS-19: fallback matches the host's verbatim "Auto" label
           (modelService AUTO_MODEL_LABEL, DETAIL-CHAT §4) so the Model row
           reads "Model/Auto" exactly like Cursor. */
        var label = typeof msg.label === 'string' && msg.label ? msg.label : 'Auto';
        if (modelBtn) {
          modelBtn.textContent = 'model: ' + label;
        }
        addCtxModelLabel = label;
        if (typeof renderAddContextMenu === 'function') { renderAddContextMenu(); }
        break;
    }
  });
})();
</script>
</body>
</html>`;
}
