/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import vm from 'vm';
import { createComposer } from '../../common/composer.js';
import type { ComposerUiConfig } from '../../common/composer.js';

/**
 * WORKER-GAPS-24C — tool call density (Cursor "Compact chat responses",
 * cursor.com/changelog/page/7): "Customize tool call density to control how
 * much of the agent's tool activity is shown in each response:
 *   - Compact: shows concise results with minimal tool traces
 *   - Balanced: includes important intermediate steps
 *   - Detailed: provides near-complete step-by-step context"
 *
 * Binary evidence (Cursor 3.25.6, workbench.glass.main.js):
 *  - config keys `cursor.composer.conversationDensity` (Glass Agent
 *    conversations, default "compact-all-grouped") and
 *    `cursor.composer.editorConversationDensity` (Editor Agent conversations,
 *    default "detailed"); enum ["compact-all-grouped","compact-ungrouped",
 *    "detailed"] with labels Compact / Balanced / Detailed.
 *  - UI: Settings → Appearance → Agent Conversations → "Tool Call Density".
 *  - normalizeDensity: known values pass through; "verbose"→"detailed",
 *    "minimal"→"compact-all-grouped", unknown→"compact-all-grouped";
 *    settings migration maps legacy "compact-shells"→"compact-ungrouped"
 *    (Balanced) and "compact-grouped"→"compact-all-grouped" (Compact).
 *  - Rendering: Compact groups ALL consecutive tool calls into one
 *    toggleable group (minimal traces); Balanced shows collapsed cards
 *    with no grouping (important intermediate steps); Detailed renders
 *    expanded cards with tool output visible (step-by-step).
 *
 * Like composerGaps30.test.ts, these tests extract the webview script from
 * createComposer() and execute it in a `vm` sandbox with a minimal DOM stub,
 * so the asserted behavior is the actual script logic — not a
 * re-implementation of it. The stub below extends the GAPS-30 stub with
 * lastElementChild / childElementCount / <pre> parsing, which the
 * tool-call rendering paths need.
 */

// ---------------------------------------------------------------------------
// Minimal DOM stub
// ---------------------------------------------------------------------------

type Listener = (e: any) => void;

class StubElement {
	children: StubElement[] = [];
	parentNode: StubElement | null = null;
	style: Record<string, any> = {
		setProperty(k: string, v: string) { this[k] = v; },
		getPropertyValue(k: string) { return this[k]; },
	};
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
	private _innerHTML = '';

	constructor(tag = 'div') {
		this.tagName = tag.toUpperCase();
		const read = (): Set<string> =>
			new Set((this.attributes['class'] || '').split(/\s+/).filter(Boolean));
		const write = (s: Set<string>) => { this.attributes['class'] = [...s].join(' '); };
		this.classList = {
			add: (...c: string[]) => { const s = read(); c.forEach((x) => s.add(x)); write(s); },
			remove: (...c: string[]) => { const s = read(); c.forEach((x) => s.delete(x)); write(s); },
			toggle: (c: string, f?: boolean) => {
				const s = read();
				const v = f === undefined ? !s.has(c) : f;
				if (v) { s.add(c); } else { s.delete(c); }
				write(s);
				return v;
			},
			contains: (c: string) => read().has(c),
		};
	}

	get className(): string { return this.attributes['class'] || ''; }
	set className(v: string) { this.attributes['class'] = String(v); }

	get lastElementChild(): StubElement | null {
		return this.children.length ? this.children[this.children.length - 1] : null;
	}
	get childElementCount(): number { return this.children.length; }

	set innerHTML(html: string) {
		this._innerHTML = html;
		this.children = [];
		// Parses the flat markup the tool-call cards render (top-level
		// <button>, <div> and <pre> rows) into child stubs.
		const re = /<(button|div|pre)([^>]*)>([\s\S]*?)<\/\1>/g;
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
		for (const f of this.listeners[e.type] || []) { f.call(this, e); }
		return true;
	}
	appendChild(c: StubElement): StubElement { this.children.push(c); c.parentNode = this; return c; }
	remove(): void {
		if (this.parentNode) {
			this.parentNode.children = this.parentNode.children.filter((c) => c !== this);
			this.parentNode = null;
		}
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

interface DensityHarness {
	body: StubElement;
	messagesEl: StubElement;
	fireMessage(msg: any): void;
	html: string;
}

const BASE_UI: ComposerUiConfig = {
	textSizeScale: 1,
	conversationDensity: 'compact-all-grouped',
	codeBlockWordWrap: false,
	showEmptyStateTips: true,
	fontSmoothingAntialiased: true,
	cmdPFilePicker: true,
};

/** Renders the composer, runs its webview script in a sandbox, returns handles. */
function runDensityWebview(ui: ComposerUiConfig): DensityHarness {
	const html = createComposer({ postMessage: () => { /* host stub */ } }, 'agent', true, 'en', 'ltr', 'auto', ui);

	const registry = new Map<string, StubElement>();
	const getEl = (id: string): StubElement => {
		let el = registry.get(id);
		if (!el) { el = new StubElement('div'); el.setAttribute('id', id); registry.set(id, el); }
		return el;
	};
	// The ui-config JSON is baked into the HTML; the script JSON.parses it at load.
	const uiJson = html.match(/<script type="application\/json" id="ide-ui-config">([\s\S]*?)<\/script>/)![1];
	getEl('ide-ui-config').textContent = uiJson;

	const windowListeners: Record<string, Listener[]> = {};
	const documentStub: any = {
		body: new StubElement('body'),
		getElementById: (id: string) => getEl(id),
		createElement: (tag: string) => new StubElement(tag),
		addEventListener: () => { /* not under test */ },
	};
	const windowStub: any = {
		addEventListener: (t: string, f: Listener) => { (windowListeners[t] = windowListeners[t] || []).push(f); },
	};

	const sandbox: any = {
		document: documentStub,
		window: windowStub,
		Node: StubElement,
		acquireVsCodeApi: () => ({ postMessage: () => { } }),
		setTimeout: () => 0 as any,
		clearTimeout: () => { },
		setInterval: () => 0 as any,
		clearInterval: () => { },
		CSS: { escape: (s: string) => String(s).replace(/[^a-zA-Z0-9_-]/g, '-') },
	};
	vm.createContext(sandbox);
	const scriptSrc = html.match(/<script nonce="[^"]*">([\s\S]*)<\/script>\s*<\/body>/)![1];
	vm.runInContext(scriptSrc, sandbox, { filename: 'composer-webview.js' });

	return {
		body: documentStub.body,
		messagesEl: getEl('messages'),
		fireMessage: (msg: any) => {
			for (const f of windowListeners['message'] || []) { f({ data: msg }); }
		},
		html,
	};
}

function toolCall(id: string, kind: string, outputPreview?: string) {
	return {
		toolCallId: id,
		kind,
		title: kind + ' ' + id,
		description: 'desc ' + id,
		status: 'done',
		outputPreview,
	};
}

function assistantBubbleWithTools(ids: Array<[string, string]>, outputPreview = 'out') {
	return {
		bubbleId: 'b1',
		role: 'assistant',
		text: 'did things',
		toolCalls: ids.map(([id, kind]) => toolCall(id, kind, outputPreview)),
	};
}

/** The .tool-calls container of the first (only) bubble. */
function toolsElOf(h: DensityHarness): StubElement {
	const bubble = h.messagesEl.querySelector('.msg');
	assert.ok(bubble, 'expected a rendered bubble');
	const tools = bubble.querySelector('.tool-calls');
	assert.ok(tools, 'expected a .tool-calls container');
	return tools;
}

suite('Tool call density (Cursor "Compact chat responses" parity)', () => {

	test('baked ui-config carries the host density (host→webview contract)', () => {
		const h = runDensityWebview({ ...BASE_UI, conversationDensity: 'detailed' });
		const baked = JSON.parse(h.html.match(/<script type="application\/json" id="ide-ui-config">([\s\S]*?)<\/script>/)![1]);
		assert.strictEqual(baked.conversationDensity, 'detailed');
	});

	test('legacy "compact-shells" migrates to Balanced (binary SNv map)', () => {
		const h = runDensityWebview({ ...BASE_UI, conversationDensity: 'compact-shells' as any });
		assert.ok(h.body.classList.contains('density-compact-ungrouped'), 'expected Balanced body class');
		assert.ok(!h.body.classList.contains('density-compact-all-grouped'), 'must not be Compact');
		assert.ok(!h.body.classList.contains('density-detailed'), 'must not be Detailed');
	});

	test('legacy "compact-grouped" migrates to Compact (binary SNv map)', () => {
		const h = runDensityWebview({ ...BASE_UI, conversationDensity: 'compact-grouped' as any });
		assert.ok(h.body.classList.contains('density-compact-all-grouped'), 'expected Compact body class');
	});

	test('"verbose"→Detailed, "minimal"→Compact, unknown→Compact (binary normalizeDensity)', () => {
		const h1 = runDensityWebview({ ...BASE_UI, conversationDensity: 'verbose' as any });
		assert.ok(h1.body.classList.contains('density-detailed'), 'verbose → Detailed');
		const h2 = runDensityWebview({ ...BASE_UI, conversationDensity: 'minimal' as any });
		assert.ok(h2.body.classList.contains('density-compact-all-grouped'), 'minimal → Compact');
		const h3 = runDensityWebview({ ...BASE_UI, conversationDensity: 'bogus-value' as any });
		assert.ok(h3.body.classList.contains('density-compact-all-grouped'), 'unknown → Compact fallback');
		assert.ok(!h3.body.classList.contains('density-detailed'));
		assert.ok(!h3.body.classList.contains('density-compact-ungrouped'));
	});

	test('Compact: consecutive tool calls (even mixed kinds) share ONE toggleable group', () => {
		const h = runDensityWebview({ ...BASE_UI, conversationDensity: 'compact-all-grouped' });
		h.fireMessage({ type: 'bubbles', bubbles: [assistantBubbleWithTools([['t1', 'shell'], ['t2', 'read'], ['t3', 'edit']])] });
		const tools = toolsElOf(h);
		const groups = tools.querySelectorAll('.tc-group');
		assert.strictEqual(groups.length, 1, 'expected exactly one group, got ' + groups.length);
		const cards = groups[0].querySelectorAll('.tool-call-card');
		assert.strictEqual(cards.length, 3, 'all 3 mixed-kind cards must be in the group');
		const head = groups[0].querySelector('.tc-group-head');
		assert.ok(head, 'group needs a toggle head');
		assert.ok((head.textContent || '').includes('3 tool calls'), 'head counts the cards, got: ' + head.textContent);
		// The group is toggleable: clicking flips aria-expanded + open class.
		assert.strictEqual(head.getAttribute('aria-expanded'), 'false');
		head.click();
		assert.strictEqual(head.getAttribute('aria-expanded'), 'true');
		assert.ok(groups[0].classList.contains('open'));
	});

	test('Balanced: cards render collapsed with NO grouping', () => {
		const h = runDensityWebview({ ...BASE_UI, conversationDensity: 'compact-ungrouped' });
		h.fireMessage({ type: 'bubbles', bubbles: [assistantBubbleWithTools([['t1', 'shell'], ['t2', 'read'], ['t3', 'edit']])] });
		const tools = toolsElOf(h);
		assert.strictEqual(tools.querySelectorAll('.tc-group').length, 0, 'Balanced must not group');
		assert.strictEqual(tools.querySelectorAll('.tool-call-card').length, 3, 'all 3 cards render individually');
		// Collapsed: output hidden until the user expands the card.
		const first = tools.querySelectorAll('.tool-call-card')[0];
		const out = first.querySelector('.tc-output');
		assert.ok(out, 'card with outputPreview renders a .tc-output node');
		assert.strictEqual(out.style.display, 'none', 'output collapsed at Balanced');
	});

	test('Detailed: cards render expanded with output visible (step-by-step)', () => {
		const h = runDensityWebview({ ...BASE_UI, conversationDensity: 'detailed' });
		h.fireMessage({ type: 'bubbles', bubbles: [assistantBubbleWithTools([['t1', 'shell'], ['t2', 'edit']])] });
		const tools = toolsElOf(h);
		assert.strictEqual(tools.querySelectorAll('.tc-group').length, 0, 'Detailed must not group');
		const cards = tools.querySelectorAll('.tool-call-card');
		assert.strictEqual(cards.length, 2);
		for (const card of cards) {
			const out = card.querySelector('.tc-output');
			assert.ok(out, 'detailed card keeps its output node');
			assert.strictEqual(out.style.display, '', 'output visible at Detailed, got: ' + out.style.display);
		}
	});

	test('live uiConfig change regroups rendered cards (Compact → Balanced)', () => {
		const h = runDensityWebview({ ...BASE_UI, conversationDensity: 'compact-all-grouped' });
		h.fireMessage({ type: 'bubbles', bubbles: [assistantBubbleWithTools([['t1', 'shell'], ['t2', 'edit']])] });
		assert.strictEqual(toolsElOf(h).querySelectorAll('.tc-group').length, 1, 'starts grouped at Compact');
		h.fireMessage({ type: 'uiConfig', ui: { ...BASE_UI, conversationDensity: 'compact-ungrouped' } });
		const tools = toolsElOf(h);
		assert.strictEqual(tools.querySelectorAll('.tc-group').length, 0, 'group dissolved after switching to Balanced');
		assert.strictEqual(tools.querySelectorAll('.tool-call-card').length, 2, 'both cards survive the regroup');
		assert.ok(h.body.classList.contains('density-compact-ungrouped'));
	});

	test('live uiConfig change to Detailed expands outputs', () => {
		const h = runDensityWebview({ ...BASE_UI, conversationDensity: 'compact-ungrouped' });
		h.fireMessage({ type: 'bubbles', bubbles: [assistantBubbleWithTools([['t1', 'shell']])] });
		const before = toolsElOf(h).querySelector('.tool-call-card')!.querySelector('.tc-output')!;
		assert.strictEqual(before.style.display, 'none');
		h.fireMessage({ type: 'uiConfig', ui: { ...BASE_UI, conversationDensity: 'detailed' } });
		const after = toolsElOf(h).querySelector('.tool-call-card')!.querySelector('.tc-output')!;
		assert.strictEqual(after.style.display, '', 'output becomes visible at Detailed');
	});
});
