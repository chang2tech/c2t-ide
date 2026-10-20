/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * IDE-CODE (W69D, rules-create-from-selection): pure logic behind Cursor's
 * `cursor.createRuleFromSelection` editor command. Kept free of any vscode
 * dependency so it can be unit-tested with plain node.
 *
 * Cursor evidence — self-verified 2026-10-20 against the reference binaries
 * (QA 2-step rule, step 1). Workbench bundle
 * `out/vs/workbench/workbench.desktop.main.js`:
 *
 * - Cursor 3.25.9: command class (EditorCommand) at byte 24829565
 *   (title 'Create Rule'); run body + toast 'Created manual rule' at byte
 *   24830470; command id literal `cursor.createRuleFromSelection` at byte
 *   24830877; slug derivation at byte 24830922; uniqueness loop at byte
 *   24831196; the id also appears in the `editor_ai_actions`
 *   command-category table at byte 32084375. Rule-service
 *   `getRuleTargetDirectory`/`createRule` at bytes 31043881/31044289.
 * - Cursor 3.25.6: identical code — 'Created manual rule' at byte 24824677,
 *   command id at byte 24825077.
 *
 * Recovered command descriptor (verbatim):
 *   { id: "cursor.createRuleFromSelection",
 *     title: { value: "Create Rule", original: "Create Rule" },
 *     precondition: hasNonEmptySelection,
 *     menu: [{ id: EditorContext, group: "navigation", order: 20 }],
 *     metadata: { description: "Create a cursor rule from the highlighted text" } }
 * registered as an EditorCommand (runEditorCommand receives the editor).
 *
 * Recovered run body (paraphrase of the minified source, strings verbatim):
 *   model = editor.getModel();            if (!model) warn(WARN_NO_MODEL)
 *   sel   = editor.getSelection();        if (!sel || sel.isEmpty()) warn(WARN_NO_SELECTION)
 *   text  = model.getValueInRange(sel).trim();
 *                                         if (!text) warn(WARN_EMPTY_SELECTION)
 *   if (!ctx.getWorkspaceFolder(model.uri)) warn(WARN_NO_WORKSPACE_FOLDER)
 *   slug  = deriveRuleSlug(text, ctx.asRelativePath(model.uri))
 *   slug  = await uniqueRuleSlug(slug, s => fileService.exists(getRuleUri(s, false)))
 *   try { uri = await ruleService.createRule(slug, text, false);
 *         notify Info createdRuleToastMessage(slug) + 'Open Rule' action }
 *   catch (e) { error(`Failed to create rule: ${msg}`) }
 *
 * HONEST NOTES:
 * - The created file's frontmatter is `alwaysApply: true` (see
 *   {@link buildRuleFileContent}): Cursor's createRule defaults
 *   `options?.alwaysApply ?? true` and this command passes no options —
 *   even though Cursor's own toast calls the result a "manual rule" and
 *   says to attach it explicitly. Binary behavior wins over the wording.
 * - No AI-assisted rule authoring happens on this path in the binary: the
 *   selected text becomes the rule body verbatim (trimEnd only).
 */

/** Command id, verbatim from the binary (3.25.9 byte 24830877). */
export const CREATE_RULE_FROM_SELECTION_ID = 'cursor.createRuleFromSelection';

/** Id of the toast's primary action, verbatim from the binary. */
export const OPEN_CREATED_RULE_ACTION_ID = 'cursor.openCreatedRule';

/** Workspace-relative directory project rules live in (binary: joinPath(folder, ".cursor", "rules")). */
export const RULES_DIR_REL_PATH = '.cursor/rules';

/** Rule file extension (binary: `${name}.mdc`). */
export const RULE_FILE_EXTENSION = '.mdc';

/** warn() string when the editor has no model (binary, verbatim). */
export const WARN_NO_MODEL = 'Open a file to create a cursor rule.';

/** warn() string when there is no selection (binary, verbatim). */
export const WARN_NO_SELECTION = 'Select the text you want to turn into a rule.';

/** warn() string when the selection trims to nothing (binary, verbatim). */
export const WARN_EMPTY_SELECTION = 'Highlight some text before creating a rule.';

/** warn() string when the file is outside any workspace folder (binary, verbatim). */
export const WARN_NO_WORKSPACE_FOLDER = 'Open a workspace folder to store cursor rules.';

/** Error thrown by getRuleTargetDirectory(false) with no workspace (binary, verbatim). */
export const NO_WORKSPACE_FOLDER_ERROR = 'No workspace folder available for project rules';

/**
 * Derive the rule slug — verbatim port of the binary's slug function
 * (3.25.9 byte 24830922):
 *
 *   const fromText = text.toLowerCase()
 *     .replace(/['"`]/g, '')
 *     .replace(/[^a-z0-9\s-]/g, ' ')
 *     .trim().split(/\s+/).filter(Boolean).slice(0, 6).join('-');
 *   const fromPath = relativePath
 *     ? relativePath.split('/').filter(Boolean).slice(0, 3).join('-')
 *     : 'rule';
 *   return ((fromText.length > 0 ? fromText : fromPath) || 'rule')
 *     .slice(0, 12).replace(/-+/g, '-');
 *
 * Note the quirks, kept on purpose: quotes are deleted (not turned into
 * separators), non-ASCII letters (e.g. Vietnamese) become spaces, the path
 * fallback is NOT lower-cased, and the 12-char cap applies to the joined
 * slug (it can cut mid-word and even leave a trailing '-').
 */
export function deriveRuleSlug(selection: string, relativePath: string | undefined): string {
	const fromText = selection
		.toLowerCase()
		.replace(/['"`]/g, '')
		.replace(/[^a-z0-9\s-]/g, ' ')
		.trim()
		.split(/\s+/)
		.filter(Boolean)
		.slice(0, 6)
		.join('-');
	const fromPath = relativePath
		? relativePath.split('/').filter(Boolean).slice(0, 3).join('-')
		: 'rule';
	return ((fromText.length > 0 ? fromText : fromPath) || 'rule')
		.slice(0, 12)
		.replace(/-+/g, '-');
}

/**
 * Pick a collision-free slug — verbatim port of the binary's uniqueness
 * loop (3.25.9 byte 24831196):
 *
 *   const base = slug || 'rule';
 *   let candidate = base, suffix = 1;
 *   while (await fileService.exists(getRuleUri(candidate, false))) {
 *     candidate = `${base}-${suffix++}`;
 *   }
 *
 * The suffix therefore starts at 1: `slug`, `slug-1`, `slug-2`, …
 * `exists` receives the candidate slug (the caller maps it to the rule URI).
 */
export async function uniqueRuleSlug(
	baseSlug: string,
	exists: (slug: string) => Promise<boolean>,
): Promise<string> {
	const base = baseSlug || 'rule';
	let candidate = base;
	let suffix = 1;
	while (await exists(candidate)) {
		candidate = `${base}-${suffix++}`;
	}
	return candidate;
}

/** Optional frontmatter inputs of the binary's createRule (4th parameter). */
export interface CreateRuleOptions {
	globs?: string;
	alwaysApply?: boolean;
}

/**
 * Content of the created rule file — verbatim port of the binary's
 * rule-service createRule (3.25.9 byte 31044289):
 *
 *   const lines = [];
 *   if (options?.globs) lines.push(`globs: ${options.globs}`);
 *   lines.push(`alwaysApply: ${(options?.alwaysApply ?? true) ? 'true' : 'false'}`);
 *   content = `---\n${lines.join('\n')}\n---\n\n${body.trimEnd()}\n`;
 *
 * The Create-Rule command passes no options, so files it creates carry
 * exactly `---\nalwaysApply: true\n---\n\n<body>\n`.
 */
export function buildRuleFileContent(body: string, options?: CreateRuleOptions): string {
	const alwaysApply = options?.alwaysApply ?? true;
	const lines: string[] = [];
	if (options?.globs) {
		lines.push(`globs: ${options.globs}`);
	}
	lines.push(`alwaysApply: ${alwaysApply ? 'true' : 'false'}`);
	return `---\n${lines.join('\n')}\n---\n\n${body.trimEnd()}\n`;
}

/**
 * Success toast, verbatim from the binary (3.25.9 byte 24830470):
 * "Created manual rule '<slug>' in .cursor/rules. Attach it explicitly when
 * you want it applied."
 */
export function createdRuleToastMessage(slug: string): string {
	return `Created manual rule '${slug}' in .cursor/rules. Attach it explicitly when you want it applied.`;
}

/** Failure notification, verbatim shape from the binary: `Failed to create rule: ${message}`. */
export function failedToCreateRuleMessage(error: unknown): string {
	const message = error instanceof Error ? error.message : String(error);
	return `Failed to create rule: ${message}`;
}
