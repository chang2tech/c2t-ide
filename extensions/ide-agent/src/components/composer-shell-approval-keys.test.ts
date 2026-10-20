/**
 * Approval-card keyboard flow webview tests (GAPS-14 — node:test, zero extra deps).
 *
 * Cursor 3.25.6 binary: the shell-tool approval card answers Enter (run) /
 * Shift+Enter (run + allowlist) / Esc (skip) — dispatched through
 * keybindingService.softDispatch when the terminal notification card has
 * focus. Our approval card is a webview (the workbench keybinding service
 * never sees webview keystrokes), so the same flow lives on the card
 * itself (components/composer.ts). These tests pin it:
 *  - Enter -> approvalResolve approve-once
 *  - Shift+Enter -> approvalResolve approve-allowlist
 *  - Escape -> approvalResolve skip
 *  - keys are ignored when the request does not offer that option id
 *    (non-shell approval kinds), when a button has focus (native click
 *    wins), after the card is cleared, and for unrelated keys.
 *
 * Strategy (same as composer-find.test.ts): createComposer() returns the
 * full webview HTML; extract the inline <script> and run it in node:vm
 * against a minimal fake DOM, then drive {type:'approval'} messages and
 * keydown events on #approvalCard.
 *
 * Run after `tsc`:  node out/components/composer-shell-approval-keys.test.js
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

interface ApprovalBoot {
  el: (id: string) => FakeElement;
  posted: unknown[];
  postApproval: (request: unknown) => void;
  cardKeydown: (e: Record<string, unknown>, target?: FakeElement) => Record<string, unknown>;
  firstButton: () => FakeElement | null;
}

let INLINE_SCRIPT = "";

function extractInlineScript(html: string): string {
  const m = html.match(/<script nonce="[^"]*">([\s\S]*?)<\/script>/);
  assert.ok(m && m[1], "inline webview script not found in createComposer HTML");
  return m[1];
}

function boot(): ApprovalBoot {
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
  const fireKeydown = (
    target: FakeElement,
    e: Record<string, unknown>,
  ): Record<string, unknown> => {
    const evt: Record<string, unknown> = {
      target,
      preventDefault: (): void => {
        evt.defaultPrevented = true;
      },
      defaultPrevented: false,
      ...e,
    };
    for (const fn of target.listeners.get("keydown") ?? []) {
      fn(evt);
    }
    return evt;
  };
  return {
    el,
    posted,
    postApproval: (request: unknown): void => postToWebview({ type: "approval", request }),
    cardKeydown: (e, target): Record<string, unknown> =>
      fireKeydown(target ?? el("approvalCard"), e),
    firstButton: (): FakeElement | null => {
      const walk = (n: FakeElement): FakeElement | null => {
        if (n.tagName === "BUTTON") {
          return n;
        }
        for (const c of n.children) {
          if (c instanceof FakeElement) {
            const f = walk(c);
            if (f) {
              return f;
            }
          }
        }
        return null;
      };
      return walk(el("approvalCard"));
    },
  };
}

let HTML = "";

before(() => {
  HTML = createComposer({} as never, "agent" as ModeName, false, "en", "ltr", "auto");
  INLINE_SCRIPT = extractInlineScript(HTML);
});

const SHELL_OPTIONS = [
  { id: "approve-once", label: "Approve once" },
  { id: "approve-allowlist", label: "Approve and allowlist" },
  { id: "skip", label: "Skip" },
];

function shellRequest() {
  return {
    approvalId: "approval-9",
    toolCallId: "tc-1",
    title: "rm -rf /tmp/x",
    reasons: ["destructive command"],
    options: SHELL_OPTIONS,
  };
}

/**
 * Only the approvalResolve messages the card posts (boot may post others).
 * JSON round-trip: messages are created inside the node:vm sandbox realm,
 * whose Object prototype differs from this realm's — deepStrictEqual would
 * fail on prototype mismatch without the normalization.
 */
function resolves(b: ApprovalBoot): unknown[] {
  return b.posted
    .filter(
      (p) =>
        typeof p === "object" && p !== null && (p as { type?: unknown }).type === "approvalResolve",
    )
    .map((p) => JSON.parse(JSON.stringify(p)));
}

describe("approval card keyboard flow — GAPS-14 (Cursor 3.25.6 parity)", () => {
  it("Enter resolves approve-once", () => {
    const b = boot();
    b.postApproval(shellRequest());
    const evt = b.cardKeydown({ key: "Enter" });
    assert.strictEqual(evt.defaultPrevented, true);
    assert.deepStrictEqual(resolves(b), [
      { type: "approvalResolve", approvalId: "approval-9", optionId: "approve-once" },
    ]);
  });

  it("Shift+Enter resolves approve-allowlist", () => {
    const b = boot();
    b.postApproval(shellRequest());
    b.cardKeydown({ key: "Enter", shiftKey: true });
    assert.deepStrictEqual(resolves(b), [
      { type: "approvalResolve", approvalId: "approval-9", optionId: "approve-allowlist" },
    ]);
  });

  it("Escape resolves skip", () => {
    const b = boot();
    b.postApproval(shellRequest());
    b.cardKeydown({ key: "Escape" });
    assert.deepStrictEqual(resolves(b), [
      { type: "approvalResolve", approvalId: "approval-9", optionId: "skip" },
    ]);
  });

  it("ignores keys the request does not offer (non-shell approval kinds)", () => {
    const b = boot();
    b.postApproval({
      approvalId: "approval-10",
      toolCallId: "tc-2",
      title: "edit a.ts",
      reasons: [],
      options: [
        { id: "accept", label: "Accept" },
        { id: "reject", label: "Reject" },
      ],
    });
    b.cardKeydown({ key: "Enter" });
    b.cardKeydown({ key: "Enter", shiftKey: true });
    b.cardKeydown({ key: "Escape" });
    assert.deepStrictEqual(resolves(b), []);
  });

  it("does not double-resolve when a button has focus (native click wins)", () => {
    const b = boot();
    b.postApproval(shellRequest());
    const btn = b.firstButton();
    assert.ok(btn, "approval card renders option buttons");
    b.cardKeydown({ key: "Enter" }, btn as FakeElement);
    assert.deepStrictEqual(resolves(b), []);
  });

  it("does nothing after the card is cleared", () => {
    const b = boot();
    b.postApproval(shellRequest());
    b.postApproval(null); // {type:'approval', request:null} -> clearApproval
    b.cardKeydown({ key: "Enter" });
    b.cardKeydown({ key: "Escape" });
    assert.deepStrictEqual(resolves(b), []);
  });

  it("unrelated keys are ignored", () => {
    const b = boot();
    b.postApproval(shellRequest());
    b.cardKeydown({ key: "Tab" });
    b.cardKeydown({ key: "a" });
    assert.deepStrictEqual(resolves(b), []);
  });
});
