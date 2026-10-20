// IDE-CODE: Migrated from extensions/ide-agent/src/browser/index.ts (CAT-A, pure logic).
/**
 * Browser-for-agent layer — public surface.
 *
 * The user's #1 favorite Cursor feature: in-IDE browser with screenshot,
 * element picker, and direct feed to the agent.
 */
export * from "./types.js";
export { CdpClient } from "./cdp-client.js";
export { CdpPageDriver, launchHeadlessChromium } from "./driver.js";
export type { PageDriver } from "./driver.js";
export { encodePngRgba, isPng, isJpeg, solidRgba } from "./png.js";
export { capture, captureForAgent, resolveElementRect, toImageBlock, toDataUrl, DEFAULT_JPEG_QUALITY } from "./screenshot.js";
export { PICKER_SCRIPT } from "./picker-script.js";
export { PickerController } from "./picker.js";
export {
  SNAPSHOT_SCRIPT,
  SnapshotController,
  isValidRef,
  selectorForRef,
  renderSnapshotText,
  countSnapshotNodes,
} from "./snapshot.js";
export type { SnapshotNode, SnapshotOptions, SnapshotData } from "./snapshot.js";
export { BrowserService, createCdpDriverFactory, assertCdpMethodAllowed } from "./service.js";
export type { ServiceDriver, DriverFactory, ElementTarget, ScrollOptions, ClickOptions } from "./service.js";
export { createBrowserMcpTools, ALL_CURSOR_BROWSER_TOOLS } from "./mcp-tools.js";
export type { BrowserToolOptions } from "./mcp-tools.js";
// TODO(IDE-CODE): re-export BrowserTabManager etc. from
// extensions/ide-agent/src/browser/browserTab.ts (987 lines, CAT-B/C/D, not
// migrated yet) once it lands in core — the browserTab module must exist
// before this re-export is restored; do NOT add a stub.
export { renderBrowserTabHtml } from "./tabView.js";
export { browserCaptureDir, resolveChromiumPath } from "./chromium.js";
