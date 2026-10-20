/**
 * Find-in-Plan webview tests (PLAN-FIND, GAPS-157 — node:test, zero
 * extra deps).
 *
 * Cursor parity (3.25.9 glass, verified by GAPS-157 slice 1): the
 * pane-level family showPlanFind / hidePlanFind / nextPlanFindMatch /
 * previousPlanFindMatch emits planFind*Requested events; the plan tab's
 * generic rich-text find bar (data-component "plan-tab-find-bar")
 * searches ONLY the plan document — case-insensitive substring matches,
 * count label "N of M" / "0 of 0", next/previous wrap, hard no-op with
 * no matches, nav buttons disabled at total===0. The fork's plan
 * content is the plan-mode assistant bubble in the transcript (the
 * host posts {type:'planReady', bubbleId} with PendingPlan.bubbleId),
 * so these tests pin OUR contract: the webview plan find bar searches
 * exactly that bubble and never highlights transcript text outside it.
 *
 * Strategy (same as composer-find.test.ts, whose fake-DOM harness is
 * reused verbatim below): createComposer() returns the full webview
 * HTML; assert the static markup, then run the inline <script> in
 * node:vm against the fake DOM. Bubbles are seeded as elements under
 * #messages; the plan bubble gets data-bubble="<id>" exactly like the
 * real renderer (composer.ts renderBubble).
 *
 * Run after `tsc`:  node out/components/composer-plan-find.test.js
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
/* GAPS-157 plan-find tests. The harness above (fake DOM + boot) is     */
/* shared with composer-find.test.ts; the helpers below add plan       */
/* bubbles (data-bubble) and per-element mark counting.                */
/* ------------------------------------------------------------------ */

/** Append a transcript line and tag it as the bubble `id` (real bubbles carry data-bubble). */
function addBubble(b: Boot, id: string, text: string): FakeElement {
  b.addLine(text);
  const kids = b.el("messages").children;
  const elx = kids[kids.length - 1] as FakeElement;
  elx.setAttribute("data-bubble", id);
  return elx;
}

/** All <mark class="find-match"> highlights under one element. */
function marksIn(root: FakeElement): FakeElement[] {
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
  walk(root);
  return out;
}

function fireOn(b: Boot, id: string, type: string, e: Record<string, unknown> = {}): Record<string, unknown> {
  const target = b.el(id);
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
}

function typePlanQuery(b: Boot, value: string): void {
  b.el("planFindInput").value = value;
  fireOn(b, "planFindInput", "input");
}

function planFindStates(b: Boot): Array<Record<string, unknown>> {
  // Normalize into test-realm plain objects: the posted messages are
  // created inside the vm context, so deepStrictEqual on the raw objects
  // would fail on prototype (realm) mismatch despite identical fields.
  return b.posted
    .filter(
      (m): m is Record<string, unknown> =>
        typeof m === "object" && m !== null && (m as Record<string, unknown>).type === "planFindBarState",
    )
    .map((m) => ({ type: m.type, open: m.open, inputFocused: m.inputFocused }));
}

/** Boot with a pending plan: plan bubble + one ordinary transcript bubble. */
function bootWithPlan(): { b: Boot; plan: FakeElement; other: FakeElement } {
  const b = boot();
  const other = addBubble(b, "other-1", "deploy the app and deploy it again");
  const plan = addBubble(b, "plan-1", "Plan: Deploy the service, then deploy the worker");
  b.post({ type: "planReady", bubbleId: "plan-1" });
  return { b, plan, other };
}

describe("find-in-plan — static markup", () => {
  it("renders the plan find bar hidden with the binary data-component and controls", () => {
    assert.match(HTML, /<div id="planFindBar"[^>]*\bhidden\b/, "plan find bar starts hidden");
    assert.match(HTML, /data-component="plan-tab-find-bar"/, "binary-verbatim data-component (config D2_ @32788864)");
    assert.match(HTML, /<input id="planFindInput"[^>]*placeholder="Find in Plan"/, "plan find input present");
    assert.match(HTML, /<span id="planFindCount"/, "match count present");
    assert.match(HTML, /<button id="planFindPrev"/, "prev button present");
    assert.match(HTML, /<button id="planFindNext"/, "next button present");
    assert.match(HTML, /<button id="planFindClose"/, "close button present");
  });

  it("planReady reveals the tray (existing behavior, plan find rides on it)", () => {
    const { b } = bootWithPlan();
    assert.strictEqual(b.el("planTray").hidden, false);
  });
});

describe("find-in-plan — show / hide protocol", () => {
  it("{type:'showFindInPlan'} reveals the bar, focuses+selects the input, reports state", () => {
    const { b } = bootWithPlan();
    b.el("planFindBar").hidden = true;
    b.post({ type: "showFindInPlan" });
    assert.strictEqual(b.el("planFindBar").hidden, false);
    assert.strictEqual(b.el("planFindInput").focused, true);
    assert.strictEqual(b.el("planFindInput").selected, true);
    assert.deepStrictEqual(planFindStates(b), [{ type: "planFindBarState", open: true, inputFocused: true }]);
  });

  it("{type:'hideFindInPlan'} hides the bar, clears marks, returns focus to the composer input", () => {
    const { b, plan } = bootWithPlan();
    b.post({ type: "showFindInPlan" });
    typePlanQuery(b, "deploy");
    assert.ok(marksIn(plan).length > 0);
    b.post({ type: "hideFindInPlan" });
    assert.strictEqual(b.el("planFindBar").hidden, true);
    assert.strictEqual(marksIn(plan).length, 0);
    assert.strictEqual(b.el("input").focused, true);
    const states = planFindStates(b);
    assert.deepStrictEqual(states[states.length - 1], { type: "planFindBarState", open: false, inputFocused: false });
  });

  it("Escape in the plan find input hides the bar", () => {
    const { b } = bootWithPlan();
    b.post({ type: "showFindInPlan" });
    const evt = fireOn(b, "planFindInput", "keydown", { key: "Escape" });
    assert.strictEqual(evt.defaultPrevented, true);
    assert.strictEqual(b.el("planFindBar").hidden, true);
  });

  it("input focus/blur reports keep glassFindInputFocused truthful while open", () => {
    const { b } = bootWithPlan();
    b.post({ type: "showFindInPlan" });
    fireOn(b, "planFindInput", "blur");
    fireOn(b, "planFindInput", "focus");
    const states = planFindStates(b);
    assert.deepStrictEqual(states[states.length - 2], { type: "planFindBarState", open: true, inputFocused: false });
    assert.deepStrictEqual(states[states.length - 1], { type: "planFindBarState", open: true, inputFocused: true });
  });

  it("planCleared closes an open plan find bar and drops the scope", () => {
    const { b, plan } = bootWithPlan();
    b.post({ type: "showFindInPlan" });
    typePlanQuery(b, "deploy");
    assert.ok(marksIn(plan).length > 0);
    b.post({ type: "planCleared" });
    assert.strictEqual(b.el("planFindBar").hidden, true);
    assert.strictEqual(marksIn(plan).length, 0);
  });
});

describe("find-in-plan — scoped search, highlight, navigation", () => {
  it("finds case-insensitive matches ONLY inside the plan bubble", () => {
    const { b, plan, other } = bootWithPlan();
    b.post({ type: "showFindInPlan" });
    typePlanQuery(b, "deploy");
    // Plan bubble: "Deploy" + "deploy" = 2. Other bubble has 2 more
    // "deploy"s — they must NOT be highlighted or counted.
    assert.strictEqual(marksIn(plan).length, 2);
    assert.strictEqual(marksIn(other).length, 0);
    assert.strictEqual(b.el("planFindCount").textContent, "1 of 2", "binary count label format");
    const current = marksIn(plan).filter((m) => m.classList.contains("find-current"));
    assert.strictEqual(current.length, 1, "exactly one current match");
  });

  it("Enter moves to the next match and wraps; Shift+Enter goes back (binary wrap)", () => {
    const { b } = bootWithPlan();
    b.post({ type: "showFindInPlan" });
    typePlanQuery(b, "deploy");
    assert.strictEqual(b.el("planFindCount").textContent, "1 of 2");
    fireOn(b, "planFindInput", "keydown", { key: "Enter" });
    assert.strictEqual(b.el("planFindCount").textContent, "2 of 2");
    fireOn(b, "planFindInput", "keydown", { key: "Enter" });
    assert.strictEqual(b.el("planFindCount").textContent, "1 of 2", "wraps to the first match");
    fireOn(b, "planFindInput", "keydown", { key: "Enter", shiftKey: true });
    assert.strictEqual(b.el("planFindCount").textContent, "2 of 2", "Shift+Enter wraps backwards");
  });

  it("host findNextInPlan / findPreviousInPlan messages navigate (core Enter chords)", () => {
    const { b } = bootWithPlan();
    b.post({ type: "showFindInPlan" });
    typePlanQuery(b, "deploy");
    b.post({ type: "findNextInPlan" });
    assert.strictEqual(b.el("planFindCount").textContent, "2 of 2");
    b.post({ type: "findPreviousInPlan" });
    assert.strictEqual(b.el("planFindCount").textContent, "1 of 2");
  });

  it("prev/next buttons navigate and are disabled while there are no matches", () => {
    const { b } = bootWithPlan();
    b.post({ type: "showFindInPlan" });
    typePlanQuery(b, "deploy");
    assert.strictEqual(b.el("planFindNext").disabled, false);
    fireOn(b, "planFindNext", "click");
    assert.strictEqual(b.el("planFindCount").textContent, "2 of 2");
    fireOn(b, "planFindPrev", "click");
    assert.strictEqual(b.el("planFindCount").textContent, "1 of 2");
  });

  it("no matches: label is '0 of 0', nav disabled, host next/previous are no-ops (binary SearchPlugin guard)", () => {
    const { b, plan } = bootWithPlan();
    b.post({ type: "showFindInPlan" });
    typePlanQuery(b, "nonexistentterm");
    assert.strictEqual(marksIn(plan).length, 0);
    assert.strictEqual(b.el("planFindCount").textContent, "0 of 0");
    assert.strictEqual(b.el("planFindNext").disabled, true);
    assert.strictEqual(b.el("planFindPrev").disabled, true);
    b.post({ type: "findNextInPlan" });
    b.post({ type: "findPreviousInPlan" });
    fireOn(b, "planFindInput", "keydown", { key: "Enter" });
    assert.strictEqual(b.el("planFindCount").textContent, "0 of 0", "no-op navigation keeps the empty state");
  });

  it("empty query clears marks and the count", () => {
    const { b, plan } = bootWithPlan();
    b.post({ type: "showFindInPlan" });
    typePlanQuery(b, "deploy");
    assert.strictEqual(marksIn(plan).length, 2);
    typePlanQuery(b, "");
    assert.strictEqual(marksIn(plan).length, 0);
    assert.strictEqual(b.el("planFindCount").textContent, "");
  });

  it("Ctrl/Cmd+G inside the plan find input navigates (binary generic-bar chord)", () => {
    const { b } = bootWithPlan();
    b.post({ type: "showFindInPlan" });
    typePlanQuery(b, "deploy");
    fireOn(b, "planFindInput", "keydown", { key: "g", ctrlKey: true });
    assert.strictEqual(b.el("planFindCount").textContent, "2 of 2");
    fireOn(b, "planFindInput", "keydown", { key: "g", ctrlKey: true, shiftKey: true });
    assert.strictEqual(b.el("planFindCount").textContent, "1 of 2");
  });

  it("F3 does NOT navigate the plan find bar (binary plan family has no F3 chord)", () => {
    const { b } = bootWithPlan();
    b.post({ type: "showFindInPlan" });
    typePlanQuery(b, "deploy");
    const evt = fireOn(b, "planFindInput", "keydown", { key: "F3" });
    assert.strictEqual(evt.defaultPrevented, false);
    assert.strictEqual(b.el("planFindCount").textContent, "1 of 2");
  });

  it("chat find still scopes to the whole transcript and is unaffected by plan find state", () => {
    const { b, plan, other } = bootWithPlan();
    // Chat find (regression, GAPS-134 family): searches #messages wholesale.
    b.showFind();
    b.typeQuery("deploy");
    assert.strictEqual(b.marks().length, 4, "chat find sees plan + other bubbles");
    b.hideFind();
    assert.strictEqual(b.marks().length, 0);
    // Plan find afterwards still scopes to the plan bubble only.
    b.post({ type: "showFindInPlan" });
    typePlanQuery(b, "deploy");
    assert.strictEqual(marksIn(plan).length, 2);
    assert.strictEqual(marksIn(other).length, 0);
  });
});

/* ------------------------------------------------------------------ */
/* GAPS-169 — NF-1: unresolved bubble scope is a NO-MATCH root.        */
/* The plan tray DOES hold chrome text ("Plan ready — review it       */
/* above, then:", "Accept Plan & Build", "Discard", "Copy as          */
/* Markdown"); the binary searching an empty/unresolved plan document  */
/* yields 0 matches, so the fork must never search the tray.           */
/* ------------------------------------------------------------------ */

/** Give the fake #planTray the same chrome text the real markup has. */
function seedTrayChrome(b: Boot): FakeElement {
  const tray = b.el("planTray");
  const line = new FakeElement("div");
  line.appendChild(new FakeText("Plan ready — review it above, then: Accept Plan & Build Discard Copy as Markdown"));
  tray.appendChild(line);
  return tray;
}

describe("find-in-plan — GAPS-169 NF-1 unresolved scope never searches the tray", () => {
  it("no planReady (bubbleId empty): queries matching tray chrome yield 0 matches, no tray highlights", () => {
    const b = boot();
    const tray = seedTrayChrome(b);
    b.post({ type: "showFindInPlan" });
    typePlanQuery(b, "Accept");
    assert.strictEqual(marksIn(tray).length, 0, "tray chrome must not be highlighted");
    assert.strictEqual(b.el("planFindCount").textContent, "0 of 0");
    assert.strictEqual(b.el("planFindNext").disabled, true);
    assert.strictEqual(b.el("planFindPrev").disabled, true);
    typePlanQuery(b, "Copy");
    assert.strictEqual(marksIn(tray).length, 0);
    assert.strictEqual(b.el("planFindCount").textContent, "0 of 0");
  });

  it("bubbleId posted but no such bubble in the DOM: 0 matches, tray untouched", () => {
    const b = boot();
    const tray = seedTrayChrome(b);
    b.post({ type: "planReady", bubbleId: "ghost-plan" });
    b.post({ type: "showFindInPlan" });
    typePlanQuery(b, "Copy");
    assert.strictEqual(marksIn(tray).length, 0);
    assert.strictEqual(b.marks().length, 0);
    assert.strictEqual(b.el("planFindCount").textContent, "0 of 0");
    assert.strictEqual(b.el("planFindNext").disabled, true);
  });

  it("bubble deleted after planReady: scope collapses to no-match (plan text and tray chrome both unsearchable)", () => {
    const { b, plan } = bootWithPlan();
    const tray = seedTrayChrome(b);
    plan.remove();
    b.post({ type: "showFindInPlan" });
    typePlanQuery(b, "deploy");
    assert.strictEqual(b.marks().length, 0);
    assert.strictEqual(b.el("planFindCount").textContent, "0 of 0");
    typePlanQuery(b, "Accept");
    assert.strictEqual(marksIn(tray).length, 0);
    assert.strictEqual(b.el("planFindCount").textContent, "0 of 0");
    assert.strictEqual(b.el("planFindNext").disabled, true);
  });

  it("valid bubbleId still scopes to the bubble (NF-1 fix does not change the resolved path)", () => {
    const { b, plan } = bootWithPlan();
    seedTrayChrome(b);
    b.post({ type: "showFindInPlan" });
    typePlanQuery(b, "deploy");
    assert.strictEqual(marksIn(plan).length, 2);
    assert.strictEqual(b.el("planFindCount").textContent, "1 of 2");
  });
});

/* ------------------------------------------------------------------ */
/* GAPS-169 — NF-2: ldk/Uqp/adk port. (a) adk segments: inside a        */
/* markdown link only the link text is searchable — the URL is         */
/* excluded for EVERY text node, code literals included (binary ldk    */
/* @15057542 applies adk without node-type distinction). (b) Uqp       */
/* advances s = o + 1, so overlapping matches count.                   */
/* ------------------------------------------------------------------ */

function bootWithPlanText(text: string): { b: Boot; plan: FakeElement } {
  const b = boot();
  addBubble(b, "other-1", "unrelated transcript line");
  const plan = addBubble(b, "plan-x", text);
  b.post({ type: "planReady", bubbleId: "plan-x" });
  b.post({ type: "showFindInPlan" });
  return { b, plan };
}

describe("find-in-plan — GAPS-169 NF-2a markdown-link URL exclusion (adk)", () => {
  it("code literal [foo](https://bar): 'bar'/'https' do NOT match the URL, 'foo' matches the link text", () => {
    const { b, plan } = bootWithPlanText("Run [foo](https://bar.example) now");
    typePlanQuery(b, "bar");
    assert.strictEqual(marksIn(plan).length, 0, "binary adk drops the URL from every text node, code included");
    assert.strictEqual(b.el("planFindCount").textContent, "0 of 0");
    typePlanQuery(b, "https");
    assert.strictEqual(marksIn(plan).length, 0);
    typePlanQuery(b, "foo");
    assert.strictEqual(marksIn(plan).length, 1);
    assert.strictEqual(b.el("planFindCount").textContent, "1 of 1");
  });

  it("link text = query counts once, not again inside the URL: [deploy](https://deploy.example) -> 1 match", () => {
    const { b, plan } = bootWithPlanText("See [deploy](https://deploy.example) steps");
    typePlanQuery(b, "deploy");
    assert.strictEqual(marksIn(plan).length, 1);
    assert.strictEqual(b.el("planFindCount").textContent, "1 of 1");
  });

  it("URL with a parenthesised group is still excluded whole: [foo](https://bar.example/a_(b))", () => {
    const { b, plan } = bootWithPlanText("Ref [foo](https://bar.example/a_(b)) tail");
    typePlanQuery(b, "bar");
    assert.strictEqual(marksIn(plan).length, 0);
    typePlanQuery(b, "tail");
    assert.strictEqual(marksIn(plan).length, 1, "text after the link stays searchable");
  });

  it("escaped bracket is NOT a link (JKr lookbehind): the whole literal stays searchable", () => {
    const { b, plan } = bootWithPlanText("Literal \\[foo](https://bar.example) end");
    typePlanQuery(b, "bar");
    assert.strictEqual(marksIn(plan).length, 1);
    assert.strictEqual(b.el("planFindCount").textContent, "1 of 1");
  });

  it("text outside links around a link remains searchable on both sides", () => {
    const { b, plan } = bootWithPlanText("deploy [guide](https://x.example) then deploy again");
    typePlanQuery(b, "deploy");
    assert.strictEqual(marksIn(plan).length, 2);
    assert.strictEqual(b.el("planFindCount").textContent, "1 of 2");
  });
});

describe("find-in-plan — GAPS-169 NF-2b overlapping matches (Uqp s = o + 1)", () => {
  it("'aa' in 'aaa' = 2 matches: label, wrap navigation, full highlight", () => {
    const { b, plan } = bootWithPlanText("aaa");
    typePlanQuery(b, "aa");
    assert.strictEqual(b.el("planFindCount").textContent, "1 of 2", "binary Uqp counts overlapping matches");
    // Crossing intervals cannot each be one <mark>: the highlight is 3
    // atomic segment marks whose union is the whole text.
    const marks = marksIn(plan);
    assert.strictEqual(marks.map((m) => m.textContent).join(""), "aaa");
    assert.strictEqual(marks.length, 3);
    fireOn(b, "planFindInput", "keydown", { key: "Enter" });
    assert.strictEqual(b.el("planFindCount").textContent, "2 of 2");
    fireOn(b, "planFindInput", "keydown", { key: "Enter" });
    assert.strictEqual(b.el("planFindCount").textContent, "1 of 2", "wraps over the match count");
    assert.strictEqual(b.transcriptText(), "unrelated transcript lineaaa", "highlighting preserves the text");
  });

  it("non-overlapping repeated query still counts per occurrence ('aa' in 'aa aa' = 2, one mark each)", () => {
    const { b, plan } = bootWithPlanText("aa aa");
    typePlanQuery(b, "aa");
    assert.strictEqual(marksIn(plan).length, 2);
    assert.strictEqual(b.el("planFindCount").textContent, "1 of 2");
  });

  it("chat find overlap behavior is UNCHANGED (scope decision: binary chat DOM engine JMi is a non-overlapping RegExp exec, not Uqp)", () => {
    const { b } = bootWithPlanText("aaa");
    b.showFind();
    b.typeQuery("aa");
    assert.strictEqual(b.marks().length, 1, "chat find keeps its pre-169 non-overlapping count");
  });
});
