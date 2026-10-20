/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { IDE_CHAT_EDITOR_SCHEME, isValidIdeChatTabId } from '../../../../browser/parts/editor/editorTabBadges.js';

suite('EditorTabBadges (orange-dot-native-tabs)', () => {

	suite('isValidIdeChatTabId — fail-closed tab id validation', () => {

		test('accepts well-formed tab ids', () => {
			assert.strictEqual(isValidIdeChatTabId('tab-1'), true);
			assert.strictEqual(isValidIdeChatTabId('tab-42'), true);
		});

		test('rejects non-strings and empty ids', () => {
			assert.strictEqual(isValidIdeChatTabId(undefined), false);
			assert.strictEqual(isValidIdeChatTabId(null), false);
			assert.strictEqual(isValidIdeChatTabId(42), false);
			assert.strictEqual(isValidIdeChatTabId({}), false);
			assert.strictEqual(isValidIdeChatTabId(''), false);
		});

		test('rejects path traversal and nested paths (never badge a wrong tab)', () => {
			assert.strictEqual(isValidIdeChatTabId('tab-1/extra'), false);
			assert.strictEqual(isValidIdeChatTabId('/tab-1'), false);
			assert.strictEqual(isValidIdeChatTabId('..'), false);
			assert.strictEqual(isValidIdeChatTabId('.'), false);
			assert.strictEqual(isValidIdeChatTabId('a/../b'), false);
			assert.strictEqual(isValidIdeChatTabId('../tab-1'), false);
		});

		test('scheme constant matches the extension-side CHAT_EDITOR_SCHEME', () => {
			// Must stay in sync with CHAT_EDITOR_SCHEME in
			// extensions/ide-agent/src/services/chatEditorProvider.ts.
			assert.strictEqual(IDE_CHAT_EDITOR_SCHEME, 'ide-chat');
		});
	});
});
