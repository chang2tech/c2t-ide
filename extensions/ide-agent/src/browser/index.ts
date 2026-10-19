/**
 * Browser-for-agent layer — public surface.
 *
 * The user's #1 favorite Cursor feature: in-IDE browser with screenshot,
 * element picker, and direct feed to the agent.
 */
export * from "./types";
export { CdpClient } from "./cdp-client";
export { CdpPageDriver, launchHeadlessChromium } from "./driver";
export type { PageDriver } from "./driver";
export { encodePngRgba, isPng, isJpeg, solidRgba } from "./png";
export { capture, captureForAgent, resolveElementRect, toImageBlock, toDataUrl, DEFAULT_JPEG_QUALITY } from "./screenshot";
export { PICKER_SCRIPT } from "./picker-script";
export { PickerController } from "./picker";
export {
  SNAPSHOT_SCRIPT,
  SnapshotController,
  isValidRef,
  selectorForRef,
  renderSnapshotText,
  countSnapshotNodes,
} from "./snapshot";
export type { SnapshotNode, SnapshotOptions, SnapshotData } from "./snapshot";
export { BrowserService, createCdpDriverFactory, assertCdpMethodAllowed } from "./service";
export type { ServiceDriver, DriverFactory, ElementTarget, ScrollOptions, ClickOptions } from "./service";
export { createBrowserMcpTools, ALL_CURSOR_BROWSER_TOOLS } from "./mcp-tools";
export type { BrowserToolOptions } from "./mcp-tools";
export {
  BrowserTabManager,
  BROWSER_TAB_AGENT_ID,
  normalizeOmnibarUrl,
  validateBrowserTabMessage,
} from "./browserTab";
export type { BrowserTabCallbacks, BrowserTabState } from "./browserTab";
export { renderBrowserTabHtml } from "./tabView";
export { browserCaptureDir, resolveChromiumPath } from "./chromium";
