/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// IDE-CODE: Footer component for the agent sidebar.
//
// Task history note: the previous `browser/agents.contribution.ts` was an
// unimplemented skeleton (4 TODOs); this module is part of the commit that
// replaces it with the real Cursor-structured implementation.
//
// Binary evidence (Cursor 3.25.9 nls.keys.json + nls.messages.json, module
// `vs/workbench/contrib/agents/browser/components/AgentSidebarFooter`,
// verified 2026-10-20 by this task): NLS key
// 'agentSidebarFooter.privateInference' -> 'Private Inference' — VERBATIM
// (nls.messages.json index 4745). The binary renders this label inside a
// React footer component (plan info + private-inference indicator); the
// layout and the condition Cursor uses to show the indicator are not
// recoverable from NLS evidence, so this DOM component is the fork's honest
// analog.
// UNKNOWN: where Cursor mounts this footer (which sidebar container). The
// component is therefore mountable: the owning view calls `render(parent)`.
// No mount site is wired in this commit — the fork's agent sidebar surface
// (composer.chat view) is owned by `contrib/composer`; wiring the mount is a
// follow-up that must not duplicate the chat view.

import * as dom from '../../../../../base/browser/dom.js';
import { localize } from '../../../../../nls.js';
import { Codicon } from '../../../../../base/common/codicons.js';
import { ThemeIcon } from '../../../../../base/common/themables.js';

export class AgentSidebarFooter {

	private readonly element: HTMLElement;

	constructor() {
		this.element = dom.$('div');
		this.element.className = 'agent-sidebar-footer';

		const indicator = dom.$('div');
		indicator.className = 'agent-sidebar-footer-private-inference';

		const icon = dom.$('span');
		icon.className = ThemeIcon.asClassName(Codicon.shield);

		const label = dom.$('span');
		// Binary-verbatim: 'agentSidebarFooter.privateInference' -> 'Private Inference'.
		label.textContent = localize('agentSidebarFooter.privateInference', 'Private Inference');

		indicator.append(icon, label);
		this.element.append(indicator);
	}

	get domElement(): HTMLElement {
		return this.element;
	}

	/** Append the footer to its owning container. */
	render(parent: HTMLElement): void {
		parent.append(this.element);
	}
}
