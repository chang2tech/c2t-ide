/**
 * DEV-GAPS-65 `worktree-lsp-opt-in` — `lsp-worktrees-enabled` wiring.
 *
 * Evidence: see src/languageMap.ts (verbatim setting id / label /
 * description / aliases from Cursor 3.25.9 glass settings strings).
 *
 * Why this layer: in Cursor the opt-in is a workbench-side settings read —
 * the workbench decides whether a worktree file gets the shadow language
 * id (TextMate-only, no LSP) or its real language id (full LSP). This fork
 * registers the shadow ids declaratively (DEV-GAPS-37B, package.json), and
 * declarative contributions cannot be un-registered at runtime, so the
 * equivalent user-visible behavior is implemented here: while
 * `ide.worktree.lspWorktreesEnabled` is on, every open worktree document
 * is switched from its shadow id to its real language id (which is what
 * activates the language server for it), and documents opened later are
 * switched on open. Turning the setting off switches remapped documents
 * back to their shadow ids.
 *
 * HONEST-DIVERGENCE:
 *   - The binary's default-ON wording ("Enable language server BY
 *     DEFAULT") is about the per-workspace default inside Cursor's own
 *     settings store; the fork exposes it as a normal boolean setting
 *     defaulting to `false`, preserving Cursor's out-of-box behavior
 *     (worktrees are TextMate-only until the user opts in).
 *   - Documents switched to a real id keep that id if the window reloads
 *     while the setting is off until reopened — VS Code persists manual
 *     language choices per file in some flows; the shadow filename
 *     patterns re-apply on fresh opens.
 */
import * as vscode from "vscode";
import {
  LSP_WORKTREES_ENABLED_CONFIG_KEY,
  isWorktreeShadowLanguageId,
  resolveRealLanguageId,
} from "./languageMap";

export function activate(context: vscode.ExtensionContext): void {
  /** uri string -> the shadow language id the document was remapped from. */
  const remappedFrom = new Map<string, string>();

  const lspEnabled = (): boolean =>
    vscode.workspace
      .getConfiguration()
      .get<boolean>(LSP_WORKTREES_ENABLED_CONFIG_KEY, false);

  const remapDocument = async (doc: vscode.TextDocument): Promise<void> => {
    const key = doc.uri.toString();
    if (remappedFrom.has(key) || !isWorktreeShadowLanguageId(doc.languageId)) {
      return;
    }
    const available = await vscode.languages.getLanguages();
    const real = resolveRealLanguageId(doc.languageId, available);
    if (real === undefined) {
      return;
    }
    const shadow = doc.languageId;
    const updated = await vscode.languages.setTextDocumentLanguage(doc, real);
    if (updated) {
      remappedFrom.set(key, shadow);
    }
  };

  const restoreDocument = async (doc: vscode.TextDocument): Promise<void> => {
    const key = doc.uri.toString();
    const shadow = remappedFrom.get(key);
    if (shadow === undefined) {
      return;
    }
    remappedFrom.delete(key);
    if (doc.languageId !== shadow) {
      await vscode.languages.setTextDocumentLanguage(doc, shadow);
    }
  };

  const applyToOpenDocuments = async (): Promise<void> => {
    const enabled = lspEnabled();
    for (const doc of vscode.workspace.textDocuments) {
      if (enabled) {
        await remapDocument(doc);
      } else {
        await restoreDocument(doc);
      }
    }
  };

  context.subscriptions.push(
    vscode.workspace.onDidOpenTextDocument((doc) => {
      if (lspEnabled()) {
        void remapDocument(doc);
      }
    }),
    vscode.workspace.onDidCloseTextDocument((doc) => {
      remappedFrom.delete(doc.uri.toString());
    }),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration(LSP_WORKTREES_ENABLED_CONFIG_KEY)) {
        void applyToOpenDocuments();
      }
    }),
  );

  if (lspEnabled()) {
    void applyToOpenDocuments();
  }
}

export function deactivate(): void {}
