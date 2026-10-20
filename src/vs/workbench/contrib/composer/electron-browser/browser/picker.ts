// IDE-CODE: Migrated from extensions/ide-agent/src/browser/picker.ts (CAT-A, pure logic).
/**
 * PickerController — drives the injected element-picker script.
 *
 * Flow (mirrors Cursor's design-mode submit, dissect-browser-interaction.md §3.4):
 *   inject script → start picking → user picks element(s) (or programmatic
 *   highlightAt for the agent) → stop → frozen-frame screenshot →
 *   composer context { uiElementSelections } keyed by xpath.
 */
import { PageDriver } from "./driver.js";
import { PICKER_SCRIPT } from "./picker-script.js";
import { captureForAgent } from "./screenshot.js";
import { BrowserError, ElementPayload, PickResult } from "./types.js";

export interface PickerHandle {
  active: boolean;
}

export class PickerController {
  constructor(private readonly driver: PageDriver) {}

  /** Inject the picker script (idempotent). Returns whether it was fresh. */
  async inject(): Promise<{ already: boolean }> {
    const res = await this.driver.evaluate<{ ok: boolean; already?: boolean; reason?: string }>(
      PICKER_SCRIPT,
    );
    if (!res.ok) {
      throw new BrowserError("EVAL_FAILED", `picker inject failed: ${res.reason ?? "unknown"}`);
    }
    return { already: !!res.already };
  }

  /** Start interactive picking (crosshair + hover highlight in the page). */
  async start(): Promise<void> {
    await this.inject();
    const res = await this.driver.evaluate<{ ok: boolean }>(
      "window.__idePicker ? window.__idePicker.start() : {ok:false}",
    );
    if (!res.ok) throw new BrowserError("EVAL_FAILED", "picker start failed (not injected?)");
  }

  /** Stop picking and return the collected payloads. */
  async stop(): Promise<ElementPayload[]> {
    const res = await this.driver.evaluate<{ ok: boolean; selections?: ElementPayload[] }>(
      "window.__idePicker ? window.__idePicker.stop() : {ok:false}",
    );
    if (!res.ok) throw new BrowserError("PICKER_NOT_ACTIVE", "picker stop failed");
    return res.selections ?? [];
  }

  /** Clear current selections (keeps the picker injected). */
  async clear(): Promise<void> {
    await this.driver.evaluate("window.__idePicker && window.__idePicker.clear()");
  }

  /**
   * Programmatic pick: highlight whatever is at viewport (x, y) and return
   * its payload. This is how the AGENT picks without a mouse.
   *
   * The orange highlight is left in place for the caller to capture
   * (frozen-frame screenshot); the caller MUST call clearHover() afterwards
   * so the outline does not linger on the real page (P2 fix 2026-10-19).
   */
  async pickAt(x: number, y: number): Promise<ElementPayload | null> {
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      throw new BrowserError("INVALID_ARGS", `pickAt coordinates must be finite numbers, got (${x}, ${y})`);
    }
    await this.inject();
    return this.driver.evaluate<ElementPayload | null>(
      `window.__idePicker.highlightAt(${x}, ${y})`,
    );
  }

  /** Remove the orange hover outline left by highlightAt (QA-BROWSERTAB-01 P2). */
  async clearHover(): Promise<void> {
    await this.driver.evaluate("window.__idePicker && window.__idePicker.clearHover()");
  }

  /** Payload for a CSS selector (agent-side element resolution). */
  async payloadForSelector(selector: string): Promise<ElementPayload | null> {
    await this.inject();
    return this.driver.evaluate<ElementPayload | null>(
      `window.__idePicker.payloadForSelector(${JSON.stringify(selector)})`,
    );
  }

  /**
   * Full submit flow: stop picking → frozen-frame screenshot →
   * { uiElementSelections } context keyed by xpath (Cursor's convention).
   */
  async submit(): Promise<PickResult> {
    const payloads = await this.stop();
    if (payloads.length === 0) {
      throw new BrowserError("PICKER_NOT_ACTIVE", "submit with no selections — pick at least one element");
    }
    const shot = await captureForAgent(this.driver, { format: "png", type: "viewport" });
    const imageBlock = shot.content.find((c) => c.type === "image");
    const frozenFrameDataUrl =
      imageBlock && imageBlock.type === "image"
        ? `data:${imageBlock.mimeType};base64,${imageBlock.base64Data}`
        : "";
    const selections = payloads.map((payload) => ({ xpath: payload.xpath, payload }));
    return {
      selections,
      frozenFrameDataUrl,
      context: { uiElementSelections: selections },
    };
  }
}
