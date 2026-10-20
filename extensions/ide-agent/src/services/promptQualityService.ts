/**
 * Prompt Quality review — host-side glue for the "Open in Prompt Quality"
 * commands. Opens the current chat's prompt in a review panel so the user
 * can evaluate and improve its quality.
 *
 * Binary evidence (Cursor 3.25.6, workbench.glass.main.js — static string
 * literals): commands `composer.openPromptQuality` (label "Open in Prompt
 * Quality") and `composer.openPromptQualityFromPane`; class `HiI` registers
 * id `sQp` with a minified title "Open Te..." (truncated in the bundle).
 * That is the full extent of the evidence: both command ids and the
 * "Open in Prompt Quality" label are pinned verbatim below.
 *
 * UNKNOWN: the real content/behavior of Cursor's Prompt Quality tool was
 * never dissected (no dialog, rubric, scoring, or panel markup observed).
 * The rubric, scoring heuristics, and panel HTML in this file are
 * IDE-CODE-ORIGINAL — designed by us for parity of *intent* (review a
 * prompt for quality), NOT a claim of behavioral parity with Cursor's
 * tool. Per the hard rule: no evidence = no "giống Cursor" claim on the
 * evaluation itself.
 */

/** Cursor command id — verbatim from the 3.25.6 bundle literal. */
export const OPEN_PROMPT_QUALITY = "composer.openPromptQuality";
/** Cursor command id — verbatim from the 3.25.6 bundle literal. */
export const OPEN_PROMPT_QUALITY_FROM_PANE = "composer.openPromptQualityFromPane";
/** Cursor command label — verbatim from the 3.25.6 bundle literal. */
export const OPEN_PROMPT_QUALITY_TITLE = "Open in Prompt Quality";

/** Minimal host surface — command registry plus the panel opener the host wires up. */
export interface PromptQualityHost {
  registerCommand(id: string, handler: (prompt?: string) => void): void;
  openPromptQualityPanel(prompt: string): void;
}

export type RubricDimensionId = "clarity" | "specificity" | "context";

export interface RubricDimension {
  id: RubricDimensionId;
  label: string;
  /** 0–100, integer. */
  score: number;
  /** Plain-language explanation of what raised/lowered the score. */
  feedback: string;
}

/**
 * Register both Cursor command ids. Both invoke the same panel; the
 * "FromPane" variant receives the pane's prompt text when the caller passes
 * it as the command argument.
 *
 * The caller (extension.ts) resolves the host: registerCommand delegates to
 * vscode.commands.registerCommand, openPromptQualityPanel creates a
 * vscode WebviewPanel fed by buildPromptQualityPanelHtml().
 */
export function registerPromptQualityCommands(host: PromptQualityHost): void {
  const handler = (prompt?: string): void => {
    host.openPromptQualityPanel(prompt ?? "");
  };
  host.registerCommand(OPEN_PROMPT_QUALITY, handler);
  host.registerCommand(OPEN_PROMPT_QUALITY_FROM_PANE, handler);
}

// ---------------------------------------------------------------------------
// Our own rubric. Designed for ide-code; NOT claimed to match Cursor's
// (undisclosed) Prompt Quality tool — see header. UNKNOWN on Cursor's side.
// ---------------------------------------------------------------------------

function clampScore(n: number): number {
  return Math.max(0, Math.min(100, Math.round(n)));
}

const IMPERATIVE_STARTERS =
  /\b(fix|add|create|explain|write|refactor|review|debug|implement|update|remove|test|design|help)\b/i;
const FILE_PATH = /[\w./-]+\.(ts|tsx|js|jsx|mjs|cjs|py|go|rs|java|kt|cpp|c|h|rb|php|swift|vue|svelte|json|yaml|yml|md|css|scss|html|sql|sh)/i;
const CODE_FENCE = /```/;
const NUMBERY = /\b\d+(\.\d+)*\b/;
const TECH_TERMS =
  /\b(api|database|schema|component|service|module|function|endpoint|query|build|deploy|test|cache|auth|state|route|migration|dependency)\b/i;
const CONSTRAINTS =
  /\b(must|should not|must not|don'?t|never|always|keep|ensure|avoid|only if)\b/i;

function scoreClarity(text: string, words: number): RubricDimension {
  const feedback: string[] = [];
  if (words === 0) {
    return { id: "clarity", label: "Clarity", score: 0, feedback: "No prompt text to evaluate." };
  }
  let score = 40;
  if (words >= 8) {
    score += 15;
    feedback.push("long enough to express a goal");
  } else {
    feedback.push("very short — expand what you want");
  }
  if (words >= 25) {
    score += 10;
    feedback.push("gives room for detail");
  }
  if (words > 500) {
    score -= 15;
    feedback.push("very long — consider splitting into steps");
  }
  if (IMPERATIVE_STARTERS.test(text)) {
    score += 10;
    feedback.push("states an action");
  } else {
    feedback.push("no clear action verb (fix, add, explain, …)");
  }
  const requestCount = (text.match(/\?/g) ?? []).length;
  if (requestCount > 2) {
    score -= 10;
    feedback.push("asks several questions at once — focus on one");
  }
  return { id: "clarity", label: "Clarity", score: clampScore(score), feedback: feedback.join("; ") + "." };
}

function scoreSpecificity(text: string, words: number): RubricDimension {
  const feedback: string[] = [];
  if (words === 0) {
    return { id: "specificity", label: "Specificity", score: 0, feedback: "No prompt text to evaluate." };
  }
  let score = 35;
  if (CODE_FENCE.test(text)) {
    score += 15;
    feedback.push("includes a code sample");
  } else {
    feedback.push("no code sample included");
  }
  if (FILE_PATH.test(text)) {
    score += 15;
    feedback.push("names concrete files");
  } else {
    feedback.push("no file or module named");
  }
  if (NUMBERY.test(text)) {
    score += 10;
    feedback.push("gives concrete numbers/versions");
  }
  if (/\b(error|stack trace|expected|actual)\b/i.test(text)) {
    score += 5;
    feedback.push("describes the failure concretely");
  }
  if (words < 12) {
    score -= 10;
    feedback.push("too vague for a specific answer");
  }
  return { id: "specificity", label: "Specificity", score: clampScore(score), feedback: feedback.join("; ") + "." };
}

function scoreContext(text: string, words: number): RubricDimension {
  const feedback: string[] = [];
  if (words === 0) {
    return { id: "context", label: "Context", score: 0, feedback: "No prompt text to evaluate." };
  }
  let score = 30;
  if (TECH_TERMS.test(text)) {
    score += 20;
    feedback.push("references the technical area");
  } else {
    feedback.push("no mention of the area/system involved");
  }
  if (CONSTRAINTS.test(text)) {
    score += 15;
    feedback.push("states constraints or requirements");
  } else {
    feedback.push("no constraints stated");
  }
  if (/\b(because|so that|in order to|goal|purpose)\b/i.test(text)) {
    score += 10;
    feedback.push("explains the goal behind the request");
  }
  return { id: "context", label: "Context", score: clampScore(score), feedback: feedback.join("; ") + "." };
}

/**
 * Score a chat prompt against our own 3-dimension rubric. Pure and
 * deterministic — same input always yields the same scores. This is a
 * lightweight heuristic to help the user improve prompts; it is NOT
 * claimed to replicate Cursor's (undisclosed) Prompt Quality evaluation.
 */
export function scorePrompt(promptText: string): RubricDimension[] {
  const text = (promptText ?? "").trim();
  const words = text ? text.split(/\s+/).length : 0;
  return [scoreClarity(text, words), scoreSpecificity(text, words), scoreContext(text, words)];
}

/** Escape text before interpolating into the panel HTML. */
export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function scoreBar(score: number): string {
  const color = score >= 70 ? "#2f9e44" : score >= 40 ? "#e8890c" : "#e03131";
  return `<div style="background:#3a3d41;border-radius:4px;height:8px;width:220px;display:inline-block;vertical-align:middle"><div style="background:${color};border-radius:4px;height:8px;width:${score}%"></div></div>`;
}

/**
 * Build the webview panel HTML for the Prompt Quality review. Shows the
 * original prompt verbatim plus the rubric table with scores and feedback.
 * Everything user-supplied is escaped; the layout is ours (UNKNOWN what
 * Cursor's tool renders — no parity claim).
 */
export function buildPromptQualityPanelHtml(promptText: string, dimensions: RubricDimension[]): string {
  const rows = dimensions
    .map(
      (d) => `<tr>
      <td style="padding:10px 12px;font-weight:600;white-space:nowrap">${escapeHtml(d.label)}</td>
      <td style="padding:10px 12px">${scoreBar(d.score)} <strong>${d.score}/100</strong></td>
      <td style="padding:10px 12px;color:#cccccc">${escapeHtml(d.feedback)}</td>
    </tr>`,
    )
    .join("\n");
  return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"></head>
<body style="font-family:var(--vscode-font-family,sans-serif);color:var(--vscode-foreground,#cccccc);padding:20px;max-width:900px">
  <h2 style="margin-top:0">${escapeHtml(OPEN_PROMPT_QUALITY_TITLE)}</h2>
  <p style="color:#999">A quick self-review of your prompt before sending it to the agent. The rubric is ours — adjust the prompt, not the score.</p>
  <h3>Prompt under review</h3>
  <pre style="background:#1e1e1e;border:1px solid #3a3d41;border-radius:6px;padding:12px;white-space:pre-wrap;word-break:break-word">${escapeHtml(promptText ?? "") || "(empty prompt)"}</pre>
  <h3>Rubric</h3>
  <table style="border-collapse:collapse;width:100%">
    <thead><tr style="text-align:left;border-bottom:1px solid #3a3d41">
      <th style="padding:8px 12px">Dimension</th><th style="padding:8px 12px">Score</th><th style="padding:8px 12px">Feedback</th>
    </tr></thead>
    <tbody>${rows}</tbody>
  </table>
</body>
</html>`;
}
