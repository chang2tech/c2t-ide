/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// IDE-CODE: Disk convention for user-attached composer images (node-free).
//
// Evidence: `docs/rea/deepdig-runtime-agent-loop-2026-10-19.md` §2 step 8 —
// Cursor's pre-turn sequence: "If attached images (`enableImageFiles`):
// injects an `<image_files>` XML block listing disk paths: 'The following
// images were provided by the user and saved to disk for future use … These
// files can be read with tools, copied to other locations, or attached to
// subagents using the file_attachments parameter.'"
//
// Convention (ours):
// - Attached images are NEVER inlined as base64 in the context. They are
//   saved to disk and referenced by path.
// - Save location: `<workspace>/.ide-code/attachments/` when a workspace
//   folder is open (so tools/subagents spawned in the workspace can read
//   them with a stable relative path), otherwise `~/.ide-code/attachments/`.
//   Rationale: workspace-local keeps attachments next to the project and
//   readable by subagents; the home-dir fallback covers window-less /
//   no-folder sessions. A tmp session dir was rejected: paths would not
//   survive restarts and tools could not rely on them.
// - The `<image_files>` XML block (built by `buildImageFilesXmlBlock`) is
//   appended to the engine prompt so tools/subagents receive the disk paths.
// - Retention: files older than `IMAGE_ATTACHMENTS_RETENTION_DAYS` are pruned
//   opportunistically on save (see imageAttachmentStore.ts).

/** Directory name (under the workspace root or home dir) holding attachments. */
export const IMAGE_ATTACHMENTS_DIR_NAME = '.ide-code/attachments';

/** Max bytes per attached image (mirrors the 15MB cap in mentionService.ts). */
export const IMAGE_ATTACHMENT_MAX_BYTES = 15 * 1024 * 1024;

/** Retention for saved attachments: files older than this are pruned. */
export const IMAGE_ATTACHMENTS_RETENTION_DAYS = 14;
export const IMAGE_ATTACHMENTS_RETENTION_MS = IMAGE_ATTACHMENTS_RETENTION_DAYS * 24 * 60 * 60 * 1000;

/** MIME types we accept for attached images. */
const SUPPORTED_IMAGE_MIME_TYPES: Record<string, string> = {
	'image/png': 'png',
	'image/jpeg': 'jpg',
	'image/webp': 'webp',
	'image/gif': 'gif',
};

export function isSupportedImageMimeType(mimeType: string): boolean {
	return Object.prototype.hasOwnProperty.call(SUPPORTED_IMAGE_MIME_TYPES, mimeType.toLowerCase());
}

export function extensionForMimeType(mimeType: string): string {
	return SUPPORTED_IMAGE_MIME_TYPES[mimeType.toLowerCase()] ?? 'png';
}

/**
 * Resolves the attachments directory. `join` is injected so this stays
 * node-free (electron-browser passes node's path.join).
 */
export function resolveImageAttachmentsDir(
	workspaceFsPath: string | undefined,
	homeDir: string,
	join: (...parts: string[]) => string,
): string {
	if (workspaceFsPath) {
		return join(workspaceFsPath, IMAGE_ATTACHMENTS_DIR_NAME);
	}
	return join(homeDir, IMAGE_ATTACHMENTS_DIR_NAME);
}

/**
 * Unique attachment filename: `image-<UTC-stamp>-<rand>.<ext>`.
 * `randomHex` is injected (node:crypto in electron-browser) for testability.
 */
export function imageAttachmentFilename(mimeType: string, now: Date = new Date(), randomHex: string = '00000000'): string {
	const stamp = now.toISOString().replace(/[:.]/g, '-');
	const safeRand = randomHex.replace(/[^0-9a-f]/gi, '').slice(0, 8) || '00000000';
	return `image-${stamp}-${safeRand}.${extensionForMimeType(mimeType)}`;
}

/** Upper bound on a data URL carrying a max-size image (base64 expansion + header). */
export const IMAGE_DATA_URL_MAX_LENGTH = Math.ceil(IMAGE_ATTACHMENT_MAX_BYTES * 4 / 3) + 128;

/**
 * Parses a `data:image/<type>;base64,...` URL into mime type + bytes.
 * Returns undefined when the URL is not a supported image data URL or the
 * payload exceeds {@link IMAGE_ATTACHMENT_MAX_BYTES}.
 *
 * HONEST DIVERGENCE: byteLength is computed from the base64 length
 * (accounting for `=` padding) without decoding — decoding multi-MB payloads
 * just to validate size would waste memory; the exact decoded size is checked
 * again by the store before writing.
 */
export function parseImageDataUrl(dataUrl: string): { mimeType: string; base64: string; byteLength: number } | undefined {
	if (typeof dataUrl !== 'string' || dataUrl.length > IMAGE_DATA_URL_MAX_LENGTH) {
		return undefined;
	}
	const match = /^data:(image\/[a-zA-Z0-9.+-]+);base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl);
	if (!match) {
		return undefined;
	}
	const mimeType = match[1].toLowerCase();
	if (!isSupportedImageMimeType(mimeType)) {
		return undefined;
	}
	const base64 = match[2];
	const padding = base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0;
	const byteLength = Math.floor(base64.length * 3 / 4) - padding;
	if (byteLength === 0 || byteLength > IMAGE_ATTACHMENT_MAX_BYTES) {
		return undefined;
	}
	return { mimeType, base64, byteLength };
}

/** XML-escapes a path for embedding in the `<image_files>` block. */
function escapeXmlAttr(s: string): string {
	return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/**
 * Builds the `<image_files>` XML block listing attached-image disk paths.
 *
 * The two intro sentences are verbatim from the deepdig evidence
 * (`docs/rea/deepdig-runtime-agent-loop-2026-10-19.md` §2 step 8).
 * HONEST DIVERGENCE: the doc elides the middle with "…", so the join and the
 * per-path list format (`- <path>` lines) are our reconstruction, not a
 * verbatim Cursor format.
 */
export function buildImageFilesXmlBlock(paths: readonly string[]): string {
	const lines = paths.map(p => `- ${p}`);
	return `<image_files>\n` +
		`The following images were provided by the user and saved to disk for future use. ` +
		`These files can be read with tools, copied to other locations, or attached to subagents using the file_attachments parameter.\n` +
		`${lines.map(escapeXmlAttr).join('\n')}\n` +
		`</image_files>`;
}

/**
 * Retention filter (pure): returns the names of entries older than
 * `retentionMs` relative to `nowMs`. The store deletes exactly these.
 */
export function filterStaleAttachments(
	entries: ReadonlyArray<{ readonly name: string; readonly mtimeMs: number }>,
	nowMs: number,
	retentionMs: number = IMAGE_ATTACHMENTS_RETENTION_MS,
): string[] {
	return entries
		.filter(e => Number.isFinite(e.mtimeMs) && nowMs - e.mtimeMs > retentionMs)
		.map(e => e.name);
}

/**
 * Builds the `<image_files>` XML block for the engine prompt from file
 * attachments. Attachments carry `file://` URIs (saved to disk by the image
 * attachment store); the block lists the disk paths so tools/subagents can
 * read them. Returns undefined when there are no resolvable file
 * attachments. `parseFileUri` is injected (base `URI.parse`) to keep this
 * module node-free.
 */
export function imageFilesXmlBlockFor(
	attachments: ReadonlyArray<{ readonly uri: string }> | undefined,
	parseFileUri: (uri: string) => { readonly fsPath: string },
): string | undefined {
	if (!attachments || attachments.length === 0) {
		return undefined;
	}
	const paths: string[] = [];
	for (const attachment of attachments) {
		if (typeof attachment.uri !== 'string' || !attachment.uri.startsWith('file://')) {
			continue;
		}
		try {
			const fsPath = parseFileUri(attachment.uri).fsPath;
			if (fsPath) {
				paths.push(fsPath);
			}
		} catch {
			// Malformed URI — skip, never fabricate a path.
		}
	}
	return paths.length > 0 ? buildImageFilesXmlBlock(paths) : undefined;
}
