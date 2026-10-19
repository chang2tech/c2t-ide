/**
 * Screenshot pipeline: capture → validate → base64 → MCP image block.
 *
 * Mirrors Cursor's pipeline (dissect-browser-tab.md §3):
 *   webContents.capturePage(bounds) → PNG / JPEG(80) → dataUrl
 *   → {type:"image", mimeType, base64Data} attached to the MCP tool result.
 *
 * All functions here are pure and unit-testable: the only browser touch
 * point is PageDriver.captureScreenshot, injected by the caller.
 */
import { PageDriver } from "./driver";
import {
  BrowserError,
  CaptureOptions,
  ImageBlock,
  MAX_CAPTURE_DIMENSION,
  Rect,
  ScreenshotResult,
  TextBlock,
} from "./types";
import { isJpeg, isPng } from "./png";

export const DEFAULT_JPEG_QUALITY = 80; // Cursor's value
/** Kept for compatibility; canonical value lives in types.ts. */
export const MAX_CLIP_DIMENSION = MAX_CAPTURE_DIMENSION;
/** P1: cap image bytes so a 4K full-page capture can't blow the agent context. */
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

function validateClip(clip: Rect | undefined): void {
  if (!clip) return;
  for (const k of ["x", "y", "width", "height"] as const) {
    if (!Number.isFinite(clip[k])) {
      throw new BrowserError("INVALID_ARGS", `screenshot clip.${k} must be finite, got ${clip[k]}`);
    }
  }
  if (clip.width <= 0 || clip.height <= 0) {
    throw new BrowserError("INVALID_ARGS", `screenshot clip must be positive, got ${clip.width}x${clip.height}`);
  }
  // P3 (QA-FILE-05): reject negative origins — a negative x/y would shift the
  // capture outside the page instead of clipping to it.
  if (clip.x < 0 || clip.y < 0) {
    throw new BrowserError("INVALID_ARGS", `screenshot clip x/y must be non-negative, got ${clip.x},${clip.y}`);
  }
  if (clip.width > MAX_CLIP_DIMENSION || clip.height > MAX_CLIP_DIMENSION) {
    throw new BrowserError("INVALID_ARGS", "screenshot clip exceeds maximum dimension");
  }
}

/** Resolve an element selector to a bounding rect inside the page. */
export async function resolveElementRect(driver: PageDriver, selector: string): Promise<Rect> {
  const rect = await driver.evaluate<Rect | null>(
    `(function(){var el=document.querySelector(${JSON.stringify(selector)});` +
      `if(!el)return null;var r=el.getBoundingClientRect();` +
      `return {x:r.x,y:r.y,width:r.width,height:r.height};})()`,
  );
  if (!rect || rect.width <= 0 || rect.height <= 0) {
    throw new BrowserError("CAPTURE_FAILED", `element screenshot: selector "${selector}" matched nothing visible`);
  }
  return rect;
}

/** Capture via the driver and return the raw result (validated). */
export async function capture(driver: PageDriver, opts: CaptureOptions = {}): Promise<ScreenshotResult> {
  validateClip(opts.clip);
  const effective: CaptureOptions = { ...opts };
  if (opts.element && !opts.clip) {
    effective.clip = await resolveElementRect(driver, opts.element);
    effective.type = "element";
    // P2: element rects come from page content — validate them against the
    // same dimension cap as user-supplied clips before capturing.
    validateClip(effective.clip);
  }
  if (effective.format === "jpeg" && effective.quality !== undefined) {
    if (effective.quality < 1 || effective.quality > 100) {
      throw new BrowserError("INVALID_ARGS", "jpeg quality must be 1-100");
    }
  }
  const shot = await driver.captureScreenshot(effective);
  const ok = shot.mimeType === "image/png" ? isPng(shot.data) : isJpeg(shot.data);
  if (!ok) {
    throw new BrowserError("CAPTURE_FAILED", `capture returned bytes that are not ${shot.mimeType}`);
  }
  // P1: reject oversized captures instead of blowing the agent's context window.
  if (shot.data.length > MAX_IMAGE_BYTES) {
    throw new BrowserError(
      "CAPTURE_FAILED",
      `screenshot is ${shot.data.length} bytes, exceeding the ${MAX_IMAGE_BYTES}-byte cap; retry with a smaller clip or viewport`,
    );
  }
  return shot;
}

/** Build the MCP image content block the agent literally sees. */
export function toImageBlock(shot: ScreenshotResult): ImageBlock {
  return {
    type: "image",
    mimeType: shot.mimeType,
    base64Data: shot.data.toString("base64"),
  };
}

/** dataUrl form (for frozen frames / UI thumbs). */
export function toDataUrl(shot: ScreenshotResult): string {
  return `data:${shot.mimeType};base64,${shot.data.toString("base64")}`;
}

/**
 * Full tool-result shape for browser_screenshot, mirroring Cursor's:
 * text summary + image block (+ metadata the host can log).
 */
export async function captureForAgent(
  driver: PageDriver,
  opts: CaptureOptions & { filename?: string } = {},
): Promise<{ content: Array<TextBlock | ImageBlock>; meta: { mimeType: string; bytes: number } }> {
  const shot = await capture(driver, opts);
  const image = toImageBlock(shot);
  const label = opts.filename ? ` Filename: ${opts.filename}.` : "";
  const text: TextBlock = {
    type: "text",
    text: `Screenshot captured successfully (${shot.mimeType}, ${shot.data.length} bytes).${label}`,
  };
  return {
    content: [text, image],
    meta: { mimeType: shot.mimeType, bytes: shot.data.length },
  };
}
