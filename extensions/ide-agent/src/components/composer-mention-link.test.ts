/**
 * Mention Link Toolbar webview tests (GAPS-131 — node:test).
 *
 * Cursor parity (CONFIRMED, work-notes-gaps131): pasting a lone URL
 * creates a link mention (desk @24723930); clicking a link mention
 * executes cursor.mentionLinkToolbar with {x: rect.left,
 * y: rect.bottom + 2, link} (desk @24666605); the host posts
 * {type:'showMentionLinkToolbar'} back and the webview renders the
 * backdrop + toolbar whose items are verbatim "Open" / "Unlink"
 * (template desk @40171210); Open posts the open request, Unlink runs
 * the onRemove semantics locally (insert the URL text at the caret,
 * remove the chip, refocus) and every close path posts
 * {type:'mentionLinkToolbarClose'} so the host resolves its promise.
 *
 * Strategy (same as composer-jump.test.ts): run createComposer()'s
 * inline <script> in node:vm against a minimal fake DOM.
 *
 * Run after `tsc`:  node out/components/composer-mention-link.test.js
 */
import { describe, it, before } from "node:test";
import * as assert from "node:assert";
import * as vm from "node:vm";

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

type Listener = (e?: any) => void;

class FakeText {
  parentNode: FakeElement | null = null;
  constructor(public nodeValue: string) {}
  get tagName(): string {
    return "#text";
  }
  get firstChild(): null {
    return null;
  }
}

type Child = FakeElement | FakeText;

class FakeElement {
  tag: string;
  attrs = new Map<string, string>();
  listeners = new Map<string, Listener[]>();
  children: Child[] = [];
  parentNode: FakeElement | null = null;
  style: any = { setProperty(_k: string, _v: string): void { /* noop */ } };
  private classes = new Set<string>();
  classList = {
    add: (...cs: string[]): void => { cs.forEach((c) => this.classes.add(c)); },
    remove: (...cs: string[]): void => { cs.forEach((c) => this.classes.delete(c)); },
    toggle: (c: string, force?: boolean): boolean => {
      const on = force === undefined ? !this.classes.has(c) : !!force;
      if (on) { this.classes.add(c); } else { this.classes.delete(c); }
      return on;
    },
    contains: (c: string): boolean => this.classes.has(c),
  };
  private _innerHTML = "";
  /** Real-DOM semantics: assigning innerHTML replaces the children
   *  (the fake parser produces no nodes from the string). renderChips
   *  relies on innerHTML='' clearing the old chip elements. */
  get innerHTML(): string {
    return this._innerHTML;
  }
  set innerHTML(v: string) {
    this._innerHTML = v;
    for (const c of this.children) {
      c.parentNode = null;
    }
    this.children = [];
  }
  title = "";
  value = "";
  hidden = false;
  disabled = false;
  /** Real HTMLTextAreaElement signal read by the GAPS-143 NF-2 guard. */
  readOnly = false;
  selectionStart: number | null = null;
  selectionEnd: number | null = null;
  selected = false;
  scrollTop = 0;
  scrollHeight = 0;
  clientHeight = 0;
  rectTop = 0;
  rectLeft = 0;
  rectBottom = 0;
  focused = false;

  constructor(tag: string) {
    this.tag = tag;
  }
  get tagName(): string {
    return this.tag.toUpperCase();
  }
  get className(): string {
    return [...this.classes].join(" ");
  }
  set className(v: string) {
    this.classes = new Set(v.split(/\s+/).filter(Boolean));
  }
  get firstChild(): Child | null {
    return this.children[0] ?? null;
  }
  get textContent(): string {
    return this.children
      .map((c) => (c instanceof FakeText ? c.nodeValue : c.textContent))
      .join("");
  }
  set textContent(v: string) {
    this.children = [];
    if (v) {
      this.appendChild(new FakeText(v));
    }
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
  addEventListener(t: string, fn: Listener): void {
    const arr = this.listeners.get(t) ?? [];
    arr.push(fn);
    this.listeners.set(t, arr);
  }
  removeEventListener(t: string, fn: Listener): void {
    const arr = this.listeners.get(t);
    if (arr) {
      this.listeners.set(t, arr.filter((f) => f !== fn));
    }
  }
  appendChild(c: Child): Child {
    if (c.parentNode) {
      c.parentNode.removeChild(c);
    }
    this.children.push(c);
    c.parentNode = this;
    return c;
  }
  insertBefore(c: Child, ref: Child | null): Child {
    if (c.parentNode) {
      c.parentNode.removeChild(c);
    }
    const idx = ref ? this.children.indexOf(ref) : -1;
    if (idx === -1) {
      this.children.push(c);
    } else {
      this.children.splice(idx, 0, c);
    }
    c.parentNode = this;
    return c;
  }
  removeChild(c: Child): Child {
    const idx = this.children.indexOf(c);
    if (idx !== -1) {
      this.children.splice(idx, 1);
      c.parentNode = null;
    }
    return c;
  }
  remove(): void {
    if (this.parentNode) {
      this.parentNode.removeChild(this);
    }
  }
  querySelector(_s: string): FakeElement | null {
    return null;
  }
  querySelectorAll(_s: string): FakeElement[] {
    return [];
  }
  contains(_n: unknown): boolean {
    return false;
  }
  closest(_s: string): FakeElement | null {
    return null;
  }
  focus(): void {
    this.focused = true;
  }
  blur(): void {
    this.focused = false;
  }
  click(): void { /* noop */ }
  select(): void {
    this.selected = true;
  }
  scrollIntoView(_o?: unknown): void { /* noop */ }
  getBoundingClientRect(): { top: number; left: number; bottom: number } {
    return { top: this.rectTop, left: this.rectLeft, bottom: this.rectBottom };
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
  posted: Array<Record<string, unknown>>;
  post: (msg: unknown) => void;
  pasteIntoInput: (text: string) => { prevented: boolean };
  chipCount: () => number;
  clickChipLabel: () => void;
}

let INLINE_SCRIPT = "";
let STATIC_HTML = "";

function extractInlineScript(html: string): string {
  const m = html.match(/<script nonce="[^"]*">([\s\S]*?)<\/script>/);
  assert.ok(m && m[1], "inline webview script not found in createComposer HTML");
  return m[1];
}

function boot(): Boot {
  const posted: Array<Record<string, unknown>> = [];
  const byId = new Map<string, FakeElement>();
  const doc: any = {
    activeElement: null,
    body: new FakeElement("body"),
    getElementById: (id: string): FakeElement => {
      let elx = byId.get(id);
      if (!elx) {
        elx = new FakeElement("div");
        byId.set(id, elx);
      }
      return elx;
    },
    createElement: (tag: string): FakeElement => new FakeElement(tag),
    createTextNode: (text: string): FakeText => new FakeText(text),
    createTreeWalker: (): { nextNode: () => null } => ({ nextNode: () => null }),
    addEventListener: (_t: string, _fn: Listener): void => { /* noop */ },
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
        posted.push(msg as Record<string, unknown>);
      },
    }),
    NodeFilter: { SHOW_TEXT: 4, FILTER_ACCEPT: 1, FILTER_REJECT: 2, FILTER_SKIP: 3 },
    URL,
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
  const el = (id: string): FakeElement => {
    const e = byId.get(id);
    assert.ok(e, `element #${id} was never requested by the webview script`);
    return e as FakeElement;
  };
  return {
    el,
    posted,
    post: (msg: unknown): void => {
      for (const fn of winListeners.get("message") ?? []) {
        fn({ data: msg });
      }
    },
    pasteIntoInput: (text: string) => {
      let prevented = false;
      el("input").dispatchEvent({
        type: "paste",
        clipboardData: { getData: (_t: string): string => text },
        preventDefault: (): void => {
          prevented = true;
        },
      });
      return { prevented };
    },
    chipCount: () => el("chips").children.filter((c) => c instanceof FakeElement).length,
    clickChipLabel: () => {
      const chip = el("chips").children.find((c) => c instanceof FakeElement) as FakeElement;
      assert.ok(chip, "no chip rendered");
      const lab = chip.children.find(
        (c) => c instanceof FakeElement && c.classList.contains("chip-label"),
      ) as FakeElement;
      assert.ok(lab, "chip has no label element");
      lab.rectLeft = 15;
      lab.rectBottom = 40;
      lab.dispatchEvent({ type: "click", currentTarget: lab });
    },
  };
}

before(() => {
  STATIC_HTML = createComposer({} as never, "agent" as ModeName, false, "en", "ltr", "auto");
  INLINE_SCRIPT = extractInlineScript(STATIC_HTML);
});

describe("mention link toolbar — static markup", () => {
  it("renders the backdrop + toolbar with the verbatim Open/Unlink items", () => {
    assert.ok(STATIC_HTML.includes('id="mentionLinkToolbar"'));
    assert.ok(STATIC_HTML.includes('id="mentionLinkBackdrop"'));
    assert.ok(STATIC_HTML.includes("mention-link-toolbar-item"));
    assert.ok(STATIC_HTML.includes('aria-label="Mention Link Toolbar"'));
    assert.ok(STATIC_HTML.includes(">Open</div>") || STATIC_HTML.includes("Open</div>"));
    assert.ok(STATIC_HTML.includes("Unlink</div>"));
    assert.ok(STATIC_HTML.includes(".mention-link-toolbar-item"));
  });
});

describe("mention link toolbar — paste auto-parse (desk @24723930)", () => {
  const URL_TEXT = "https://example.com/docs";

  it("a lone pasted URL becomes a link chip and is not inserted as text", () => {
    const b = boot();
    const res = b.pasteIntoInput(URL_TEXT);
    assert.equal(res.prevented, true);
    assert.equal(b.chipCount(), 1);
    assert.equal(b.el("input").value, "");
  });

  it("pasting the same URL twice does not duplicate the chip", () => {
    const b = boot();
    b.pasteIntoInput(URL_TEXT);
    b.pasteIntoInput(URL_TEXT);
    assert.equal(b.chipCount(), 1);
  });

  it("plain text and slash pastes do not become link chips", () => {
    const b = boot();
    const res = b.pasteIntoInput("hello world, no link here");
    assert.equal(res.prevented, false);
    assert.equal(b.chipCount(), 0);
  });

  it("no auto-parse while the mention menu is open (binary: !isMentionsMenuOpen)", () => {
    const b = boot();
    b.el("mentionMenu").style.display = "block";
    const res = b.pasteIntoInput(URL_TEXT);
    assert.equal(res.prevented, false);
    assert.equal(b.chipCount(), 0);
  });
});

describe("mention link toolbar — activation guard (GAPS-143 NF-2, D5)", () => {
  const URL_TEXT = "https://example.com/docs";

  it("chip click does NOT post the request when the input is readOnly (binary readonly leg)", () => {
    const b = boot();
    b.pasteIntoInput(URL_TEXT);
    assert.equal(b.chipCount(), 1);
    b.el("input").readOnly = true;
    b.clickChipLabel();
    assert.equal(b.posted.some((m) => m.type === "mentionLinkToolbar"), false);
  });

  it("chip click does NOT post the request when the input is disabled", () => {
    const b = boot();
    b.pasteIntoInput(URL_TEXT);
    assert.equal(b.chipCount(), 1);
    b.el("input").disabled = true;
    b.clickChipLabel();
    assert.equal(b.posted.some((m) => m.type === "mentionLinkToolbar"), false);
  });

  it("chip click still posts the request when the input is editable (guard is not a blanket block)", () => {
    const b = boot();
    b.pasteIntoInput(URL_TEXT);
    b.el("input").readOnly = false;
    b.el("input").disabled = false;
    b.clickChipLabel();
    assert.ok(b.posted.some((m) => m.type === "mentionLinkToolbar"));
  });
});

describe("mention link toolbar — show / open / unlink / close", () => {
  const URL_TEXT = "https://example.com/docs";

  function bootWithChip(): { b: Boot; uuid: string } {
    const b = boot();
    b.pasteIntoInput(URL_TEXT);
    b.clickChipLabel();
    const req = b.posted.find((m) => m.type === "mentionLinkToolbar");
    assert.ok(req, "chip click did not post a mentionLinkToolbar request");
    return { b, uuid: String(req.uuid) };
  }

  it("chip click posts the request with x=rect.left, y=rect.bottom+2 (desk @24666605)", () => {
    const b = boot();
    b.pasteIntoInput(URL_TEXT);
    b.clickChipLabel();
    const req = b.posted.find((m) => m.type === "mentionLinkToolbar");
    assert.ok(req);
    assert.equal(req.x, 15);
    assert.equal(req.y, 42);
    assert.equal(req.link, URL_TEXT);
    assert.equal(typeof req.uuid, "string");
  });

  it("show message renders the toolbar at (x, y) with the backdrop", () => {
    const { b, uuid } = bootWithChip();
    b.post({ type: "showMentionLinkToolbar", x: 15, y: 42, link: URL_TEXT, uuid });
    assert.equal(b.el("mentionLinkToolbar").hidden, false);
    assert.equal(b.el("mentionLinkBackdrop").hidden, false);
    assert.equal(b.el("mentionLinkToolbar").style.left, "15px");
    assert.equal(b.el("mentionLinkToolbar").style.top, "42px");
  });

  it("backdrop click hides the toolbar and posts the close", () => {
    const { b, uuid } = bootWithChip();
    b.post({ type: "showMentionLinkToolbar", x: 15, y: 42, link: URL_TEXT, uuid });
    b.el("mentionLinkBackdrop").dispatchEvent({ type: "click" });
    assert.equal(b.el("mentionLinkToolbar").hidden, true);
    assert.ok(b.posted.some((m) => m.type === "mentionLinkToolbarClose"));
  });

  it("Open posts mentionLinkToolbarOpen with the link and hides locally", () => {
    const { b, uuid } = bootWithChip();
    b.post({ type: "showMentionLinkToolbar", x: 15, y: 42, link: URL_TEXT, uuid });
    b.el("mentionLinkOpen").dispatchEvent({ type: "click" });
    const open = b.posted.find((m) => m.type === "mentionLinkToolbarOpen");
    assert.ok(open);
    assert.equal(open.link, URL_TEXT);
    assert.equal(b.el("mentionLinkToolbar").hidden, true);
    // No close echo: the host closes the controller in its Open case.
    assert.equal(b.posted.some((m) => m.type === "mentionLinkToolbarClose"), false);
  });

  it("Unlink inserts the URL text at the caret, removes the chip, posts close", () => {
    const { b, uuid } = bootWithChip();
    const input = b.el("input");
    input.value = "see ";
    input.selectionStart = input.selectionEnd = 4;
    b.post({ type: "showMentionLinkToolbar", x: 15, y: 42, link: URL_TEXT, uuid });
    b.el("mentionLinkUnlink").dispatchEvent({ type: "click" });
    assert.equal(input.value, "see " + URL_TEXT);
    assert.equal(b.chipCount(), 0);
    assert.equal(b.el("mentionLinkToolbar").hidden, true);
    assert.ok(b.posted.some((m) => m.type === "mentionLinkToolbarClose"));
  });

  it("host hide message hides without a close echo", () => {
    const { b, uuid } = bootWithChip();
    b.post({ type: "showMentionLinkToolbar", x: 15, y: 42, link: URL_TEXT, uuid });
    b.post({ type: "hideMentionLinkToolbar" });
    assert.equal(b.el("mentionLinkToolbar").hidden, true);
    assert.equal(b.posted.some((m) => m.type === "mentionLinkToolbarClose"), false);
  });
});
