/**
 * checkpointDiff.ts — PURE module (no vscode import).
 *
 * Diff-based file snapshots for Cursor-style checkpoints, factored out of
 * CheckpointService so it is unit-testable under plain node (node:test).
 *
 * Binary evidence (OBSERVED — Cursor 3.25.6/3.25.9; see
 * docs/rea/deepdig-runtime-checkpoint-2026-10-19.md §2 and
 * docs/rea/dig-continuous-checkpoint-ui-2026-10-19.md §4):
 *  - each file record in a checkpoint carries `originalModelDiffWrtV0`
 *    (the original model's diff with respect to "v0"), NOT full contents;
 *  - restore runs `applyDiffToLines(currentLines, originalModelDiffWrtV0)`
 *    and writes the result back (`D.join("\n")`) when it differs from the
 *    current content;
 *  - the isSame check reconstructs expected lines via
 *    `getCodeBlockLinesByDiff(uri, originalModelDiffWrtV0)` and compares
 *    them against current on-disk contents with `areContentsEqual`.
 *
 * HONEST-DIVERGENCE / UNKNOWN: the REA docs record the identifier
 * `originalModelDiffWrtV0` and the apply-on-revert shape, but NOT Cursor's
 * exact diff wire format, the precise definition of "v0", or
 * applyDiffToLines' internals. The encoding below is our own line-edit
 * format engineered to satisfy the observed contract — no parity is claimed
 * for the wire format itself:
 *  - v0 (base) = the file's content at its first snapshot in this session.
 *    CheckpointService keeps one base per file (persisted alongside the
 *    checkpoint records) and never mutates it afterwards.
 *  - originalModelDiffWrtV0 = line edits transforming v0 -> the original
 *    (pre-edit) content captured at snapshot time.
 *  - applyDiffToLines(currentLines, diff, baseLines) reconstructs the
 *    original lines exactly from (base + diff). `currentLines` participates
 *    only through the identity fast-path (return the input unchanged when
 *    the checkpoint state already matches — mirrors Cursor's observed
 *    "only setValue when the result differs" guard). Reconstruction does
 *    NOT depend on currentLines, so restore is exact even when the file
 *    changed arbitrarily since the snapshot — unlike positional patch
 *    application, which would misfire on shifted line numbers.
 *  - Cursor's applyDiffToLines takes (currentLines, diff); ours takes an
 *    explicit baseLines third argument because reconstruction requires the
 *    base. Callers pass the session base map.
 */

import { createHash } from "node:crypto";

/** One line-range replacement, in BASE (v0) coordinates. */
export interface LineEdit {
  /** 0-based start offset into the base lines (inclusive). */
  start: number;
  /** 0-based end offset into the base lines (exclusive). */
  end: number;
  /** The ORIGINAL's lines for [start, end). */
  text: string[];
}

/**
 * The original (pre-edit) model's diff with respect to v0.
 * Identifier verbatim from the Cursor binary (OBSERVED).
 */
export interface OriginalModelDiffWrtV0 {
  /** sha1 hex of the base (v0) content this diff was computed from. */
  baseHash: string;
  /** Line count of the base content. */
  baseLineCount: number;
  /** Ascending, non-overlapping edits in base coordinates. */
  edits: LineEdit[];
}

function splitLines(s: string): string[] {
  // Inverse of Cursor's observed `D.join("\n")` — round-trips exactly,
  // including trailing-newline files ("" after the last \n) and \r\n files
  // (\r stays glued to its line on both sides).
  return s.split("\n");
}

export function sha1Hex(s: string): string {
  return createHash("sha1").update(s, "utf8").digest("hex");
}

/** Structural validity check — never throws. */
export function isValidDiff(diff: unknown): diff is OriginalModelDiffWrtV0 {
  if (!diff || typeof diff !== "object") {
    return false;
  }
  const d = diff as Record<string, unknown>;
  if (typeof d.baseHash !== "string" || !/^[0-9a-f]{40}$/.test(d.baseHash)) {
    return false;
  }
  if (typeof d.baseLineCount !== "number" || !Number.isInteger(d.baseLineCount) || d.baseLineCount < 0) {
    return false;
  }
  if (!Array.isArray(d.edits)) {
    return false;
  }
  for (const e of d.edits) {
    if (!e || typeof e !== "object") {
      return false;
    }
    const edit = e as Record<string, unknown>;
    if (
      typeof edit.start !== "number" || !Number.isInteger(edit.start) || edit.start < 0 ||
      typeof edit.end !== "number" || !Number.isInteger(edit.end) || edit.end < edit.start ||
      !Array.isArray(edit.text) || edit.text.some((t) => typeof t !== "string")
    ) {
      return false;
    }
  }
  return true;
}

// ------------------------------------------------------------------ //
// Diff computation (Myers O(ND), line-based)                          //
// ------------------------------------------------------------------ //

interface RawEdit {
  start: number;
  end: number;
  text: string[];
}

/**
 * Merge adjacent/overlapping raw edits into one replacement each.
 * Input must be in ascending base-coordinate order (myersEdits guarantees
 * this after its reverse). Semantics-preserving: replacing [s1,e1)+[s2,e2)
 * piecewise with t1 then t2 equals replacing [s1,max(e1,e2)) with t1+t2
 * whenever s2 <= e1.
 */
function mergeRawEdits(raw: RawEdit[]): RawEdit[] {
  const out: RawEdit[] = [];
  for (const e of raw) {
    const last = out[out.length - 1];
    if (last && e.start <= last.end) {
      last.end = Math.max(last.end, e.end);
      last.text.push(...e.text);
    } else {
      out.push({ start: e.start, end: e.end, text: e.text.slice() });
    }
  }
  return out;
}

/**
 * Myers diff producing edits that transform a -> b (both line arrays).
 * Returns ascending, non-overlapping {start,end,text} in a-coordinates.
 */
function myersEdits(a: string[], b: string[]): RawEdit[] {
  const n = a.length;
  const m = b.length;
  if (n === 0) {
    return m === 0 ? [] : [{ start: 0, end: 0, text: b.slice() }];
  }
  if (m === 0) {
    return [{ start: 0, end: n, text: [] }];
  }
  const max = n + m;
  const off = max;
  const size = 2 * max + 1;
  let v = new Int32Array(size).fill(-1);
  v[off + 1] = 0;
  const trace: Int32Array[] = [];
  let solutionD = -1;
  for (let d = 0; d <= max; d++) {
    const cur = new Int32Array(size).fill(-1);
    let done = false;
    for (let k = -d; k <= d; k += 2) {
      let x: number;
      if (k === -d || (k !== d && v[off + k - 1] < v[off + k + 1])) {
        x = v[off + k + 1]; // down: insertion from b
      } else {
        x = v[off + k - 1] + 1; // right: deletion from a
      }
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x++;
        y++;
      }
      cur[off + k] = x;
      if (x >= n && y >= m) {
        solutionD = d;
        done = true;
        break;
      }
    }
    trace.push(cur);
    if (done) {
      break;
    }
    v = cur;
  }
  // Backtrack from (n, m): d = D .. 1, emitting one single-line edit per
  // step (insertions/deletions), then merge into range replacements.
  const raw: RawEdit[] = [];
  let x = n;
  let y = m;
  for (let d = solutionD; d >= 1; d--) {
    const prev = trace[d - 1];
    const k = x - y;
    const down = k === -d || (k !== d && prev[off + k - 1] < prev[off + k + 1]);
    const prevK = down ? k + 1 : k - 1;
    const prevX = prev[off + prevK];
    const prevY = prevX - prevK;
    // Unwind the snake: the forward walk added exactly one non-diagonal
    // step plus s diagonal pairs, so removing pairs while both coordinates
    // exceed the previous point lands exactly on the single edit step.
    while (x > prevX && y > prevY) {
      x--;
      y--;
    }
    if (x === prevX) {
      raw.push({ start: prevX, end: prevX, text: [b[prevY]] }); // insertion
    } else {
      raw.push({ start: prevX, end: prevX + 1, text: [] }); // deletion
    }
    x = prevX;
    y = prevY;
  }
  raw.reverse();
  return mergeRawEdits(raw);
}

/**
 * Compute originalModelDiffWrtV0 for (base -> original).
 *
 * Common prefix/suffix trimming first: the overwhelmingly common checkpoint
 * case (small localized edits) reduces Myers to a tiny middle. When the
 * trimmed middle is too large for bounded Myers (product > 1M line-pairs),
 * falls back to a single whole-range replacement — still exactly correct,
 * just less space-efficient.
 */
export function computeLineDiff(base: string, original: string): OriginalModelDiffWrtV0 {
  const baseLines = splitLines(base);
  const baseHash = sha1Hex(base);
  if (base === original) {
    return { baseHash, baseLineCount: baseLines.length, edits: [] };
  }
  const origLines = splitLines(original);
  let prefix = 0;
  const maxPrefix = Math.min(baseLines.length, origLines.length);
  while (prefix < maxPrefix && baseLines[prefix] === origLines[prefix]) {
    prefix++;
  }
  let suffix = 0;
  const maxSuffix = Math.min(baseLines.length - prefix, origLines.length - prefix);
  while (
    suffix < maxSuffix &&
    baseLines[baseLines.length - 1 - suffix] === origLines[origLines.length - 1 - suffix]
  ) {
    suffix++;
  }
  const aMid = baseLines.slice(prefix, baseLines.length - suffix);
  const bMid = origLines.slice(prefix, origLines.length - suffix);
  let edits: LineEdit[];
  if (aMid.length * bMid.length > 1_000_000) {
    edits = [{ start: prefix, end: baseLines.length - suffix, text: bMid }];
  } else {
    edits = myersEdits(aMid, bMid).map((e) => ({
      start: e.start + prefix,
      end: e.end + prefix,
      text: e.text,
    }));
  }
  return { baseHash, baseLineCount: baseLines.length, edits };
}

// ------------------------------------------------------------------ //
// Diff application                                                     //
// ------------------------------------------------------------------ //

/**
 * Apply validated edits to base lines. Returns undefined when any edit is
 * out of bounds, overlapping, or misordered (corrupt diff) — the caller
 * treats this as "no original file state found" and skips the file, mirroring
 * Cursor's observed per-file skip on missing original state.
 */
function applyEditsToLines(baseLines: string[], edits: LineEdit[]): string[] | undefined {
  const out: string[] = [];
  let pos = 0;
  for (const e of edits) {
    if (e.start < pos || e.end < e.start || e.end > baseLines.length) {
      return undefined;
    }
    for (let i = pos; i < e.start; i++) {
      out.push(baseLines[i]);
    }
    for (const t of e.text) {
      out.push(t);
    }
    pos = e.end;
  }
  for (let i = pos; i < baseLines.length; i++) {
    out.push(baseLines[i]);
  }
  return out;
}

/**
 * Cursor's observed `getCodeBlockLinesByDiff(uri, originalModelDiffWrtV0)`
 * equivalent: reconstruct the original (pre-edit) lines from (base + diff).
 * Returns undefined when the diff is structurally invalid, the base line
 * count/hash doesn't match (corrupt or mismatched base), or an edit is out
 * of bounds.
 */
export function reconstructOriginalLines(
  diff: OriginalModelDiffWrtV0,
  baseLines: string[],
): string[] | undefined {
  if (!isValidDiff(diff)) {
    return undefined;
  }
  if (baseLines.length !== diff.baseLineCount) {
    return undefined;
  }
  if (sha1Hex(baseLines.join("\n")) !== diff.baseHash) {
    return undefined;
  }
  return applyEditsToLines(baseLines, diff.edits);
}

/**
 * Cursor binary identifier (OBSERVED). Applies `originalModelDiffWrtV0` to
 * reconstruct the checkpoint-state lines.
 *
 * HONEST-DIVERGENCE: Cursor's exact two-argument behavior is UNKNOWN beyond
 * the identifier; reconstruction fundamentally needs the base, so ours takes
 * it explicitly as `baseLines` (the session's v0 content for this file).
 * `currentLines` drives only the identity fast-path: when the reconstructed
 * lines already equal the current content, the input array is returned
 * unchanged (mirrors Cursor's observed "only setValue when the result
 * differs" guard). Reconstruction itself never depends on currentLines, so
 * restore is exact no matter how much the file changed since the snapshot.
 *
 * Returns undefined when the original state cannot be reconstructed
 * (invalid diff / base mismatch) — the caller must skip the file, like
 * Cursor's "[composer] No original file state found" path.
 */
export function applyDiffToLines(
  currentLines: string[],
  diff: OriginalModelDiffWrtV0,
  baseLines: string[],
): string[] | undefined {
  const reconstructed = reconstructOriginalLines(diff, baseLines);
  if (!reconstructed) {
    return undefined;
  }
  if (
    reconstructed.length === currentLines.length &&
    reconstructed.every((line, i) => line === currentLines[i])
  ) {
    return currentLines;
  }
  return reconstructed;
}
