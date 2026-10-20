import * as vscode from "vscode";

/**
 * chatResubmitService — "edit a sent message and resubmit" flow (Cursor parity).
 *
 * EVIDENCE (must-read before touching this file):
 * forum.cursor.com, staff (Mohit), 2026-03-23 — verbatim:
 *   "To clarify what the dialog options do: 'Continue and revert' restores
 *   your files to the state they were in at that message's checkpoint.
 *   'Continue without reverting' keeps your current file state but still
 *   clears the conversation messages after the one you edited. So the file
 *   changes are optional, but the message history truncation always happens
 *   on resubmit."
 *
 * Behavior:
 *  - Editing a sent (human) message and resubmitting shows a modal dialog
 *    with exactly the two verbatim options above, plus Cancel.
 *  - 'Continue and revert': restore workspace files to that message's
 *    checkpoint (files-only; transcript untouched by the restore), THEN
 *    truncate every message after the edited one. The restore reuses
 *    CheckpointService with skipConfirm — the resubmit dialog IS the
 *    confirmation (Cursor skips its "Discard all changes up to this
 *    checkpoint?" dialog on the submit-chat path; binary note
 *    `fromSubmitChat` — see CheckpointService.confirmCheckoutToCheckpoint).
 *  - 'Continue without reverting': keep current files, truncate every message
 *    after the edited one.
 *  - Cancel/dismiss: do nothing at all.
 *  - Truncation ALWAYS happens on resubmit (both options), per the staff
 *    quote. It is never optional.
 *
 * Do NOT confuse with the checkpoint-restore flow ("Discard all changes up
 * to this checkpoint?" — composerDataService.revertToCheckpoint), which is a
 * files-only restore with NO transcript truncation. This file is the
 * resubmit flow, which always truncates.
 *
 * UNKNOWN / divergence notes:
 *  - Cursor's exact dialog BODY text is not in the staff quote — only the two
 *    option labels are verbatim. The body wording below is our own
 *    paraphrase of the documented behavior; the option strings are NOT
 *    paraphrased.
 *  - If the edited message has no checkpoint, 'Continue and revert' degrades
 *    to truncate-only (the restore is a no-op) — truncation still happens.
 */

// Verbatim option labels from the staff quote — do NOT paraphrase.
export const RESUBMIT_OPTION_REVERT = "Continue and revert";
export const RESUBMIT_OPTION_KEEP = "Continue without reverting";
export const RESUBMIT_OPTION_CANCEL = "Cancel";

export type ResubmitChoice = "revert" | "keep" | "cancel";

/**
 * Hooks the service uses to effect the resubmit. In production these are
 * implemented by ComposerDataService (the ONLY place allowed to mutate the
 * bubble store, per the store mutation contract) — injected here so the
 * dialog/decision logic is unit-testable without a composer.
 */
export interface ChatResubmitHooks {
  /**
   * Files-only restore to the edited message's checkpoint. Must NOT show its
   * own confirmation dialog (the resubmit dialog is the confirmation).
   */
  restoreCheckpoint(bubbleId: string): Promise<void>;
  /**
   * Drop the edited bubble itself plus every bubble after it (the edited
   * message is re-submitted as a fresh turn, so it must not remain twice).
   * Returns the removed bubble ids.
   */
  truncateFrom(bubbleId: string): string[];
  /** Start a new turn with the edited text. */
  resubmit(text: string): void;
}

export class ChatResubmitService {
  /**
   * The resubmit confirmation dialog. Returns the user's choice; Cancel and
   * dismissal both resolve to "cancel".
   */
  async promptResubmitChoice(): Promise<ResubmitChoice> {
    const choice = await vscode.window.showInformationMessage(
      // NOTE: body text is our own wording — only the option labels below
      // are staff-verbatim (see header evidence).
      "You edited a previous message. Resubmitting will permanently remove " +
        "all messages after it. How do you want to continue?",
      { modal: true },
      RESUBMIT_OPTION_REVERT,
      RESUBMIT_OPTION_KEEP,
      RESUBMIT_OPTION_CANCEL,
    );
    if (choice === RESUBMIT_OPTION_REVERT) {
      return "revert";
    }
    if (choice === RESUBMIT_OPTION_KEEP) {
      return "keep";
    }
    // Cancel button or dialog dismissed (Esc / click-outside).
    return "cancel";
  }

  /**
   * Full edit-resubmit flow: prompt → (optionally restore files) → truncate →
   * resubmit. Returns true when a resubmit was started, false when the user
   * cancelled.
   */
  async handleResubmit(
    bubbleId: string,
    newText: string,
    hooks: ChatResubmitHooks,
  ): Promise<boolean> {
    const choice = await this.promptResubmitChoice();
    if (choice === "cancel") {
      return false;
    }
    if (choice === "revert") {
      // Files-only restore to the message's checkpoint; transcript
      // truncation happens below regardless of the restore outcome.
      await hooks.restoreCheckpoint(bubbleId);
    }
    // Truncation ALWAYS happens on resubmit — both options (staff quote).
    hooks.truncateFrom(bubbleId);
    hooks.resubmit(newText);
    return true;
  }
}
