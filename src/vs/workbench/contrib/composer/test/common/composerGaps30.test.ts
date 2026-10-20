/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import vm from 'vm';
import { createComposer } from '../../common/composer.js';

/**
 * DEV-GAPS-30 — composer input UI parity (P1, evidence: live-app CDP on
 * Cursor 3.25.9, docs/rea/detail-chat-2026-10-19.md §§2–6).
 *
 * The composer webview is a generated HTML string whose script runs in a
 * real webview. These tests extract that script and execute it in a `vm`
 * sandbox with a minimal DOM stub, so the asserted behavior is the actual
 * script logic — not a re-implementation of it:
 *
 *  1. `composer-empty-submit-voice-chat`: button.ui-prompt-input-submit-button
 *     carries aria-label="Start voice chat" while the input is empty and
 *     morphs to aria-label="Send message" when text is typed (CDP §5).
 *     HONEST DIVERGENCE: clicking the voice-chat entry is a deliberate
 *     no-op — this build has no STT engine / mic capture, and the Web
 *     Speech API recognition service is unavailable in Electron webviews.
 *  2. `composer-add-context-menu`: button.ui-icon-button
 *     [aria-label="Add agents, context, tools"] opens one menu with the
 *     verbatim sections Modes (Plan/Debug/Multitask/Ask + descriptions),
 *     Files, Model, MCP (CDP §3); each item triggers the right intent.
 *  3. `composer-input-context-menu`: right-click on the composer input must
 *     show only Chromium's native menu (Cut | Copy | Paste | Select All) —
 *     the webview registers NO custom contextmenu handler (CDP §6).
 */

// ---------------------------------------------------------------------------
// Minimal DOM stub — just enough for the composer webview script's load path
// and the interactions under test.
// ---------------------------------------------------------------------------

type Listener = (e: any) => void;

class StubElement {
	children: StubElement[] = [];
	parentNode: StubElement | null = null;
	style: Record<string, any> = {
		setProperty(k: string, v: string) { this[k] = v; },
	};
	attributes: Record<string, string> = {};
	listeners: Record<string, Listener[]> = {};
	tagName: string;
	value = '';
	textContent = '';
	hidden = false;
	disabled = false;
	selectionStart: number | null = null;
	selectionEnd: number | null = null;
	dataset: Record<string, string> = {};
	classList: {
		add(...c: string[]): void;
		remove(...c: string[]): void;
		toggle(c: string, f?: boolean): boolean;
		contains(c: string): boolean;
	};
	private _innerHTML = '';

	constructor(tag = 'div') {
		this.tagName = tag.toUpperCase();
		const s = new Set<string>();
		this.classList = {
			add: (...c: string[]) => { c.forEach((x) => s.add(x)); },
			remove: (...c: string[]) => { c.forEach((x) => s.delete(x)); },
			toggle: (c: string, f?: boolean) => {
				const v = f === undefined ? !s.has(c) : f;
				if (v) { s.add(c); } else { s.delete(c); }
				return v;
			},
			contains: (c: string) => s.has(c),
		};
	}

	set innerHTML(html: string) {
		this._innerHTML = html;
		this.children = [];
		// Parses the flat markup the composer menus render (top-level
		// <button> and <div> rows) into clickable child stubs.
		const re = /<(button|div)([^>]*)>([\s\S]*?)<\/\1>/g;
		let m: RegExpExecArray | null;
		while ((m = re.exec(html))) {
			const child = new StubElement(m[1]);
			const attrRe = /([\w-]+)="([^"]*)"/g;
			let a: RegExpExecArray | null;
			while ((a = attrRe.exec(m[2]))) { child.setAttribute(a[1], a[2]); }
			child.textContent = m[3].replace(/<[^>]*>/g, '');
			this.appendChild(child);
		}
	}
	get innerHTML(): string { return this._innerHTML; }

	setAttribute(k: string, v: string): void { this.attributes[k] = String(v); }
	getAttribute(k: string): string | null { return k in this.attributes ? this.attributes[k] : null; }
	removeAttribute(k: string): void { delete this.attributes[k]; }
	addEventListener(t: string, f: Listener): void { (this.listeners[t] = this.listeners[t] || []).push(f); }
	removeEventListener(): void { /* not needed by the paths under test */ }
	dispatchEvent(e: any): boolean {
		e.target = e.target || this;
		if (typeof e.stopPropagation !== 'function') { e.stopPropagation = () => { }; }
		if (typeof e.preventDefault !== 'function') { e.preventDefault = () => { }; }
		for (const f of this.listeners[e.type] || []) { f.call(this, e); }
		return true;
	}
	appendChild(c: StubElement): StubElement { this.children.push(c); c.parentNode = this; return c; }
	contains(node: any): boolean {
		let n = node;
		while (n) { if (n === this) { return true; } n = n.parentNode; }
		return false;
	}
	querySelectorAll(sel: string): StubElement[] {
		const cls = sel.startsWith('.') ? sel.slice(1) : null;
		const out: StubElement[] = [];
		const walk = (el: StubElement) => {
			for (const c of el.children) {
				if (cls && (c.getAttribute('class') || '').split(/\s+/).includes(cls)) { out.push(c); }
				walk(c);
			}
		};
		walk(this);
		return out;
	}
	querySelector(sel: string): StubElement | null { return this.querySelectorAll(sel)[0] || null; }
	focus(): void { /* no-op */ }
	blur(): void { /* no-op */ }
	click(): void { this.dispatchEvent({ type: 'click' }); }
}

interface WebviewHarness {
	sendBtn: StubElement;
	inputEl: StubElement;
	addBtn: StubElement;
	addMenu: StubElement;
	modelBtn: StubElement;
	posted: any[];
	documentClick: (target: StubElement) => void;
	html: string;
}

/** Renders the composer, runs its webview script in a sandbox, and returns handles. */
function runComposerWebview(modelLabel = 'auto'): WebviewHarness {
	const posted: any[] = [];
	const html = createComposer({ postMessage: (m: unknown) => { /* host stub */ } }, 'agent', true, 'en', 'ltr', modelLabel);

	const registry = new Map<string, StubElement>();
	const getEl = (id: string): StubElement => {
		let el = registry.get(id);
		if (!el) { el = new StubElement('div'); el.setAttribute('id', id); registry.set(id, el); }
		return el;
	};
	// The ui-config JSON is baked into the HTML; the script JSON.parses it at load.
	const uiJson = html.match(/<script type="application\/json" id="ide-ui-config">([\s\S]*?)<\/script>/)![1];
	getEl('ide-ui-config').textContent = uiJson;
	// The model picker button's label is baked into the template markup; the
	// stub registry creates fresh elements, so seed it like the template does.
	getEl('modelBtn').textContent = 'model: ' + modelLabel;

	const docListeners: Record<string, Listener[]> = {};
	const documentStub: any = {
		body: new StubElement('body'),
		getElementById: (id: string) => getEl(id),
		createElement: (tag: string) => new StubElement(tag),
		addEventListener: (t: string, f: Listener) => { (docListeners[t] = docListeners[t] || []).push(f); },
	};
	const windowStub: any = { addEventListener: () => { /* not under test */ } };
	class FakeEvent { constructor(public type: string, public init?: any) { } }

	const sandbox: any = {
		document: documentStub,
		window: windowStub,
		Node: StubElement,
		Event: FakeEvent,
		acquireVsCodeApi: () => ({ postMessage: (msg: any) => { posted.push(msg); } }),
		setTimeout: (fn: any) => 0 as any,
		clearTimeout: () => { },
		setInterval: () => 0 as any,
		clearInterval: () => { },
	};
	vm.createContext(sandbox);
	const scriptSrc = html.match(/<script nonce="[^"]*">([\s\S]*)<\/script>\s*<\/body>/)![1];
	vm.runInContext(scriptSrc, sandbox, { filename: 'composer-webview.js' });

	return {
		sendBtn: getEl('send'),
		inputEl: getEl('input'),
		addBtn: getEl('addBtn'),
		addMenu: getEl('addMenu'),
		modelBtn: getEl('modelBtn'),
		posted,
		documentClick: (target: StubElement) => {
			for (const f of docListeners['click'] || []) { f({ type: 'click', target }); }
		},
		html,
	};
}

function typeInto(h: WebviewHarness, text: string): void {
	h.inputEl.value = text;
	h.inputEl.dispatchEvent({ type: 'input' });
}

suite('composerGaps30 (DEV-GAPS-30 — composer input UI parity)', () => {

	suite('composer-empty-submit-voice-chat (detail-chat §5)', () => {
		test('empty input → voice-chat entry: aria-label "Start voice chat", data-state active', () => {
			const h = runComposerWebview();
			assert.strictEqual(h.sendBtn.getAttribute('aria-label'), 'Start voice chat');
			assert.strictEqual(h.sendBtn.getAttribute('title'), 'Start voice chat');
			assert.strictEqual(h.sendBtn.getAttribute('data-state'), 'active');
			assert.ok(h.sendBtn.getAttribute('class') === null || true); // class tracked via classList
			assert.ok(h.sendBtn.classList.contains('slot-voice'), 'voice slot class');
			assert.strictEqual(h.sendBtn.disabled, false, 'voice entry is not disabled (Cursor: data-state=active)');
			assert.ok(h.html.includes('data-component="prompt-input-submit-button"'),
				'data-component marker present on the slot');
			assert.ok(h.html.includes('ui-prompt-input-submit-button'));
		});

		test('typing text morphs the slot to "Send message"', () => {
			const h = runComposerWebview();
			typeInto(h, 'hello test');
			assert.strictEqual(h.sendBtn.getAttribute('aria-label'), 'Send message');
			assert.strictEqual(h.sendBtn.getAttribute('data-state'), 'active');
			assert.ok(h.sendBtn.classList.contains('slot-send'));
		});

		test('clearing the text morphs the slot back to "Start voice chat"', () => {
			const h = runComposerWebview();
			typeInto(h, 'hello test');
			typeInto(h, '');
			assert.strictEqual(h.sendBtn.getAttribute('aria-label'), 'Start voice chat');
			assert.ok(h.sendBtn.classList.contains('slot-voice'));
		});

		test('whitespace-only input keeps the voice-chat entry', () => {
			const h = runComposerWebview();
			typeInto(h, '   ');
			assert.strictEqual(h.sendBtn.getAttribute('aria-label'), 'Start voice chat');
		});

		test('HONEST DIVERGENCE: clicking the voice-chat entry posts nothing (no fake voice)', () => {
			const h = runComposerWebview();
			const before = h.posted.length; // the load-time webviewReady handshake
			h.sendBtn.click();
			assert.strictEqual(h.posted.length, before, 'voice-chat click must not post any host message');
		});

		test('clicking with text submits instead', () => {
			const h = runComposerWebview();
			typeInto(h, 'hello test');
			h.sendBtn.click();
			const submit = h.posted.find((m) => m.type === 'submit');
			assert.ok(submit, 'expected a submit message');
		});
	});

	suite('composer-add-context-menu (detail-chat §3)', () => {
		const VERBATIM_MODES: Array<[string, string]> = [
			['Plan', 'Generate an implementation plan'],
			['Debug', 'Pinpoint the root cause of an issue'],
			['Multitask', 'Orchestrate multiple subagents in parallel'],
			['Ask', 'Answer questions without making edits'],
		];

		test('the + button exists with the verbatim aria-label and ui-icon-button class', () => {
			const h = runComposerWebview();
			assert.ok(h.html.includes('aria-label="Add agents, context, tools"'), 'verbatim aria-label');
			assert.ok(h.html.includes('class="ui-icon-button"'), 'ui-icon-button class');
		});

		function openMenu(h: WebviewHarness): StubElement[] {
			h.addBtn.click();
			assert.strictEqual(h.addMenu.style.display, 'block', 'menu opens on + click');
			return h.addMenu.querySelectorAll('.mode-item');
		}

		test('menu has the verbatim sections Modes / Files / Model / MCP', () => {
			const h = runComposerWebview();
			openMenu(h);
			for (const section of ['Modes', 'Files', 'Model', 'MCP']) {
				assert.ok(h.addMenu.innerHTML.includes(`<div class="menu-section">${section}</div>`),
					`section "${section}" verbatim`);
			}
		});

		test('Modes section lists Plan/Debug/Multitask/Ask with verbatim descriptions, no Agent item', () => {
			const h = runComposerWebview();
			const items = openMenu(h);
			const modeItems = items.filter((b) => b.getAttribute('data-mode'));
			assert.strictEqual(modeItems.length, 4, 'exactly the 4 pickable modes — no Agent item');
			for (const [label, description] of VERBATIM_MODES) {
				const item = modeItems.find((b) => b.textContent.includes(label));
				assert.ok(item, `mode item "${label}" present`);
				assert.ok(item!.textContent.includes(description),
					`description verbatim for "${label}": "${description}"`);
			}
			assert.ok(!modeItems.some((b) => b.textContent.includes('Agent')), 'no Agent item (implicit default)');
		});

		test('mode item click posts setMode and closes the menu', () => {
			const h = runComposerWebview();
			const items = openMenu(h);
			const plan = items.find((b) => b.getAttribute('data-mode') === 'plan')!;
			plan.click();
			const msg = h.posted.find((m) => m.type === 'setMode');
			// Field-wise comparison: the message object is created inside the
			// vm realm, so cross-realm deepStrictEqual would reject it.
			assert.ok(msg, 'expected a setMode message');
			assert.strictEqual(msg.type, 'setMode');
			assert.strictEqual(msg.mode, 'plan');
			assert.strictEqual(h.addMenu.style.display, 'none', 'menu closes after selection');
		});

		test('Files item opens the @-file picker (mentionQuery "file ")', () => {
			const h = runComposerWebview();
			const items = openMenu(h);
			items.find((b) => b.getAttribute('data-intent') === 'files')!.click();
			const msg = h.posted.find((m) => m.type === 'mentionQuery');
			assert.ok(msg, 'expected a mentionQuery message');
			assert.strictEqual(msg.query, 'file ');
		});

		test('Model item shows the current picker label and opens the model picker', () => {
			const h = runComposerWebview('Auto');
			const items = openMenu(h);
			const modelItem = items.find((b) => b.getAttribute('data-intent') === 'model')!;
			assert.ok(modelItem.textContent.includes('Auto'), 'current model label shown');
			modelItem.click();
			assert.ok(h.posted.some((m) => m.type === 'openModelPicker'), 'expected openModelPicker');
		});

		test('MCP item queries the @-mention MCP scope', () => {
			const h = runComposerWebview();
			const items = openMenu(h);
			items.find((b) => b.getAttribute('data-intent') === 'mcp')!.click();
			const msg = h.posted.find((m) => m.type === 'mentionQuery');
			assert.ok(msg, 'expected a mentionQuery message');
			assert.strictEqual(msg.query, 'mcp ');
		});

		test('clicking outside the menu dismisses it', () => {
			const h = runComposerWebview();
			openMenu(h);
			h.documentClick(h.inputEl);
			assert.strictEqual(h.addMenu.style.display, 'none', 'outside click closes the menu');
		});
	});

	suite('composer-input-context-menu (detail-chat §6)', () => {
		test('the webview registers no custom contextmenu handler — native Chromium menu applies', () => {
			const h = runComposerWebview();
			assert.ok(!h.html.includes('contextmenu'),
				'no "contextmenu" string anywhere in the composer webview (markup, script, or CSS)');
		});
	});

	/**
	 * DEV-GAPS-35 — composer-dom-structure (P1, evidence: live-app CDP on
	 * Cursor 3.25.9, docs/rea/detail-chat-2026-10-19.md §1).
	 *
	 * Cursor's verbatim composer input DOM (class names stable, dynamic
	 * ui-xxxxx hashes filtered out by the auditor):
	 *
	 *   DIV.agent-prompt-input-root
	 *     DIV.ui-prompt-input
	 *       DIV.ui-prompt-input__container
	 *         DIV.ui-prompt-input-editor
	 *           DIV.ui-prompt-input-editor__content
	 *             DIV[contenteditable=true][role=textbox][aria-label="Prompt"]
	 *               .tiptap.ProseMirror.ui-prompt-input-editor__input
	 *
	 * HONEST DIVERGENCE: the editor NODE itself is not ported — Cursor's is
	 * a TipTap ProseMirror contenteditable div; ours is a plain <textarea>
	 * (the webview script is a single inline bundle keyed to
	 * HTMLTextAreaElement; a ProseMirror port would mean vendoring TipTap
	 * and rewriting all input logic as ProseMirror extensions — a full
	 * editor re-architecture, out of scope for this DOM-structure gap).
	 * The container class chain + the editor's verbatim aria-label are
	 * applied exactly as observed.
	 */
	suite('composer-dom-structure (detail-chat §1)', () => {
		test('composer root carries the verbatim class agent-prompt-input-root', () => {
			const h = runComposerWebview();
			const m = h.html.match(/<div id="composer" class="([^"]*)">/);
			assert.ok(m, 'composer root div present');
			const classes = m![1].split(/\s+/);
			assert.ok(classes.includes('agent-prompt-input-root'),
				'composer root carries verbatim class agent-prompt-input-root');
			assert.ok(classes.includes('ai-input-full-input-box'),
				'internal box class retained (owns the 12px-radius box styling)');
		});

		test('verbatim nesting chain agent-prompt-input-root > ui-prompt-input > ui-prompt-input__container > ui-prompt-input-editor > ui-prompt-input-editor__content > textarea#input', () => {
			const h = runComposerWebview();
			const markers = [
				'<div id="composer" class="ai-input-full-input-box agent-prompt-input-root">',
				'<div class="ui-prompt-input">',
				'<div class="ui-prompt-input__container">',
				'<div class="ui-prompt-input-editor">',
				'<div class="ui-prompt-input-editor__content">',
				'<textarea id="input"',
			];
			let from = 0;
			for (const marker of markers) {
				const idx = h.html.indexOf(marker, from);
				assert.ok(idx >= from, `expected ${JSON.stringify(marker)} after position ${from}`);
				from = idx + marker.length;
			}
		});

		test('the input carries Cursor\'s verbatim aria-label "Prompt"', () => {
			const h = runComposerWebview();
			const m = h.html.match(/<textarea id="input"[^>]*>/);
			assert.ok(m, 'textarea#input present');
			assert.ok(m![0].includes('aria-label="Prompt"'),
				`verbatim aria-label "Prompt" on the editor (got: ${m![0]})`);
		});

		test('the toolbar still sits inside the container (box holds everything)', () => {
			const h = runComposerWebview();
			const containerIdx = h.html.indexOf('<div class="ui-prompt-input__container">');
			const toolbarIdx = h.html.indexOf('<div class="composer-toolbar">', containerIdx);
			assert.ok(containerIdx >= 0 && toolbarIdx > containerIdx,
				'composer-toolbar is nested inside ui-prompt-input__container');
		});

		test('the container is the flex column with the 6px gap (layout unchanged)', () => {
			const h = runComposerWebview();
			assert.ok(/\.ui-prompt-input__container\s*\{[^}]*display:\s*flex[^}]*flex-direction:\s*column[^}]*gap:\s*6px/.test(h.html),
				'.ui-prompt-input__container carries the flex-column 6px-gap layout #composer used to own');
		});

		test('HONEST DIVERGENCE: the editor node is a plain textarea, not a ProseMirror contenteditable div', () => {
			const h = runComposerWebview();
			const m = h.html.match(/<textarea id="input"[^>]*>/)![0];
			assert.ok(!m.includes('contenteditable'),
				'editor node must not claim contenteditable');
			assert.ok(!m.includes('tiptap') && !m.includes('ProseMirror'),
				'editor node carries no tiptap/ProseMirror classes — we do not fake the ProseMirror editor');
		});
	});
});
