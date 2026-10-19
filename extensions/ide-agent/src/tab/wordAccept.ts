/**
 * Word-boundary logic for partial (next-word) accept.
 * Mirrors Cursor's `makeEditsForNextWordAccept` / `onlyAcceptFirstWord` semantics:
 * from the current offset inside the suggestion text, skip whitespace, then
 * consume exactly one "word":
 *   - a run of word characters (letters, digits, `_`, unicode-aware), or
 *   - a run of non-word, non-space characters (operators / punctuation).
 */

const WORD_CHAR = /[\p{L}\p{N}_]/u;
const SPACE = /\s/;

function isWordChar(c: string): boolean {
  return WORD_CHAR.test(c);
}

/**
 * Offset of the end of the next word starting at `from`.
 * Returns `text.length` when nothing remains.
 */
export function nextWordBoundary(text: string, from: number): number {
  let i = Math.max(0, from);
  const n = text.length;
  while (i < n && SPACE.test(text[i]!)) i++;
  if (i >= n) return n;
  if (isWordChar(text[i]!)) {
    while (i < n && isWordChar(text[i]!)) i++;
  } else {
    while (i < n && !SPACE.test(text[i]!) && !isWordChar(text[i]!)) i++;
  }
  return i;
}

export interface PartialAcceptResult {
  /** Text newly applied by this partial accept (may be empty). */
  applied: string;
  /** Offset into the full suggestion text after applying. */
  newOffset: number;
  /** True when the whole suggestion has now been consumed. */
  fullyConsumed: boolean;
}

/** Apply one "next word" step of a partial accept. Pure and testable. */
export function acceptNextWord(fullText: string, offset: number): PartialAcceptResult {
  const boundary = nextWordBoundary(fullText, offset);
  return {
    applied: fullText.slice(offset, boundary),
    newOffset: boundary,
    fullyConsumed: boundary >= fullText.length,
  };
}

/**
 * P1 (QA-FILE-06): pure type-over detector. Returns the typed text iff
 * `change` is a single pure insertion exactly at the expected type-over
 * position (the suggestion's insertPosition advanced by the already-applied
 * prefix); otherwise returns ''.
 *
 * Plain `{line, character}` shapes keep this testable without vscode.
 *
 * Without the position check, typing a matching character elsewhere in the
 * file would falsely record PARTIAL_ACCEPT and corrupt `appliedLength`
 * (e.g. suggestion `function foo()`, user types `f` on another line).
 */
export function typeOverText(
  insertLine: number,
  insertCharacter: number,
  fullText: string,
  appliedLength: number,
  change: { rangeLength: number; startLine: number; startCharacter: number; text: string },
): string {
  if (change.rangeLength !== 0) return '';
  const prefix = fullText.slice(0, appliedLength);
  const lines = prefix.split('\n');
  const expLine = insertLine + lines.length - 1;
  const expCharacter =
    lines.length === 1 ? insertCharacter + prefix.length : lines[lines.length - 1]!.length;
  if (change.startLine !== expLine || change.startCharacter !== expCharacter) return '';
  return change.text;
}
