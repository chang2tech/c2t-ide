/**
 * inlinePromptSelection.ts
 *
 * Pending-selection store for the Cursor K-08 parity binding
 * (`ide.addSelectionToInlinePrompt`, Ctrl/Cmd+Shift+K — "Add selection to Cmd+K").
 *
 * Cursor lets you attach the current editor selection to the Cmd+K input and
 * then open the prompt later; the attached selection wins over the live cursor
 * selection. `InlineEditService.openPrompt()` consumes the pending selection
 * via `takePendingSelection()` (see the KEYBOARD-PARITY hook there).
 */
import * as vscode from "vscode";

export interface PendingSelection {
  uri: vscode.Uri;
  range: vscode.Range;
  /** Document version at capture time — stale-edit guard. */
  version: number;
}

let pending: PendingSelection | undefined;

/**
 * Capture the active editor's current selection as the pending inline-prompt
 * target. Returns false (and tells the user) when there is nothing to attach.
 */
export function attachPendingSelection(): boolean {
  const editor = vscode.window.activeTextEditor;
  if (!editor || editor.selection.isEmpty || editor.document.isClosed) {
    void vscode.window.showInformationMessage("IDE Agent: select code in the editor first.");
    return false;
  }
  pending = {
    uri: editor.document.uri,
    range: new vscode.Range(editor.selection.start, editor.selection.end),
    version: editor.document.version,
  };
  return true;
}

/** Consume (and clear) the pending selection, if any. */
export function takePendingSelection(): PendingSelection | undefined {
  const p = pending;
  pending = undefined;
  return p;
}
