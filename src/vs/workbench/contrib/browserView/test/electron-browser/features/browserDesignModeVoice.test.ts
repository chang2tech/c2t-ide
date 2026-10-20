/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { decodeBase64 } from '../../../../../../base/common/buffer.js';
import { IChatRequestVariableEntry } from '../../../../chat/common/attachments/chatVariableEntries.js';
import { toIdeBrowserChatAttachment } from '../../../electron-browser/features/browserEditorChatFeatures.js';

/**
 * design-mode-voice / design-mode-drawing: the IDE Agent routing payloads.
 * Voice transcripts must reach the `ide-agent` extension as `voiceInput`
 * entries; design annotations must arrive as `designAnnotation` entries with
 * their PNG bytes intact.
 */
suite('Browser Design Mode ide-agent payloads', () => {

	function voiceEntry(text: string): IChatRequestVariableEntry {
		return {
			id: 'browser-voice-input-123',
			name: 'Voice input',
			fullName: 'Voice input',
			kind: 'generic',
			value: text,
			modelDescription: 'Voice-dictated change from the browser Design Mode mic.',
		};
	}

	test('voice transcript maps to a voiceInput payload with text', () => {
		const payload = toIdeBrowserChatAttachment(voiceEntry('make the header blue'));
		assert.strictEqual(payload.kind, 'voiceInput');
		assert.strictEqual(payload.text, 'make the header blue');
		assert.strictEqual(payload.imageBase64, undefined);
	});

	test('design annotation image maps to designAnnotation with PNG bytes', () => {
		const bytes = decodeBase64('iVBORw0KGgo=');
		const entry: IChatRequestVariableEntry = {
			id: 'browser-design-annotation-123',
			name: 'Design annotations',
			fullName: 'Design annotations',
			kind: 'image',
			value: bytes,
			mimeType: 'image/png',
		};
		const payload = toIdeBrowserChatAttachment(entry);
		assert.strictEqual(payload.kind, 'designAnnotation');
		assert.strictEqual(payload.imageMimeType, 'image/png');
		assert.ok(payload.imageBase64, 'image bytes must survive the RPC boundary');
		assert.deepStrictEqual(decodeBase64(payload.imageBase64!), bytes);
	});

	test('area screenshot image entries keep their bytes (value/mimeType shape)', () => {
		const bytes = decodeBase64('aGVsbG8=');
		const entry: IChatRequestVariableEntry = {
			id: 'browser-area-screenshot-123',
			name: 'Browser Area Screenshot',
			fullName: 'Browser Area Screenshot',
			kind: 'image',
			value: bytes,
			mimeType: 'image/jpeg',
		};
		const payload = toIdeBrowserChatAttachment(entry);
		assert.strictEqual(payload.kind, 'areaScreenshot');
		assert.strictEqual(payload.imageMimeType, 'image/jpeg');
		assert.ok(payload.imageBase64, 'area screenshot bytes must survive the RPC boundary');
	});
});
