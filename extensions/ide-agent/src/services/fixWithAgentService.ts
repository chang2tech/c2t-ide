/**
 * fixWithAgentService — runtime half of Cursor's diagnostic
 * "Fix with Agent" flow (DEV-GAPS-83, `agent-fix-with-agent-error`).
 *
 * Binary evidence (Cursor 3.25.9, workbench.glass.main.js, self-verified
 * 2026-10-20):
 *  - `editor.action.fixInAgent` command + "Fix in Agent" QuickFix code
 *    actions + the marker-hover "Fix with Agent" button all funnel into
 *    the composer service's `fixLinterErrorWithAI({ errorMessage,
 *    editorUri, range, addToCurrent })` (byte ~40267498).
 *  - Its prompt is VERBATIM:
 *      `For the code present, we get this error:\n```\n${errorMessage}\n```\nFix it, verify, and then give a concise explanation.`
 *  - The attached code selection spans lines
 *    `[max(1, start-1) .. min(lineCount, end+2)]` (full width).
 *  - Dedupe: if the last human bubble's text already equals the prompt
 *    AND the composer status is "generating", it returns without acting.
 *  - `addToCurrent: true` reuses the selected composer; `false` creates a
 *    new composer first (hover Ctrl/Cmd+click).
 *  - Hover telemetry: `trackEvent("hover_bar.submit_fix", { useCurrent,
 *    mode: "edit" })` — emitted here for every entry point with the
 *    fork's `[telemetry]` output-channel convention (see
 *    chatCopyMessageService.ts); `useCurrent` mirrors addToCurrent.
 *
 * HONEST-DIVERGENCE: Cursor PRE-FILLS the composer input and only submits
 * when a caller passes `autoSubmit` (none of the three entry points do).
 * The fork's composer API is submit-based (`ComposerDataService.submit`,
 * the same path `ide.investigateError` / `fixWithAI` use), so this service
 * submits the verbatim prompt. The attached code selection is delivered
 * through the fork's selection-context chip mechanism
 * (`addSelectionContext`, the K-07 mechanism Cursor's
 * `addCodeSelectionWithInlineMention` maps to in this fork).
 */

export const FIX_WITH_AGENT_TELEMETRY_EVENT = "hover_bar.submit_fix";

/** 1-based line/column range, as passed by the core command. */
export interface FixRange {
  startLineNumber: number;
  startColumn: number;
  endLineNumber: number;
  endColumn: number;
}

/** The verbatim `fixLinterErrorWithAI` prompt. Keep byte-identical. */
export function buildFixLinterPrompt(errorMessage: string): string {
  return `For the code present, we get this error:\n\`\`\`\n${errorMessage}\n\`\`\`\nFix it, verify, and then give a concise explanation.`;
}

/**
 * The widened context range (1-based lines, inclusive) Cursor attaches:
 * start `max(1, start-1)`, end `min(lineCount, end+2)`.
 */
export function fixContextLines(range: FixRange, lineCount: number): { startLine: number; endLine: number } {
  return {
    startLine: Math.max(1, range.startLineNumber - 1),
    endLine: Math.min(lineCount, range.endLineNumber + 2),
  };
}

/** Seam over the host APIs so node:test can inject stubs. */
export interface FixWithAgentSeam {
  /** Open the document for `uriString`; undefined when it cannot be opened. */
  openDocument(uriString: string): Promise<{ lineCount: number; getLines(startLine: number, endLine: number): string } | undefined>;
  /** Text of the last human bubble in the target composer, if any. */
  lastHumanBubbleText(): string | undefined;
  /** Whether the target composer is currently generating a turn. */
  isGenerating(): boolean;
  /** Create and activate a fresh chat tab (binary createComposer path). */
  createNewChat(): Promise<void>;
  /** Attach a code-selection context chip to the (new) active composer. */
  addSelectionContext(label: string, content: string): void;
  /** Submit the prompt to the target composer. */
  submit(prompt: string): void;
  /** Reveal/focus the chat surface. */
  focusChat(): Promise<void>;
  trackEvent(eventName: string, data: Record<string, unknown>): void;
}

export interface FixWithAgentRequest {
  uriString: string;
  errorMessage: string;
  range: FixRange;
  addToCurrent: boolean;
}

/**
 * Run one fix request. Returns false when the document could not be
 * opened or the binary's generating-dedupe guard suppressed the fix.
 */
export async function fixErrorWithAgent(request: FixWithAgentRequest, seam: FixWithAgentSeam): Promise<boolean> {
  const prompt = buildFixLinterPrompt(request.errorMessage);

  // Binary dedupe guard (checked against the currently selected composer
  // before any new composer is created).
  if (seam.isGenerating() && seam.lastHumanBubbleText() === prompt) {
    return false;
  }

  const doc = await seam.openDocument(request.uriString);
  if (!doc) {
    return false;
  }

  if (!request.addToCurrent) {
    await seam.createNewChat();
  }

  const { startLine, endLine } = fixContextLines(request.range, doc.lineCount);
  const code = doc.getLines(startLine, endLine);
  if (code.trim()) {
    const fileName = request.uriString.split("/").pop() ?? request.uriString;
    seam.addSelectionContext(`${fileName}:${startLine}-${endLine}`, code);
  }

  seam.trackEvent(FIX_WITH_AGENT_TELEMETRY_EVENT, { useCurrent: request.addToCurrent, mode: "edit" });
  seam.submit(prompt);
  await seam.focusChat();
  return true;
}
