/**
 * markdownTableService tests (node:test, zero extra deps).
 *
 * Covers Cursor parity for hover-on-markdown-table actions
 * ("Expand table" / "Copy table" + Copy as Markdown/CSV/TSV + Download):
 *  - pure TS: GFM table detection, alignment, serializers (Markdown/CSV/TSV/
 *    rich HTML), XSS safety, webview-script embedding invariants;
 *  - browser bundle (markdownTableWebviewScript, run in node:vm against a
 *    minimal fake DOM): hover toolbar injection, copy formats, expand modal.
 *
 * Run after `tsc`:  node out/services/test/run-markdown-table-tests.js
 */
import { describe, it, before } from "node:test";
import * as assert from "node:assert";
import * as vm from "node:vm";
import {
  detectMarkdownTable,
  splitTableRow,
  parseDelimiterCell,
  tableToMarkdown,
  tableToCsv,
  tableToTsv,
  tableToClipboardHtml,
  renderTableHtml,
  tableDownloadFilename,
  markdownTableWebviewScript,
  TABLE_LABELS,
  type ParsedMarkdownTable,
} from "../markdownTableService";

/* ------------------------------------------------------------------ */
/* Fixtures                                                            */
/* ------------------------------------------------------------------ */

const BASIC_LINES = [
  "Some intro text",
  "",
  "| Name | Age | City |",
  "| :--- | :---: | ---: |",
  "| Ada | 36 | London |",
  "| Grace | 85 | New York |",
  "",
  "After the table",
];

const BASIC_TABLE: ParsedMarkdownTable = {
  headers: ["Name", "Age", "City"],
  aligns: ["left", "center", "right"],
  rows: [
    ["Ada", "36", "London"],
    ["Grace", "85", "New York"],
  ],
};

/* ------------------------------------------------------------------ */
/* Pure TS: detection                                                  */
/* ------------------------------------------------------------------ */

describe("detectMarkdownTable", () => {
  it("detects a basic GFM table with alignment and body rows", () => {
    const found = detectMarkdownTable(BASIC_LINES, 2);
    assert.ok(found, "expected a table at line 2");
    assert.deepStrictEqual(found.table, BASIC_TABLE);
    assert.strictEqual(found.endLine, 5);
  });

  it("parses all four alignment markers", () => {
    assert.strictEqual(parseDelimiterCell("---"), null);
    assert.strictEqual(parseDelimiterCell(":---"), "left");
    assert.strictEqual(parseDelimiterCell(":---:"), "center");
    assert.strictEqual(parseDelimiterCell("---:"), "right");
    assert.strictEqual(parseDelimiterCell(" - - "), "invalid");
    assert.strictEqual(parseDelimiterCell("abc"), "invalid");
  });

  it("rejects a setext-style false positive (pipe text + --- line)", () => {
    // "foo | bar" header would split to 2 cells, "---" to 1 -> count mismatch.
    assert.strictEqual(detectMarkdownTable(["foo | bar", "---", "baz"], 0), null);
    assert.strictEqual(detectMarkdownTable(["just a paragraph", "---"], 0), null);
    assert.strictEqual(detectMarkdownTable(["| a |", "not a delimiter"], 0), null);
  });

  it("handles tables without outer pipes", () => {
    const found = detectMarkdownTable(["Name | Age", "--- | ---", "Ada | 36"], 0);
    assert.ok(found);
    assert.deepStrictEqual(found.table.headers, ["Name", "Age"]);
    assert.deepStrictEqual(found.table.rows, [["Ada", "36"]]);
    assert.strictEqual(found.endLine, 2);
  });

  it("keeps escaped pipes inside cells", () => {
    const cells = splitTableRow("| a \\| b | c |");
    assert.deepStrictEqual(cells, ["a | b", "c"]);
  });

  it("pads short rows and truncates long rows to the header width", () => {
    const found = detectMarkdownTable(
      ["| a | b |", "|---|---|", "| 1 |", "| 2 | 3 | 4 |"],
      0,
    );
    assert.ok(found);
    assert.deepStrictEqual(found.table.rows, [
      ["1", ""],
      ["2", "3"],
    ]);
  });
});

/* ------------------------------------------------------------------ */
/* Pure TS: serializers                                                */
/* ------------------------------------------------------------------ */

describe("serializers", () => {
  it("tableToMarkdown regenerates GFM that re-parses to the same model", () => {
    const md = tableToMarkdown(BASIC_TABLE);
    assert.ok(md.includes("| :--- | :---: | ---: |"), "alignment row preserved:\n" + md);
    const reparsed = detectMarkdownTable(md.split("\n"), 0);
    assert.ok(reparsed, "regenerated markdown should parse");
    assert.deepStrictEqual(reparsed.table, BASIC_TABLE);
  });

  it("tableToCsv quotes per RFC-4180", () => {
    const t: ParsedMarkdownTable = {
      headers: ["a", "b"],
      aligns: [null, null],
      rows: [["x,y", 'say "hi"'], ["line1\nline2", "plain"]],
    };
    assert.strictEqual(tableToCsv(t), 'a,b\r\n"x,y","say ""hi"""\r\n"line1\nline2",plain');
  });

  it("tableToTsv separates with tabs and cleans embedded tabs/newlines", () => {
    const t: ParsedMarkdownTable = {
      headers: ["a", "b"],
      aligns: [null, null],
      rows: [["x\ty", "line1\nline2"]],
    };
    assert.strictEqual(tableToTsv(t), "a\tb\nx y\tline1 line2");
  });

  it("renderTableHtml escapes cells, keeps working links, marks md-table", () => {
    const t: ParsedMarkdownTable = {
      headers: ["H", "Link"],
      aligns: [null, null],
      rows: [["<script>alert(1)</script>", "[docs](https://example.com/x)"]],
    };
    const html = renderTableHtml(t);
    assert.ok(html.includes('<table class="md-table">'), "md-table class");
    assert.ok(!html.includes("<script>alert"), "XSS escaped");
    assert.ok(html.includes("&lt;script&gt;"), "escaped visibly");
    assert.ok(
      html.includes('<a href="https://example.com/x" target="_blank" rel="noopener">docs</a>'),
      "working link, got: " + html,
    );
  });

  it("tableToClipboardHtml is a standalone bordered table", () => {
    const html = tableToClipboardHtml(BASIC_TABLE);
    assert.ok(html.startsWith("<table style="), "inline styles, no class dependency");
    assert.ok(html.includes("<th"), "headers present");
    assert.ok(html.includes("Ada") && html.includes("New York"), "cells present");
  });

  it("tableDownloadFilename uses table.{md,csv,tsv}", () => {
    assert.strictEqual(tableDownloadFilename("markdown"), "table.md");
    assert.strictEqual(tableDownloadFilename("csv"), "table.csv");
    assert.strictEqual(tableDownloadFilename("tsv"), "table.tsv");
  });
});

/* ------------------------------------------------------------------ */
/* Webview script embedding invariants                                 */
/* ------------------------------------------------------------------ */

describe("markdownTableWebviewScript", () => {
  let script = "";
  before(() => {
    script = markdownTableWebviewScript();
  });

  it("is safe to interpolate into a template literal (no backticks/${/close tag)", () => {
    assert.ok(!script.includes("`"), "no backticks");
    assert.ok(!script.includes("${"), "no ${");
    assert.ok(!script.includes("</script"), "no closing script tag");
  });

  it("exposes the full API the composer webview expects", () => {
    for (const name of [
      "MD_TABLE_PH",
      "mdTableBlockHtml",
      "ideInitTableHover",
      "ideOpenTableModal",
      "ideCloseTableModal",
      "ideCopyTable",
      "ideDownloadTable",
    ]) {
      assert.ok(script.includes(name), "missing API: " + name);
    }
  });

  it("uses the exact Cursor labels from the binary", () => {
    for (const label of Object.values(TABLE_LABELS)) {
      assert.ok(script.includes(label), "missing label: " + label);
    }
    assert.strictEqual(TABLE_LABELS.copyTable, "Copy table");
    assert.strictEqual(TABLE_LABELS.expandTable, "Expand table");
  });
});

/* ------------------------------------------------------------------ */
/* Minimal fake DOM for the browser bundle                             */
/* ------------------------------------------------------------------ */

class TEl {
  tag: string;
  children: TEl[] = [];
  parent: TEl | null = null;
  attrs = new Map<string, string>();
  classes = new Set<string>();
  listeners = new Map<string, Array<(e: Record<string, unknown>) => void>>();
  style: Record<string, string> = {};
  text = "";
  value = "";

  classList = {
    add: (...cs: string[]): void => {
      cs.forEach((c) => this.classes.add(c));
    },
    remove: (...cs: string[]): void => {
      cs.forEach((c) => this.classes.delete(c));
    },
    contains: (c: string): boolean => this.classes.has(c),
    toggle: (c: string, force?: boolean): boolean => {
      const on = force === undefined ? !this.classes.has(c) : !!force;
      if (on) {
        this.classes.add(c);
      } else {
        this.classes.delete(c);
      }
      return on;
    },
  };

  constructor(tag: string) {
    this.tag = tag;
  }

  get parentNode(): TEl | null {
    return this.parent;
  }

  // Real DOM reflects these element properties to attributes.
  get href(): string | null {
    return this.getAttribute("href");
  }
  set href(v: string) {
    this.setAttribute("href", v);
  }
  get download(): string | null {
    return this.getAttribute("download");
  }
  set download(v: string) {
    this.setAttribute("download", v);
  }

  get className(): string {
    return [...this.classes].join(" ");
  }
  set className(v: string) {
    this.classes = new Set(String(v).split(/\s+/).filter(Boolean));
    this.attrs.set("class", this.className);
  }

  setAttribute(k: string, v: string): void {
    if (k === "class") {
      this.classes = new Set(String(v).split(/\s+/).filter(Boolean));
    }
    this.attrs.set(k, String(v));
  }
  getAttribute(k: string): string | null {
    if (k === "class") {
      return [...this.classes].join(" ") || null;
    }
    const v = this.attrs.get(k);
    return v === undefined ? null : v;
  }
  removeAttribute(k: string): void {
    this.attrs.delete(k);
    if (k === "class") {
      this.classes.clear();
    }
  }
  hasAttribute(k: string): boolean {
    return this.attrs.has(k);
  }

  get textContent(): string {
    if (this.tag === "#text") {
      return this.text;
    }
    return this.children.map((c) => c.textContent).join("");
  }
  set textContent(v: string) {
    this.children = [];
    if (v) {
      const t = new TEl("#text");
      t.text = v;
      t.parent = this;
      this.children.push(t);
    }
  }

  appendChild(c: TEl): TEl {
    if (c.parent) {
      c.parent.removeChild(c);
    }
    c.parent = this;
    this.children.push(c);
    return c;
  }
  insertBefore(c: TEl, ref: TEl | null): TEl {
    if (c.parent) {
      c.parent.removeChild(c);
    }
    c.parent = this;
    const idx = ref ? this.children.indexOf(ref) : -1;
    if (idx < 0) {
      this.children.push(c);
    } else {
      this.children.splice(idx, 0, c);
    }
    return c;
  }
  removeChild(c: TEl): TEl {
    const idx = this.children.indexOf(c);
    if (idx >= 0) {
      this.children.splice(idx, 1);
    }
    c.parent = null;
    return c;
  }
  remove(): void {
    if (this.parent) {
      this.parent.removeChild(this);
    }
  }
  cloneNode(deep: boolean): TEl {
    const c = new TEl(this.tag);
    c.attrs = new Map(this.attrs);
    c.classes = new Set(this.classes);
    c.style = { ...this.style };
    c.text = this.text;
    c.value = this.value;
    if (deep) {
      for (const k of this.children) {
        c.appendChild(k.cloneNode(true));
      }
    }
    return c;
  }

  addEventListener(t: string, fn: (e: Record<string, unknown>) => void): void {
    const arr = this.listeners.get(t) ?? [];
    arr.push(fn);
    this.listeners.set(t, arr);
  }
  removeEventListener(t: string, fn: (e: Record<string, unknown>) => void): void {
    const arr = this.listeners.get(t);
    if (arr) {
      this.listeners.set(
        t,
        arr.filter((f) => f !== fn),
      );
    }
  }
  dispatchEvent(e: Record<string, unknown>): boolean {
    const evt = { target: this as TEl, ...e, type: (e as { type: string }).type };
    for (const fn of this.listeners.get(evt.type) ?? []) {
      fn(evt);
    }
    return true;
  }
  click(): void {
    this.dispatchEvent({ type: "click", stopPropagation: () => undefined });
  }
  focus(): void {
    /* noop */
  }
  select(): void {
    /* noop */
  }

  querySelectorAll(sel: string): TEl[] {
    const out: TEl[] = [];
    const walk = (el: TEl): void => {
      for (const c of el.children) {
        if (matchesSel(c, sel)) {
          out.push(c);
        }
        walk(c);
      }
    };
    walk(this);
    return out;
  }
  querySelector(sel: string): TEl | null {
    return this.querySelectorAll(sel)[0] ?? null;
  }
}

function matchPart(el: TEl, part: string): boolean {
  // supports: tag, .class, tag.class(.class2...)
  const m = part.match(/^([a-zA-Z0-9#]+)?((?:\.[a-zA-Z0-9_-]+)*)$/);
  if (!m) {
    return false;
  }
  const tag = m[1];
  const classes = m[2].split(".").filter(Boolean);
  if (tag && tag !== "#" && el.tag !== tag) {
    return false;
  }
  return classes.every((c) => el.classes.has(c));
}

function matchesSel(el: TEl, sel: string): boolean {
  // supports comma groups and descendant combinators of simple parts.
  // The rightmost part must match the element itself; earlier parts may
  // match any ancestor (descendant combinator).
  for (const group of sel.split(",").map((s) => s.trim())) {
    const parts = group.split(/\s+/).filter(Boolean);
    let cur: TEl | null = el;
    let ok = true;
    for (let i = parts.length - 1; i >= 0; i--) {
      if (i === parts.length - 1) {
        if (!cur || !matchPart(cur, parts[i])) {
          ok = false;
          break;
        }
      } else {
        while (cur && !matchPart(cur, parts[i])) {
          cur = cur.parent;
        }
        if (!cur) {
          ok = false;
          break;
        }
      }
      if (i > 0) {
        cur = cur.parent;
      }
    }
    if (ok) {
      return true;
    }
  }
  return false;
}

interface FakeClipboard {
  writes: unknown[][];
  texts: string[];
}

class FakeBlob {
  parts: string;
  type: string;
  constructor(parts: unknown[], opts?: { type?: string }) {
    this.parts = parts.map(String).join("");
    this.type = opts?.type ?? "";
  }
}

class FakeClipboardItem {
  data: Record<string, FakeBlob>;
  constructor(data: Record<string, FakeBlob>) {
    this.data = data;
  }
}

interface BundleCtx {
  sandbox: Record<string, unknown>;
  doc: {
    body: TEl;
    createElement: (tag: string) => TEl;
    querySelector: (sel: string) => TEl | null;
    querySelectorAll: (sel: string) => TEl[];
    addEventListener: (t: string, fn: (e: Record<string, unknown>) => void) => void;
    removeEventListener: (t: string, fn: (e: Record<string, unknown>) => void) => void;
    dispatchEvent: (e: Record<string, unknown>) => boolean;
    execCommand: (cmd: string) => boolean;
  };
  clipboard: FakeClipboard;
  lastBlob: { blob: FakeBlob | null };
}

function bootBundle(): BundleCtx {
  const clipboard: FakeClipboard = { writes: [], texts: [] };
  const lastBlob: { blob: FakeBlob | null } = { blob: null };
  const body = new TEl("body");
  const docListeners = new Map<string, Array<(e: Record<string, unknown>) => void>>();
  const doc = {
    body,
    createElement: (tag: string): TEl => new TEl(tag),
    querySelector: (sel: string): TEl | null => body.querySelector(sel),
    querySelectorAll: (sel: string): TEl[] => body.querySelectorAll(sel),
    addEventListener: (t: string, fn: (e: Record<string, unknown>) => void): void => {
      const arr = docListeners.get(t) ?? [];
      arr.push(fn);
      docListeners.set(t, arr);
    },
    removeEventListener: (t: string, fn: (e: Record<string, unknown>) => void): void => {
      const arr = docListeners.get(t);
      if (arr) {
        docListeners.set(
          t,
          arr.filter((f) => f !== fn),
        );
      }
    },
    dispatchEvent: (e: Record<string, unknown>): boolean => {
      for (const fn of docListeners.get((e as { type: string }).type) ?? []) {
        fn(e);
      }
      return true;
    },
    execCommand: (_cmd: string): boolean => true,
  };
  const sandbox: Record<string, unknown> = {
    document: doc,
    navigator: {
      clipboard: {
        write: async (items: unknown[]): Promise<void> => {
          clipboard.writes.push(items);
        },
        writeText: async (t: string): Promise<void> => {
          clipboard.texts.push(t);
        },
      },
    },
    ClipboardItem: FakeClipboardItem,
    Blob: FakeBlob,
    URL: {
      createObjectURL: (b: FakeBlob): string => {
        lastBlob.blob = b;
        return "blob:fake-url";
      },
      revokeObjectURL: (_u: string): void => {
        /* noop */
      },
    },
    setTimeout,
    clearTimeout,
    console,
  };
  vm.createContext(sandbox);
  vm.runInContext(markdownTableWebviewScript(), sandbox, { filename: "md-table-bundle.js" });
  return { sandbox, doc, clipboard, lastBlob };
}

/** Build a rendered <table class="md-table"> in the fake DOM. */
function buildFakeTable(doc: BundleCtx["doc"], withLink: boolean): TEl {
  const table = doc.createElement("table");
  table.classList.add("md-table");
  const thead = doc.createElement("thead");
  const hr = doc.createElement("tr");
  for (const [h, a] of [["Name", "left"], ["Age", "right"]] as Array<[string, string]>) {
    const th = doc.createElement("th");
    th.setAttribute("style", "text-align:" + a);
    th.textContent = h;
    hr.appendChild(th);
  }
  thead.appendChild(hr);
  const tbody = doc.createElement("tbody");
  const rows: string[][] = withLink ? [["Ada", "see [docs](https://x.test)"], ["Grace", "85"]] : [["Ada", "36"], ["Grace", "85"]];
  for (const r of rows) {
    const tr = doc.createElement("tr");
    for (const cell of r) {
      const td = doc.createElement("td");
        const linkMatch = cell.match(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/);
      if (linkMatch) {
        td.textContent = cell.slice(0, linkMatch.index);
        const a = doc.createElement("a");
        a.setAttribute("href", linkMatch[2]);
        a.setAttribute("target", "_blank");
        a.textContent = linkMatch[1];
        td.appendChild(a);
        const rest = cell.slice((linkMatch.index ?? 0) + linkMatch[0].length);
        if (rest) {
          const tail = doc.createElement("#text");
          tail.text = rest;
          td.appendChild(tail);
        }
      } else {
        td.textContent = cell;
      }
      tr.appendChild(td);
    }
    tbody.appendChild(tr);
  }
  table.appendChild(thead);
  table.appendChild(tbody);
  return table;
}

function buttonsWithText(root: TEl, text: string): TEl[] {
  return root.querySelectorAll("button").filter((b) => b.textContent === text);
}

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 5));

/* ------------------------------------------------------------------ */
/* Integration: the real composer webview script                        */
/* ------------------------------------------------------------------ */

/** Stub the "vscode" module the way composer-morph.test.ts does. */
function withVscodeStub<T>(fn: () => T): T {
  const Module = require("module") as {
    _load: (...args: unknown[]) => unknown;
  };
  const origLoad = Module._load.bind(Module);
  (Module as unknown as { _load: (...args: unknown[]) => unknown })._load = function (
    request: unknown,
    ...rest: unknown[]
  ) {
    if (request === "vscode") {
      return {};
    }
    return origLoad(request, ...rest);
  };
  try {
    return fn();
  } finally {
    (Module as unknown as { _load: (...args: unknown[]) => unknown })._load = origLoad;
  }
}

function composerHtml(): string {
  return withVscodeStub(() => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires, @typescript-eslint/no-explicit-any
    const { createComposer } = require("../../components/composer") as any;
    return createComposer({} as never, "agent", false, "en", "ltr", "auto") as string;
  });
}

function inlineScriptOf(html: string): string {
  const m = html.match(/<script nonce="[^"]*">([\s\S]*?)<\/script>/);
  assert.ok(m && m[1], "inline webview script not found");
  return m[1];
}

/** Minimal document stub just sufficient to execute the script top-level. */
function stubDocForBoot(): Record<string, unknown> {
  const mkEl = (): Record<string, unknown> => {
    const classes = new Set<string>();
    return {
      style: {},
      listeners: new Map<string, Array<(e: unknown) => void>>(),
      classList: {
        add: (...cs: string[]): void => {
          cs.forEach((c) => classes.add(c));
        },
        remove: (...cs: string[]): void => {
          cs.forEach((c) => classes.delete(c));
        },
        contains: (c: string): boolean => classes.has(c),
        toggle: (c: string): boolean => {
          const on = !classes.has(c);
          if (on) {
            classes.add(c);
          } else {
            classes.delete(c);
          }
          return on;
        },
      },
      addEventListener(t: string, fn: (e: unknown) => void): void {
        (this.listeners as Map<string, Array<(e: unknown) => void>>).get(t)?.push(fn);
      },
      setAttribute(): void {
        /* noop */
      },
      appendChild(): void {
        /* noop */
      },
      querySelector: (): null => null,
      querySelectorAll: (): never[] => [],
      textContent: "{}",
      value: "",
      hidden: false,
    };
  };
  const byId = new Map<string, Record<string, unknown>>();
  return {
    getElementById: (id: string): Record<string, unknown> => {
      let el = byId.get(id);
      if (!el) {
        el = mkEl();
        byId.set(id, el);
      }
      return el;
    },
    createElement: (): Record<string, unknown> => mkEl(),
    querySelector: (): null => null,
    querySelectorAll: (): never[] => [],
    addEventListener: (): void => {
      /* noop */
    },
    body: mkEl(),
    // Real documents always have <head>; the unread-divider webview script
    // injects its CSS via document.head (ensureCss).
    head: mkEl(),
  };
}

describe("composer wiring (integration)", () => {
  it("embeds the table script, render hooks, and toolbar CSS", () => {
    const html = composerHtml();
    const script = inlineScriptOf(html);
    // The full inline script must still parse after our interpolation.
    assert.doesNotThrow(() => new vm.Script(script), "inline webview script parses");
    // Injection present (single source of truth from markdownTableService).
    assert.ok(
      script.includes("markdown-table-expand-copy (markdownTableService)"),
      "service script injected",
    );
    // renderMarkdown table extraction + restore.
    assert.ok(script.includes("mdTableBlockHtml(rawLines, tblIdx)"), "table extraction hook");
    assert.ok(script.includes("tableBlockRe"), "table placeholder restore");
    // Hover wiring after both bubble render paths.
    assert.ok(script.includes("ideInitTableHover(text)"), "bubbleEl wiring");
    assert.ok(script.includes("ideInitTableHover(bubbleTextEl)"), "patchBubble wiring");
    // CSS for tables, toolbar, modal.
    for (const cls of [".md-table-wrap", ".md-table-toolbar", ".md-table-menu", ".md-table-modal-overlay"]) {
      assert.ok(html.includes(cls), "CSS present: " + cls);
    }
    assert.ok(html.includes("table.md-table"), "table.md-table styles present");
  });

  it("the real renderMarkdown renders GFM tables to table.md-table", () => {
    const script = inlineScriptOf(composerHtml());
    const needle = "function renderMarkdown(src) {";
    assert.ok(script.includes(needle), "renderMarkdown found");
    assert.strictEqual(script.indexOf(needle), script.lastIndexOf(needle), "hook anchor unique");
    const hooked = script.replace(needle, "globalThis.__tRM = function renderMarkdown(src) {");
    const sandbox: Record<string, unknown> = {
      document: stubDocForBoot(),
      window: { addEventListener: (): void => undefined },
      acquireVsCodeApi: () => ({ postMessage: (): void => undefined }),
      navigator: {},
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
    vm.runInContext(hooked, sandbox, { filename: "composer-wiring-check.js" });
    const renderMarkdown = sandbox["__tRM"] as (src: string) => string;
    assert.strictEqual(typeof renderMarkdown, "function", "renderMarkdown reachable");
    const out = renderMarkdown("| Name | Age |\n| --- | ---: |\n| Ada | 36 |\n\nplain para");
    assert.ok(out.includes('<table class="md-table">'), "table element, got: " + out.slice(0, 200));
    assert.ok(out.includes("<th>Name</th>"), "header cell");
    assert.ok(out.includes('style="text-align:right"'), "column alignment");
    assert.ok(out.includes("<td>Ada</td>"), "body cell");
    assert.ok(out.includes("<p>plain para</p>"), "surrounding markdown unaffected");
    // No delimiter row -> not a table, stays a paragraph (no false positive).
    const notTable = renderMarkdown("a | b\nc | d");
    assert.ok(!notTable.includes("<table"), "no table without delimiter row");
  });
});

/* ------------------------------------------------------------------ */
/* Browser bundle: TS/browser parity                                   */
/* ------------------------------------------------------------------ */

describe("browser bundle parity", () => {
  it("mdTableBlockHtml matches TS renderTableHtml on fixtures", () => {
    const { sandbox } = bootBundle();
    const mdTableBlockHtml = sandbox["mdTableBlockHtml"] as (
      lines: string[],
      i: number,
    ) => { html: string; next: number } | null;
    const fixtures: string[][] = [
      ["| Name | Age |", "| --- | ---: |", "| Ada | 36 |", "| Grace | 85 |"],
      ["Name | Age", ":-- | --:", "Ada | 36"],
      ["| H |", "| --- |", "| a \\\\| b |", "| <b>bold</b> & [x](https://e.test/y) |"],
    ];
    for (const lines of fixtures) {
      const browser = mdTableBlockHtml(lines, 0);
      assert.ok(browser, "browser should detect table in: " + lines[0]);
      const tsDetected = detectMarkdownTable(lines, 0);
      assert.ok(tsDetected, "TS should detect table in: " + lines[0]);
      assert.strictEqual(browser.next, tsDetected.endLine, "same consumed lines");
      assert.strictEqual(browser.html, renderTableHtml(tsDetected.table), "same HTML for: " + lines[0]);
    }
    assert.strictEqual(mdTableBlockHtml(["no table", "here"], 0), null);
    assert.strictEqual(mdTableBlockHtml(["foo | bar", "---"], 0), null);
  });
});

/* ------------------------------------------------------------------ */
/* Browser bundle: hover toolbar                                       */
/* ------------------------------------------------------------------ */

describe("ideInitTableHover", () => {
  it("injects Expand table and Copy table buttons on a rendered markdown table", () => {
    const { sandbox, doc } = bootBundle();
    const init = sandbox["ideInitTableHover"] as (root: TEl) => void;
    const container = doc.createElement("div");
    container.appendChild(buildFakeTable(doc, false));
    doc.body.appendChild(container);
    init(container);
    const wraps = container.querySelectorAll(".md-table-wrap");
    assert.strictEqual(wraps.length, 1, "exactly one wrapper");
    const bar = wraps[0].querySelector(".md-table-toolbar");
    assert.ok(bar, "toolbar injected");
    assert.strictEqual(bar.getAttribute("role"), "toolbar");
    assert.deepStrictEqual(
      bar.children.filter((b) => b.tag === "button").map((b) => b.textContent),
      ["Expand table", "Copy table", "More"],
      "primary toolbar buttons are direct children",
    );
    const menuItems = wraps[0].querySelectorAll(".md-table-menuitem").map((b) => b.textContent);
    assert.deepStrictEqual(menuItems, [
      "Copy table as Markdown",
      "Copy table as CSV",
      "Copy table as TSV",
      "Download table as Markdown",
      "Download table as CSV",
    ]);
  });

  it("leaves foreign tables (no .md-table) alone", () => {
    const { sandbox, doc } = bootBundle();
    const init = sandbox["ideInitTableHover"] as (root: TEl) => void;
    const container = doc.createElement("div");
    const foreign = doc.createElement("table"); // e.g. some other widget's table
    const tr = doc.createElement("tr");
    const td = doc.createElement("td");
    td.textContent = "x";
    tr.appendChild(td);
    foreign.appendChild(tr);
    container.appendChild(foreign);
    doc.body.appendChild(container);
    init(container);
    assert.strictEqual(container.querySelectorAll(".md-table-wrap").length, 0, "no wrapper injected");
    assert.strictEqual(container.querySelectorAll("button").length, 0, "no buttons injected");
  });

  it("is idempotent across streaming re-renders", () => {
    const { sandbox, doc } = bootBundle();
    const init = sandbox["ideInitTableHover"] as (root: TEl) => void;
    const container = doc.createElement("div");
    container.appendChild(buildFakeTable(doc, false));
    doc.body.appendChild(container);
    init(container);
    init(container);
    init(container);
    assert.strictEqual(container.querySelectorAll(".md-table-wrap").length, 1);
    assert.strictEqual(buttonsWithText(container, "Copy table").length, 1);
  });
});

/* ------------------------------------------------------------------ */
/* Browser bundle: copy / download / expand                            */
/* ------------------------------------------------------------------ */

describe("table actions", () => {
  it("Copy table writes text/html (real table) + text/plain (Markdown)", async () => {
    const { sandbox, doc, clipboard } = bootBundle();
    const init = sandbox["ideInitTableHover"] as (root: TEl) => void;
    const container = doc.createElement("div");
    container.appendChild(buildFakeTable(doc, false));
    doc.body.appendChild(container);
    init(container);
    buttonsWithText(container, "Copy table")[0].click();
    await tick();
    assert.strictEqual(clipboard.writes.length, 1, "one clipboard.write call");
    const item = clipboard.writes[0][0] as FakeClipboardItem;
    assert.ok(item instanceof FakeClipboardItem);
    const html = item.data["text/html"];
    const plain = item.data["text/plain"];
    assert.ok(html && html.type === "text/html" && html.parts.includes("<table"), "rich table HTML");
    assert.ok(html.parts.includes("Ada"), "cells in HTML");
    assert.ok(
      plain && plain.type === "text/plain" && plain.parts.includes("| Name | Age |"),
      "Markdown fallback, got: " + (plain && plain.parts),
    );
  });

  it("Copy table as CSV writes CSV text", async () => {
    const { sandbox, doc, clipboard } = bootBundle();
    const init = sandbox["ideInitTableHover"] as (root: TEl) => void;
    const container = doc.createElement("div");
    container.appendChild(buildFakeTable(doc, false));
    doc.body.appendChild(container);
    init(container);
    buttonsWithText(container, "Copy table as CSV")[0].click();
    await tick();
    assert.deepStrictEqual(clipboard.texts, ["Name,Age\r\nAda,36\r\nGrace,85"]);
  });

  it("Download table as CSV creates a blob download named table.csv", async () => {
    const { sandbox, doc, lastBlob } = bootBundle();
    const init = sandbox["ideInitTableHover"] as (root: TEl) => void;
    const container = doc.createElement("div");
    container.appendChild(buildFakeTable(doc, false));
    doc.body.appendChild(container);
    init(container);
    buttonsWithText(container, "Download table as CSV")[0].click();
    await tick();
    const anchors: TEl[] = [];
    const walk = (el: TEl): void => {
      for (const c of el.children) {
        if (c.tag === "a" && c.getAttribute("download")) {
          anchors.push(c);
        }
        walk(c);
      }
    };
    walk(doc.body);
    assert.strictEqual(anchors.length, 1, "one download anchor");
    assert.strictEqual(anchors[0].getAttribute("download"), "table.csv");
    assert.strictEqual(anchors[0].getAttribute("href"), "blob:fake-url");
    assert.ok(lastBlob.blob && lastBlob.blob.parts.includes("Ada,36"), "CSV blob content");
  });

  it("Expand table opens a modal with wrapped columns and working links; Escape closes it", () => {
    const { sandbox, doc } = bootBundle();
    const init = sandbox["ideInitTableHover"] as (root: TEl) => void;
    const container = doc.createElement("div");
    container.appendChild(buildFakeTable(doc, true));
    doc.body.appendChild(container);
    init(container);
    buttonsWithText(container, "Expand table")[0].click();
    const overlay = doc.querySelector(".md-table-modal-overlay");
    assert.ok(overlay, "modal overlay opened");
    assert.strictEqual(overlay.getAttribute("role"), "dialog");
    assert.strictEqual(overlay.getAttribute("aria-modal"), "true");
    assert.ok(overlay.querySelector(".md-table-modal-panel"), "panel present");
    const modalTable = overlay.querySelector("table.md-table");
    assert.ok(modalTable, "table cloned into modal");
    const link = modalTable.querySelector("a");
    assert.ok(link, "link preserved in modal");
    assert.strictEqual(link.getAttribute("href"), "https://x.test");
    assert.strictEqual(link.getAttribute("target"), "_blank", "working link opens externally");
    doc.dispatchEvent({ type: "keydown", key: "Escape", keyCode: 27 });
    assert.strictEqual(doc.querySelector(".md-table-modal-overlay"), null, "Escape closes the modal");
  });
});
