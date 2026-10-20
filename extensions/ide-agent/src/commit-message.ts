/**
 * DEV-GAPS-54 `ai-commit-message-generation` — pure helpers (Cursor parity).
 *
 * Spec (feature-matrix.json, evidence from Cursor 3.25.6 cursor-always-local
 * static-literal extraction):
 *   "command cursor.generateGitCommitMessage (Generate Commit Message, f1
 *   palette, sparkle icon); menus.scm/inputBox when scmProvider==git;
 *   runCommand(GetCurrentIndexAndRecentCommits,{rawUris,rootPath}) ->
 *   {diffs, previousCommitMessages};
 *   generateCommitMessage({diffs, previousCommitMessages, explicitContext})
 *   -> input.setValue(message)"
 *
 * This module holds the testable core: collecting the "explicit context"
 * (diff + recent commit subjects as style reference) and building the
 * generation prompt, plus cleaning the raw model output into a single-line
 * message. The VS Code-facing orchestration (git calls, composer turn,
 * SCM inputBox fill) lives in extension.ts `generateGitCommitMessage`.
 *
 * node-testable: no vscode imports here.
 */

export type CommitDiffSource = "staged" | "working-tree";

/** Shape of the explicit context fed to the AI. Mirrors Cursor's
 * `GetCurrentIndexAndRecentCommits` -> `{diffs, previousCommitMessages}`. */
export interface CommitMessageContext {
  /** unified diff of staged (index) files, or working-tree files when the
   * index is empty */
  diff: string;
  /** short stat summary of the same change set */
  stat: string;
  /** recent commit subjects, newest first — style reference only */
  previousCommitMessages: string[];
  /** which change set `diff` came from */
  source: CommitDiffSource;
}

/** Upper bound for the diff embedded in the prompt. */
export const COMMIT_MESSAGE_MAX_DIFF_CHARS = 12_000;
/** Upper bound for the stat summary embedded in the prompt. */
export const COMMIT_MESSAGE_MAX_STAT_CHARS = 2_000;
/** How many recent commit subjects to fetch as style reference. */
export const COMMIT_MESSAGE_RECENT_COUNT = 10;

function truncate(text: string, maxChars: number): string {
  return text.length > maxChars ? text.slice(0, maxChars) + "\n…[truncated]" : text;
}

/**
 * Build the "explicit context" prompt for commit-message generation.
 * The rules keep the model on a single imperative subject line; the recent
 * subjects teach the repo's existing style (Cursor's `previousCommitMessages`
 * input serves exactly this role).
 */
export function buildCommitMessagePrompt(ctx: CommitMessageContext): string {
  const scopeNote =
    ctx.source === "staged"
      ? "These changes are STAGED and about to be committed."
      : "No changes are staged — these are UNSTAGED working-tree changes. Generate the message anyway.";
  const styleNote =
    ctx.previousCommitMessages.length > 0
      ? "Recent commit messages in this repo (match their style, e.g. conventional commits if used):\n" +
        ctx.previousCommitMessages.map((m) => `- ${m}`).join("\n") +
        "\n\n"
      : "";
  return (
    `Write a single git commit message for the ${ctx.source} changes below. ${scopeNote}\n\n` +
    `Rules: imperative mood, subject line of 72 characters or fewer, no body unless the ` +
    `change needs explanation, output ONLY the message text — no code fences, no explanation.\n\n` +
    styleNote +
    `File summary:\n${truncate(ctx.stat, COMMIT_MESSAGE_MAX_STAT_CHARS)}\n\n` +
    `Diff:\n${truncate(ctx.diff, COMMIT_MESSAGE_MAX_DIFF_CHARS)}`
  );
}

/**
 * Clean raw model output into a single-line commit message:
 * strip markdown fences, take the first non-empty line, trim.
 * Returns "" when nothing usable remains.
 */
export function cleanCommitMessage(text: string): string {
  const withoutFences = text
    .replace(/^```[a-z]*\s*/i, "")
    .replace(/\s*```$/, "")
    .trim();
  const firstLine = withoutFences
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line.length > 0);
  // Guard against the model echoing the prompt or quoting the message.
  return (firstLine ?? "").replace(/^["'`]+|["'`]+$/g, "").trim();
}

/**
 * Parse `git log --format=%s` output into a subject list (newest first),
 * dropping blank lines. Bounded to COMMIT_MESSAGE_RECENT_COUNT.
 */
export function parseRecentCommitMessages(logOutput: string): string[] {
  return logOutput
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .slice(0, COMMIT_MESSAGE_RECENT_COUNT);
}
