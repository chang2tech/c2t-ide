/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import {
	LEGACY_OPEN_LOCALHOST_LINKS_CONFIG_KEY,
	OPEN_LOCAL_LINKS_CONFIG_KEY,
	OPEN_LOCAL_LINKS_DEFAULT,
	OPEN_LOCAL_LINKS_DESCRIPTION,
	OPEN_LOCAL_LINKS_LABEL,
	OPEN_LOCAL_LINKS_SEARCH_ID,
	OPEN_LOCAL_LINKS_STORAGE_KEY,
	OPEN_LOCAL_LINKS_STORAGE_NAME,
	OPEN_WEB_LINKS_DEFAULT,
	OPEN_WEB_LINKS_DESCRIPTION,
	OPEN_WEB_LINKS_LABEL,
	OPEN_WEB_LINKS_SEARCH_ID,
	OPEN_WEB_LINKS_STORAGE_KEY,
	OPEN_WEB_LINKS_STORAGE_NAME,
	TERMINAL_LINK_HOVER_SUFFIX,
	URL_OPEN_TOAST_DONT_OPEN_ACTION_ID,
	URL_OPEN_TOAST_DONT_OPEN_LABEL,
	URL_OPEN_TOAST_MESSAGE,
	URL_OPEN_TOAST_NEVER_SHOW_AGAIN_ID,
	UrlOpenToastTracker,
	isLocalhostUrl,
	isSameAuthorityAsUrl,
	normalizeLocalhostUrl,
	resolveLegacyLocalhostLinkOpenerDecision,
	resolveLocalLinkBrowserOpen,
} from '../../common/openLocalLinks.js';

// DEV-GAPS-147 (`settings-open-local-links`): Cursor 3.25.9 parity for
// "Open Local Links in Cursor Browser". Binary evidence (re-extracted,
// see contrib/browserView/common/openLocalLinks.ts header and
// docs/rea/work-notes-gaps147.md):
//   storage schema @14326223  autoOpenLocalhostUrls:Jh(!0,-1,0),
//                             glassOpenWebLinksInBrowser:Jh(!1,-1,0)
//   settings row    @37322502 setting:browser:show-localhost-links
//   classifier lqt  @16936848 (tunnel.js) + helpers pBn/gph
//   consumer        @32435883 (first OpenerService opener)

suite('Open Local Links (DEV-GAPS-147)', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('verbatim constants: label, description, ids, storage keys, defaults', () => {
		assert.strictEqual(OPEN_LOCAL_LINKS_LABEL, 'Open Local Links in Cursor Browser');
		assert.strictEqual(OPEN_LOCAL_LINKS_DESCRIPTION, 'Automatically open localhost links in the Browser Tab');
		assert.strictEqual(OPEN_LOCAL_LINKS_SEARCH_ID, 'setting:browser:show-localhost-links');
		assert.strictEqual(OPEN_LOCAL_LINKS_STORAGE_NAME, 'autoOpenLocalhostUrls');
		assert.strictEqual(OPEN_LOCAL_LINKS_STORAGE_KEY, 'cursor/autoOpenLocalhostUrls');
		// Binary Jh(!0, -1, 0): the setting defaults to ON.
		assert.strictEqual(OPEN_LOCAL_LINKS_DEFAULT, true);
		assert.strictEqual(OPEN_LOCAL_LINKS_CONFIG_KEY, 'ide.browser.openLocalhostLinks');
	});

	test('verbatim constants: glass-only sibling (recorded, not registered in the fork)', () => {
		assert.strictEqual(OPEN_WEB_LINKS_LABEL, 'Open Web Links in Cursor Browser');
		assert.strictEqual(OPEN_WEB_LINKS_DESCRIPTION, 'Automatically open http and https links in the Browser Tab');
		assert.strictEqual(OPEN_WEB_LINKS_SEARCH_ID, 'setting:browser:open-web-links');
		assert.strictEqual(OPEN_WEB_LINKS_STORAGE_NAME, 'glassOpenWebLinksInBrowser');
		assert.strictEqual(OPEN_WEB_LINKS_STORAGE_KEY, 'cursor/glassOpenWebLinksInBrowser');
		// Binary Jh(!1, -1, 0): the sibling defaults to OFF.
		assert.strictEqual(OPEN_WEB_LINKS_DEFAULT, false);
	});

	suite('isLocalhostUrl — the binary lqt classifier', () => {
		const localUrls = [
			'http://localhost',
			'http://localhost:3000',
			'http://localhost:3000/path?q=1#frag',
			'https://localhost:9448/review?pr=342081#changes',
			'http://LOCALHOST:3000/',
			'http://localhost.:3000/',
			'http://foo.localhost:8080/',
			'http://a.b.localhost/',
			'http://127.0.0.1',
			'http://127.0.0.1:5173/',
			// Trailing dot on an IP literal: the binary strips ONE trailing
			// dot after hostname extraction (added by DEV-GAPS-159 per
			// QA-155, which verified this case against the binary by hand).
			'http://127.0.0.1./',
			'http://127.0.0.1.:8080/',
			// Userinfo does not affect the hostname checks (also verified
			// against the binary by QA-155).
			'http://user:pass@127.0.0.1/',
			'http://user:pass@localhost:3000/',
			'http://user@localhost/',
			// The whole 127.0.0.0/8 range matches the binary regex.
			'http://127.0.0.2/',
			'http://127.255.0.9:8080/',
			// WHATWG URL parsing expands the shorthand 127.1 to 127.0.0.1
			// before the binary's hostname checks run (the binary also goes
			// through `new URL`), so this is local there too.
			'http://127.1/',
			'http://[::1]:3000/',
			'http://[0:0:0:0:0:0:0:1]/',
			// All-interfaces hosts are in the binary mBn set.
			'http://0.0.0.0:5173/',
			'http://[::]/',
			'http://[0:0:0:0:0:0:0:0]/',
		];
		for (const url of localUrls) {
			test(`local: ${url}`, () => {
				assert.strictEqual(isLocalhostUrl(url), true);
				assert.strictEqual(isLocalhostUrl(URI.parse(url)), true);
			});
		}

		const nonLocalUrls = [
			'https://example.com/',
			'http://192.168.1.10:3000/',
			'http://10.0.0.5/',
			'http://128.0.0.1/',
			'http://127.0.0.1.evil.com/',
			'http://localhost.evil.com/',
			'http://evil-localhost.com/',
			// *.local is NOT in the binary's local set.
			'http://foo.local/',
			'http://myhost:3000/',
			// Non-http(s) schemes never qualify.
			'file://localhost/path/to/file.ts',
			'ftp://localhost:21/',
			'vscode://localhost/',
			'command:workbench.action.openBrowserEditor',
		];
		for (const url of nonLocalUrls) {
			test(`not local: ${url}`, () => {
				assert.strictEqual(isLocalhostUrl(url), false);
				assert.strictEqual(isLocalhostUrl(URI.parse(url)), false);
			});
		}

		test('unparseable / scheme-less strings are not local', () => {
			assert.strictEqual(isLocalhostUrl('localhost:3000'), false); // scheme "localhost", not http
			assert.strictEqual(isLocalhostUrl(''), false);
		});
	});

	suite('normalizeLocalhostUrl — the binary pBn', () => {
		test('rewrites unspecified hosts to localhost, preserving port and path', () => {
			assert.strictEqual(normalizeLocalhostUrl('http://0.0.0.0:5173/app'), 'http://localhost:5173/app');
			assert.strictEqual(normalizeLocalhostUrl('http://[::]:8080/'), 'http://localhost:8080/');
			assert.strictEqual(normalizeLocalhostUrl('http://[0:0:0:0:0:0:0:0]:8080/'), 'http://localhost:8080/');
		});

		test('leaves other URLs byte-identical', () => {
			assert.strictEqual(normalizeLocalhostUrl('http://localhost:3000/x'), 'http://localhost:3000/x');
			assert.strictEqual(normalizeLocalhostUrl('http://127.0.0.1:3000/x'), 'http://127.0.0.1:3000/x');
			assert.strictEqual(normalizeLocalhostUrl('https://example.com/'), 'https://example.com/');
			assert.strictEqual(normalizeLocalhostUrl('not a url'), 'not a url');
		});
	});

	suite('isSameAuthorityAsUrl — the binary gph', () => {
		test('same authority (host + port) matches, after normalization on both sides', () => {
			assert.strictEqual(isSameAuthorityAsUrl('http://localhost:3000/a', 'http://localhost:3000'), true);
			assert.strictEqual(isSameAuthorityAsUrl('http://0.0.0.0:3000/a', 'http://localhost:3000'), true);
			assert.strictEqual(isSameAuthorityAsUrl('http://LOCALHOST:3000/a', 'http://localhost:3000'), true);
		});

		test('different authority does not match', () => {
			assert.strictEqual(isSameAuthorityAsUrl('http://localhost:3001/a', 'http://localhost:3000'), false);
			assert.strictEqual(isSameAuthorityAsUrl('http://127.0.0.1:3000/a', 'http://localhost:3000'), false);
			assert.strictEqual(isSameAuthorityAsUrl('http://localhost:3000/a', ''), false);
			assert.strictEqual(isSameAuthorityAsUrl('http://localhost:3000/a', 'not a url'), false);
		});
	});

	suite('resolveLocalLinkBrowserOpen — the binary opener decision', () => {
		const on = { autoOpenLocalhostUrls: true };

		test('setting ON + local URL → routed, URL unchanged', () => {
			assert.strictEqual(resolveLocalLinkBrowserOpen('http://localhost:3000/dashboard', on), 'http://localhost:3000/dashboard');
			assert.strictEqual(resolveLocalLinkBrowserOpen(URI.parse('https://127.0.0.2:8443/'), on), 'https://127.0.0.2:8443/');
		});

		test('setting ON + all-interfaces URL → routed with pBn normalization', () => {
			assert.strictEqual(resolveLocalLinkBrowserOpen('http://0.0.0.0:5173/', on), 'http://localhost:5173/');
		});

		test('setting OFF → never routed', () => {
			assert.strictEqual(resolveLocalLinkBrowserOpen('http://localhost:3000/', { autoOpenLocalhostUrls: false }), undefined);
			assert.strictEqual(resolveLocalLinkBrowserOpen('http://127.0.0.1/', { autoOpenLocalhostUrls: false }), undefined);
		});

		test('explicit openExternal → never routed (binary checks it first)', () => {
			assert.strictEqual(resolveLocalLinkBrowserOpen('http://localhost:3000/', { ...on, openExternal: true }), undefined);
			assert.strictEqual(resolveLocalLinkBrowserOpen('http://localhost:3000/', { ...on, openExternal: false }), 'http://localhost:3000/');
		});

		test('non-local URL → not routed even when ON', () => {
			assert.strictEqual(resolveLocalLinkBrowserOpen('https://example.com/', on), undefined);
			assert.strictEqual(resolveLocalLinkBrowserOpen('http://192.168.0.10:3000/', on), undefined);
		});

		test('backend authority → not routed (binary exclusion)', () => {
			const backendUrl = 'http://localhost:3000';
			assert.strictEqual(resolveLocalLinkBrowserOpen('http://localhost:3000/api/x', { ...on, backendUrl }), undefined);
			assert.strictEqual(resolveLocalLinkBrowserOpen('http://localhost:3001/api/x', { ...on, backendUrl }), 'http://localhost:3001/api/x');
			assert.strictEqual(resolveLocalLinkBrowserOpen('http://localhost:3000/api/x', { ...on, backendUrl: undefined }), 'http://localhost:3000/api/x');
		});

		test('ssh-remote authority → not routed; other remotes still routed', () => {
			assert.strictEqual(resolveLocalLinkBrowserOpen('http://localhost:3000/', { ...on, remoteAuthority: 'ssh-remote+myhost' }), undefined);
			assert.strictEqual(resolveLocalLinkBrowserOpen('http://localhost:3000/', { ...on, remoteAuthority: 'user@ssh-remote+myhost' }), undefined);
			assert.strictEqual(resolveLocalLinkBrowserOpen('http://localhost:3000/', { ...on, remoteAuthority: 'wsl+Ubuntu' }), 'http://localhost:3000/');
			assert.strictEqual(resolveLocalLinkBrowserOpen('http://localhost:3000/', { ...on, remoteAuthority: undefined }), 'http://localhost:3000/');
		});
	});

	// DEV-GAPS-159 (QA-155 NF-2): the UrlOpenToast texts are nls entries
	// in the reference tree's `out/nls.messages.json` — 12224/12225/10782,
	// alignment cross-verified (see common/openLocalLinks.ts header).
	suite('UrlOpenToast — verbatim texts and dedupe (DEV-GAPS-159)', () => {
		test('verbatim constants: message, action label/id, never-show-again id, C5 suffix', () => {
			assert.strictEqual(URL_OPEN_TOAST_MESSAGE, 'Opening {0} in Cursor Browser');
			assert.strictEqual(URL_OPEN_TOAST_DONT_OPEN_LABEL, `Don't Open`);
			assert.strictEqual(URL_OPEN_TOAST_DONT_OPEN_ACTION_ID, 'urlOpenToast.dontOpen');
			assert.strictEqual(URL_OPEN_TOAST_NEVER_SHOW_AGAIN_ID, 'urlOpenToast.neverShowAgainv1');
			assert.strictEqual(TERMINAL_LINK_HOVER_SUFFIX, ', hold shift for your browser');
		});

		test('tracker: first toast per origin shows, repeats are deduped (binary _shownOrigins)', () => {
			const tracker = new UrlOpenToastTracker();
			assert.strictEqual(tracker.shouldShow('http://localhost:3000/a', false), true);
			assert.strictEqual(tracker.shouldShow('http://localhost:3000/b', false), false);
			// A different port is a different origin.
			assert.strictEqual(tracker.shouldShow('http://localhost:3001/a', false), true);
			assert.strictEqual(tracker.shouldShow('https://127.0.0.1:3000/a', false), true);
			assert.strictEqual(tracker.shouldShow('https://127.0.0.1:3000/b', false), false);
		});

		test('tracker: never-show-again set → always attempt notify, no bookkeeping (platform suppresses)', () => {
			const tracker = new UrlOpenToastTracker();
			assert.strictEqual(tracker.shouldShow('http://localhost:3000/a', true), true);
			assert.strictEqual(tracker.shouldShow('http://localhost:3000/a', true), true);
			// Nothing was recorded while never-show-again was set, so the
			// first non-suppressed call still shows.
			assert.strictEqual(tracker.shouldShow('http://localhost:3000/a', false), true);
			assert.strictEqual(tracker.shouldShow('http://localhost:3000/a', false), false);
		});

		test('tracker: unparseable or opaque ("null") origins are never deduped', () => {
			const tracker = new UrlOpenToastTracker();
			assert.strictEqual(tracker.shouldShow('not a url', false), true);
			assert.strictEqual(tracker.shouldShow('not a url', false), true);
			assert.strictEqual(tracker.shouldShow('data:text/plain,hi', false), true);
			assert.strictEqual(tracker.shouldShow('data:text/plain,hi', false), true);
		});
	});

	// DEV-GAPS-159 (QA-155 NF-1): the legacy upstream opener
	// (`workbench.browser.openLocalhostLinks`) must never open a link
	// itself — see header divergence 6 in common/openLocalLinks.ts.
	suite('resolveLegacyLocalhostLinkOpenerDecision — the NF-1 gate', () => {
		test('verbatim legacy config key', () => {
			assert.strictEqual(LEGACY_OPEN_LOCALHOST_LINKS_CONFIG_KEY, 'workbench.browser.openLocalhostLinks');
		});

		test('legacy OFF → disabled, regardless of the ide setting', () => {
			assert.strictEqual(resolveLegacyLocalhostLinkOpenerDecision(false, true), 'disabled');
			assert.strictEqual(resolveLegacyLocalhostLinkOpenerDecision(false, false), 'disabled');
		});

		test('legacy ON + ide OFF → suppressed-by-ide-off (the Cursor OFF wins)', () => {
			assert.strictEqual(resolveLegacyLocalhostLinkOpenerDecision(true, false), 'suppressed-by-ide-off');
		});

		test('legacy ON + ide ON → defer-to-ide-opener (C1 superset semantics win)', () => {
			assert.strictEqual(resolveLegacyLocalhostLinkOpenerDecision(true, true), 'defer-to-ide-opener');
		});
	});
});
