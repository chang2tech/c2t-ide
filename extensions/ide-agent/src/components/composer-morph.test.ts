/**
 * Submit-slot morph tests (DETAIL-CHAT §5, P1 — node:test, zero extra deps).
 *
 * Verified live on Cursor 3.25.9: the submit slot is ONE button
 * (class ui-prompt-input-submit-button) whose aria-label + icon morph with
 * the composer content — empty → "Start voice chat", non-empty →
 * "Send message". It is NOT a disabled Send button when empty.
 *
 * Strategy: createComposer() returns the full webview HTML. The test
 * asserts the static initial markup, then extracts the inline <script> and
 * runs it in node:vm against a minimal fake DOM, firing the same input /
 * click / message events the real webview would produce.
 *
 * Run after `tsc`:  node out/components/composer-morph.test.js
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
/* Minimal fake DOM — just enough for the composer's inline script.     */
/* ------------------------------------------------------------------ */

type Listener = (e?: any) => void;

class FakeElement {
  tag: string;
  attrs = new Map<string, string>();
  listeners = new Map<string, Listener[]>();
  children: FakeElement[] = [];
  style: any = {
    setProperty(_k: string, _v: string): void {
      /* noop */
    },
  };
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
  innerHTML = "";
  textContent = "";
  title = "";
  value = "";
  hidden = false;
  open = false;
  disabled = false;
  selectionStart: number | null = null;
  selectionEnd: number | null = null;

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
    /* noop */
  }
  blur(): void {
    /* noop */
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
  fireKeydown: (e: Record<string, unknown>) => void;
  clickSend: () => void;
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
  const el = (id: string): FakeElement => {
    const e = byId.get(id);
    assert.ok(e, `element #${id} was never requested by the webview script`);
    return e as FakeElement;
  };
  return {
    el,
    posted,
    fireInput: (value: string): void => {
      const input = el("input");
      input.value = value;
      for (const fn of input.listeners.get("input") ?? []) {
        fn({ target: input });
      }
    },
    fireKeydown: (e: Record<string, unknown>): void => {
      const input = el("input");
      const evt = { preventDefault: (): void => undefined, ...e };
      for (const fn of input.listeners.get("keydown") ?? []) {
        fn(evt);
      }
    },
    clickSend: (): void => {
      for (const fn of el("send").listeners.get("click") ?? []) {
        fn({});
      }
    },
    postToWebview: (msg: unknown): void => {
      for (const fn of winListeners.get("message") ?? []) {
        fn({ data: msg });
      }
    },
  };
}

function sendLabel(b: Boot): string | null {
  return b.el("send").getAttribute("aria-label");
}

let HTML = "";

before(() => {
  HTML = createComposer(
    {} as never,
    "agent" as ModeName,
    false,
    "en",
    "ltr",
    "auto",
  );
  INLINE_SCRIPT = extractInlineScript(HTML);
});

/* ------------------------------------------------------------------ */

describe("composer submit-slot morph — static markup (DETAIL-CHAT §5)", () => {
  it("renders the submit slot with Cursor's class and the voice-chat label when empty", () => {
    assert.match(
      HTML,
      /<button id="send"[^>]*class="ui-prompt-input-submit-button"[^>]*aria-label="Start voice chat"/,
      "send button must carry class ui-prompt-input-submit-button + aria-label 'Start voice chat'",
    );
  });

  it("renders a mic icon (inline SVG, no emoji) for the empty state", () => {
    const m = HTML.match(/<button id="send"[^>]*>([\s\S]*?)<\/button>/);
    assert.ok(m, "send button markup found");
    assert.match(m[1], /<svg/, "empty-state slot contains an inline SVG icon");
    assert.doesNotMatch(m[1], /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u, "no emoji in the icon");
  });

  it("stop button carries Cursor's 'Stop generation' label", () => {
    assert.match(
      HTML,
      /<button id="stop"[^>]*aria-label="Stop generation"/,
      "stop button must have aria-label 'Stop generation'",
    );
  });
});

describe("composer webview script — markdown escape regression (P0)", () => {
  // The inline script once shipped with single-backslash escapes inside the
  // TS template literal, which the template turned into literal backticks /
  // newlines / dropped backslashes — the whole webview script failed to
  // parse. These tests extract renderMarkdown from the SHIPPED script and
  // verify it actually works (XSS-safe, placeholders restored).
  function renderMarkdownFromScript(): (src: string) => string {
    const start = INLINE_SCRIPT.indexOf("function esc(s)");
    const end = INLINE_SCRIPT.indexOf("function toolCallCardEl");
    assert.ok(start >= 0 && end > start, "markdown block found in inline script");
    const block = INLINE_SCRIPT.slice(start, end);
    return new Function(block + "; return renderMarkdown;")() as (src: string) => string;
  }

  it("renders inline code, bold, italic, links, headings, lists, quotes", () => {
    const renderMarkdown = renderMarkdownFromScript();
    const bt = String.fromCharCode(96);
    assert.match(renderMarkdown("hello " + bt + "code" + bt + " world"), /<code>code<\/code>/);
    assert.match(renderMarkdown("**bold** and *italic*"), /<strong>bold<\/strong>/);
    assert.match(renderMarkdown("*em*"), /<em>em<\/em>/);
    assert.match(
      renderMarkdown("[link](https://example.com)"),
      /<a href="https:\/\/example\.com"/,
    );
    assert.match(renderMarkdown("# Title"), /<h1>Title<\/h1>/);
    assert.match(renderMarkdown("- item"), /<li>item<\/li>/);
    assert.match(renderMarkdown("> quote"), /<blockquote>quote<\/blockquote>/);
  });

  it("renders fenced code blocks (including unclosed fences)", () => {
    const renderMarkdown = renderMarkdownFromScript();
    const bt = String.fromCharCode(96);
    assert.match(
      renderMarkdown(bt + bt + bt + "js\nconst a = 1;\n" + bt + bt + bt),
      /<pre class="md-code">/,
    );
    assert.match(renderMarkdown(bt + bt + bt + "\nopen fence"), /<pre class="md-code">/);
  });

  it("escapes HTML and rejects non-http(s) link targets (XSS-safe)", () => {
    const renderMarkdown = renderMarkdownFromScript();
    assert.match(renderMarkdown("<script>alert(1)</script>"), /&lt;script&gt;/);
    assert.doesNotMatch(renderMarkdown("[x](javascript:alert(1))"), /<a href/);
  });
});

describe("composer submit-slot morph — live webview script", () => {
  it("starts in the voice-chat state (empty composer)", () => {
    const b = boot();
    assert.strictEqual(sendLabel(b), "Start voice chat");
    assert.strictEqual(b.el("send").getAttribute("title"), "Start voice chat");
  });

  it("typing text morphs the slot to 'Send message'", () => {
    const b = boot();
    b.fireInput("hello test");
    assert.strictEqual(sendLabel(b), "Send message");
    assert.strictEqual(b.el("send").getAttribute("title"), "Send (Enter)");
    assert.match(b.el("send").innerHTML, /<svg/, "send state renders an icon");
  });

  it("clearing the text morphs the slot back to 'Start voice chat'", () => {
    const b = boot();
    b.fireInput("hello test");
    assert.strictEqual(sendLabel(b), "Send message");
    b.fireInput("");
    assert.strictEqual(sendLabel(b), "Start voice chat");
  });

  it("whitespace-only input counts as empty (voice state)", () => {
    const b = boot();
    b.fireInput("   \n  ");
    assert.strictEqual(sendLabel(b), "Start voice chat");
  });

  it("clicking the empty slot posts startVoiceChat (never a fake session)", () => {
    const b = boot();
    b.clickSend();
    // Note: the message object is created inside the vm realm, so compare
    // by property instead of deepStrictEqual (different Object.prototype).
    const last = b.posted[b.posted.length - 1] as { type: string };
    assert.strictEqual(last.type, "startVoiceChat");
    assert.ok(
      !b.posted.some((m) => (m as { type: string }).type === "submit"),
      "empty slot must not submit",
    );
  });

  it("clicking the slot with text submits the message", () => {
    const b = boot();
    b.fireInput("hello test");
    b.clickSend();
    const last = b.posted[b.posted.length - 1] as { type: string; text: string };
    assert.strictEqual(last.type, "submit");
    assert.strictEqual(last.text, "hello test");
  });

  it("Enter submits and the slot morphs back to voice chat", () => {
    const b = boot();
    b.fireInput("hello test");
    b.fireKeydown({ key: "Enter", shiftKey: false, isComposing: false });
    const submit = b.posted.find((m) => (m as { type: string }).type === "submit");
    assert.ok(submit, "Enter posted a submit message");
    assert.strictEqual(b.el("input").value, "");
    assert.strictEqual(sendLabel(b), "Start voice chat");
  });

  it("running turn shows Stop; finishing restores the morph for the current input", () => {
    const b = boot();
    b.postToWebview({ type: "turnState", running: true });
    assert.ok(b.el("stop").classList.contains("visible"), "Stop button visible while running");
    assert.ok(b.el("send").classList.contains("hidden"), "send slot hidden while running");
    b.postToWebview({ type: "turnState", running: false });
    assert.ok(!b.el("stop").classList.contains("visible"), "Stop button hidden after the turn");
    assert.ok(!b.el("send").classList.contains("hidden"), "send slot visible after the turn");
    assert.strictEqual(sendLabel(b), "Start voice chat", "empty input → voice state after the turn");
  });

  it("prefill morphs to 'Send message'; newChat morphs back to voice", () => {
    const b = boot();
    b.postToWebview({ type: "prefill", text: "explain this" });
    assert.strictEqual(sendLabel(b), "Send message");
    b.postToWebview({ type: "newChat" });
    assert.strictEqual(sendLabel(b), "Start voice chat");
  });
});
