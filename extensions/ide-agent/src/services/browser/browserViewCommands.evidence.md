# P0 `browser-tab-workbench-commands` — evidence notes (DEV-GAPS-49B)

## Slice 1 — REA evidence for `cursor.browserView.*` (verbatim)

**Source:** `~/workspace/ide-code-mission/docs/rea/dissect-browser-tab.md` §5
"workbench command inventory (30)" — the REA team applied an audit correction
2026-10-19: a 31st command `blur` has zero occurrences in the glass bundle and
does NOT exist. The verified unique set is **exactly 30**, not 27.

Task brief said 27; evidence says 30. Implementing per evidence (30).

### 30 verified command IDs (verbatim)
1. `cursor.browserView.executeJavaScript`
2. `cursor.browserView.executeJavaScriptInIsolatedWorld`
3. `cursor.browserView.takeScreenshot`
4. `cursor.browserView.updateScreenshot`
5. `cursor.browserView.reload`
6. `cursor.browserView.navigate`
7. `cursor.browserView.goBack`
8. `cursor.browserView.goForward`
9. `cursor.browserView.newTab`
10. `cursor.browserView.closeTab`
11. `cursor.browserView.hideTab`
12. `cursor.browserView.showHeadlessTab`
13. `cursor.browserView.newHeadlessTab`
14. `cursor.browserView.isHeadless`
15. `cursor.browserView.selectTab`
16. `cursor.browserView.focusOrShowTab`
17. `cursor.browserView.listTabs`
18. `cursor.browserView.getURL`
19. `cursor.browserView.getTitle`
20. `cursor.browserView.getConsoleLogs`
21. `cursor.browserView.getNetworkRequests`
22. `cursor.browserView.sendCDPCommand`
23. `cursor.browserView.setLocked`
24. `cursor.browserView.isLocked`
25. `cursor.browserView.setRecordingType`
26. `cursor.browserView.getRecordingType`
27. `cursor.browserView.configureDialogHandling`
28. `cursor.browserView.clearAgentDeviceEmulation`
29. `cursor.browserView.resize`

REAL BUT DIFFERENT-ID: bare `cursor.browserView.debug` does NOT exist in the
binary (0 exact hits in 3.25.6 + 3.25.9 `workbench.glass.main.js`); the real
debug surface is the two Developer-category Action2 commands
`cursor.browserView.debug.crashRenderer` ("Developer: Crash Browser Webview Renderer")
and `cursor.browserView.debug.orphanView` ("Developer: Orphan Browser View Entry"),
both `f1: true`. The previously-registered bare `cursor.browserView.debug`
(Debugger.enable/disable toggle) was fabricated — REMOVED 2026-10-20 (W1-RECOVERY).

REAL: bare `browserView.blur` (no `cursor.` prefix) — `registerCommand("browserView.blur", ...)`
at offset 40545349 in 3.25.9 `workbench.glass.main.js` (also present in 3.25.6);
handler resolves the view and calls `view.blur()`. The old "zero occurrences"
claim was wrong (searched the wrong pattern). NOT YET IMPLEMENTED in fork.

### Cross-cutting params (from §5 header)
- `viewId` (default = last interacted tab)
- `take_screenshot_afterwards` (default false; auto-attaches screenshot to action result)
- `ownerAgentId` (internal routing)

### Signature evidence
- `listTabs` returns `{viewIds, activeViewId, lastInteractedViewId, headlessViewIds, owners}`.
- `takeScreenshot {type, fullPage, viewId, ref|element, filename, ownerAgentId}`.
- `updateScreenshot(viewId, dataUrl)` — live thumb in UI service (internal, not a real action).
- `sendCDPCommand`: main-process runs `webContents.debugger`, `isAttached() || attach("1.3")`,
  then `sendCommand(method, params)`. Server-side denylist: `Input.*` rejected;
  domain-prefix deny `{Browser, Input, Storage, SystemInfo, Target, Tethering}`;
  exact-method deny (`DOM.setFileInputFiles`, `Network.clearBrowserCache`,
  `Network.clearBrowserCookies`, `Network.deleteCookies`, `Network.getAllCookies`,
  `Network.getCookies`, `Network.setCookie`, `Network.setCookies`,
  `Page.getNavigationHistory`, `Page.navigate`, `Page.navigateToHistoryEntry`).
- Console logs: main captures `console-message` → per-view `consoleLogs[]` +
  `onBrowserMessage(native-console)`; `getConsoleLogs` reads that.
- Network: `setupSessionNetworkTracking`; `getNetworkRequests` reads it.
- Device emulation: `clearAgentDeviceEmulation` (agent-scoped; ownership-checked) —
  agent can emulate mobile viewports (values UNKNOWN).
- Tab recording: `setRecordingType`/`getRecordingType`; type enum values UNKNOWN.
- Dialog handling: `configureDialogHandling` (details UNKNOWN).
- Tab locking: `browser_lock` (lock/unlock); `setLocked`/`isLocked`; lock metadata
  returned with snapshots (OBSERVED).
- Headless: `newHeadlessTab` (no editor tab), `showHeadlessTab` (promote to visible),
  `isHeadless`; headless containers rendered at `setContainerZIndex(-1)`; closing a
  tab whose view `wasHeadless` prompts **hide vs close** (OBSERVED).
- `executeJavaScript[InIsolatedWorld]` → `webContents` APIs (from
  `dissect-browser-interaction.md` line ~205).

### Reimplementation layering (from §7)
- Main: `src/vs/platform/browserView/electron-main/` service — WebContentsView
  (Cursor 3.25.6 uses WebContentsView; `BrowserView*` names are legacy).
- Workbench: `src/vs/workbench/contrib/browser/`.
- Commands: workbench-level `cursor.browserView.*`.
- MCP/extension `ide-agent`: calls the workbench commands via command execution.

Note: `ide.browserAttachToChat` + `browserEditorChatFeatures.ts` + `nativeDriver.ts`
already exist per mission notes (FORK-BROWSER-NATIVE). Check next slice.

## Slice 2 — existing code scan (find/grep, 2026-10-20)

- `cursor.browserView` in `extensions/ide-agent/src/`: only evidence notes (this
  file) + one comment at `browser/service.ts:914` (goBack/goForward analogy).
  **No command is registered yet anywhere** (also confirmed zero hits in
  `src/vs/` — grep across workbench returned nothing; the REA §7 workbench
  contribution layer exists as `src/vs/workbench/contrib/browserView/` but
  registers no `cursor.browserView.*` commands).
- Native infra present: `browser/nativeDriver.ts` (`NativeBrowserPageDriver`,
  CDP-multiplexed, `isNativeBrowserTabAvailable()`); `browser/service.ts`
  (`BrowserService` sessions, `createNativeDriverFactory`).
- Proposed `browser` API enabled in `extensions/ide-agent/package.json`
  (`enabledApiProposals: ["browser", ...]`). ExtHost surface
  (`src/vs/workbench/api/common/extHostBrowsers.ts`,
  `vscode.proposed.browser.d.ts`): `browserTabs`, `activeBrowserTab`,
  `onDidOpenBrowserTab/Close/ChangeActive/ChangeState`, `openBrowserTab(url,
  {viewColumn?, preserveFocus?, background?})`, `BrowserTab.startCDPSession()`,
  `BrowserTab.close()`. NO focus/reveal/hide primitives on BrowserTab.
- Focus workaround (real): `vscode.commands.executeCommand('vscode.open',
  vscode.Uri.parse('vscode-browser:///<id>'))` — the fork registers an editor
  resolver for `vscode-browser:/**` in
  `src/vs/workbench/contrib/browserView/electron-browser/browserView.contribution.ts`.
  The tab `id` is internal to `ExtHostBrowserTab` (not in the public proposal);
  read defensively with fallback.
- Gap for wiring: `NativeBrowserPageDriver.open()` always opens a NEW tab; the
  command registry needs to attach a driver to EXISTING tabs → add an
  `attach(tab)` path in `nativeDriver.ts` (minimal, additive).
- Test pattern to reuse: `src/browser/test/run-tests.ts` (node:test + vscode
  stub + `native-tab-shim.ts` backed by real headless Chromium when
  `IDE_BROWSER_CHROME` set); unit path runs without Chrome. Targeted tsc:
  `npm run check` in the extension dir.
- Registration site: `extensions/ide-agent/src/extension.ts` `activate()`
  (programmatic `vscode.commands.registerCommand`, matching how ide.*
  commands are registered). Cursor registers these workbench-side; the
  extension host is the layer that owns the native driver here, and extension
  `registerCommand` is the real command-registration API — no stub.

## Slice 3 — registry core + Group 1 (2026-10-20)

- New: `src/services/browser/browserViewCommands.ts` — `BrowserViewCommandRegistry`
  (viewId→view record, last-interacted defaulting, external-tab adoption,
  `take_screenshot_afterwards` result attachment) + `activateBrowserViewCommands()`.
- `src/browser/nativeDriver.ts`: exported `ProposedBrowserTab`/`ProposedBrowserCDPSession`;
  added `attachToTab(tab)` (additive; `open()` now delegates, same behavior).
- `src/browser/types.ts`: `BrowserError` code union extended additively with
  `NATIVE_API_UNAVAILABLE | UNKNOWN_VIEW | NO_VIEW`.
- `src/extension.ts`: `activateBrowserViewCommands(context)` in `activate()`.
- `src/services/test/vscode-stub.ts`: additive `commands.registerCommand` recorder.
- Group 1 wired (5): `cursor.browserView.newTab` → `openBrowserTab`;
  `navigate` → driver.navigate (P0 http/https guard kept);
  `goBack`/`goForward` → `Page.getNavigationHistory` + `Page.navigateToHistoryEntry`;
  `reload` → `Page.reload` (`ignoreCache` when `hard: true`).
- Tests: `src/services/browser/test/browserViewCommands.test.ts` (9 tests, fake
  native API + stateful fake CDP session). tsc `npm run check` clean; 9/9 pass.

## Slice 4 — Group 2 (2026-10-20)

- `registerGroup2()`: `cursor.browserView.newHeadlessTab` (open background +
  `headless: true`); `showHeadlessTab` (clear headless, focus via
  `vscode.open` on `vscode-browser:///<tabId>`); `isHeadless`;
  `hideTab` (registry `hidden` flag; page keeps running — documented
  divergence, no hide primitive in the proposal API); `closeTab`
  (CDP session disposed + tab closed + record dropped).
- Tests: +3 (12/12 pass). Targeted tsc: only error is in
  `src/mcp/symbolicFileArgs.ts(470,33)` — modified 07:48 +07 by another
  worker AFTER my session started; not my file, not touched (flagged, not fixed).

## Slice 5 — Group 3 (2026-10-20)

- `registerGroup3()`: `cursor.browserView.selectTab` / `focusOrShowTab`
  (focus via `vscode.open` on `vscode-browser:///<tabId>`; focusOrShowTab also
  clears `hidden`); `listTabs` (REA shape
  `{viewIds, activeViewId, lastInteractedViewId, headlessViewIds, owners}` +
  adopts externally opened tabs via `syncTabs()`); `getURL` / `getTitle`
  (live `tab.url` / `tab.title` from the ext host — no page round-trip).
- Tests: +3 (15/15 pass). Another worker is mid-edit in
  `src/services/test/run-debug-multitask-tests.ts` (syntax errors, not mine,
  flagged not fixed).

## Slice 6 — Group 4 (2026-10-20)

- `registerGroup4()`: `cursor.browserView.takeScreenshot` (REA arg surface
  `{type, fullPage, viewId, ref|element, filename, ownerAgentId}` → real
  `Page.captureScreenshot`; `ref` as CSS selector resolved in-page via
  `querySelector`+`getBoundingClientRect`; non-selector refs throw
  UNSUPPORTED — snapshot-ref resolution belongs to the snapshot P0);
  `updateScreenshot` (live thumbnail store); `getConsoleLogs` (lazy
  `Log.enable` + `Runtime.consoleAPICalled`/`Runtime.exceptionThrown`/
  `Log.entryAdded` → per-view buffer, cap 200); `getNetworkRequests` (lazy
  `Network.enable` + willBeSent/responseReceived/loadingFinished/loadingFailed
  correlation → per-view buffer, cap 200); `executeJavaScript` (driver
  `evaluate`, EVAL_FAILED surfacing).
- Tests: +7 (22/22 pass).

## Slice 7 — Group 5 (2026-10-20)

- `registerGroup5()`: `executeJavaScriptInIsolatedWorld`
  (`Page.getFrameTree` → `Page.createIsolatedWorld` → `Runtime.evaluate`
  with `contextId`); `sendCDPCommand` (multiplexed over the view's CDP
  session AFTER Cursor's server-side denylist: `Input.*` rejected,
  domain-prefix deny {Browser, Input, Storage, SystemInfo, Target,
  Tethering}, exact-method deny list verbatim from REA);
  `resize` (`Emulation.setDeviceMetricsOverride`);
  `debug` (`Debugger.enable`/`Debugger.disable` + per-view flag — exact
  Cursor semantics UNKNOWN, wired to the real debugger substrate);
  `clearAgentDeviceEmulation` (`Emulation.clearDeviceMetricsOverride`).
- Tests: +4 (26/26 pass).

## Slice 8 — Group 6 + completeness (2026-10-20)

- `registerGroup6()`: `setLocked`/`isLocked` (registry `browser_lock` state +
  owner); `setRecordingType`/`getRecordingType` (stored verbatim per view —
  enum values UNKNOWN per REA); `configureDialogHandling`
  (accept/dismiss + promptText; `Page.javascriptDialogOpening` auto-handled
  via `Page.handleJavaScriptDialog`, real CDP).
- Completeness test: registered IDs deep-equal the 30 REA-verified IDs
  (sorted); no `blur`, no extras.
- Final: tsc clean on all touched files; 30/30 tests pass; existing
  `browser/test/run-tests.js` 114/114 pass (nativeDriver refactor safe).
- Concurrent-worker noise (flagged, NOT fixed — not my files):
  `src/mcp/symbolicFileArgs.ts(470,33)` and `src/mcp/index.ts` type errors,
  `src/services/test/run-debug-multitask-tests.ts` syntax errors — all from
  other workers editing mid-session.
