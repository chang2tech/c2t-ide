/**
 * "Run on" picker tests (cloud-run-on-picker — P1, node:test, zero extra deps).
 *
 * Evidence (Cursor 3.25.9 live CDP, DETAIL-CHAT §7, verbatim DOM): the Agents
 * window header has an IDE/Cloud tab switcher — `SPAN "IDE"` in `BUTTON`,
 * `SPAN "Cloud"`; clicking `Cloud` shows a section "Run on" with 3 options
 * (`Cloud` / `This Computer` / `Remote Machine`) plus the text
 * "Cloud agents work from a clone of your repo in a secure sandbox.";
 * clicking `IDE` returns the composer to normal. Binary confirms: `grep -o
 * "Run on"` and `grep -o "Remote Machine"` both hit in
 * `workbench.glass.main.js`.
 *
 * Strategy: createComposer() returns the full webview HTML. The test asserts
 * the static initial markup (all labels verbatim), then extracts the inline
 * <script> and runs it in node:vm against a minimal fake DOM, firing the
 * same clicks the real webview would produce.
 *
 * HONEST DIVERGENCE (documented in composer.ts): "Cloud" and "Remote
 * Machine" have no backend infra in this build, so picking one does NOT
 * fake a cloud run — it shows a plain-language unavailable notice and the
 * effective target stays "This Computer" (the only option that can execute).
 *
 * Run after `tsc`:  node out/components/run-on-picker.test.js
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
/* Minimal fake DOM — just enough for the run-on picker's inline code.  */
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
  className = "";
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
  hasAttribute(k: string): boolean {
    return this.attrs.has(k);
  }
  addEventListener(t: string, fn: Listener): void {
    const arr = this.listeners.get(t) ?? [];
    arr.push(fn);
    this.listeners.set(t, arr);
  }
  appendChild(c: FakeElement): FakeElement {
    this.children.push(c);
    return c;
  }
  querySelector(_s: string): FakeElement | null {
    return null;
  }
  querySelectorAll(_s: string): FakeElement[] {
    return [];
  }
  click(): void {
    for (const fn of this.listeners.get("click") ?? []) {
      fn({});
    }
  }
}

interface Boot {
  el: (id: string) => FakeElement;
  option: (runOn: string) => FakeElement;
  click: (e: FakeElement) => void;
}

let INLINE_SCRIPT = "";

function extractInlineScript(html: string): string {
  const m = html.match(/<script nonce="[^"]*">([\s\S]*?)<\/script>/);
  assert.ok(m && m[1], "inline webview script not found in createComposer HTML");
  return m[1];
}

function makeOption(runOn: string, selected: boolean): FakeElement {
  const e = new FakeElement("button");
  e.className = selected ? "run-on-option selected" : "run-on-option";
  e.setAttribute("data-runon", runOn);
  e.setAttribute("role", "radio");
  e.setAttribute("aria-checked", String(selected));
  return e;
}

function boot(): Boot {
  const byId = new Map<string, FakeElement>();

  // Pre-register the run-on picker elements with the SAME initial state the
  // baked HTML carries, so behavior assertions start from reality.
  const runEnvIde = new FakeElement("button");
  runEnvIde.className = "run-env-btn active";
  runEnvIde.setAttribute("aria-pressed", "true");
  const runEnvCloud = new FakeElement("button");
  runEnvCloud.className = "run-env-btn";
  runEnvCloud.setAttribute("aria-pressed", "false");
  const runOnSection = new FakeElement("section");
  runOnSection.hidden = true;
  const runOnUnavailable = new FakeElement("div");
  runOnUnavailable.hidden = true;
  byId.set("runEnvIde", runEnvIde);
  byId.set("runEnvCloud", runEnvCloud);
  byId.set("runOnSection", runOnSection);
  byId.set("runOnUnavailable", runOnUnavailable);
  const options = [
    makeOption("cloud", false),
    makeOption("this-computer", true),
    makeOption("remote-machine", false),
  ];

  const doc: any = {
    activeElement: null,
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
    querySelectorAll: (s: string): FakeElement[] =>
      s === ".run-on-option" ? options : [],
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
      postMessage: (_msg: unknown): void => {
        /* not exercised by the run-on picker */
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
    assert.ok(e, `element #${id} was never registered`);
    return e as FakeElement;
  };
  return {
    el,
    option: (runOn: string): FakeElement => {
      const o = options.find((x) => x.getAttribute("data-runon") === runOn);
      assert.ok(o, `run-on option ${runOn} missing`);
      return o as FakeElement;
    },
    click: (e: FakeElement): void => e.click(),
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
    "auto",
  );
  INLINE_SCRIPT = extractInlineScript(HTML);
});

/* ------------------------------------------------------------------ */

describe("run-on picker — static markup (cloud-run-on-picker P1)", () => {
  it("renders the IDE/Cloud switcher as BUTTONs with SPAN \"IDE\" / SPAN \"Cloud\" (verbatim DETAIL-CHAT §7)", () => {
    assert.match(
      HTML,
      /<button class="run-env-btn active" id="runEnvIde" aria-pressed="true"><span>IDE<\/span><\/button>/,
      "IDE tab: button with verbatim SPAN 'IDE'",
    );
    assert.match(
      HTML,
      /<button class="run-env-btn" id="runEnvCloud" aria-pressed="false"><span>Cloud<\/span><\/button>/,
      "Cloud tab: button with verbatim SPAN 'Cloud'",
    );
  });

  it("renders the \"Run on\" section hidden with the 3 verbatim options", () => {
    assert.match(
      HTML,
      /<section id="runOnSection" class="run-on-section" hidden aria-label="Run on">/,
      "'Run on' section starts hidden",
    );
    assert.match(HTML, /<div class="run-on-title">Run on<\/div>/, "'Run on' heading verbatim");
    assert.match(
      HTML,
      /<button class="run-on-option" data-runon="cloud"[^>]*><span>Cloud<\/span><\/button>/,
      "option 'Cloud' verbatim",
    );
    assert.match(
      HTML,
      /<button class="run-on-option selected" data-runon="this-computer"[^>]*><span>This Computer<\/span><\/button>/,
      "option 'This Computer' verbatim and pre-selected",
    );
    assert.match(
      HTML,
      /<button class="run-on-option" data-runon="remote-machine"[^>]*><span>Remote Machine<\/span><\/button>/,
      "option 'Remote Machine' verbatim",
    );
  });

  it("renders Cursor's verbatim sandbox description", () => {
    assert.ok(
      HTML.includes("Cloud agents work from a clone of your repo in a secure sandbox."),
      "description must be verbatim: 'Cloud agents work from a clone of your repo in a secure sandbox.'",
    );
  });
});

describe("run-on picker — behavior", () => {
  it("starts on the IDE tab with the Run-on section hidden", () => {
    const b = boot();
    assert.strictEqual(b.el("runEnvIde").className, "run-env-btn active");
    assert.strictEqual(b.el("runEnvCloud").className, "run-env-btn");
    assert.strictEqual(b.el("runOnSection").hidden, true);
    assert.strictEqual(b.option("this-computer").className, "run-on-option selected");
  });

  it("clicking Cloud shows the Run-on section; clicking IDE hides it again (DETAIL-CHAT §7)", () => {
    const b = boot();
    b.click(b.el("runEnvCloud"));
    assert.strictEqual(b.el("runOnSection").hidden, false, "Cloud tab reveals the section");
    assert.strictEqual(b.el("runEnvCloud").getAttribute("aria-pressed"), "true");
    b.click(b.el("runEnvIde"));
    assert.strictEqual(b.el("runOnSection").hidden, true, "IDE tab hides the section");
    assert.strictEqual(b.el("runEnvIde").getAttribute("aria-pressed"), "true");
  });

  it("selecting 'This Computer' selects it and clears any unavailable notice", () => {
    const b = boot();
    b.click(b.option("this-computer"));
    assert.strictEqual(b.option("this-computer").getAttribute("aria-checked"), "true");
    assert.strictEqual(b.el("runOnUnavailable").hidden, true);
  });

  it("selecting 'Cloud' reports it is NOT supported instead of faking a cloud run (honest divergence)", () => {
    const b = boot();
    b.click(b.option("cloud"));
    const notice = b.el("runOnUnavailable");
    assert.strictEqual(notice.hidden, false, "unavailable notice must be shown");
    assert.ok(
      notice.textContent.includes("not available in this build"),
      `notice must say 'not available in this build', got: ${notice.textContent}`,
    );
    assert.ok(
      notice.textContent.includes("This Computer"),
      "notice must say the run stays on This Computer",
    );
    assert.strictEqual(
      b.option("cloud").getAttribute("aria-checked"),
      "false",
      "Cloud must NOT become the selected target — no fake cloud run",
    );
    assert.strictEqual(
      b.option("this-computer").getAttribute("aria-checked"),
      "true",
      "effective target stays 'This Computer'",
    );
  });

  it("selecting 'Remote Machine' reports it is NOT supported likewise", () => {
    const b = boot();
    b.click(b.option("remote-machine"));
    const notice = b.el("runOnUnavailable");
    assert.strictEqual(notice.hidden, false, "unavailable notice must be shown");
    assert.ok(
      notice.textContent.includes("not available in this build"),
      `notice must say 'not available in this build', got: ${notice.textContent}`,
    );
    assert.strictEqual(
      b.option("remote-machine").getAttribute("aria-checked"),
      "false",
      "Remote Machine must NOT become the selected target",
    );
    assert.strictEqual(b.option("this-computer").getAttribute("aria-checked"), "true");
  });
});
