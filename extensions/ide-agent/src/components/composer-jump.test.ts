/**
 * Chat jump-between-messages webview tests (DEV-GAPS-119 — node:test).
 *
 * Cursor parity (CONFIRMED, work-notes-gaps119): the glass commands
 * jumpToNextUserMessage / jumpToPrevUserMessage /
 * scrollAgentPanelToTop / scrollAgentPanelToBottom emit
 * jumpToNextUserMessageRequested / jumpToPrevUserMessageRequested /
 * agentPanelScrollToEdgeRequested; the webview scrolls #messages to the
 * next/previous HUMAN bubble using the binary algorithm
 * (composerReactTranscriptCommands.js: next = first human row with
 * absoluteTop > scrollTop + 2; prev = last with absoluteTop <
 * scrollTop - 2; no wrap-around). The webview also reports prompt
 * emptiness ({type:'inputEmpty'}) for the core when-clause.
 *
 * Strategy (same as composer-find.test.ts): run createComposer()'s
 * inline <script> in node:vm against a minimal fake DOM, seed #messages
 * with fake .msg rows at known content positions, post the host
 * messages, and assert #messages.scrollTop.
 *
 * Run after `tsc`:  node out/components/composer-jump.test.js
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
  innerHTML = "";
  title = "";
  value = "";
  hidden = false;
  open = false;
  disabled = false;
  selectionStart: number | null = null;
  selectionEnd: number | null = null;
  selected = false;
  scrollTop = 0;
  scrollHeight = 0;
  clientHeight = 0;
  rectTop = 0;
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
  querySelectorAll(s: string): FakeElement[] {
    if (s !== ".msg.human") {
      return [];
    }
    const out: FakeElement[] = [];
    const walk = (n: FakeElement): void => {
      for (const c of n.children) {
        if (c instanceof FakeElement) {
          if (c.classList.contains("msg") && c.classList.contains("human")) {
            out.push(c);
          }
          walk(c);
        }
      }
    };
    walk(this);
    return out;
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
  getBoundingClientRect(): { top: number } {
    return { top: this.rectTop };
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
  post: (msg: unknown) => void;
  /** Place the transcript: human rows at the given content tops,
   *  interleaved with assistant rows between them. */
  seedTranscript: (humanTops: number[], scrollTop: number) => void;
  scrollTop: () => number;
}

let INLINE_SCRIPT = "";

function extractInlineScript(html: string): string {
  const m = html.match(/<script nonce="[^"]*">([\s\S]*?)<\/script>/);
  assert.ok(m && m[1], "inline webview script not found in createComposer HTML");
  return m[1];
}

const VIEWPORT_TOP = 100;

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
        posted.push(msg);
      },
    }),
    NodeFilter: { SHOW_TEXT: 4, FILTER_ACCEPT: 1, FILTER_REJECT: 2, FILTER_SKIP: 3 },
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
  const postToWebview = (msg: unknown): void => {
    for (const fn of winListeners.get("message") ?? []) {
      fn({ data: msg });
    }
  };
  return {
    el,
    posted,
    post: postToWebview,
    seedTranscript: (humanTops: number[], scrollTop: number) => {
      const messages = el("messages");
      messages.children = [];
      messages.rectTop = VIEWPORT_TOP;
      messages.scrollHeight = 2600;
      messages.clientHeight = 600;
      messages.scrollTop = scrollTop;
      humanTops.forEach((top, i) => {
        if (i > 0) {
          const a = new FakeElement("div");
          a.className = "msg assistant";
          a.rectTop = VIEWPORT_TOP - scrollTop + top - 150;
          messages.appendChild(a);
        }
        const h = new FakeElement("div");
        h.className = "msg human";
        h.rectTop = VIEWPORT_TOP - scrollTop + top;
        messages.appendChild(h);
      });
    },
    scrollTop: () => el("messages").scrollTop,
  };
}

before(() => {
  const html = createComposer({} as never, "agent" as ModeName, false, "en", "ltr", "auto");
  INLINE_SCRIPT = extractInlineScript(html);
});

describe("chat jump — host message protocol", () => {
  it("next from the top lands on the SECOND human row (first is within the 2px epsilon)", () => {
    const b = boot();
    b.seedTranscript([0, 400, 950, 2000], 0);
    b.post({ type: "jumpToNextUserMessageRequested" });
    assert.equal(b.scrollTop(), 400);
  });

  it("next from mid-scroll lands on the following human row; assistant rows are skipped", () => {
    const b = boot();
    b.seedTranscript([0, 400, 950, 2000], 500);
    b.post({ type: "jumpToNextUserMessageRequested" });
    assert.equal(b.scrollTop(), 950);
  });

  it("prev from mid-scroll lands on the previous human row", () => {
    const b = boot();
    b.seedTranscript([0, 400, 950, 2000], 1000);
    b.post({ type: "jumpToPrevUserMessageRequested" });
    assert.equal(b.scrollTop(), 950);
  });

  it("no wrap-around: next past the last human row and prev at the top are no-ops", () => {
    const b = boot();
    b.seedTranscript([0, 400, 950, 2000], 2000);
    b.post({ type: "jumpToNextUserMessageRequested" });
    assert.equal(b.scrollTop(), 2000);
    const b2 = boot();
    b2.seedTranscript([0, 400, 950, 2000], 0);
    b2.post({ type: "jumpToPrevUserMessageRequested" });
    assert.equal(b2.scrollTop(), 0);
  });

  it("edge requests scroll to the very top / bottom of the conversation", () => {
    const b = boot();
    b.seedTranscript([0, 400, 950, 2000], 700);
    b.post({ type: "agentPanelScrollToEdgeRequested", payload: { direction: -1 } });
    assert.equal(b.scrollTop(), 0);
    b.post({ type: "agentPanelScrollToEdgeRequested", payload: { direction: 1 } });
    assert.equal(b.scrollTop(), 2000); // scrollHeight 2600 - clientHeight 600
  });

  it("an edge request with an invalid direction is ignored", () => {
    const b = boot();
    b.seedTranscript([0, 400], 300);
    b.post({ type: "agentPanelScrollToEdgeRequested", payload: { direction: 0 } });
    assert.equal(b.scrollTop(), 300);
    b.post({ type: "agentPanelScrollToEdgeRequested" });
    assert.equal(b.scrollTop(), 300);
  });

  it("empty transcript: jumps are harmless no-ops", () => {
    const b = boot();
    b.seedTranscript([], 0);
    b.post({ type: "jumpToNextUserMessageRequested" });
    b.post({ type: "jumpToPrevUserMessageRequested" });
    assert.equal(b.scrollTop(), 0);
  });
});

describe("chat jump — inputEmpty reporting (glassPromptInputEmpty analog)", () => {
  it("reports empty=true once at startup (the prompt starts empty)", () => {
    const b = boot();
    const reports = b.posted.filter(
      (m) => (m as { type?: string }).type === "inputEmpty",
    ) as Array<{ empty: boolean }>;
    assert.ok(reports.length >= 1, "expected an inputEmpty report at startup");
    assert.equal(reports[0].empty, true);
  });
});
