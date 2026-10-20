// Local declarations for the proposed `cursor.registerCheckoutProvider` API.
// Runtime: implemented in the fork's extHost (`vscode.cursor` namespace,
// gated by "enabledApiProposals": ["cursor"] in package.json). Types:
// declared here because @types/vscode only ships the stable API surface.
// Method set is verbatim from the decompiled `cursor-checkout` v0.0.1
// extension (Cursor 3.25.9) — see
// ~/workspace/ide-code-mission/docs/rea/harvest-cursor-checkout-2026-10-19.md
// (structure/behavior only; no proprietary code reproduced).
declare module "vscode" {
  namespace cursor {
    export interface CheckoutBranchOptions {
      readonly commitSha?: string;
      readonly localOnly?: boolean;
    }
    export interface EnsureBranchPushedOptions {
      readonly cwd?: string;
      readonly remoteName?: string;
      readonly branchName?: string;
      readonly forcePush?: boolean;
    }
    export interface SnapshotPushOptions {
      readonly cwd?: string;
      readonly remoteName?: string;
      readonly commitMessage?: string;
      readonly branchPrefix?: string;
      readonly stashLocalChangesAfterPush?: boolean;
      readonly stashMessage?: string;
    }
    export type CheckoutConflictResolution = "stash" | "commit" | "discard";
    /**
     * Conflict delegate handed to the provider as the first argument of
     * `checkoutBranch` (verbatim: `checkoutBranch(provider, { commitSha?,
     * localOnly? }, token)`, Cursor 3.25.9). `resolveConflict()` RPCs back to
     * the main thread, where workbench core shows the stash/commit/discard/
     * cancel QuickPick. Resolves `'abort'` when dismissed.
     */
    export interface CheckoutConflictDelegate {
      resolveConflict(): Promise<CheckoutConflictResolution | "abort" | undefined>;
      onNoConflictDetected(): void;
    }
    export interface CheckoutProvider {
      checkoutBranch(
        delegate: CheckoutConflictDelegate,
        branchName: string,
        options: CheckoutBranchOptions,
        token: CancellationToken
      ): Promise<void>;
      warmCheckoutBranch(branchName: string, token: CancellationToken): Promise<void>;
      ensureCurrentBranchPushed(
        options: EnsureBranchPushedOptions,
        token: CancellationToken
      ): Promise<void>;
      snapshotAndPushCurrentBranch(
        options: SnapshotPushOptions,
        token: CancellationToken
      ): Promise<string>;
      hasDirtyWorkingTree(token: CancellationToken): Promise<boolean>;
    }
    export function registerCheckoutProvider(
      provider: CheckoutProvider
    ): Disposable;
  }
}
