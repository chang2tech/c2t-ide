/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// IDE-CODE: Disk store for user-attached composer images (node, electron-browser).
// Pure convention logic lives in ../common/imageAttachments.js (unit-tested
// node-free); this module does the fs work.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { randomBytes } from "node:crypto";
import {
  IMAGE_ATTACHMENTS_RETENTION_MS,
  IMAGE_ATTACHMENT_MAX_BYTES,
  filterStaleAttachments,
  imageAttachmentFilename,
  parseImageDataUrl,
  resolveImageAttachmentsDir,
} from "../common/imageAttachments.js";

export interface ISavedImageAttachment {
  /** Absolute disk path (referenced by the <image_files> XML block). */
  readonly filePath: string;
  /** File name. */
  readonly name: string;
  /** MIME type of the saved image. */
  readonly mimeType: string;
  /** Byte size of the saved image. */
  readonly byteLength: number;
}

export interface IImageAttachmentStoreOptions {
  /** Workspace folder fs path; undefined → home-dir fallback (see convention). */
  readonly workspaceFsPath?: string;
  /** Retention in ms; defaults to IMAGE_ATTACHMENTS_RETENTION_MS (14 days). */
  readonly retentionMs?: number;
  /** Clock override (tests). */
  readonly now?: () => number;
}

/**
 * Saves a user-attached image (data URL from the composer webview's
 * paste/drop handler) to the attachments dir and returns its disk path.
 * Prunes attachments older than the retention window afterwards.
 *
 * Throws when the payload is not a supported image data URL or exceeds the
 * size cap — callers surface the failure to the user instead of silently
 * dropping the attachment.
 */
export async function saveUserImageAttachment(
  dataUrl: string,
  opts: IImageAttachmentStoreOptions = {},
): Promise<ISavedImageAttachment> {
  const parsed = parseImageDataUrl(dataUrl);
  if (!parsed) {
    throw new Error("Not a supported image attachment (expected data:image/png|jpeg|webp|gif;base64, ≤15MB).");
  }
  const dir = resolveImageAttachmentsDir(opts.workspaceFsPath, os.homedir(), path.join);
  await fs.promises.mkdir(dir, { recursive: true });
  const name = imageAttachmentFilename(parsed.mimeType, new Date(), randomBytes(4).toString("hex"));
  const filePath = path.join(dir, name);
  const bytes = Buffer.from(parsed.base64, "base64");
  // Exact size check on the decoded bytes (parseImageDataUrl estimated).
  if (bytes.length === 0 || bytes.length > IMAGE_ATTACHMENT_MAX_BYTES) {
    throw new Error("Image attachment exceeds the 15MB size cap.");
  }
  await fs.promises.writeFile(filePath, bytes);
  // Opportunistic retention cleanup; never fails the save.
  await pruneImageAttachments(dir, opts.retentionMs ?? IMAGE_ATTACHMENTS_RETENTION_MS, opts.now).catch(() => undefined);
  return { filePath, name, mimeType: parsed.mimeType, byteLength: bytes.length };
}

/**
 * Deletes attachments in `dir` older than `retentionMs`. Returns the deleted
 * file names. Never throws for a missing dir.
 */
export async function pruneImageAttachments(
  dir: string,
  retentionMs: number = IMAGE_ATTACHMENTS_RETENTION_MS,
  now: () => number = Date.now,
): Promise<{ deleted: string[] }> {
  let dirents: fs.Dirent[];
  try {
    dirents = await fs.promises.readdir(dir, { withFileTypes: true });
  } catch {
    return { deleted: [] };
  }
  const nowMs = now();
  const entries: Array<{ name: string; mtimeMs: number }> = [];
  for (const dirent of dirents) {
    if (!dirent.isFile()) {
      continue;
    }
    try {
      const stat = await fs.promises.stat(path.join(dir, dirent.name));
      entries.push({ name: dirent.name, mtimeMs: stat.mtimeMs });
    } catch {
      // Race with concurrent deletes — skip.
    }
  }
  const stale = filterStaleAttachments(entries, nowMs, retentionMs);
  const deleted: string[] = [];
  for (const name of stale) {
    try {
      await fs.promises.unlink(path.join(dir, name));
      deleted.push(name);
    } catch {
      // Already gone — not an error.
    }
  }
  return { deleted };
}
