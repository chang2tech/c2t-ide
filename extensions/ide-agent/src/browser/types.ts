/**
 * Shared types for the ide-agent browser-for-agent layer.
 *
 * Mirrors Cursor 3.25.6's browser architecture (docs/rea/dissect-browser-tab.md,
 * docs/rea/dissect-browser-interaction.md):
 *  - native browser views managed per agent session (headless tabs + lock mutex)
 *  - screenshot pipeline: capture → PNG/JPEG → base64 image block → agent context
 *  - element picker: off-DOM WeakMap identity, crosshair + orange hover outline,
 *    multi-select hue coding, payload submitted as `uiElementSelections` keyed by xpath
 */

/** Viewport CSS-pixel rectangle. */
export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Maximum capture dimension in CSS px (P2 robustness). Shared by the
 * screenshot pipeline (screenshot.ts) and the CDP driver (driver.ts) so the
 * full-page content-size clip and element rects are capped in one place.
 */
export const MAX_CAPTURE_DIMENSION = 16384;

export type ScreenshotFormat = "png" | "jpeg";
export type ScreenshotType = "viewport" | "element" | "fullPage";

/** Raw capture result from the page driver. */
export interface ScreenshotResult {
  /** Encoded image bytes (PNG or JPEG as requested). */
  data: Buffer;
  mimeType: "image/png" | "image/jpeg";
  /** Viewport CSS size at capture time. */
  viewportWidth: number;
  viewportHeight: number;
  /** Device pixel ratio at capture time. */
  devicePixelRatio: number;
}

/** MCP image content block — the shape the agent literally sees. */
export interface ImageBlock {
  type: "image";
  mimeType: string;
  base64Data: string;
}

/** MCP text content block. */
export interface TextBlock {
  type: "text";
  text: string;
}

/** Element payload delivered to the agent for one picked element.
 *  Field list mirrors Cursor's buildPayload (dissect-browser-interaction.md §3.3). */
export interface ElementPayload {
  tagName: string;
  id: string;
  className: string;
  /** Visible text, capped at 200 chars. */
  innerText: string;
  /** Off-DOM WeakMap identity, e.g. "ide-el-<rand>-<n>". Never a DOM attribute. */
  uniqueId: string;
  /** CSS-selector path from document.body. */
  path: string;
  /** XPath — the key under which this lands in uiElementSelections. */
  xpath: string;
  /** Capped [{name, value}] attribute list. */
  attributes: Array<{ name: string; value: string }>;
  /** getBoundingClientRect() in viewport CSS px. */
  rect: Rect;
  styles: {
    color: string;
    backgroundColor: string;
    fontSize: string;
    fontFamily: string;
    display: string;
    position: string;
  };
  /** Framework detection (React/Vue devtools hooks). */
  framework: string | null;
  component: string | null;
  componentStack: string[];
}

/** One entry of the composer `uiElementSelections` context. */
export interface UiElementSelection {
  /** Keyed by e.xpath (Cursor convention). */
  xpath: string;
  payload: ElementPayload;
}

/** Result of a pick-elements flow: selections + frozen-frame screenshot. */
export interface PickResult {
  selections: UiElementSelection[];
  /** Frozen-frame screenshot taken at submit time (dataUrl). */
  frozenFrameDataUrl: string;
  /** Composer context fragment to merge. */
  context: { uiElementSelections: UiElementSelection[] };
}

export type SessionStatus = "active" | "closed";

/** A browser session = one headless tab owned by one agent. */
export interface BrowserSession {
  sessionId: string;
  /** Agent that owns this tab; cross-agent use is rejected. */
  agentId: string;
  url: string;
  title: string;
  /** Lock mutex (Cursor's browser_lock). */
  locked: boolean;
  lockedBy: string | null;
  status: SessionStatus;
  createdAt: number;
  lastInteractedAt: number;
}

/** Options for BrowserService.createSession. */
export interface CreateSessionOptions {
  agentId: string;
  url?: string;
  /** Viewport size in CSS px. Defaults to 1280x800. */
  viewport?: { width: number; height: number };
}

/** Options for screenshot capture. */
export interface CaptureOptions {
  format?: ScreenshotFormat;
  /** JPEG quality 1-100 (default 80, Cursor's value). */
  quality?: number;
  type?: ScreenshotType;
  /** Clip rect for element/viewport captures (viewport CSS px). */
  clip?: Rect;
  /** CSS selector — resolved in-page to a bounding rect for type:"element". */
  element?: string;
  fullPage?: boolean;
}

/** Minimal MCP tool definition (JSON-Schema inputs, MCP-compatible). */
export interface McpToolDef {
  name: string;
  description: string;
  inputSchema: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
  };
  handler: (args: Record<string, unknown>) => Promise<Record<string, unknown>>;
}

/** Errors thrown by the browser layer. */
export class BrowserError extends Error {
  readonly code:
    | "SESSION_NOT_FOUND"
    | "SESSION_CLOSED"
    | "OWNED_BY_ANOTHER_AGENT"
    | "TAB_LOCKED"
    | "NAVIGATION_FAILED"
    | "CAPTURE_FAILED"
    | "EVAL_FAILED"
    | "PICKER_NOT_ACTIVE"
    | "INVALID_ARGS"
    | "NO_CHROMIUM"
    | "NO_DEBUG_PORT"
    | "UNSUPPORTED"
    // Added by P0 browser-tab-workbench-commands (additive):
    | "NATIVE_API_UNAVAILABLE"
    | "UNKNOWN_VIEW"
    | "NO_VIEW";
  constructor(code: BrowserError["code"], message: string) {
    super(message);
    this.code = code;
    this.name = "BrowserError";
  }
}
