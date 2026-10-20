import * as vscode from "vscode";

/**
 * planCopyService — plan-mode "Copy plan markdown" (Cursor parity).
 *
 * Binary evidence (Cursor 3.25.9, workbench.glass.main.js — W77D, 2026-10-20):
 * - copy-action map `lm` (module "glass-toast.js"):
 *   `copyPlanMarkdown:"glass.copy-plan-markdown"` @25574265-25574289,
 *   alongside copy-messages / copy-diff-path / copy-browser-url.
 * - run body (PlanTabContent) @32802481, recovered verbatim:
 *   `Et=sH(()=>{ae.writeText(Le.serializedMarkdown).then(()=>{de.notify(`
 *   `{severity:ii.Info,message:"Copied plan markdown to clipboard",`
 *   `id:lm.copyPlanMarkdown})}).catch(mn=>{ee.error(`
 *   `"[PlanTabContent] Failed to copy plan as markdown:",mn)})},`
 *   `[ae,ee,de,Le.serializedMarkdown])`
 * - wired as `onCopyAsMarkdown: Et` in the plan tab header (alongside
 *   onBuild / onSaveToWorkspace / onFind).
 *
 * The three verbatim values — copied markdown source, success toast and
 * failure log tag — are preserved exactly:
 *  - SOURCE = the plan's serialized markdown (`PendingPlan.text` is the
 *    assistant's markdown source — the fork analog of `Le.serializedMarkdown`).
 *  - TOAST = "Copied plan markdown to clipboard" (Info notification).
 *  - LOG TAG = "[PlanTabContent] Failed to copy plan as markdown:".
 *
 * HONEST-DIVERGENCES from the binary:
 *  - Cursor's action lives in the glass plan TAB header (`onCopyAsMarkdown`
 *    prop). The fork has no plan tab — plan review happens in the
 *    extension's chat webview plan tray (`planTray` in components/composer.ts)
 *    — so the action is the tray's "Copy as Markdown" button plus the
 *    palette command `ide.copyPlanMarkdown`, both resolving the pending
 *    plan from the tab's ComposerDataService.
 *  - The binary's notify id `lm.copyPlanMarkdown` (= "glass.copy-plan-markdown",
 *    a glass-toast dedup id) has no fork analog; the fork shows a plain
 *    info message with the verbatim text.
 *  - The binary logs failures via the workbench log service (`ee.error`);
 *    the fork routes them to the "IDE Agent" output channel.
 */
export const COPY_PLAN_MARKDOWN_COMMAND_ID = "ide.copyPlanMarkdown";
export const COPY_PLAN_MARKDOWN_TITLE = "Copy plan markdown";
export const PLAN_MARKDOWN_COPIED_MESSAGE = "Copied plan markdown to clipboard";
export const COPY_PLAN_MARKDOWN_FAILED_LOG_TAG =
  "[PlanTabContent] Failed to copy plan as markdown:";

/** Outcome of the copy flow (mirrors the binary's then/catch split). */
export type CopyPlanMarkdownResult = "copied" | "empty" | "failed";

/** Seam over the host APIs so node:test can inject stubs. */
export interface PlanCopySeam {
  writeClipboardText(text: string): Promise<void> | Thenable<void>;
  showInformationMessage(message: string): void;
  logError(tag: string, err: unknown): void;
}

/**
 * Pure resolver: the trimmed non-empty plan markdown, or undefined when
 * there is no plan (or no text). The binary's handler only exists while a
 * plan is loaded, so "no plan" is a silent no-op there too.
 */
export function resolvePlanMarkdownToCopy(
  plan: { text?: string | null } | null | undefined,
): string | undefined {
  const text = typeof plan?.text === "string" ? plan.text.trim() : "";
  return text ? text : undefined;
}

/**
 * Minimal structural requirement on the plan owner (satisfied by
 * ComposerDataService; kept structural so tests can inject a stub).
 */
export interface PlanMarkdownHolder {
  getPendingPlan(): { text?: string | null } | null | undefined;
}

/**
 * Copy the tab's pending plan markdown to the clipboard (Cursor
 * `glass.copy-plan-markdown` parity). Verbatim port of the binary run body:
 * `writeText(serializedMarkdown)` -> on success the Info toast
 * "Copied plan markdown to clipboard"; on failure the error log
 * "[PlanTabContent] Failed to copy plan as markdown:".
 *
 * Returns "copied" / "empty" (no plan — silent no-op, like the binary) /
 * "failed".
 */
export async function copyPendingPlanMarkdownToClipboard(
  composer: PlanMarkdownHolder,
  seam: PlanCopySeam,
): Promise<CopyPlanMarkdownResult> {
  const markdown = resolvePlanMarkdownToCopy(composer.getPendingPlan());
  if (!markdown) {
    return "empty";
  }
  try {
    await seam.writeClipboardText(markdown);
  } catch (err) {
    seam.logError(COPY_PLAN_MARKDOWN_FAILED_LOG_TAG, err);
    return "failed";
  }
  seam.showInformationMessage(PLAN_MARKDOWN_COPIED_MESSAGE);
  return "copied";
}

let planCopyLogChannel: vscode.OutputChannel | undefined;

/**
 * Production seam for the chat surfaces (sidebar chat view and the chat
 * editor tab). Mirrors `makeCopyMessageSeam` (chatCopyMessageService.ts).
 */
export function makePlanCopySeam(): PlanCopySeam {
  return {
    writeClipboardText: (text: string) => vscode.env.clipboard.writeText(text),
    showInformationMessage: (message: string) => {
      void vscode.window.showInformationMessage(message);
    },
    logError: (tag: string, err: unknown) => {
      if (!planCopyLogChannel) {
        planCopyLogChannel = vscode.window.createOutputChannel("IDE Agent");
      }
      const m = err instanceof Error ? err.message : String(err);
      planCopyLogChannel.appendLine(`${tag} ${m}`);
    },
  };
}
