# Browser-for-agent layer (`src/browser/`)

The user's favorite Cursor feature, reimplemented: an in-IDE browser the agent
can see and touch — screenshot, element pick, direct feed into agent context.

## Architecture

```
MCP tools (mcp-tools.ts)          19 tools: all 16 of Cursor's registered browser
        │                         tools (navigate, take_screenshot, snapshot, click,
        │                         mouse_click_xy, type, fill, select_option, press_key,
        │                         scroll, drag, highlight, get_bounding_box, tabs,
        │                         cdp, lock) + our 3 extras:
        │                         browser_screenshot (back-compat alias),
        │                         browser_pick_element (xpath-payload grounding),
        │                         browser_close (session hygiene).
        │                         browser_fill_form / browser_hover are dead in
        │                         Cursor 3.25.6 and are NOT implemented.
        ▼
BrowserService (service.ts)       sessions = headless tabs, one per agent
        │                         ownership (viewId→agentId), lastInteracted,
        │                         per-session action queue, browser_lock mutex
        ├─► PickerController (picker.ts) ──► PICKER_SCRIPT (picker-script.ts)
        │      inject → start → pick → stop → frozen-frame screenshot
        │      → { uiElementSelections } keyed by xpath (Cursor's convention)
        ├─► SnapshotController (snapshot.ts) ──► SNAPSHOT_SCRIPT
        │      stamps stable data-ide-ref="e<N>" refs (Cursor uses
        │      data-cursor-ref); validates staleness/visibility/description
        │      before every ref-based action ("The page may have changed.
        │      Take a new snapshot.")
        └─► screenshot pipeline (screenshot.ts)
               capture → validate → base64 → MCP {type:"image"} block
        │
PageDriver seam (driver.ts)       CdpPageDriver: CDP over WebSocket (global, no deps).
                                  This is the SAME protocol Electron's
                                  webContents.debugger exposes — the fork's future
                                  main-process BrowserViewMainService implements
                                  this interface with zero logic changes.
```

## Key design decisions (from the REA blueprints)

- **Off-DOM WeakMap identity.** The picker script never writes tracking attributes
  into the DOM — Cursor broke Next.js HMR doing that. IDs look like
  `ide-el-<rand>-<n>`.
- **Crosshair + orange `#ff6a00` hover outline**, multi-select with per-pick hue
  coding — the exact visual language of Cursor's picker.
- **Element payload** mirrors Cursor's `buildPayload`: tagName/id/class/innerText
  (≤200)/uniqueId/DOM path/**xpath**/attributes/rect/computed styles/
  React-Vue component stack (devtools-hook detection).
- **Screenshot pipeline** mirrors Cursor's: capture → PNG / JPEG(80) →
  base64 image block attached to the tool result, so the agent literally sees it.
- **Simple Browser stays** for plain human web viewing; this layer is the
  *agent browser* (headless tabs, no editor UI required).

## Wiring into the fork

Today the driver talks CDP to a headless Chromium (used by tests and by the
extension host, where Electron main-process APIs are unavailable). When the
fork's `BrowserViewMainService` lands in `src/vs/platform/browserView/`:

1. Implement `PageDriver` against its IPC (`createBrowserView`, `capturePage`,
   `executeJavaScript`, …) — ~100 lines, no changes needed above the seam.
2. Pass the new factory to `BrowserService`. Done.

## Tests

`test/run-tests.ts` (node:test, zero deps beyond the compiled output):

- PNG encoder → valid magic bytes + dimensions
- screenshot pipeline → image block shape, base64 round-trip, clip validation
- mutex → concurrent actions serialize per session; per-agent lastInteracted;
  lock ownership
- snapshot ref registry → `/^e\d+$/` format, stamped selector, tree rendering
- browser_cdp denylist → Input.* / sensitive domains / exact methods denied
- tool schemas → all 16 Cursor names registered (+ 3 ours);
  fill_form/hover NOT registered; cdp gated off by default
- lock/highlight/viewId/click-options → browser_lock lock/unlock + invalid
  action; browser_highlight ok + durationMs default/cap; action tools honor
  explicit viewId; click doubleClick/right-button/modifiers dispatch real
  synthetic events; element alias works
- **integration** (needs chrome-headless-shell): navigate a fixture page →
  real PNG bytes from `Page.captureScreenshot` → inject picker → `pickAt`
  a real button → assert payload fields (tagName, xpath, rect, styles);
  snapshot stable refs → ref-based click/type/fill; select_option/press_key/
  bounding_box; scroll/drag/mouse_click_xy/tabs/cdp passthrough

Run: compile first (`npx tsc -p ./` from the extension dir), then
`node out/browser/test/run-tests.js`.
Set `IDE_BROWSER_CHROME` to the chrome-headless-shell binary for integration.
