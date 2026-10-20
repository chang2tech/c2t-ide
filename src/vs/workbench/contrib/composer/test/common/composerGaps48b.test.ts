/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import vm from 'vm';
import { createComposer, shouldShowMicWhileRunning } from '../../common/composer.js';

/**
 * DEV-GAPS-48B — multitask follow-up voice toolbar (P1, missing feature,
 * strong binary evidence: auditor run 31, 2026-10-20 06:07).
 *
 * Binary truth (Cursor 3.25.9, workbench.glass.main.js @ byte 29760461,
 * module "voice-toolbar-follow-up-while-running.js", re-verified 2026-10-20):
 * ```
 * function bmC(t){return t.forceMicWhileRunning===!0||t.composerUnifiedMode==="multitask"?!0:t.queueDefaultBehavior==="queue"||t.queueDefaultBehavior==="send"||t.queueDefaultBehavior==="steer"}
 * ```
 * Call site (~29846937): Vf=xL(()=>bmC({forceMicWhileRunning:Pe,
 * composerUnifiedMode:nh /* = composerDataHandle.data.unifiedMode *\/,
 * queueDefaultBehavior:Em}),[Pe,nh,Em]); the result feeds the
 * follow-up-while-running voice toolbar as `showMicWhileRunning:Vf`
 * (~29865328, alongside onStopClick/onMicClick/isProcessing).
 *
 * Behavior: in multitask mode the follow-up-while-running input ALWAYS
 * shows the voice toolbar (mic) instead of the queue/send/steer message
 * buttons. The fork has no queueDefaultBehavior / forceMicWhileRunning
 * (0 hits each, verified 2026-10-20), so those inputs are absent → the
 * fork's decision reduces to `composerUnifiedMode === "multitask"`.
 *
 * These tests cover:
 *  A. the truth table of the ported decision function (direct TS import);
 *  B. that the exact function source injected into the webview behaves
 *     identically (single-source-of-truth guard);
 *  C. the webview wiring: mic button visible only while a turn runs in
 *     multitask mode, stop slot untouched, mic click a deliberate no-op
 *     (HONEST DIVERGENCE: no STT engine / mic capture in this build).
 */

// ---------------------------------------------------------------------------
// A. Truth table — direct port of bmC
// ---------------------------------------------------------------------------

suite('gaps48b: shouldShowMicWhileRunning truth table (bmC port)', () => {
	test('forceMicWhileRunning=true forces the mic regardless of mode', () => {
		assert.strictEqual(shouldShowMicWhileRunning({ forceMicWhileRunning: true, composerUnifiedMode: 'agent' }), true);
		assert.strictEqual(shouldShowMicWhileRunning({ forceMicWhileRunning: true, composerUnifiedMode: 'multitask' }), true);
		assert.strictEqual(shouldShowMicWhileRunning({ forceMicWhileRunning: true }), true);
	});

	test('multitask mode ALWAYS shows the mic (queueDefaultBehavior unset)', () => {
		assert.strictEqual(shouldShowMicWhileRunning({ composerUnifiedMode: 'multitask' }), true);
	});

	test('multitask wins even with forceMicWhileRunning=false', () => {
		assert.strictEqual(shouldShowMicWhileRunning({ forceMicWhileRunning: false, composerUnifiedMode: 'multitask' }), true);
	});

	test('queue/send/steer behaviors show the mic in non-multitask modes', () => {
		for (const mode of ['agent', 'plan', 'debug', 'chat']) {
			assert.strictEqual(shouldShowMicWhileRunning({ composerUnifiedMode: mode, queueDefaultBehavior: 'queue' }), true, mode);
			assert.strictEqual(shouldShowMicWhileRunning({ composerUnifiedMode: mode, queueDefaultBehavior: 'send' }), true, mode);
			assert.strictEqual(shouldShowMicWhileRunning({ composerUnifiedMode: mode, queueDefaultBehavior: 'steer' }), true, mode);
		}
	});

	test('non-multitask + unset queueDefaultBehavior → no mic (queue/send/steer buttons instead)', () => {
		for (const mode of ['agent', 'plan', 'debug', 'chat', undefined]) {
			assert.strictEqual(shouldShowMicWhileRunning({ composerUnifiedMode: mode }), false, String(mode));
		}
		assert.strictEqual(shouldShowMicWhileRunning({}), false, 'empty opts');
	});

	test('unrecognized queueDefaultBehavior values → no mic', () => {
		assert.strictEqual(shouldShowMicWhileRunning({ composerUnifiedMode: 'agent', queueDefaultBehavior: 'stop-and-send' }), false);
		assert.strictEqual(shouldShowMicWhileRunning({ composerUnifiedMode: 'agent', queueDefaultBehavior: '' }), false);
	});

	test('fork mapping: absent forceMic/queueBehavior in multitask → mic; in agent → no mic', () => {
		// The fork has neither setting (0 hits each); absent ≡ false/unset.
		assert.strictEqual(shouldShowMicWhileRunning({ composerUnifiedMode: 'multitask' }), true);
		assert.strictEqual(shouldShowMicWhileRunning({ composerUnifiedMode: 'agent' }), false);
	});
});

// ---------------------------------------------------------------------------
// B. Injected webview copy behaves identically (single-source guard)
// ---------------------------------------------------------------------------

/** Extracts the injected `shouldShowMicWhileRunning` source from built HTML and evaluates it. */
function injectedDecisionFn(html: string): (opts: any) => boolean {
	const m = html.match(/var shouldShowMicWhileRunning = (function shouldShowMicWhileRunning[\s\S]*?\n\});/);
	assert.ok(m, 'injected shouldShowMicWhileRunning source not found in webview HTML');
	return vm.runInNewContext('(' + m[1] + ')', {}, { filename: 'injected-bmc.js' });
}

suite('gaps48b: webview-injected decision function matches the TS source', () => {
	const cases: Array<[any, boolean]> = [
		[{ forceMicWhileRunning: true, composerUnifiedMode: 'agent' }, true],
		[{ composerUnifiedMode: 'multitask' }, true],
		[{ forceMicWhileRunning: false, composerUnifiedMode: 'multitask' }, true],
		[{ composerUnifiedMode: 'agent', queueDefaultBehavior: 'queue' }, true],
		[{ composerUnifiedMode: 'agent', queueDefaultBehavior: 'send' }, true],
		[{ composerUnifiedMode: 'plan', queueDefaultBehavior: 'steer' }, true],
		[{ composerUnifiedMode: 'agent' }, false],
		[{ composerUnifiedMode: 'debug' }, false],
		[{}, false],
		[{ composerUnifiedMode: 'agent', queueDefaultBehavior: 'stop-and-send' }, false],
	];
	for (const [opts, expected] of cases) {
		test(`injected fn ${JSON.stringify(opts)} → ${expected}`, () => {
			const html = createComposer({ postMessage: () => { /* host stub */ } }, 'agent', true);
			const injected = injectedDecisionFn(html);
			assert.strictEqual(injected(opts), expected, 'injected copy diverged from TS source');
			assert.strictEqual(injected(opts), shouldShowMicWhileRunning(opts), 'injected copy must equal TS export');
		});
	}
});

// ---------------------------------------------------------------------------
// C. Webview wiring — minimal DOM stub + captured window message listener
// ---------------------------------------------------------------------------

type Listener = (e: any) => void;

class StubElement {
	children: StubElement[] = [];
	parentNode: StubElement | null = null;
	style: Record<string, any> = {};
	attributes: Record<string, string> = {};
	listeners: Record<string, Listener[]> = {};
	tagName: string;
	value = '';
	textContent = '';
	hidden = false;
	disabled = false;
	dataset: Record<string, string> = {};
	classList: {
		add(...c: string[]): void;
		remove(...c: string[]): void;
		toggle(c: string, f?: boolean): boolean;
		contains(c: string): boolean;
	};

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

	setAttribute(k: string, v: string): void { this.attributes[k] = String(v); }
	getAttribute(k: string): string | null { return k in this.attributes ? this.attributes[k] : null; }
	removeAttribute(k: string): void { delete this.attributes[k]; }
	addEventListener(t: string, f: Listener): void { (this.listeners[t] = this.listeners[t] || []).push(f); }
	dispatchEvent(e: any): boolean {
		for (const f of this.listeners[e.type] || []) { f.call(this, e); }
		return true;
	}
	appendChild(c: StubElement): StubElement { this.children.push(c); c.parentNode = this; return c; }
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
	click(): void { this.dispatchEvent({ type: 'click' }); }
}

interface Harness {
	micBtn: StubElement;
	sendBtn: StubElement;
	posted: any[];
	hostMessage: (msg: any) => void;
	html: string;
}

/** Renders the composer and runs its webview script, capturing window message listeners. */
function runWebview(initialMode: 'agent' | 'multitask' = 'agent'): Harness {
	const posted: any[] = [];
	const html = createComposer({ postMessage: (m: unknown) => { /* host stub */ } }, initialMode, true);
	const registry = new Map<string, StubElement>();
	const getEl = (id: string): StubElement => {
		let el = registry.get(id);
		if (!el) { el = new StubElement('div'); el.setAttribute('id', id); registry.set(id, el); }
		return el;
	};
	const uiJson = html.match(/<script type="application\/json" id="ide-ui-config">([\s\S]*?)<\/script>/)![1];
	getEl('ide-ui-config').textContent = uiJson;
	getEl('modelBtn').textContent = 'model: auto';

	const windowListeners: Record<string, Listener[]> = {};
	const sandbox: any = {
		document: {
			body: new StubElement('body'),
			getElementById: (id: string) => getEl(id),
			createElement: (tag: string) => new StubElement(tag),
			addEventListener: () => { /* not under test */ },
		},
		window: {
			addEventListener: (t: string, f: Listener) => { (windowListeners[t] = windowListeners[t] || []).push(f); },
		},
		acquireVsCodeApi: () => ({ postMessage: (msg: any) => { posted.push(msg); } }),
		setTimeout: () => 0 as any,
		clearTimeout: () => { },
		setInterval: () => 0 as any,
		clearInterval: () => { },
	};
	vm.createContext(sandbox);
	const scriptSrc = html.match(/<script nonce="[^"]*">([\s\S]*)<\/script>\s*<\/body>/)![1];
	vm.runInContext(scriptSrc, sandbox, { filename: 'composer-webview.js' });

	return {
		micBtn: getEl('voiceWhileRunning'),
		sendBtn: getEl('send'),
		posted,
		hostMessage: (msg: any) => {
			for (const f of windowListeners['message'] || []) { f({ data: msg }); }
		},
		html,
	};
}

suite('gaps48b: follow-up-while-running voice toolbar wiring', () => {
	test('mic button exists with the voice entry tokens and starts hidden', () => {
		const h = runWebview();
		assert.ok(h.html.includes('id="voiceWhileRunning"'), 'button present in HTML');
		assert.ok(h.html.includes('data-component="voice-toolbar-follow-up-while-running"'), 'Cursor module marker');
		assert.ok(h.html.includes('aria-label="Start voice chat"'), 'voice entry aria-label');
		assert.ok(h.html.includes('id="voiceWhileRunning"') && h.html.includes('style="display:none"'), 'initially hidden');
	});

	test('agent mode + turn running → mic stays hidden, stop slot owns the submit slot', () => {
		const h = runWebview('agent');
		h.hostMessage({ type: 'turnState', running: true });
		assert.strictEqual(h.micBtn.style.display, 'none', 'no mic in agent mode while running');
		assert.strictEqual(h.sendBtn.getAttribute('aria-label'), 'Stop generation', 'stop slot unchanged');
	});

	test('multitask mode + turn running → mic shown (bmC: multitask always forces showMicWhileRunning)', () => {
		const h = runWebview('agent');
		h.hostMessage({ type: 'mode', mode: 'multitask' });
		h.hostMessage({ type: 'turnState', running: true });
		assert.strictEqual(h.micBtn.style.display, 'inline-flex', 'mic visible while a multitask turn runs');
		assert.strictEqual(h.sendBtn.getAttribute('aria-label'), 'Stop generation',
			'stop control is NOT removed — Cursor keeps onStopClick wired in this state');
	});

	test('mode baked as multitask at render → mic shown on turn start', () => {
		const h = runWebview('multitask');
		h.hostMessage({ type: 'turnState', running: true });
		assert.strictEqual(h.micBtn.style.display, 'inline-flex');
	});

	test('switching to multitask mid-turn reveals the mic; switching away hides it', () => {
		const h = runWebview('agent');
		h.hostMessage({ type: 'turnState', running: true });
		assert.strictEqual(h.micBtn.style.display, 'none');
		h.hostMessage({ type: 'mode', mode: 'multitask' });
		assert.strictEqual(h.micBtn.style.display, 'inline-flex', 'mid-turn mode switch updates the toolbar');
		h.hostMessage({ type: 'mode', mode: 'agent' });
		assert.strictEqual(h.micBtn.style.display, 'none');
	});

	test('turn end hides the mic again in multitask mode', () => {
		const h = runWebview('multitask');
		h.hostMessage({ type: 'turnState', running: true });
		assert.strictEqual(h.micBtn.style.display, 'inline-flex');
		h.hostMessage({ type: 'turnState', running: false });
		assert.strictEqual(h.micBtn.style.display, 'none');
		assert.strictEqual(h.sendBtn.getAttribute('aria-label'), 'Start voice chat', 'slot re-morphs to the idle voice entry');
	});

	test('HONEST DIVERGENCE: clicking the while-running mic posts nothing (no fake voice)', () => {
		const h = runWebview('multitask');
		h.hostMessage({ type: 'turnState', running: true });
		assert.strictEqual(h.micBtn.style.display, 'inline-flex');
		const before = h.posted.length; // the load-time webviewReady handshake
		h.micBtn.click();
		assert.strictEqual(h.posted.length, before, 'mic click must not post any host message');
	});

	test('clicking the stop slot while running still stops the turn in multitask mode', () => {
		const h = runWebview('multitask');
		h.hostMessage({ type: 'turnState', running: true });
		h.sendBtn.click();
		const stop = h.posted.find((m) => m.type === 'stopTurn');
		assert.ok(stop, 'stopTurn still reachable — the mic never replaces the stop control');
	});
});
