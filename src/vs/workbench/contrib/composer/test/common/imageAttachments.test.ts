/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import {
	IMAGE_ATTACHMENTS_RETENTION_MS,
	IMAGE_ATTACHMENT_MAX_BYTES,
	buildImageFilesXmlBlock,
	extensionForMimeType,
	filterStaleAttachments,
	imageAttachmentFilename,
	imageFilesXmlBlockFor,
	isSupportedImageMimeType,
	parseImageDataUrl,
	resolveImageAttachmentsDir,
} from '../../common/imageAttachments.js';

const join = (...parts: string[]) => parts.join('/');

suite('imageAttachments (agent-image-files-disk-convention)', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('buildImageFilesXmlBlock lists disk paths with the evidence intro text', () => {
		const block = buildImageFilesXmlBlock(['/ws/.ide-code/attachments/image-1.png', '/ws/.ide-code/attachments/image-2.jpg']);
		assert.ok(block.startsWith('<image_files>'), 'opens with <image_files>');
		assert.ok(block.endsWith('</image_files>'), 'closes with </image_files>');
		// Verbatim intro sentences from deepdig-runtime-agent-loop-2026-10-19.md §2 step 8.
		assert.ok(block.includes('The following images were provided by the user and saved to disk for future use.'));
		assert.ok(block.includes('These files can be read with tools, copied to other locations, or attached to subagents using the file_attachments parameter.'));
		assert.ok(block.includes('- /ws/.ide-code/attachments/image-1.png'));
		assert.ok(block.includes('- /ws/.ide-code/attachments/image-2.jpg'));
		// No base64 in the block — paths only.
		assert.ok(!block.includes('base64'));
	});

	test('buildImageFilesXmlBlock escapes XML special chars in paths', () => {
		const block = buildImageFilesXmlBlock(['/ws/a&b/<c>.png']);
		assert.ok(block.includes('/ws/a&amp;b/&lt;c&gt;.png'));
		assert.ok(!block.includes('<c>'));
	});

	test('resolveImageAttachmentsDir prefers the workspace, falls back to home', () => {
		assert.strictEqual(
			resolveImageAttachmentsDir('/ws/project', '/home/u', join),
			'/ws/project/.ide-code/attachments',
		);
		assert.strictEqual(
			resolveImageAttachmentsDir(undefined, '/home/u', join),
			'/home/u/.ide-code/attachments',
		);
	});

	test('imageAttachmentFilename is unique per call and carries the right extension', () => {
		const now = new Date('2026-10-20T00:00:00.000Z');
		const a = imageAttachmentFilename('image/png', now, 'aaaaaaaa');
		const b = imageAttachmentFilename('image/png', now, 'bbbbbbbb');
		assert.ok(a.endsWith('.png'));
		assert.ok(b.endsWith('.png'));
		assert.notStrictEqual(a, b, 'different random suffixes');
		assert.strictEqual(imageAttachmentFilename('image/jpeg', now, 'cccccccc').endsWith('.jpg'), true);
		assert.strictEqual(imageAttachmentFilename('image/webp', now, 'cccccccc').endsWith('.webp'), true);
		assert.strictEqual(extensionForMimeType('image/gif'), 'gif');
	});

	test('isSupportedImageMimeType accepts png/jpeg/webp/gif only', () => {
		assert.strictEqual(isSupportedImageMimeType('image/png'), true);
		assert.strictEqual(isSupportedImageMimeType('image/jpeg'), true);
		assert.strictEqual(isSupportedImageMimeType('image/webp'), true);
		assert.strictEqual(isSupportedImageMimeType('image/gif'), true);
		assert.strictEqual(isSupportedImageMimeType('image/svg+xml'), false);
		assert.strictEqual(isSupportedImageMimeType('text/plain'), false);
	});

	test('parseImageDataUrl accepts a valid png data URL', () => {
		// PNG magic bytes (89 50 4E 47) as base64 — hardcoded to stay node-free.
		const base64 = 'iVBORw==';
		const parsed = parseImageDataUrl(`data:image/png;base64,${base64}`);
		assert.ok(parsed);
		assert.strictEqual(parsed.mimeType, 'image/png');
		assert.strictEqual(parsed.base64, base64);
		assert.strictEqual(parsed.byteLength, 4);
	});

	test('parseImageDataUrl rejects non-image, oversized and malformed URLs', () => {
		assert.strictEqual(parseImageDataUrl('not-a-data-url'), undefined);
		assert.strictEqual(parseImageDataUrl('data:text/plain;base64,aGk='), undefined);
		assert.strictEqual(parseImageDataUrl('data:image/svg+xml;base64,PHN2Zz4='), undefined);
		// Declared byte length over the cap.
		const huge = 'A'.repeat(Math.ceil(IMAGE_ATTACHMENT_MAX_BYTES * 4 / 3) + 8);
		assert.strictEqual(parseImageDataUrl(`data:image/png;base64,${huge}`), undefined);
	});

	test('filterStaleAttachments flags only entries older than the retention window', () => {
		const now = 1_000_000_000;
		const names = filterStaleAttachments([
			{ name: 'old.png', mtimeMs: now - IMAGE_ATTACHMENTS_RETENTION_MS - 1 },
			{ name: 'fresh.png', mtimeMs: now - 1000 },
			{ name: 'edge.png', mtimeMs: now - IMAGE_ATTACHMENTS_RETENTION_MS },
		], now);
		assert.deepStrictEqual(names, ['old.png']);
	});

	test('imageFilesXmlBlockFor builds the block from file:// attachments only', () => {
		const parseFileUri = (uri: string) => URI.parse(uri);
		const block = imageFilesXmlBlockFor([
			{ uri: 'file:///ws/.ide-code/attachments/a.png' },
			{ uri: 'https://example.com/b.png' },
			{ uri: 'not-a-uri' },
		], parseFileUri);
		assert.ok(block);
		assert.ok(block.includes('- /ws/.ide-code/attachments/a.png'), 'disk path listed');
		assert.ok(!block.includes('https://example.com'), 'non-file URIs skipped');
		assert.ok(block.startsWith('<image_files>') && block.endsWith('</image_files>'));
	});

	test('imageFilesXmlBlockFor returns undefined without resolvable attachments', () => {
		const parseFileUri = (uri: string) => URI.parse(uri);
		assert.strictEqual(imageFilesXmlBlockFor(undefined, parseFileUri), undefined);
		assert.strictEqual(imageFilesXmlBlockFor([], parseFileUri), undefined);
		assert.strictEqual(imageFilesXmlBlockFor([{ uri: 'https://example.com/b.png' }], parseFileUri), undefined);
	});
});
