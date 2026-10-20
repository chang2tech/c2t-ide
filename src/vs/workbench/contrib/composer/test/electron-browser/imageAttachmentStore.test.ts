/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IMAGE_ATTACHMENTS_RETENTION_MS } from '../../common/imageAttachments.js';
import { pruneImageAttachments, saveUserImageAttachment } from '../../electron-browser/imageAttachmentStore.js';

function makeTempDir(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), 'ide-image-attach-test-'));
}

suite('imageAttachmentStore', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('saveUserImageAttachment writes the image to disk and returns its path', async () => {
		const dir = makeTempDir();
		// 1x1 PNG as a data URL (hardcoded to stay deterministic).
		const dataUrl = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
		const saved = await saveUserImageAttachment(dataUrl, {
			workspaceFsPath: dir,
			retentionMs: IMAGE_ATTACHMENTS_RETENTION_MS,
		});
		assert.ok(saved.filePath.startsWith(path.join(dir, '.ide-code', 'attachments') + path.sep));
		assert.ok(saved.name.endsWith('.png'));
		assert.strictEqual(saved.mimeType, 'image/png');
		assert.ok(fs.existsSync(saved.filePath), 'file exists on disk');
		assert.ok(fs.statSync(saved.filePath).size > 0);
		assert.strictEqual(saved.byteLength, fs.statSync(saved.filePath).size);
		fs.rmSync(dir, { recursive: true, force: true });
	});

	test('saveUserImageAttachment rejects non-image payloads', async () => {
		await assert.rejects(
			saveUserImageAttachment('data:text/plain;base64,aGk=', { workspaceFsPath: makeTempDir() }),
			/supported image attachment/,
		);
	});

	test('pruneImageAttachments deletes only files older than the retention window', async () => {
		const dir = makeTempDir();
		const attachDir = path.join(dir, '.ide-code', 'attachments');
		fs.mkdirSync(attachDir, { recursive: true });
		const oldFile = path.join(attachDir, 'old.png');
		const freshFile = path.join(attachDir, 'fresh.png');
		fs.writeFileSync(oldFile, 'x');
		fs.writeFileSync(freshFile, 'x');
		const now = Date.now();
		fs.utimesSync(oldFile, new Date(now), new Date(now - IMAGE_ATTACHMENTS_RETENTION_MS - 60_000));
		const { deleted } = await pruneImageAttachments(attachDir, IMAGE_ATTACHMENTS_RETENTION_MS, () => now);
		assert.deepStrictEqual(deleted, ['old.png']);
		assert.ok(!fs.existsSync(oldFile), 'stale file deleted');
		assert.ok(fs.existsSync(freshFile), 'fresh file kept');
		fs.rmSync(dir, { recursive: true, force: true });
	});

	test('pruneImageAttachments tolerates a missing directory', async () => {
		const { deleted } = await pruneImageAttachments(path.join(makeTempDir(), 'nope'));
		assert.deepStrictEqual(deleted, []);
	});
});
