/**
 * Cursor parity: "Copy Request ID" (debug).
 *
 * Binary evidence (Cursor 3.25.6, workbench.glass.main.js static literal):
 * commands 'composer.copyRequestId', 'composer.copyRequestIdFromPane',
 * 'composer.copyRequestIdFromEditor' are registered. Behavior: the user (or
 * support) copies the backend request ID of a chat turn from the pane or
 * from the editor to debug / file a bug report.
 *
 * Data source: the assistant bubble of the chat turn carries the backend id
 * on `bubble.serverBubbleId` (model.ts; reconciled by bubbleStore
 * `reconcileServerId`, sourced from the engine adapter's `reconcile` event).
 * When no server id is known yet (e.g. a stub/simulated turn), the client
 * `bubbleId` is the best available identifier. This matches the resolution
 * the extension host previously used inline in extension.ts
 * (`last?.serverBubbleId ?? last?.bubbleId`).
 *
 * UNKNOWN (not verifiable from the static literals): whether Cursor 3.25.6
 * prefers `serverBubbleId` or some other field for FromPane/FromEditor. The
 * fallback chain below is our fork's best-known resolution, not a binary
 * claim.
 *
 * Extracted as a testable module: all VS Code access goes through the
 * injected `CopyRequestIdSeam`, and turn lookup goes through the injected
 * `CopyRequestIdResolver`. Nothing here depends on the extension host.
 */

export const COPY_REQUEST_ID_COMMAND = "composer.copyRequestId";
export const COPY_REQUEST_ID_FROM_PANE_COMMAND = "composer.copyRequestIdFromPane";
export const COPY_REQUEST_ID_FROM_EDITOR_COMMAND = "composer.copyRequestIdFromEditor";

/** Where the command was invoked from — lets the resolver pick the right chat. */
export type CopyRequestIdSource = "pane" | "editor" | "palette";

export interface CopyRequestIdResolver {
  /**
   * Returns the backend request id of the current chat turn, or `undefined`
   * when there is no turn yet. Implementations should read it from the chat
   * data provider (composer bubbles: `serverBubbleId ?? bubbleId`).
   */
  getCurrentTurnRequestId(source: CopyRequestIdSource): string | undefined;
}

export interface CopyRequestIdSeam {
  writeClipboardText(text: string): Promise<void>;
  showInformationMessage(message: string): void;
  registerCommand(
    id: string,
    handler: (args?: unknown) => void | Promise<void>,
  ): { dispose(): void };
}

export interface CopyRequestIdDeps {
  resolver: CopyRequestIdResolver;
  seam: CopyRequestIdSeam;
}

/**
 * Copies the current turn's backend request id to the clipboard.
 * Returns `true` when an id was copied, `false` when there was none.
 */
export async function copyCurrentTurnRequestId(
  deps: CopyRequestIdDeps,
  source: CopyRequestIdSource,
): Promise<boolean> {
  const requestId = deps.resolver.getCurrentTurnRequestId(source);
  if (requestId) {
    await deps.seam.writeClipboardText(requestId);
    deps.seam.showInformationMessage("IDE Agent: request ID copied to the clipboard.");
    return true;
  }
  deps.seam.showInformationMessage("IDE Agent: no request ID yet — ask the agent something first.");
  return false;
}

/**
 * Registers the three Copy Request ID commands.
 * - `composer.copyRequestId` — invoked without an explicit origin (palette / keybinding).
 * - `composer.copyRequestIdFromPane` — invoked from the AI pane.
 * - `composer.copyRequestIdFromEditor` — invoked from a chat editor tab.
 *
 * Returns a combined disposable.
 */
export function registerCopyRequestIdCommands(deps: CopyRequestIdDeps): { dispose(): void } {
  const registrations: Array<{ dispose(): void }> = [
    deps.seam.registerCommand(COPY_REQUEST_ID_COMMAND, (_args?: unknown) => {
      void copyCurrentTurnRequestId(deps, "palette");
    }),
    deps.seam.registerCommand(COPY_REQUEST_ID_FROM_PANE_COMMAND, (_args?: unknown) => {
      void copyCurrentTurnRequestId(deps, "pane");
    }),
    deps.seam.registerCommand(COPY_REQUEST_ID_FROM_EDITOR_COMMAND, (_args?: unknown) => {
      void copyCurrentTurnRequestId(deps, "editor");
    }),
  ];
  return {
    dispose: () => {
      for (const r of registrations) {
        r.dispose();
      }
    },
  };
}
