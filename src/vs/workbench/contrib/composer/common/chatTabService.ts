/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// IDE-CODE: Migrated — vscode API → DI (2026-10-19).
//
// vscode API → core mapping used here:
//   vscode.EventEmitter            → Emitter (vs/base/common/event)
//   vscode.Disposable              → Disposable/IDisposable (vs/base/common/lifecycle)
//   vscode.window.showWarningMessage → INotificationService.warn
//   vscode.ExtensionContext        → DROPPED. Per-tab composers are supplied by an injected
//                                    IChatTabComposerFactory; the workbench contribution wiring
//                                    site constructs the real composer once ComposerDataService
//                                    is migrated (CAT-B, sibling agent).
//   HookService                    → owned by the composer factory, no longer referenced here.
//
// Wiring: construct via IInstantiationService at the contribution site, passing
// INotificationService plus a factory that builds the migrated composer.

import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable, IDisposable } from '../../../../base/common/lifecycle.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import type { ModeName } from './model.js';

/**
 * ChatTabService — real chat tabs (doc-gap B8, Cursor parity).
 *
 * Each tab owns a full composer: its own bubbles (history), mode,
 * message queue, checkpoints, approvals and engine session. Tabs run
 * independently — a turn in one tab does not block another.
 *
 * The webview shows one tab at a time (the active tab). The service forwards
 * composer events tagged with the originating tab id; hosts filter to the
 * active tab for transcript updates but listen to all tabs for tab-bar
 * state (running spinners) and tab-list changes.
 */

export interface ChatTab {
	id: string;
	title: string;
	composer: IChatTabComposer;
	createdAt: number;
}

export interface ChatTabState {
	id: string;
	title: string;
	active: boolean;
	running: boolean;
	queuedCount: number;
}

export interface IChatTabComposerEvent {
	readonly kind: string;
}

export interface IChatTabComposerBubbles {
	getAllInOrder(): Array<{ role: string; text?: string }>;
}

export interface IChatTabComposerModes {
	setMode(mode: ModeName): void;
	getMode(): ModeName;
}

/**
 * Structural surface the tab service needs from a per-tab composer.
 * Satisfied by the migrated ComposerDataService (CAT-B, sibling agent).
 */
export interface IChatTabComposer extends IDisposable {
	readonly onDidChange: Event<IChatTabComposerEvent>;
	readonly isRunning: boolean;
	readonly isDraining: boolean;
	readonly queue: { readonly length: number };
	readonly bubbles: IChatTabComposerBubbles;
	readonly modes: IChatTabComposerModes;
	newChat(): boolean;
}

/** Builds one composer per tab. Implemented by the contribution wiring site. */
export interface IChatTabComposerFactory {
	create(): IChatTabComposer;
}

export type ChatTabEvent =
	| { kind: 'tabsChanged' }
	| { kind: 'composerEvent'; tabId: string; event: IChatTabComposerEvent };

let tabSeq = 0;

/** Auto-title from the first user message (Cursor shows a summary-ish title). */
function titleFromText(text: string): string {
	const oneLine = text.replace(/\s+/g, ' ').trim();
	if (oneLine.length <= 28) {
		return oneLine || 'New chat';
	}
	return `${oneLine.slice(0, 28)}…`;
}

export class ChatTabService extends Disposable {
	private readonly tabs = new Map<string, ChatTab>();
	private activeId: string | undefined;
	private readonly emitter = new Emitter<ChatTabEvent>();
	readonly onDidChange: Event<ChatTabEvent> = this.emitter.event;
	private readonly tabRelays = new Map<string, IDisposable>();
	/**
	 * DEV-KEYBOARD-FIX: stack of recently closed tabs (Cursor "Reopen Last
	 * Closed Chat Tab", Ctrl+Shift+T parity). Only the mode + title survive —
	 * closeTab disposes the composer, so the transcript cannot be restored.
	 */
	private readonly closedStack: Array<{ mode: ModeName; title: string }> = [];

	constructor(
		private readonly notificationService: INotificationService,
		private readonly composerFactory: IChatTabComposerFactory,
	) {
		super();
		this._register(this.emitter);
		const first = this.createTab({ title: 'New chat' });
		this.activeId = first.id;
	}

	/**
	 * DEV-KEYBOARD-FIX: pop the most recently closed tab descriptor, if any.
	 * The caller recreates the tab (mode + title); the transcript is gone.
	 */
	popClosedTab(): { mode: ModeName; title: string } | undefined {
		return this.closedStack.pop();
	}

	/** The currently active tab. */
	get activeTab(): ChatTab {
		const tab = this.activeId ? this.tabs.get(this.activeId) : undefined;
		if (tab) {
			return tab;
		}
		// Defensive: never leave the UI without an active tab.
		const first = this.tabs.values().next().value as ChatTab | undefined;
		if (first) {
			this.activeId = first.id;
			return first;
		}
		const created = this.createTab({ title: 'New chat' });
		this.activeId = created.id;
		return created;
	}

	/** Shortcut for the active tab's composer (the transcript the UI shows). */
	get activeComposer(): IChatTabComposer {
		return this.activeTab.composer;
	}

	get tabCount(): number {
		return this.tabs.size;
	}

	listTabs(): ChatTab[] {
		return [...this.tabs.values()];
	}

	getTabStates(): ChatTabState[] {
		return this.listTabs().map((t) => ({
			id: t.id,
			title: t.title,
			active: t.id === this.activeId,
			running: t.composer.isRunning,
			queuedCount: t.composer.queue.length,
		}));
	}

	createTab(opts?: { title?: string; mode?: ModeName }): ChatTab {
		tabSeq += 1;
		const id = `tab-${tabSeq}`;
		const composer = this.composerFactory.create();
		if (opts?.mode) {
			composer.modes.setMode(opts.mode);
		}
		const tab: ChatTab = {
			id,
			title: opts?.title ?? 'New chat',
			composer,
			createdAt: Date.now(),
		};
		// Forward this tab's composer events, tagged with the tab id.
		// P2 (QA-CHATTABS-X1): tracked per tab so closeTab can dispose it.
		const relay = composer.onDidChange((event) => {
			// Auto-title: first human message sets the tab title.
			if (event.kind === 'bubblesChanged' && tab.title === 'New chat') {
				const humans = composer.bubbles
					.getAllInOrder()
					.filter((b) => b.role === 'human');
				const firstText = humans[0]?.text?.trim();
				if (firstText) {
					tab.title = titleFromText(firstText);
					this.emitter.fire({ kind: 'tabsChanged' });
				}
			}
			// P3 (QA-CHATTABS-X1): a cleared chat gets a fresh title — otherwise
			// the first message after newChat never re-titles the tab because the
			// auto-title above only fires when title === "New chat".
			if (event.kind === 'newChat' && tab.title !== 'New chat') {
				tab.title = 'New chat';
				this.emitter.fire({ kind: 'tabsChanged' });
			}
			this.emitter.fire({ kind: 'composerEvent', tabId: id, event });
		});
		this.tabRelays.set(id, relay);
		this._register(relay);
		this.tabs.set(id, tab);
		this.emitter.fire({ kind: 'tabsChanged' });
		return tab;
	}

	/** Create a tab and make it active (the "New Agent Chat" command). */
	createAndActivate(opts?: { title?: string; mode?: ModeName }): ChatTab {
		const tab = this.createTab(opts);
		this.activeId = tab.id;
		this.emitter.fire({ kind: 'tabsChanged' });
		return tab;
	}

	switchTab(id: string): boolean {
		if (!this.tabs.has(id) || id === this.activeId) {
			return false;
		}
		this.activeId = id;
		this.emitter.fire({ kind: 'tabsChanged' });
		return true;
	}

	nextTab(): ChatTab {
		const list = this.listTabs();
		const idx = list.findIndex((t) => t.id === this.activeId);
		const next = list[(idx + 1) % list.length]!;
		this.activeId = next.id;
		this.emitter.fire({ kind: 'tabsChanged' });
		return next;
	}

	previousTab(): ChatTab {
		const list = this.listTabs();
		const idx = list.findIndex((t) => t.id === this.activeId);
		const prev = list[(idx - 1 + list.length) % list.length]!;
		this.activeId = prev.id;
		this.emitter.fire({ kind: 'tabsChanged' });
		return prev;
	}

	renameTab(id: string, title: string): boolean {
		const tab = this.tabs.get(id);
		const clean = title.replace(/\s+/g, ' ').trim().slice(0, 60);
		if (!tab || clean.length === 0) {
			return false;
		}
		tab.title = clean;
		this.emitter.fire({ kind: 'tabsChanged' });
		return true;
	}

	/**
	 * Close a tab. Refuses while that tab's turn is running OR draining.
	 * Closing the last tab clears it instead (Cursor always keeps one chat open).
	 *
	 * P1-2 (QA-CHATTABS-01): the tab's composer is disposed — its sidecar
	 * `bun serve` is killed, no zombie processes.
	 * P2-6 (QA-CHATTABS-01): refusing while `isDraining` closes the ghost-turn
	 * hole — closeTab used to guard only isRunning, but the drain window has
	 * running === false while follow-up turns are about to start.
	 */
	async closeTab(id: string): Promise<boolean> {
		const tab = this.tabs.get(id);
		if (!tab) {
			return false;
		}
		if (tab.composer.isRunning || tab.composer.isDraining) {
			this.notificationService.warn(
				'IDE Agent: cannot close a chat tab while its turn is running — stop the turn first.',
			);
			return false;
		}
		if (this.tabs.size === 1) {
			// Last tab: clear it instead of closing (verified newChat semantics).
			return tab.composer.newChat();
		}
		// DEV-KEYBOARD-FIX: remember mode + title for ide.reopenChatTab
		// (Ctrl+Shift+T). Capped so the stack can't grow without bound.
		this.closedStack.push({ mode: tab.composer.modes.getMode(), title: tab.title });
		if (this.closedStack.length > 10) {
			this.closedStack.shift();
		}
		this.disposeTabRelay(id);
		tab.composer.dispose();
		this.tabs.delete(id);
		if (this.activeId === id) {
			this.activeId = this.listTabs()[0]!.id;
		}
		this.emitter.fire({ kind: 'tabsChanged' });
		return true;
	}

	/** P2 (QA-CHATTABS-X1): dispose a tab's event relay so it can be GC'd. */
	private disposeTabRelay(id: string): void {
		const relay = this.tabRelays.get(id);
		if (relay) {
			this.tabRelays.delete(id);
			relay.dispose();
		}
	}

	override dispose(): void {
		// P1-2 (QA-CHATTABS-01): dispose every tab's composer (kills sidecars).
		for (const tab of this.tabs.values()) {
			this.disposeTabRelay(tab.id);
			try {
				tab.composer.dispose();
			} catch {
				/* dispose must never throw */
			}
		}
		this.tabs.clear();
		super.dispose();
	}
}
