/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// IDE-CODE: Migrated from extensions/ide-agent/src/services/inlineEditService.ts (CAT-B, vscode→DI)
//
// vscode API → core mapping (per docs/rea/ext-api-audit-2026-10-19.md §3):
//   window.activeTextEditor              → IEditorService.activeTextEditorControl
//                                          (structural ICodeEditor guard — type-only import,
//                                          no runtime browser dependency)
//   window.onDidChangeActiveTextEditor   → IEditorService.onDidActiveEditorChange
//   window.withProgress                  → IProgressService.withProgress
//   window.showErrorMessage              → INotificationService.error
//   window.showWarning/InformationMessage(with buttons)
//                                        → IDialogService.confirm
//   window.createStatusBarItem           → IStatusbarService.addEntry
//   window.createTextEditorDecorationType + editor.setDecorations
//                                        → editor.deltaDecorations (there is no
//                                          IModelDecorationsService in core)
//   commands.executeCommand("setContext", k, v)
//                                        → IContextKeyService.createKey(k, false).set(v)
//   commands.executeCommand("workbench.action.openSettings", q)
//                                        → ICommandService.executeCommand
//   workspace.getConfiguration("ide.*")  → IConfigurationService.getValue("ide.*.*")
//   workspace.openTextDocument({language, content}) + showTextDocument(doc, Beside)
//                                        → IUntitledTextEditorService.create +
//                                          IEditorService.openEditor(..., SIDE_GROUP)
//   workspace.textDocuments              → IModelService.getModels()
//   workspace.fs.readDirectory/readFile  → IFileService.resolve().children / .readFile()
//   workspace.asRelativePath             → IWorkspaceContextService + extUri
//   Uri.joinPath/Uri.file                → URI.joinPath/URI.file
//   TextDocument                         → ITextModel (getVersionId, getValueInRange,
//                                          validateRange, isDisposed, getLineCount,
//                                          getLineMaxColumn, getLanguageId)
//   TextEditor                           → ICodeEditor; editor.edit(b => b.replace(r, t))
//                                          → editor.executeEdits('ide-inline-edit', [{range, text}])
//   ExtensionContext (_context, unused)  → DROPPED
//   takePendingSelection                 → IInlinePromptSelectionService.takePendingSelection()
//   defaultEnginePath                    → from ./composerDataService.js
//   tryGetAiCodeTracking                 → from ./aiCodeTracking.js
//
// Honest deviations (documented, not silent):
//   D1 The prompt bar is now a native Monaco view zone (PromptBarViewZone,
//      browser/inlineEditPromptBar.ts) — the same layer Cursor uses — instead
//      of the previous quick-input box. Extension-API builds cannot do this:
//      vscode's public TextEditor API exposes no view-zone API, so this
//      requires the workbench-core patch (per the standing "patch core like
//      Cursor" rule).
//   D2 Removed lines render as a HOVER on the added-range decoration, not as
//      injected before-content text — core IModelDecorationOptions has no
//      before.contentText. Exact Cursor parity (removed text rendered inline
//      above the change) needs a browser-layer view-zone widget —
//      TODO(composer): implement in the composer browser contribution.
//   D3 Added-line background colors move to CSS classes
//      (.composer-inline-edit-added / .composer-inline-edit-added-plain) that
//      the browser contribution's stylesheet must define:
//        .composer-inline-edit-added       { background: var(--vscode-diffEditor-insertedTextBackground); }
//        .composer-inline-edit-added-plain { background: rgba(120, 180, 90, 0.25); }
//      The `ide.cmdk.useThemedDiffBackground` setting picks which class to use
//      (same semantics as before).
//
// The generation flow, Myers diff, curation caps and session logic are
// UNCHANGED — only workbench access moved to DI.
//
// PARITY EVIDENCE STATUS (rule: ~/AGENTS.md "KHÔNG BỊA ĐẶT", 2026-10-19):
//   COMMUNITY-CORROBORATED (not REA): Cursor's Cmd+K opens an inline-edit
//     prompt; Alt+Enter asks a question about the code; Ctrl+L sends the
//     selection to chat; Esc rejects; Ctrl+Enter applies. Multiple community
//     sources agree (e.g. Contrary Research Cursor breakdown). Treat as
//     community evidence — NOT binary-verified.
//   UNKNOWN: the C1–C8 breakdown below cites internal mission docs
//     (docs/inline-edit, deep-docs-all.md), NOT Cursor sources. The
//     composer.diff_summary / composer.accept_diff event names have NO
//     evidence — marked UNKNOWN inline. "Cursor does X" claims about removed-
//     line rendering internals are UNKNOWN; D2/D3 describe OUR degradation,
//     not verified Cursor behavior.

import * as path from "path";
import { Disposable, toDisposable } from "../../../../base/common/lifecycle.js";
import { URI } from "../../../../base/common/uri.js";
import { extUri } from "../../../../base/common/resources.js";
import { Emitter, Event } from "../../../../base/common/event.js";
import { generateUuid } from "../../../../base/common/uuid.js";
import { Schemas } from "../../../../base/common/network.js";
import { MarkdownString } from "../../../../base/common/htmlContent.js";
import { Range } from "../../../../editor/common/core/range.js";
import { Position } from "../../../../editor/common/core/position.js";
import type { IPosition } from "../../../../editor/common/core/position.js";
import type { ICodeEditor } from "../../../../editor/browser/editorBrowser.js";
import type { ITextModel } from "../../../../editor/common/model.js";
import { IModelService } from "../../../../editor/common/services/model.js";
import { INotificationService } from "../../../../platform/notification/common/notification.js";
import { IDialogService } from "../../../../platform/dialogs/common/dialogs.js";
import { IConfigurationService } from "../../../../platform/configuration/common/configuration.js";
import { IProgressService, ProgressLocation } from "../../../../platform/progress/common/progress.js";
import { ICommandService } from "../../../../platform/commands/common/commands.js";
import { ITelemetryService } from "../../../../platform/telemetry/common/telemetry.js";
import { IUndoRedoService, IResourceUndoRedoElement, UndoRedoElementType } from "../../../../platform/undoRedo/common/undoRedo.js";
import { IContextKeyService, IContextKey } from "../../../../platform/contextkey/common/contextkey.js";
import { IWorkspaceContextService } from "../../../../platform/workspace/common/workspace.js";
import { IFileService } from "../../../../platform/files/common/files.js";
import { IEditorService, SIDE_GROUP } from "../../../../workbench/services/editor/common/editorService.js";
import { IStatusbarService, StatusbarAlignment, IStatusbarEntryAccessor } from "../../../../workbench/services/statusbar/browser/statusbar.js";
import { IOutputService } from "../../../../workbench/services/output/common/output.js";
import { IUntitledTextEditorService } from "../../../../workbench/services/untitled/common/untitledTextEditorService.js";
import { IdeCodeEngineAdapter } from "./ideCodeEngineAdapter.js";
import type { IComposerOutputChannel } from "../common/ideCodeEngineAdapter.js";
import { defaultEnginePath } from "../common/composerDataService.js";
import { IInlinePromptSelectionService } from "../common/inlinePromptSelection.js";
import { IInlineEditPromptBar, IPromptBarDataSelection, IPromptBarModelRef, resolveSameUriOverrideTarget, selectNewestPromptBarIdForUri } from "../common/inlineEditPromptBar.js";
import { filterModelsEligibleForCmdK } from "../common/cmdkModelEligibility.js";
import { IInlineEditChatBridge } from "../common/inlineEditChatBridge.js";
import { tryGetAiCodeTracking } from "../common/aiCodeTracking.js";
import { CellUri } from "../../notebook/common/notebookCommon.js";
import {
  findClosestPendingHunk,
  mergePartialHunks,
  PARTIAL_ACCEPT_TELEMETRY_EVENT,
  PARTIAL_REJECT_TELEMETRY_EVENT,
  PARTIAL_ACCEPT_UNDO_LABEL,
  PARTIAL_ACCEPT_UNDO_CODE,
  PARTIAL_REJECT_UNDO_LABEL,
  PARTIAL_REJECT_UNDO_CODE,
  type PartialHunkState,
  type IPartialHunkRange,
} from "../common/inlineDiffPartial.js";
import {
  INLINE_DIFFS_ACTIVE_EDITOR_WITH_DIFFS,
  INLINE_DIFFS_HAS_ACTIVELY_GENERATING_DIFF,
} from "../common/inlineDiffContextKeys.js";
// DEV-GAPS-53 (inline-diff-performance-protection / suppression-warning /
// deleted-code-margin / partial-widget, Cursor 3.25.9 binary evidence).
import {
  INLINE_DIFF_PERF_PROTECTION_CONFIG_KEY,
  INLINE_DIFF_MAX_DECORATIONS_CONFIG_KEY,
  INLINE_DIFF_PERF_PROTECTION_DEFAULT,
  INLINE_DIFF_MAX_DECORATIONS_DEFAULT,
  shouldSuppressInlineDiffDecorations,
} from "../common/inlineDiffPerf.js";
import type { IInlineDiffDeletedLine } from "../common/inlineDiffDeletedCodeMargin.js";
import { InlineDiffDeletedCodeMargin } from "../browser/inlineDiffDeletedCodeMargin.js";
import { InlineDiffPartialWidget } from "../browser/inlineDiffPartialWidget.js";
import { IInlineEditService, IInlineEditPartialDiffEvent, IInlineEditSuppressionInfo } from "../common/inlineEditService.js";
import { resolveEmptySelectionTarget, trimSelectionEndingAtColumn1 } from "../common/autoSelect.js";

/**
 * Structural ICodeEditor guard for IEditorService.activeTextEditorControl.
 * (type-only import — no runtime dependency on the editor browser layer.)
 */
function asCodeEditor(control: unknown): ICodeEditor | undefined {
  if (!control) {
    return undefined;
  }
  const candidate = control as Partial<ICodeEditor>;
  return typeof candidate.getModel === "function" && typeof candidate.deltaDecorations === "function"
    ? (control as ICodeEditor)
    : undefined;
}

/**
 * DD-SB-5: file key for aiCodeTracking attribution — workspace-relative when
 * possible (matches repo-relative paths at score time for the common
 * workspace-root repo layout), else the absolute path.
 */
export const INLINE_EDIT_CONTEXT_KEY = "ideAgent.inlineEditPending";

// NOTE (user directive 2026-10-19, refined same day): keep the curation caps
// that shape MODEL INPUT — focused context is a big part of why the agent
// feels smart (user: "không chừng nhờ cắt vậy mà chat cursor mới thông minh").
// Removed only the hostile refusal (MAX_TARGET_CHARS): the user's selection
// is the edit target, the model must see it whole — never refuse it.
const CONTEXT_LINES = 40;
const CONTEXT_CHARS = 4_000;
const MAX_FOLLOWUP_HISTORY_CHARS = 6_000;

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
 * Myers O(ND) line diff. Pure function — no workbench dependency.
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

interface InlineTarget {
  document: ITextModel;
  /** Range in the document that will be replaced (zero-width when inserting). */
  range: Range;
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
  editor: ICodeEditor;
  instruction: string;
  history: string[];
  proposedText: string;
  /** Document version right after the preview was applied. */
  previewVersion: number;
  /**
   * DD-SB-5: `linesAdded + linesRemoved` of the proposed diff, computed from
   * the preview hunks in showPreview. (UNKNOWN: "Cursor's per-event unit" and
   * the event names composer.diff_summary / composer.accept_diff — no evidence.)
   */
  suggestLines: number;
  /**
   * PARTIAL-DIFF-CORE (Cursor: `EPe.changes`) — per-change tracking for
   * partial accept/reject. Cursor filters resolved changes out of its
   * `changes` array; we keep every hunk with a fate in `hunkStates`.
   */
  hunks: DiffHunk[];
  hunkStates: PartialHunkState[];
  /**
   * Per-hunk `[start, end)` spans in the CURRENT merged text (0-based).
   * Recomputed on every partial reject — merged text shifts lines, so the
   * proposed-text coordinates in `hunks` go stale. Used for both the
   * closest-hunk search (Cursor's `addedRange`) and decoration rendering.
   */
  hunkRanges: IPartialHunkRange[];
  /**
   * Cursor's `inlineDiff.generationUUID` — carried on the partial
   * accept/reject telemetry (`inlineDiffAcceptPartial` /
   * `inlineDiffRejectPartial`) and the partial-diff events.
   */
  generationUUID: string;
  /**
   * Live merged text currently shown in the preview range. Partial rejects
   * rewrite the document; the preview range is recomputed from this, not
   * from the original proposal.
   *
   * HONEST DIVERGENCE: Cursor's preview is decoration-only (the document is
   * untouched until full accept), so it has no equivalent field.
   */
  currentText: string;
}

/**
 * InlineEditService — Cmd+K-style inline edit (Cmd+K UX is community-
 * corroborated as Cursor's; internals below are OUR implementation).
 *
 * Flow: prompt bar (native Monaco view zone, PromptBarViewZone) → engine
 * generates replacement code → inline diff preview (applied + decorated) →
 * accept (Ctrl+Enter) / reject (Esc) → optional follow-up refinement.
 *
 * How WE structure it (C1–C8 below come from internal mission docs
 * docs/inline-edit + deep-docs-all.md — NOT Cursor sources; UNKNOWN whether
 * Cursor implements it this way):
 *   C1 prompt bar at cursor · C2 inline generation (no selection) ·
 *   C3 inline edits on selection · C4 follow-up refines the edit ·
 *   C5 question mode (ask without editing) · C6 "do it" applies the
 *   suggested change · C7 default context gathering · C8 escalate to Agent.
 *
 * The prompt bar is a cursor-anchored view zone (the layer Cursor uses), so
 * the old quick-input limitations are gone: Alt+Enter switches to question
 * mode and the 3-mode switcher (Edit Selection / Quick Question / Send to
 * Chat) lives in the bar itself.
 */
export class InlineEditService extends Disposable implements IInlineEditService {

  declare readonly _serviceBrand: undefined;

  private session?: InlineSession;
  private adapter?: IdeCodeEngineAdapter;
  private addedDecoIds: string[] = [];
  private statusBarEntry?: IStatusbarEntryAccessor;
  private readonly inlineEditPendingKey: IContextKey<boolean>;
  /** Cursor's `_onDidAcceptPartialDiff` / `_onDidRejectPartialDiff`. */
  private readonly _onDidAcceptPartialDiff = this._register(new Emitter<IInlineEditPartialDiffEvent>());
  private readonly _onDidRejectPartialDiff = this._register(new Emitter<IInlineEditPartialDiffEvent>());
  readonly onDidAcceptPartialDiff: Event<IInlineEditPartialDiffEvent> = this._onDidAcceptPartialDiff.event;
  readonly onDidRejectPartialDiff: Event<IInlineEditPartialDiffEvent> = this._onDidRejectPartialDiff.event;
  /**
   * DEV-GAPS-53 (inline-diff-performance-protection): fired when the
   * change count exceeds `ide.inlineDiff.maxDecorations` and the
   * decorations are suppressed. The
   * `workbench.contrib.composer.inlineDiffSuppressionNotification`
   * contribution shows the "too many changes" warning on this event.
   */
  private readonly _onDidSuppressDiffDecorations = this._register(new Emitter<IInlineEditSuppressionInfo>());
  readonly onDidSuppressDiffDecorations: Event<IInlineEditSuppressionInfo> = this._onDidSuppressDiffDecorations.event;
  /**
   * generationUUID of the session whose suppression was already reported —
   * the "too many changes" warning fires once per generation, not on every
   * re-render while suppressed.
   */
  private suppressedGenerationUUID: string | undefined;
  /**
   * DEV-GAPS-53 (inline-diff-deleted-code-margin): one margin per session
   * editor, fed with the pending diff's deleted lines on every decoration
   * render. Recreated when the session moves to a different editor.
   */
  private deletedCodeMarginOwner?: { editor: ICodeEditor; margin: InlineDiffDeletedCodeMargin };
  /**
   * DEV-GAPS-53 (inline-diff-partial-accept-reject companion UI): one
   * `inlineDiffPartialWidget` per pending hunk (Cursor's
   * `partialWidgets`, id = diffId + "-partial" + index).
   */
  private partialWidgets: InlineDiffPartialWidget[] = [];
  /**
   * WORKER-GAPS-34C (inline-edit-command-ids): binary-verbatim context keys
   * for the `editor.action.inlineDiffs.*` preconditions —
   * `inlineDiffs.activeEditorWithDiffs` (accept/reject/partials) and
   * `hasActivelyGeneratingDiff` (cancelEdits, weight 600). Set alongside the
   * legacy `ideAgent.inlineEditPending` key so the Cursor command family's
   * preconditions hold on desktop; the extension mirrors them on web/aux.
   */
  private readonly activeEditorWithDiffsKey: IContextKey<boolean>;
  private readonly hasActivelyGeneratingDiffKey: IContextKey<boolean>;
  /** Cancels the in-flight generation turn (set by runEngineTurn). */
  private generationCancel: (() => void) | undefined;
  /** C7 — LRU of recently active file paths for default context gathering. */
  private readonly recentFiles: string[] = [];
  /** Last model key applied via adapter.setModel (prompt-bar model toggle). */
  private lastAppliedModelKey = "";

  constructor(
    @IEditorService private readonly editorService: IEditorService,
    @IModelService private readonly modelService: IModelService,
    @INotificationService private readonly notificationService: INotificationService,
    @IDialogService private readonly dialogService: IDialogService,
    @IConfigurationService private readonly configurationService: IConfigurationService,
    @IOutputService private readonly outputService: IOutputService,
    @IProgressService private readonly progressService: IProgressService,
    @IStatusbarService private readonly statusbarService: IStatusbarService,
    @IContextKeyService private readonly contextKeyService: IContextKeyService,
    @ICommandService private readonly commandService: ICommandService,
    @IWorkspaceContextService private readonly workspaceContextService: IWorkspaceContextService,
    @IFileService private readonly fileService: IFileService,
    @ITelemetryService private readonly telemetryService: ITelemetryService,
    @IUndoRedoService private readonly undoRedoService: IUndoRedoService,
    @IUntitledTextEditorService private readonly untitledTextEditorService: IUntitledTextEditorService,
    @IInlinePromptSelectionService private readonly selectionService: IInlinePromptSelectionService,
    @IInlineEditPromptBar private readonly promptBar: IInlineEditPromptBar,
    // F2-A (2026-10-20): DI-pure — the old non-service `opts.prefillChat`
    // callback is now the injectable IInlineEditChatBridge seam (implemented
    // in browser/, routed through the extension's chat surface).
    @IInlineEditChatBridge private readonly chatBridge: IInlineEditChatBridge,
  ) {
    super();
    this.inlineEditPendingKey = this.contextKeyService.createKey(INLINE_EDIT_CONTEXT_KEY, false);
    this.activeEditorWithDiffsKey = this.contextKeyService.createKey(INLINE_DIFFS_ACTIVE_EDITOR_WITH_DIFFS, false);
    this.hasActivelyGeneratingDiffKey = this.contextKeyService.createKey(INLINE_DIFFS_HAS_ACTIVELY_GENERATING_DIFF, false);
    this._register(this.editorService.onDidActiveEditorChange(() => {
      const editor = asCodeEditor(this.editorService.activeTextEditorControl);
      const model = editor?.getModel();
      if (!model || model.uri.scheme !== "file") return;
      const key = model.uri.fsPath;
      const at = this.recentFiles.indexOf(key);
      if (at >= 0) this.recentFiles.splice(at, 1);
      this.recentFiles.unshift(key);
      if (this.recentFiles.length > 8) this.recentFiles.length = 8;
    }));
    // Feed the prompt bar's model picker ("Open model toggle",
    // `cmdk.togglePromptBarModel`). The adapter is created lazily, so the
    // picker only lists engine models after the first generation — before
    // that it offers "Auto (engine default)".
    //
    // cmdk-model-eligibility (Cursor parity — staff forum 146433 + binary
    // `supportsCmdK` flag): the picker lists ONLY Cmd+K-eligible models —
    // non-thinking (non-reasoning), non-max-mode. Ineligible models simply
    // don't appear, exactly like Cursor (the reporter's Composer 1 "is
    // available in chat mode" but "excluded" from Cmd+K).
    this.promptBar.setModelProvider(async () => {
      const adapter = this.ensureAdapter();
      if (!adapter) return [];
      return filterModelsEligibleForCmdK(await adapter.listModels());
    });
  }

  get hasPendingEdit(): boolean {
    return this.session !== undefined;
  }

  /** Entry point for `composer.openInlinePrompt`. Re-entrant: acts as follow-up while a preview is pending. */
  async openPrompt(): Promise<void> {
    if (this.session) {
      await this.followUp();
      return;
    }
    const editor = asCodeEditor(this.editorService.activeTextEditorControl);
    const model = editor?.getModel();
    if (!editor || !model) {
      this.notificationService.error(
        "IDE Agent: open a file first — inline edit needs an active editor.",
      );
      return;
    }
    // KEYBOARD-PARITY (K-08): a selection attached via
    // `composer.addSelectionToInlinePrompt` wins over the live
    // cursor selection. Stale or foreign-document attachments are discarded.
    // (GAPS-171: the Ctrl/Cmd+Shift+K chord was reassigned to
    // `aipopup.action.modal.generate` per the Cursor 3.25.9 binary —
    // the attach command itself is now palette/programmatic-only.)
    const pendingSel = this.selectionService.takePendingSelection();
    const target =
      pendingSel &&
        !model.isDisposed() &&
        pendingSel.uri.toString() === model.uri.toString() &&
        pendingSel.version === model.getVersionId()
        ? await this.captureTarget(editor, model, pendingSel.range)
        : await this.captureTarget(editor, model);
    if (!target) return;
    await this.runPromptFlow(editor, target);
  }

  /**
   * GAPS-174 (#33): the create path of `aipopup.action.modal.generate` for
   * programmatic callers carrying `overrideUri`/`overrideRange` — the only
   * such caller in the binary is `cmdK.resolveConflictInCmdK`. Mirrors
   * StartEditPrompt (glass @40731968, run body re-sliced by GAPS-189):
   * the target uri is `n.overrideUri ?? active uri`; the prompt bars are
   * filtered by that uri FIRST and, when one is already open, run()
   * executes `aipopup.action.insertEditSelection` (override range
   * NON-EMPTY, used AS GIVEN — the column-1 trim belongs only to the
   * create path below) or `aipopup.action.focusEdit` (empty range) with
   * that bar's id and returns WITHOUT an id, so the caller aborts — no
   * setText/submit. GAPS-174 returned `undefined` there without the
   * insert/focus side effect; QA-185 round 24 flagged that gap as NF-1
   * and GAPS-189 mirrors the side effect here (the modal.generate
   * override branch performs the same step first, via the shared
   * `resolveSameUriOverrideTarget` helper, so through that caller this
   * branch is a contract-level backstop, not a second firing).
   * Otherwise the editor for the uri is opened, the target is captured
   * from the override range (captureTarget applies the binary's
   * column-1 trim), the standard prompt flow is started WITHOUT
   * awaiting it, and the new bar's id is returned once the bar exists
   * (the binary: `return le.id` @40739556).
   *
   * Remaining ordering difference (noted by QA-185, not required for
   * NF-1): the binary opens the editor for `overrideUri` BEFORE the
   * same-uri check; the fork checks first. A bar can only exist inside
   * an open editor (it is a view zone), and in the real CodeLens flow
   * that editor is the active one, so the insert/focus commands land
   * on the same editor the binary's open-first order would produce.
   */
  async openPromptForRange(uri: URI, range: Range): Promise<string | undefined> {
    if (this.session) return undefined;
    const sameUri = resolveSameUriOverrideTarget(this.promptBar.getPromptBars(), uri.toString(), range);
    if (sameUri.kind === "insertEditSelection") {
      // Binary: `c.executeCommand(ezc, ce.id)` — ezc is the id of
      // `AipopupInsertEditSelectionAction` (browser/composerActions.ts);
      // the electron-browser layer addresses it by literal id, exactly
      // like the binary's executeCommand(string).
      await this.commandService.executeCommand("aipopup.action.insertEditSelection", sameUri.barId);
      return undefined; // binary: same-uri bar exists → StartEditPrompt returns no id
    }
    if (sameUri.kind === "focusEdit") {
      // Binary: `c.executeCommand(C$e, ce.id)` — C$e is the id of
      // `AipopupFocusEditAction` (browser/composerActions.ts).
      await this.commandService.executeCommand("aipopup.action.focusEdit", sameUri.barId);
      return undefined; // binary: same-uri bar exists → StartEditPrompt returns no id
    }
    const pane = await this.editorService.openEditor({ resource: uri }).catch(() => undefined);
    const editor = asCodeEditor(pane?.getControl()) ?? asCodeEditor(this.editorService.activeTextEditorControl);
    const model = editor?.getModel();
    if (!editor || !model || model.isDisposed() || model.uri.toString() !== uri.toString()) {
      return undefined;
    }
    const target = await this.captureTarget(editor, model, range);
    if (!target) return undefined;
    void this.runPromptFlow(editor, target);
    // showPromptBar creates the bar synchronously inside runPromptFlow's
    // first await; poll briefly in case of scheduling delays.
    for (let attempt = 0; attempt < 10; attempt++) {
      const barId = selectNewestPromptBarIdForUri(this.promptBar.getPromptBars(), uri.toString());
      if (barId !== undefined) return barId;
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
    }
    return undefined;
  }

  /** The prompt → answer → generation flow shared by openPrompt/openPromptForRange. */
  private async runPromptFlow(editor: ICodeEditor, target: InlineTarget): Promise<void> {
    const answer = await this.promptForInstruction(editor, target, undefined, false);
    if (!answer) return; // user cancelled
    if (answer.kind === "question") {
      await this.askQuestion(editor, target, answer.text, answer.selections);
      return;
    }
    if (answer.kind === "escalate") {
      await this.escalateWithInstruction(answer.text, target);
      return;
    }
    await this.runGeneration(editor, target, answer.text, [], answer.model, answer.selections);
  }

  /** `editor.action.inlineDiffs.acceptAll` — keep the previewed change. */
  accept(): void {
    if (!this.session) return;
    // DD-SB-5: aiCodeTracking `composer.accept_diff` analog — the accepted
    // diff's lines plus per-file attribution for commit scoring.
    // PARTIAL-DIFF-CORE: hunks already accepted via acceptPartial() were
    // attributed per-op — only the still-pending hunks count here (mirrors
    // the extension's accept()).
    const s = this.session;
    try {
      const t = tryGetAiCodeTracking();
      if (t) {
        let lines = 0;
        const finalStates = s.hunkStates.map((st) => (st === "rejected" ? "rejected" : "accepted") as PartialHunkState);
        s.hunks.forEach((h, i) => {
          if (s.hunkStates[i] === "pending") {
            lines += h.newEnd - h.newStart + (h.origEnd - h.origStart);
          }
        });
        if (lines > 0) {
          t.recordAccept("COMPOSER", lines);
          const acceptedText = mergePartialHunks(
            s.target.originalText.split("\n"),
            s.proposedText.split("\n"),
            s.hunks,
            finalStates,
          ).lines.join("\n");
          t.recordAcceptedLines("COMPOSER", this.trackingFileKey(s.target.document.uri), acceptedText);
        }
      }
    } catch {
      /* stats must never break the accept flow */
    }
    this.clearSession();
  }

  /** Compute the exact range the preview now occupies: original start + current merged-text extent. */
  private previewRange(s: InlineSession): Range {
    const start = s.target.range.getStartPosition();
    const lines = s.currentText.split("\n");
    const end =
      lines.length === 1
        ? new Position(start.lineNumber, start.column + lines[0]!.length)
        : new Position(
          start.lineNumber + lines.length - 1,
          lines[lines.length - 1]!.length,
        );
    return Range.fromPositions(start, end);
  }

  /** `editor.action.inlineDiffs.rejectAll` — restore the original text. */
  async reject(): Promise<void> {
    const s = this.session;
    if (!s) return;
    const document = s.target.document;
    if (document.getVersionId() !== s.previewVersion) {
      const { confirmed } = await this.dialogService.confirm({
        type: "warning",
        message: "IDE Agent: the file changed during the preview. Rejecting will overwrite those changes.",
        primaryButton: "Reject anyway",
        cancelButton: "Keep",
      });
      if (!confirmed) return;
    }
    try {
      const ok = s.editor.executeEdits("ide-inline-edit", [
        { range: this.previewRange(s), text: s.target.originalText },
      ]);
      if (!ok) {
        this.notificationService.error("IDE Agent: could not revert the inline edit.");
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.notificationService.error(`IDE Agent: could not revert the inline edit — ${message}`);
    }
    this.clearSession();
  }

  // ------------------------------------------------------------------ //
  // PARTIAL-DIFF-CORE — Cursor's `InlineDiffService.acceptPartialDiff` /
  // `rejectPartialDiff` (workbench.glass.main.js), migrated to the core
  // service. Previously these commands delegated to the ide-agent extension
  // runtime (`ide.acceptPartialInlineEdit`); the core now owns the mechanism.
  // ------------------------------------------------------------------ //

  /**
   * Cursor's `getUndoResourceForInlineDiff`: notebook-cell diffs resolve to
   * the notebook URI so the undo element lands on the right resource.
   */
  private undoResourceForInlineDiff(uri: URI): URI {
    if (uri.scheme === Schemas.vscodeNotebookCell) {
      return CellUri.parse(uri)?.notebook ?? uri;
    }
    return uri;
  }

  /**
   * Push a Cursor-style undo element for a partial op. The element owns both
   * the hunk fate and the document text, so one Ctrl+Z undoes the whole op.
   *
   * HONEST DIVERGENCE: Cursor calls `pushUndoElement(el,
   * {breakConsolidation: true})`; stock VS Code's
   * `IUndoRedoService.pushElement` has no such option. Ours is a distinct
   * `IResourceUndoRedoElement` (never merged with text edits), and the
   * document mutation itself goes through the untracked
   * `ITextModel.applyEdits` path — exactly like Cursor's
   * `textEditorModel.applyEdits([d], true)` — so no competing model undo
   * entry exists for the same op.
   */
  private pushPartialUndoElement(
    s: InlineSession,
    kind: "accept" | "reject",
    undo: () => void,
    redo: () => void,
  ): void {
    const element: IResourceUndoRedoElement = {
      type: UndoRedoElementType.Resource,
      resource: this.undoResourceForInlineDiff(s.target.document.uri),
      label: kind === "accept" ? PARTIAL_ACCEPT_UNDO_LABEL : PARTIAL_REJECT_UNDO_LABEL,
      code: kind === "accept" ? PARTIAL_ACCEPT_UNDO_CODE : PARTIAL_REJECT_UNDO_CODE,
      undo,
      redo,
    };
    this.undoRedoService.pushElement(element);
  }

  /**
   * Cursor's `computeDecorations()`: re-render the pending-diff decorations
   * from the current hunk states. Only `pending` hunks are decorated —
   * accepted/rejected hunks lose the pending-diff styling. Ranges come from
   * `s.hunkRanges` (merged-text coordinates), so decorations stay aligned
   * after partial rejects shift lines.
   */
  private renderHunkDecorations(s: InlineSession): void {
    const editor = s.editor;
    const baseLine = s.target.range.startLineNumber;

    // DEV-GAPS-53 (inline-diff-performance-protection, Cursor
    // `cursor.inlineDiff.enablePerformanceProtection`, default true): when
    // the pending change count exceeds maxDecorations
    // (`inline_diff_performance_config.maxDecorations`, default 100), ALL
    // inline-diff rendering (decorations, partial widgets, deleted-code
    // margin) is suppressed to prevent editor unresponsiveness, and
    // `onDidSuppressDiffDecorations` fires — the suppression-warning
    // contribution turns it into the `inlineDiff.tooManyChangesWarning`
    // notification (never-show-again backed by notification-service state).
    const pendingCount = s.hunkStates.filter((st) => st === "pending").length;
    const protectionEnabled =
      this.configurationService.getValue<boolean>(INLINE_DIFF_PERF_PROTECTION_CONFIG_KEY) ??
      INLINE_DIFF_PERF_PROTECTION_DEFAULT;
    const maxDecorations =
      this.configurationService.getValue<number>(INLINE_DIFF_MAX_DECORATIONS_CONFIG_KEY) ??
      INLINE_DIFF_MAX_DECORATIONS_DEFAULT;
    if (shouldSuppressInlineDiffDecorations(pendingCount, protectionEnabled, maxDecorations)) {
      this.addedDecoIds = editor.deltaDecorations(this.addedDecoIds, []);
      this.clearPartialWidgets();
      this.deletedCodeMarginOwner?.margin.clear();
      // Fire once per generation (the never-show-again warning must not
      // spam on every re-render while the diff stays suppressed).
      if (this.suppressedGenerationUUID !== s.generationUUID) {
        this.suppressedGenerationUUID = s.generationUUID;
        this._onDidSuppressDiffDecorations.fire({
          changeCount: pendingCount,
          maxDecorations,
          generationUUID: s.generationUUID,
        });
      }
      return;
    }
    // Back under the limit (or protection off): allow a future suppression
    // to report again.
    this.suppressedGenerationUUID = undefined;

    const addedRanges: Range[] = [];
    const removedLines: string[] = [];
    const deletedLines: IInlineDiffDeletedLine[] = [];
    const oldLines = s.target.originalText.split("\n");
    s.hunks.forEach((hunk, i) => {
      if (s.hunkStates[i] !== "pending") {
        return;
      }
      const r = s.hunkRanges[i]!;
      if (r.end > r.start) {
        addedRanges.push(new Range(baseLine + r.start, 1, baseLine + r.end - 1, 1));
      }
      if (hunk.origEnd > hunk.origStart) {
        // D2: core decorations cannot inject before-content text — the
        // removed lines ride along as a hover on the added range instead.
        removedLines.push(
          ...oldLines.slice(hunk.origStart, hunk.origEnd).map((line) => `- ${line}`),
        );
        // DEV-GAPS-53 (inline-diff-deleted-code-margin): the deleted code
        // also surfaces in the scroll-aware deleted-code margin, anchored
        // at the hunk's first merged-preview line.
        for (let l = hunk.origStart; l < hunk.origEnd; l++) {
          deletedLines.push({
            anchorLineNumber: baseLine + r.start,
            text: oldLines[l] ?? "",
            hunkIndex: i,
          });
        }
      }
    });
    // SETTINGS-PARITY: `ide.cmdk.useThemedDiffBackground` (mirrors
    // cursor.cmdk.useThemedDiffBackground2). Off = fixed neutral greens.
    // D3: the actual background lives in the browser contribution's
    // stylesheet (.composer-inline-edit-added / .composer-inline-edit-added-plain).
    const useThemedDiff = this.configurationService.getValue<boolean>("ide.cmdk.useThemedDiffBackground") ?? true;
    const hover = removedLines.length > 0
      ? new MarkdownString(`**Removed lines:**\n\`\`\`diff\n${removedLines.join("\n")}\n\`\`\``)
      : undefined;
    this.addedDecoIds = editor.deltaDecorations(this.addedDecoIds, addedRanges.map((range) => ({
      range,
      options: {
        description: "ide-agent-inline-edit-added",
        className: useThemedDiff ? "composer-inline-edit-added" : "composer-inline-edit-added-plain",
        isWholeLine: true,
        hoverMessage: hover ? [hover] : undefined,
      },
    })));

    // DEV-GAPS-53: feed the scroll-aware deleted-code margin and rebuild
    // the per-hunk partial widgets (Cursor's `partialWidgets`,
    // id = diffId + "-partial" + index).
    this.deletedCodeMarginFor(editor).setDeletedLines(deletedLines);
    this.renderPartialWidgets(s, pendingCount);
  }

  /**
   * The deleted-code margin for `editor` (one per session editor; recreated
   * when the session moves to a different editor).
   */
  private deletedCodeMarginFor(editor: ICodeEditor): InlineDiffDeletedCodeMargin {
    if (this.deletedCodeMarginOwner?.editor !== editor) {
      this.deletedCodeMarginOwner?.margin.dispose();
      this.deletedCodeMarginOwner = { editor, margin: new InlineDiffDeletedCodeMargin(editor) };
    }
    return this.deletedCodeMarginOwner.margin;
  }

  /** Dispose all per-hunk partial widgets. */
  private clearPartialWidgets(): void {
    for (const widget of this.partialWidgets) {
      widget.dispose();
    }
    this.partialWidgets = [];
  }

  /**
   * Rebuild one `inlineDiffPartialWidget` per pending hunk: a view zone
   * above the hunk with Accept/Reject controls for that hunk only
   * (Cursor's companion UI for partial accept/reject).
   */
  private renderPartialWidgets(s: InlineSession, pendingCount: number): void {
    this.clearPartialWidgets();
    const baseLine = s.target.range.startLineNumber;
    s.hunks.forEach((hunk, i) => {
      if (s.hunkStates[i] !== "pending") {
        return;
      }
      const r = s.hunkRanges[i]!;
      const hunkStartLine = baseLine + r.start;
      const anchor = new Position(hunkStartLine, 1);
      this.partialWidgets.push(
        new InlineDiffPartialWidget(s.editor, {
          hunkIndex: i,
          pendingCount,
          hunkStartLineNumber: hunkStartLine,
          onAccept: () => {
            void this.acceptPartial(anchor);
          },
          onReject: () => {
            void this.rejectPartial(anchor);
          },
        }),
      );
    });
  }

  /**
   * Resolve the hunk a partial op applies to: the pending change nearest
   * `position` (Cursor's `findClosestChangeIndex`), defaulting to the
   * cursor. Returns -1 when no hunk is pending.
   */
  private resolvePartialHunk(s: InlineSession, position?: IPosition): number {
    const pos = position ?? s.editor.getPosition() ?? undefined;
    if (!pos) {
      return s.hunkStates.findIndex((st) => st === "pending");
    }
    return findClosestPendingHunk(
      s.hunkRanges,
      s.hunkStates,
      s.target.range.startLineNumber,
      pos.lineNumber,
    );
  }

  /**
   * Cursor: `InlineDiffService.acceptPartialDiff(diffId, position)` —
   * accept only the pending change nearest `position`. The change's text is
   * already showing (the preview is applied); accepting commits the hunk's
   * fate, recomputes decorations, logs `inlineDiffAcceptPartial`, pushes the
   * "Undo Accept Partial Diff" undo element, and fires
   * `onDidAcceptPartialDiff`. Returns true when every change is resolved
   * (Cursor's `isDone`) — then the prompt bar closes.
   */
  async acceptPartial(position?: IPosition): Promise<boolean> {
    const s = this.session;
    if (!s) {
      this.notificationService.info("IDE Agent: no inline edit preview is open — nothing to accept.");
      return false;
    }
    const idx = this.resolvePartialHunk(s, position);
    if (idx < 0) {
      this.notificationService.info("IDE Agent: every change in this preview is already resolved — use accept/reject to finish.");
      return true;
    }
    const hunk = s.hunks[idx]!;
    const acceptedLines = s.proposedText.split("\n").slice(hunk.newStart, hunk.newEnd);
    const previousContent = s.currentText;

    // Cursor: `telemetryService.publicLogCapture("inlineDiffAcceptPartial",
    // {generationUUID})`.
    this.telemetryService.publicLog(PARTIAL_ACCEPT_TELEMETRY_EVENT, {
      generationUUID: s.generationUUID,
    });

    // No document change: the accepted hunk already shows the proposed text.
    // The undo element restores the pending fate (+ decorations) on Ctrl+Z.
    const applyAccept = (): void => {
      if (this.session !== s) return;
      s.hunkStates[idx] = "accepted";
      this.renderHunkDecorations(s);
    };
    this.pushPartialUndoElement(s, "accept", () => {
      if (this.session !== s) return;
      s.hunkStates[idx] = "pending";
      this.renderHunkDecorations(s);
    }, applyAccept);
    applyAccept();

    // DD-SB-5: attribute the accepted hunk's lines immediately (a later
    // accept() only counts hunks that are still pending).
    try {
      const t = tryGetAiCodeTracking();
      if (t) {
        t.recordAccept("COMPOSER", hunk.newEnd - hunk.newStart + (hunk.origEnd - hunk.origStart));
        t.recordAcceptedLines(
          "COMPOSER",
          this.trackingFileKey(s.target.document.uri),
          acceptedLines.join("\n"),
        );
      }
    } catch {
      /* stats must never break the accept flow */
    }

    const isDone = s.hunkStates.every((st) => st !== "pending");
    this._onDidAcceptPartialDiff.fire({
      requestId: s.generationUUID,
      file: s.target.document.uri.toString(),
      previousContent,
      updatedContent: s.currentText,
      isDone,
      change: { accepted: acceptedLines, rejected: [] },
    });
    if (isDone) {
      this.finishPartialSession(s);
    }
    return isDone;
  }

  /**
   * Cursor: `InlineDiffService.rejectPartialDiff(diffId, position)` —
   * reject only the pending change nearest `position`. The hunk's region is
   * rewritten to the original text (via the untracked `ITextModel.applyEdits`
   * path, like Cursor's `textEditorModel.applyEdits([d], true)`), the
   * "Undo Reject Partial Diff" undo element owns text + fate, telemetry
   * `inlineDiffRejectPartial` is logged, and `onDidRejectPartialDiff` fires.
   * Returns true when every change is resolved — then the prompt bar closes.
   */
  async rejectPartial(position?: IPosition): Promise<boolean> {
    const s = this.session;
    if (!s) {
      this.notificationService.info("IDE Agent: no inline edit preview is open — nothing to reject.");
      return false;
    }
    const document = s.target.document;
    if (document.getVersionId() !== s.previewVersion) {
      const { confirmed } = await this.dialogService.confirm({
        type: "warning",
        message: "IDE Agent: the file changed during the preview. Rejecting will overwrite those changes.",
        primaryButton: "Reject anyway",
        cancelButton: "Keep",
      });
      if (!confirmed) return false;
    }
    const idx = this.resolvePartialHunk(s, position);
    if (idx < 0) {
      this.notificationService.info("IDE Agent: every change in this preview is already resolved — use accept/reject to finish.");
      return true;
    }
    const hunk = s.hunks[idx]!;
    const origLines = s.target.originalText.split("\n");
    const newLines = s.proposedText.split("\n");
    const rejectedLines = origLines.slice(hunk.origStart, hunk.origEnd);
    const previousContent = s.currentText;
    const previousRanges = s.hunkRanges;

    // Cursor: `telemetryService.publicLogCapture("inlineDiffRejectPartial",
    // {generationUUID})`.
    this.telemetryService.publicLog(PARTIAL_REJECT_TELEMETRY_EVENT, {
      generationUUID: s.generationUUID,
    });

    const nextStates = s.hunkStates.slice();
    nextStates[idx] = "rejected";
    const merged = mergePartialHunks(origLines, newLines, s.hunks, nextStates);
    const mergedText = merged.lines.join("\n");

    const applyReject = (): boolean => {
      if (this.session !== s) return false;
      try {
        // Untracked model edit (Cursor: `textEditorModel.applyEdits([d],
        // true)`): the custom undo element below is the sole undo entry for
        // this op — no competing model undo element is created.
        document.applyEdits([{ range: this.previewRange(s), text: mergedText }]);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.notificationService.error(`IDE Agent: could not reject this change — ${message}`);
        return false;
      }
      // Fresh copies every time: undo()/redo() must never observe a state
      // array mutated by a previous cycle.
      s.hunkStates = nextStates.slice();
      s.hunkRanges = merged.hunkRanges;
      s.currentText = mergedText;
      s.previewVersion = document.getVersionId();
      this.renderHunkDecorations(s);
      return true;
    };
    const undoReject = (): void => {
      if (this.session !== s) return;
      try {
        // previewRange(s) still covers the merged text here (currentText is
        // only swapped after the edit lands).
        document.applyEdits([{ range: this.previewRange(s), text: previousContent }]);
      } catch {
        /* best effort — the fate restore below still runs */
      }
      const undoneStates = s.hunkStates.slice();
      undoneStates[idx] = "pending";
      s.hunkStates = undoneStates;
      s.hunkRanges = previousRanges;
      s.currentText = previousContent;
      s.previewVersion = document.getVersionId();
      this.renderHunkDecorations(s);
    };
    this.pushPartialUndoElement(s, "reject", undoReject, () => { applyReject(); });
    if (!applyReject()) {
      return false;
    }

    const isDone = nextStates.every((st) => st !== "pending");
    this._onDidRejectPartialDiff.fire({
      requestId: s.generationUUID,
      file: s.target.document.uri.toString(),
      previousContent,
      updatedContent: mergedText,
      isDone,
      change: { accepted: [], rejected: rejectedLines },
    });
    if (isDone) {
      this.finishPartialSession(s);
    }
    return isDone;
  }

  /**
   * Cursor: when the last change resolves, the diff is removed with
   * `{closePromptBar: true, ...}`. The document already shows the
   * fully-resolved text (accepted hunks kept, rejected hunks reverted), so
   * finishing only closes the prompt bar and clears the session — no text
   * rewrite, no prev-state store
   * (Cursor: `{accepted, shouldStorePrevState: false}`).
   */
  private finishPartialSession(s: InlineSession): void {
    if (this.session !== s) {
      return;
    }
    try {
      this.promptBar.closePromptBar(s.editor);
    } catch {
      /* the bar may already be gone */
    }
    this.clearSession();
  }

  /** True while an inline-diff generation turn is in flight. */
  get isGenerating(): boolean {
    return this.generationCancel !== undefined;
  }

  /**
   * `editor.action.inlineDiffs.cancelEdits` — abort the in-flight generation
   * (Cursor's J4 `cancelGeneration(n,"both")`, weight 600). Breaks the
   * engine-turn stream; `runEngineTurn` then returns undefined and
   * `runGeneration` exits without a preview, like a user-cancelled progress
   * notification.
   */
  cancelGeneration(): void {
    this.generationCancel?.();
  }

  /** `composer.sendToAgent` — escalate the inline task to a full agent turn (C8). */
  async escalateToAgent(): Promise<void> {
    const s = this.session;
    if (s) {
      await this.escalateWithInstruction(s.instruction, s.target);
      return;
    }
    const editor = asCodeEditor(this.editorService.activeTextEditorControl);
    const model = editor?.getModel();
    if (!editor || !model) {
      this.notificationService.error(
        "IDE Agent: open a file first — there is nothing to send to the agent.",
      );
      return;
    }
    const target = await this.captureTarget(editor, model);
    if (!target) return;
    const answer = await this.promptForInstruction(editor, target, undefined, false);
    if (!answer) return;
    if (answer.kind === "question") {
      await this.askQuestion(editor, target, answer.text, answer.selections);
      return;
    }
    // "edit" and "escalate" both land in the agent with the typed text.
    await this.escalateWithInstruction(answer.text, target);
  }

  /**
   * Build the agent-turn prompt from an inline instruction + target, then
   * hand it to chat. (Community-corroborated: Ctrl/⌘+L in Cursor sends the
   * selection to chat.) Ours prefills the real chat composer and focuses it.
   */
  private async escalateWithInstruction(instruction: string, target: InlineTarget): Promise<void> {
    const startLine = target.range.startLineNumber;
    const endLine = target.insertMode
      ? startLine
      : target.range.endLineNumber;
    // Curation restored (user directive 2026-10-19 refined): the escalated
    // chat prompt carries a focused slice of the code, not the whole file.
    const code =
      target.originalText.length > 4000
        ? target.originalText.slice(0, 4000) + "\n…(truncated)"
        : target.originalText;
    const fence = FENCE_ALIASES[target.languageId.toLowerCase()] ?? target.languageId;
    const text = [
      instruction,
      "",
      `Context — ${target.fileLabel} (${target.languageId}), line${startLine === endLine ? "" : "s"} ${startLine}${startLine === endLine ? "" : `–${endLine}`}:`,
      `\`\`\`${fence}`,
      code,
      "```",
    ].join("\n");
    await this.chatBridge.prefillChat(text);
  }

  override dispose(): void {
    this.clearSession();
    super.dispose();
  }

  // ------------------------------------------------------------------ //

  /**
   * DD-SB-5: file key for aiCodeTracking attribution — workspace-relative when
   * possible, else the absolute path.
   */
  private trackingFileKey(uri: URI): string {
    return this.asRelativePath(uri);
  }

  private asRelativePath(uri: URI): string {
    try {
      const folder = this.workspaceContextService.getWorkspaceFolder(uri);
      if (folder) {
        return extUri.relativePath(folder.uri, uri) ?? uri.fsPath;
      }
      return uri.fsPath;
    } catch {
      return uri.fsPath;
    }
  }

  /**
   * GAPS-172 (#28 inline-edit-empty-selection): resolve the editor's folding
   * region at `lineNumber` the way Cursor's folding accessor (`vH.get(editor)`)
   * does — structurally, so a missing controller/model degrades to the
   * binary's own fallback (single-line range) instead of failing.
   */
  private async resolveFoldingRegion(editor: ICodeEditor, lineNumber: number): Promise<{ startLineNumber: number; endLineNumber: number } | null | undefined> {
    try {
      const controller = editor.getContribution("editor.contrib.folding") as unknown as { getFoldingModel(): Promise<{ getRegionAtLine(line: number): { startLineNumber: number; endLineNumber: number } | null } | null> | null } | null;
      if (!controller) return undefined;
      const foldingModel = await controller.getFoldingModel();
      if (!foldingModel) return undefined;
      const region = foldingModel.getRegionAtLine(lineNumber);
      return region ? { startLineNumber: region.startLineNumber, endLineNumber: region.endLineNumber } : null;
    } catch {
      return undefined;
    }
  }

  private async captureTarget(editor: ICodeEditor, document: ITextModel, explicitRange?: Range): Promise<InlineTarget | undefined> {
    if (document.isDisposed()) return undefined;
    const selection = editor.getSelection();
    if (!selection) return undefined;
    // GAPS-172: StartEditPrompt selection normalization (Cursor 3.25.9,
    // workbench.glass.main.js @40733372 trim / @40734485 heuristicSelect).
    // (1) Column-1 trim: a non-empty multi-line selection (the live selection
    // or an explicit/override range — the binary trims `M =
    // overrideRange ?? getSelection()`) ending at column 1 drops its last
    // line. (2) heuristicSelect: an empty selection on a NON-EMPTY line is
    // expanded by `autoSelectService.heuristicSelect` to the top-scored
    // line/group/folding range instead of staying a zero-width insert; an
    // empty selection on an empty line keeps the fork's insert mode. The
    // binary gates (2) on `insertNewLine ?? true`; the fork's openPrompt
    // path has no insertNewLine=false caller, so the default applies.
    const effective = explicitRange ?? selection;
    const trimmed = trimSelectionEndingAtColumn1(document, effective);
    // GAPS-174 (QA-175 steer): an EMPTY explicit/override range takes the
    // binary's empty-`M` flow too — StartEditPrompt computes
    // `M = n?.overrideRange ?? selection` and then applies the SAME
    // empty-selection handling to it (heuristicSelect on a non-empty
    // line, zero-width insert on an empty line; glass @40733337+). The
    // only caller today is openPromptForRange (#33), whose JcI-shaped
    // range (startLine,1)-(endLine,1) is empty exactly when
    // startLine === endLine — defensive parity, handled at the first
    // wired caller as QA-175 asked.
    const explicitEmpty = explicitRange !== undefined && explicitRange.isEmpty();
    let insertMode = explicitEmpty || (!explicitRange && selection.isEmpty());
    const anchor = explicitEmpty ? explicitRange.getStartPosition() : selection.getPosition();
    let range: Range;
    if (explicitRange && !explicitEmpty) {
      range = document.validateRange(new Range(trimmed.startLineNumber, trimmed.startColumn, trimmed.endLineNumber, trimmed.endColumn));
    } else if (insertMode) {
      // GAPS-189: the empty-`M` decision itself (heuristic expand on a
      // non-empty anchor line / zero-width insert on an empty one) lives
      // in the pure `resolveEmptySelectionTarget` helper
      // (common/autoSelect.ts) so the explicit-empty-range case carries
      // a regression lock (QA-185 round 24 point 5). The folding region
      // is resolved lazily by the helper, only on the heuristic path —
      // exactly as before this extraction.
      const resolved = await resolveEmptySelectionTarget(document, { lineNumber: anchor.lineNumber, column: anchor.column }, async () => ({ foldingRegion: await this.resolveFoldingRegion(editor, anchor.lineNumber) }));
      insertMode = resolved.insertMode;
      range = resolved.insertMode
        ? Range.fromPositions(anchor, anchor)
        : document.validateRange(new Range(resolved.range.startLineNumber, resolved.range.startColumn, resolved.range.endLineNumber, resolved.range.endColumn));
    } else {
      range = document.validateRange(new Range(trimmed.startLineNumber, trimmed.startColumn, trimmed.endLineNumber, trimmed.endColumn));
    }
    const originalText = document.getValueInRange(range);
    // NOTE (user directive 2026-10-19): no artificial size cap on the
    // selection. This is our own system — the user edits whatever they
    // select; the engine/model context window is the only real bound.
    const startLine = range.startLineNumber;
    const endLine = insertMode ? startLine : range.endLineNumber;
    const beforeStart = Math.max(1, startLine - CONTEXT_LINES);
    const afterEnd = Math.min(document.getLineCount(), endLine + CONTEXT_LINES);
    // Curation cap restored (user directive 2026-10-19 refined): surrounding
    // context is auto-attached — keep it focused so the model stays sharp.
    const cap = (text: string): string =>
      text.length > CONTEXT_CHARS ? text.slice(0, CONTEXT_CHARS) + "\n…(truncated)" : text;
    const contextBefore =
      beforeStart < startLine
        ? cap(document.getValueInRange(new Range(beforeStart, 1, startLine, 1)))
        : "";
    const contextAfter =
      afterEnd > endLine
        ? cap(
          document.getValueInRange(
            new Range(endLine + 1, 1, afterEnd, document.getLineMaxColumn(afterEnd)),
          ),
        )
        : "";
    return {
      document,
      range,
      originalText,
      version: document.getVersionId(),
      languageId: document.getLanguageId(),
      fileLabel: this.asRelativePath(document.uri),
      contextBefore,
      contextAfter,
      insertMode,
    };
  }

  /**
   * Show the prompt bar as a native Monaco view zone above the target's first
   * line (Cursor's PromptBarViewZone layer). Maps the bar's 3 modes onto our
   * flow: edit_selection → edit, quick_question → question, send_to_chat →
   * escalate. Returns undefined when the user cancels (Esc / close command).
   */
  private async promptForInstruction(
    editor: ICodeEditor,
    target: InlineTarget,
    previous: string | undefined,
    followUp: boolean,
  ): Promise<{ kind: "edit" | "question" | "escalate"; text: string; model?: IPromptBarModelRef; selections: readonly IPromptBarDataSelection[] } | undefined> {
    const result = await this.promptBar.showPromptBar(editor, {
      startLineNumber: target.range.startLineNumber,
      targetRange: target.range,
      previous,
      followUp,
    });
    if (!result) return undefined; // user cancelled
    const kind =
      result.mode === "quick_question" ? "question"
        : result.mode === "send_to_chat" ? "escalate"
          : "edit";
    return { kind, text: result.text, model: result.model, selections: result.selections };
  }

  private ensureAdapter(): IdeCodeEngineAdapter | undefined {
    if (this.adapter) return this.adapter;
    if ((this.configurationService.getValue<string>("ide.agent.engineMode") ?? "sidecar") !== "sidecar") {
      // Honest precondition, not a scaffold: the whole composer (chat
      // included) needs the sidecar engine + a configured model to generate.
      void this.dialogService.confirm({
        type: "warning",
        message: "IDE Agent: inline edit needs the ide-code engine.",
        detail: 'Set "ide.agent.engineMode" to "sidecar" and configure a model, then try again.',
        primaryButton: "Open Settings",
      }).then(({ confirmed }) => {
        if (confirmed) {
          void this.commandService.executeCommand(
            "workbench.action.openSettings",
            "ide.agent.engineMode",
          );
        }
      });
      return undefined;
    }
    const coreChannel = this.outputService.getChannel("ide-agent-inline-edit");
    const output: IComposerOutputChannel = coreChannel
      ? {
        append: (value: string) => coreChannel.append(value),
        appendLine: (value: string) => coreChannel.append(value + "\n"),
      }
      : {
        // TODO(composer): register the `ide-agent-inline-edit` output channel
        // in the composer workbench contribution via OutputChannelRegistry.
        append: (value: string) => console.log(`[ide-agent-inline-edit] ${value}`),
        appendLine: (value: string) => console.log(`[ide-agent-inline-edit] ${value}`),
      };
    const adapter = new IdeCodeEngineAdapter(
      {
        enginePath: this.configurationService.getValue<string>("ide.agent.enginePath") || defaultEnginePath(),
        output,
        // Inline edits are single-shot code rewrites; the prompt forbids tool
        // use, so any approval request is auto-skipped rather than blocking.
        requestApproval: () => Promise.resolve({ optionId: "skip" }),
        getMode: () => "edit",
      },
      this.configurationService,
    );
    this.adapter = adapter;
    this._register(toDisposable(() => adapter.dispose()));
    return adapter;
  }

  private async buildEditPrompt(target: InlineTarget, instruction: string, history: string[], selections: readonly IPromptBarDataSelection[] = []): Promise<string> {
    const lines: string[] = [
      "You are an expert code editor performing an inline edit.",
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
    // DEV-GAPS-68 (`cmdk-insert-edit-selection`): selections appended via
    // `aipopup.action.insertEditSelection` ride on the bar's `data.selections`
    // and land in the outgoing request, exactly like Cursor's CmdK request
    // (they are already fenced markdown from the Mfh() port). Read-only
    // reference, never part of the output contract.
    for (const selection of selections) {
      lines.push("<selection> (read-only reference, appended from the editor):", selection.text, "</selection>", "");
    }
    const related = await this.relatedFilesContext(target.document.uri);
    if (related) {
      lines.push("<related-files> (read-only reference — recent and neighboring files):", related, "</related-files>", "");
    }
    return lines.join("\n");
  }

  /**
   * C7 — default context gathering. (UNKNOWN whether Cursor does this; OUR
   * approximation) This gathers:
   *   (a) the 3 most recently active files (excluding the current one), and
   *   (b) up to 2 same-directory files with the same extension.
   * Bounded (≤5 files, heads only) and labeled; unreadable files are skipped.
   */
  private async relatedFilesContext(current: URI): Promise<string> {
    const MAX_FILES = 5;
    const MAX_LINES = 40;
    const MAX_CHARS = 2_000;
    const seen = new Set<string>([current.fsPath]);
    const sections: string[] = [];

    const addFile = async (uri: URI, tag: string): Promise<void> => {
      if (sections.length >= MAX_FILES || seen.has(uri.fsPath)) return;
      seen.add(uri.fsPath);
      const head = await this.readFileHead(uri, MAX_LINES, MAX_CHARS);
      if (!head || !head.trim()) return;
      const label = this.asRelativePath(uri);
      sections.push(`--- ${label} (${tag}) ---\n${head}`);
    };

    // (a) recent files, most recent first.
    for (const fsPath of this.recentFiles) {
      if (sections.length >= 3) break;
      await addFile(URI.file(fsPath), "recent");
    }
    // (b) neighboring files with the same extension.
    if (sections.length < MAX_FILES) {
      const ext = path.extname(current.fsPath);
      if (ext) {
        try {
          const dirUri = URI.file(path.dirname(current.fsPath));
          const stat = await this.fileService.resolve(dirUri);
          const entries = (stat.children ?? [])
            .slice(0, 40)
            .sort((a, b) => extUri.basename(a.resource).localeCompare(extUri.basename(b.resource)));
          const base = path.basename(current.fsPath);
          for (const entry of entries) {
            if (sections.length >= MAX_FILES) break;
            const name = extUri.basename(entry.resource);
            if (!entry.isFile) continue;
            if (name === base || !name.endsWith(ext)) continue;
            await addFile(URI.joinPath(dirUri, name), "neighbor");
          }
        } catch {
          // No directory access — neighbors are best-effort.
        }
      }
    }
    return sections.join("\n\n");
  }

  /** Read the head of a file: prefer the open document (has unsaved edits), else disk. */
  private async readFileHead(uri: URI, maxLines: number, maxChars: number): Promise<string | undefined> {
    try {
      const open = this.modelService.getModels().find(
        (m) => m.uri.toString() === uri.toString(),
      );
      if (open) {
        const end = Math.min(maxLines, open.getLineCount());
        const text = open.getValueInRange(new Range(1, 1, end + 1, 1));
        return text.length > maxChars ? text.slice(0, maxChars) : text;
      }
      const content = await this.fileService.readFile(uri);
      const text = content.value.toString().slice(0, maxChars);
      return text.split("\n").slice(0, maxLines).join("\n");
    } catch {
      return undefined; // binary, deleted, or unreadable — skip silently
    }
  }

  /** Run one generation turn against the engine and return the raw text. */
  private async runEngineTurn(
    prompt: string,
    title: string,
    model?: IPromptBarModelRef,
    trackCancel?: (cancel: (() => void) | undefined) => void,
  ): Promise<string | undefined> {
    const adapter = this.ensureAdapter();
    if (!adapter) return undefined;
    // Apply the prompt bar's model pick ("Open model toggle") before the
    // turn. setModel switches live sessions and records the selection for
    // future ones; skip the call when the selection hasn't changed.
    const modelKey = model ? `${model.providerID}/${model.id}${model.variant ? `#${model.variant}` : ""}` : "";
    if (modelKey !== this.lastAppliedModelKey) {
      try {
        await adapter.setModel(model ? { id: model.id, providerID: model.providerID, variant: model.variant } : undefined);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.notificationService.warn(`IDE Agent: could not switch model — ${message}`);
      }
      this.lastAppliedModelKey = modelKey;
    }
    let cancelled = false;
    const cancel = () => {
      cancelled = true;
    };
    // WORKER-GAPS-34C: expose the in-flight turn to `cancelGeneration()` (the
    // `editor.action.inlineDiffs.cancelEdits` live path). Question-mode turns
    // pass no tracker, so they are not cancellable via cancelEdits — the key
    // is "generating an edit", per the binary description.
    trackCancel?.(cancel);
    try {
      const raw = await this.progressService.withProgress<string | undefined>(
        { location: ProgressLocation.Notification, title, cancellable: true },
        async () => {
          let text = "";
          for await (const ev of adapter.runTurn({
            prompt,
            mode: "edit",
            bubbleId: `inline-${Date.now().toString(36)}`,
          })) {
            if (cancelled) break;
            if (ev.type === "textDelta") text += ev.delta;
            else if (ev.type === "done") break;
          }
          return cancelled ? undefined : text;
        },
        () => {
          cancelled = true;
        },
      );
      return raw;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.notificationService.error(`IDE Agent: inline edit failed — ${message}`);
      return undefined;
    } finally {
      trackCancel?.(undefined);
    }
  }

  private async runGeneration(
    editor: ICodeEditor,
    target: InlineTarget,
    instruction: string,
    history: string[],
    model?: IPromptBarModelRef,
    selections: readonly IPromptBarDataSelection[] = [],
  ): Promise<void> {
    // WORKER-GAPS-34C: drive `hasActivelyGeneratingDiff` (the cancelEdits
    // precondition, binary-verbatim) for the whole edit-generation window.
    this.generationCancel = undefined;
    this.hasActivelyGeneratingDiffKey.set(true);
    let raw: string | undefined;
    try {
      raw = await this.runEngineTurn(
        await this.buildEditPrompt(target, instruction, history, selections),
        "IDE Agent: generating inline edit…",
        model,
        (cancel) => {
          this.generationCancel = cancel;
        },
      );
    } finally {
      this.generationCancel = undefined;
      this.hasActivelyGeneratingDiffKey.set(false);
    }
    if (raw === undefined) return; // cancelled, engine missing, or error (already reported)
    const code = extractCodeBlock(raw, target.languageId);
    if (!code) {
      this.notificationService.error(
        "IDE Agent: the engine returned no usable code. Try rephrasing the instruction.",
      );
      return;
    }
    await this.showPreview(editor, target, instruction, history, code);
  }

  private async showPreview(
    editor: ICodeEditor,
    target: InlineTarget,
    instruction: string,
    history: string[],
    proposedText: string,
  ): Promise<void> {
    const document = target.document;
    if (document.getVersionId() !== target.version) {
      this.notificationService.warn(
        "IDE Agent: the file changed while generating — inline edit cancelled to avoid conflicts.",
      );
      return;
    }
    const hunks = lineDiff(target.originalText.split("\n"), proposedText.split("\n"));
    if (hunks.length === 0) {
      this.notificationService.info(
        "IDE Agent: the engine returned the code unchanged — nothing to preview.",
      );
      return;
    }
    let applied = false;
    try {
      applied = editor.executeEdits("ide-inline-edit", [
        { range: target.range, text: proposedText },
      ]);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.notificationService.error(`IDE Agent: could not apply the preview — ${message}`);
      return;
    }
    if (!applied) {
      this.notificationService.error("IDE Agent: could not apply the preview edit.");
      return;
    }

    // DD-SB-5: aiCodeTracking diff-summary analog — the proposed diff's
    // linesAdded + linesRemoved. (UNKNOWN: "composer.diff_summary" event name
    // and "Cursor diffs previous vs updated content per event" — no evidence;
    // the preview hunks are exactly that diff in OUR implementation.)
    let suggestLines = 0;
    for (const hunk of hunks) {
      suggestLines += hunk.newEnd - hunk.newStart + (hunk.origEnd - hunk.origStart);
    }
    try {
      tryGetAiCodeTracking()?.recordSuggest("COMPOSER", suggestLines);
    } catch {
      /* stats must never break the preview */
    }

    // PARTIAL-DIFF-CORE: per-change tracking (Cursor: `EPe.changes` +
    // `inlineDiff.generationUUID`). The merged-text hunk ranges are the
    // live coordinates for the closest-hunk search and decorations.
    const pendingStates: PartialHunkState[] = hunks.map(() => "pending");
    const origLines = target.originalText.split("\n");
    const newLines = proposedText.split("\n");
    const initialMerge = mergePartialHunks(origLines, newLines, hunks, pendingStates);
    this.session = {
      target,
      editor,
      instruction,
      history,
      proposedText,
      previewVersion: document.getVersionId(),
      suggestLines,
      hunks,
      hunkStates: pendingStates,
      hunkRanges: initialMerge.hunkRanges,
      generationUUID: generateUuid(),
      currentText: proposedText,
    };
    this.renderHunkDecorations(this.session);

    this.statusBarEntry = this.statusbarService.addEntry(
      {
        name: "IDE Agent inline edit",
        text: "$(diff) Inline edit — Ctrl+Enter: accept · Esc: reject",
        ariaLabel: "IDE Agent inline edit preview",
        tooltip: "IDE Agent inline edit preview",
      },
      "composer.inlineEdit.status",
      StatusbarAlignment.RIGHT,
      101,
    );

    this.inlineEditPendingKey.set(true);
    // WORKER-GAPS-34C: the binary-verbatim precondition key for
    // acceptAll/rejectAll/partials. HONEST-DIVERGENCE: the fork tracks a
    // single preview session, so the key means "the active editor has a
    // pending inline-diff preview" rather than Cursor's per-editor map.
    this.activeEditorWithDiffsKey.set(true);
  }

  private async followUp(): Promise<void> {
    const s = this.session;
    if (!s) return;
    const answer = await this.promptForInstruction(s.editor, s.target, s.instruction, true);
    if (!answer) return; // cancelled — keep the current preview
    if (answer.kind === "question") {
      await this.askQuestion(s.editor, s.target, answer.text, answer.selections);
      return;
    }
    if (answer.kind === "escalate") {
      // Send-to-agent (Ctrl/⌘+L in Cursor — community-corroborated): drop
      // the preview silently and hand the refined instruction to chat.
      const { target } = s;
      if (!(await this.revertSessionText(s))) return;
      this.clearSession();
      await this.escalateWithInstruction(answer.text, target);
      return;
    }
    // Revert the current preview silently, then regenerate from the original
    // with the previous attempt recorded in history.
    // Follow-up history curation restored (user directive 2026-10-19 refined):
    // the model gets the gist of the previous attempt, not megabytes of it.
    const cappedPrev =
      s.proposedText.length > MAX_FOLLOWUP_HISTORY_CHARS
        ? s.proposedText.slice(0, MAX_FOLLOWUP_HISTORY_CHARS) + "\n…(truncated)"
        : s.proposedText;
    const historyEntry =
      `Previous instruction: "${s.instruction}". ` +
      `Previous result (refine it, do not repeat its mistakes):\n${cappedPrev}`;
    const newHistory = [...s.history, historyEntry];
    const { editor, target } = s;
    if (!(await this.revertSessionText(s))) return; // must land before regenerating
    this.clearSession();
    // The revert changed the document; refresh the captured version.
    target.version = target.document.getVersionId();
    await this.runGeneration(editor, target, answer.text, newHistory, answer.model, answer.selections);
  }

  /** Restore the original text without user prompts (follow-up path). */
  private async revertSessionText(s: InlineSession): Promise<boolean> {
    let ok = false;
    try {
      ok = s.editor.executeEdits("ide-inline-edit", [
        { range: this.previewRange(s), text: s.target.originalText },
      ]);
    } catch {
      ok = false;
    }
    if (!ok) {
      this.notificationService.error(
        "IDE Agent: could not revert the inline edit preview — follow-up cancelled.",
      );
    }
    return ok;
  }

  /** Question mode (C5): answer about the code without editing. */
  private async askQuestion(
    editor: ICodeEditor,
    target: InlineTarget,
    question: string,
    selections: readonly IPromptBarDataSelection[] = [],
  ): Promise<void> {
    // Curation restored (user directive 2026-10-19 refined).
    const code =
      target.originalText.length > 8000
        ? target.originalText.slice(0, 8000) + "\n…(truncated)"
        : target.originalText;
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
    ];
    // DEV-GAPS-68 (`cmdk-insert-edit-selection`): selections appended while
    // the bar was open — read-only reference, same as the edit prompt.
    for (const selection of selections) {
      prompt.push("", "<selection> (read-only reference, appended from the editor):", selection.text, "</selection>");
    }
    const raw = await this.runEngineTurn(prompt.join("\n"), "IDE Agent: answering question…");
    if (raw === undefined) return;
    const answer = raw.trim() || "(the engine returned an empty answer)";
    const model = this.untitledTextEditorService.create({
      languageId: "markdown",
      initialValue: `# IDE Agent — question\n\n**Q:** ${question}\n\n**File:** ${target.fileLabel}\n\n---\n\n${answer}\n`,
    });
    await this.editorService.openEditor(
      { resource: model.resource, options: { pinned: true } },
      SIDE_GROUP,
    );
    // C6 "do it": offer to apply the suggested change as an inline edit.
    const suggested = extractCodeBlock(raw, target.languageId);
    if (suggested && suggested.trim() && suggested.trim() !== target.originalText.trim()) {
      const { confirmed } = await this.dialogService.confirm({
        message: "IDE Agent: the answer suggests a code change. Apply it as an inline edit?",
        primaryButton: "Apply as inline edit",
      });
      if (confirmed) {
        await this.showPreview(editor, target, `Apply suggested fix for: ${question}`, [], suggested);
      }
    }
  }

  private clearSession(): void {
    const s = this.session;
    this.session = undefined;
    if (s && this.addedDecoIds.length > 0) {
      try {
        s.editor.deltaDecorations(this.addedDecoIds, []);
      } catch {
        /* the editor may already be gone */
      }
    }
    this.addedDecoIds = [];
    // DEV-GAPS-53: tear down the inline-diff UI companions (deleted-code
    // margin, per-hunk partial widgets) with the session.
    this.clearPartialWidgets();
    if (this.deletedCodeMarginOwner) {
      this.deletedCodeMarginOwner.margin.dispose();
      this.deletedCodeMarginOwner = undefined;
    }
    this.suppressedGenerationUUID = undefined;
    this.statusBarEntry?.dispose();
    this.statusBarEntry = undefined;
    this.inlineEditPendingKey.set(false);
    this.activeEditorWithDiffsKey.set(false);
  }
}
