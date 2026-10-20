import * as path from "path";
import * as vscode from "vscode";
import { IdeCodeEngineAdapter } from "./ideCodeEngineAdapter";
import { defaultEnginePath } from "./composerDataService";
import { takePendingSelection } from "./inlinePromptSelection";
import { tryGetAiCodeTracking } from "./aiCodeTracking";

/**
 * DD-SB-5: file key for aiCodeTracking attribution — workspace-relative when
 * possible (matches repo-relative paths at score time for the common
 * workspace-root repo layout), else the absolute path.
 */
function trackingFileKey(uri: vscode.Uri): string {
  try {
    return vscode.workspace.asRelativePath(uri);
  } catch {
    return uri.fsPath;
  }
}

/**
 * InlineEditService — Cursor-style Cmd+K inline edit.
 *
 * Flow: prompt (quick input) → engine generates replacement code →
 * inline diff preview (applied + decorated) → accept (Ctrl+Enter) /
 * reject (Esc) → optional follow-up refinement.
 *
 * How Cursor does it (docs/inline-edit, deep-docs-all.md):
 *   C1 prompt bar at cursor · C2 inline generation (no selection) ·
 *   C3 inline edits on selection · C4 follow-up refines the edit ·
 *   C5 question mode (ask without editing) · C6 "do it" applies the
 *   suggested change · C7 default context gathering · C8 escalate to Agent.
 *
 * Two honest deviations from Cursor, forced by the VS Code extension API:
 *  - The prompt is a native quick-input box, not a cursor-anchored widget
 *    (the public API exposes no cursor-anchored input surface).
 *  - The default keybinding is Ctrl+I / Cmd+I. Cursor's Ctrl+K / Cmd+K are
 *    chord-prefix keys in stock VS Code; hijacking them would break every
 *    Ctrl+K / Cmd+K chord (comment, fold, …). Cursor's question-mode
 *    Alt+Enter and in-bar Cmd+L are exposed as explicit buttons on the
 *    input box — same behavior, since keys can't be intercepted inside a
 *    quick-input.
 */

export const INLINE_EDIT_CONTEXT_KEY = "ideAgent.inlineEditPending";

// NOTE (binary evidence, 2026-10-19, Cursor 3.25.9 glass bundle):
// zero hits for 6000/60000; no escalation/question flows in CmdK; Cursor
// sends the full `query_history` linked list via proto `CmdKQueryHistory`.
// The inline-edit char caps (follow-up history 6000, escalation 4000,
// question 8000) were fabricated — they are removed. The target/selection
// and prior attempts are passed to the model whole; any real token limits
// are enforced server-side by the model endpoint, not by client truncation.
const CONTEXT_LINES = 40; // UNKNOWN: no binary evidence for a Cursor-side
const CONTEXT_CHARS = 4_000; // surrounding-context window — kept as a local
// default only; do NOT claim parity with Cursor.

/** One contiguous changed region between the original and proposed text. */
export interface DiffHunk {
  /** 0-based line range in the ORIGINAL text (end exclusive). */
  origStart: number;
  origEnd: number;
  /** 0-based line range in the PROPOSED text (end exclusive). */
  newStart: number;
  newEnd: number;
}

function getV(v: Map<number, number>, k: number): number {
  const val = v.get(k);
  // Unset diagonals are never read by the forward pass (only k±1 of visited
  // diagonals are ever queried); -1 is a safe fallback, not a live value.
  return val === undefined ? -1 : val;
}

type DiffOp =
  | { t: 0; a: number; b: number }
  | { t: 1; a: number; b: number }
  | { t: 2; a: number; b: number };

/**
 * Myers O(ND) line diff. Pure function — no VS Code dependency.
 * Returns hunks in document order.
 */
export function lineDiff(a: string[], b: string[]): DiffHunk[] {
  const n = a.length;
  const m = b.length;
  if (n === 0 && m === 0) return [];
  const max = n + m;
  let v = new Map<number, number>();
  v.set(1, 0);
  const trace: Array<Map<number, number>> = [];
  let done = false;
  for (let d = 0; d <= max && !done; d++) {
    const prev = v;
    const cur = new Map<number, number>();
    for (let k = -d; k <= d; k += 2) {
      let x: number;
      if (k === -d || (k !== d && getV(prev, k - 1) < getV(prev, k + 1))) {
        x = getV(prev, k + 1); // down: line inserted in b
      } else {
        x = getV(prev, k - 1) + 1; // right: line deleted from a
      }
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x++;
        y++;
      }
      cur.set(k, x);
      if (x >= n && y >= m) {
        done = true;
        break;
      }
    }
    trace.push(cur);
    v = cur;
  }

  // Backtrack from (n, m) to build the edit script (reversed).
  const ops: DiffOp[] = [];
  let x = n;
  let y = m;
  for (let d = trace.length - 1; d >= 1; d--) {
    const prev = trace[d - 1]!;
    const k = x - y;
    let prevK: number;
    if (k === -d || (k !== d && getV(prev, k - 1) < getV(prev, k + 1))) {
      prevK = k + 1; // came down: insertion
    } else {
      prevK = k - 1; // came right: deletion
    }
    const prevX = getV(prev, prevK);
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      x--;
      y--;
      ops.push({ t: 0, a: x, b: y });
    }
    if (x === prevX) {
      // Insertion of b[prevY].
      ops.push({ t: 2, a: prevX, b: prevY });
      y = prevY;
    } else {
      // Deletion of a[prevX].
      ops.push({ t: 1, a: prevX, b: prevY });
      x = prevX;
    }
    x = prevX;
    y = prevY;
  }
  // d = 0: remaining common prefix.
  while (x > 0 && y > 0) {
    x--;
    y--;
    ops.push({ t: 0, a: x, b: y });
  }
  ops.reverse();

  // Group consecutive non-equal ops into hunks.
  const hunks: DiffHunk[] = [];
  let i = 0;
  while (i < ops.length) {
    if (ops[i]!.t === 0) {
      i++;
      continue;
    }
    let origStart = -1;
    let origEnd = -1;
    let newStart = -1;
    let newEnd = -1;
    while (i < ops.length && ops[i]!.t !== 0) {
      const o = ops[i]!;
      if (o.t === 1) {
        if (origStart < 0) origStart = o.a;
        origEnd = o.a + 1;
        if (newStart < 0) {
          newStart = o.b;
          newEnd = o.b;
        }
      } else {
        if (newStart < 0) newStart = o.b;
        newEnd = o.b + 1;
        if (origStart < 0) {
          origStart = o.a;
          origEnd = o.a;
        }
      }
      i++;
    }
    hunks.push({ origStart, origEnd, newStart, newEnd });
  }
  return hunks;
}

// ------------------------------------------------------------------
// Partial-diff core (Cursor 3.25.9 parity).
//
// Binary evidence (dig-continuous-inline-edit-2026-10-19, §3.3/§5):
// - `inlineDiffController.showDiff()`: each diff has `zoneWidgets` and
//   `partialWidgets` (id = diffId + "-partial" + index) — every individual
//   hunk/change gets its own accept/reject controls, not just accept-all.
// - Commands: `editor.action.inlineDiffs.acceptPartialEdit`
//   ("Accept Partial Edit", Win Ctrl+Shift+Y / mac Cmd+Y, weight 500) and
//   `editor.action.inlineDiffs.rejectPartialEdit`
//   ("Reject Partial Edit", Ctrl/Cmd+N, weight 500).
// - Telemetry: "Accepted Partial Diff" / "Rejected Partial Diff"
//   (distinct from "Accepted Diff" / "Rejected Diff").
// - Navigation: Alt+J/K next/previous change, Alt+H/L next/previous diff
//   file.
//
// All helpers below are pure (no VS Code dependency) and unit-tested in
// src/services/test/run-partial-diff-tests.ts.
// ------------------------------------------------------------------

/**
 * Per-hunk resolution state inside a pending inline-edit preview.
 * "pending" = shown as proposed, awaiting a decision;
 * "accepted" = committed to the file (partial accept);
 * "rejected" = reverted to the original lines (partial reject).
 */
export type InlineHunkState = "pending" | "accepted" | "rejected";

/** Merged text plus where each hunk landed inside it. */
export interface MergedHunks {
  lines: string[];
  /**
   * hunkRanges[i] = 0-based [start, end) line range of hunk i inside
   * `lines`. Index-aligned with the hunks passed to mergeHunks.
   */
  hunkRanges: Array<{ start: number; end: number }>;
}

/**
 * Merge original/proposed line arrays according to per-hunk states.
 * Pending and accepted hunks contribute the proposed lines (the preview
 * already shows them); rejected hunks contribute the original lines.
 * Pure — no VS Code dependency.
 */
export function mergeHunks(
  origLines: string[],
  newLines: string[],
  hunks: DiffHunk[],
  states: readonly InlineHunkState[],
): MergedHunks {
  if (hunks.length !== states.length) {
    throw new Error(
      `mergeHunks: got ${hunks.length} hunks but ${states.length} states`,
    );
  }
  const lines: string[] = [];
  const hunkRanges: Array<{ start: number; end: number }> = [];
  let o = 0;
  for (let i = 0; i < hunks.length; i++) {
    const h = hunks[i]!;
    // Equal prefix between the previous hunk and this one — identical in
    // both texts by construction of lineDiff.
    while (o < h.origStart) {
      lines.push(origLines[o]!);
      o++;
    }
    const start = lines.length;
    if (states[i] === "rejected") {
      for (let k = h.origStart; k < h.origEnd; k++) {
        lines.push(origLines[k]!);
      }
    } else {
      for (let k = h.newStart; k < h.newEnd; k++) {
        lines.push(newLines[k]!);
      }
    }
    hunkRanges.push({ start, end: lines.length });
    o = h.origEnd;
  }
  while (o < origLines.length) {
    lines.push(origLines[o]!);
    o++;
  }
  return { lines, hunkRanges };
}

/**
 * Immutable per-hunk state transition. Throws RangeError on a bad index —
 * callers resolve the index via nextPendingHunkIndex first.
 */
export function setHunkState(
  states: readonly InlineHunkState[],
  index: number,
  state: InlineHunkState,
): InlineHunkState[] {
  if (!Number.isInteger(index) || index < 0 || index >= states.length) {
    throw new RangeError(
      `setHunkState: hunk index ${index} out of range (0..${states.length - 1})`,
    );
  }
  const next = states.slice();
  next[index] = state;
  return next;
}

/**
 * Next/previous PENDING hunk index, wrapping around the hunk list.
 * direction: +1 (Alt+J) / -1 (Alt+K).
 * `fromIndex` is the navigation cursor and may be -1 (unset): +1 starts at
 * the first hunk, -1 at the last hunk; an out-of-range cursor is treated as
 * unset. Returns -1 when no hunk is pending.
 */
export function nextPendingHunkIndex(
  states: readonly InlineHunkState[],
  fromIndex: number,
  direction: 1 | -1,
): number {
  const total = states.length;
  if (total === 0) return -1;
  const mod = (v: number): number => ((v % total) + total) % total;
  const start =
    fromIndex >= 0 && fromIndex < total ? mod(fromIndex + direction) : direction === 1 ? 0 : total - 1;
  for (let step = 0; step < total; step++) {
    const idx = mod(start + direction * step);
    if (states[idx] === "pending") return idx;
  }
  return -1;
}

/**
 * Cursor 3.25.9 inline-diff analytics event names, verbatim from the glass
 * bundle (dig-continuous-inline-edit-2026-10-19 §4).
 *
 * HONEST DIVERGENCE: this codebase has no telemetry backend, so the
 * service only records these names into an in-memory per-preview log
 * (see InlineSession.telemetry / getTelemetryLog). The names are kept
 * verbatim so a future backend sends exactly what Cursor sends.
 */
export const INLINE_EDIT_TELEMETRY = {
  acceptedDiff: "Accepted Diff",
  rejectedDiff: "Rejected Diff",
  acceptedPartialDiff: "Accepted Partial Diff",
  rejectedPartialDiff: "Rejected Partial Diff",
  cancelledDiff: "Cancelled Diff",
} as const;

const FENCE_ALIASES: Record<string, string> = {
  typescript: "ts",
  javascript: "js",
  python: "py",
  csharp: "cs",
  shellscript: "sh",
};

/**
 * Extract the generated code from an engine response. Prefers a fenced block
 * matching the document language, else the first fenced block, else the whole
 * trimmed response (the prompt instructs code-only output).
 */
export function extractCodeBlock(text: string, languageId: string): string | undefined {
  const blocks: Array<{ lang: string; code: string }> = [];
  const re = /```([^\s`]*)\s*\n([\s\S]*?)```/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    blocks.push({ lang: match[1]!.toLowerCase(), code: match[2]! });
  }
  if (blocks.length === 0) {
    const trimmed = text.trim();
    return trimmed ? trimmed : undefined;
  }
  const lang = languageId.toLowerCase();
  const wanted = new Set([lang, FENCE_ALIASES[lang] ?? ""].filter(Boolean));
  const hit = blocks.find((blk) => wanted.has(blk.lang)) ?? blocks[0]!;
  return hit.code.replace(/\n+$/, "");
}

/**
 * PERF-PROTECTION (Cursor parity — binary evidence 2026-10-19, Cursor 3.25.9
 * glass bundle):
 * - Setting `cursor.inlineDiff.enablePerformanceProtection` (default true):
 *   "Enable performance protection for inline diffs. When enabled, inline
 *   diff decorations will be suppressed if there are too many changes to
 *   prevent editor unresponsiveness."
 * - Threshold from experiment `inline_diff_performance_config.maxDecorations`
 *   (default 100). Over the threshold Cursor suppresses decorations
 *   (`s && this.changes.length > o && r.splice(0)`), calls
 *   `notifySuppressedDiffVisible`, and shows a notification dismissible via
 *   `neverShowAgain: {id: "inlineDiff.tooManyChangesWarning"}`.
 * Ours: `ide.inlineDiff.enablePerformanceProtection` /
 * `ide.inlineDiff.maxDecorations`. `this.changes` maps to our diff `hunks`.
 */

/** Configuration section for the inline-diff perf-protection settings. */
export const INLINE_DIFF_PERF_CONFIG_SECTION = "ide.inlineDiff";
/** Default threshold — verbatim from `inline_diff_performance_config.maxDecorations`. */
export const INLINE_DIFF_MAX_DECORATIONS_DEFAULT = 100;
/**
 * Verbatim warning id (Cursor's `neverShowAgain` id). The public VS Code API
 * has no `neverShowAgain` option (Cursor uses its internal notification
 * service), so the dismissal is persisted in extension globalState instead.
 */
export const INLINE_DIFF_TOO_MANY_CHANGES_WARNING_ID = "ide.inlineDiff.tooManyChangesWarning";

export interface InlineDiffPerfProtection {
  enablePerformanceProtection: boolean;
  maxDecorations: number;
}

export function readInlineDiffPerfConfig(
  cfg: Pick<vscode.WorkspaceConfiguration, "get"> = vscode.workspace.getConfiguration(
    INLINE_DIFF_PERF_CONFIG_SECTION,
  ),
): InlineDiffPerfProtection {
  return {
    enablePerformanceProtection: cfg.get<boolean>("enablePerformanceProtection", true),
    maxDecorations: cfg.get<number>("maxDecorations", INLINE_DIFF_MAX_DECORATIONS_DEFAULT),
  };
}

/**
 * PARTIAL-ACCEPTS TOGGLE for inline-edit hunk accept/reject.
 *
 * HONEST-DIVERGENCE (WORKER-GAPS-11A, binary re-verified 2026-10-20): this is
 * NOT verbatim Cursor parity. Cursor 3.25.9's `cursor.cpp.enablePartialAccepts`
 * (workbench.desktop.main.js) is registered in the "cpp" (Cursor Tab) settings
 * section with description "Enable partial accepts for Cursor Tab, using the
 * editor.action.inlineSuggest.acceptNextWord keybinding" and default FALSE — it
 * gates Tab's next-WORD partial accept (`acceptNextWord()` returns false unless
 * the setting is true), NOT inline-diff hunk accept/reject. Cursor's inline-diff
 * commands `editor.action.inlineDiffs.acceptPartialEdit` / `rejectPartialEdit`
 * have NO config gate in the binary (only a shouldHideInlineDiffs session guard).
 * The true Cursor equivalent of that toggle is `ide.tab.enablePartialAccepts`
 * (core composerConfiguration.ts, wired to the partial-accept keybinding).
 *
 * Ours: `ide.cpp.enablePartialAccepts` (registered in the extension package.json,
 * "IDE CPP" section, default true) is an IDE-CODE extension of the concept:
 * when disabled, partial accept/reject of individual hunks is turned off —
 * only the full Accept/Reject of the whole inline edit apply.
 */

/** Configuration section for the `ide.cpp.*` settings. */
export const CPP_CONFIG_SECTION = "ide.cpp";
/** Default of `ide.cpp.enablePartialAccepts` — IDE-CODE choice (Cursor's Tab toggle defaults to false; see PARTIAL-ACCEPTS TOGGLE above). */
export const PARTIAL_ACCEPTS_DEFAULT = true;

export function readPartialAcceptsEnabled(
  cfg: Pick<vscode.WorkspaceConfiguration, "get"> = vscode.workspace.getConfiguration(
    CPP_CONFIG_SECTION,
  ),
): boolean {
  return cfg.get<boolean>("enablePartialAccepts", PARTIAL_ACCEPTS_DEFAULT);
}

/**
 * Pure suppression decision. Mirrors the binary: `s &&
 * this.changes.length > o` — s = protection enabled, o = maxDecorations.
 * Boundary is strictly greater-than: exactly `maxDecorations` changes still
 * render decorations normally.
 */
export function shouldSuppressInlineDiffDecorations(
  changeCount: number,
  perf: InlineDiffPerfProtection,
): boolean {
  return perf.enablePerformanceProtection && changeCount > perf.maxDecorations;
}

/**
 * Cursor's `notifySuppressedDiffVisible` analog: warn the user that the
 * inline-diff decorations were suppressed, with a "Don't show again" action
 * that persists the dismissal under `ide.inlineDiff.tooManyChangesWarning`.
 */
export async function showInlineDiffTooManyChangesWarning(
  changeCount: number,
  globalState: vscode.Memento,
): Promise<void> {
  if (globalState.get<boolean>(INLINE_DIFF_TOO_MANY_CHANGES_WARNING_ID, false)) {
    return; // user dismissed it before — stay silent
  }
  const choice = await vscode.window.showWarningMessage(
    `IDE Agent: the inline diff has ${changeCount} changes — diff decorations were suppressed to keep the editor responsive.`,
    "Don't show again",
  );
  if (choice === "Don't show again") {
    await globalState.update(INLINE_DIFF_TOO_MANY_CHANGES_WARNING_ID, true);
  }
}

interface InlineTarget {
  document: vscode.TextDocument;
  /** Range in the document that will be replaced (zero-width when inserting). */
  range: vscode.Range;
  originalText: string;
  /** Document version when the target was captured (stale-edit guard). */
  version: number;
  languageId: string;
  fileLabel: string;
  /** Surrounding code, read-only reference for the model. */
  contextBefore: string;
  contextAfter: string;
  insertMode: boolean;
}

interface InlineSession {
  target: InlineTarget;
  editor: vscode.TextEditor;
  instruction: string;
  history: string[];
  proposedText: string;
  /** Document version right after the preview was applied. */
  previewVersion: number;
  /**
   * DD-SB-5: `linesAdded + linesRemoved` of the proposed diff (Cursor's
   * per-event unit for `composer.diff_summary` / `composer.accept_diff`),
   * computed from the preview hunks in showPreview.
   */
  suggestLines: number;
  /** 0-based line arrays of the original vs proposed text (merge sources). */
  origLines: string[];
  newLines: string[];
  /** Diff hunks between origLines and newLines, in document order. */
  hunks: DiffHunk[];
  /** Per-hunk resolution state, index-aligned with `hunks`. */
  hunkStates: InlineHunkState[];
  /** Per-hunk 0-based line ranges inside `mergedLines`, index-aligned. */
  hunkRanges: Array<{ start: number; end: number }>;
  /** Text currently applied in the document (merged per `hunkStates`). */
  mergedLines: string[];
  /** Navigation cursor: index into `hunks`, or -1 when unset. */
  currentHunk: number;
  /**
   * In-memory log of INLINE_EDIT_TELEMETRY event names for this preview
   * (partial vs full accept/reject are logged distinctly, like Cursor).
   * Snapshotted to `lastTelemetryLog` when the session clears.
   */
  telemetry: string[];
  /**
   * PERF-PROTECTION: when true, decorations were suppressed at preview
   * time (too many changes) and renderHunkDecorations stays a no-op.
   */
  decorationsSuppressed: boolean;
}

export class InlineEditService implements vscode.Disposable {
  private session?: InlineSession;
  private adapter?: IdeCodeEngineAdapter;
  private readonly disposables: vscode.Disposable[] = [];
  private addedDeco?: vscode.TextEditorDecorationType;
  private removedDeco?: vscode.TextEditorDecorationType;
  private statusBar?: vscode.StatusBarItem;
  /**
   * WORKER-GAPS-34C (inline-edit-command-ids): cancels the in-flight
   * generation turn (the `editor.action.inlineDiffs.cancelEdits` fallback,
   * weight 600). Set inside runEngineTurn for edit generations only —
   * question-mode turns pass no tracker.
   */
  private generationCancel: (() => void) | undefined;
  /** C7 — LRU of recently active file paths for default context gathering. */
  private readonly recentFiles: string[] = [];
  /**
   * Verbatim Cursor telemetry event names from the most recently closed
   * preview (the live session's log is on InlineSession.telemetry).
   */
  private lastTelemetryLog: string[] = [];

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly opts: { prefillChat: (text: string) => Promise<void> },
  ) {
    const record = vscode.window.onDidChangeActiveTextEditor((editor) => {
      if (!editor || editor.document.uri.scheme !== "file") return;
      const key = editor.document.uri.fsPath;
      const at = this.recentFiles.indexOf(key);
      if (at >= 0) this.recentFiles.splice(at, 1);
      this.recentFiles.unshift(key);
      if (this.recentFiles.length > 8) this.recentFiles.length = 8;
    });
    this.disposables.push(record);
  }

  get hasPendingEdit(): boolean {
    return this.session !== undefined;
  }

  /**
   * WORKER-GAPS-34C (inline-edit-command-ids): `ide.cancelInlineEditGeneration`
   * — the web/aux fallback for `editor.action.inlineDiffs.cancelEdits`.
   * Aborts the in-flight edit generation; the turn stream breaks and
   * runGeneration exits without a preview.
   */
  cancelGeneration(): void {
    this.generationCancel?.();
  }

  /** Entry point for `ide.openInlinePrompt`. Re-entrant: acts as follow-up while a preview is pending. */
  async openPrompt(): Promise<void> {
    if (this.session) {
      await this.followUp();
      return;
    }
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      void vscode.window.showErrorMessage(
        "IDE Agent: open a file first — inline edit needs an active editor.",
      );
      return;
    }
    // KEYBOARD-PARITY (K-08): a selection attached via
    // `ide.addSelectionToInlinePrompt` wins over the live
    // cursor selection. Stale or foreign-document attachments are discarded.
    // (GAPS-171: the Ctrl/Cmd+Shift+K chord was reassigned to
    // `aipopup.action.modal.generate` per the Cursor 3.25.9 binary.)
    const pendingSel = takePendingSelection();
    const target =
      pendingSel &&
      !editor.document.isClosed &&
      pendingSel.uri.toString() === editor.document.uri.toString() &&
      pendingSel.version === editor.document.version
        ? this.captureTarget(editor, pendingSel.range)
        : this.captureTarget(editor);
    if (!target) return;
    const answer = await this.promptForInstruction(target, undefined, false);
    if (!answer) return; // user cancelled
    if (answer.kind === "question") {
      await this.askQuestion(editor, target, answer.text);
      return;
    }
    if (answer.kind === "escalate") {
      await this.escalateWithInstruction(answer.text, target);
      return;
    }
    await this.runGeneration(editor, target, answer.text, []);
  }

  /** `ide.acceptInlineEdit` — keep the previewed change. */
  accept(): void {
    const s = this.session;
    if (!s) return;
    this.logTelemetry(s, INLINE_EDIT_TELEMETRY.acceptedDiff);
    // DD-SB-5: aiCodeTracking `composer.accept_diff` analog — the accepted
    // diff's lines plus per-file attribution for commit scoring.
    try {
      const t = tryGetAiCodeTracking();
      if (t) {
        // Hunks already attributed by acceptPartial are skipped; only the
        // still-pending hunks are counted here (with no partial ops this is
        // exactly the old suggestLines whole-diff recording).
        let lines = 0;
        for (let i = 0; i < s.hunks.length; i++) {
          if (s.hunkStates[i] !== "pending") continue;
          const h = s.hunks[i]!;
          lines += h.newEnd - h.newStart + (h.origEnd - h.origStart);
        }
        if (lines > 0) {
          t.recordAccept("COMPOSER", lines);
          const acceptedText = mergeHunks(
            s.origLines,
            s.newLines,
            s.hunks,
            s.hunkStates.map((st) => (st === "rejected" ? "rejected" : "accepted")),
          ).lines.join("\n");
          t.recordAcceptedLines("COMPOSER", trackingFileKey(s.target.document.uri), acceptedText);
        }
      }
    } catch {
      /* stats must never break the accept flow */
    }
    this.clearSession();
  }

  /** In-memory log of Cursor-verbatim telemetry event names (partial vs full are distinct). */
  getTelemetryLog(): readonly string[] {
    return this.session ? [...this.session.telemetry] : [...this.lastTelemetryLog];
  }

  /** Append a Cursor-verbatim analytics event name to the session log. */
  private logTelemetry(s: InlineSession, event: string): void {
    s.telemetry.push(event);
  }

  /**
   * `ide.acceptPartialInlineEdit` — accept ONLY the current hunk
   * (Cursor: `editor.action.inlineDiffs.acceptPartialEdit`,
   * "Accept Partial Edit", Win Ctrl+Shift+Y / mac Cmd+Y).
   * The hunk's text is committed; the remaining hunks stay pending.
   * Telemetry: "Accepted Partial Diff" (distinct from "Accepted Diff").
   */
  async acceptPartial(): Promise<void> {
    // WORKER-P3-QUICK-FIXES (Finding 1 — inline-diff-partial-accept-toggle),
    // corrected WORKER-GAPS-11A: IDE-CODE's `ide.cpp.enablePartialAccepts`
    // gates partial accept/reject (HONEST-DIVERGENCE — Cursor's similarly named
    // toggle is a Cursor Tab next-word setting with no gate on inline-diff
    // partial edit; see PARTIAL-ACCEPTS TOGGLE above).
    // When disabled, individual hunk accepts are refused — only the full
    // accept() of the whole inline edit applies.
    if (!readPartialAcceptsEnabled()) {
      void vscode.window.showInformationMessage(
        "IDE Agent: partial accept is disabled (ide.cpp.enablePartialAccepts). Use Accept to apply all changes.",
      );
      return;
    }
    const s = this.session;
    if (!s) {
      void vscode.window.showInformationMessage(
        "IDE Agent: no inline edit preview is open — nothing to accept.",
      );
      return;
    }
    const idx = this.resolvePartialTarget(s);
    if (idx < 0) {
      void vscode.window.showInformationMessage(
        "IDE Agent: every change in this preview is already resolved — use accept/reject to finish.",
      );
      return;
    }
    s.hunkStates = setHunkState(s.hunkStates, idx, "accepted");
    this.logTelemetry(s, INLINE_EDIT_TELEMETRY.acceptedPartialDiff);
    // DD-SB-5: attribute the accepted hunk's lines immediately (a later
    // accept() only counts hunks that are still pending).
    try {
      const t = tryGetAiCodeTracking();
      if (t) {
        const h = s.hunks[idx]!;
        t.recordAccept("COMPOSER", h.newEnd - h.newStart + (h.origEnd - h.origStart));
        t.recordAcceptedLines(
          "COMPOSER",
          trackingFileKey(s.target.document.uri),
          s.newLines.slice(h.newStart, h.newEnd).join("\n"),
        );
      }
    } catch {
      /* stats must never break the accept flow */
    }
    // The accepted hunk already shows the proposed text — only the
    // decorations and the navigation cursor change.
    this.renderHunkDecorations(s);
    this.advancePartialCursor(s, 1);
  }

  /**
   * `ide.rejectPartialInlineEdit` — reject ONLY the current hunk
   * (Cursor: `editor.action.inlineDiffs.rejectPartialEdit`,
   * "Reject Partial Edit", Ctrl/Cmd+N).
   * The hunk's lines revert to the original; remaining hunks stay pending.
   * Telemetry: "Rejected Partial Diff" (distinct from "Rejected Diff").
   */
  async rejectPartial(): Promise<void> {
    // WORKER-P3-QUICK-FIXES (Finding 1 — inline-diff-partial-accept-toggle),
    // corrected WORKER-GAPS-11A: IDE-CODE's `ide.cpp.enablePartialAccepts`
    // gates partial accept/reject (HONEST-DIVERGENCE — Cursor's similarly named
    // toggle is a Cursor Tab next-word setting with no gate on inline-diff
    // partial edit; see PARTIAL-ACCEPTS TOGGLE above).
    // When disabled, individual hunk rejects are refused — only the full
    // reject() of the whole inline edit applies.
    if (!readPartialAcceptsEnabled()) {
      void vscode.window.showInformationMessage(
        "IDE Agent: partial reject is disabled (ide.cpp.enablePartialAccepts). Use Reject to discard all changes.",
      );
      return;
    }
    const s = this.session;
    if (!s) {
      void vscode.window.showInformationMessage(
        "IDE Agent: no inline edit preview is open — nothing to reject.",
      );
      return;
    }
    const idx = this.resolvePartialTarget(s);
    if (idx < 0) {
      void vscode.window.showInformationMessage(
        "IDE Agent: every change in this preview is already resolved — use accept/reject to finish.",
      );
      return;
    }
    const document = s.target.document;
    if (document.version !== s.previewVersion) {
      const choice = await vscode.window.showWarningMessage(
        "IDE Agent: the file changed during the preview. Rejecting this change will overwrite those edits.",
        { modal: true },
        "Reject anyway",
        "Keep",
      );
      if (choice !== "Reject anyway") return;
    }
    s.hunkStates = setHunkState(s.hunkStates, idx, "rejected");
    this.logTelemetry(s, INLINE_EDIT_TELEMETRY.rejectedPartialDiff);
    const merged = mergeHunks(s.origLines, s.newLines, s.hunks, s.hunkStates);
    try {
      const ok = await s.editor.edit((builder) =>
        builder.replace(this.previewRange(s), merged.lines.join("\n")),
      );
      if (!ok) {
        // Roll back so the document and the hunk states stay consistent.
        s.hunkStates = setHunkState(s.hunkStates, idx, "pending");
        s.telemetry.pop();
        void vscode.window.showErrorMessage(
          "IDE Agent: could not reject this change — the preview was not modified.",
        );
        return;
      }
    } catch (err) {
      s.hunkStates = setHunkState(s.hunkStates, idx, "pending");
      s.telemetry.pop();
      const message = err instanceof Error ? err.message : String(err);
      void vscode.window.showErrorMessage(
        `IDE Agent: could not reject this change — ${message}`,
      );
      return;
    }
    s.mergedLines = merged.lines;
    s.hunkRanges = merged.hunkRanges;
    s.previewVersion = document.version;
    this.renderHunkDecorations(s);
    this.advancePartialCursor(s, 1);
  }

  /** `ide.nextInlineChange` — Alt+J: jump to the next pending change. */
  nextChange(): void {
    this.gotoChange(1);
  }

  /** `ide.previousInlineChange` — Alt+K: jump to the previous pending change. */
  previousChange(): void {
    this.gotoChange(-1);
  }

  /**
   * `ide.nextInlineDiffFile` — Alt+L. Cursor jumps across files that have
   * diffs; this service holds a single pending preview, so this is a
   * graceful no-op (the command/keybinding exist so the surface matches
   * Cursor 1:1; multi-diff navigation is future work).
   */
  nextDiffFile(): void {
    void vscode.window.showInformationMessage(
      "IDE Agent: only one inline diff is open — there is no next diff file.",
    );
  }

  /** `ide.previousInlineDiffFile` — Alt+H (same single-session caveat). */
  previousDiffFile(): void {
    void vscode.window.showInformationMessage(
      "IDE Agent: only one inline diff is open — there is no previous diff file.",
    );
  }

  /** Move the navigation cursor to the next/previous pending hunk and reveal it. */
  private gotoChange(direction: 1 | -1): void {
    const s = this.session;
    if (!s) {
      void vscode.window.showInformationMessage(
        "IDE Agent: no inline edit preview is open.",
      );
      return;
    }
    const idx = nextPendingHunkIndex(s.hunkStates, s.currentHunk, direction);
    if (idx < 0) {
      void vscode.window.showInformationMessage(
        "IDE Agent: no unresolved changes left in this preview.",
      );
      return;
    }
    s.currentHunk = idx;
    const mr = s.hunkRanges[idx]!;
    const baseLine = s.target.range.start.line;
    const lastDocLine = s.editor.document.lineCount - 1;
    // A pending pure-deletion hunk occupies zero merged lines; still land
    // the cursor on its anchor line so navigation never jumps nowhere.
    const startLine = Math.min(baseLine + mr.start, lastDocLine);
    const endLine = Math.min(baseLine + Math.max(mr.end - 1, mr.start), lastDocLine);
    const range = new vscode.Range(
      startLine,
      0,
      endLine,
      s.editor.document.lineAt(endLine).range.end.character,
    );
    s.editor.selection = new vscode.Selection(range.start, range.end);
    s.editor.revealRange(range, vscode.TextEditorRevealType.InCenter);
  }

  /**
   * Which hunk a partial accept/reject applies to: the navigation cursor
   * when it points at a pending hunk, else the next pending hunk after it.
   * Returns -1 when no hunk is pending.
   */
  private resolvePartialTarget(s: InlineSession): number {
    if (
      s.currentHunk >= 0 &&
      s.currentHunk < s.hunkStates.length &&
      s.hunkStates[s.currentHunk] === "pending"
    ) {
      return s.currentHunk;
    }
    return nextPendingHunkIndex(s.hunkStates, s.currentHunk, 1);
  }

  /** Advance the navigation cursor past just-resolved hunks. */
  private advancePartialCursor(s: InlineSession, direction: 1 | -1): void {
    s.currentHunk = nextPendingHunkIndex(s.hunkStates, s.currentHunk, direction);
  }

  /** Compute the exact range the preview now occupies: original start + merged-text extent. */
  private previewRange(s: InlineSession): vscode.Range {
    const start = s.target.range.start;
    const lines = s.mergedLines;
    const end =
      lines.length === 1
        ? start.translate(0, lines[0]!.length)
        : new vscode.Position(
            start.line + lines.length - 1,
            lines[lines.length - 1]!.length,
          );
    return new vscode.Range(start, end);
  }

  /** `ide.rejectInlineEdit` — restore the original text. */
  async reject(): Promise<void> {
    const s = this.session;
    if (!s) return;
    const document = s.target.document;
    if (document.version !== s.previewVersion) {
      const choice = await vscode.window.showWarningMessage(
        "IDE Agent: the file changed during the preview. Rejecting will overwrite those changes.",
        { modal: true },
        "Reject anyway",
        "Keep",
      );
      if (choice !== "Reject anyway") return;
    }
    // UNKNOWN (binary has no evidence either way): a full "Undo Edits"
    // restores the whole preview region to the pre-preview original text,
    // including hunks already committed via partial accept — per-hunk
    // commits are NOT preserved across a full reject. This keeps the
    // pre-partial reject() semantics.
    this.logTelemetry(s, INLINE_EDIT_TELEMETRY.rejectedDiff);
    try {
      await s.editor.edit((builder) => builder.replace(this.previewRange(s), s.target.originalText));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      void vscode.window.showErrorMessage(`IDE Agent: could not revert the inline edit — ${message}`);
    }
    this.clearSession();
  }

  /** `ide.sendToAgent` — escalate the inline task to a full agent turn (C8). */
  async escalateToAgent(): Promise<void> {
    const s = this.session;
    if (s) {
      await this.escalateWithInstruction(s.instruction, s.target);
      return;
    }
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      void vscode.window.showErrorMessage(
        "IDE Agent: open a file first — there is nothing to send to the agent.",
      );
      return;
    }
    const target = this.captureTarget(editor);
    if (!target) return;
    const answer = await this.promptForInstruction(target, undefined, false);
    if (!answer) return;
    if (answer.kind === "question") {
      await this.askQuestion(editor, target, answer.text);
      return;
    }
    // "edit" and "escalate" both land in the agent with the typed text.
    await this.escalateWithInstruction(answer.text, target);
  }

  /**
   * Build the agent-turn prompt from an inline instruction + target, then
   * hand it to chat. Cursor opens Agent with the selected code as context
   * (Cmd/Ctrl+L); ours prefills the real chat composer and focuses it.
   */
  private async escalateWithInstruction(instruction: string, target: InlineTarget): Promise<void> {
    const startLine = target.range.start.line + 1;
    const endLine = target.insertMode
      ? startLine
      : target.range.end.line + 1;
    // Binary evidence: Cursor CmdK has no escalation truncation — the
    // selected code is sent as-is (full query_history via proto).
    const code = target.originalText;
    const fence = FENCE_ALIASES[target.languageId.toLowerCase()] ?? target.languageId;
    const text = [
      instruction,
      "",
      `Context — ${target.fileLabel} (${target.languageId}), line${startLine === endLine ? "" : "s"} ${startLine}${startLine === endLine ? "" : `–${endLine}`}:`,
      `\`\`\`${fence}`,
      code,
      "```",
    ].join("\n");
    await this.opts.prefillChat(text);
  }

  dispose(): void {
    this.clearSession();
    for (const d of this.disposables) d.dispose();
    this.disposables.length = 0;
  }

  // ------------------------------------------------------------------ //

  private captureTarget(editor: vscode.TextEditor, explicitRange?: vscode.Range): InlineTarget | undefined {
    const document = editor.document;
    if (editor.document.isClosed) return undefined;
    const selection = editor.selection;
    const insertMode = !explicitRange && selection.isEmpty;
    const range = explicitRange
      ? document.validateRange(explicitRange)
      : insertMode
        ? new vscode.Range(selection.active, selection.active)
        : document.validateRange(new vscode.Range(selection.start, selection.end));
    const originalText = document.getText(range);
    // NOTE (user directive 2026-10-19): no artificial size cap on the
    // selection. This is our own system — the user edits whatever they
    // select; the engine/model context window is the only real bound.
    const startLine = range.start.line;
    const endLine = insertMode ? startLine : range.end.line;
    const beforeStart = Math.max(0, startLine - CONTEXT_LINES);
    const afterEnd = Math.min(document.lineCount - 1, endLine + CONTEXT_LINES);
    // UNKNOWN (no binary evidence for Cursor's surrounding-context
    // window; see header note): surrounding context is auto-attached and
    // bounded by a local default so a huge file can't blow up the prompt.
    const cap = (text: string): string =>
      text.length > CONTEXT_CHARS ? text.slice(0, CONTEXT_CHARS) + "\n…(truncated)" : text;
    const contextBefore =
      beforeStart < startLine
        ? cap(document.getText(new vscode.Range(beforeStart, 0, startLine, 0)))
        : "";
    const contextAfter =
      afterEnd > endLine
        ? cap(
            document.getText(
              new vscode.Range(endLine + 1, 0, afterEnd, document.lineAt(afterEnd).range.end.character),
            ),
          )
        : "";
    let fileLabel: string;
    try {
      fileLabel = vscode.workspace.asRelativePath(document.uri);
    } catch {
      fileLabel = document.uri.fsPath;
    }
    return {
      document,
      range,
      originalText,
      version: document.version,
      languageId: document.languageId,
      fileLabel,
      contextBefore,
      contextAfter,
      insertMode,
    };
  }

  private promptForInstruction(
    target: InlineTarget,
    previous: string | undefined,
    followUp: boolean,
  ): Promise<{ kind: "edit" | "question" | "escalate"; text: string } | undefined> {
    return new Promise((resolve) => {
      const input = vscode.window.createInputBox();
      const startLine = target.range.start.line + 1;
      const loc = target.insertMode
        ? `line ${startLine}`
        : `lines ${startLine}–${target.range.end.line + 1}`;
      // Cursor's Alt+Enter question mode is not capturable in a quick-input
      // box, so it is exposed as an explicit button — same behavior.
      const askButton: vscode.QuickInputButton = {
        iconPath: new vscode.ThemeIcon("comment-discussion"),
        tooltip: "Ask about this code instead (no edit)",
      };
      // Cursor's Cmd+L in the prompt bar escalates to Agent. Keys can't be
      // intercepted inside a quick-input, so this is an explicit button.
      const escalateButton: vscode.QuickInputButton = {
        iconPath: new vscode.ThemeIcon("rocket"),
        tooltip: "Send to Agent (multi-file / complex change)",
      };
      input.title = followUp ? "IDE Agent inline edit — follow-up" : "IDE Agent inline edit";
      input.prompt =
        (followUp ? "Refine the proposed edit" : "Describe the change") +
        ` — ${target.fileLabel}:${loc} (${target.languageId})`;
      input.placeholder = "e.g. convert to async/await and add error handling";
      if (previous) input.value = previous;
      input.buttons = [askButton, escalateButton];
      let settled = false;
      const finish = (value: { kind: "edit" | "question" | "escalate"; text: string } | undefined): void => {
        if (settled) return;
        settled = true;
        input.dispose();
        resolve(value);
      };
      input.onDidTriggerButton((button) => {
        if (button === askButton) {
          const q = input.value.trim();
          if (!q) {
            input.validationMessage = "Type a question first, or press Esc to cancel.";
            return;
          }
          finish({ kind: "question", text: q });
        } else if (button === escalateButton) {
          const t = input.value.trim();
          if (!t) {
            input.validationMessage = "Type the task first, or press Esc to cancel.";
            return;
          }
          finish({ kind: "escalate", text: t });
        }
      });
      input.onDidAccept(() => {
        const value = input.value.trim();
        if (!value) {
          input.validationMessage = "Describe the change first, or press Esc to cancel.";
          return;
        }
        finish({ kind: "edit", text: value });
      });
      input.onDidHide(() => finish(undefined));
      input.show();
    });
  }

  private ensureAdapter(): IdeCodeEngineAdapter | undefined {
    if (this.adapter) return this.adapter;
    const cfg = vscode.workspace.getConfiguration("ide.agent");
    if (cfg.get<string>("engineMode", "sidecar") !== "sidecar") {
      // Honest precondition, not a scaffold: the whole extension (chat
      // included) needs the sidecar engine + a configured model to generate.
      void vscode.window
        .showWarningMessage(
          'IDE Agent: inline edit needs the ide-code engine. Set "ide.agent.engineMode" to "sidecar" and configure a model, then try again.',
          "Open Settings",
        )
        .then((selection) => {
          if (selection === "Open Settings") {
            void vscode.commands.executeCommand(
              "workbench.action.openSettings",
              "ide.agent.engineMode",
            );
          }
        });
      return undefined;
    }
    const output = vscode.window.createOutputChannel("IDE Agent Inline Edit");
    const adapter = new IdeCodeEngineAdapter({
      enginePath: cfg.get<string>("enginePath", "") || defaultEnginePath(),
      output,
      // Inline edits are single-shot code rewrites; the prompt forbids tool
      // use, so any approval request is auto-skipped rather than blocking.
      requestApproval: () => Promise.resolve({ optionId: "skip" }),
      getMode: () => "edit",
    });
    this.adapter = adapter;
    this.disposables.push({ dispose: () => adapter.dispose() });
    return adapter;
  }

  private async buildEditPrompt(target: InlineTarget, instruction: string, history: string[]): Promise<string> {
    const lines: string[] = [
      "You are an expert code editor performing a Cursor-style inline edit.",
      "",
      "Rules:",
      "- Output ONLY the rewritten code inside a single fenced code block.",
      "- Rewrite ONLY the <target> section below. <context> and <related-files> are read-only reference — never include them in your output.",
    ];
    if (target.insertMode) {
      lines.push("- The <target> section is EMPTY: write the new code to insert at the cursor.");
    } else {
      lines.push(
        "- Replace the ENTIRE <target> section with the improved version: output the full new text, not a diff.",
      );
    }
    lines.push(
      "- Preserve code style, indentation, and everything unrelated to the instruction.",
      "- No explanations, no apologies, no text outside the code block. Do not use tools.",
      "",
    );
    if (history.length > 0) {
      lines.push(
        "Earlier attempts in this session (the newest instruction takes precedence):",
        ...history.map((h, i) => `${i + 1}. ${h}`),
        "",
      );
    }
    lines.push(
      `Instruction: ${instruction}`,
      "",
      `File: ${target.fileLabel} (${target.languageId})`,
      "",
    );
    if (target.contextBefore) {
      lines.push("<context> (read-only, above the target):", target.contextBefore, "</context>", "");
    }
    lines.push("<target>", target.originalText, "</target>", "");
    if (target.contextAfter) {
      lines.push("<context> (read-only, below the target):", target.contextAfter, "</context>", "");
    }
    const related = await this.relatedFilesContext(target.document.uri);
    if (related) {
      lines.push("<related-files> (read-only reference — recent and neighboring files):", related, "</related-files>", "");
    }
    return lines.join("\n");
  }

  /**
   * C7 — default context gathering. Cursor feeds related and recent files
   * into inline edit automatically; this approximates it with:
   *   (a) the 3 most recently active files (excluding the current one), and
   *   (b) up to 2 same-directory files with the same extension.
   * Bounded (≤5 files, heads only) and labeled; unreadable files are skipped.
   */
  private async relatedFilesContext(current: vscode.Uri): Promise<string> {
    const MAX_FILES = 5;
    const MAX_LINES = 40;
    const MAX_CHARS = 2_000;
    const seen = new Set<string>([current.fsPath]);
    const sections: string[] = [];

    const addFile = async (uri: vscode.Uri, tag: string): Promise<void> => {
      if (sections.length >= MAX_FILES || seen.has(uri.fsPath)) return;
      seen.add(uri.fsPath);
      const head = await this.readFileHead(uri, MAX_LINES, MAX_CHARS);
      if (!head || !head.trim()) return;
      let label: string;
      try {
        label = vscode.workspace.asRelativePath(uri);
      } catch {
        label = uri.fsPath;
      }
      sections.push(`--- ${label} (${tag}) ---\n${head}`);
    };

    // (a) recent files, most recent first.
    for (const fsPath of this.recentFiles) {
      if (sections.length >= 3) break;
      await addFile(vscode.Uri.file(fsPath), "recent");
    }
    // (b) neighboring files with the same extension.
    if (sections.length < MAX_FILES) {
      const ext = path.extname(current.fsPath);
      if (ext) {
        try {
          const dirUri = vscode.Uri.file(path.dirname(current.fsPath));
          const entries = await vscode.workspace.fs.readDirectory(dirUri);
          const base = path.basename(current.fsPath);
          for (const [name, type] of entries) {
            if (sections.length >= MAX_FILES) break;
            if (type !== vscode.FileType.File || name === base || !name.endsWith(ext)) continue;
            await addFile(vscode.Uri.joinPath(dirUri, name), "neighbor");
          }
        } catch {
          // No directory access — neighbors are best-effort.
        }
      }
    }
    return sections.join("\n\n");
  }

  /** Read the head of a file: prefer the open document (has unsaved edits), else disk. */
  private async readFileHead(uri: vscode.Uri, maxLines: number, maxChars: number): Promise<string | undefined> {
    try {
      const open = vscode.workspace.textDocuments.find(
        (d) => d.uri.toString() === uri.toString(),
      );
      if (open) {
        const end = Math.min(maxLines, open.lineCount);
        const text = open.getText(new vscode.Range(0, 0, end, 0));
        return text.length > maxChars ? text.slice(0, maxChars) : text;
      }
      const bytes = await vscode.workspace.fs.readFile(uri);
      const text = new TextDecoder().decode(bytes.subarray(0, maxChars));
      return text.split("\n").slice(0, maxLines).join("\n");
    } catch {
      return undefined; // binary, deleted, or unreadable — skip silently
    }
  }

  /** Run one generation turn against the engine and return the raw text. */
  private async runEngineTurn(
    prompt: string,
    title: string,
    trackCancel?: (cancel: (() => void) | undefined) => void,
  ): Promise<string | undefined> {
    const adapter = this.ensureAdapter();
    if (!adapter) return undefined;
    let cancelled = false;
    const cancel = () => {
      cancelled = true;
    };
    // WORKER-GAPS-34C: expose the in-flight turn to `cancelGeneration()`
    // (the `editor.action.inlineDiffs.cancelEdits` fallback path).
    trackCancel?.(cancel);
    try {
      const raw = await vscode.window.withProgress<string | undefined>(
        { location: vscode.ProgressLocation.Notification, title, cancellable: true },
        async (_progress, token) => {
          token.onCancellationRequested(() => {
            cancelled = true;
          });
          let text = "";
          for await (const ev of adapter.runTurn({
            prompt,
            mode: "edit",
            bubbleId: `inline-${Date.now().toString(36)}`,
          })) {
            if (cancelled || token.isCancellationRequested) break;
            if (ev.type === "textDelta") text += ev.delta;
            else if (ev.type === "done") break;
          }
          return cancelled ? undefined : text;
        },
      );
      return raw;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      void vscode.window.showErrorMessage(`IDE Agent: inline edit failed — ${message}`);
      return undefined;
    } finally {
      trackCancel?.(undefined);
    }
  }

  private async runGeneration(
    editor: vscode.TextEditor,
    target: InlineTarget,
    instruction: string,
    history: string[],
  ): Promise<void> {
    // WORKER-GAPS-34C: mirror the core `hasActivelyGeneratingDiff` key for
    // the web/aux fallback path (the core
    // `editor.action.inlineDiffs.cancelEdits` precondition).
    this.generationCancel = undefined;
    void vscode.commands.executeCommand("setContext", "hasActivelyGeneratingDiff", true);
    let raw: string | undefined;
    try {
      raw = await this.runEngineTurn(
        await this.buildEditPrompt(target, instruction, history),
        "IDE Agent: generating inline edit…",
        (cancel) => {
          this.generationCancel = cancel;
        },
      );
    } finally {
      this.generationCancel = undefined;
      void vscode.commands.executeCommand("setContext", "hasActivelyGeneratingDiff", false);
    }
    if (raw === undefined) return; // cancelled, engine missing, or error (already reported)
    const code = extractCodeBlock(raw, target.languageId);
    if (!code) {
      void vscode.window.showErrorMessage(
        "IDE Agent: the engine returned no usable code. Try rephrasing the instruction.",
      );
      return;
    }
    await this.showPreview(editor, target, instruction, history, code);
  }

  private async showPreview(
    editor: vscode.TextEditor,
    target: InlineTarget,
    instruction: string,
    history: string[],
    proposedText: string,
  ): Promise<void> {
    const document = target.document;
    if (document.version !== target.version) {
      void vscode.window.showWarningMessage(
        "IDE Agent: the file changed while generating — inline edit cancelled to avoid conflicts.",
      );
      return;
    }
    const origLines = target.originalText.split("\n");
    const newLines = proposedText.split("\n");
    const hunks = lineDiff(origLines, newLines);
    if (hunks.length === 0) {
      void vscode.window.showInformationMessage(
        "IDE Agent: the engine returned the code unchanged — nothing to preview.",
      );
      return;
    }
    // PARTIAL-DIFF: every hunk starts "pending"; the merged text below is
    // identical to proposedText in this state, but all later renders go
    // through mergeHunks so partial accept/reject stay consistent.
    const hunkStates: InlineHunkState[] = hunks.map(() => "pending");
    const merged = mergeHunks(origLines, newLines, hunks, hunkStates);
    let applied = false;
    try {
      applied = await editor.edit((builder) =>
        builder.replace(target.range, merged.lines.join("\n")),
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      void vscode.window.showErrorMessage(`IDE Agent: could not apply the preview — ${message}`);
      return;
    }
    if (!applied) {
      void vscode.window.showErrorMessage("IDE Agent: could not apply the preview edit.");
      return;
    }

    // PERF-PROTECTION: suppress ALL inline-diff decorations when the change
    // count exceeds maxDecorations (binary: `s && this.changes.length > o &&
    // r.splice(0)`). The preview edit itself stays applied; only the
    // decorations are dropped, and the user gets the too-many-changes
    // warning (Cursor's `notifySuppressedDiffVisible` analog).
    const decorationsSuppressed = shouldSuppressInlineDiffDecorations(
      hunks.length,
      readInlineDiffPerfConfig(),
    );
    if (decorationsSuppressed) {
      await showInlineDiffTooManyChangesWarning(hunks.length, this.context.globalState);
    } else {
      // SETTINGS-PARITY: `ide.cmdk.useThemedDiffBackground` (mirrors
      // cursor.cmdk.useThemedDiffBackground2). Off = fixed neutral greens.
      const useThemedDiff = vscode.workspace
        .getConfiguration("ide.cmdk")
        .get<boolean>("useThemedDiffBackground", true);
      this.addedDeco = vscode.window.createTextEditorDecorationType({
        backgroundColor: useThemedDiff
          ? new vscode.ThemeColor("diffEditor.insertedTextBackground")
          : "rgba(120, 180, 90, 0.25)",
        isWholeLine: true,
      });
      this.removedDeco = vscode.window.createTextEditorDecorationType({});
    }

    this.statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 101);
    this.statusBar.text =
      "$(diff) Inline edit — Ctrl+Enter: accept · Esc: reject · " +
      "Ctrl+Shift+Y: accept change · Ctrl+N: reject change · Alt+J/K: changes";
    this.statusBar.tooltip = "IDE Agent inline edit preview";
    this.statusBar.show();

    // DD-SB-5: aiCodeTracking `composer.diff_summary` analog — the proposed
    // diff's linesAdded + linesRemoved (Cursor diffs previous vs updated
    // content per event; the preview hunks are exactly that diff).
    let suggestLines = 0;
    for (const hunk of hunks) {
      suggestLines += hunk.newEnd - hunk.newStart + (hunk.origEnd - hunk.origStart);
    }
    try {
      tryGetAiCodeTracking()?.recordSuggest("COMPOSER", suggestLines);
    } catch {
      /* stats must never break the preview */
    }

    this.session = {
      target,
      editor,
      instruction,
      history,
      proposedText,
      previewVersion: document.version,
      suggestLines,
      origLines,
      newLines,
      hunks,
      hunkStates,
      hunkRanges: merged.hunkRanges,
      mergedLines: merged.lines,
      currentHunk: nextPendingHunkIndex(hunkStates, -1, 1),
      telemetry: [],
      decorationsSuppressed,
    };
    this.renderHunkDecorations(this.session);
    await vscode.commands.executeCommand("setContext", INLINE_EDIT_CONTEXT_KEY, true);
    // WORKER-GAPS-34C: mirror the binary-verbatim precondition key for the
    // `editor.action.inlineDiffs.*` family on the web/aux fallback path
    // (the core service sets the same key on desktop).
    await vscode.commands.executeCommand("setContext", "inlineDiffs.activeEditorWithDiffs", true);
  }

  /**
   * (Re)compute per-hunk decorations for the session's current merged text.
   * Called from showPreview and after every partial accept/reject, because
   * hunk line ranges shift whenever a hunk is rejected. Rejected hunks
   * already show the original lines, so they get no decorations. No-op
   * when decorations were suppressed by perf protection.
   */
  private renderHunkDecorations(s: InlineSession): void {
    if (s.decorationsSuppressed) return;
    if (!this.addedDeco || !this.removedDeco) return;
    const editor = s.editor;
    const baseLine = s.target.range.start.line;
    const addedRanges: vscode.Range[] = [];
    const removedOptions: vscode.DecorationOptions[] = [];
    const oldLines = s.origLines;
    for (let i = 0; i < s.hunks.length; i++) {
      if (s.hunkStates[i] === "rejected") continue;
      const h = s.hunks[i]!;
      const mr = s.hunkRanges[i]!;
      if (mr.end > mr.start) {
        addedRanges.push(
          new vscode.Range(baseLine + mr.start, 0, baseLine + mr.end - 1, 0),
        );
      }
      if (h.origEnd > h.origStart) {
        const removedText = oldLines
          .slice(h.origStart, h.origEnd)
          .map((line) => `- ${line}`)
          .join("\n");
        const anchorLine = Math.min(
          baseLine + mr.start,
          editor.document.lineCount - 1,
        );
        removedOptions.push({
          range: new vscode.Range(anchorLine, 0, anchorLine, 0),
          renderOptions: {
            before: {
              contentText: removedText,
              color: new vscode.ThemeColor("editorError.foreground"),
              textDecoration: "line-through",
            },
          },
        });
      }
    }
    editor.setDecorations(this.addedDeco, addedRanges);
    editor.setDecorations(this.removedDeco, removedOptions);
  }

  private async followUp(): Promise<void> {
    const s = this.session;
    if (!s) return;
    const answer = await this.promptForInstruction(s.target, s.instruction, true);
    if (!answer) return; // cancelled — keep the current preview
    if (answer.kind === "question") {
      await this.askQuestion(s.editor, s.target, answer.text);
      return;
    }
    if (answer.kind === "escalate") {
      // Cursor's Cmd+L opens Agent with the selected code as context: drop
      // the preview silently and hand the refined instruction to chat.
      const { target } = s;
      if (!(await this.revertSessionText(s))) return;
      this.clearSession();
      await this.escalateWithInstruction(answer.text, target);
      return;
    }
    // Revert the current preview silently, then regenerate from the original
    // with the previous attempt recorded in history. Binary evidence:
    // Cursor sends the full `query_history` linked list via proto
    // `CmdKQueryHistory` — the previous attempt is recorded whole, not
    // truncated to a fabricated cap.
    const prevAttempt = s.proposedText;
    const historyEntry =
      `Previous instruction: "${s.instruction}". ` +
      `Previous result (refine it, do not repeat its mistakes):\n${prevAttempt}`;
    const newHistory = [...s.history, historyEntry];
    const { editor, target } = s;
    if (!(await this.revertSessionText(s))) return; // must land before regenerating
    this.clearSession();
    // The revert changed the document; refresh the captured version.
    target.version = target.document.version;
    await this.runGeneration(editor, target, answer.text, newHistory);
  }

  /** Restore the original text without user prompts (follow-up path). */
  private async revertSessionText(s: InlineSession): Promise<boolean> {
    const ok = await s.editor.edit((builder) =>
      builder.replace(this.previewRange(s), s.target.originalText),
    );
    if (!ok) {
      void vscode.window.showErrorMessage(
        "IDE Agent: could not revert the inline edit preview — follow-up cancelled.",
      );
    }
    return ok;
  }

  /** Question mode (C5): answer about the code without editing. */
  private async askQuestion(
    editor: vscode.TextEditor,
    target: InlineTarget,
    question: string,
  ): Promise<void> {
    // Binary evidence: no truncation in Cursor CmdK — the code is sent
    // as-is for question mode.
    const code = target.originalText;
    const fence = FENCE_ALIASES[target.languageId.toLowerCase()] ?? target.languageId;
    const prompt = [
      "You are an expert programming assistant. Answer the question about the code below.",
      "",
      "Rules:",
      "- Be concise. Use markdown.",
      "- Do not edit anything. Do not use tools.",
      "- If you suggest a code change, include it in a single fenced code block.",
      "",
      `Question: ${question}`,
      "",
      `File: ${target.fileLabel} (${target.languageId})`,
      `\`\`\`${fence}`,
      code,
      "```",
    ].join("\n");
    const raw = await this.runEngineTurn(prompt, "IDE Agent: answering question…");
    if (raw === undefined) return;
    const answer = raw.trim() || "(the engine returned an empty answer)";
    const doc = await vscode.workspace.openTextDocument({
      language: "markdown",
      content: `# IDE Agent — question\n\n**Q:** ${question}\n\n**File:** ${target.fileLabel}\n\n---\n\n${answer}\n`,
    });
    await vscode.window.showTextDocument(doc, vscode.ViewColumn.Beside);
    // C6 "do it": offer to apply the suggested change as an inline edit.
    const suggested = extractCodeBlock(raw, target.languageId);
    if (suggested && suggested.trim() && suggested.trim() !== target.originalText.trim()) {
      const choice = await vscode.window.showInformationMessage(
        "IDE Agent: the answer suggests a code change. Apply it as an inline edit?",
        "Apply as inline edit",
        "Dismiss",
      );
      if (choice === "Apply as inline edit") {
        await this.showPreview(editor, target, `Apply suggested fix for: ${question}`, [], suggested);
      }
    }
  }

  private clearSession(): void {
    if (this.session) {
      this.lastTelemetryLog = [...this.session.telemetry];
    }
    this.session = undefined;
    if (this.addedDeco) {
      this.addedDeco.dispose();
      this.addedDeco = undefined;
    }
    if (this.removedDeco) {
      this.removedDeco.dispose();
      this.removedDeco = undefined;
    }
    if (this.statusBar) {
      this.statusBar.dispose();
      this.statusBar = undefined;
    }
    void vscode.commands.executeCommand("setContext", INLINE_EDIT_CONTEXT_KEY, false);
    void vscode.commands.executeCommand("setContext", "inlineDiffs.activeEditorWithDiffs", false);
  }
}
