/**
 * ide-checkout — built-in extension implementing the checkout provider
 * protocol (DEV-GAPS-33, protocol-shape fix DEV-GAPS-42A/F1-1, RPC bridge
 * F1-2, conflict UI moved to workbench core F1-3).
 *
 * Mirrors Cursor's `cursor-checkout` v0.0.1 ("Checkout provider for branch
 * migration operations", publisher anysphere, `activationEvents: ["*"]`,
 * `enabledApiProposals: ["cursor"]`, main `./dist/main`): on activation it
 * calls `vscode.cursor.registerCheckoutProvider(provider)` (minified:
 * `r.cursor.registerCheckoutProvider(i)` in `activate()`).
 *
 * Protocol shape (verbatim): `checkoutBranch(delegate, branchName,
 * { commitSha?, localOnly? }, token)` — the conflict delegate comes first.
 * The extension renders NO conflict UI itself: on a dirty tree it calls
 * `delegate.resolveConflict()`, which RPCs back to the main thread where
 * workbench core (`src/vs/workbench/contrib/checkout/`) shows the
 * stash/commit/discard/cancel QuickPick.
 *
 * The provider is the machine behind branch migration / local↔cloud handoff
 * (Agents Window "move to cloud", `/in-cloud`, cloud subagents): a hardened,
 * cancellation-aware git operation layer.
 */

import * as vscode from 'vscode';
import { CheckoutProviderImpl } from './checkoutProvider.js';
import { NodeGitRunner } from './nodeGitRunner.js';

export function activate(context: vscode.ExtensionContext): void {
	const provider = new CheckoutProviderImpl(new NodeGitRunner());
	// `vscode.cursor.registerCheckoutProvider` is a proposed API; the local
	// `vscode-proposed.d.ts` declares it. Guard at runtime anyway so the
	// extension degrades gracefully on hosts without the namespace.
	const cursorApi: typeof vscode.cursor | undefined = (vscode as unknown as { cursor?: typeof vscode.cursor }).cursor;
	if (cursorApi && typeof cursorApi.registerCheckoutProvider === 'function') {
		context.subscriptions.push(cursorApi.registerCheckoutProvider(provider));
	}
}

export function deactivate(): void {
	// The registration disposable (in context.subscriptions) unregisters the
	// provider on deactivation.
}
