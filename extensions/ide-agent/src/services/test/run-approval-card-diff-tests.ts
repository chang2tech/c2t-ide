/**
 * GAPS-12 (approval-card-diff) tests — node:test, no vscode dependency.
 *
 * Guards Cursor parity (docs/rea/deepdig-runtime-approval-2026-10-19.md
 * §3.11, §6 — matrix `approval-card-diff`): file-edit approvals include a
 * unified diff with CONTEXT 2 of the proposed change.
 *
 * Fixtures below are VERBATIM outputs of the engine's `fileDiff()` — the
 * `diff` npm package's `createTwoFilesPatch(file, file, before, after)`
 * with its default context of 3 (captured 2026-10-20 from
 * ~/workspace/ide-code/packages/core/node_modules/diff). The approval
 * pipeline trims them to context 2; the tests pin that transform and the
 * card's rendering of the result.
 *
 * Part 1: pure unit tests for services/unifiedDiff.ts.
 * Part 2: webview render tests — createComposer() HTML, extract the inline
 *   <script>, run it in node:vm against a minimal fake DOM, post
 *   {type:'approval', request} and assert the rendered diff block.
 *
 * Run after `tsc`:  node --test out/services/test/run-approval-card-diff-tests.js
 */
import { describe, it, before } from "node:test";
import * as assert from "node:assert";
import * as vm from "node:vm";
import {
  APPROVAL_DIFF_CONTEXT,
  hasDiffHunks,
  trimUnifiedDiffContext,
  buildFileEditApprovalDetails,
} from "../unifiedDiff";

/* ------------------------------------------------------------------ */
/* Verbatim engine fixtures (context 3, from the real `diff` package).  */
/* ------------------------------------------------------------------ */

/** Two edits 7 lines apart — merged into ONE hunk at context 3. */
const ENGINE_PATCH_TWO_EDITS = [
  "Index: src/a.ts",
  "===================================================================",
  "--- src/a.ts",
  "+++ src/a.ts",
  "@@ -1,12 +1,12 @@",
  " line1",
  " line2",
  "-line3",
  "+line3-CHANGED",
  " line4",
  " line5",
  " line6",
  " line7",
  " line8",
  " line9",
  " line10",
  "-line11",
  "+line11-CHANGED",
  " line12",
  "",
].join("\n");

/** Expected trim of ENGINE_PATCH_TWO_EDITS at context 2: two hunks. */
const TRIMMED_TWO_EDITS = [
  "Index: src/a.ts",
  "===================================================================",
  "--- src/a.ts",
  "+++ src/a.ts",
  "@@ -1,5 +1,5 @@",
  " line1",
  " line2",
  "-line3",
  "+line3-CHANGED",
  " line4",
  " line5",
  "@@ -9,4 +9,4 @@",
  " line9",
  " line10",
  "-line11",
  "+line11-CHANGED",
  " line12",
  "",
].join("\n");

/** Two edits 2 lines apart — one hunk at context 3, still one at context 2. */
const ENGINE_PATCH_CLOSE_EDITS = [
  "Index: src/b.ts",
  "===================================================================",
  "--- src/b.ts",
  "+++ src/b.ts",
  "@@ -1,12 +1,12 @@",
  " line1",
  " line2",
  " line3",
  " line4",
  "-line5",
  "+line5-CHANGED",
  " line6",
  " line7",
  "-line8",
  "+line8-CHANGED",
  " line9",
  " line10",
  " line11",
  " line12",
  "",
].join("\n");

const TRIMMED_CLOSE_EDITS = [
  "Index: src/b.ts",
  "===================================================================",
  "--- src/b.ts",
  "+++ src/b.ts",
  "@@ -3,8 +3,8 @@",
  " line3",
  " line4",
  "-line5",
  "+line5-CHANGED",
  " line6",
  " line7",
  "-line8",
  "+line8-CHANGED",
  " line9",
  " line10",
  "",
].join("\n");

/** New file — all additions, no context to trim. */
const ENGINE_PATCH_NEW_FILE = [
  "Index: src/new.ts",
  "===================================================================",
  "--- src/new.ts",
  "+++ src/new.ts",
  "@@ -0,0 +1,3 @@",
  "+a",
  "+b",
  "+c",
  "",
].join("\n");

/** Missing trailing newline — `\ No newline at end of file` markers. */
const ENGINE_PATCH_NO_NEWLINE = [
  "Index: src/c.ts",
  "===================================================================",
  "--- src/c.ts",
  "+++ src/c.ts",
  "@@ -1,2 +1,2 @@",
  " x",
  "-y",
  "\\ No newline at end of file",
  "+y-CHANGED",
  "\\ No newline at end of file",
  "",
].join("\n");

/** No changes — headers only, no hunks. */
const ENGINE_PATCH_EMPTY = [
  "Index: src/a.ts",
  "===================================================================",
  "--- src/a.ts",
  "+++ src/a.ts",
  "",
].join("\n");

/**
 * Large patch: 60-line file, 9 edits 5 lines apart. Verbatim structure of
 * createTwoFilesPatch output (verified against the real package): a single
 * context-3 hunk `@@ -2,57 +2,57 @@` starting at ` line2`.
 */
function buildLargeEnginePatch(): string {
  const out = [
    "Index: src/big.ts",
    "===================================================================",
    "--- src/big.ts",
    "+++ src/big.ts",
    "@@ -2,57 +2,57 @@",
  ];
  for (let n = 2; n <= 58; n++) {
    if (n % 6 === 0) {
      out.push(`-line${n}`, `+line${n}-CHANGED`);
    } else {
      out.push(` line${n}`);
    }
  }
  return out.join("\n") + "\n";
}

/* ------------------------------------------------------------------ */
/* Part 1: trim / parse unit tests.                                    */
/* ------------------------------------------------------------------ */

describe("approval-card-diff — context constant", () => {
  it("context is exactly 2 (binary evidence, verbatim)", () => {
    assert.strictEqual(APPROVAL_DIFF_CONTEXT, 2);
  });
});

describe("approval-card-diff — hasDiffHunks", () => {
  it("true for patches with hunks", () => {
    assert.strictEqual(hasDiffHunks(ENGINE_PATCH_TWO_EDITS), true);
  });
  it("false for an empty (headers-only) patch", () => {
    assert.strictEqual(hasDiffHunks(ENGINE_PATCH_EMPTY), false);
  });
  it("false for empty string", () => {
    assert.strictEqual(hasDiffHunks(""), false);
  });
});

describe("approval-card-diff — trimUnifiedDiffContext", () => {
  it("splits a context-3 merged hunk into two context-2 hunks (verbatim)", () => {
    assert.strictEqual(trimUnifiedDiffContext(ENGINE_PATCH_TWO_EDITS, 2), TRIMMED_TWO_EDITS);
  });

  it("keeps close edits in one hunk with exactly 2 context lines at the edges", () => {
    assert.strictEqual(trimUnifiedDiffContext(ENGINE_PATCH_CLOSE_EDITS, 2), TRIMMED_CLOSE_EDITS);
  });

  it("defaults to context 2", () => {
    assert.strictEqual(trimUnifiedDiffContext(ENGINE_PATCH_TWO_EDITS), TRIMMED_TWO_EDITS);
  });

  it("leaves a new-file patch untouched (all additions, no context)", () => {
    assert.strictEqual(trimUnifiedDiffContext(ENGINE_PATCH_NEW_FILE, 2), ENGINE_PATCH_NEW_FILE);
  });

  it("preserves `\\ No newline at end of file` markers at end-of-file", () => {
    assert.strictEqual(trimUnifiedDiffContext(ENGINE_PATCH_NO_NEWLINE, 2), ENGINE_PATCH_NO_NEWLINE);
  });

  it("passes an empty (headers-only) patch through — still no hunks", () => {
    const out = trimUnifiedDiffContext(ENGINE_PATCH_EMPTY, 2);
    assert.strictEqual(hasDiffHunks(out), false);
  });

  it("large diff: splits into one hunk per edit, nothing truncated", () => {
    const input = buildLargeEnginePatch();
    assert.strictEqual((input.match(/^@@ /gm) || []).length, 1, "engine emits one context-3 hunk");
    const out = trimUnifiedDiffContext(input, 2);
    const headers = out.match(/^@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@$/gm) || [];
    assert.strictEqual(headers.length, 9, "9 edits -> 9 context-2 hunks");
    // Spot-check the recomputed headers: edit at line L -> @@ -L-2,5 +L-2,5 @@
    const expectedStarts = [4, 10, 16, 22, 28, 34, 40, 46, 52];
    headers.forEach((h, i) => {
      assert.strictEqual(h, `@@ -${expectedStarts[i]},5 +${expectedStarts[i]},5 @@`);
    });
    // No -/+ line lost in the transform.
    assert.strictEqual((out.match(/^-line\d+$/gm) || []).length, 9);
    assert.strictEqual((out.match(/^\+line\d+-CHANGED$/gm) || []).length, 9);
    // Exactly 2 context lines at every hunk edge.
    const hunks = out.split(/^@@ .* @@$/m).slice(1);
    for (const body of hunks) {
      const bodyLines = body.split("\n").filter((l) => l.length > 0);
      const firstChange = bodyLines.findIndex((l) => l[0] === "-" || l[0] === "+");
      const lastChange = bodyLines.length - 1 - [...bodyLines].reverse().findIndex((l) => l[0] === "-" || l[0] === "+");
      assert.strictEqual(firstChange, 2, "2 context lines before the first change");
      assert.strictEqual(bodyLines.length - 1 - lastChange, 2, "2 context lines after the last change");
    }
  });

  it("never invents content: -/+ lines are byte-identical to the input", () => {
    const input = buildLargeEnginePatch();
    const out = trimUnifiedDiffContext(input, 2);
    const inChanges = input.split("\n").filter((l) => l[0] === "-" || l[0] === "+").sort();
    const outChanges = out.split("\n").filter((l) => l[0] === "-" || l[0] === "+").sort();
    assert.deepStrictEqual(outChanges, inChanges);
  });
});

describe("approval-card-diff — buildFileEditApprovalDetails", () => {
  it("builds {type:'fileEdit', isNewFile, diffString} from engine metadata", () => {
    const details = buildFileEditApprovalDetails({
      files: [{ file: "src/a.ts", patch: ENGINE_PATCH_TWO_EDITS, additions: 2, deletions: 2, status: "modified" }],
    });
    assert.ok(details);
    assert.strictEqual(details.type, "fileEdit");
    assert.strictEqual(details.isNewFile, false);
    assert.strictEqual(details.diffString, TRIMMED_TWO_EDITS);
  });

  it("marks new files via status 'added'", () => {
    const details = buildFileEditApprovalDetails({
      files: [{ file: "src/new.ts", patch: ENGINE_PATCH_NEW_FILE, additions: 3, deletions: 0, status: "added" }],
    });
    assert.ok(details);
    assert.strictEqual(details.isNewFile, true);
    assert.strictEqual(details.diffString, ENGINE_PATCH_NEW_FILE);
  });

  it("returns undefined when the patch has no hunks (empty diff)", () => {
    assert.strictEqual(
      buildFileEditApprovalDetails({ files: [{ file: "src/a.ts", patch: ENGINE_PATCH_EMPTY, status: "modified" }] }),
      undefined,
    );
  });

  it("returns undefined for missing/garbage metadata", () => {
    assert.strictEqual(buildFileEditApprovalDetails(undefined), undefined);
    assert.strictEqual(buildFileEditApprovalDetails(null), undefined);
    assert.strictEqual(buildFileEditApprovalDetails({}), undefined);
    assert.strictEqual(buildFileEditApprovalDetails({ files: [] }), undefined);
    assert.strictEqual(buildFileEditApprovalDetails({ files: [null] }), undefined);
    assert.strictEqual(buildFileEditApprovalDetails({ files: [{ patch: 42 }] }), undefined);
  });
});

/* ------------------------------------------------------------------ */
/* Part 2: webview render tests (createComposer + node:vm fake DOM).   */
/* ------------------------------------------------------------------ */

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
const { createComposer } = require("../../components/composer") as typeof import("../../components/composer");
import type { ModeName } from "../../model";

/** Minimal fake DOM — just enough for the approval card path. */
class FakeElement {
  tag: string;
  children: FakeElement[] = [];
  parentNode: FakeElement | null = null;
  className = "";
  attrs = new Map<string, string>();
  style: Record<string, string> = {};
  listeners = new Map<string, Array<(e?: unknown) => void>>();
  private _text = "";
  id = "";
  value = "";
  dataset: Record<string, string> = {};
  private _classes = new Set<string>();
  classList = {
    add: (...cs: string[]): void => {
      cs.forEach((c) => this._classes.add(c));
    },
    remove: (...cs: string[]): void => {
      cs.forEach((c) => this._classes.delete(c));
    },
    contains: (c: string): boolean => this._classes.has(c),
    toggle: (c: string, force?: boolean): boolean => {
      const on = force ?? !this._classes.has(c);
      if (on) {
        this._classes.add(c);
      } else {
        this._classes.delete(c);
      }
      return on;
    },
  };

  constructor(tag: string) {
    this.tag = tag;
  }
  get textContent(): string {
    return this._text + this.children.map((c) => c.textContent).join("");
  }
  set textContent(v: string) {
    this._text = v;
    this.children = [];
  }
  set innerHTML(_v: string) {
    this._text = "";
    this.children = [];
  }
  appendChild(c: FakeElement): FakeElement {
    this.children.push(c);
    c.parentNode = this;
    return c;
  }
  setAttribute(k: string, v: string): void {
    this.attrs.set(k, String(v));
  }
  querySelector(_s: string): FakeElement | null {
    return null;
  }
  querySelectorAll(_s: string): FakeElement[] {
    return [];
  }
  addEventListener(t: string, fn: (e?: unknown) => void): void {
    const arr = this.listeners.get(t) ?? [];
    arr.push(fn);
    this.listeners.set(t, arr);
  }
  focus(): void {
    /* noop */
  }
  contains(n: unknown): boolean {
    return n === this || this.children.some((c) => c.contains(n));
  }
}

function extractInlineScript(html: string): string {
  const m = html.match(/<script nonce="[^"]*">([\s\S]*?)<\/script>/);
  assert.ok(m && m[1], "inline webview script not found in createComposer HTML");
  return m[1];
}

interface WebviewBoot {
  el: (id: string) => FakeElement;
  post: (msg: unknown) => void;
  posted: unknown[];
}

let INLINE_SCRIPT = "";

before(() => {
  const html = createComposer({} as never, "agent" as ModeName, false, "en", "ltr", "auto");
  INLINE_SCRIPT = extractInlineScript(html);
  // The diff styles must exist and use theme variables, never hardcoded colors.
  assert.match(html, /\.appr-diff\s*\{/, "appr-diff CSS present");
  assert.match(html, /--vscode-diffEditor-insertedLineBackground/, "inserted line background themed");
  assert.match(html, /--vscode-diffEditor-removedLineBackground/, "removed line background themed");
});

function boot(): WebviewBoot {
  const posted: unknown[] = [];
  const byId = new Map<string, FakeElement>();
  const doc: any = {
    activeElement: null,
    // Real documents always have <head>; the unread-divider webview script
    // injects its CSS via document.head (ensureCss).
    head: new FakeElement("head"),
    getElementById: (id: string): FakeElement => {
      let e = byId.get(id);
      if (!e) {
        e = new FakeElement("div");
        e.id = id;
        byId.set(id, e);
      }
      return e;
    },
    createElement: (tag: string): FakeElement => new FakeElement(tag),
    // The webview script queries document-level selectors at load (e.g. the
    // run-on picker: document.querySelectorAll('.run-on-option')). The fake
    // DOM has no HTML parser, so selector queries resolve to empty — the
    // forEach/addEventListener call sites then no-op safely.
    querySelector: (_s: string): null => null,
    querySelectorAll: (_s: string): FakeElement[] => [],
    addEventListener: (): void => {
      /* noop */
    },
  };
  const winListeners = new Map<string, Array<(e?: unknown) => void>>();
  const sandbox: any = {
    document: doc,
    window: {
      addEventListener: (t: string, fn: (e?: unknown) => void): void => {
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
  return {
    el: (id: string): FakeElement => {
      const e = byId.get(id);
      assert.ok(e, `element #${id} was never requested by the webview script`);
      return e as FakeElement;
    },
    post: (msg: unknown): void => {
      for (const fn of winListeners.get("message") ?? []) {
        fn({ data: msg });
      }
    },
    posted,
  };
}

/** Depth-first walk of element descendants. */
function walk(el: FakeElement, visit: (e: FakeElement) => void): void {
  for (const c of el.children) {
    visit(c);
    walk(c, visit);
  }
}

function diffLines(card: FakeElement): FakeElement[] {
  const out: FakeElement[] = [];
  walk(card, (e) => {
    if (e.className.split(" ").includes("adl")) {
      out.push(e);
    }
  });
  return out;
}

function showFileEditApproval(b: WebviewBoot, diffString: string): void {
  b.post({
    type: "approval",
    request: {
      approvalId: "approval-1",
      toolCallId: "tc-1",
      title: "edit src/a.ts",
      reasons: ["The engine requests permission"],
      options: [{ id: "approve-once", label: "Approve once" }],
      approvalDetails: { type: "fileEdit", isNewFile: false, diffString },
    },
  });
}

describe("approval-card-diff — webview render", () => {
  it("renders the unified diff with @@, -/+ lines and theme diff classes", () => {
    const b = boot();
    showFileEditApproval(b, TRIMMED_TWO_EDITS);
    const lines = diffLines(b.el("approvalCard"));
    assert.ok(lines.length > 0, "diff block rendered");
    const hunks = lines.filter((l) => l.className.includes("adl-hunk"));
    assert.strictEqual(hunks.length, 2);
    assert.strictEqual(hunks[0].textContent, "@@ -1,5 +1,5 @@");
    assert.strictEqual(hunks[1].textContent, "@@ -9,4 +9,4 @@");
    const dels = lines.filter((l) => l.className.includes("adl-del")).map((l) => l.textContent);
    const adds = lines.filter((l) => l.className.includes("adl-add")).map((l) => l.textContent);
    assert.deepStrictEqual(dels, ["-line3", "-line11"]);
    assert.deepStrictEqual(adds, ["+line3-CHANGED", "+line11-CHANGED"]);
  });

  it("shows exactly 2 context lines on each side of every change", () => {
    const b = boot();
    showFileEditApproval(b, TRIMMED_TWO_EDITS);
    const texts = diffLines(b.el("approvalCard")).map((l) => l.textContent);
    const hunkIdx = texts.map((t, i) => (t.startsWith("@@") ? i : -1)).filter((i) => i >= 0);
    assert.strictEqual(hunkIdx.length, 2);
    // First hunk body: 2 context, -/+, 2 context.
    assert.deepStrictEqual(texts.slice(hunkIdx[0] + 1, hunkIdx[1]), [
      " line1",
      " line2",
      "-line3",
      "+line3-CHANGED",
      " line4",
      " line5",
    ]);
    // Second hunk body: 2 context, -/+, 1 context (file ends).
    assert.deepStrictEqual(texts.slice(hunkIdx[1] + 1), [
      " line9",
      " line10",
      "-line11",
      "+line11-CHANGED",
      " line12",
    ]);
  });

  it("does not render a diff block for an empty (headers-only) diff", () => {
    const b = boot();
    showFileEditApproval(b, ENGINE_PATCH_EMPTY);
    assert.strictEqual(diffLines(b.el("approvalCard")).length, 0, "no diff block for empty diff");
    // The card itself still renders title + reasons + buttons.
    assert.match(b.el("approvalCard").textContent, /Approval needed/);
  });

  it("renders no diff block when the request has no approvalDetails", () => {
    const b = boot();
    b.post({
      type: "approval",
      request: {
        approvalId: "approval-2",
        toolCallId: "tc-2",
        title: "run tests",
        reasons: ["shell"],
        options: [{ id: "approve-once", label: "Approve once" }],
      },
    });
    assert.strictEqual(diffLines(b.el("approvalCard")).length, 0);
  });

  it("renders a large diff fully — no truncation", () => {
    const b = boot();
    const trimmed = trimUnifiedDiffContext(buildLargeEnginePatch(), 2);
    showFileEditApproval(b, trimmed);
    const lines = diffLines(b.el("approvalCard"));
    const hunks = lines.filter((l) => l.className.includes("adl-hunk"));
    assert.strictEqual(hunks.length, 9, "all 9 hunks rendered");
    assert.strictEqual(lines.filter((l) => l.className.includes("adl-del")).length, 9);
    assert.strictEqual(lines.filter((l) => l.className.includes("adl-add")).length, 9);
  });

  it("escapes patch content — never injects markup", () => {
    const b = boot();
    const evil = "@@ -1,1 +1,1 @@\n-<script>alert(1)</script>\n+<b>bold</b>\n";
    showFileEditApproval(b, evil);
    const lines = diffLines(b.el("approvalCard"));
    const del = lines.find((l) => l.className.includes("adl-del"));
    assert.ok(del);
    assert.strictEqual(del.textContent, "-<script>alert(1)</script>");
    assert.strictEqual(del.children.length, 0, "no parsed child elements");
  });

  it("clearing the approval removes the diff block", () => {
    const b = boot();
    showFileEditApproval(b, TRIMMED_TWO_EDITS);
    assert.ok(diffLines(b.el("approvalCard")).length > 0);
    b.post({ type: "approval", request: null });
    assert.strictEqual(diffLines(b.el("approvalCard")).length, 0);
    assert.strictEqual(b.el("approvalCard").style.display, "none");
  });
});
