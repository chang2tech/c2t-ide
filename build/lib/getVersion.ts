/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as git from './git.ts';

export function getVersion(root: string): string | undefined {
	let version = process.env['BUILD_SOURCEVERSION'];

	if (!version || !/^[0-9a-f]{40}$/i.test(version.trim())) {
		version = git.getVersion(root);
	}

	return version;
}

/**
 * Hard assert for desktop packaging: returns `commit` unchanged when it is
 * present, and throws otherwise. Packaging stamps the commit into
 * product.json, the win32 `code.sh` scripts and the copilot shim launcher;
 * a missing commit would be stamped there as the literal string
 * `"undefined"` instead of failing. Only call this from a packaging task
 * closure (e.g. `packageTask` in `gulpfile.vscode.ts`) — never at module
 * top, because the gulpfiles are also loaded for non-packaging tasks that
 * legitimately run from a source tree without a `.git` checkout.
 *
 * This only checks for presence (undefined/empty): `getVersion` already
 * validates the 40-hex shape of `BUILD_SOURCEVERSION`, and the git
 * fallback returns a SHA or `undefined`.
 */
export function requireCommit(commit: string | undefined, context: string): string {
	if (!commit) {
		throw new Error(`[packageTask] Refusing to package ${context}: no commit hash available (getVersion returned undefined); product.json, code.sh and copilot.sh would be stamped with the literal string "undefined". Build from a git checkout, or set BUILD_SOURCEVERSION to the full 40-character commit SHA.`);
	}

	return commit;
}
