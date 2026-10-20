/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Wires up the Cursor-parity browser-view command surface: the five command
 * groups (tab / nav / capture / agent / origin-allowlist) register their
 * `cursor.browserView.*` and `cursor.browserOriginAllowlist.*` commands (plus
 * the bare `browserView.blur` and the two `cursor.browserView.debug.*`
 * actions) via CommandsRegistry / registerAction2 when this module is
 * imported for side effects by browserView.contribution.ts.
 *
 * Registration is idempotent (see registerBrowserViewCommandSurface), so tests
 * may also call it directly.
 */
import { registerBrowserViewTabCommands } from './browserViewTabCommands.js';
import { registerBrowserViewNavCommands } from './browserViewNavCommands.js';
import { registerBrowserViewCaptureCommands } from './browserViewCaptureCommands.js';
import { registerBrowserViewAgentCommands } from './browserViewAgentCommands.js';
import { registerBrowserViewOriginAllowlistCommands } from './browserViewOriginAllowlistCommands.js';

let _surfaceRegistered = false;

/** Registers the full Cursor-parity browser-view command surface. Idempotent. */
export function registerBrowserViewCommandSurface(): void {
	if (_surfaceRegistered) {
		return;
	}
	_surfaceRegistered = true;
	registerBrowserViewTabCommands();
	registerBrowserViewNavCommands();
	registerBrowserViewCaptureCommands();
	registerBrowserViewAgentCommands();
	registerBrowserViewOriginAllowlistCommands();
}

// Self-register on import (side-effect import from browserView.contribution.ts).
registerBrowserViewCommandSurface();
