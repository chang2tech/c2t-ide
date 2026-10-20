/**
 * DEV-GAPS-19 (2026-10-20): "+" add-context menu tests (DETAIL-CHAT §3,
 * feature-matrix `composer-add-context-menu`, P1 — node:test, zero deps).
 *
 * Cursor 3.25.9 (verified live CDP): `button.ui-icon-button[aria-label="Add
 * agents, context, tools"]` opens a menu whose items are VERBATIM:
 *   Modes — Plan / "Generate an implementation plan",
 *            Debug / "Pinpoint the root cause of an issue",
 *            Multitask / "Orchestrate multiple subagents in parallel",
 *            Ask / "Answer questions without making edits"
 *   Files, Model / Auto, MCP.
 * No "Agent" row — Agent is the implicit default mode.
 *
 * Behaviors: mode item → {type:'setMode', mode}; Files → @-mention picker
 * scoped to files; Model → {type:'openModelPicker'} (same as #modelBtn);
 * MCP → @-mention picker scoped to "mcp" (the MCP tools list surface).
 *
 * Strategy (same as composer-morph.test.ts): createComposer() returns the
 * full webview HTML; assert the static markup, then run the inline <script>
 * in node:vm against a minimal fake DOM and drive clicks/messages.
 *
 * Run after `tsc`:  node out/components/composer-add-context.test.js
 */
import { describe, it, before } from "node:test";
import * as assert from "node:assert";
import * as vm from "node:vm";

/* The ide-agent sources import the "vscode" module, which does not exist
   outside the extension host. Stub it at the require level before loading
   the composer — createComposer() only needs it as a type. */
const Module = require("module") as { _load: (...args: unknown[]) => unknown };
const origLoad = (Module._load as (...args: unknown[]) => unknown).bind(Module);
(Module as unknown as { _load: (...args: unknown[]) => unknown })._load = function (
  request: unknown,
  ...rest: unknown[]
) {
  if (request === "vscode") {
    return {};
  }
  return origLoad(request, ...rest);
};

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { createComposer } = require("./composer") as typeof import("./composer");
import type { ModeName } from "../model";

/* ------------------------------------------------------------------ */
/* Minimal fake DOM — morph-test harness + parsed .ac-item children.    */
/* ------------------------------------------------------------------ */

type Listener = (e?: any) => void;

class FakeElement {
  tag: string;
  id = "";
  attrs = new Map<string, string>();
  listeners = new Map<string, Listener[]>();
  children: FakeElement[] = [];
  style: any = {
    setProperty(_k: string, _v: string): void {
      /* noop */
    },
  };
  private _html = "";
  private classes = new Set<string>();
  classList = {
    add: (...cs: string[]): void => {
      cs.forEach((c) => this.classes.add(c));
    },
    remove: (...cs: string[]): void => {
      cs.forEach((c) => this.classes.delete(c));
    },
    toggle: (c: string, force?: boolean): boolean => {
      const on = force === undefined ? !this.classes.has(c) : !!force;
      if (on) {
        this.classes.add(c);
      } else {
        this.classes.delete(c);
      }
      return on;
    },
    contains: (c: string): boolean => this.classes.has(c),
  };
  private _innerHTML = "";
  get innerHTML(): string {
    return this._innerHTML;
  }
  set innerHTML(v: string) {
    this._innerHTML = v;
    // When the webview script renders the add-context menu, immediately
    // parse its rows — querySelectorAll('.ac-item') then returns elements
    // the script attaches its real click listeners to.
    if (this.id === "addContextMenu") {
      this.acItems = [];
      const re = /<button class="ac-item"([^>]*)>/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(v)) !== null) {
        const attrs = m[1];
        const b = new FakeElement("button");
        const mode = /data-ac-mode="([^"]*)"/.exec(attrs);
        const action = /data-ac-action="([^"]*)"/.exec(attrs);
        if (mode) {
          b.setAttribute("data-ac-mode", mode[1]);
        }
        if (action) {
          b.setAttribute("data-ac-action", action[1]);
        }
        this.acItems.push(b);
      }
    }
  }
  textContent = "";
  title = "";
  value = "";
  hidden = false;
  open = false;
  disabled = false;
  selectionStart: number | null = null;
  selectionEnd: number | null = null;
  /** Parsed from renderAddContextMenu's innerHTML — lets tests click rows. */
  acItems: FakeElement[] = [];

  constructor(tag: string) {
    this.tag = tag;
  }
  setAttribute(k: string, v: string): void {
    this.attrs.set(k, String(v));
  }
  getAttribute(k: string): string | null {
    const v = this.attrs.get(k);
    return v === undefined ? null : v;
  }
  removeAttribute(k: string): void {
    this.attrs.delete(k);
  }
  hasAttribute(k: string): boolean {
    return this.attrs.has(k);
  }
  addEventListener(t: string, fn: Listener): void {
    const arr = this.listeners.get(t) ?? [];
    arr.push(fn);
    this.listeners.set(t, arr);
  }
  removeEventListener(t: string, fn: Listener): void {
    const arr = this.listeners.get(t);
    if (arr) {
      this.listeners.set(
        t,
        arr.filter((f) => f !== fn),
      );
    }
  }
  appendChild(c: FakeElement): FakeElement {
    this.children.push(c);
    return c;
  }
  insertBefore(c: FakeElement, _ref: FakeElement | null): FakeElement {
    this.children.push(c);
    return c;
  }
  remove(): void {
    /* noop */
  }
  querySelector(_s: string): FakeElement | null {
    return null;
  }
  querySelectorAll(s: string): FakeElement[] {
    // The webview script only queries '.ac-item' on the add-context menu and
    // 'button' on the mention menus; returning the parsed children lets the
    // row click handlers (attached at render time) be driven by tests.
    if (this.id === "addContextMenu" && s === ".ac-item") {
      return [...this.acItems];
    }
    if (s === "button") {
      return this.children.filter((c) => c.tag === "button");
    }
    return [];
  }
  contains(_n: unknown): boolean {
    return false;
  }
  closest(_s: string): FakeElement | null {
    return null;
  }
  blurred = false;
  focus(): void {
    /* noop */
  }
  blur(): void {
    this.blurred = true;
  }
  click(): void {
    /* noop */
  }
  scrollIntoView(_o?: unknown): void {
    /* noop */
  }
  dispatchEvent(e: { type: string } & Record<string, unknown>): boolean {
    for (const fn of this.listeners.get(e.type) ?? []) {
      fn(e);
    }
    return true;
  }
}

interface Boot {
  el: (id: string) => FakeElement;
  posted: unknown[];
  fireInput: (value: string) => void;
  fireKeydown: (e: Record<string, unknown>) => Record<string, unknown>;
  clickAddContext: () => void;
  clickAcItem: (predicate: (b: FakeElement) => boolean) => FakeElement;
  /** Re-parse the rendered add-context rows (needed after the webview script
      re-renders the menu, e.g. on a host {type:'model'} message). */
  reparseAcItems: () => void;
  postToWebview: (msg: unknown) => void;
}

let INLINE_SCRIPT = "";

function extractInlineScript(html: string): string {
  const m = html.match(/<script nonce="[^"]*">([\s\S]*?)<\/script>/);
  assert.ok(m && m[1], "inline webview script not found in createComposer HTML");
  return m[1];
}

function boot(): Boot {
  const posted: unknown[] = [];
  const byId = new Map<string, FakeElement>();
  const doc: any = {
    activeElement: null,
    body: new FakeElement("body"),
    getElementById: (id: string): FakeElement => {
      let elx = byId.get(id);
      if (!elx) {
        elx = new FakeElement("div");
        elx.id = id;
        byId.set(id, elx);
      }
      return elx;
    },
    createElement: (tag: string): FakeElement => new FakeElement(tag),
    addEventListener: (_t: string, _fn: Listener): void => {
      /* noop */
    },
    querySelector: (_s: string): null => null,
    querySelectorAll: (_s: string): FakeElement[] => [],
  };
  const winListeners = new Map<string, Listener[]>();
  const sandbox: any = {
    document: doc,
    window: {
      addEventListener: (t: string, fn: Listener): void => {
        const arr = winListeners.get(t) ?? [];
        arr.push(fn);
        winListeners.set(t, arr);
      },
    },
    acquireVsCodeApi: () => ({
      postMessage: (msg: unknown): void => {
        posted.push(msg);
      },
    }),
    JSON,
    Math,
    Date,
    console,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
  };
  vm.createContext(sandbox);
  vm.runInContext(INLINE_SCRIPT, sandbox, { filename: "composer-webview.js" });
  // The static markup carries the `hidden` attribute on #addContextMenu; the
  // fake DOM does not parse HTML attributes, so mirror it here.
  doc.getElementById("addContextMenu").hidden = true;
  const el = (id: string): FakeElement => {
    const e = byId.get(id);
    assert.ok(e, `element #${id} was never requested by the webview script`);
    return e as FakeElement;
  };
  const fireListeners = (target: FakeElement, type: string, evt: Record<string, unknown>): void => {
    for (const fn of target.listeners.get(type) ?? []) {
      fn(evt);
    }
  };
  return {
    el,
    posted,
    fireInput: (value: string): void => {
      const input = el("input");
      input.value = value;
      fireListeners(input, "input", { target: input });
    },
    fireKeydown: (e: Record<string, unknown>): Record<string, unknown> => {
      const input = el("input");
      const evt: Record<string, unknown> = {
        preventDefault: (): void => {
          evt.defaultPrevented = true;
        },
        stopPropagation: (): void => {
          /* noop */
        },
        defaultPrevented: false,
        ...e,
      };
      fireListeners(input, "keydown", evt);
      return evt;
    },
    clickAddContext: (): void => {
      const btn = el("addContextBtn");
      fireListeners(btn, "click", {
        stopPropagation: (): void => {
          /* noop */
        },
        target: btn,
      });
    },
    clickAcItem: (predicate: (b: FakeElement) => boolean): FakeElement => {
      // Re-render after boot so querySelectorAll('.ac-item') in the script
      // sees the parsed rows — mirrors what happens in the real DOM.
      const menu = el("addContextMenu");
      menu.hidden = false;
      const items = menu.querySelectorAll(".ac-item");
      const hit = items.find(predicate);
      assert.ok(hit, "add-context menu row not found");
      fireListeners(hit as FakeElement, "click", { target: hit });
      return hit as FakeElement;
    },
    reparseAcItems: (): void => {
      /* noop — the innerHTML setter re-parses on every script render */
    },
    postToWebview: (msg: unknown): void => {
      for (const fn of winListeners.get("message") ?? []) {
        fn({ data: msg });
      }
    },
  };
}

let HTML = "";

before(() => {
  HTML = createComposer(
    {} as never,
    "agent" as ModeName,
    false,
    "en",
    "ltr",
    "Auto",
  );
  INLINE_SCRIPT = extractInlineScript(HTML);
});

/** Assert the last posted webview→host message (property-wise: messages are
    created inside the node:vm sandbox, so deepStrictEqual's prototype check
    would fail on structurally identical objects). */
function lastMsg(b: Boot): { type: string; mode?: string; query?: string } {
  return b.posted[b.posted.length - 1] as { type: string; mode?: string; query?: string };
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/* ------------------------------------------------------------------ */

describe("add-context (+) button — static markup (DETAIL-CHAT §3)", () => {
  it("renders the + button with the verbatim aria-label and ui-icon-button class", () => {
    assert.match(
      HTML,
      /<button id="addContextBtn"[^>]*class="ui-icon-button add-context-btn"[^>]*aria-label="Add agents, context, tools"/,
      "button must carry class ui-icon-button + aria-label 'Add agents, context, tools'",
    );
    assert.match(
      HTML,
      /<button id="addContextBtn"[^>]*title="Add agents, context, tools"/,
      "button title is the same verbatim string",
    );
  });

  it("uses an inline SVG plus icon — no emoji, no text glyph", () => {
    const m = HTML.match(/<button id="addContextBtn"[^>]*>([\s\S]*?)<\/button>/);
    assert.ok(m, "add-context button markup found");
    assert.match(m[1], /<svg/, "button contains an inline SVG icon");
    assert.doesNotMatch(m[1], /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u, "no emoji in the icon");
  });

  it("renders the menu container before the model picker in the toolbar", () => {
    assert.match(
      HTML,
      /<div class="menu" id="addContextMenu" hidden><\/div>/,
      "the add-context menu container exists, hidden by default",
    );
    const btnIdx = HTML.indexOf('id="addContextBtn"');
    const modelIdx = HTML.indexOf('id="modelBtn"');
    assert.ok(btnIdx > -1 && modelIdx > -1 && btnIdx < modelIdx, "+ button sits before the model picker in the toolbar");
  });
});

describe("add-context menu — live webview script", () => {
  it("clicking + opens the menu with Cursor's verbatim items and NO Agent row", () => {
    const b = boot();
    assert.strictEqual(b.el("addContextMenu").hidden, true, "menu starts hidden");
    b.clickAddContext();
    assert.strictEqual(b.el("addContextMenu").hidden, false, "+ opens the menu");
    const inner = b.el("addContextMenu").innerHTML;
    assert.match(inner, /<div class="menu-section">Modes<\/div>/, "Modes section header");
    // Mode labels + descriptions VERBATIM from the live CDP evidence.
    for (const s of [
      "Plan",
      "Generate an implementation plan",
      "Debug",
      "Pinpoint the root cause of an issue",
      "Multitask",
      "Orchestrate multiple subagents in parallel",
      "Ask",
      "Answer questions without making edits",
      "Files",
      "Model",
      "Auto",
      "MCP",
    ]) {
      assert.ok(inner.includes(s), `menu shows verbatim item ${JSON.stringify(s)}`);
    }
    assert.doesNotMatch(inner, /data-ac-mode="agent"/, "no Agent row — Agent is the implicit default");
    assert.doesNotMatch(inner, />Agent</, "no Agent label in the menu");
  });

  it("clicking + twice toggles the menu closed", () => {
    const b = boot();
    b.clickAddContext();
    assert.strictEqual(b.el("addContextMenu").hidden, false);
    b.clickAddContext();
    assert.strictEqual(b.el("addContextMenu").hidden, true, "second click closes the menu");
  });

  it("Plan row posts setMode=plan", () => {
    const b = boot();
    b.clickAddContext();
    b.clickAcItem((x) => x.getAttribute("data-ac-mode") === "plan");
    assert.strictEqual(lastMsg(b).type, "setMode");
    assert.strictEqual(lastMsg(b).mode, "plan");
    assert.strictEqual(b.el("addContextMenu").hidden, true, "menu closes after picking a mode");
  });

  it("Debug row posts setMode=debug", () => {
    const b = boot();
    b.clickAddContext();
    b.clickAcItem((x) => x.getAttribute("data-ac-mode") === "debug");
    assert.strictEqual(lastMsg(b).type, "setMode");
    assert.strictEqual(lastMsg(b).mode, "debug");
  });

  it("Multitask row posts setMode=multitask", () => {
    const b = boot();
    b.clickAddContext();
    b.clickAcItem((x) => x.getAttribute("data-ac-mode") === "multitask");
    assert.strictEqual(lastMsg(b).type, "setMode");
    assert.strictEqual(lastMsg(b).mode, "multitask");
  });

  it("Ask row posts setMode=chat (Ask = wire id 'chat')", () => {
    const b = boot();
    b.clickAddContext();
    b.clickAcItem((x) => x.getAttribute("data-ac-mode") === "chat");
    assert.strictEqual(lastMsg(b).type, "setMode");
    assert.strictEqual(lastMsg(b).mode, "chat");
  });

  it("Model row posts openModelPicker — the same message as the model button", () => {
    const b = boot();
    b.clickAddContext();
    b.clickAcItem((x) => x.getAttribute("data-ac-action") === "model");
    assert.strictEqual(lastMsg(b).type, "openModelPicker");
    assert.strictEqual(b.el("addContextMenu").hidden, true, "menu closes after the Model row");
  });

  it("host {type:'model'} updates the Model row's current-model label", () => {
    const b = boot();
    b.clickAddContext();
    b.postToWebview({ type: "model", label: "gpt-5" });
    // The re-render reparsed rows — keep the test rows in sync.
    b.reparseAcItems();
    assert.ok(
      b.el("addContextMenu").innerHTML.includes("gpt-5"),
      "Model row shows the host-announced model",
    );
  });

  it("Files row opens the @-mention picker scoped to files", async () => {
    const b = boot();
    b.clickAddContext();
    b.clickAcItem((x) => x.getAttribute("data-ac-action") === "files");
    assert.strictEqual(b.el("addContextMenu").hidden, true, "menu closes when Files is picked");
    assert.ok(b.el("input").value.includes("@files "), "the input gets the @files scope token");
    assert.strictEqual(b.el("mentionMenu").style.display, "block", "the mention palette opens");
    await sleep(200);
    const q = b.posted.find((m) => (m as { type: string }).type === "mentionQuery") as
      | { type: string; query: string }
      | undefined;
    assert.ok(q, "a mentionQuery is posted to the host");
    assert.strictEqual(q.query.trim(), "files", "the query is the 'files' mention scope (file+folder kinds)");
  });

  it("MCP row opens the @-mention picker scoped to mcp (the MCP tools list)", async () => {
    const b = boot();
    b.clickAddContext();
    b.clickAcItem((x) => x.getAttribute("data-ac-action") === "mcp");
    assert.strictEqual(b.el("addContextMenu").hidden, true, "menu closes when MCP is picked");
    assert.ok(b.el("input").value.includes("@mcp "), "the input gets the @mcp scope token");
    await sleep(200);
    const q = b.posted.find((m) => (m as { type: string }).type === "mentionQuery") as
      | { type: string; query: string }
      | undefined;
    assert.ok(q, "a mentionQuery is posted to the host");
    assert.strictEqual(q.query.trim(), "mcp", "the query is the 'mcp' mention scope (MCP tools)");
  });

  it("Esc dismisses the open add-context menu", () => {
    const b = boot();
    b.clickAddContext();
    assert.strictEqual(b.el("addContextMenu").hidden, false);
    b.fireKeydown({ key: "Escape" });
    assert.strictEqual(b.el("addContextMenu").hidden, true, "Esc (via closeMenus) hides the menu");
  });
});
