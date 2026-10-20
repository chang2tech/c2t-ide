/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { CancellationToken } from '../../../../../../base/common/cancellation.js';
import { Disposable } from '../../../../../../base/common/lifecycle.js';
import { URI } from '../../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../../base/test/common/utils.js';
import { IConfigurationService } from '../../../../../../platform/configuration/common/configuration.js';
import { TestConfigurationService } from '../../../../../../platform/configuration/test/common/testConfigurationService.js';
import { IResourceEditorInput, ViewColumn } from '../../../../../../platform/editor/common/editor.js';
import { IOpenerService } from '../../../../../../platform/opener/common/opener.js';
import { IEditorService, PreferredGroup } from '../../../../../services/editor/common/editorService.js';
import { workbenchInstantiationService } from '../../../../../test/browser/workbenchTestServices.js';
import { LEGACY_OPEN_LOCALHOST_LINKS_CONFIG_KEY, OPEN_LOCAL_LINKS_CONFIG_KEY } from '../../../common/openLocalLinks.js';
import { LocalhostLinkOpenerContribution } from '../../../electron-browser/features/browserTabManagementFeatures.js';

// DEV-GAPS-159 (QA-155 NF-1): the legacy upstream opener for
// `workbench.browser.openLocalhostLinks` no longer opens links itself.
// Contributed external openers run before the OpenerService `_openers`
// loop, so opening here pre-empted the Cursor parity interceptor
// (OpenLocalLinksOpenerContribution) with a narrower classifier, no
// `pBn` rewrite and no ssh-remote exclusion — and it opened links even
// when `ide.browser.openLocalhostLinks` (Cursor's
// `autoOpenLocalhostUrls`) was false. The provider now always returns
// false: with the ide setting ON the parity interceptor decides in the
// `_openers` loop; with it OFF nothing auto-opens. These tests pin the
// provider side of that gate (the interceptor side is covered by
// openLocalLinksOpener.test.ts and the pure gate matrix by
// openLocalLinks.test.ts).

suite('Localhost Link Opener (legacy, gated by DEV-GAPS-159)', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	function createOpener(configuration: Record<string, unknown>): { opener: LocalhostLinkOpenerContribution; openedEditors: unknown[] } {
		const instantiationService = workbenchInstantiationService(undefined, store);
		const openedEditors: unknown[] = [];
		instantiationService.stub(IOpenerService, { registerExternalOpener: () => Disposable.None });
		instantiationService.stub(IConfigurationService, new TestConfigurationService(configuration));
		instantiationService.stub(IEditorService, 'openEditor', async (input: IResourceEditorInput, group?: PreferredGroup) => {
			openedEditors.push({ input, group });
			return undefined;
		});
		const opener = store.add(instantiationService.createInstance(LocalhostLinkOpenerContribution));
		return { opener, openedEditors };
	}

	const url = 'https://localhost:9448/review?pr=342081#changes';

	for (const viewColumn of [undefined, ViewColumn.Beside]) {
		test(`legacy ON + ide ON: does not open here (defers to the parity interceptor): ${viewColumn}`, async () => {
			const { opener, openedEditors } = createOpener({
				[LEGACY_OPEN_LOCALHOST_LINKS_CONFIG_KEY]: true,
				[OPEN_LOCAL_LINKS_CONFIG_KEY]: true,
			});
			const handled = await opener.openExternal(url, { sourceUri: URI.parse(url), viewColumn }, CancellationToken.None);
			assert.strictEqual(handled, false);
			assert.deepStrictEqual(openedEditors, []);
		});
	}

	test('legacy ON + ide OFF: does not open (the Cursor setting OFF wins)', async () => {
		const { opener, openedEditors } = createOpener({
			[LEGACY_OPEN_LOCALHOST_LINKS_CONFIG_KEY]: true,
			[OPEN_LOCAL_LINKS_CONFIG_KEY]: false,
		});
		const handled = await opener.openExternal(url, { sourceUri: URI.parse(url) }, CancellationToken.None);
		assert.strictEqual(handled, false);
		assert.deepStrictEqual(openedEditors, []);
	});

	test('legacy ON + ide unset (binary default ON): still defers, does not open here', async () => {
		const { opener, openedEditors } = createOpener({
			[LEGACY_OPEN_LOCALHOST_LINKS_CONFIG_KEY]: true,
		});
		const handled = await opener.openExternal('http://127.0.0.1:5173/', { sourceUri: URI.parse('http://127.0.0.1:5173/') }, CancellationToken.None);
		assert.strictEqual(handled, false);
		assert.deepStrictEqual(openedEditors, []);
	});

	test('legacy OFF: does not open, regardless of the ide setting', async () => {
		for (const ideValue of [true, false]) {
			const { opener, openedEditors } = createOpener({
				[LEGACY_OPEN_LOCALHOST_LINKS_CONFIG_KEY]: false,
				[OPEN_LOCAL_LINKS_CONFIG_KEY]: ideValue,
			});
			const handled = await opener.openExternal(url, { sourceUri: URI.parse(url) }, CancellationToken.None);
			assert.strictEqual(handled, false);
			assert.deepStrictEqual(openedEditors, []);
		}
	});

	test('non-localhost href: does not open even with both settings ON', async () => {
		const { opener, openedEditors } = createOpener({
			[LEGACY_OPEN_LOCALHOST_LINKS_CONFIG_KEY]: true,
			[OPEN_LOCAL_LINKS_CONFIG_KEY]: true,
		});
		const handled = await opener.openExternal('https://example.com/', { sourceUri: URI.parse('https://example.com/') }, CancellationToken.None);
		assert.strictEqual(handled, false);
		assert.deepStrictEqual(openedEditors, []);
	});
});
