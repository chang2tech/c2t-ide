/**
 * Functional tests for GAPS-3-MODESUI (Task 3 + Task 4).
 *
 * Task 3 — Plan Mode auto-suggest: shouldSuggestPlanMode is an EXACT port
 * of Cursor 3.25.9's composerUtilsService.shouldSuggestPlanMode
 * (workbench.glass.main.js). The keyword list is binary-verbatim
 * (PLAN_MODE_SUGGEST_KEYWORDS, 241 unique, multilingual).
 *
 * Task 4 — status pills above the prompt: visibleComposerPills() is the
 * unit-testable mirror of the webview's renderPills(); per-pill binary
 * evidence (data-component, label, show condition) is documented on the
 * function in components/composer.ts.
 *
 * node:test, zero extra deps. `vscode` is stubbed via Module._load
 * interception (same pattern as run-plan-mode-tests.ts).
 *
 * Run after `tsc`:  node --test out/services/test/run-modesui-tests.js
 */
import { describe, it } from "node:test";
import * as assert from "node:assert";
import Module from "node:module";
import * as vm from "node:vm";

// ---- vscode API stub (test-only, never packaged) ----
class StubEventEmitter<T> {
  private listeners: Array<(e: T) => void> = [];
  get event() {
    return (listener: (e: T) => void) => {
      this.listeners.push(listener);
      return { dispose: () => undefined };
    };
  }
  fire(e: T): void {
    for (const l of [...this.listeners]) l(e);
  }
  dispose(): void {
    this.listeners = [];
  }
}
const vscodeStub = { EventEmitter: StubEventEmitter };
const origLoad = (Module as unknown as { _load: Function })._load;
(Module as unknown as { _load: Function })._load = function (
  request: string,
  ...rest: unknown[]
) {
  if (request === "vscode") return vscodeStub;
  return origLoad.call(this, request, ...rest);
};

import {
  PLAN_MODE_SUGGEST_KEYWORDS,
  shouldSuggestPlanMode,
} from "../modeService";
import {
  createComposer,
  visibleComposerPills,
  ComposerPillState,
} from "../../components/composer";

// ---------------------------------------------------------------------------
// Task 3 — keyword list integrity (binary-verbatim).
// ---------------------------------------------------------------------------
describe("PLAN_MODE_SUGGEST_KEYWORDS (binary-verbatim list)", () => {
  it("has the expected size and no duplicates", () => {
    assert.strictEqual(PLAN_MODE_SUGGEST_KEYWORDS.length, 241);
    assert.strictEqual(new Set(PLAN_MODE_SUGGEST_KEYWORDS).size, 241);
  });

  it("contains the core English complex-task keywords", () => {
    for (const k of [
      "plan",
      "planning",
      "refactor",
      "migrate",
      "restructure",
      "design",
      "architect",
      "blueprint",
      "roadmap",
      "checklist",
      "implementation",
      "acceptance criteria",
      "definition of done",
    ]) {
      assert.ok(PLAN_MODE_SUGGEST_KEYWORDS.includes(k), `missing keyword ${k}`);
    }
  });

  it("is multilingual like the binary (ES/FR/PT/ZH/HI/AR/pinyin/romaji)", () => {
    assert.ok(PLAN_MODE_SUGGEST_KEYWORDS.includes("planificar")); // ES
    assert.ok(PLAN_MODE_SUGGEST_KEYWORDS.includes("planifier")); // FR
    assert.ok(PLAN_MODE_SUGGEST_KEYWORDS.includes("planejar")); // PT
    assert.ok(PLAN_MODE_SUGGEST_KEYWORDS.includes("计划")); // ZH
    assert.ok(PLAN_MODE_SUGGEST_KEYWORDS.includes("jihua")); // pinyin
    assert.ok(PLAN_MODE_SUGGEST_KEYWORDS.includes("keikaku")); // romaji
    assert.ok(PLAN_MODE_SUGGEST_KEYWORDS.includes("योजना")); // HI
    assert.ok(PLAN_MODE_SUGGEST_KEYWORDS.includes("خطة")); // AR
  });

  it("contains NO Vietnamese keywords (binary has none — honest parity)", () => {
    assert.ok(!PLAN_MODE_SUGGEST_KEYWORDS.includes("kế hoạch"));
    assert.ok(!PLAN_MODE_SUGGEST_KEYWORDS.includes("thiết kế"));
  });
});

// ---------------------------------------------------------------------------
// Task 3 — heuristic behavior, incl. differential checks vs the binary logic.
// ---------------------------------------------------------------------------
/** The binary function, transcribed for differential testing. */
function binaryShouldSuggestPlanMode(t: string): boolean {
  if (!t || t.trim().length === 0) return false;
  const kws: ReadonlyArray<string> = PLAN_MODE_SUGGEST_KEYWORDS;
  const r = t.toLowerCase();
  return !!(
    kws.some((l) => r.includes(l)) ||
    (t.match(/[.!?]+/g) || []).length >= 1 ||
    t
      .trim()
      .split(/\s+/)
      .filter((l) => l.length > 0).length >= 35
  );
}

describe("shouldSuggestPlanMode (exact binary port)", () => {
  it("empty / whitespace-only text never suggests", () => {
    assert.strictEqual(shouldSuggestPlanMode(""), false);
    assert.strictEqual(shouldSuggestPlanMode("   "), false);
    assert.strictEqual(shouldSuggestPlanMode("\n\t "), false);
  });

  it("matches keywords case-insensitively by substring", () => {
    assert.strictEqual(shouldSuggestPlanMode("please REFACTOR the auth module"), true);
    assert.strictEqual(shouldSuggestPlanMode("Design a caching layer"), true);
    assert.strictEqual(shouldSuggestPlanMode("help me plan the migration"), true);
    assert.strictEqual(shouldSuggestPlanMode("create a blueprint for payments"), true);
    assert.strictEqual(shouldSuggestPlanMode("viết tài liệu thiết kế hệ thống"), false); // no VI keywords in binary
    assert.strictEqual(shouldSuggestPlanMode("请帮我制定计划"), true); // ZH 计划
  });

  it("fires on a sentence terminator even without keywords (binary rule)", () => {
    assert.strictEqual(shouldSuggestPlanMode("what is this?"), true);
    assert.strictEqual(shouldSuggestPlanMode("fix it now!"), true);
    assert.strictEqual(shouldSuggestPlanMode("update readme."), true);
  });

  it("fires at >= 35 words even without keywords (binary rule)", () => {
    const words35 = Array.from({ length: 35 }, (_, i) => `word${i}`).join(" ");
    const words34 = Array.from({ length: 34 }, (_, i) => `word${i}`).join(" ");
    assert.strictEqual(shouldSuggestPlanMode(words35), true);
    assert.strictEqual(shouldSuggestPlanMode(words34), false);
  });

  it("short plain text without keywords does not suggest", () => {
    assert.strictEqual(shouldSuggestPlanMode("hello"), false);
    assert.strictEqual(shouldSuggestPlanMode("run the tests"), false);
    assert.strictEqual(shouldSuggestPlanMode("show me the file"), false);
  });

  it("matches the binary logic on a differential corpus", () => {
    const corpus = [
      "",
      " ",
      "hi",
      "refactor login",
      "REFACTOR LOGIN",
      "can you design the schema",
      "migrate to postgres",
      "write docs",
      "what?",
      "no way!",
      "v1.2.3",
      "e.g. something",
      Array.from({ length: 34 }, () => "x").join(" "),
      Array.from({ length: 35 }, () => "x").join(" "),
      Array.from({ length: 100 }, () => "x").join(" "),
      "请制定计划",
      "planificar la migración",
      "the roadmap for q4",
      "add a button",
      "specify the api",
      "a  b   c",
    ];
    for (const text of corpus) {
      assert.strictEqual(
        shouldSuggestPlanMode(text),
        binaryShouldSuggestPlanMode(text),
        `divergence on ${JSON.stringify(text)}`,
      );
    }
  });
});

// ---------------------------------------------------------------------------
// Task 4 — pill visibility logic.
// ---------------------------------------------------------------------------
describe("visibleComposerPills (binary-grounded visibility)", () => {
  const empty: ComposerPillState = {
    planPending: false,
    debugReproActive: false,
    canvasActive: false,
    goalActive: false,
    queueCount: 0,
  };

  it("shows no pills when nothing is active", () => {
    assert.deepStrictEqual(visibleComposerPills(empty), []);
  });

  it("queue pill appears iff queueCount > 0", () => {
    assert.deepStrictEqual(visibleComposerPills({ ...empty, queueCount: 3 }), ["queue"]);
    assert.deepStrictEqual(visibleComposerPills({ ...empty, queueCount: 0 }), []);
  });

  it("plan/debug/canvas/goal pills follow their state flags", () => {
    assert.deepStrictEqual(visibleComposerPills({ ...empty, planPending: true }), ["plan"]);
    assert.deepStrictEqual(visibleComposerPills({ ...empty, debugReproActive: true }), ["debug"]);
    assert.deepStrictEqual(visibleComposerPills({ ...empty, canvasActive: true }), ["canvas"]);
    assert.deepStrictEqual(visibleComposerPills({ ...empty, goalActive: true }), ["goal"]);
  });

  it("renders in plan → debug → canvas → goal → queue order", () => {
    assert.deepStrictEqual(
      visibleComposerPills({
        planPending: true,
        debugReproActive: true,
        canvasActive: true,
        goalActive: true,
        queueCount: 2,
      }),
      ["plan", "debug", "canvas", "goal", "queue"],
    );
  });
});

// ---------------------------------------------------------------------------
// Task 3+4 — webview static surface (createComposer output).
// ---------------------------------------------------------------------------
describe("createComposer webview surface (nudge + pills)", () => {
  const html = createComposer({} as never, "agent", true);

  it("contains the plan-nudge banner with Switch/Dismiss", () => {
    assert.ok(html.includes('id="planNudge"'), "planNudge banner missing");
    assert.ok(html.includes('id="planNudgeSwitch"'), "Switch button missing");
    assert.ok(html.includes('id="planNudgeDismiss"'), "Dismiss button missing");
    assert.ok(html.includes("Switch to Plan Mode?"), "nudge text missing");
  });

  it("contains the pills container above the prompt box", () => {
    const pillsIdx = html.indexOf('id="composerPills"');
    const boxIdx = html.indexOf('id="composer"');
    assert.ok(pillsIdx > 0 && boxIdx > 0, "elements missing");
    assert.ok(pillsIdx < boxIdx, "pills container must render above the prompt box");
  });

  it("bakes the binary keyword list into the webview script", () => {
    assert.ok(html.includes('"refactor"'), "keywords not baked");
    assert.ok(html.includes('"acceptance criteria"'), "multi-word keyword not baked");
  });

  it("renders all five binary data-components in the pill renderer", () => {
    for (const dc of [
      "glass-queue-pill",
      "glass-canvas-pill",
      "glass-debug-repro-pill",
      "glass-goal-pill",
      "glass-plan-pill",
    ]) {
      assert.ok(html.includes(dc), `${dc} missing from webview script`);
    }
  });

  it("nudge + pills start hidden (non-blocking)", () => {
    assert.ok(html.includes('id="planNudge" class="plan-nudge" hidden'), "nudge must start hidden");
    assert.ok(
      html.includes('id="composerPills" class="composer-pills" hidden'),
      "pills must start hidden",
    );
  });
});

// ---------------------------------------------------------------------------
// Task 3+4 — webview UI behavior (inline script in node:vm, fake DOM).
// Follows the composer-morph.test.ts pattern: boot the real script, fire
// input/click/message events, assert nudge + pill behavior.
// ---------------------------------------------------------------------------
type Listener = (e?: unknown) => void;

class FakeElement {
  tag: string;
  attrs = new Map<string, string>();
  listeners = new Map<string, Listener[]>();
  children: FakeElement[] = [];
  style: Record<string, (...args: string[]) => void> = {
    setProperty: () => undefined,
    removeProperty: () => undefined,
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
      if (on) this.classes.add(c);
      else this.classes.delete(c);
      return on;
    },
    contains: (c: string): boolean => this.classes.has(c),
  };
  private _innerHTML = "";
  get innerHTML(): string {
    return this._innerHTML;
  }
  set innerHTML(v: string) {
    this._innerHTML = String(v);
    this.children = [];
  }
  textContent = "";
  title = "";
  value = "";
  hidden = false;
  disabled = false;
  selectionStart: number | null = null;
  selectionEnd: number | null = null;
  offsetWidth = 0;

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
  addEventListener(t: string, fn: Listener): void {
    const arr = this.listeners.get(t) ?? [];
    arr.push(fn);
    this.listeners.set(t, arr);
  }
  appendChild(c: FakeElement): FakeElement {
    this.children.push(c);
    return c;
  }
  insertBefore(c: FakeElement, _ref: FakeElement | null): FakeElement {
    this.children.push(c);
    return c;
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
  focus(): void {
    /* noop */
  }
  scrollIntoView(_o?: unknown): void {
    /* noop */
  }
  dispatchEvent(e: { type: string } & Record<string, unknown>): boolean {
    for (const fn of this.listeners.get(e.type) ?? []) fn(e);
    return true;
  }
}

interface UiBoot {
  el: (id: string) => FakeElement;
  posted: unknown[];
  fireInput: (value: string) => void;
  click: (id: string) => void;
  postToWebview: (msg: unknown) => void;
  pillComponents: () => Array<string | null>;
}

function bootWebview(): UiBoot {
  const html = createComposer({} as never, "agent", true);
  const m = html.match(/<script nonce="[^"]*">([\s\S]*?)<\/script>/);
  assert.ok(m && m[1], "inline webview script not found");
  const posted: unknown[] = [];
  const byId = new Map<string, FakeElement>();
  const doc: Record<string, unknown> = {
    body: new FakeElement("body"),
    // Real documents always have <head>; the unread-divider webview script
    // injects its CSS via document.head (ensureCss).
    head: new FakeElement("head"),
    getElementById: (id: string): FakeElement => {
      let e = byId.get(id);
      if (!e) {
        e = new FakeElement("div");
        byId.set(id, e);
      }
      return e;
    },
    createElement: (tag: string): FakeElement => new FakeElement(tag),
    addEventListener: () => undefined,
    querySelector: () => null,
    querySelectorAll: () => [],
  };
  const winListeners = new Map<string, Listener[]>();
  const sandbox: Record<string, unknown> = {
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
  };
  vm.createContext(sandbox);
  vm.runInContext(m[1], sandbox, { filename: "composer-webview.js" });
  /* Mirror the real initial HTML: these elements carry the `hidden`
     attribute at render time; the lazy fake elements default to visible. */
  for (const hid of ["planTray", "debugLogs", "planNudge", "composerPills"]) {
    const he = byId.get(hid);
    if (he) he.hidden = true;
  }
  const el = (id: string): FakeElement => {
    const e = byId.get(id);
    assert.ok(e, `element #${id} was never requested by the webview script`);
    return e as FakeElement;
  };
  const fire = (id: string, type: string, evt: unknown = {}): void => {
    for (const fn of el(id).listeners.get(type) ?? []) fn(evt);
  };
  return {
    el,
    posted,
    fireInput: (value: string): void => {
      el("input").value = value;
      fire("input", "input", { target: el("input") });
    },
    click: (id: string): void => fire(id, "click", {}),
    postToWebview: (msg: unknown): void => {
      for (const fn of winListeners.get("message") ?? []) fn({ data: msg });
    },
    pillComponents: (): Array<string | null> =>
      el("composerPills").children.map((c) => c.getAttribute("data-component")),
  };
}

describe("webview UI behavior (node:vm)", () => {
  it("typing a complex-task keyword shows the plan nudge", () => {
    const b = bootWebview();
    assert.strictEqual(b.el("planNudge").hidden, true, "nudge starts hidden");
    b.fireInput("hello");
    assert.strictEqual(b.el("planNudge").hidden, true, "plain text must not nudge");
    b.fireInput("please refactor the auth module");
    assert.strictEqual(b.el("planNudge").hidden, false, "keyword must show the nudge");
  });

  it("nudge stays hidden in plan mode", () => {
    const b = bootWebview();
    b.postToWebview({ type: "mode", mode: "plan" });
    b.fireInput("please refactor the auth module");
    assert.strictEqual(b.el("planNudge").hidden, true);
  });

  it("nudge only fires before the first human message (binary gate)", () => {
    const b = bootWebview();
    b.postToWebview({
      type: "bubbles",
      bubbles: [{ bubbleId: "b1", role: "human", text: "hi", toolCalls: [] }],
    });
    b.fireInput("please refactor the auth module");
    assert.strictEqual(b.el("planNudge").hidden, true, "must not nudge mid-conversation");
  });

  it("Dismiss hides the nudge for the session; newChat re-arms it", () => {
    const b = bootWebview();
    b.fireInput("design the schema");
    assert.strictEqual(b.el("planNudge").hidden, false);
    b.click("planNudgeDismiss");
    assert.strictEqual(b.el("planNudge").hidden, true);
    b.fireInput("design the schema again");
    assert.strictEqual(b.el("planNudge").hidden, true, "dismissed nudge must not reappear");
    b.postToWebview({ type: "newChat" });
    b.fireInput("design the schema once more");
    assert.strictEqual(b.el("planNudge").hidden, false, "new chat re-arms the nudge");
  });

  it("Switch posts setMode=plan to the host and hides the nudge", () => {
    const b = bootWebview();
    b.fireInput("migrate to postgres");
    b.click("planNudgeSwitch");
    assert.strictEqual(b.el("planNudge").hidden, true);
    const setMode = b.posted.filter(
      (p) => (p as { type?: string }).type === "setMode",
    ) as Array<{ type: string; mode: string }>;
    assert.ok(setMode.length > 0, "Switch must post setMode");
    assert.strictEqual(setMode[setMode.length - 1].mode, "plan");
  });

  it("queue pill renders iff queueCount > 0 (binary: glass-queue-pill)", () => {
    const b = bootWebview();
    assert.deepStrictEqual(b.pillComponents(), [], "no pills initially");
    b.postToWebview({ type: "queue", length: 2, items: [] });
    assert.deepStrictEqual(b.pillComponents(), ["glass-queue-pill"]);
    const pill = b.el("composerPills").children[0];
    assert.strictEqual(pill.getAttribute("aria-label"), "Queued 2");
    const count = pill.children.find((c) => c.textContent === "2");
    assert.ok(count, "count badge must show 2");
    b.postToWebview({ type: "queue", length: 0, items: [] });
    assert.deepStrictEqual(b.pillComponents(), [], "queue pill hides at 0");
  });

  it("debug pill follows debug mode (binary: glass-debug-repro-pill)", () => {
    const b = bootWebview();
    b.postToWebview({ type: "mode", mode: "debug" });
    assert.deepStrictEqual(b.pillComponents(), ["glass-debug-repro-pill"]);
    b.postToWebview({ type: "mode", mode: "agent" });
    assert.deepStrictEqual(b.pillComponents(), []);
  });

  it("plan pill follows the pending plan tray (binary: glass-plan-pill)", () => {
    const b = bootWebview();
    b.postToWebview({ type: "planReady" });
    assert.deepStrictEqual(b.pillComponents(), ["glass-plan-pill"]);
    b.postToWebview({ type: "planCleared" });
    assert.deepStrictEqual(b.pillComponents(), []);
  });

  it("canvas + goal pills follow host state (binary: glass-canvas-pill / glass-goal-pill)", () => {
    const b = bootWebview();
    b.postToWebview({ type: "canvasState", canvas: { path: "/tmp/plan.md", label: "plan.md" } });
    b.postToWebview({ type: "goalState", goal: { objective: "Ship v2", paused: false } });
    assert.deepStrictEqual(b.pillComponents(), ["glass-canvas-pill", "glass-goal-pill"]);
    b.postToWebview({ type: "canvasState", canvas: null });
    assert.deepStrictEqual(b.pillComponents(), ["glass-goal-pill"]);
    b.postToWebview({ type: "goalState", goal: null });
    assert.deepStrictEqual(b.pillComponents(), []);
  });

  it("pills render in plan → debug → canvas → goal → queue order", () => {
    const b = bootWebview();
    b.postToWebview({ type: "queue", length: 1, items: [] });
    b.postToWebview({ type: "goalState", goal: { objective: "Ship v2", paused: false } });
    b.postToWebview({ type: "canvasState", canvas: { path: "/tmp/a.md", label: "a" } });
    b.postToWebview({ type: "mode", mode: "debug" });
    b.postToWebview({ type: "planReady" });
    assert.deepStrictEqual(b.pillComponents(), [
      "glass-plan-pill",
      "glass-debug-repro-pill",
      "glass-canvas-pill",
      "glass-goal-pill",
      "glass-queue-pill",
    ]);
  });
});
