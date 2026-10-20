/**
 * Submit-slot morph tests (DETAIL-CHAT §5, P1 — node:test, zero extra deps).
 *
 * Cursor 3.25.9 (verified live): the submit slot is ONE button
 * (class ui-prompt-input-submit-button) whose aria-label + icon morph with
 * the composer content — empty → "Start voice chat", non-empty →
 * "Send message".
 *
 * HONEST DIVERGENCE (2026-10-19): the voice entry was REMOVED — the Web
 * Speech API's recognition service is unavailable in Electron webviews
 * (tied to the browser vendor's cloud, not to Chromium — Electron ships
 * no speech API key), and this build bundles no mic capture or local STT
 * engine, so a voice button could never work. Zero-placeholder policy:
 * no dead buttons. Our slot morphs empty → DISABLED send, non-empty →
 * "Send message", running → stop-circle.
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
    fireKeydown: (e: Record<string, unknown>): Record<string, unknown> => {
      const input = el("input");
      const evt: Record<string, unknown> = {
        preventDefault: (): void => {
          evt.defaultPrevented = true;
        },
        defaultPrevented: false,
        ...e,
      };
      for (const fn of input.listeners.get("keydown") ?? []) {
        fn(evt);
      }
      return evt;
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

describe("composer submit-slot morph — static markup (DD-CM-2)", () => {
  it("renders the submit slot with Cursor's class and a disabled 'Send message' label when empty (voice entry REMOVED — honest divergence)", () => {
    assert.match(
      HTML,
      /<button id="send"[^>]*class="ui-prompt-input-submit-button[\s"][^>]*aria-label="Send message"/,
      "send button must carry class ui-prompt-input-submit-button + aria-label 'Send message'",
    );
  });

  it("carries Cursor's data-component / data-size attributes and a disabled state when empty", () => {
    assert.match(
      HTML,
      /<button id="send"[^>]*data-component="prompt-input-submit-button"[^>]*data-size="md"[^>]*data-state="disabled"/,
      "send button must carry data-component, data-size=md and data-state=disabled",
    );
    assert.match(
      HTML,
      /<button id="send"[^>]*\sdisabled[\s>]/,
      "the empty-state slot carries the standalone disabled attribute (no dead voice button)",
    );
  });

  it("contains no voice entry anywhere in the static markup", () => {
    assert.doesNotMatch(HTML, /Start voice chat/, "no voice-chat label");
    assert.doesNotMatch(HTML, /slot-voice/, "no voice slot class");
    // P2-F fix (QA-VERIFY-DIGDEEPER): strip JS/HTML comments before asserting.
    // The old `assert.doesNotMatch(HTML, /startVoiceChat/)` was too broad — it
    // would match the identifier inside a code comment (e.g. "never post a
    // dead startVoiceChat message") even with zero voice UI. Scoping to
    // comment-free markup keeps the test honest.
    const markupOnly = HTML.replace(/<!--[\s\S]*?-->/g, "").replace(
      /\/\*[\s\S]*?\*\//g,
      "",
    );
    assert.doesNotMatch(markupOnly, /startVoiceChat/, "no dead startVoiceChat message");
  });

  it("renders the send-arrow icon (inline SVG, no emoji) for the empty state", () => {
    const m = HTML.match(/<button id="send"[^>]*>([\s\S]*?)<\/button>/);
    assert.ok(m, "send button markup found");
    assert.match(m[1], /<svg/, "empty-state slot contains an inline SVG icon");
    assert.doesNotMatch(m[1], /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u, "no emoji in the icon");
  });

  it("has NO separate #stop button — stop is the same 24px circle morph (DD-CM-6)", () => {
    assert.doesNotMatch(HTML, /<button id="stop"/, "the rectangular Stop text button must be gone");
  });

  it("is the single-box architecture: toolbar row + model picker INSIDE #composer (DD-CM-1)", () => {
    const m = HTML.match(/<div id="composer"[^>]*>([\s\S]*?)<div class="menu" id="mentionMenu"/);
    assert.ok(m, "composer box markup found");
    const box = m[1];
    const chipsIdx = box.indexOf('id="chips"');
    const inputIdx = box.indexOf('id="input"');
    const toolbarIdx = box.indexOf('class="composer-toolbar"');
    const modelIdx = box.indexOf('id="modelBtn"');
    const sendIdx = box.indexOf('id="send"');
    assert.ok(
      chipsIdx >= 0 && inputIdx > chipsIdx && toolbarIdx > inputIdx,
      "chips row, input and toolbar row all live inside the single box, in that order",
    );
    assert.ok(modelIdx > toolbarIdx && sendIdx > modelIdx, "model picker + send slot sit inside the toolbar row");
  });

  it("uses the verbatim Cursor placeholder, not a per-mode one (DD-CM-4)", () => {
    assert.match(
      HTML,
      /<textarea id="input"[^>]*placeholder="Plan, Build, \/ for skills, @ for context"/,
      "input placeholder must be Cursor's verbatim string",
    );
  });
});

function styleBlock(): string {
  const m = HTML.match(/<style>([\s\S]*?)<\/style>/);
  assert.ok(m, "style block found in createComposer HTML");
  return m[1];
}

describe("composer metrics — static CSS (DD-CM-2/3)", () => {
  it("input box: 12px radius, 8/10/6/10 padding, light tokens (DD-CM-3)", () => {
    const css = styleBlock();
    const box = css.match(/#composer\s*\{([^}]*)\}/);
    assert.ok(box, "#composer rule found");
    assert.match(box[1], /border-radius:\s*12px/, "radius 12px");
    assert.match(box[1], /padding:\s*8px 10px 6px 10px/, "padding 8/10/6/10");
    assert.match(box[1], /background:\s*rgba\(252,252,252,0\.9\)/, "bg rgba(252,252,252,.9)");
    assert.match(box[1], /border:\s*1px solid rgba\(20,20,20,0\.2\)/, "border 1px rgba(20,20,20,.2)");
  });

  it("input: 14px/22px system-ui, #141414, no focus outline (DD-CM-3)", () => {
    const css = styleBlock();
    const input = css.match(/#input\s*\{([^}]*)\}/);
    assert.ok(input, "#input rule found");
    assert.match(input[1], /font-size:\s*14px/, "14px font");
    assert.match(input[1], /line-height:\s*22px/, "22px line height");
    assert.match(input[1], /font-family:\s*system-ui/, "system-ui stack");
    assert.match(input[1], /color:\s*#141414/, "#141414 text");
    assert.match(css, /#input:focus\s*\{[^}]*outline:\s*none/, "no focus outline");
  });

  it("placeholder: 36% ink at 50% opacity (DD-CM-4)", () => {
    const css = styleBlock();
    const ph = css.match(/#input::placeholder\s*\{([^}]*)\}/);
    assert.ok(ph, "#input::placeholder rule found");
    assert.match(ph[1], /color:\s*rgba\(20,20,20,0\.36\)/, "36% ink");
    assert.match(ph[1], /opacity:\s*0\.5/, "50% opacity");
  });

  it("submit slot: 24px circle with Cursor's state tokens (DD-CM-2/6)", () => {
    const css = styleBlock();
    const send = css.match(/#send\.ui-prompt-input-submit-button\s*\{([^}]*)\}/);
    assert.ok(send, "submit slot rule found");
    assert.match(send[1], /width:\s*24px/, "24px wide");
    assert.match(send[1], /height:\s*24px/, "24px tall");
    assert.match(send[1], /border-radius:\s*9999px/, "circle");
    assert.match(css, /#send\[data-state="active"\]\s*\{\s*background:\s*#141414/, "active bg #141414");
    assert.match(css, /#send\[data-state="disabled"\][\s\S]*?cursor:\s*not-allowed/, "disabled cursor not-allowed");
    assert.doesNotMatch(css, /slot-voice/, "voice slot CSS is gone");
    assert.match(css, /#send\.slot-send svg\s*\{[^}]*width:\s*12px/, "send icon 12px");
    assert.match(css, /#send\[data-state="stop"\] svg\s*\{[^}]*width:\s*20px/, "stop icon 20px");
  });

  it("chips: small inline pills, not 44px touch targets (DD-CM-7)", () => {
    const css = styleBlock();
    const chip = css.match(/\.chip\s*\{([^}]*)\}/);
    assert.ok(chip, ".chip rule found");
    assert.match(chip[1], /min-height:\s*22px/, "22px min-height");
    assert.doesNotMatch(chip[1], /min-height:\s*44px/, "44px min-height is gone");
    const chipBtn = css.match(/\.chip button\s*\{([^}]*)\}/);
    assert.ok(chipBtn, ".chip button rule found");
    assert.match(chipBtn[1], /width:\s*18px/, "18px X button");
    assert.doesNotMatch(chipBtn[1], /min-width:\s*44px/, "44px X button is gone");
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
  it("starts in the disabled send state (empty composer — voice entry removed)", () => {
    const b = boot();
    assert.strictEqual(sendLabel(b), "Send message");
    assert.strictEqual(b.el("send").getAttribute("title"), "Send message");
    assert.strictEqual(b.el("send").getAttribute("data-state"), "disabled");
    assert.strictEqual(b.el("send").disabled, true, "button is truly disabled — no dead voice button");
    assert.ok(b.el("send").classList.contains("slot-send"), "slot-send class for the 12px icon");
    assert.ok(!b.el("send").classList.contains("slot-voice"), "no voice slot class");
  });

  it("typing text morphs the slot to an enabled 'Send message'", () => {
    const b = boot();
    b.fireInput("hello test");
    assert.strictEqual(sendLabel(b), "Send message");
    assert.strictEqual(b.el("send").getAttribute("title"), "Send message");
    assert.strictEqual(b.el("send").getAttribute("data-state"), "active");
    assert.strictEqual(b.el("send").disabled, false, "slot enables once text is typed");
    assert.ok(b.el("send").classList.contains("slot-send"), "slot-send class for the 12px icon");
    assert.match(b.el("send").innerHTML, /<svg/, "send state renders an icon");
  });

  it("clearing the text morphs the slot back to the disabled send state", () => {
    const b = boot();
    b.fireInput("hello test");
    assert.strictEqual(sendLabel(b), "Send message");
    b.fireInput("");
    assert.strictEqual(sendLabel(b), "Send message");
    assert.strictEqual(b.el("send").getAttribute("data-state"), "disabled");
    assert.strictEqual(b.el("send").disabled, true, "slot re-disables when the text is cleared");
  });

  it("whitespace-only input counts as empty (disabled state)", () => {
    const b = boot();
    b.fireInput("   \n  ");
    assert.strictEqual(sendLabel(b), "Send message");
    assert.strictEqual(b.el("send").getAttribute("data-state"), "disabled");
    assert.strictEqual(b.el("send").disabled, true);
  });

  it("clicking the empty slot posts nothing — the dead voice entry is gone (zero-placeholder policy)", () => {
    const b = boot();
    const before = b.posted.length;
    b.clickSend();
    assert.strictEqual(b.posted.length, before, "an empty-slot click posts no message at all");
    assert.ok(
      !b.posted.some((m) => (m as { type: string }).type === "startVoiceChat"),
      "startVoiceChat is gone — never post a dead voice message",
    );
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

  it("Enter submits; the slot becomes the stop-circle morph while the turn runs (DD-CM-6)", () => {
    const b = boot();
    b.fireInput("hello test");
    b.fireKeydown({ key: "Enter", shiftKey: false, isComposing: false });
    const submit = b.posted.find((m) => (m as { type: string }).type === "submit");
    assert.ok(submit, "Enter posted a submit message");
    assert.strictEqual(b.el("input").value, "");
    // The submit started a turn → the SAME slot morphs to the stop state.
    assert.strictEqual(b.el("send").getAttribute("data-state"), "stop");
    assert.strictEqual(sendLabel(b), "Stop generation");
    assert.ok(b.el("send").classList.contains("slot-stop"), "slot-stop class for the 20px icon");
    // Clicking the stop slot posts stopTurn — never a second submit.
    b.clickSend();
    const last = b.posted[b.posted.length - 1] as { type: string };
    assert.strictEqual(last.type, "stopTurn");
    assert.ok(
      !b.posted.some((m) => (m as { type: string }).type === "startVoiceChat"),
      "stop slot must never post a dead voice message",
    );
    // The turn finishing morphs the slot back to the disabled send state.
    b.postToWebview({ type: "turnState", running: false });
    assert.strictEqual(sendLabel(b), "Send message");
    assert.strictEqual(b.el("send").getAttribute("data-state"), "disabled");
    assert.strictEqual(b.el("send").disabled, true, "slot re-disables after the turn");
  });

  it("host turnState morphs the SAME slot to stop and back (DD-CM-6)", () => {
    const b = boot();
    b.postToWebview({ type: "turnState", running: true });
    assert.strictEqual(b.el("send").getAttribute("data-state"), "stop", "slot is the stop state");
    assert.strictEqual(sendLabel(b), "Stop generation");
    assert.ok(b.el("send").classList.contains("slot-stop"));
    assert.match(b.el("send").innerHTML, /<svg/, "stop state renders the stop-circle icon");
    assert.doesNotMatch(HTML, /<button id="stop"/, "no separate stop button anywhere");
    b.postToWebview({ type: "turnState", running: false });
    assert.strictEqual(b.el("send").getAttribute("data-state"), "disabled");
    assert.ok(!b.el("send").classList.contains("slot-stop"), "stop class removed after the turn");
    assert.strictEqual(sendLabel(b), "Send message", "empty input → disabled send after the turn");
    assert.strictEqual(b.el("send").disabled, true);
  });

  it("mode sets the data-color accent on the submit slot (plan/debug/chat)", () => {
    const b = boot();
    b.postToWebview({ type: "mode", mode: "plan" });
    assert.strictEqual(b.el("send").getAttribute("data-color"), "plan");
    b.postToWebview({ type: "mode", mode: "debug" });
    assert.strictEqual(b.el("send").getAttribute("data-color"), "debug");
    b.postToWebview({ type: "mode", mode: "chat" });
    assert.strictEqual(b.el("send").getAttribute("data-color"), "chat");
    b.postToWebview({ type: "mode", mode: "agent" });
    assert.strictEqual(b.el("send").getAttribute("data-color"), null, "agent = no accent");
  });

  it("mode never changes the placeholder — it stays Cursor's verbatim string (DD-CM-4)", () => {
    const b = boot();
    b.postToWebview({ type: "mode", mode: "plan" });
    assert.strictEqual(
      b.el("input").getAttribute("placeholder"),
      "Plan, Build, / for skills, @ for context",
    );
    b.postToWebview({ type: "mode", mode: "debug" });
    assert.strictEqual(
      b.el("input").getAttribute("placeholder"),
      "Plan, Build, / for skills, @ for context",
    );
  });

  it("prefill morphs to 'Send message'; newChat morphs back to the disabled send state", () => {
    const b = boot();
    b.postToWebview({ type: "prefill", text: "explain this" });
    assert.strictEqual(sendLabel(b), "Send message");
    assert.strictEqual(b.el("send").disabled, false);
    b.postToWebview({ type: "newChat" });
    assert.strictEqual(sendLabel(b), "Send message");
    assert.strictEqual(b.el("send").getAttribute("data-state"), "disabled");
    assert.strictEqual(b.el("send").disabled, true);
  });
});

describe("composer keyboard contract (DD-CM-5) + chips (DD-CM-7) — live webview script", () => {
  it("Tab is trapped in the editor — it never moves focus out", () => {
    const b = boot();
    const evt = b.fireKeydown({ key: "Tab", shiftKey: false });
    assert.strictEqual(evt.defaultPrevented, true, "Tab must be preventDefaulted (trapped)");
  });

  it("Shift+Tab still cycles the chat mode (existing binding preserved)", () => {
    const b = boot();
    b.fireKeydown({ key: "Tab", shiftKey: true, ctrlKey: false, metaKey: false, altKey: false });
    const last = b.posted[b.posted.length - 1] as { type: string };
    assert.strictEqual(last.type, "cycleMode");
  });

  it("Esc blurs the composer", () => {
    const b = boot();
    b.fireKeydown({ key: "Escape" });
    assert.strictEqual(b.el("input").blurred, true, "Esc must blur the input");
  });

  it("Shift+Enter is not hijacked — the newline lands in the textarea", () => {
    const b = boot();
    const evt = b.fireKeydown({ key: "Enter", shiftKey: true, isComposing: false });
    assert.strictEqual(evt.defaultPrevented, false, "Shift+Enter must not be preventDefaulted");
    assert.ok(
      !b.posted.some((m) => (m as { type: string }).type === "submit"),
      "Shift+Enter must not submit",
    );
  });

  it("chips row is hidden when empty and appears inside the box on attach", () => {
    const b = boot();
    assert.ok(!b.el("chips").classList.contains("has-chips"), "no chips → row hidden");
    b.postToWebview({ type: "addSelectionContext", label: "foo.ts", content: "const a = 1;" });
    assert.ok(b.el("chips").classList.contains("has-chips"), "chip added → row visible");
    b.postToWebview({ type: "newChat" });
    assert.ok(!b.el("chips").classList.contains("has-chips"), "newChat clears chips → row hidden");
  });
});
