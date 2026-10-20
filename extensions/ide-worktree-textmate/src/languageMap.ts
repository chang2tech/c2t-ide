/**
 * DEV-GAPS-65 `worktree-lsp-opt-in` — pure language-id mapping.
 *
 * BINARY EVIDENCE (Cursor 3.25.9 strings, harvest-cursor-worktree-textmate-
 * 2026-10-19.md §"no-LSP default is opt-out-able" + detail-settings-2026-10-
 * 19.md §12 "Static-only indexing keys"):
 *   - Setting id: `lsp-worktrees-enabled`
 *   - Label: "Enable LSPs for Worktrees"
 *   - Description: "Enable language server by default to provide code
 *     intelligence in agent worktree workspaces"
 *   - Aliases: `language server`, `worktree`
 *   - Surface: settings tab `indexing` (glass). Static key also confirmed in
 *     the indexing key list next to `lsp`, `lsp-max-local-workspaces`,
 *     `lsp-max-remote-workspaces`.
 *
 * Mechanism: by default, agent-worktree workspaces get TextMate-only
 * treatment — files open under shadow language ids (`worktree-<lang>`,
 * 28 ids, see ../package.json and DEV-GAPS-37B), which deliberately keep
 * real language extensions (and therefore language servers) from
 * activating. The verbatim setting flips that default: with it enabled,
 * worktree files must carry their REAL language id so language servers
 * provide full code intelligence — exactly what "enable language server
 * by default … in agent worktree workspaces" says.
 *
 * This module is the testable core: the shadow→real map (derived by the
 * shadow-id pattern itself: `worktree-<real-id>`), plus the resolution
 * rule used by src/extension.ts. No vscode imports here.
 */

/** The configuration key in this fork (mirrors the binary's `lsp-worktrees-enabled` glass-settings key). */
export const LSP_WORKTREES_ENABLED_CONFIG_KEY = "ide.worktree.lspWorktreesEnabled";

/** Verbatim Cursor setting id (glass settings store, indexing tab). */
export const CURSOR_LSP_WORKTREES_SETTING_ID = "lsp-worktrees-enabled";

/** Verbatim Cursor setting label. */
export const LSP_WORKTREES_ENABLED_LABEL = "Enable LSPs for Worktrees";

/** Verbatim Cursor setting description. */
export const LSP_WORKTREES_ENABLED_DESCRIPTION =
  "Enable language server by default to provide code intelligence in agent worktree workspaces";

/** Verbatim Cursor search aliases for the setting. */
export const LSP_WORKTREES_ENABLED_ALIASES: readonly string[] = ["language server", "worktree"];

/** Prefix of every shadow language id registered by this extension. */
export const WORKTREE_LANGUAGE_PREFIX = "worktree-";

/**
 * The 28 shadow language IDs — identical to the `contributes.languages`
 * ids in this extension's package.json (DEV-GAPS-37B; the harvest doc's
 * count is "28 language IDs / 27 grammar files", `worktree-hcl` reusing
 * the terraform shim grammar).
 */
export const WORKTREE_SHADOW_LANGUAGE_IDS: readonly string[] = [
  "worktree-c",
  "worktree-cpp",
  "worktree-css",
  "worktree-go",
  "worktree-html",
  "worktree-java",
  "worktree-javascript",
  "worktree-javascriptreact",
  "worktree-json",
  "worktree-php",
  "worktree-protobuf",
  "worktree-python",
  "worktree-ruby",
  "worktree-rust",
  "worktree-shellscript",
  "worktree-sql",
  "worktree-swift",
  "worktree-typescript",
  "worktree-typescriptreact",
  "worktree-yaml",
  "worktree-terraform",
  "worktree-terraform-vars",
  "worktree-hcl",
  "worktree-terraform-stack",
  "worktree-terraform-deploy",
  "worktree-terraform-test",
  "worktree-terraform-mock",
  "worktree-terraform-search",
];

/** True when `languageId` is one of this extension's shadow ids. */
export function isWorktreeShadowLanguageId(languageId: string): boolean {
  return WORKTREE_SHADOW_LANGUAGE_IDS.includes(languageId);
}

/**
 * The real language id behind a shadow id — the shadow pattern is the
 * prefix itself, so this is a strip. Returns `undefined` for non-shadow
 * ids. (For the terraform family the real ids — `terraform`,
 * `terraform-vars`, `hcl`, `terraform-stack`, … — exist only when a
 * Terraform extension is installed; `resolveRealLanguageId` guards that.)
 */
export function realLanguageIdForShadow(shadowLanguageId: string): string | undefined {
  if (!isWorktreeShadowLanguageId(shadowLanguageId)) {
    return undefined;
  }
  return shadowLanguageId.slice(WORKTREE_LANGUAGE_PREFIX.length);
}

/**
 * Resolve the language a worktree document should be switched to when
 * the opt-in is enabled: the real id, but ONLY when that language is
 * actually registered in the running IDE (otherwise switching would
 * throw / lose the TextMate grammar for nothing).
 */
export function resolveRealLanguageId(
  shadowLanguageId: string,
  availableLanguageIds: readonly string[],
): string | undefined {
  const real = realLanguageIdForShadow(shadowLanguageId);
  if (real === undefined) {
    return undefined;
  }
  return availableLanguageIds.includes(real) ? real : undefined;
}
