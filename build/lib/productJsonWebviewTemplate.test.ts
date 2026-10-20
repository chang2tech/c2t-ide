/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { suite, test } from 'node:test';

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const product = JSON.parse(fs.readFileSync(path.join(repoRoot, 'product.json'), 'utf8'));

suite('product.json webviewContentExternalBaseUrlTemplate (XQA-05 P2 lock-in)', () => {
	test('is byte-identical to Cursor 3.25.6 (verified against the reference app)', () => {
		// Source: docs/rea/cdn-research.md — Cursor reuses Microsoft's
		// vscode-cdn.net (hardcoded insider/<commit>), not its own CDN.
		// On desktop this template is never read (webviewExternalEndpoint is
		// hardcoded to vscode-webview://{{uuid}}); it only matters for web builds.
		const CURSOR_3_25_6 =
			'https://{{uuid}}.vscode-cdn.net/insider/ef65ac1ba57f57f2a3961bfe94aa20481caca4c6/out/vs/workbench/contrib/webview/browser/pre/';
		assert.strictEqual(product.webviewContentExternalBaseUrlTemplate, CURSOR_3_25_6);
	});

	test('does not point at the dead cdn.ide-code.dev sinkhole', () => {
		assert.ok(
			!String(product.webviewContentExternalBaseUrlTemplate).includes('cdn.ide-code.dev'),
			'must not regress to the dead sinkhole domain flagged by XQA-05'
		);
	});
});
