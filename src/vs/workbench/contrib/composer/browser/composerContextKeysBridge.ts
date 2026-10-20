/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// IDE-CODE: core-owned derivation of the `composer.*` context keys.
//
// P1 migration-dead-context-keys (2026-10-19): the `composer.*` context keys
// referenced by the keybinding `when` clauses in composerActions.ts
// (`composer.chatInputFocused`, `composer.inlineEditPending`,
// `composer.toolApprovalVisible`) were never set by anyone — the ide-agent
// extension only sets the legacy `ideAgent.*` keys from its webview host
// (extension.ts:3685 `ideAgent.chatInputFocused`, chatEditorProvider.ts:467,
// inlineEditService.ts:1354/1519 `ideAgent.inlineEditPending`,
// extension.ts:3854 `ideAgent.toolApprovalVisible`; grep confirms 0
// `composer.*` setContext hits in extensions/ide-agent/src). Result: 16
// keybindings were dead (e.g. Shift+Tab cycle mode).
//
// Cursor sets these keys in core (the composer UI is core-owned there).
// Until our chat webview migrates to core DOM, core cannot observe the chat
// input's DOM focus or the webview-rendered approval cards itself — so this
// module OWNS the canonical `composer.*` keys and derives them from the
// extension's authoritative `ideAgent.*` signals via the shared window
// context-key service. When the webview migration lands, the source moves to
// core focus tracking and this bridge is deleted. Do NOT have the extension
// set `composer.*` directly — single core-owned writer, like Cursor.

import { Disposable, IDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { IContextKey, IContextKeyService } from '../../../../platform/contextkey/common/contextkey.js';
import { ComposerContextKeys } from '../common/composerContextKeys.js';

/** Canonical core-owned key <- legacy extension-owned key. Exported for tests. */
export const LEGACY_CONTEXT_KEY_MIRRORS = [
	{ target: ComposerContextKeys.chatInputFocused, source: 'ideAgent.chatInputFocused' },
	// DEV-GAPS-119 (chat-jump-messages-kbd): prompt emptiness for the
	// jump-between-messages when-clause (binary `glassPromptInputEmpty`
	// conjunct). The chat webview posts {type:'inputEmpty'} on every edit;
	// both hosts (chatEditorProvider.ts, extension.ts ChatViewProvider)
	// setContext `ideAgent.chatInputEmpty`.
	{ target: ComposerContextKeys.chatInputEmpty, source: 'ideAgent.chatInputEmpty' },
	{ target: ComposerContextKeys.inlineEditPending, source: 'ideAgent.inlineEditPending' },
	{ target: ComposerContextKeys.toolApprovalVisible, source: 'ideAgent.toolApprovalVisible' },
	// DEV-GAPS-12 (agent-shell-approval-keyboard-flow): Cursor's
	// `composerShellToolPendingKeybindingsActive` /
	// `composerShellToolAllowlistShortcutActive` — the Enter/Shift+Enter/Esc
	// approval bindings only live while a shell-tool approval is pending.
	// Set by the ide-agent extension's approval subscription via `setContext`.
	{ target: ComposerContextKeys.shellToolPendingKeybindingsActive, source: 'ideAgent.shellToolPendingKeybindingsActive' },
	{ target: ComposerContextKeys.shellToolAllowlistShortcutActive, source: 'ideAgent.shellToolAllowlistShortcutActive' },
	// GAPS-14 (agent-shell-approval-keyboard-flow): running-state for the
	// `composer.cancelTerminalToolCall` Shift+Backspace binding. Set by the
	// ide-agent extension's TerminalService via `setContext`.
	{ target: ComposerContextKeys.terminalToolCallRunning, source: 'ideAgent.terminalToolCallRunning' },
] as const;

class ComposerContextKeyBridge extends Disposable {
	constructor(
		private readonly contextKeyService: IContextKeyService,
	) {
		super();
		const legacyKeys = new Set<string>(LEGACY_CONTEXT_KEY_MIRRORS.map(m => m.source));
		const bound: Array<{ key: IContextKey<boolean>; source: string }> = LEGACY_CONTEXT_KEY_MIRRORS.map(m => {
			const key = m.target.bindTo(this.contextKeyService);
			// IContextKey is not IDisposable in this fork — reset on dispose.
			this._register(toDisposable(() => key.reset()));
			return { key, source: m.source };
		});
		const sync = () => {
			for (const { key, source } of bound) {
				key.set(this.contextKeyService.getContextKeyValue(source) === true);
			}
		};
		sync(); // the extension may have set values before this bridge was created
		this._register(this.contextKeyService.onDidChangeContext(e => {
			if (e.affectsSome(legacyKeys)) {
				sync();
			}
		}));
	}
}

/**
 * Starts the core-owned `composer.*` <- legacy `ideAgent.*` context-key
 * bridge. Call once from the composer workbench contribution; the returned
 * disposable stops the bridge.
 */
export function startComposerContextKeyBridge(contextKeyService: IContextKeyService): IDisposable {
	return new ComposerContextKeyBridge(contextKeyService);
}
