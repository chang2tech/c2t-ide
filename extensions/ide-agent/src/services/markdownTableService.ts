/**
 * markdownTableService — hover toolbar for Markdown tables in agent replies
 * (Cursor parity: "Expand table" / "Copy table").
 *
 * EVIDENCE (verified directly against the Cursor 3.25.9 binary
 * `workbench.glass.main.js`, squashfs reference in ide-code-mission):
 *   copyTable:"Copy table"                    (1 key hit; "Copy table" x3 total)
 *   copyTableAsMarkdown:"Copy table as Markdown"
 *   copyTableAsCsv:"Copy table as CSV"
 *   copyTableAsTsv:"Copy table as TSV"
 *   downloadTable:"Download table"
 *   downloadTableAsCsv:"Download table as CSV"
 *   downloadTableAsMarkdown:"Download table as Markdown"
 *   "Expand table" x2
 * Release notes: "Hover a Markdown table in an agent's reply or a Markdown
 * file to show Expand table and Copy table buttons beside it. Expand table
 * opens the table in a full-size view with wrapped columns and working
 * links, and Copy table pastes as a real table into docs and chat apps, or
 * as Markdown into plain text."
 *
 * HONEST DIVERGENCE / UNKNOWN (do not claim parity here):
 * - The exact Cursor trigger UI (hover offset, toolbar layout, icon set) is
 *   UNKNOWN — the binary is minified and the trigger lives in React code we
 *   did not reverse. Our toolbar shows on :hover/:focus-within of a wrapper
 *   div positioned beside the table's top-right corner.
 * - The "Markdown file" half of the release note (hovering tables in the
 *   editor's Markdown preview) is OUT OF SCOPE here: that surface belongs to
 *   the built-in markdown-language-features extension / workbench core, not
 *   the ide-agent chat webview. This service wires the agent-reply webview.
 * - Cursor's exact CSV/TSV quoting and download filename are UNKNOWN; we use
 *   RFC-4180 quoting and `table.{csv,md}` filenames.
 *
 * ARCHITECTURE
 * This file is the single source of truth, in two halves:
 *  1. Pure TS functions (no DOM): parse GFM tables, render <table> HTML,
 *     serialize to Markdown / CSV / TSV / rich HTML. Unit-tested with
 *     node:test, zero extra deps.
 *  2. The browser half (hover toolbar, expand modal, clipboard) is authored
 *     as the plain TS function __mdTableBrowserImpl below and serialized
 *     with Function.prototype.toString() by markdownTableWebviewScript().
 *     Rationale: the webview <script> cannot import TS modules, and
 *     hand-maintaining a second copy as an escaped string literal is an
 *     escaping-bug factory. Authoring it as real TS gives us tsc checking;
 *     toString() preserves the compiled source verbatim (no minification in
 *     this repo). Constraints on __mdTableBrowserImpl (guarded by unit
 *     tests): no imports, no backticks, no "${" (it is interpolated into
 *     composer.ts's webview <script> template literal), no TS-only emit
 *     (enums, parameter properties). It installs its API on globalThis.
 */
export type TableAlignment = "left" | "center" | "right" | null;

export interface ParsedMarkdownTable {
  headers: string[];
  aligns: TableAlignment[];
  rows: string[][];
}

/** Exact user-visible labels, byte-identical to the Cursor 3.25.9 binary. */
export const TABLE_LABELS = {
  expandTable: "Expand table",
  copyTable: "Copy table",
  copyTableAsMarkdown: "Copy table as Markdown",
  copyTableAsCsv: "Copy table as CSV",
  copyTableAsTsv: "Copy table as TSV",
  downloadTable: "Download table",
  downloadTableAsMarkdown: "Download table as Markdown",
  downloadTableAsCsv: "Download table as CSV",
} as const;

export type TableCopyFormat = "markdown" | "csv" | "tsv";

/* ------------------------------------------------------------------ */
/* Pure parsing (TS side — also mirrored in the browser bundle)        */
/* ------------------------------------------------------------------ */

/** Private-use placeholder for an escaped pipe while splitting rows. */
const PIPE_PH = "";

function protectEscapedPipes(s: string): string {
  return s.replace(/\\\|/g, PIPE_PH);
}

function restoreEscapedPipes(s: string): string {
  return s.split(PIPE_PH).join("|");
}

/**
 * Split one markdown table row into cells. Handles optional leading /
 * trailing pipes and escaped pipes (\|).
 */
export function splitTableRow(line: string): string[] {
  const protectedRow = protectEscapedPipes(line);
  let cells = protectedRow.split("|");
  if (cells.length > 0 && /^\s*$/.test(cells[0])) {
    cells = cells.slice(1);
  }
  if (cells.length > 0 && /^\s*$/.test(cells[cells.length - 1])) {
    cells = cells.slice(0, -1);
  }
  return cells.map((c) => restoreEscapedPipes(c).trim());
}

const DELIM_CELL_RE = /^\s*:?-+:?\s*$/;

/** Parse one delimiter cell; returns "invalid" when it is not a delimiter. */
export function parseDelimiterCell(cell: string): TableAlignment | "invalid" {
  if (!DELIM_CELL_RE.test(cell)) {
    return "invalid";
  }
  const t = cell.trim();
  const left = t.startsWith(":");
  const right = t.endsWith(":");
  if (left && right) {
    return "center";
  }
  if (right) {
    return "right";
  }
  if (left) {
    return "left";
  }
  return null;
}

/**
 * Detect a GFM table starting at `lines[start]` (header row). The next line
 * must be a delimiter row with the same cell count. Consumes following body
 * rows (lines containing a pipe) until a blank line or a non-table line.
 * Returns null when there is no table at `start`.
 */
export function detectMarkdownTable(
  lines: string[],
  start: number,
): { table: ParsedMarkdownTable; endLine: number } | null {
  if (start < 0 || start + 1 >= lines.length) {
    return null;
  }
  const headerLine = lines[start];
  if (headerLine.indexOf("|") < 0) {
    return null;
  }
  const delimCells = splitTableRow(lines[start + 1]);
  if (delimCells.length === 0) {
    return null;
  }
  const aligns: TableAlignment[] = [];
  for (const c of delimCells) {
    const a = parseDelimiterCell(c);
    if (a === "invalid") {
      return null;
    }
    aligns.push(a);
  }
  const headers = splitTableRow(headerLine);
  // GFM requires the header and delimiter to have the same cell count;
  // this also rejects "text | text" followed by a "---" setext line.
  if (headers.length !== aligns.length || headers.length === 0) {
    return null;
  }
  const rows: string[][] = [];
  let endLine = start + 1;
  for (let i = start + 2; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s*$/.test(line) || line.indexOf("|") < 0) {
      break;
    }
    const cells = splitTableRow(line);
    while (cells.length < headers.length) {
      cells.push("");
    }
    rows.push(cells.slice(0, headers.length));
    endLine = i;
  }
  return { table: { headers, aligns, rows }, endLine };
}

/* ------------------------------------------------------------------ */
/* Pure rendering / serialization (TS side)                           */
/* ------------------------------------------------------------------ */

function escHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Minimal inline-markdown for table cells (TS side): code, links, bold,
 * italic, strikethrough. Only http(s) links become anchors (same policy as
 * the webview's inlineMd).
 */
export function formatInlineCellMd(cell: string): string {
  let s = escHtml(cell);
  s = s.replace(/`([^`\n]+)`/g, "<code>$1</code>");
  s = s.replace(
    /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g,
    '<a href="$2" target="_blank" rel="noopener">$1</a>',
  );
  s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  s = s.replace(/(^|[^*\w])\*([^\n*]+)\*/g, "$1<em>$2</em>");
  s = s.replace(/~~([^~]+)~~/g, "<del>$1</del>");
  return s;
}

function alignAttr(a: TableAlignment): string {
  return a ? ` style="text-align:${a}"` : "";
}

/**
 * Render a parsed table as the chat HTML fragment. The browser bundle's
 * mdTableBlockHtml produces the same markup; keep the two in sync
 * (a unit test compares them on fixtures).
 */
export function renderTableHtml(t: ParsedMarkdownTable): string {
  let html = '<table class="md-table">';
  html += "<thead><tr>";
  for (let i = 0; i < t.headers.length; i++) {
    html += `<th${alignAttr(t.aligns[i])}>${formatInlineCellMd(t.headers[i])}</th>`;
  }
  html += "</tr></thead><tbody>";
  for (const row of t.rows) {
    html += "<tr>";
    for (let i = 0; i < t.headers.length; i++) {
      html += `<td${alignAttr(t.aligns[i])}>${formatInlineCellMd(row[i] ?? "")}</td>`;
    }
    html += "</tr>";
  }
  html += "</tbody></table>";
  return html;
}

/** Regenerate GFM source from a parsed table (the "as Markdown" copy). */
export function tableToMarkdown(t: ParsedMarkdownTable): string {
  const delim = t.aligns
    .map((a) => (a === "left" ? ":---" : a === "right" ? "---:" : a === "center" ? ":---:" : "---"))
    .join(" | ");
  const lines = [
    `| ${t.headers.join(" | ")} |`,
    `| ${delim} |`,
    ...t.rows.map((r) => `| ${r.join(" | ")} |`),
  ];
  return lines.join("\n");
}

function quoteCsvCell(cell: string): string {
  if (/[",\n\r]/.test(cell)) {
    return '"' + cell.replace(/"/g, '""') + '"';
  }
  return cell;
}

/** RFC-4180 CSV. */
export function tableToCsv(t: ParsedMarkdownTable): string {
  const lines = [
    t.headers.map(quoteCsvCell).join(","),
    ...t.rows.map((r) => r.map(quoteCsvCell).join(",")),
  ];
  return lines.join("\r\n");
}

/** TSV (tabs inside cells become spaces — TSV has no quoting convention). */
export function tableToTsv(t: ParsedMarkdownTable): string {
  const clean = (c: string): string => c.replace(/\t/g, " ").replace(/\r?\n/g, " ");
  const lines = [t.headers.map(clean).join("\t"), ...t.rows.map((r) => r.map(clean).join("\t"))];
  return lines.join("\n");
}

/**
 * Rich HTML for the clipboard ("Copy table pastes as a real table into docs
 * and chat apps"): a standalone <table> with inline borders so pasting into
 * Google Docs / Notion / Word keeps the grid even without our CSS.
 */
export function tableToClipboardHtml(t: ParsedMarkdownTable): string {
  const border = "border:1px solid #999;border-collapse:collapse";
  const cellPad = "padding:4px 8px";
  let html = '<table style="' + border + '"><thead><tr>';
  for (let i = 0; i < t.headers.length; i++) {
    const align = t.aligns[i] ? ";text-align:" + t.aligns[i] : "";
    html +=
      '<th style="' +
      border +
      ";" +
      cellPad +
      ";background:#eee" +
      align +
      '">' +
      formatInlineCellMd(t.headers[i]) +
      "</th>";
  }
  html += "</tr></thead><tbody>";
  for (const row of t.rows) {
    html += "<tr>";
    for (let i = 0; i < t.headers.length; i++) {
      const align = t.aligns[i] ? ";text-align:" + t.aligns[i] : "";
      html +=
        '<td style="' +
        border +
        ";" +
        cellPad +
        align +
        '">' +
        formatInlineCellMd(row[i] ?? "") +
        "</td>";
    }
    html += "</tr>";
  }
  html += "</tbody></table>";
  return html;
}

export function tableDownloadFilename(format: TableCopyFormat): string {
  return "table." + (format === "markdown" ? "md" : format);
}

/* ------------------------------------------------------------------ */
/* Browser bundle                                                      */
/*                                                                     */
/* Authored as a real TS function so tsc checks it; serialized with    */
/* Function.prototype.toString() by markdownTableWebviewScript() and   */
/* interpolated into composer.ts's webview <script>. Constraints:      */
/* no imports, no backticks, no "${", no TS-only emit. The bundle      */
/* installs: MD_TABLE_PH, mdTableBlockHtml, ideTableSerialize,         */
/* ideTableToMarkdown/Csv/Tsv/Html, ideCopyTable, ideDownloadTable,    */
/* ideOpenTableModal, ideCloseTableModal, ideInitTableHover.            */
/* ------------------------------------------------------------------ */

function __mdTableBrowserImpl(): void {
  /* markdown-table-expand-copy (markdownTableService): hover toolbar for rendered Markdown tables. */
  var MDT_PIPE_PH = "";
  var MD_TABLE_PH = "";

  function mdtEsc(s: string): string {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function mdtInline(cell: string): string {
    var s = mdtEsc(cell);
    s = s.replace(/\x60([^\x60\n]+)\x60/g, "<code>$1</code>");
    s = s.replace(
      /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g,
      '<a href="$2" target="_blank" rel="noopener">$1</a>',
    );
    s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
    s = s.replace(/(^|[^*\w])\*([^\n*]+)\*/g, "$1<em>$2</em>");
    s = s.replace(/~~([^~]+)~~/g, "<del>$1</del>");
    return s;
  }

  function mdtSplitRow(line: string): string[] {
    var p = String(line).replace(/\\\|/g, MDT_PIPE_PH);
    var cells = p.split("|");
    if (cells.length && /^\s*$/.test(cells[0])) {
      cells = cells.slice(1);
    }
    if (cells.length && /^\s*$/.test(cells[cells.length - 1])) {
      cells = cells.slice(0, -1);
    }
    var out: string[] = [];
    for (var i = 0; i < cells.length; i++) {
      out.push(
        cells[i]
          .split(MDT_PIPE_PH)
          .join("|")
          .replace(/^\s+|\s+$/g, ""),
      );
    }
    return out;
  }

  function mdtAlignOf(cell: string): string | null {
    if (!/^\s*:?-+:?\s*$/.test(cell)) {
      return "invalid";
    }
    var t = cell.replace(/^\s+|\s+$/g, "");
    var l = t.charAt(0) === ":";
    var r = t.charAt(t.length - 1) === ":";
    if (l && r) {
      return "center";
    }
    if (r) {
      return "right";
    }
    if (l) {
      return "left";
    }
    return null;
  }

  function mdtAlignAttr(a: string | null): string {
    return a && a !== "invalid" ? ' style="text-align:' + a + '"' : "";
  }

  interface BrowserTable {
    headers: string[];
    aligns: Array<string | null>;
    rows: string[][];
  }

  /**
   * Block renderer for the webview's renderMarkdown: returns {html, next}
   * (next = last consumed line index) or null. Mirrors the TS-side
   * detectMarkdownTable + renderTableHtml (unit-tested for parity).
   */
  function mdTableBlockHtml(lines: string[], i: number): { html: string; next: number } | null {
    if (i < 0 || i + 1 >= lines.length) {
      return null;
    }
    if (lines[i].indexOf("|") < 0) {
      return null;
    }
    var delim = mdtSplitRow(lines[i + 1]);
    if (!delim.length) {
      return null;
    }
    var aligns: Array<string | null> = [];
    for (var d = 0; d < delim.length; d++) {
      var a = mdtAlignOf(delim[d]);
      if (a === "invalid") {
        return null;
      }
      aligns.push(a);
    }
    var headers = mdtSplitRow(lines[i]);
    if (!headers.length || headers.length !== aligns.length) {
      return null;
    }
    var rows: string[][] = [];
    var next = i + 1;
    for (var r = i + 2; r < lines.length; r++) {
      var line = lines[r];
      if (/^\s*$/.test(line) || line.indexOf("|") < 0) {
        break;
      }
      var cells = mdtSplitRow(line);
      while (cells.length < headers.length) {
        cells.push("");
      }
      rows.push(cells.slice(0, headers.length));
      next = r;
    }
    var html = '<table class="md-table"><thead><tr>';
    for (var h = 0; h < headers.length; h++) {
      html += "<th" + mdtAlignAttr(aligns[h]) + ">" + mdtInline(headers[h]) + "</th>";
    }
    html += "</tr></thead><tbody>";
    for (var b = 0; b < rows.length; b++) {
      html += "<tr>";
      for (var c = 0; c < headers.length; c++) {
        html += "<td" + mdtAlignAttr(aligns[c]) + ">" + mdtInline(rows[b][c] || "") + "</td>";
      }
      html += "</tr>";
    }
    html += "</tbody></table>";
    return { html: html, next: next };
  }

  /** Serialize a rendered <table class="md-table"> back to a model. */
  function ideTableSerialize(table: Element): BrowserTable {
    var headers: string[] = [];
    var aligns: Array<string | null> = [];
    var rows: string[][] = [];
    var headCells = table.querySelectorAll("thead th");
    for (var i = 0; i < headCells.length; i++) {
      var hc = headCells[i] as HTMLElement;
      headers.push(ideTableCellText(hc));
      var st = hc.getAttribute("style") || "";
      var m = st.match(/text-align:\s*(left|center|right)/);
      aligns.push(m ? m[1] : null);
    }
    var bodyRows = table.querySelectorAll("tbody tr");
    for (var r = 0; r < bodyRows.length; r++) {
      var cells = bodyRows[r].querySelectorAll("td");
      var row: string[] = [];
      for (var c = 0; c < headers.length; c++) {
        row.push(cells[c] ? ideTableCellText(cells[c] as HTMLElement) : "");
      }
      rows.push(row);
    }
    return { headers: headers, aligns: aligns, rows: rows };
  }

  function ideTableCellText(cell: Element): string {
    return (cell.textContent || "").replace(/\s+/g, " ").replace(/^\s+|\s+$/g, "");
  }

  function ideTableDelim(t: BrowserTable): string[] {
    var delim: string[] = [];
    for (var i = 0; i < t.aligns.length; i++) {
      var a = t.aligns[i];
      delim.push(a === "left" ? ":---" : a === "right" ? "---:" : a === "center" ? ":---:" : "---");
    }
    return delim;
  }

  function ideTableToMarkdown(t: BrowserTable): string {
    var lines = ["| " + t.headers.join(" | ") + " |", "| " + ideTableDelim(t).join(" | ") + " |"];
    for (var r = 0; r < t.rows.length; r++) {
      lines.push("| " + t.rows[r].join(" | ") + " |");
    }
    return lines.join("\n");
  }

  function mdtQuoteCsv(cell: string): string {
    if (/[",\n\r]/.test(cell)) {
      return '"' + cell.replace(/"/g, '""') + '"';
    }
    return cell;
  }

  function ideTableToCsv(t: BrowserTable): string {
    var lines = [t.headers.map(mdtQuoteCsv).join(",")];
    for (var r = 0; r < t.rows.length; r++) {
      lines.push(t.rows[r].map(mdtQuoteCsv).join(","));
    }
    return lines.join("\r\n");
  }

  function ideTableToTsv(t: BrowserTable): string {
    function clean(c: string): string {
      return String(c).replace(/\t/g, " ").replace(/\r?\n/g, " ");
    }
    var lines = [t.headers.map(clean).join("\t")];
    for (var r = 0; r < t.rows.length; r++) {
      lines.push(t.rows[r].map(clean).join("\t"));
    }
    return lines.join("\n");
  }

  function ideTableToHtml(t: BrowserTable): string {
    var border = "border:1px solid #999;border-collapse:collapse";
    var pad = "padding:4px 8px";
    function al(a: string | null): string {
      return a ? ";text-align:" + a : "";
    }
    var html = '<table style="' + border + '"><thead><tr>';
    for (var i = 0; i < t.headers.length; i++) {
      html +=
        '<th style="' +
        border +
        ";" +
        pad +
        ";background:#eee" +
        al(t.aligns[i]) +
        '">' +
        mdtEsc(t.headers[i]) +
        "</th>";
    }
    html += "</tr></thead><tbody>";
    for (var r = 0; r < t.rows.length; r++) {
      html += "<tr>";
      for (var c = 0; c < t.headers.length; c++) {
        html +=
          '<td style="' +
          border +
          ";" +
          pad +
          al(t.aligns[c]) +
          '">' +
          mdtEsc(t.rows[r][c] || "") +
          "</td>";
      }
      html += "</tr>";
    }
    return html + "</tbody></table>";
  }

  function ideCopyTable(table: Element, format: string): Promise<void> {
    var t = ideTableSerialize(table);
    var md = ideTableToMarkdown(t);
    var text = format === "csv" ? ideTableToCsv(t) : format === "tsv" ? ideTableToTsv(t) : md;
    var html = ideTableToHtml(t);
    var nav = navigator as unknown as {
      clipboard?: {
        write?: (items: unknown[]) => Promise<void>;
        writeText?: (text: string) => Promise<void>;
      };
    };
    function fallbackPlain(): Promise<void> {
      if (nav.clipboard && nav.clipboard.writeText) {
        return nav.clipboard.writeText(text);
      }
      var ta = document.createElement("textarea") as HTMLTextAreaElement;
      ta.value = text;
      ta.setAttribute("readonly", "");
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      try {
        (document as unknown as { execCommand: (cmd: string) => void }).execCommand("copy");
      } catch (e) {
        /* clipboard unavailable — nothing more we can do */
      }
      document.body.removeChild(ta);
      return Promise.resolve();
    }
    /* "Copy table" pastes as a real table into docs/chat apps (text/html)
       or as Markdown into plain text (text/plain) — per release notes. */
    var ClipboardItemCtor = (globalThis as unknown as {
      ClipboardItem?: new (data: Record<string, unknown>) => unknown;
    }).ClipboardItem;
    var BlobCtor = (globalThis as unknown as { Blob?: new (parts: unknown[], opts: unknown) => unknown })
      .Blob;
    if (
      format === "rich" &&
      nav.clipboard &&
      nav.clipboard.write &&
      ClipboardItemCtor &&
      BlobCtor
    ) {
      var item = new ClipboardItemCtor({
        "text/html": new BlobCtor([html], { type: "text/html" }),
        "text/plain": new BlobCtor([md], { type: "text/plain" }),
      });
      return nav.clipboard.write([item]).catch(function () {
        return fallbackPlain();
      });
    }
    return fallbackPlain();
  }

  function ideDownloadTable(table: Element, format: string): void {
    var t = ideTableSerialize(table);
    var text = format === "csv" ? ideTableToCsv(t) : ideTableToMarkdown(t);
    var ext = format === "csv" ? "csv" : "md";
    var mime = format === "csv" ? "text/csv" : "text/markdown";
    var blob = new Blob([text], { type: mime + ";charset=utf-8" });
    var url = URL.createObjectURL(blob);
    var a = document.createElement("a") as HTMLAnchorElement;
    a.href = url;
    a.download = "table." + ext;
    document.body.appendChild(a);
    a.click();
    setTimeout(function () {
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    }, 100);
  }

  /** Full-size view: wrapped columns + working links. */
  function ideOpenTableModal(table: Element): void {
    ideCloseTableModal();
    var overlay = document.createElement("div");
    overlay.className = "md-table-modal-overlay";
    overlay.setAttribute("role", "dialog");
    overlay.setAttribute("aria-modal", "true");
    overlay.setAttribute("aria-label", "Expanded table");
    var panel = document.createElement("div");
    panel.className = "md-table-modal-panel";
    var bar = document.createElement("div");
    bar.className = "md-table-modal-bar";
    var title = document.createElement("span");
    title.className = "md-table-modal-title";
    title.textContent = "Table";
    var close = document.createElement("button") as HTMLButtonElement;
    close.className = "md-table-modal-close";
    close.setAttribute("aria-label", "Close");
    close.textContent = "×";
    close.addEventListener("click", function () {
      ideCloseTableModal();
    });
    bar.appendChild(title);
    bar.appendChild(close);
    var body = document.createElement("div");
    body.className = "md-table-modal-body";
    var clone = table.cloneNode(true) as Element;
    clone.removeAttribute("id");
    body.appendChild(clone);
    panel.appendChild(bar);
    panel.appendChild(body);
    overlay.appendChild(panel);
    overlay.addEventListener("click", function (e) {
      if (e.target === overlay) {
        ideCloseTableModal();
      }
    });
    document.addEventListener("keydown", ideTableModalKeydown);
    document.body.appendChild(overlay);
    close.focus();
  }

  function ideTableModalKeydown(e: KeyboardEvent): void {
    if (e && (e.key === "Escape" || e.keyCode === 27)) {
      ideCloseTableModal();
    }
  }

  function ideCloseTableModal(): void {
    var prev = document.querySelector(".md-table-modal-overlay");
    if (prev && prev.parentNode) {
      prev.parentNode.removeChild(prev);
    }
    document.removeEventListener("keydown", ideTableModalKeydown);
  }

  function ideMakeTableButton(label: string, onClick: () => void, cls: string): HTMLElement {
    var b = document.createElement("button") as HTMLButtonElement;
    b.className = cls || "md-table-btn";
    b.type = "button";
    b.textContent = label;
    b.setAttribute("aria-label", label);
    b.addEventListener("click", function (e) {
      e.stopPropagation();
      onClick();
    });
    return b;
  }

  /**
   * Hover toolbar: "Expand table" + "Copy table" beside the table, extra
   * formats in an overflow menu. Idempotent across streaming re-renders
   * (data-ide-table-wired guard). Only touches tables the markdown renderer
   * produced (table.md-table) — never foreign tables.
   */
  function ideInitTableHover(root: Element): void {
    if (!root || typeof root.querySelectorAll !== "function") {
      return;
    }
    var tables = root.querySelectorAll("table.md-table");
    for (var i = 0; i < tables.length; i++) {
      (function (table: Element): void {
        var te = table as HTMLElement;
        if (te.getAttribute("data-ide-table-wired")) {
          return;
        }
        te.setAttribute("data-ide-table-wired", "1");
        var wrap = document.createElement("div");
        wrap.className = "md-table-wrap";
        if (!table.parentNode) {
          return;
        }
        table.parentNode.insertBefore(wrap, table);
        wrap.appendChild(table);
        var bar = document.createElement("div");
        bar.className = "md-table-toolbar";
        bar.setAttribute("role", "toolbar");
        bar.setAttribute("aria-label", "Table actions");
        bar.appendChild(
          ideMakeTableButton("Expand table", function () {
            ideOpenTableModal(table);
          }, "md-table-btn"),
        );
        bar.appendChild(
          ideMakeTableButton("Copy table", function () {
            ideCopyTable(table, "rich");
          }, "md-table-btn"),
        );
        var menu = document.createElement("div");
        menu.className = "md-table-menu";
        menu.style.display = "none";
        menu.setAttribute("role", "menu");
        var items: Array<[string, () => void]> = [
          [
            "Copy table as Markdown",
            function () {
              ideCopyTable(table, "markdown");
            },
          ],
          [
            "Copy table as CSV",
            function () {
              ideCopyTable(table, "csv");
            },
          ],
          [
            "Copy table as TSV",
            function () {
              ideCopyTable(table, "tsv");
            },
          ],
          [
            "Download table as Markdown",
            function () {
              ideDownloadTable(table, "markdown");
            },
          ],
          [
            "Download table as CSV",
            function () {
              ideDownloadTable(table, "csv");
            },
          ],
        ];
        for (var k = 0; k < items.length; k++) {
          (function (label: string, fn: () => void): void {
            var mi = ideMakeTableButton(
              label,
              function () {
                menu.style.display = "none";
                moreBtn.setAttribute("aria-expanded", "false");
                fn();
              },
              "md-table-menuitem",
            );
            mi.setAttribute("role", "menuitem");
            menu.appendChild(mi);
          })(items[k][0], items[k][1]);
        }
        var moreBtn = ideMakeTableButton(
          "More",
          function () {
            var open = menu.style.display !== "none";
            menu.style.display = open ? "none" : "block";
            moreBtn.setAttribute("aria-expanded", open ? "false" : "true");
          },
          "md-table-btn",
        );
        moreBtn.setAttribute("aria-haspopup", "true");
        moreBtn.setAttribute("aria-expanded", "false");
        moreBtn.setAttribute("aria-label", "More table actions");
        bar.appendChild(moreBtn);
        bar.appendChild(menu);
        wrap.appendChild(bar);
      })(tables[i]);
    }
  }

  var g = globalThis as unknown as Record<string, unknown>;
  g["MD_TABLE_PH"] = MD_TABLE_PH;
  g["mdTableBlockHtml"] = mdTableBlockHtml;
  g["ideTableSerialize"] = ideTableSerialize;
  g["ideTableToMarkdown"] = ideTableToMarkdown;
  g["ideTableToCsv"] = ideTableToCsv;
  g["ideTableToTsv"] = ideTableToTsv;
  g["ideTableToHtml"] = ideTableToHtml;
  g["ideCopyTable"] = ideCopyTable;
  g["ideDownloadTable"] = ideDownloadTable;
  g["ideOpenTableModal"] = ideOpenTableModal;
  g["ideCloseTableModal"] = ideCloseTableModal;
  g["ideInitTableHover"] = ideInitTableHover;
}

/**
 * The browser-side implementation as a runnable script string. The returned
 * source is the compiled __mdTableBrowserImpl plus an immediate invocation
 * that installs the API on globalThis.
 */
export function markdownTableWebviewScript(): string {
  return __mdTableBrowserImpl.toString() + "\n__mdTableBrowserImpl();";
}
