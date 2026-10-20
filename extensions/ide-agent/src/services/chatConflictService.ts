import * as vscode from "vscode";

/**
 * chatConflictService — Cursor "Resolve All Conflicts in Chat" parity.
 *
 * EVIDENCE (binary, Cursor 3.25.9,
 * workbench.desktop.main.js, class A2S — BINARY-VERIFIED, do not touch
 * without re-verifying):
 *   - Command id: `composer.resolveAllConflictsInChat`,
 *     title: "Resolve All Conflicts in Chat", f1: false (NOT in the command
 *     palette — triggered programmatically with args).
 *   - run(): creates a NEW composer in a new tab
 *     (`createComposer({openInNewTab: true})`, falls back to the selected
 *     composer); on failure: `error("Failed to create or find a composer to
 *     fix merge conflicts")` and returns.
 *   - For each `t.conflictedFiles` (each has `.uri`): opens the file's text
 *     model, runs `findAllConflictMarkers(model)`; when markers exist:
 *       `addContext({composerHandle, contextType: "fileSelections",
 *          value: {uri}, shouldShowPreview: false})`
 *     and per conflict:
 *       `addContext({composerHandle, contextType: "selections",
 *          value: {uri, uuid, text, rawText, range: {
 *            selectionStartLineNumber: startLine, selectionStartColumn: 1,
 *            positionLineNumber: endLine, positionColumn: 1}},
 *          shouldShowPreview: false})`
 *   - Prompt (VERBATIM strings):
 *       f > 1 ? `Resolve these ${f} merge ${b} across ${t.fileCount} ${v}`
 *             : "Resolve this merge conflict"
 *     where v = fileCount === 1 ? "file" : "files",
 *           b = f === 1 ? "conflict" : "conflicts".
 *     `updateComposerData(handle, {text: y, richText: y})`,
 *     `fireShouldForceText({composerId})`.
 *   - Then, if on a branch: `addContext({composerHandle,
 *     contextType: "gitDiffFromBranchToMain", value: true,
 *     shouldShowPreview: false})`.
 *   - Finally: `handleOpenComposer(newId, {focusMainInputBox: true})`.
 *   - `findAllConflictMarkers(model)` (verbatim algorithm): scans lines for
 *     a line starting with "<<<<<<<" … a later line starting with ">>>>>>>";
 *     returns [{startLine, endLine, text}] with 1-based line numbers and
 *     text = the full range content (markers included). Files that fail to
 *     load: `warn("Could not process conflicted file <uri>:")`, skipped.
 *
 * OUR MAPPING (same mechanism, same layer — extension host):
 *   - new composer tab  → ChatTabService.createAndActivate
 *   - fileSelections + selections contexts → webview `addSelectionContext`
 *     chips (existing message; each conflict becomes a `code` chip whose
 *     label is `<relPath>:<start>-<end>` and whose content is the verbatim
 *     conflict text — resolved by resolveMentionContext on submit)
 *   - composer text     → webview `prefill` message (verbatim prompt)
 *   - handleOpenComposer(focusMainInputBox) → reveal + `focusInput` message
 *   - conflictedFiles   → command args when available; otherwise discovered
 *     from `git status --porcelain` unmerged entries (UU/AA/DD/AU/UA/UD/DU)
 *     in the first workspace folder.
 *
 * HONEST-DIVERGENCES (documented, not hidden):
 *   1. Cursor attaches the whole file as a `fileSelections` chip IN ADDITION
 *      to per-conflict `selections` chips. We attach one chip per conflict
 *      (label carries the file path, content carries the conflict text).
 *      A host-initiated file chip needs a new webview message
 *      (`addFileContext`); components/composer.ts is under live concurrent
 *      edit, so the file chip is deferred — the conflict text is sufficient
 *      for the agent to resolve, and the file is one click away via the
 *      chip label.
 *   2. Cursor auto-attaches `gitDiffFromBranchToMain` when on a branch. We
 *      do not: our `git` mention provider already offers the working diff
 *      via @-mention, and silently dumping a branch diff into the new tab
 *      without a webview chip type would bypass the user's context budget
 *      visibility.
 *   3. Binary note `fromSubmitChat`-style skipConfirm does not apply here;
 *      there is no destructive action in this flow.
 */

// Verbatim from the binary — do NOT paraphrase.
export const RESOLVE_CONFLICTS_TITLE = "Resolve All Conflicts in Chat";
export const RESOLVE_CONFLICTS_PROMPT_SINGLE = "Resolve this merge conflict";
export const RESOLVE_CONFLICTS_ERROR_NO_COMPOSER =
  "Failed to create or find a composer to fix merge conflicts";

/** One merge-conflict hunk: 1-based lines, text includes the markers. */
export interface ConflictMarker {
  startLine: number;
  endLine: number;
  text: string;
}

/**
 * Binary-verbatim port of Cursor's `findAllConflictMarkers`: a line that
 * starts with "<<<<<<<" opens a conflict, a later line that starts with
 * ">>>>>>>" closes it. Returns hunks with 1-based line numbers.
 */
export function findConflictMarkers(text: string): ConflictMarker[] {
  const START = "<<<<<<<";
  const END = ">>>>>>>";
  const lines = text.split("\n");
  const out: ConflictMarker[] = [];
  let inConflict = false;
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!inConflict) {
      if (line.startsWith(START)) {
        inConflict = true;
        start = i;
      }
    } else if (line.startsWith(END)) {
      out.push({
        startLine: start + 1,
        endLine: i + 1,
        text: lines.slice(start, i + 1).join("\n"),
      });
      inConflict = false;
      start = -1;
    }
  }
  return out;
}

/**
 * Parse `git status --porcelain` (v1) output for unmerged/conflicted paths:
 * XY codes UU, AA, DD, AU, UA, UD, DU. Returns repo-relative paths.
 */
export function parseUnmergedFiles(porcelain: string): string[] {
  const out: string[] = [];
  for (const rawLine of porcelain.split("\n")) {
    if (rawLine.length < 4) {
      continue;
    }
    const xy = rawLine.slice(0, 2);
    const unmerged =
      xy === "UU" ||
      xy === "AA" ||
      xy === "DD" ||
      xy === "AU" ||
      xy === "UA" ||
      xy === "UD" ||
      xy === "DU";
    if (!unmerged) {
      continue;
    }
    // Renamed unmerged entries look like "UD old -> new"; take the target.
    const rest = rawLine.slice(3);
    const arrow = rest.indexOf(" -> ");
    out.push(arrow >= 0 ? rest.slice(arrow + 4) : rest);
  }
  return out;
}

/**
 * Binary-verbatim prompt builder.
 *   f > 1 ? `Resolve these ${f} merge ${b} across ${t.fileCount} ${v}`
 *         : "Resolve this merge conflict"
 */
export function buildResolvePrompt(conflictCount: number, fileCount: number): string {
  if (conflictCount > 1) {
    const b = conflictCount === 1 ? "conflict" : "conflicts";
    const v = fileCount === 1 ? "file" : "files";
    return `Resolve these ${conflictCount} merge ${b} across ${fileCount} ${v}`;
  }
  return RESOLVE_CONFLICTS_PROMPT_SINGLE;
}

/** Optional args, mirroring the binary's `{conflictedFiles, fileCount}`. */
export interface ResolveConflictsArgs {
  /** Absolute file paths (or file URIs as strings). */
  conflictedFiles?: string[];
  fileCount?: number;
}

/**
 * Host seam for the orchestration. Injected so the decision logic is
 * unit-testable; production implements these in extension.ts.
 */
export interface ChatConflictHost {
  /** Create AND activate a new chat tab (Cursor: createComposer openInNewTab). */
  createTab(title: string): string;
  /** Post a message to the target tab's webview. */
  postToWebview(tabId: string, message: unknown): void;
  /** Reveal the chat surface and move DOM focus into the composer input. */
  focusChatInput(tabId: string): Promise<void>;
  /** Run git in a repo dir; resolves stdout (gitExecFile in production). */
  runGit(args: string[], cwd: string): Promise<string>;
  /** Read a file's full text. */
  readFile(absPath: string): Promise<string>;
  /** Repo root for conflict discovery (first workspace folder). */
  repoRoot(): string | undefined;
  showInformationMessage(message: string): void;
  showWarningMessage(message: string): void;
  showErrorMessage(message: string): void;
}

export class ChatConflictService {
  constructor(private readonly host: ChatConflictHost) {}

  /**
   * Full "Resolve All Conflicts in Chat" flow (see header evidence).
   * Creates a new chat tab, attaches one `code` chip per conflict hunk,
   * prefills the verbatim prompt, and focuses the composer input.
   * Returns the number of conflicts attached, or 0 when there was nothing
   * to resolve.
   */
  async resolveAllConflicts(args?: ResolveConflictsArgs): Promise<number> {
    let files: string[] = [];
    if (args?.conflictedFiles && args.conflictedFiles.length > 0) {
      files = args.conflictedFiles.map((f) => normalizeToPath(f));
    } else {
      files = await this.discoverConflictedFiles();
    }
    if (files.length === 0) {
      this.host.showInformationMessage("IDE Agent: no merge conflicts found.");
      return 0;
    }

    // Binary: createComposer({openInNewTab: true}) ?? selectedComposerId;
    // failure → error("Failed to create or find a composer to fix merge
    // conflicts") and return.
    let tabId: string;
    try {
      tabId = this.host.createTab("Resolve merge conflicts");
    } catch {
      this.host.showErrorMessage(`IDE Agent: ${RESOLVE_CONFLICTS_ERROR_NO_COMPOSER}.`);
      return 0;
    }
    if (!tabId) {
      this.host.showErrorMessage(`IDE Agent: ${RESOLVE_CONFLICTS_ERROR_NO_COMPOSER}.`);
      return 0;
    }

    let conflictCount = 0;
    const filesWithConflicts: string[] = [];
    const root = this.host.repoRoot() ?? "";
    for (const absPath of files) {
      let text: string;
      try {
        text = await this.host.readFile(absPath);
      } catch (err) {
        // Binary: warn(`Could not process conflicted file ${uri}:`, err) — skip.
        this.host.showWarningMessage(
          `IDE Agent: could not process conflicted file ${absPath} — skipped.`,
        );
        void err;
        continue;
      }
      const markers = findConflictMarkers(text);
      if (markers.length === 0) {
        continue;
      }
      filesWithConflicts.push(absPath);
      const rel = root ? vscode.workspace.asRelativePath(absPath) : absPath;
      for (const m of markers) {
        // Mirrors the binary's per-conflict `selections` addContext: the
        // chip label carries file + 1-based line range, the content carries
        // the verbatim hunk text (markers included).
        this.host.postToWebview(tabId, {
          type: "addSelectionContext",
          label: `${rel}:${m.startLine}-${m.endLine}`,
          content: m.text,
        });
        conflictCount++;
      }
    }

    if (conflictCount === 0) {
      this.host.showInformationMessage(
        "IDE Agent: the conflicted files contain no conflict markers.",
      );
      return 0;
    }

    // Binary: updateComposerData(handle, {text: y, richText: y}) — we prefill
    // the input (the user reviews and sends; same prefill pattern as the
    // terminal-AI-command flow).
    const fileCount = args?.fileCount ?? filesWithConflicts.length;
    this.host.postToWebview(tabId, {
      type: "prefill",
      text: buildResolvePrompt(conflictCount, fileCount),
    });
    // Binary: handleOpenComposer(newId, {focusMainInputBox: true}).
    await this.host.focusChatInput(tabId);
    return conflictCount;
  }

  /**
   * Discover unmerged files via `git status --porcelain` in the repo root.
   * Returns absolute paths.
   */
  async discoverConflictedFiles(): Promise<string[]> {
    const root = this.host.repoRoot();
    if (!root) {
      return [];
    }
    let out: string;
    try {
      out = await this.host.runGit(["status", "--porcelain"], root);
    } catch {
      return [];
    }
    const { join } = await import("node:path");
    return parseUnmergedFiles(out).map((rel) => join(root, rel));
  }
}

function normalizeToPath(f: string): string {
  // Accept vscode.Uri-like strings ("file:///…") or plain absolute paths.
  if (f.startsWith("file://")) {
    return vscode.Uri.parse(f).fsPath;
  }
  return f;
}
