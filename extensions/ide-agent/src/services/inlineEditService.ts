import * as path from "path";
import * as vscode from "vscode";
import { IdeCodeEngineAdapter } from "./ideCodeEngineAdapter";
import { defaultEnginePath } from "./composerDataService";
import { takePendingSelection } from "./inlinePromptSelection";

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
}

export class InlineEditService implements vscode.Disposable {
  private session?: InlineSession;
  private adapter?: IdeCodeEngineAdapter;
  private readonly disposables: vscode.Disposable[] = [];
  private addedDeco?: vscode.TextEditorDecorationType;
  private removedDeco?: vscode.TextEditorDecorationType;
  private statusBar?: vscode.StatusBarItem;
  /** C7 — LRU of recently active file paths for default context gathering. */
  private readonly recentFiles: string[] = [];

  constructor(
    _context: vscode.ExtensionContext,
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
    // `ide.addSelectionToInlinePrompt` (Ctrl/Cmd+Shift+K) wins over the live
    // cursor selection. Stale or foreign-document attachments are discarded.
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
    if (!this.session) return;
    this.clearSession();
  }

  /** Compute the exact range the preview now occupies: original start + proposed-text extent. */
  private previewRange(s: InlineSession): vscode.Range {
    const start = s.target.range.start;
    const lines = s.proposedText.split("\n");
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
    // Curation cap restored (user directive 2026-10-19 refined): surrounding
    // context is auto-attached — keep it focused so the model stays sharp.
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
    if (cfg.get<string>("engineMode", "stub") !== "sidecar") {
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
  private async runEngineTurn(prompt: string, title: string): Promise<string | undefined> {
    const adapter = this.ensureAdapter();
    if (!adapter) return undefined;
    let cancelled = false;
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
    }
  }

  private async runGeneration(
    editor: vscode.TextEditor,
    target: InlineTarget,
    instruction: string,
    history: string[],
  ): Promise<void> {
    const raw = await this.runEngineTurn(
      await this.buildEditPrompt(target, instruction, history),
      "IDE Agent: generating inline edit…",
    );
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
    const hunks = lineDiff(target.originalText.split("\n"), proposedText.split("\n"));
    if (hunks.length === 0) {
      void vscode.window.showInformationMessage(
        "IDE Agent: the engine returned the code unchanged — nothing to preview.",
      );
      return;
    }
    let applied = false;
    try {
      applied = await editor.edit((builder) => builder.replace(target.range, proposedText));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      void vscode.window.showErrorMessage(`IDE Agent: could not apply the preview — ${message}`);
      return;
    }
    if (!applied) {
      void vscode.window.showErrorMessage("IDE Agent: could not apply the preview edit.");
      return;
    }

    const baseLine = target.range.start.line;
    const addedRanges: vscode.Range[] = [];
    const removedOptions: vscode.DecorationOptions[] = [];
    const oldLines = target.originalText.split("\n");
    for (const hunk of hunks) {
      if (hunk.newEnd > hunk.newStart) {
        addedRanges.push(
          new vscode.Range(baseLine + hunk.newStart, 0, baseLine + hunk.newEnd - 1, 0),
        );
      }
      if (hunk.origEnd > hunk.origStart) {
        const removedText = oldLines
          .slice(hunk.origStart, hunk.origEnd)
          .map((line) => `- ${line}`)
          .join("\n");
        const anchorLine = Math.min(baseLine + hunk.newStart, document.lineCount - 1);
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
    editor.setDecorations(this.addedDeco, addedRanges);
    editor.setDecorations(this.removedDeco, removedOptions);

    this.statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 101);
    this.statusBar.text = "$(diff) Inline edit — Ctrl+Enter: accept · Esc: reject";
    this.statusBar.tooltip = "IDE Agent inline edit preview";
    this.statusBar.show();

    this.session = {
      target,
      editor,
      instruction,
      history,
      proposedText,
      previewVersion: document.version,
    };
    await vscode.commands.executeCommand("setContext", INLINE_EDIT_CONTEXT_KEY, true);
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
  }
}
