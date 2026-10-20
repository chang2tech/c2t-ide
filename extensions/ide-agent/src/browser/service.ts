/**
 * BrowserService — manages browser sessions (headless tabs) per agent.
 *
 * Mirrors Cursor's model (dissect-browser-tab.md):
 *  - one headless tab per agent session (no editor UI required)
 *  - resourceOwnershipService: viewId → agentId; cross-agent use is rejected
 *    ("Browser view is owned by another agent")
 *  - browser_lock: per-tab mutex for longer automations; locked tabs reject
 *    other sessions' actions until unlocked
 *  - lastInteracted tracking for default tab resolution
 *
 * The page substrate is injected as a PageDriver factory so the service is
 * fully unit-testable without a browser (fake drivers) and the fork's
 * main-process BrowserView service can back it without logic changes.
 */
import { CdpPageDriver } from "./driver";
import { NativeBrowserPageDriver } from "./nativeDriver";
import { PickerController } from "./picker";
import { captureForAgent } from "./screenshot";
import { SnapshotController } from "./snapshot";
import {
  BrowserError,
  BrowserSession,
  CaptureOptions,
  CreateSessionOptions,
  ImageBlock,
  PickResult,
  Rect,
  TextBlock,
} from "./types";

/** Debug-connection info for opening the DevTools frontend. */
export interface DriverDebugInfo {
  host: string;
  port: number;
  targetId: string;
}

/** Minimal page-driver surface the service needs (subset of PageDriver). */
export interface ServiceDriver {
  navigate(url: string, timeoutMs?: number): Promise<void>;
  captureScreenshot(opts: CaptureOptions): Promise<import("./types").ScreenshotResult>;
  evaluate<T>(script: string): Promise<T>;
  getUrl(): Promise<string>;
  getTitle(): Promise<string>;
  rawCdp<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T>;
  close(): Promise<void>;
  /** Debug info for the DevTools frontend (absent on drivers without a debug port). */
  debugInfo?(): DriverDebugInfo | undefined;
}

export type DriverFactory = (opts: { viewport: { width: number; height: number } }) => Promise<ServiceDriver>;

interface SessionRecord {
  session: BrowserSession;
  driver: ServiceDriver;
  picker: PickerController;
  /** Ref registry for snapshot-based interaction (browser_snapshot et al). */
  snapshotter: SnapshotController;
  /** Mutex chain: each action appends to this promise. */
  queue: Promise<unknown>;
}

/** Target for ref-or-selector actions (browser_click / browser_type). */
export interface ElementTarget {
  /** Snapshot ref, e.g. "e12" (preferred — validated for staleness). */
  ref?: string;
  /** CSS selector fallback. */
  selector?: string;
}

/** Options for BrowserService.scroll. */
export interface ScrollOptions {
  ref?: string;
  direction?: "up" | "down" | "left" | "right";
  /** Pixels for direction scrolls (default 500). */
  amount?: number;
  deltaX?: number;
  deltaY?: number;
  scrollIntoView?: boolean;
}

/** Options for BrowserService.click (Cursor's browser_click contract). */
export interface ClickOptions {
  /** Dispatch a real double-click sequence (mousedown/up/click x2 + dblclick). */
  doubleClick?: boolean;
  /** Mouse button: left (default), right (contextmenu), middle (auxclick). */
  button?: "left" | "right" | "middle";
  /** Modifier keys held during the click: Alt, Control, Meta, Shift. */
  modifiers?: string[];
}

/**
 * CDP denylist for browser_cdp (mirrors Cursor 3.25.6's server-side gate).
 * Input.* is banned — "use dedicated browser tools". Sensitive domains and
 * exact methods are denied outright.
 */
const CDP_DENIED_DOMAIN_PREFIXES = ["Browser", "Input", "Storage", "SystemInfo", "Target", "Tethering"];
const CDP_DENIED_EXACT_METHODS = new Set([
  "DOM.setFileInputFiles",
  "Network.clearBrowserCache",
  "Network.clearBrowserCookies",
  "Network.getAllCookies",
  "Network.getCookies",
  "Network.setCookie",
  "Network.setCookies",
  "Network.deleteCookies",
  "Page.getNavigationHistory",
  "Page.navigate",
  "Page.navigateToHistoryEntry",
]);

/** Enforce Cursor's CDP denylist. Pure and unit-testable. Throws on denial. */
export function assertCdpMethodAllowed(method: string): void {
  if (typeof method !== "string" || !/^[A-Za-z]+\.[A-Za-z]+$/.test(method)) {
    throw new BrowserError("INVALID_ARGS", `browser_cdp: invalid method "${method}"`);
  }
  const domain = method.split(".")[0];
  if (CDP_DENIED_DOMAIN_PREFIXES.includes(domain)) {
    throw new BrowserError(
      "INVALID_ARGS",
      `browser_cdp: ${domain}.* is not allowed — use the dedicated browser tools instead`,
    );
  }
  if (CDP_DENIED_EXACT_METHODS.has(method)) {
    throw new BrowserError("INVALID_ARGS", `browser_cdp: ${method} is denied`);
  }
}

/** Keyboard map for browser_press_key (DOM KeyboardEvent init). */
const KEY_MAP: Record<string, { key: string; code: string; keyCode: number }> = {
  Enter: { key: "Enter", code: "Enter", keyCode: 13 },
  Escape: { key: "Escape", code: "Escape", keyCode: 27 },
  Tab: { key: "Tab", code: "Tab", keyCode: 9 },
  Backspace: { key: "Backspace", code: "Backspace", keyCode: 8 },
  Delete: { key: "Delete", code: "Delete", keyCode: 46 },
  Home: { key: "Home", code: "Home", keyCode: 36 },
  End: { key: "End", code: "End", keyCode: 35 },
  PageUp: { key: "PageUp", code: "PageUp", keyCode: 33 },
  PageDown: { key: "PageDown", code: "PageDown", keyCode: 34 },
  ArrowUp: { key: "ArrowUp", code: "ArrowUp", keyCode: 38 },
  ArrowDown: { key: "ArrowDown", code: "ArrowDown", keyCode: 40 },
  ArrowLeft: { key: "ArrowLeft", code: "ArrowLeft", keyCode: 37 },
  ArrowRight: { key: "ArrowRight", code: "ArrowRight", keyCode: 39 },
  " ": { key: " ", code: "Space", keyCode: 32 },
};

function randomId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/** Maximum concurrent browser sessions. Oldest (LRU) is evicted on overflow. */
const MAX_SESSIONS = 8;

export class BrowserService {
  private sessions = new Map<string, SessionRecord>();
  /**
   * P1 (QA-FILE-05): last-interacted is per-agent, not global. A single
   * global pointer made agent B resolve to agent A's tab (OWNED_BY_ANOTHER_AGENT)
   * whenever A interacted last.
   */
  private lastInteractedByAgent = new Map<string, string>();

  constructor(private readonly driverFactory: DriverFactory) {}

  /** Create a headless tab owned by agentId. */
  async createSession(opts: CreateSessionOptions): Promise<BrowserSession> {
    // P1: enforce a session cap with LRU eviction so agents can't exhaust resources.
    if (this.sessions.size >= MAX_SESSIONS) {
      let oldest: SessionRecord | undefined;
      for (const rec of this.sessions.values()) {
        if (!oldest || rec.session.lastInteractedAt < oldest.session.lastInteractedAt) {
          oldest = rec;
        }
      }
      if (oldest) {
        try {
          await oldest.driver.close();
        } catch {
          /* ignore */
        }
        this.sessions.delete(oldest.session.sessionId);
        // P2 (QA-FILE-05): reset the evicted session's owner pointer too —
        // otherwise the agent would resolve to a deleted session.
        if (this.lastInteractedByAgent.get(oldest.session.agentId) === oldest.session.sessionId) {
          this.lastInteractedByAgent.delete(oldest.session.agentId);
        }
      }
    }

    const viewport = opts.viewport ?? { width: 1280, height: 800 };
    const driver = await this.driverFactory({ viewport });
    const session: BrowserSession = {
      sessionId: randomId("browser"),
      agentId: opts.agentId,
      url: "about:blank",
      title: "",
      locked: false,
      lockedBy: null,
      status: "active",
      createdAt: Date.now(),
      lastInteractedAt: Date.now(),
    };
    // CdpPageDriver has the full PageDriver surface; the picker needs it.
    const picker = new PickerController(driver as unknown as import("./driver").PageDriver);
    const snapshotter = new SnapshotController(driver as unknown as import("./driver").PageDriver);
    this.sessions.set(session.sessionId, { session, driver, picker, snapshotter, queue: Promise.resolve() });
    this.lastInteractedByAgent.set(opts.agentId, session.sessionId);
    // P1: if the initial navigate fails, close the tab instead of leaking it.
    if (opts.url) {
      try {
        await this.navigate(session.sessionId, opts.agentId, opts.url);
      } catch (err) {
        try {
          await driver.close();
        } catch {
          /* ignore */
        }
        this.sessions.delete(session.sessionId);
        if (this.lastInteractedByAgent.get(opts.agentId) === session.sessionId) {
          this.lastInteractedByAgent.delete(opts.agentId);
        }
        throw err;
      }
    }
    return { ...session };
  }

  /** Resolve a session: explicit id → agent's last interacted → most recent active. Enforces ownership and lock. */
  private requireSession(sessionId: string | undefined, agentId: string, opts: { checkLock?: boolean } = {}): SessionRecord {
    let id = sessionId ?? this.lastInteractedByAgent.get(agentId);
    if (!id) {
      // The last-interacted pointer may dangle (e.g. after tabs close); fall
      // back to the agent's most recently interacted active session.
      let best: SessionRecord | undefined;
      for (const r of this.sessions.values()) {
        if (r.session.agentId === agentId && r.session.status === "active") {
          if (!best || r.session.lastInteractedAt > best.session.lastInteractedAt) best = r;
        }
      }
      id = best?.session.sessionId;
    }
    if (!id) throw new BrowserError("SESSION_NOT_FOUND", "no browser session exists yet");
    const rec = this.sessions.get(id);
    if (!rec) throw new BrowserError("SESSION_NOT_FOUND", `browser session ${id} not found`);
    if (rec.session.status === "closed") throw new BrowserError("SESSION_CLOSED", `browser session ${id} is closed`);
    if (rec.session.agentId !== agentId) {
      throw new BrowserError(
        "OWNED_BY_ANOTHER_AGENT",
        `Browser view is owned by another agent (owner: ${rec.session.agentId})`,
      );
    }
    // P1: enforce browser_lock — locked tabs reject other sessions' mutating actions.
    if (opts.checkLock !== false && rec.session.locked && rec.session.lockedBy !== agentId) {
      throw new BrowserError("TAB_LOCKED", `tab is locked by ${rec.session.lockedBy}`);
    }
    return rec;
  }

  /** Run fn serialized per session (the lock mutex runs through the same queue). */
  private runSerialized<T>(rec: SessionRecord, fn: () => Promise<T>): Promise<T> {
    const run = rec.queue.then(fn, fn);
    // Keep the chain alive even if this action rejects.
    rec.queue = run.catch(() => undefined);
    return run;
  }

  private touch(rec: SessionRecord, agentId: string): void {
    rec.session.lastInteractedAt = Date.now();
    this.lastInteractedByAgent.set(agentId, rec.session.sessionId);
  }

  /** Lock a tab before a longer automation (Cursor's browser_lock). */
  async lock(sessionId: string | undefined, agentId: string): Promise<void> {
    const rec = this.requireSession(sessionId, agentId);
    if (rec.session.locked && rec.session.lockedBy !== agentId) {
      throw new BrowserError("TAB_LOCKED", `tab is locked by ${rec.session.lockedBy}`);
    }
    rec.session.locked = true;
    rec.session.lockedBy = agentId;
  }

  async unlock(sessionId: string | undefined, agentId: string): Promise<void> {
    const rec = this.requireSession(sessionId, agentId);
    rec.session.locked = false;
    rec.session.lockedBy = null;
  }

  async navigate(sessionId: string | undefined, agentId: string, url: string): Promise<{ url: string; title: string }> {
    const rec = this.requireSession(sessionId, agentId);
    return this.runSerialized(rec, async () => {
      await rec.driver.navigate(url);
      rec.session.url = await rec.driver.getUrl();
      rec.session.title = await rec.driver.getTitle();
      this.touch(rec, agentId);
      return { url: rec.session.url, title: rec.session.title };
    });
  }

  async screenshot(
    sessionId: string | undefined,
    agentId: string,
    opts: CaptureOptions & { filename?: string } = {},
  ): Promise<{ content: Array<TextBlock | ImageBlock>; meta: { mimeType: string; bytes: number } }> {
    const rec = this.requireSession(sessionId, agentId);
    return this.runSerialized(rec, async () => {
      const out = await captureForAgent(rec.driver as unknown as import("./driver").PageDriver, opts);
      this.touch(rec, agentId);
      return out;
    });
  }

  /** Interactive element picking (user flow): start → user picks → submit(). */
  pickerFor(sessionId: string | undefined, agentId: string): PickerController {
    const rec = this.requireSession(sessionId, agentId);
    this.touch(rec, agentId);
    return rec.picker;
  }

  /** Agent-side pick at coordinates → payload (no mouse needed). */
  async pickAt(sessionId: string | undefined, agentId: string, x: number, y: number): Promise<PickResult> {
    const rec = this.requireSession(sessionId, agentId);
    return this.runSerialized(rec, async () => {
      try {
        const payload = await rec.picker.pickAt(x, y);
        if (!payload) throw new BrowserError("EVAL_FAILED", `no pickable element at (${x}, ${y})`);
        const shot = await captureForAgent(rec.driver as unknown as import("./driver").PageDriver, {
          format: "png",
          type: "viewport",
        });
        const imageBlock = shot.content.find((c) => c.type === "image");
        const frozenFrameDataUrl =
          imageBlock && imageBlock.type === "image"
            ? `data:${imageBlock.mimeType};base64,${imageBlock.base64Data}`
            : "";
        const selections = [{ xpath: payload.xpath, payload }];
        this.touch(rec, agentId);
        return { selections, frozenFrameDataUrl, context: { uiElementSelections: selections } };
      } finally {
        // The orange highlight was visible for the frozen-frame screenshot;
        // clear it so it does not linger on the real page (QA-BROWSERTAB-01 P2).
        await rec.picker.clearHover();
      }
    });
  }

  /** Resolve an ElementTarget to a CSS selector, validating snapshot refs. */
  private async resolveTarget(rec: SessionRecord, target: ElementTarget, tool: string): Promise<string> {
    if (target.ref) {
      const { selector } = await rec.snapshotter.validate(target.ref);
      return selector;
    }
    if (target.selector) return target.selector;
    throw new BrowserError("INVALID_ARGS", `${tool}: provide ref (from browser_snapshot) or selector`);
  }

  /** Click an element by snapshot ref (preferred) or CSS selector. */
  async click(
    sessionId: string | undefined,
    agentId: string,
    target: ElementTarget,
    opts: ClickOptions = {},
  ): Promise<{ ok: boolean }> {
    const button = opts.button ?? "left";
    if (button !== "left" && button !== "right" && button !== "middle") {
      throw new BrowserError("INVALID_ARGS", 'browser_click: button must be "left"|"right"|"middle"');
    }
    const rec = this.requireSession(sessionId, agentId);
    return this.runSerialized(rec, async () => {
      const selector = await this.resolveTarget(rec, target, "browser_click");
      // Normalize modifier names to the MouseEvent init flags.
      const mods = { altKey: false, ctrlKey: false, metaKey: false, shiftKey: false };
      for (const m of opts.modifiers ?? []) {
        const k = String(m).toLowerCase();
        if (k === "alt") mods.altKey = true;
        else if (k === "control" || k === "ctrl") mods.ctrlKey = true;
        else if (k === "meta" || k === "cmd" || k === "command") mods.metaKey = true;
        else if (k === "shift") mods.shiftKey = true;
      }
      const clicked = await rec.driver.evaluate<boolean>(
        `(function(){var el=document.querySelector(${JSON.stringify(selector)});` +
          `if(!el)return false;` +
          `el.scrollIntoView({block:"center",inline:"center"});` +
          `var mods=${JSON.stringify(mods)},btn=${JSON.stringify(button)},dbl=${JSON.stringify(
            opts.doubleClick === true,
          )};` +
          `var r=el.getBoundingClientRect();` +
          `var cx=r.x+r.width/2,cy=r.y+r.height/2;` +
          `function code(){return btn==="right"?2:(btn==="middle"?1:0);}` +
          `function btns(down){if(!down)return 0;var c=code();return c===0?1:(c===1?4:2);}` +
          `function me(type,down){return new MouseEvent(type,{bubbles:true,cancelable:true,` +
          `clientX:cx,clientY:cy,button:code(),buttons:btns(down),` +
          `altKey:mods.altKey,ctrlKey:mods.ctrlKey,metaKey:mods.metaKey,shiftKey:mods.shiftKey,view:window});}` +
          `if(btn==="right"){el.dispatchEvent(me("mousedown",true));el.dispatchEvent(me("mouseup",false));` +
          `el.dispatchEvent(me("contextmenu",false));return true;}` +
          `if(btn==="middle"){el.dispatchEvent(me("mousedown",true));el.dispatchEvent(me("mouseup",false));` +
          `el.dispatchEvent(me("auxclick",false));return true;}` +
          `function once(){el.dispatchEvent(me("mousedown",true));el.dispatchEvent(me("mouseup",false));` +
          `el.dispatchEvent(me("click",false));}` +
          `once();` +
          `if(dbl){once();el.dispatchEvent(me("dblclick",false));}` +
          `return true;})()`,
      );
      if (!clicked)
        throw new BrowserError("EVAL_FAILED", `browser_click: target "${selector}" matched nothing`);
      this.touch(rec, agentId);
      return { ok: true };
    });
  }

  /** Type text into an element by snapshot ref (preferred) or CSS selector. */
  async type(
    sessionId: string | undefined,
    agentId: string,
    target: ElementTarget,
    text: string,
    opts: { clear?: boolean; submit?: boolean; slowly?: boolean } = {},
  ): Promise<{ ok: boolean }> {
    const rec = this.requireSession(sessionId, agentId);
    return this.runSerialized(rec, async () => {
      const selector = await this.resolveTarget(rec, target, "browser_type");
      const submitTail =
        `var f=el.form;if(f){f.requestSubmit?f.requestSubmit():f.submit();}` +
        `else{el.dispatchEvent(new KeyboardEvent("keydown",{key:"Enter",bubbles:true}));}`;
      if (opts.slowly === true) {
        // Human-like pacing: type character-by-character through the browser's
        // editing pipeline (document.execCommand("insertText")), with a short
        // pause between keystrokes, instead of setting the value in one shot.
        const focused = await rec.driver.evaluate<boolean>(
          `(function(){var el=document.querySelector(${JSON.stringify(selector)});` +
            `if(!el)return false;el.scrollIntoView({block:"center",inline:"center"});el.focus();` +
            (opts.clear
              ? `if("value" in el){el.value="";}else if(el.isContentEditable){el.textContent="";}`
              : "") +
            `return true;})()`,
        );
        if (!focused)
          throw new BrowserError("EVAL_FAILED", `browser_type: target "${selector}" matched nothing`);
        for (const ch of text) {
          const inserted = await rec.driver.evaluate<boolean>(
            `(function(){var el=document.activeElement;if(!el)return false;` +
              `var ch=${JSON.stringify(ch)};var done=false;` +
              `try{done=document.execCommand("insertText",false,ch);}catch(e){}` +
              `if(!done){` +
              `if("selectionStart" in el&&el.selectionStart!=null){` +
              `var s=el.selectionStart,e=el.selectionEnd;` +
              `el.value=el.value.slice(0,s)+ch+el.value.slice(e);` +
              `el.selectionStart=el.selectionEnd=s+ch.length;` +
              `el.dispatchEvent(new Event("input",{bubbles:true}));done=true;}` +
              `else if(el.isContentEditable){` +
              `var sel=window.getSelection();` +
              `if(sel&&sel.rangeCount>0){sel.deleteContents();` +
              `sel.getRangeAt(0).insertNode(document.createTextNode(ch));sel.collapseToEnd();}` +
              `else{el.textContent=(el.textContent||"")+ch;}` +
              `el.dispatchEvent(new Event("input",{bubbles:true}));done=true;}` +
              `}` +
              `return done;})()`,
          );
          if (!inserted)
            throw new BrowserError("EVAL_FAILED", "browser_type: slowly typing failed mid-stream");
          // Human-like inter-keystroke pause (~25ms).
          await new Promise((r) => setTimeout(r, 25));
        }
        await rec.driver.evaluate(
          `(function(){var el=document.activeElement||document.body;` +
            `el.dispatchEvent(new Event("change",{bubbles:true}));` +
            (opts.submit ? submitTail : "") +
            `return true;})()`,
        );
        this.touch(rec, agentId);
        return { ok: true };
      }
      const typed = await rec.driver.evaluate<boolean>(
        `(function(){var el=document.querySelector(${JSON.stringify(selector)});` +
          `if(!el)return false;el.focus();` +
          (opts.clear ? `if("value" in el)el.value="";` : "") +
          `var setter=Object.getOwnPropertyDescriptor(el.constructor.prototype,"value");` +
          `if(setter&&setter.set&&"value" in el){setter.set.call(el,${JSON.stringify(text)});}` +
          `else if(el.isContentEditable){el.textContent=${JSON.stringify(text)};}` +
          `el.dispatchEvent(new Event("input",{bubbles:true}));` +
          `el.dispatchEvent(new Event("change",{bubbles:true}));` +
          (opts.submit ? submitTail : "") +
          `return true;})()`,
      );
      if (!typed)
        throw new BrowserError("EVAL_FAILED", `browser_type: target "${selector}" matched nothing`);
      this.touch(rec, agentId);
      return { ok: true };
    });
  }

  /** Accessibility snapshot with stable e<N> refs (Cursor's core perception tool). */
  async snapshot(
    sessionId: string | undefined,
    agentId: string,
    opts: { maxDepth?: number; compact?: boolean; selector?: string; interactive?: boolean } = {},
  ): Promise<{ text: string; refCount: number }> {
    const rec = this.requireSession(sessionId, agentId);
    return this.runSerialized(rec, async () => {
      const data = await rec.snapshotter.snapshot(opts);
      this.touch(rec, agentId);
      return { text: data.text, refCount: data.refCount };
    });
  }

  /** Fill an input/textarea/contenteditable by snapshot ref (Cursor's browser_fill). */
  async fill(
    sessionId: string | undefined,
    agentId: string,
    ref: string,
    value: string,
  ): Promise<{ ok: boolean }> {
    const rec = this.requireSession(sessionId, agentId);
    return this.runSerialized(rec, async () => {
      const { selector } = await rec.snapshotter.validate(ref);
      const filled = await rec.driver.evaluate<boolean>(
        `(function(){var el=document.querySelector(${JSON.stringify(selector)});` +
          `if(!el)return false;el.focus();` +
          `var tag=(el.tagName||"").toLowerCase();` +
          `if(tag==="input"||tag==="textarea"){` +
          `var setter=Object.getOwnPropertyDescriptor(el.constructor.prototype,"value");` +
          `if(setter&&setter.set){setter.set.call(el,${JSON.stringify(value)});}` +
          `else{el.value=${JSON.stringify(value)};}` +
          `}else if(el.isContentEditable){el.textContent=${JSON.stringify(value)};}` +
          `else{return false;}` +
          `el.dispatchEvent(new Event("input",{bubbles:true}));` +
          `el.dispatchEvent(new Event("change",{bubbles:true}));` +
          `return true;})()`,
      );
      if (!filled) throw new BrowserError("EVAL_FAILED", `browser_fill: ref ${ref} is not fillable`);
      this.touch(rec, agentId);
      return { ok: true };
    });
  }

  /** Select option(s) in a <select> by snapshot ref. */
  async selectOption(
    sessionId: string | undefined,
    agentId: string,
    ref: string,
    values: string[],
  ): Promise<{ ok: boolean; selected: string[] }> {
    const rec = this.requireSession(sessionId, agentId);
    return this.runSerialized(rec, async () => {
      const { selector } = await rec.snapshotter.validate(ref);
      const selected = await rec.driver.evaluate<string[] | null>(
        `(function(){var el=document.querySelector(${JSON.stringify(selector)});` +
          `if(!el||el.tagName.toLowerCase()!=="select")return null;` +
          `var want=${JSON.stringify(values)};var out=[];` +
          `for(var i=0;i<el.options.length;i++){var o=el.options[i];` +
          `if(want.indexOf(o.value)>=0||want.indexOf(o.text)>=0){o.selected=true;out.push(o.value);}}` +
          `el.dispatchEvent(new Event("input",{bubbles:true}));` +
          `el.dispatchEvent(new Event("change",{bubbles:true}));` +
          `return out;})()`,
      );
      if (!selected)
        throw new BrowserError("EVAL_FAILED", `browser_select_option: ref ${ref} is not a <select>`);
      this.touch(rec, agentId);
      return { ok: true, selected };
    });
  }

  /** Press a keyboard key via DOM keyboard events (not CDP Input — Cursor's rule). */
  async pressKey(sessionId: string | undefined, agentId: string, key: string): Promise<{ ok: boolean }> {
    if (typeof key !== "string" || key.length === 0) {
      throw new BrowserError("INVALID_ARGS", "browser_press_key: key is required");
    }
    const rec = this.requireSession(sessionId, agentId);
    return this.runSerialized(rec, async () => {
      let def = KEY_MAP[key];
      if (!def && key.length === 1) {
        def = {
          key,
          code: /[a-zA-Z]/.test(key) ? `Key${key.toUpperCase()}` : "",
          keyCode: key.charCodeAt(0),
        };
      }
      if (!def) throw new BrowserError("INVALID_ARGS", `browser_press_key: unsupported key "${key}"`);
      const pressed = await rec.driver.evaluate<boolean>(
        `(function(){var d=${JSON.stringify(def)};` +
          `var t=document.activeElement&&document.activeElement!==document.body?document.activeElement:document.body;` +
          `function ev(type){return new KeyboardEvent(type,{key:d.key,code:d.code,keyCode:d.keyCode,which:d.keyCode,bubbles:true,cancelable:true});}` +
          `t.dispatchEvent(ev("keydown"));t.dispatchEvent(ev("keypress"));t.dispatchEvent(ev("keyup"));` +
          `return true;})()`,
      );
      if (!pressed) throw new BrowserError("EVAL_FAILED", "browser_press_key: dispatch failed");
      this.touch(rec, agentId);
      return { ok: true };
    });
  }

  /** Scroll the page, a scrollable container, or an element into view. */
  async scroll(
    sessionId: string | undefined,
    agentId: string,
    opts: ScrollOptions = {},
  ): Promise<{ ok: boolean }> {
    const rec = this.requireSession(sessionId, agentId);
    return this.runSerialized(rec, async () => {
      let selector: string | null = null;
      if (opts.ref) {
        selector = (await rec.snapshotter.validate(opts.ref)).selector;
      }
      const amount =
        Number.isFinite(opts.amount) && (opts.amount as number) > 0 ? (opts.amount as number) : 500;
      const dx = Number.isFinite(opts.deltaX) ? (opts.deltaX as number) : 0;
      const dy = Number.isFinite(opts.deltaY) ? (opts.deltaY as number) : 0;
      const dir = opts.direction;
      const scrolled = await rec.driver.evaluate<boolean>(
        `(function(){var sel=${JSON.stringify(selector)};` +
          `var el=sel?document.querySelector(sel):null;` +
          (opts.scrollIntoView ? `if(el){el.scrollIntoView({block:"center"});return true;}` : "") +
          `var dx=${JSON.stringify(dx)},dy=${JSON.stringify(dy)};` +
          `var dir=${JSON.stringify(dir)},amount=${JSON.stringify(amount)};` +
          `if(dir==="up")dy=-amount;else if(dir==="down")dy=amount;` +
          `else if(dir==="left")dx=-amount;else if(dir==="right")dx=amount;` +
          `if(el){el.scrollBy(dx,dy);return true;}` +
          `window.scrollBy(dx,dy);return true;})()`,
      );
      if (!scrolled) throw new BrowserError("EVAL_FAILED", "browser_scroll failed");
      this.touch(rec, agentId);
      return { ok: true };
    });
  }

  /** Drag from a source ref to a target ref or viewport coordinates. */
  async drag(
    sessionId: string | undefined,
    agentId: string,
    sourceRef: string,
    target: { targetRef?: string; targetX?: number; targetY?: number },
  ): Promise<{ ok: boolean }> {
    const rec = this.requireSession(sessionId, agentId);
    return this.runSerialized(rec, async () => {
      const { selector: srcSel } = await rec.snapshotter.validate(sourceRef);
      let tgtSel: string | null = null;
      if (target.targetRef) {
        tgtSel = (await rec.snapshotter.validate(target.targetRef)).selector;
      }
      const tx = target.targetX;
      const ty = target.targetY;
      if (!tgtSel && (typeof tx !== "number" || typeof ty !== "number")) {
        throw new BrowserError("INVALID_ARGS", "browser_drag: provide targetRef or targetX/targetY");
      }
      const dragged = await rec.driver.evaluate<boolean>(
        `(function(){var src=document.querySelector(${JSON.stringify(srcSel)});` +
          `if(!src)return false;` +
          `var sr=src.getBoundingClientRect();` +
          `var sx=sr.x+sr.width/2,sy=sr.y+sr.height/2;` +
          `var tSel=${JSON.stringify(tgtSel)};` +
          `var tx,ty,tgt=null;` +
          `if(tSel){tgt=document.querySelector(tSel);if(!tgt)return false;` +
          `var tr=tgt.getBoundingClientRect();tx=tr.x+tr.width/2;ty=tr.y+tr.height/2;}` +
          `else{tx=${JSON.stringify(tx)};ty=${JSON.stringify(ty)};}` +
          `function me(type,x,y){return new MouseEvent(type,{bubbles:true,cancelable:true,clientX:x,clientY:y,buttons:1});}` +
          `src.dispatchEvent(me("mousedown",sx,sy));` +
          `try{var dt=new DataTransfer();src.dispatchEvent(new DragEvent("dragstart",{bubbles:true,cancelable:true,clientX:sx,clientY:sy,dataTransfer:dt}));}catch(e){}` +
          `var steps=8;` +
          `for(var i=1;i<=steps;i++){var x=sx+(tx-sx)*i/steps,y=sy+(ty-sy)*i/steps;` +
          `document.dispatchEvent(me("mousemove",x,y));` +
          `var hop=document.elementFromPoint(x,y);` +
          `if(hop){try{hop.dispatchEvent(new DragEvent("dragover",{bubbles:true,cancelable:true,clientX:x,clientY:y}));}catch(e){}}}` +
          `if(tgt){try{tgt.dispatchEvent(new DragEvent("drop",{bubbles:true,cancelable:true,clientX:tx,clientY:ty}));}catch(e){}}` +
          `document.dispatchEvent(me("mouseup",tx,ty));` +
          `try{src.dispatchEvent(new DragEvent("dragend",{bubbles:true,cancelable:true}));}catch(e){}` +
          `return true;})()`,
      );
      if (!dragged) throw new BrowserError("EVAL_FAILED", "browser_drag failed");
      this.touch(rec, agentId);
      return { ok: true };
    });
  }

  /** Viewport bounding box for a snapshot ref. */
  async getBoundingBox(sessionId: string | undefined, agentId: string, ref: string): Promise<Rect> {
    const rec = this.requireSession(sessionId, agentId);
    return this.runSerialized(rec, async () => {
      const rect = await rec.snapshotter.getBoundingBox(ref);
      this.touch(rec, agentId);
      return rect;
    });
  }

  /**
   * Visually highlight an element by its snapshot ref with Cursor's orange
   * outline (#ff6a00). The outline is injected as a namespaced class and
   * removed in-page after durationMs (the removal is scheduled in the page,
   * so the service call returns immediately).
   */
  async highlight(
    sessionId: string | undefined,
    agentId: string,
    ref: string,
    durationMs?: number,
  ): Promise<{ ok: boolean; ref: string; durationMs: number }> {
    const ms =
      typeof durationMs === "number" && Number.isFinite(durationMs) && durationMs >= 0
        ? Math.min(Math.floor(durationMs), 30000)
        : 2000;
    const rec = this.requireSession(sessionId, agentId);
    return this.runSerialized(rec, async () => {
      const { selector } = await rec.snapshotter.validate(ref);
      const highlighted = await rec.driver.evaluate<boolean>(
        `(function(){var el=document.querySelector(${JSON.stringify(selector)});` +
          `if(!el)return false;` +
          `var STYLE_ID="__ide-ref-highlight-style";` +
          `var style=document.getElementById(STYLE_ID);` +
          `if(!style){style=document.createElement("style");style.id=STYLE_ID;` +
          `style.textContent=".__ide-ref-highlight{outline:2px solid #ff6a00 !important;` +
          `box-shadow:0 0 0 2px rgba(255,106,0,.4) !important;}";` +
          `(document.head||document.documentElement).appendChild(style);}` +
          `el.classList.add("__ide-ref-highlight");` +
          `setTimeout(function(){el.classList.remove("__ide-ref-highlight");},${JSON.stringify(ms)});` +
          `return true;})()`,
      );
      if (!highlighted)
        throw new BrowserError("EVAL_FAILED", `browser_highlight: ref ${ref} matched nothing`);
      this.touch(rec, agentId);
      return { ok: true, ref, durationMs: ms };
    });
  }

  /**
   * Raw CDP passthrough. The tool layer enforces the admin gate;
   * the denylist is enforced here unconditionally.
   */
  async cdp(
    sessionId: string | undefined,
    agentId: string,
    method: string,
    params: Record<string, unknown> = {},
  ): Promise<unknown> {
    assertCdpMethodAllowed(method);
    const rec = this.requireSession(sessionId, agentId);
    return this.runSerialized(rec, async () => {
      const out = await rec.driver.rawCdp(method, params);
      this.touch(rec, agentId);
      return out ?? {};
    });
  }

  /**
   * Evaluate a script in the page (host chrome use — e.g. page zoom via
   * `document.body.style.zoom`). Not agent-facing.
   */
  async evaluateInPage<T>(
    sessionId: string | undefined,
    agentId: string,
    script: string,
  ): Promise<T> {
    const rec = this.requireSession(sessionId, agentId);
    return this.runSerialized(rec, async () => {
      const out = await rec.driver.evaluate<T>(script);
      this.touch(rec, agentId);
      return out;
    });
  }

  /**
   * REVERIFY-P1-1: sanctioned internal CDP for the tab chrome's own
   * "Clear Browsing History / Cookies / Cache" menu (host chrome use —
   * the user's own input, NOT agent-facing).
   *
   * The agent-facing `cdp()` denylist stays intact: this method accepts
   * ONLY the exact 3 methods the menu needs (type-level union, no string
   * passthrough), so it cannot be used as a denylist bypass for arbitrary
   * CDP methods.
   */
  async clearBrowsingDataInternal(
    sessionId: string | undefined,
    agentId: string,
    method:
      | "Page.resetNavigationHistory"
      | "Network.clearBrowserCookies"
      | "Network.clearBrowserCache",
  ): Promise<void> {
    // REVERIFY2-P3-1: defense-in-depth RUNTIME allowlist. TS type unions are
    // compile-time only — a cast `as any` would bypass them (demonstrated by
    // the X1 probe), so enforce the exact 3 literals at runtime too.
    // Fail-closed: anything else throws before touching the driver.
    if (
      method !== "Page.resetNavigationHistory" &&
      method !== "Network.clearBrowserCookies" &&
      method !== "Network.clearBrowserCache"
    ) {
      throw new Error(
        `clearBrowsingDataInternal: refusing CDP method outside the allowlist: ${JSON.stringify(method)}`,
      );
    }
    const rec = this.requireSession(sessionId, agentId);
    await this.runSerialized(rec, async () => {
      await rec.driver.rawCdp(method, {});
      this.touch(rec, agentId);
    });
  }

  /**
   * Debug-connection info for the session's target (for the DevTools
   * frontend). Throws when the driver has no debug port.
   */
  async getDebugInfo(
    sessionId: string | undefined,
    agentId: string,
  ): Promise<DriverDebugInfo> {
    const rec = this.requireSession(sessionId, agentId, { checkLock: false });
    const info = rec.driver.debugInfo?.();
    if (!info) throw new BrowserError("NO_DEBUG_PORT", "driver has no remote-debugging port");
    return info;
  }

  /** Click at viewport coordinates (prefer browser_click with refs when possible). */
  async mouseClickXy(
    sessionId: string | undefined,
    agentId: string,
    x: number,
    y: number,
    opts: { button?: "left" | "right" | "middle" } = {},
  ): Promise<{ ok: boolean }> {
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      throw new BrowserError("INVALID_ARGS", "browser_mouse_click_xy: x/y must be finite numbers");
    }
    const rec = this.requireSession(sessionId, agentId);
    return this.runSerialized(rec, async () => {
      const button = opts.button === "right" ? "right" : opts.button === "middle" ? "middle" : "left";
      // Sanctioned internal use of CDP Input (the browser_cdp tool still bans it).
      await rec.driver.rawCdp("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button, clickCount: 1 });
      await rec.driver.rawCdp("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button, clickCount: 1 });
      this.touch(rec, agentId);
      return { ok: true };
    });
  }

  /** Tab management: list / new / close / select (Cursor's browser_tabs). */
  async tabs(
    agentId: string,
    action: "list" | "new" | "close" | "select",
    opts: { index?: number; url?: string } = {},
  ): Promise<Record<string, unknown>> {
    const ownTabs = () =>
      [...this.sessions.values()].filter(
        (r) => r.session.agentId === agentId && r.session.status === "active",
      );
    if (action === "list") {
      const tabs = ownTabs().map((r) => ({
        viewId: r.session.sessionId,
        url: r.session.url,
        title: r.session.title,
        locked: r.session.locked,
      }));
      const viewIds = tabs.map((t) => t.viewId);
      const active = this.lastInteractedByAgent.get(agentId) ?? null;
      return {
        viewIds,
        activeViewId: active,
        lastInteractedViewId: active,
        headlessViewIds: viewIds,
        owners: Object.fromEntries(tabs.map((t) => [t.viewId, agentId])),
        tabs,
      };
    }
    if (action === "new") {
      const s = await this.createSession({ agentId, url: opts.url });
      return { ok: true, viewId: s.sessionId, url: s.url, title: s.title };
    }
    // close / select: target by index, else the agent's last-interacted tab.
    const tabs = ownTabs();
    let rec: SessionRecord | undefined;
    if (typeof opts.index === "number") {
      rec = tabs[opts.index];
    } else {
      const id = this.lastInteractedByAgent.get(agentId);
      rec = id ? this.sessions.get(id) : undefined;
      if (rec && (rec.session.agentId !== agentId || rec.session.status !== "active")) rec = undefined;
    }
    if (!rec) throw new BrowserError("SESSION_NOT_FOUND", `browser_tabs: no tab for ${action}`);
    if (action === "close") {
      const viewId = rec.session.sessionId;
      await this.closeSession(viewId, agentId);
      return { ok: true, viewId };
    }
    // select
    this.lastInteractedByAgent.set(agentId, rec.session.sessionId);
    rec.session.lastInteractedAt = Date.now();
    return { ok: true, viewId: rec.session.sessionId };
  }

  listSessions(agentId: string): BrowserSession[] {
    return [...this.sessions.values()]
      .filter((r) => r.session.agentId === agentId && r.session.status === "active")
      .map((r) => ({ ...r.session }));
  }

  async closeSession(sessionId: string | undefined, agentId: string): Promise<void> {
    const rec = this.requireSession(sessionId, agentId);
    rec.session.status = "closed";
    try {
      await rec.driver.close();
    } finally {
      this.sessions.delete(rec.session.sessionId);
      if (this.lastInteractedByAgent.get(agentId) === rec.session.sessionId) {
        this.lastInteractedByAgent.delete(agentId);
      }
    }
  }

  // ------------------------------------------------------------------
  // User-visible browser tab surface.
  //
  // These methods back the in-editor browser tab chrome (omnibar, page
  // input forwarding, screencast). They are host-UI functions, NOT agent
  // tools: they are never exposed through the MCP tool registry, and the
  // browser_cdp Input.*/navigation denylist does not apply to them (the
  // denylist guides the *agent*; the tab chrome is the user's own input,
  // like Cursor's cursor.browserView.goBack/goForward workbench commands).
  // ------------------------------------------------------------------

  /**
   * Start a CDP screencast for the tab. Frames stream outside the session
   * mutex (they are read-only). Resolves a stop function.
   */
  async startScreencast(
    sessionId: string | undefined,
    agentId: string,
    opts: import("./driver").ScreencastOptions,
    onFrame: (dataBase64: string) => void,
  ): Promise<() => Promise<void>> {
    const rec = this.requireSession(sessionId, agentId, { checkLock: false });
    const driver = rec.driver as unknown as import("./driver").PageDriver;
    if (typeof driver.startScreencast !== "function" || typeof driver.onCdpEvent !== "function") {
      throw new BrowserError("UNSUPPORTED", "this page driver does not support screencast");
    }
    return driver.startScreencast(opts, (data) => {
      this.touch(rec, agentId);
      onFrame(data);
    });
  }

  /**
   * Subscribe to a page CDP event (loading indicator, URL sync). Read-only;
   * bypasses the session mutex like the screencast.
   */
  onPageEvent(
    sessionId: string | undefined,
    agentId: string,
    method: string,
    handler: (params?: Record<string, unknown>) => void,
  ): () => void {
    const rec = this.requireSession(sessionId, agentId, { checkLock: false });
    const driver = rec.driver as unknown as import("./driver").PageDriver;
    if (typeof driver.onCdpEvent !== "function") {
      throw new BrowserError("UNSUPPORTED", "this page driver does not support CDP events");
    }
    return driver.onCdpEvent(method, handler);
  }

  /** Navigation state for the omnibar (mirrors Cursor's listTabs/getURL/getTitle). */
  async getNavState(
    sessionId: string | undefined,
    agentId: string,
  ): Promise<{
    url: string;
    title: string;
    canGoBack: boolean;
    canGoForward: boolean;
    viewportWidth: number;
    viewportHeight: number;
  }> {
    const rec = this.requireSession(sessionId, agentId, { checkLock: false });
    return this.runSerialized(rec, async () => {
      const [url, title, history] = await Promise.all([
        rec.driver.getUrl().catch(() => ""),
        rec.driver.getTitle().catch(() => ""),
        rec.driver
          .rawCdp<{ currentIndex: number; entries: unknown[] }>("Page.getNavigationHistory", {})
          .catch(() => null),
      ]);
      // Viewport CSS size for click-coordinate mapping.
      const metrics = await rec.driver
        .rawCdp<{ visualViewport: { clientWidth: number; clientHeight: number } }>(
          "Page.getLayoutMetrics",
          {},
        )
        .catch(() => null);
      const entries = history?.entries ?? [];
      const idx = history?.currentIndex ?? 0;
      this.touch(rec, agentId);
      return {
        url,
        title,
        canGoBack: idx > 0,
        canGoForward: idx < entries.length - 1,
        viewportWidth: Math.round(metrics?.visualViewport?.clientWidth ?? 1280),
        viewportHeight: Math.round(metrics?.visualViewport?.clientHeight ?? 800),
      };
    });
  }

  /** Back / forward via the tab's own history (host chrome, not the agent). */
  async goBack(sessionId: string | undefined, agentId: string): Promise<void> {
    const rec = this.requireSession(sessionId, agentId, { checkLock: false });
    await this.runSerialized(rec, () =>
      rec.driver
        .rawCdp("Page.getNavigationHistory", {})
        .then((h: unknown) => {
          const hist = h as { currentIndex: number; entries: { id: number }[] };
          const target = hist.entries[hist.currentIndex - 1];
          if (!target) throw new BrowserError("NAVIGATION_FAILED", "no back history");
          return rec.driver.rawCdp("Page.navigateToHistoryEntry", { entryId: target.id });
        })
        .then(() => {
          this.touch(rec, agentId);
        }),
    );
  }

  /** Forward via the tab's own history (host chrome, not the agent). */
  async goForward(sessionId: string | undefined, agentId: string): Promise<void> {
    const rec = this.requireSession(sessionId, agentId, { checkLock: false });
    await this.runSerialized(rec, () =>
      rec.driver
        .rawCdp("Page.getNavigationHistory", {})
        .then((h: unknown) => {
          const hist = h as { currentIndex: number; entries: { id: number }[] };
          const target = hist.entries[hist.currentIndex + 1];
          if (!target) throw new BrowserError("NAVIGATION_FAILED", "no forward history");
          return rec.driver.rawCdp("Page.navigateToHistoryEntry", { entryId: target.id });
        })
        .then(() => {
          this.touch(rec, agentId);
        }),
    );
  }

  /**
   * Forward a user click at page CSS px into the page. Uses synthetic DOM
   * events (the same technique as the agent's browser_click) — no CDP
   * Input.* involved.
   */
  async userClick(sessionId: string | undefined, agentId: string, x: number, y: number): Promise<void> {
    const rec = this.requireSession(sessionId, agentId, { checkLock: false });
    await this.runSerialized(rec, async () => {
      const hit = await rec.driver.evaluate<boolean>(
        `(function(x,y){var el=document.elementFromPoint(x,y);if(!el)return false;` +
          `var r=el.getBoundingClientRect(),cx=r.x+r.width/2,cy=r.y+r.height/2;` +
          `function me(t,d){return new MouseEvent(t,{bubbles:true,cancelable:true,clientX:cx,clientY:cy,button:0,buttons:d?1:0,view:window});}` +
          `el.dispatchEvent(me("mousedown",true));el.dispatchEvent(me("mouseup",false));el.dispatchEvent(me("click",false));` +
          `try{el.focus&&el.focus();}catch(e){}return true;})(${Math.round(x)},${Math.round(y)})`,
      );
      if (!hit) throw new BrowserError("EVAL_FAILED", "click missed — no element at point");
      this.touch(rec, agentId);
    });
  }

  /** Forward a wheel gesture as a real scroll (host chrome, not the agent). */
  async userScroll(
    sessionId: string | undefined,
    agentId: string,
    deltaX: number,
    deltaY: number,
  ): Promise<void> {
    const rec = this.requireSession(sessionId, agentId, { checkLock: false });
    await this.runSerialized(rec, async () => {
      await rec.driver.evaluate(
        `(function(dx,dy){window.scrollBy(dx,dy);})(${Math.round(deltaX)},${Math.round(deltaY)})`,
      );
      this.touch(rec, agentId);
    });
  }

  /**
   * Forward a key press into the page. Printable characters are inserted
   * into the focused editable (input/textarea/contenteditable) via
   * execCommand('insertText') so React-controlled inputs update; Enter /
   * Backspace edit the value directly; other keys dispatch trusted
   * KeyboardEvents to the focused element.
   */
  async userKey(sessionId: string | undefined, agentId: string, key: string): Promise<void> {
    const rec = this.requireSession(sessionId, agentId, { checkLock: false });
    await this.runSerialized(rec, async () => {
      const done = await rec.driver.evaluate<boolean>(
        `(function(k){var el=document.activeElement||document.body;` +
          `function ke(t){var e=new KeyboardEvent(t,{bubbles:true,cancelable:true,key:k,code:k});return el.dispatchEvent(e);}` +
          `function editable(){if(!el)return null;var tn=(el.tagName||"").toLowerCase();` +
          `if(tn==="input"||tn==="textarea")return el;if(el.isContentEditable)return el;return null;}` +
          `if(k==="Enter"){ke("keydown");ke("keypress");` +
          `var ed=editable();if(ed&&ed.tagName.toLowerCase()==="input"&&ed.form){try{ed.form.requestSubmit&&ed.form.requestSubmit();}catch(e){}}` +
          `ke("keyup");return true;}` +
          `if(k==="Backspace"){ke("keydown");var e2=editable();` +
          `if(e2){if(e2.isContentEditable){document.execCommand("delete");}` +
          `else{var s=e2.selectionStart??e2.value.length,en=e2.selectionEnd??e2.value.length;` +
          `if(s===en&&s>0){s--;}e2.setRangeText("",s,en,"end");e2.dispatchEvent(new Event("input",{bubbles:true}));}}` +
          `ke("keyup");return true;}` +
          `if(k.length===1){ke("keydown");ke("keypress");var e3=editable();` +
          `if(e3){if(e3.isContentEditable){document.execCommand("insertText",false,k);}` +
          `else{e3.setRangeText(k,e3.selectionStart??e3.value.length,e3.selectionEnd??e3.value.length,"end");` +
          `e3.dispatchEvent(new Event("input",{bubbles:true}));}}` +
          `ke("keyup");return true;}` +
          `ke("keydown");ke("keyup");return true;})(${JSON.stringify(key)})`,
      );
      if (!done) throw new BrowserError("EVAL_FAILED", "key forwarding failed");
      this.touch(rec, agentId);
    });
  }

  /**
   * Interactive element pick at page CSS px for the user-visible tab:
   * highlights the element (orange #ff6a00, visible in the screencast) and
   * returns its payload. The caller posts the payload to chat.
   */
  async userPickAt(
    sessionId: string | undefined,
    agentId: string,
    x: number,
    y: number,
  ): Promise<import("./types").ElementPayload | null> {
    const rec = this.requireSession(sessionId, agentId, { checkLock: false });
    return this.runSerialized(rec, async () => {
      const payload = await rec.picker.pickAt(Math.round(x), Math.round(y));
      // The payload is captured — clear the orange outline so it does not
      // linger on the user's real page (QA-BROWSERTAB-01 P2).
      await rec.picker.clearHover();
      this.touch(rec, agentId);
      return payload;
    });
  }
}

/** Default driver factory: fresh CDP page per session (headless Chromium). */
export function createCdpDriverFactory(host: string, port: number): DriverFactory {
  return async () => {
    const driver = await CdpPageDriver.attach(host, port);
    return driver as unknown as ServiceDriver;
  };
}

/**
 * Native driver factory: one Integrated Browser tab (WebContentsView) per
 * session via the proposed `vscode.window.openBrowserTab` API — the
 * Cursor-equivalent path. This is the factory the 16 browser MCP tools
 * (createBrowserMcpTools) run on. Throws when the native tab API is
 * unavailable; callers fall back to createCdpDriverFactory in that case.
 */
export function createNativeDriverFactory(initialUrl = "about:blank"): DriverFactory {
  return async () => {
    const driver = new NativeBrowserPageDriver();
    await driver.open(initialUrl);
    return driver as unknown as ServiceDriver;
  };
}
