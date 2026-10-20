/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { suite, test } from 'node:test';
import { getBuiltInExtensionDownloadSource } from './builtInExtensionSource.ts';

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const product = JSON.parse(fs.readFileSync(path.join(repoRoot, 'product.json'), 'utf8'));

suite('builtInExtension download source (XQA-05 P2 lock-in)', () => {
	test('predicate truth table mirrors getExtensionDownloadStream branch order', () => {
		// vsix wins over everything
		assert.strictEqual(getBuiltInExtensionDownloadSource({ vsix: 'a.vsix', platformSpecific: { t: 's' } }, 'https://gallery'), 'vsix');
		assert.strictEqual(getBuiltInExtensionDownloadSource({ vsix: 'a.vsix' }, undefined), 'vsix');
		// platformSpecific always goes to GitHub (marketplace lacks per-target assets),
		// even when a gallery is configured
		assert.strictEqual(getBuiltInExtensionDownloadSource({ platformSpecific: { t: 's' } }, 'https://gallery'), 'github');
		assert.strictEqual(getBuiltInExtensionDownloadSource({ platformSpecific: { t: 's' } }, undefined), 'github');
		// otherwise the gallery decides
		assert.strictEqual(getBuiltInExtensionDownloadSource({}, 'https://gallery'), 'marketplace');
		assert.strictEqual(getBuiltInExtensionDownloadSource({}, ''), 'github');
		assert.strictEqual(getBuiltInExtensionDownloadSource({}, undefined), 'github');
	});

	test('extensionsGallery is configured (open-vsx)', () => {
		assert.ok(product.extensionsGallery?.serviceUrl, 'extensionsGallery.serviceUrl must be set');
	});

	test('the three MS builtInExtensions download from the gallery, not GitHub', () => {
		const gallery = product.extensionsGallery.serviceUrl;
		for (const name of ['ms-vscode.js-debug-companion', 'ms-vscode.js-debug', 'ms-vscode.vscode-js-profile-table']) {
			const ext = product.builtInExtensions.find((e: any) => e.name === name);
			assert.ok(ext, `${name} must be listed in builtInExtensions`);
			assert.strictEqual(ext.vsix, undefined, `${name} must not use a local vsix`);
			assert.strictEqual(ext.platformSpecific, undefined, `${name} must not be platformSpecific`);
			assert.strictEqual(
				getBuiltInExtensionDownloadSource(ext, gallery),
				'marketplace',
				`${name}: with the gallery configured the download source is the gallery — ` +
				`the "fetched at build time from Microsoft repos, bypassing Open VSX" claim is refuted`
			);
		}
	});

	test('repo field is present but inert when the gallery is configured', () => {
		// fromMarketplace destructures only { name, version, sha256, metadata } — `repo`
		// is never read on this path. It stays as a fallback for gallery-less builds.
		const ext = product.builtInExtensions.find((e: any) => e.name === 'ms-vscode.js-debug');
		assert.ok(ext.repo.includes('github.com/microsoft'), 'repo fallback is still recorded');
		assert.strictEqual(getBuiltInExtensionDownloadSource(ext, product.extensionsGallery.serviceUrl), 'marketplace');
	});
});
