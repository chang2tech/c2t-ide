/**
 * Find-in-Chat webview tests (FIND-IN-CHAT — node:test, zero extra deps).
 *
 * Cursor parity note: Cursor 3.25.x opens a find overlay in the composer
 * panel on Cmd/Ctrl+F; its exact internals were not dissected, so these
 * tests pin OUR contract: the host posts {type:'showFindInChat'} /
 * {type:'hideFindInChat'}, the webview shows an overlay bar, searches the
 * rendered transcript (#messages), wraps matches in <mark class="find-match">,
 * shows "n / m", and Enter/Shift+Enter move the current match.
 *
 * Strategy (same as composer-morph.test.ts): createComposer() returns the
 * full webview HTML. Assert the static markup, then extract the inline
 * <script> and run it in node:vm against a minimal fake DOM — extended
 * here with text nodes + document.createTreeWalker, which the find
 * implementation needs. Transcript text is seeded as fake text nodes under
 * #messages.
 *
 * Run after `tsc`:  node out/components/composer-find.test.js
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
/* Minimal fake DOM — elements + text nodes + TreeWalker.               */
/* ------------------------------------------------------------------ */

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
  /** Real splitText semantics: this node keeps [0, offset), the returned
      node holds [offset, end) and is inserted right after this one. */
  splitText(offset: number): FakeText {
    const before = this.nodeValue.slice(0, offset);
    const after = this.nodeValue.slice(offset);
    this.nodeValue = before;
    const tail = new FakeText(after);
    const parent = this.parentNode;
    if (parent) {
      const idx = parent.children.indexOf(this);
      parent.children.splice(idx + 1, 0, tail);
      tail.parentNode = parent;
    }
    return tail;
  }
}

type Child = FakeElement | FakeText;

class FakeElement {
  tag: string;
  attrs = new Map<string, string>();
  listeners = new Map<string, Listener[]>();
  children: Child[] = [];
  parentNode: FakeElement | null = null;
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
  title = "";
  value = "";
  hidden = false;
  open = false;
  disabled = false;
  selectionStart: number | null = null;
  selectionEnd: number | null = null;
  selected = false;

  constructor(tag: string) {
    this.tag = tag;
  }
  get tagName(): string {
    return this.tag.toUpperCase();
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
      this.listeners.set(
        t,
        arr.filter((f) => f !== fn),
      );
    }
  }
  /** Real DOM move semantics: a child is detached from its old parent. */
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
  focused = false;
  focus(): void {
    this.focused = true;
  }
  blur(): void {
    this.focused = false;
  }
  click(): void {
    /* noop */
  }
  select(): void {
    this.selected = true;
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

/** Depth-first text-node iterator, honoring a NodeFilter-style filter. */
class FakeTreeWalker {
  private stack: Child[];
  constructor(
    root: FakeElement,
    private filter: { acceptNode?: (n: Child) => number } | null,
  ) {
    this.stack = [...root.children].reverse();
  }
  nextNode(): Child | null {
    while (this.stack.length > 0) {
      const node = this.stack.pop() as Child;
      if (node instanceof FakeElement) {
        for (let i = node.children.length - 1; i >= 0; i--) {
          this.stack.push(node.children[i]);
        }
        continue;
      }
      const verdict = this.filter?.acceptNode
        ? this.filter.acceptNode(node)
        : 1; /* FILTER_ACCEPT */
      if (verdict === 1) {
        return node;
      }
    }
    return null;
  }
}

interface Boot {
  el: (id: string) => FakeElement;
  posted: unknown[];
  showFind: () => void;
  hideFind: () => void;
  typeQuery: (value: string) => void;
  findKeydown: (e: Record<string, unknown>) => Record<string, unknown>;
  click: (id: "findPrev" | "findNext" | "findClose") => void;
  /**
   * Host → webview post (what ide.findNextInChat / ide.findPreviousInChat
   * send when the core composer.find.next / composer.find.previous actions
   * fire). Used to test the new-command message protocol.
   */
  post: (msg: unknown) => void;
  /** Append one transcript line (a div with a single text node) to #messages. */
  addLine: (text: string) => void;
  /** All <mark> highlights currently in the transcript. */
  marks: () => FakeElement[];
  transcriptText: () => string;
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
    createTextNode: (text: string): FakeText => new FakeText(text),
    createTreeWalker: (root: FakeElement, _what: number, filter: unknown): FakeTreeWalker =>
      new FakeTreeWalker(root, filter as { acceptNode?: (n: Child) => number } | null),
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
  const fireOn = (id: string, type: string, e: Record<string, unknown> = {}): Record<string, unknown> => {
    const target = el(id);
    const evt: Record<string, unknown> = {
      target,
      preventDefault: (): void => {
        evt.defaultPrevented = true;
      },
      defaultPrevented: false,
      ...e,
    };
    for (const fn of target.listeners.get(type) ?? []) {
      fn(evt);
    }
    return evt;
  };
  return {
    el,
    posted,
    showFind: () => postToWebview({ type: "showFindInChat" }),
    hideFind: () => postToWebview({ type: "hideFindInChat" }),
    typeQuery: (value: string) => {
      const input = el("findInput");
      input.value = value;
      fireOn("findInput", "input");
    },
    findKeydown: (e: Record<string, unknown>) => fireOn("findInput", "keydown", e),
    click: (id) => fireOn(id, "click"),
    post: postToWebview,
    addLine: (text: string) => {
      const line = new FakeElement("div");
      line.appendChild(new FakeText(text));
      el("messages").appendChild(line);
    },
    marks: () => {
      const out: FakeElement[] = [];
      const walk = (n: Child): void => {
        if (n instanceof FakeElement) {
          if (n.tag === "mark" && n.classList.contains("find-match")) {
            out.push(n);
          }
          for (const c of n.children) {
            walk(c);
          }
        }
      };
      walk(el("messages"));
      return out;
    },
    transcriptText: () => el("messages").textContent,
  };
}

let HTML = "";

before(() => {
  HTML = createComposer({} as never, "agent" as ModeName, false, "en", "ltr", "auto");
  INLINE_SCRIPT = extractInlineScript(HTML);
});

/* ------------------------------------------------------------------ */

describe("find-in-chat — static markup", () => {
  it("renders the find bar hidden with input, count, prev/next/close buttons", () => {
    assert.match(HTML, /<div id="findBar"[^>]*\bhidden\b/, "find bar starts hidden");
    assert.match(HTML, /<input id="findInput"/, "find input present");
    assert.match(HTML, /<span id="findCount"/, "match count present");
    assert.match(HTML, /<button id="findPrev"/, "prev button present");
    assert.match(HTML, /<button id="findNext"/, "next button present");
    assert.match(HTML, /<button id="findClose"/, "close button present");
  });

  it("uses inline SVG icons, never emoji, in the find bar", () => {
    const m = HTML.match(/<div id="findBar"[\s\S]*?<\/div>/);
    assert.ok(m, "find bar markup found");
    assert.match(m[0], /<svg/, "buttons use inline SVG");
    assert.doesNotMatch(m[0], /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u, "no emoji in the find bar");
  });

  it("the find bar is a sibling of #messages, not inside it (it must not be searched)", () => {
    const messagesIdx = HTML.indexOf('id="messages"');
    const findBarIdx = HTML.indexOf('id="findBar"');
    assert.ok(messagesIdx !== -1 && findBarIdx !== -1 && findBarIdx > messagesIdx);
  });

  it("styles find matches via theme variables with fallbacks", () => {
    assert.match(HTML, /mark\.find-match\s*\{[^}]*var\(--vscode-editor-findMatchBackground/, "match background themed");
    assert.match(HTML, /mark\.find-match\.find-current/, "current-match style present");
  });
});

describe("find-in-chat — show / hide protocol", () => {
  it("{type:'showFindInChat'} reveals the bar and focuses the find input", () => {
    const b = boot();
    // Note: the fake DOM does not parse HTML, so the static `hidden`
    // attribute is asserted on the raw markup above; here the bar starts
    // in the script's default state and must become visible on the message.
    b.el("findBar").hidden = true;
    b.showFind();
    assert.strictEqual(b.el("findBar").hidden, false);
    assert.strictEqual(b.el("findInput").focused, true);
  });

  it("{type:'hideFindInChat'} hides the bar and returns focus to the chat input", () => {
    const b = boot();
    b.showFind();
    b.hideFind();
    assert.strictEqual(b.el("findBar").hidden, true);
    assert.strictEqual(b.el("input").focused, true);
  });

  it("Escape in the find input hides the bar and refocuses the chat input", () => {
    const b = boot();
    b.showFind();
    const evt = b.findKeydown({ key: "Escape" });
    assert.strictEqual(evt.defaultPrevented, true);
    assert.strictEqual(b.el("findBar").hidden, true);
    assert.strictEqual(b.el("input").focused, true);
  });

  it("hiding clears highlights and the count but keeps the query (editor parity)", () => {
    const b = boot();
    b.addLine("hello world");
    b.showFind();
    b.typeQuery("hello");
    assert.strictEqual(b.marks().length, 1);
    b.hideFind();
    assert.strictEqual(b.marks().length, 0);
    assert.strictEqual(b.el("findInput").value, "hello", "query preserved for reopen");
    assert.strictEqual(b.el("findCount").textContent, "");
    assert.strictEqual(b.transcriptText(), "hello world", "unwrap restores the original text");
  });

  it("the close button hides the bar", () => {
    const b = boot();
    b.showFind();
    b.click("findClose");
    assert.strictEqual(b.el("findBar").hidden, true);
  });
});

describe("find-in-chat — search, highlight, navigation", () => {
  function bootWithTranscript(): Boot {
    const b = boot();
    b.addLine("the quick brown fox");
    b.addLine("jumps over the lazy dog");
    b.addLine("FOX and fox again");
    b.showFind();
    return b;
  }

  it("finds case-insensitive matches across lines and shows n / m", () => {
    const b = bootWithTranscript();
    b.typeQuery("fox");
    const marks = b.marks();
    assert.strictEqual(marks.length, 3, "fox, FOX, fox = 3 matches");
    assert.strictEqual(b.el("findCount").textContent, "1 / 3");
    assert.ok(marks[0].classList.contains("find-current"), "first match is current");
    assert.ok(!marks[1].classList.contains("find-current"), "others are not current");
    assert.strictEqual(marks[0].textContent, "fox");
    assert.strictEqual(marks[1].textContent, "FOX", "original casing preserved in the highlight");
  });

  it("shows 'No results' when nothing matches and creates no marks", () => {
    const b = bootWithTranscript();
    b.typeQuery("zebra");
    assert.strictEqual(b.marks().length, 0);
    assert.strictEqual(b.el("findCount").textContent, "No results");
  });

  it("clears the count and marks when the query is emptied", () => {
    const b = bootWithTranscript();
    b.typeQuery("fox");
    assert.strictEqual(b.marks().length, 3);
    b.typeQuery("");
    assert.strictEqual(b.marks().length, 0);
    assert.strictEqual(b.el("findCount").textContent, "");
  });

  it("Enter moves to the next match and wraps around", () => {
    const b = bootWithTranscript();
    b.typeQuery("fox");
    b.findKeydown({ key: "Enter" });
    assert.strictEqual(b.el("findCount").textContent, "2 / 3");
    assert.ok(b.marks()[1].classList.contains("find-current"));
    b.findKeydown({ key: "Enter" });
    assert.strictEqual(b.el("findCount").textContent, "3 / 3");
    b.findKeydown({ key: "Enter" });
    assert.strictEqual(b.el("findCount").textContent, "1 / 3", "wraps to the first match");
  });

  it("Shift+Enter moves to the previous match and wraps around", () => {
    const b = bootWithTranscript();
    b.typeQuery("fox");
    b.findKeydown({ key: "Enter", shiftKey: true });
    assert.strictEqual(b.el("findCount").textContent, "3 / 3", "wraps to the last match");
    assert.ok(b.marks()[2].classList.contains("find-current"));
  });

  it("prev/next buttons move the current match", () => {
    const b = bootWithTranscript();
    b.typeQuery("fox");
    b.click("findNext");
    assert.strictEqual(b.el("findCount").textContent, "2 / 3");
    b.click("findPrev");
    assert.strictEqual(b.el("findCount").textContent, "1 / 3");
  });

  it("finds multiple matches inside a single text node", () => {
    const b = boot();
    b.addLine("foo bar foo bar foo");
    b.showFind();
    b.typeQuery("foo");
    assert.strictEqual(b.marks().length, 3);
    assert.strictEqual(b.el("findCount").textContent, "1 / 3");
  });

  it("re-searching unwraps old highlights before wrapping new ones", () => {
    const b = bootWithTranscript();
    b.typeQuery("fox");
    assert.strictEqual(b.marks().length, 3);
    b.typeQuery("the");
    assert.strictEqual(b.marks().length, 2, "the, the = 2 matches, no stale fox marks");
    assert.strictEqual(
      b.transcriptText(),
      "the quick brown foxjumps over the lazy dogFOX and fox again",
      "transcript text is intact after re-search",
    );
  });

  it("Ctrl+F inside the find input reselects the query (editor parity)", () => {
    const b = bootWithTranscript();
    b.typeQuery("fox");
    b.el("findInput").selected = false;
    const evt = b.findKeydown({ key: "f", ctrlKey: true });
    assert.strictEqual(evt.defaultPrevented, true);
    assert.strictEqual(b.el("findInput").selected, true);
  });

  it("reopening keeps the previous query and reselects it", () => {
    const b = bootWithTranscript();
    b.typeQuery("fox");
    b.hideFind();
    b.el("findInput").selected = false;
    b.showFind();
    assert.strictEqual(b.el("findInput").value, "fox");
    assert.strictEqual(b.el("findInput").selected, true);
    assert.strictEqual(b.marks().length, 3, "matches are re-run on reopen");
  });
});

describe("find-in-chat — host findNext/findPrevious protocol (composer.find.next / composer.find.previous)", () => {
  // Binary parity (Cursor 3.25.9, workbench.glass.main.js, offset 39888447):
  //   composer.find.next     "Find Next in Chat"     F3 / Enter,       f1:!1, weight 200, when composerFindWidgetFocused → findNext(i)
  //   composer.find.previous "Find Previous in Chat" Shift+F3 / Shift+Enter, f1:!1, weight 200, when composerFindWidgetFocused → findPrevious(i)
  // In the fork the core Action2s (composerActions.ts) delegate to
  // ide.findNextInChat / ide.findPreviousInChat, and the host posts these
  // webview messages. The webview must advance the SAME <mark> highlights as
  // the find input's own Enter/Shift+Enter handlers (they share findGoTo).
  function bootWithFox(): Boot {
    const b = boot();
    b.addLine("the quick brown fox");
    b.addLine("jumps over the lazy dog");
    b.addLine("FOX and fox again");
    b.showFind();
    b.typeQuery("fox");
    return b;
  }

  it("{type:'findNextInChat'} advances the current match and wraps around", () => {
    const b = bootWithFox();
    assert.strictEqual(b.el("findCount").textContent, "1 / 3");
    b.post({ type: "findNextInChat" });
    assert.strictEqual(b.el("findCount").textContent, "2 / 3");
    assert.ok(b.marks()[1].classList.contains("find-current"));
    assert.ok(!b.marks()[0].classList.contains("find-current"));
    b.post({ type: "findNextInChat" });
    assert.strictEqual(b.el("findCount").textContent, "3 / 3");
    b.post({ type: "findNextInChat" });
    assert.strictEqual(b.el("findCount").textContent, "1 / 3", "wraps to the first match");
    assert.ok(b.marks()[0].classList.contains("find-current"));
  });

  it("{type:'findPreviousInChat'} goes to the previous match and wraps around", () => {
    const b = bootWithFox();
    b.post({ type: "findPreviousInChat" });
    assert.strictEqual(b.el("findCount").textContent, "3 / 3", "wraps to the last match");
    assert.ok(b.marks()[2].classList.contains("find-current"));
    b.post({ type: "findPreviousInChat" });
    assert.strictEqual(b.el("findCount").textContent, "2 / 3");
    assert.ok(b.marks()[1].classList.contains("find-current"));
  });

  it("host messages interleave with the find input's own Enter/Shift+Enter navigation", () => {
    const b = bootWithFox();
    b.findKeydown({ key: "Enter" }); // 2 / 3 via the input handler
    assert.strictEqual(b.el("findCount").textContent, "2 / 3");
    b.post({ type: "findNextInChat" }); // host path continues from the same index
    assert.strictEqual(b.el("findCount").textContent, "3 / 3");
    b.post({ type: "findPreviousInChat" });
    assert.strictEqual(b.el("findCount").textContent, "2 / 3");
    b.findKeydown({ key: "Enter", shiftKey: true });
    assert.strictEqual(b.el("findCount").textContent, "1 / 3");
  });

  it("findNext/findPrevious are no-ops when the bar is closed (no marks, no throw)", () => {
    const b = boot();
    b.addLine("the quick brown fox");
    // Bar never opened: the core keybinding's when-clause (composerFindWidgetFocused)
    // normally prevents these, but the webview must not crash on a stray post.
    assert.doesNotThrow(() => {
      b.post({ type: "findNextInChat" });
      b.post({ type: "findPreviousInChat" });
    });
    assert.strictEqual(b.marks().length, 0);
  });

  it("findNext is a no-op when the query has no matches (no throw)", () => {
    const b = boot();
    b.addLine("the quick brown fox");
    b.showFind();
    b.typeQuery("zebra");
    assert.strictEqual(b.el("findCount").textContent, "No results");
    assert.doesNotThrow(() => b.post({ type: "findNextInChat" }));
    assert.strictEqual(b.el("findCount").textContent, "No results");
    assert.strictEqual(b.marks().length, 0);
  });
});
