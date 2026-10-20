import * as vscode from "vscode";

/**
 * Cursor parity: "Add to Chat" (Ctrl+L).
 *
 * Editor path: the active editor's selection becomes a context chip in the
 * chat input. Terminal path: VS Code's extension API cannot read the
 * terminal selection directly, so we run
 * `workbench.action.terminal.copySelection` and read the clipboard back —
 * the text is attached as a `terminal selection` chip.
 *
 * The workbench-core terminal selection toolbar (a floating "Add to Chat"
 * button, Cursor's "Toolbar on Selection") invokes this command with
 * `{ source: 'terminal', text }` — the selection text is already resolved
 * in core, so no clipboard round-trip is needed on that path.
 *
 * Focus detection (P1-2/P2-6, QA-CHATEDITOR): there is NO public VS Code API
 * for "does the terminal have focus". `window.activeTextEditor` is NOT
 * cleared when the terminal is focused (vscode.d.ts: "the one that currently
 * has focus or, when none has focus, the one that has changed input most
 * recently"), and `window.activeTerminal` stays set after focus leaves.
 * So any `terminalHasFocus()` heuristic built on those two is wrong in at
 * least one direction. Instead:
 *  - keybindings pass an explicit `{ source: 'terminal' | 'editor' }` arg
 *    (package.json keybinding `args`), which is deterministic;
 *  - the ambiguous palette path probes the terminal BEHAVIORALLY: if
 *    `copySelection` changes the clipboard, the terminal had a selection.
 *
 * Extracted from extension.ts into a testable module: all VS Code access
 * goes through the injected `Host` seam.
 */

export interface AddToChatHost {
  postToWebview(message: unknown): void;
  focusChatView(): Promise<void>;
}

export interface VscodeSeam {
  activeTextEditor: vscode.TextEditor | undefined;
  activeTerminal: vscode.Terminal | undefined;
  executeCommand(command: string, ...args: unknown[]): Promise<unknown>;
  readClipboardText(): Promise<string>;
  /** P3-13: restore the clipboard after the copySelection round-trip. */
  writeClipboardText(text: string): Promise<void>;
  showInformationMessage(message: string): void;
  asRelativePath(uri: vscode.Uri): string;
}

/** Production seam backed by the real vscode API. */
export const realVscodeSeam: VscodeSeam = {
  get activeTextEditor() {
    return vscode.window.activeTextEditor;
  },
  get activeTerminal() {
    return vscode.window.activeTerminal;
  },
  executeCommand: (command, ...args) =>
    Promise.resolve(vscode.commands.executeCommand(command, ...args) as unknown),
  readClipboardText: () => Promise.resolve(vscode.env.clipboard.readText()),
  writeClipboardText: (text) => Promise.resolve(vscode.env.clipboard.writeText(text)),
  showInformationMessage: (m) => {
    void vscode.window.showInformationMessage(m);
  },
  asRelativePath: (uri) => vscode.workspace.asRelativePath(uri),
};

export function buildEditorSelectionLabel(
  seam: VscodeSeam,
  doc: vscode.TextDocument,
  sel: vscode.Selection,
): { label: string; content: string } {
  const label = `selection:${seam.asRelativePath(doc.uri)}:${sel.start.line + 1}`;
  const content = doc.getText(sel);
  return { label, content };
}

/**
 * Optional arguments accepted by the `ide.addToChat` command.
 * - Keybindings pass `{ source: 'terminal' }` / `{ source: 'editor' }`
 *   explicitly (deterministic, no focus guessing).
 * - The workbench-core terminal selection toolbar passes
 *   `{ source: 'terminal', text }` with the selection text already resolved.
 */
export interface AddToChatArgs {
  source?: string;
  text?: string;
  /**
   * IDE-CODE (Cursor parity, DETAIL-TERMINAL): Ctrl/Cmd+click on the
   * terminal floating "Add to Chat" button opens the selection in a NEW
   * composer instead of the current one.
   */
  newChat?: boolean;
}

/**
 * P3-12 (QA-CHATEDITOR): menu invocations can forward arbitrary model
 * objects (e.g. a Uri) as the first arg. Accept ONLY a plain object whose
 * keys are a subset of {source, text, newChat}; anything else is treated
 * as "no args" so the command falls back to the behavioral probe instead
 * of misreading a Uri as AddToChatArgs.
 */
export function sanitizeAddToChatArgs(raw: unknown): AddToChatArgs | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return undefined;
  }
  const record = raw as Record<string, unknown>;
  const keys = Object.keys(record);
  if (keys.length === 0 || !keys.every((k) => k === "source" || k === "text" || k === "newChat")) {
    return undefined;
  }
  const out: AddToChatArgs = {};
  if (typeof record.source === "string") {
    out.source = record.source;
  }
  if (typeof record.text === "string") {
    out.text = record.text;
  }
  if (record.newChat === true) {
    out.newChat = true;
  }
  return out;
}

/**
 * Behavioral terminal-selection probe.
 *
 * Runs `copySelection` and compares the clipboard before/after:
 * - changed + non-empty + stable → the terminal had a selection; returns
 *   its text.
 * - unchanged/empty → no terminal selection; returns undefined and never
 *   attaches the (possibly secret) stale clipboard content (P1-1).
 *
 * The user's original clipboard content is restored afterwards (P3-13),
 * best-effort — a failed restore must not break the flow.
 *
 * REVERIFY-P2-2 (H1, clipboard race): the clipboard is shared mutable
 * state. If the user copies something ELSE in the millisecond window of
 * this probe, `after` would be their text (possibly a secret), not the
 * terminal selection. To narrow this, we read a THIRD time after a short
 * settle delay: if the clipboard is still changing (`after2 !== after`),
 * someone else is actively writing → abort (return undefined) WITHOUT
 * attaching and WITHOUT restoring (restoring would clobber their fresh
 * copy = data loss). Only a stable change is treated as our copySelection
 * result and restored.
 *
 * Known trade-off (documented, accepted): if the terminal selection happens
 * to be byte-identical to the previous clipboard content, the probe reports
 * "no selection". Privacy (never leaking stale clipboard as a chat chip)
 * wins over this rare false negative.
 *
 * RESIDUAL TOCTOU (documented, accepted risk — QA-REVERIFY-2-01): the clipboard
 * is shared mutable state and the extension-host API offers NO direct
 * terminal-selection API (no way to read a terminal's selection except the
 * copySelection→clipboard round-trip), so the probe is inherently
 * time-of-check/time-of-use. A SINGLE user copy that completes ENTIRELY in
 * the before→first-after window (copySelection→read) is stable through the
 * settle check and will still be misattributed as the terminal selection and
 * attached. The window is only a few milliseconds (one read + one command +
 * one read), so it requires the user to hit copy at exactly that instant —
 * accepted as residual, not fixable via this probe design. What we CAN bound
 * is the damage: see the re-read right before restore (REVERIFY2-P3-2) which
 * guarantees we never clobber a fresher copy even when misattribution
 * occurred.
 */
export async function probeTerminalSelection(seam: VscodeSeam): Promise<string | undefined> {
  const before = await seam.readClipboardText();
  await seam.executeCommand("workbench.action.terminal.copySelection");
  const after = await seam.readClipboardText();
  if (!after || after === before) {
    return undefined;
  }
  // Stability check: give a concurrent writer a chance to reveal itself.
  await new Promise((resolve) => setTimeout(resolve, 50));
  const after2 = await seam.readClipboardText();
  if (after2 !== after) {
    // Someone else is writing to the clipboard right now — `after` is
    // their text, not the terminal selection. Abort: do NOT attach it
    // (privacy) and do NOT restore `before` over their fresh copy
    // (data loss). Leave their clipboard alone.
    return undefined;
  }
  // Stable change: our copySelection produced it. Restore the user's
  // original clipboard content (P3-13), best-effort.
  //
  // REVERIFY2-P3-2 (restore-clobber): the 50ms settle above only catches a
  // writer active DURING the window. Re-read right before restoring: if the
  // clipboard no longer equals `after`, someone copied something new AFTER
  // our last read → SKIP the restore (writing `before` now would clobber
  // their fresh copy = data loss). Only restore when the clipboard is still
  // the value we read.
  const beforeRestore = await seam.readClipboardText();
  if (beforeRestore === after) {
    try {
      await seam.writeClipboardText(before);
    } catch {
      /* best-effort restore */
    }
  }
  return after;
}

export async function addToChat(
  host: AddToChatHost,
  seam: VscodeSeam = realVscodeSeam,
  args?: AddToChatArgs,
): Promise<void> {
  // Core toolbar path: the selection text arrives pre-resolved — attach it
  // directly as a terminal selection chip (backward compatible: no args
  // keeps the previous editor/clipboard behavior).
  if (args?.source === "terminal" && typeof args.text === "string" && args.text.length > 0) {
    await postSelectionContextToChat(host, "terminal selection", args.text, "terminal");
    return;
  }
  // Explicit source from the keybinding args — deterministic, no focus
  // guessing (P1-2/P2-6).
  if (args?.source === "terminal") {
    await addTerminalSelectionToChat(host, seam);
    return;
  }
  if (args?.source === "editor") {
    await addEditorSelectionToChat(host, seam);
    return;
  }
  // Ambiguous invocation (command palette): probe the terminal
  // behaviorally. If it has a selection, use it; otherwise fall back to
  // the editor path.
  const probed = await probeTerminalSelection(seam);
  if (probed !== undefined) {
    await postSelectionContextToChat(host, "terminal selection", probed, "terminal");
    return;
  }
  await addEditorSelectionToChat(host, seam);
}

export async function addEditorSelectionToChat(
  host: AddToChatHost,
  seam: VscodeSeam = realVscodeSeam,
): Promise<void> {
  const editor = seam.activeTextEditor;
  if (!editor || editor.selection.isEmpty) {
    seam.showInformationMessage("IDE Agent: select code in the editor first.");
    return;
  }
  const { label, content } = buildEditorSelectionLabel(seam, editor.document, editor.selection);
  await postSelectionContextToChat(host, label, content, "editor");
}

export async function addTerminalSelectionToChat(
  host: AddToChatHost,
  seam: VscodeSeam = realVscodeSeam,
): Promise<void> {
  const text = await probeTerminalSelection(seam);
  if (text === undefined) {
    seam.showInformationMessage("IDE Agent: select text in the terminal first.");
    return;
  }
  await postSelectionContextToChat(host, "terminal selection", text, "terminal");
}

export async function postSelectionContextToChat(
  host: AddToChatHost,
  label: string,
  content: string,
  /**
   * GAPS-176: the selection's origin, when this post is a user
   * "Add to Chat" insert. The webview turns it into a tooltip-pipeline
   * `chat.insert_selection.*` event ONLY when the chip is actually
   * inserted (not deduped) — see components/composer.ts. Programmatic
   * attach paths that reuse this helper without a source stay silent.
   * Editor inserts from this flow always carry a NON-EMPTY selection
   * (empty selections return early in addEditorSelectionToChat).
   */
  tooltipInsertSource?: "editor" | "terminal",
): Promise<void> {
  await host.focusChatView();
  host.postToWebview({
    type: "addSelectionContext",
    label,
    content,
    ...(tooltipInsertSource ? { tooltipInsertSource } : {}),
  });
}
