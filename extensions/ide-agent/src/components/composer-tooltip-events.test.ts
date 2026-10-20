/**
 * GAPS-176 — composer webview tooltip-pipeline producers.
 *
 * Strategy (same as composer-add-context.test.ts): createComposer()
 * returns the full webview HTML; run the inline <script> in node:vm
 * against a minimal fake DOM and drive the real listeners.
 *
 * Covered producers (event names verbatim from Cursor 3.25.9's
 * tooltipPipelines config — work-notes-gaps176.md Slice 1):
 *  - `chat.type`: ONLY for trusted input events that are not paste/drop
 *    insertions (a paste must not double-report as type).
 *  - `chat.paste`: exactly once per paste event on the chat input.
 *  - `chat.copy.codeblock.manual`: only when the copy selection anchor
 *    is inside a `pre.md-code` transcript codeblock.
 *  - `chat.insert_selection.editor.non_empty` /
 *    `chat.insert_selection.terminal.empty`: only when an
 *    `addSelectionContext` host message carrying `tooltipInsertSource`
 *    actually inserts a chip — a deduped re-attach emits nothing, and
 *    untagged attaches (programmatic paths) emit nothing.
 *
 * Run after `tsc`:  node out/components/composer-tooltip-events.test.js
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
/* Minimal fake DOM (trimmed from composer-add-context.test.ts).       */
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
  }
  textContent = "";
  title = "";
  value = "";
  hidden = false;
  open = false;
  disabled = false;
  readOnly = false;
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
  querySelectorAll(s: string): FakeElement[] {
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
  tooltipEvents: () => string[];
  fireInput: (evt: Record<string, unknown>) => void;
  firePaste: (clipboardData: unknown) => void;
  fireCopyWithAnchor: (anchorNode: unknown) => void;
  postToWebview: (msg: unknown) => void;
}

let INLINE_SCRIPT = "";

function extractInlineScript(html: string): string {
  const m = html.match(/<script nonce="[^"]*">([\s\S]*?)<\/script>/);
  assert.ok(m && m[1], "inline webview script not found in createComposer HTML");
  return m[1];
}

function boot(): Boot {
  const posted: Array<{ type?: string; event?: string }> = [];
  const byId = new Map<string, FakeElement>();
  const docListeners = new Map<string, Listener[]>();
  let selection: unknown = null;
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
    addEventListener: (t: string, fn: Listener): void => {
      const arr = docListeners.get(t) ?? [];
      arr.push(fn);
      docListeners.set(t, arr);
    },
    querySelector: (_s: string): null => null,
    querySelectorAll: (_s: string): FakeElement[] => [],
    getSelection: (): unknown => selection,
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
        posted.push(msg as { type?: string; event?: string });
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
  const fire = (target: FakeElement, type: string, evt: Record<string, unknown>): void => {
    for (const fn of target.listeners.get(type) ?? []) {
      fn(evt);
    }
  };
  return {
    el,
    tooltipEvents: (): string[] =>
      posted.filter((m) => m.type === "tooltipEvent").map((m) => String(m.event)),
    fireInput: (evt: Record<string, unknown>): void => {
      fire(el("input"), "input", evt);
    },
    firePaste: (clipboardData: unknown): void => {
      fire(el("input"), "paste", {
        clipboardData,
        preventDefault: (): void => {
          /* noop */
        },
      });
    },
    fireCopyWithAnchor: (anchorNode: unknown): void => {
      selection = anchorNode ? { anchorNode } : null;
      for (const fn of docListeners.get("copy") ?? []) {
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

before(() => {
  const html = createComposer(
    {} as never,
    "agent" as ModeName,
    false,
    "en",
    "ltr",
    "Auto",
  );
  INLINE_SCRIPT = extractInlineScript(html);
});

describe("composer tooltip producers (GAPS-176)", () => {
  it("inline webview script parses as valid JS", () => {
    assert.doesNotThrow(() => new vm.Script(INLINE_SCRIPT, { filename: "composer-webview.js" }));
  });

  it("chat.type fires once for a trusted typing input event", () => {
    const b = boot();
    b.fireInput({ isTrusted: true, inputType: "insertText" });
    assert.deepEqual(b.tooltipEvents(), ["chat.type"]);
  });

  it("chat.type does NOT fire for the paste handler's synthetic input event", () => {
    const b = boot();
    b.fireInput({ isTrusted: false, inputType: "insertText" });
    b.fireInput({}); // synthetic Event('input') carries neither flag
    assert.deepEqual(b.tooltipEvents(), []);
  });

  it("chat.type does NOT fire for paste/drop insertions (1 action = 1 event)", () => {
    const b = boot();
    b.fireInput({ isTrusted: true, inputType: "insertFromPaste" });
    b.fireInput({ isTrusted: true, inputType: "insertFromDrop" });
    assert.deepEqual(b.tooltipEvents(), []);
  });

  it("chat.paste fires exactly once per paste event on the chat input", () => {
    const b = boot();
    const cd = { getData: (t: string): string => (t === "text/plain" ? "hello world" : "") };
    b.firePaste(cd);
    assert.deepEqual(b.tooltipEvents(), ["chat.paste"]);
  });

  it("chat.paste does NOT fire when the paste event has no clipboardData", () => {
    const b = boot();
    b.firePaste(null);
    assert.deepEqual(b.tooltipEvents(), []);
  });

  it("chat.copy.codeblock.manual fires when the copy anchor is inside pre.md-code", () => {
    const b = boot();
    const pre: Record<string, unknown> = { nodeType: 1 };
    pre.closest = (s: string): unknown => (s === "pre.md-code" ? pre : null);
    b.fireCopyWithAnchor({ nodeType: 3, parentElement: pre });
    assert.deepEqual(b.tooltipEvents(), ["chat.copy.codeblock.manual"]);
  });

  it("chat.copy.codeblock.manual does NOT fire for a copy outside a codeblock", () => {
    const b = boot();
    const div: Record<string, unknown> = { nodeType: 1, closest: (): unknown => null };
    b.fireCopyWithAnchor({ nodeType: 3, parentElement: div });
    b.fireCopyWithAnchor(null);
    assert.deepEqual(b.tooltipEvents(), []);
  });

  it("insert_selection: editor chip insertion emits editor.non_empty exactly once; a deduped re-attach emits nothing", () => {
    const b = boot();
    const msg = {
      type: "addSelectionContext",
      label: "selection:proj/a.ts:5",
      content: "const x = 1;",
      tooltipInsertSource: "editor",
    };
    b.postToWebview(msg);
    assert.deepEqual(b.tooltipEvents(), ["chat.insert_selection.editor.non_empty"]);
    b.postToWebview(msg); // same label — webview dedups the chip
    assert.deepEqual(b.tooltipEvents(), ["chat.insert_selection.editor.non_empty"]);
  });

  it("insert_selection: terminal chip insertion emits terminal.empty", () => {
    const b = boot();
    b.postToWebview({
      type: "addSelectionContext",
      label: "terminal selection",
      content: "$ ls",
      tooltipInsertSource: "terminal",
    });
    assert.deepEqual(b.tooltipEvents(), ["chat.insert_selection.terminal.empty"]);
  });

  it("insert_selection: an untagged addSelectionContext (programmatic attach) emits nothing", () => {
    const b = boot();
    b.postToWebview({
      type: "addSelectionContext",
      label: "selection:proj/b.ts:1",
      content: "const y = 2;",
    });
    assert.deepEqual(b.tooltipEvents(), []);
  });
});
