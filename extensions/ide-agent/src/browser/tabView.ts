/**
 * Browser tab webview HTML — the user-visible browser chrome.
 *
 * Mirrors Cursor's browser tab chrome (dissect-browser-tab.md §2): an omnibar
 * (back / forward / reload / location bar / loading indicator) above the page
 * viewport, plus IDE-agent affordances: screenshot-to-chat and element picker.
 * The page itself is rendered by the host via CDP screencast frames (the
 * extension host cannot overlay a native WebContentsView — that is fork work,
 * tracked as the QA-DOC-05 P0; screencast is the faithful extension-level
 * rendering of the same BrowserService session the agent drives).
 *
 * Pure function of state → HTML string; unit-tested in test/run-tests.ts.
 */

/** Navigation + chrome state pushed from the host. */
export interface BrowserTabState {
  url: string;
  title: string;
  loading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  pickerMode: boolean;
  /** Viewport CSS size of the page (for click coordinate mapping). */
  viewportWidth: number;
  viewportHeight: number;
  /** "live" (screencast) or "snapshot" (periodic capture fallback). */
  renderMode: "live" | "snapshot";
  /** Page zoom percent, 25–500 (Cursor: BrowserMoreMenu zoom row). */
  zoomPercent: number;
  /** Area-select mode: user drags a rectangle to capture. */
  areaSelectMode: boolean;
}

/** Clear-data kinds (Cursor: "Clear Browsing History" / "Clear Cookies" / "Clear Cache"). */
export type ClearDataKind = "history" | "cookies" | "cache";

/**
 * Chromium's standard page-zoom ladder (percent). Cursor's browser menu
 * clamps zoom to 25–500 (BrowserMoreMenu.react.js: Zep=25, Qep=500).
 */
export const ZOOM_LADDER = [25, 33, 50, 67, 75, 80, 90, 100, 110, 125, 150, 175, 200, 250, 300, 400, 500];
export const ZOOM_MIN = 25;
export const ZOOM_MAX = 500;
export const ZOOM_DEFAULT = 100;

/** Next zoom step up the ladder (clamped to ZOOM_MAX). */
export function zoomStepIn(current: number): number {
  for (const z of ZOOM_LADDER) if (z > current) return z;
  return ZOOM_MAX;
}

/** Next zoom step down the ladder (clamped to ZOOM_MIN). */
export function zoomStepOut(current: number): number {
  for (let i = ZOOM_LADDER.length - 1; i >= 0; i--) if (ZOOM_LADDER[i] < current) return ZOOM_LADDER[i];
  return ZOOM_MIN;
}

/** Clamp an arbitrary zoom value to [ZOOM_MIN, ZOOM_MAX]. */
export function clampZoom(value: number): number {
  if (!Number.isFinite(value)) return ZOOM_DEFAULT;
  return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Math.round(value)));
}

/** Messages the webview posts to the host. */
export type BrowserTabWebviewMessage =
  | { type: "navigate"; url: string }
  | { type: "back" }
  | { type: "forward" }
  | { type: "reload" }
  | { type: "pageClick"; x: number; y: number }
  | { type: "pageWheel"; deltaX: number; deltaY: number; x: number; y: number }
  | { type: "pageKey"; key: string }
  | { type: "screenshot" }
  | { type: "togglePicker" }
  | { type: "refreshSnapshot" }
  | { type: "captureArea" }
  | { type: "areaSelect"; x: number; y: number; width: number; height: number }
  | { type: "cancelAreaSelect" }
  | { type: "hardReload" }
  | { type: "copyUrl" }
  | { type: "zoomIn" }
  | { type: "zoomOut" }
  | { type: "zoomReset" }
  | { type: "clearData"; kind: ClearDataKind }
  | { type: "openDevTools" };

/**
 * Validate an inbound webview message (the webview is untrusted input).
 * Returns the message when well-formed, null otherwise.
 */
export function validateBrowserTabMessage(msg: unknown): BrowserTabWebviewMessage | null {
  if (typeof msg !== "object" || msg === null) return null;
  const m = msg as Record<string, unknown>;
  const num = (v: unknown): number | null =>
    typeof v === "number" && Number.isFinite(v) ? v : null;
  switch (m.type) {
    case "navigate":
      return typeof m.url === "string" && m.url.length > 0 && m.url.length <= 2048
        ? { type: "navigate", url: m.url }
        : null;
    case "back":
    case "forward":
    case "reload":
    case "screenshot":
    case "togglePicker":
    case "refreshSnapshot":
    case "captureArea":
    case "cancelAreaSelect":
    case "hardReload":
    case "copyUrl":
    case "zoomIn":
    case "zoomOut":
    case "zoomReset":
    case "openDevTools":
      return { type: m.type } as BrowserTabWebviewMessage;
    case "clearData":
      return m.kind === "history" || m.kind === "cookies" || m.kind === "cache"
        ? { type: "clearData", kind: m.kind }
        : null;
    case "areaSelect": {
      const x = num(m.x);
      const y = num(m.y);
      const w = num(m.width);
      const h = num(m.height);
      // Bounds: page CSS px, positive size, capped to sane maxima.
      return x !== null && y !== null && w !== null && h !== null && w > 0 && h > 0 && w <= 16384 && h <= 16384
        ? { type: "areaSelect", x, y, width: w, height: h }
        : null;
    }
    case "pageClick": {
      const x = num(m.x);
      const y = num(m.y);
      return x !== null && y !== null ? { type: "pageClick", x, y } : null;
    }
    case "pageWheel": {
      const dx = num(m.deltaX);
      const dy = num(m.deltaY);
      const x = num(m.x);
      const y = num(m.y);
      return dx !== null && dy !== null && x !== null && y !== null
        ? { type: "pageWheel", deltaX: dx, deltaY: dy, x, y }
        : null;
    }
    case "pageKey":
      return typeof m.key === "string" && m.key.length > 0 && m.key.length <= 32
        ? { type: "pageKey", key: m.key }
        : null;
    default:
      return null;
  }
}

/**
 * Normalize a raw omnibar entry to a navigable URL.
 * Bare domains become https://…; localhost/loopback/private hosts become
 * http://…; anything else must already be http(s).
 * Returns null when the entry is not a navigable URL (host shows a toast).
 */
export function normalizeOmnibarUrl(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  // Absolute URL with a parseable scheme: only http(s) may navigate.
  // javascript:/data:/file:/vbscript:/blob:/about:/chrome:/view-source:
  // all parse successfully, so every one of them is rejected right here
  // (P0 — the omnibar must never become a local-file exfil channel).
  try {
    const u = new URL(trimmed);
    if (u.protocol === "http:" || u.protocol === "https:") return u.toString();
    // A "<word>:<digits>[/…]" that parsed as a non-http(s) "scheme" is really
    // host:port (e.g. "localhost:3000") — not a scheme at all. Anything else
    // with a non-http(s) scheme (javascript:/data:/file:/…) is rejected
    // outright (P0 — the omnibar must never become a local-file exfil channel).
    const hostPort = /^([A-Za-z0-9_.-]+):(\d{1,5})(\/.*)?$/.exec(trimmed);
    if (!hostPort) return null;
    const asHttp = new URL(`http://${hostPort[1]}:${hostPort[2]}${hostPort[3] ?? ""}`);
    if (!isLocalHost(asHttp.hostname.toLowerCase())) return null;
    return asHttp.toString();
  } catch {
    /* Not an absolute URL — fall through to the bare-host handling. */
  }
  // No parseable scheme at all (e.g. "example.com", "localhost", "127.0.0.1:8080").
  // A parseable non-http(s) scheme can never reach here: it was rejected
  // above — so forcing an http(s) scheme here cannot smuggle one in.
  try {
    const probe = new URL(`http://${trimmed}`);
    const host = probe.hostname.toLowerCase();
    if (!host) return null;
    if (isLocalHost(host)) return probe.toString();
    // Bare public domain → https:// (existing behavior).
    if (host.includes(".")) return new URL(`https://${trimmed}`).toString();
  } catch {
    /* fall through */
  }
  return null;
}

/** Loopback / private-network hostnames get plain http (QA-BROWSERTAB-01 P2). */
function isLocalHost(host: string): boolean {
  return (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host === "127.0.0.1" ||
    host === "[::1]" ||
    host.startsWith("127.") ||
    host.startsWith("10.") ||
    host.startsWith("192.168.") ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host)
  );
}

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// Inline SVG icons (no emoji in UI — repo rule).
const ICONS = {
  back: '<svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M10 3L5 8l5 5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  forward:
    '<svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M6 3l5 5-5 5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  reload:
    '<svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M13.5 8a5.5 5.5 0 1 1-1.61-3.89M13.5 1.5v3h-3" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  camera:
    '<svg width="16" height="16" viewBox="0 0 16 16" fill="none"><rect x="1.5" y="4" width="13" height="9" rx="1.5" stroke="currentColor" stroke-width="1.6"/><circle cx="8" cy="8.5" r="2.6" stroke="currentColor" stroke-width="1.6"/><path d="M5.5 4l1-1.5h3l1 1.5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  picker:
    '<svg width="16" height="16" viewBox="0 0 16 16" fill="none"><circle cx="8" cy="8" r="5.5" stroke="currentColor" stroke-width="1.6"/><circle cx="8" cy="8" r="1.2" fill="currentColor"/><path d="M8 1v2.5M8 12.5V15M1 8h2.5M12.5 8H15" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>',
  plus: '<svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M8 3v10M3 8h10" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>',
  spinner:
    '<svg class="spin" width="14" height="14" viewBox="0 0 16 16" fill="none"><circle cx="8" cy="8" r="6.5" stroke="currentColor" stroke-width="2" opacity="0.25"/><path d="M14.5 8a6.5 6.5 0 0 0-6.5-6.5" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
  ellipsis:
    '<svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><circle cx="3" cy="8" r="1.4"/><circle cx="8" cy="8" r="1.4"/><circle cx="13" cy="8" r="1.4"/></svg>',
  history:
    '<svg width="13" height="13" viewBox="0 0 16 16" fill="none"><path d="M3 8a5 5 0 1 1 1.46 3.54M3 8H1.5M3 8V6.5M8 5v3l2 1.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>',
};

/**
 * Render the full browser-tab webview HTML. `nonce` must match the
 * script-src nonce in the panel's content security policy.
 */
export function renderBrowserTabHtml(nonce: string, initial: BrowserTabState): string {
  const s = initial;
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:; script-src 'nonce-${nonce}';">
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; height: 100%; overflow: hidden;
    background: var(--vscode-editor-background, #1e1e1e);
    color: var(--vscode-editor-foreground, #cccccc);
    font-family: var(--vscode-font-family, sans-serif); font-size: 13px; }
  #chrome { display: flex; align-items: center; gap: 4px; padding: 6px 8px;
    background: var(--vscode-sideBar-background, #252526);
    border-bottom: 1px solid var(--vscode-sideBar-border, #2d2d2d); }
  .btn { display: inline-flex; align-items: center; justify-content: center;
    width: 28px; height: 28px; border: none; border-radius: 5px; cursor: pointer;
    background: transparent; color: var(--vscode-icon-foreground, #cccccc); }
  .btn:hover:not(:disabled) { background: var(--vscode-toolbar-hoverBackground, #3a3a3a); }
  .btn:disabled { opacity: 0.35; cursor: default; }
  .btn.active { background: rgba(255,106,0,0.18); color: #ff6a00; }
  #omnibar { flex: 1; display: flex; align-items: center; gap: 6px; height: 28px;
    padding: 0 10px; border-radius: 6px;
    background: var(--vscode-input-background, #3c3c3c);
    border: 1px solid var(--vscode-input-border, transparent); }
  #omnibar:focus-within { border-color: var(--vscode-focusBorder, #007fd4); }
  #url { flex: 1; border: none; outline: none; background: transparent; color: inherit;
    font: inherit; min-width: 0; }
  #loading { display: none; align-items: center; }
  #loading.on { display: inline-flex; }
  .spin { animation: rot 0.9s linear infinite; }
  @keyframes rot { to { transform: rotate(360deg); } }
  #viewport { position: relative; height: calc(100% - 41px); background: #fff; }
  #screen { display: block; width: 100%; height: 100%; object-fit: contain; background: #fff; }
  #screen.picking { cursor: crosshair; }
  #empty { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center;
    flex-direction: column; gap: 10px; color: #888; background: var(--vscode-editor-background, #1e1e1e); }
  #toast { position: absolute; left: 50%; bottom: 18px; transform: translateX(-50%);
    background: rgba(30,30,30,0.92); color: #ddd; border: 1px solid #3a3a3a;
    padding: 7px 14px; border-radius: 6px; font-size: 12px; display: none;
    max-width: 80%; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  #modebar { display: none; align-items: center; gap: 8px; padding: 5px 10px;
    background: rgba(255,106,0,0.10); border-bottom: 1px solid rgba(255,106,0,0.35);
    color: #ff8c2e; font-size: 12px; }
  #modebar.on { display: flex; }
  #viewport.picking #modebar { display: flex; }
  /* "..." browser menu (Cursor: BrowserMoreMenu "Browser options") */
  #menuWrap { position: relative; }
  #moreMenu { position: absolute; right: 0; top: 32px; z-index: 50; display: none;
    min-width: 230px; max-width: 300px; padding: 4px;
    background: var(--vscode-menu-background, #252526);
    border: 1px solid var(--vscode-menu-border, #454545); border-radius: 6px;
    box-shadow: 0 4px 16px rgba(0,0,0,0.45); color: var(--vscode-menu-foreground, #cccccc); }
  #menuWrap.open #moreMenu { display: block; }
  .mi { display: flex; align-items: center; width: 100%; padding: 6px 10px; border: none;
    background: transparent; color: inherit; font: inherit; font-size: 13px;
    border-radius: 4px; cursor: pointer; text-align: left; }
  .mi:hover:not(:disabled) { background: var(--vscode-menu-selectionBackground, #04395e);
    color: var(--vscode-menu-selectionForeground, #ffffff); }
  .mi:disabled { opacity: 0.4; cursor: default; }
  .msep { height: 1px; margin: 4px 6px; background: var(--vscode-menu-separatorBackground, #454545); }
  .zoomrow { display: flex; align-items: center; gap: 1px; padding: 6px 10px; font-size: 13px; }
  .zoomrow .zlabel { flex: 1; }
  .zbtn { display: inline-flex; align-items: center; justify-content: center;
    width: 22px; height: 22px; padding: 0; border: 1px solid var(--vscode-panel-border, #454545);
    background: transparent; color: inherit; cursor: pointer; font-size: 13px; line-height: 1; }
  .zbtn:first-of-type { border-radius: 3px 0 0 3px; }
  .zbtn:disabled { opacity: 0.3; cursor: default; }
  #zoomPct { display: inline-flex; align-items: center; justify-content: center; min-width: 44px;
    height: 22px; padding: 0 4px; font-size: 11px; user-select: none;
    border-top: 1px solid var(--vscode-panel-border, #454545);
    border-bottom: 1px solid var(--vscode-panel-border, #454545); }
  #zoomResetBtn { border-radius: 3px; margin-left: 3px; border: 1px solid transparent; }
  /* Area-select overlay (Cursor: "Capture Area Screenshot") */
  #areaOverlay { position: absolute; inset: 0; display: none; z-index: 40; cursor: crosshair;
    background: rgba(0,0,0,0.25); }
  #viewport.areaselect #areaOverlay { display: block; }
  #areaRect { position: absolute; display: none; border: 1.5px solid #ff6a00;
    background: rgba(255,106,0,0.12); }
  #areaHint { position: absolute; left: 50%; top: 14px; transform: translateX(-50%);
    background: rgba(30,30,30,0.92); color: #ddd; border: 1px solid #3a3a3a;
    padding: 6px 12px; border-radius: 6px; font-size: 12px; white-space: nowrap; }
</style>
</head>
<body>
  <div id="chrome">
    <button class="btn" id="backBtn" title="Back" ${s.canGoBack ? "" : "disabled"}>${ICONS.back}</button>
    <button class="btn" id="fwdBtn" title="Forward" ${s.canGoForward ? "" : "disabled"}>${ICONS.forward}</button>
    <button class="btn" id="reloadBtn" title="Reload">${ICONS.reload}</button>
    <div id="omnibar">
      <span id="loading" class="${s.loading ? "on" : ""}">${ICONS.spinner}</span>
      <input id="url" type="text" value="${esc(s.url)}" spellcheck="false" autocomplete="off"
        placeholder="Search or enter URL" aria-label="Address bar" />
    </div>
    <button class="btn" id="shotBtn" title="Screenshot — send to chat">${ICONS.camera}</button>
    <button class="btn ${s.pickerMode ? "active" : ""}" id="pickBtn" title="Pick element — send to chat">${ICONS.picker}</button>
    <div id="menuWrap">
      <button class="btn" id="moreBtn" title="Browser Menu" aria-label="Browser options" aria-haspopup="menu">${ICONS.ellipsis}</button>
      <div id="moreMenu" role="menu" aria-label="Browser options">
        <button class="mi" id="mShot" role="menuitem">Take Screenshot</button>
        <button class="mi" id="mAreaShot" role="menuitem">Capture Area Screenshot</button>
        <div class="msep" role="separator"></div>
        <button class="mi" id="mHardReload" role="menuitem">Hard Reload</button>
        <button class="mi" id="mCopyUrl" role="menuitem">Copy Current URL</button>
        <div class="msep" role="separator"></div>
        <div class="zoomrow" role="group" aria-label="Zoom"><span class="zlabel">Zoom</span><button class="zbtn" id="zOut" aria-label="Zoom out" title="Zoom out">−</button><span id="zoomPct">${s.zoomPercent || 100}%</span><button class="zbtn" id="zIn" aria-label="Zoom in" title="Zoom in">+</button><button class="zbtn" id="zoomResetBtn" aria-label="Reset zoom" title="Reset zoom to 100%">${ICONS.history}</button></div>
        <div class="msep" role="separator"></div>
        <button class="mi" id="mClearHistory" role="menuitem">Clear Browsing History</button>
        <button class="mi" id="mClearCookies" role="menuitem">Clear Cookies</button>
        <button class="mi" id="mClearCache" role="menuitem">Clear Cache</button>
        <div class="msep" role="separator"></div>
        <button class="mi" id="mDevTools" role="menuitem">Open DevTools</button>
      </div>
    </div>
  </div>
  <div id="viewport" class="${s.pickerMode ? "picking" : ""}${s.areaSelectMode ? " areaselect" : ""}">
    <div id="areaOverlay"><div id="areaHint">Drag to select an area — Esc to cancel</div><div id="areaRect"></div></div>
    <div id="modebar">Element picker active — click any element to send it to chat. <span style="opacity:.7">(toggle the picker button to exit)</span></div>
    <img id="screen" alt="Browser viewport" draggable="false" />
    <div id="empty">
      <div style="font-size:14px">No page loaded</div>
      <div style="font-size:12px;opacity:.7">Type a URL above and press Enter</div>
    </div>
    <div id="toast"></div>
  </div>
<script nonce="${nonce}">
(function () {
  var vscode = acquireVsCodeApi();
  var state = vscode.getState() || {};
  var screen = document.getElementById('screen');
  var empty = document.getElementById('empty');
  var toastEl = document.getElementById('toast');
  var urlInput = document.getElementById('url');
  var loadingEl = document.getElementById('loading');
  var backBtn = document.getElementById('backBtn');
  var fwdBtn = document.getElementById('fwdBtn');
  var viewport = document.getElementById('viewport');
  var pickBtn = document.getElementById('pickBtn');
  var toastTimer = null;
  var pageW = ${s.viewportWidth || 1280}, pageH = ${s.viewportHeight || 800};

  function post(msg) { vscode.postMessage(msg); }
  function toast(text) {
    toastEl.textContent = text;
    toastEl.style.display = 'block';
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { toastEl.style.display = 'none'; }, 2600);
  }

  urlInput.addEventListener('keydown', function (e) {
    if (e.key === 'Enter') { post({ type: 'navigate', url: urlInput.value }); }
    e.stopPropagation();
  });
  backBtn.addEventListener('click', function () { post({ type: 'back' }); });
  fwdBtn.addEventListener('click', function () { post({ type: 'forward' }); });
  document.getElementById('reloadBtn').addEventListener('click', function () { post({ type: 'reload' }); });
  document.getElementById('shotBtn').addEventListener('click', function () { post({ type: 'screenshot' }); });
  pickBtn.addEventListener('click', function () { post({ type: 'togglePicker' }); });

  // "..." browser menu (Cursor: BrowserMoreMenu).
  var menuWrap = document.getElementById('menuWrap');
  var moreBtn = document.getElementById('moreBtn');
  moreBtn.addEventListener('click', function (e) {
    e.stopPropagation();
    menuWrap.classList.toggle('open');
    // X3: move focus into the menu so arrow-key navigation works immediately.
    if (menuWrap.classList.contains('open')) {
      var first = document.querySelector('#moreMenu .mi:not(:disabled)');
      if (first) first.focus();
    }
  });
  document.addEventListener('click', function (e) {
    if (menuWrap.classList.contains('open') && !menuWrap.contains(e.target)) {
      menuWrap.classList.remove('open');
    }
  });
  function menuPost(type, extra) {
    menuWrap.classList.remove('open');
    post(Object.assign({ type: type }, extra));
  }
  document.getElementById('mShot').addEventListener('click', function () { menuPost('screenshot'); });
  document.getElementById('mAreaShot').addEventListener('click', function () { menuPost('captureArea'); });
  document.getElementById('mHardReload').addEventListener('click', function () { menuPost('hardReload'); });
  document.getElementById('mCopyUrl').addEventListener('click', function () { menuPost('copyUrl'); });
  document.getElementById('zIn').addEventListener('click', function () { post({ type: 'zoomIn' }); });
  document.getElementById('zOut').addEventListener('click', function () { post({ type: 'zoomOut' }); });
  document.getElementById('zoomResetBtn').addEventListener('click', function () { post({ type: 'zoomReset' }); });
  document.getElementById('mClearHistory').addEventListener('click', function () { menuPost('clearData', { kind: 'history' }); });
  document.getElementById('mClearCookies').addEventListener('click', function () { menuPost('clearData', { kind: 'cookies' }); });
  document.getElementById('mClearCache').addEventListener('click', function () { menuPost('clearData', { kind: 'cache' }); });
  document.getElementById('mDevTools').addEventListener('click', function () { menuPost('openDevTools'); });
  var zoomPctEl = document.getElementById('zoomPct');
  var zInBtn = document.getElementById('zIn');
  var zOutBtn = document.getElementById('zOut');
  // P3-3: Cursor disables these when no URL is loaded.
  var urlGatedBtns = [
    document.getElementById('mShot'),
    document.getElementById('mAreaShot'),
    document.getElementById('mHardReload'),
    document.getElementById('mCopyUrl'),
  ];

  // Area-select overlay: drag a rectangle, post page-CSS-px clip.
  var areaOverlay = document.getElementById('areaOverlay');
  var areaRect = document.getElementById('areaRect');
  var dragStart = null;
  areaOverlay.addEventListener('mousedown', function (e) {
    dragStart = { x: e.clientX, y: e.clientY };
    areaRect.style.display = 'block';
    e.preventDefault();
  });
  document.addEventListener('mousemove', function (e) {
    if (!dragStart) return;
    var r = areaOverlay.getBoundingClientRect();
    var x1 = Math.min(dragStart.x, e.clientX), y1 = Math.min(dragStart.y, e.clientY);
    var x2 = Math.max(dragStart.x, e.clientX), y2 = Math.max(dragStart.y, e.clientY);
    areaRect.style.left = (x1 - r.left) + 'px';
    areaRect.style.top = (y1 - r.top) + 'px';
    areaRect.style.width = (x2 - x1) + 'px';
    areaRect.style.height = (y2 - y1) + 'px';
  });
  document.addEventListener('mouseup', function (e) {
    if (!dragStart) return;
    var sx = dragStart.x, sy = dragStart.y;
    dragStart = null;
    areaRect.style.display = 'none';
    var p1 = toPage(Math.min(sx, e.clientX), Math.min(sy, e.clientY));
    var p2 = toPage(Math.max(sx, e.clientX), Math.max(sy, e.clientY));
    // X2-P3-4: toPage returns null when the stream hasn't rendered yet —
    // don't post NaN coordinates.
    if (!p1 || !p2) {
      toast('Page not rendered yet — try again in a moment');
      return;
    }
    // P3-4: clamp to the page bounds (dragging over the letterbox area can
    // produce negative or out-of-range coordinates).
    var cx1 = Math.max(0, Math.min(p1.x, pageW));
    var cy1 = Math.max(0, Math.min(p1.y, pageH));
    var cx2 = Math.max(0, Math.min(p2.x, pageW));
    var cy2 = Math.max(0, Math.min(p2.y, pageH));
    var w = cx2 - cx1, h = cy2 - cy1;
    if (w >= 4 && h >= 4) {
      menuPost('areaSelect', { x: cx1, y: cy1, width: w, height: h });
    } else {
      // P3-5: a plain click used to leave area-select mode stuck with no
      // feedback — tell the user what to do.
      toast('Drag to select an area — Esc to cancel');
    }
  });

  // Map a client point on the (possibly letterboxed) image to page CSS px.
  // Returns null when the mapping is undefined (image not rendered yet).
  function toPage(clientX, clientY) {
    var r = screen.getBoundingClientRect();
    // X2-P3-4: before the first frame renders, the rect is 0x0 → scale would
    // be NaN and every coordinate downstream would be NaN.
    if (!r.width || !r.height || !pageW || !pageH) return null;
    var scale = Math.min(r.width / pageW, r.height / pageH);
    if (!scale || !isFinite(scale)) return null;
    var dw = pageW * scale, dh = pageH * scale;
    var ox = r.left + (r.width - dw) / 2, oy = r.top + (r.height - dh) / 2;
    return { x: Math.round((clientX - ox) / scale), y: Math.round((clientY - oy) / scale) };
  }
  screen.addEventListener('click', function (e) {
    var p = toPage(e.clientX, e.clientY);
    if (!p) return;
    post({ type: 'pageClick', x: p.x, y: p.y });
  });
  screen.addEventListener('wheel', function (e) {
    e.preventDefault();
    var p = toPage(e.clientX, e.clientY);
    if (!p) return;
    post({ type: 'pageWheel', deltaX: Math.round(e.deltaX), deltaY: Math.round(e.deltaY), x: p.x, y: p.y });
  }, { passive: false });
  // Forward typing into the page (clicks focus elements first).
  document.addEventListener('keydown', function (e) {
    if (e.target === urlInput) return;
    if (e.key === 'Tab') return; // keep focus in the IDE
    // X3-P3-new-1: Escape closes the "..." menu (it used to fall through to
    // the page while the menu stayed open).
    if (e.key === 'Escape' && menuWrap.classList.contains('open')) {
      menuWrap.classList.remove('open');
      moreBtn.focus();
      e.preventDefault();
      e.stopPropagation();
      return;
    }
    // X3-P3-new-1: arrow-key navigation inside the open menu.
    if (
      menuWrap.classList.contains('open') &&
      (e.key === 'ArrowDown' || e.key === 'ArrowUp') &&
      menuWrap.contains(document.activeElement)
    ) {
      var items = Array.prototype.slice.call(
        document.querySelectorAll('#moreMenu .mi:not(:disabled), #moreMenu .zbtn:not(:disabled)'),
      );
      var idx = items.indexOf(document.activeElement);
      var next =
        e.key === 'ArrowDown'
          ? items[(idx + 1) % items.length]
          : items[(idx - 1 + items.length) % items.length];
      if (next) next.focus();
      e.preventDefault();
      e.stopPropagation();
      return;
    }
    if (e.key === 'Escape' && viewport.classList.contains('areaselect')) {
      dragStart = null;
      areaRect.style.display = 'none';
      menuPost('cancelAreaSelect');
      e.preventDefault();
      e.stopPropagation();
      return;
    }
    post({ type: 'pageKey', key: e.key });
    if (e.key.length === 1 || e.key === 'Enter' || e.key === 'Backspace') e.preventDefault();
  });

  window.addEventListener('message', function (ev) {
    var msg = ev.data || {};
    if (msg.type === 'frame') {
      if (msg.dataUrl) {
        screen.src = msg.dataUrl;
        empty.style.display = 'none';
      }
    } else if (msg.type === 'navState') {
      if (typeof msg.url === 'string' && document.activeElement !== urlInput) urlInput.value = msg.url;
      if (typeof msg.title === 'string') document.title = msg.title || 'Browser';
      backBtn.disabled = !msg.canGoBack;
      fwdBtn.disabled = !msg.canGoForward;
      loadingEl.className = msg.loading ? 'on' : '';
      if (msg.viewportWidth) pageW = msg.viewportWidth;
      if (msg.viewportHeight) pageH = msg.viewportHeight;
      var picking = !!msg.pickerMode;
      screen.classList.toggle('picking', picking);
      viewport.classList.toggle('picking', picking);
      pickBtn.classList.toggle('active', picking);
      var areaMode = !!msg.areaSelectMode;
      viewport.classList.toggle('areaselect', areaMode);
      if (!areaMode) { dragStart = null; areaRect.style.display = 'none'; }
      if (typeof msg.zoomPercent === 'number' && msg.zoomPercent > 0) {
        var zp = Math.round(msg.zoomPercent);
        zoomPctEl.textContent = zp + '%';
        zInBtn.disabled = zp >= 500;
        zOutBtn.disabled = zp <= 25;
      }
      // P3-3: disable URL-gated menu items when no page is loaded.
      if (typeof msg.hasUrl === 'boolean') {
        for (var gi = 0; gi < urlGatedBtns.length; gi++) {
          urlGatedBtns[gi].disabled = !msg.hasUrl;
        }
      }
    } else if (msg.type === 'toast') {
      toast(String(msg.text || ''));
    } else if (msg.type === 'focusOmnibar') {
      urlInput.focus();
      urlInput.select();
    }
  });
})();
</script>
</body>
</html>`;
}
