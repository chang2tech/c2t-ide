/**
 * chatWidthService.ts — Chat Width (Settings > Appearance > Agent Conversations).
 *
 * BINARY EVIDENCE (Cursor 3.25.9, workbench.glass.main.js, module
 * AppearanceSettings.js):
 *   QKe={label:"Chat Width",
 *        description:"Set the maximum width of Agent conversations",
 *        searchAliases:["chat width","max width","conversation width",
 *                       "wide","narrow","tables","chatMaxWidth"]}
 *   — registered right next to "Code Block Word Wrap" and
 *   "Themed Diff Backgrounds", i.e. the Agent Conversations appearance group.
 *
 * DOCS EVIDENCE (cursor.com/docs/release-notes, recorded in
 * ide-code-mission/docs/rea/dig-docs-blog-changelog-findings.json):
 *   "A new Chat Width slider in Settings > Appearance > Agent Conversations
 *    sets how wide agent conversations can grow, from Narrow to Wide
 *    (600 to 1600px). Widen it to give tables and code more room, or
 *    narrow it for easier reading."
 *
 * KNOWN UNKNOWNS (do NOT claim parity on these):
 *  - Cursor's canonical DEFAULT is not revealed by the binary or the docs.
 *    A live Cursor 3.25.9 profile observed the slider at 780px, but that is
 *    a stored user value, not evidence of the default. OUR DEFAULT 900px is
 *    our own choice and is marked as such in the setting registration.
 *  - The exact Cursor property id is not visible in the minified bundle
 *    (the variable QKe is the whole setting object); "chatMaxWidth" appears
 *    in the binary's own searchAliases, so `ide.composer.chatMaxWidth`
 *    mirrors the established `ide.composer.*` ↔ `cursor.composer.*` naming
 *    convention used by every other composer setting in this repo.
 *  - Whether Cursor centres the conversation when it is narrower than the
 *    panel is not observable from the evidence; we centre via
 *    `align-self: center` on #messages so a narrow width looks intentional
 *    instead of left-stuck. If a later live-CDP pass shows otherwise, this
 *    is a one-line CSS change.
 */
export const CHAT_WIDTH_MIN_PX = 600;
export const CHAT_WIDTH_MAX_PX = 1600;

/**
 * Default chat width in px. OUR CHOICE — the Cursor binary and docs do not
 * reveal the canonical default (see header comment). 900px keeps lines
 * readable while giving code blocks breathing room.
 */
export const CHAT_WIDTH_DEFAULT_PX = 900;

/**
 * Normalize a raw setting value to a safe pixel width.
 *
 * - Non-finite / non-number / undefined → CHAT_WIDTH_DEFAULT_PX (a hand-
 *   edited settings.json string or a corrupt value must never break the
 *   webview CSS).
 * - Out-of-range numbers are clamped to [600, 1600] so programmatic or
 *   hand-edited values cannot blow out the layout.
 * - Fractional values are rounded to whole px (CSS var expects integer px).
 */
export function normalizeChatWidth(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return CHAT_WIDTH_DEFAULT_PX;
  }
  const rounded = Math.round(value);
  if (rounded < CHAT_WIDTH_MIN_PX) {
    return CHAT_WIDTH_MIN_PX;
  }
  if (rounded > CHAT_WIDTH_MAX_PX) {
    return CHAT_WIDTH_MAX_PX;
  }
  return rounded;
}

/**
 * The CSS length string the webview applies to the conversation container,
 * e.g. "1200px". Kept as a pure helper so the webview wiring and the host
 * both format the value identically; unit-tested below.
 */
export function chatWidthCssValue(widthPx: number): string {
  return `${normalizeChatWidth(widthPx)}px`;
}
