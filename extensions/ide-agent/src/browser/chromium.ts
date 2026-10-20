/**
 * Chromium resolution for the in-IDE browser tab — no vscode dependency,
 * unit-testable.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { randomBytes } from "node:crypto";

/** Where browser-tab screenshots are saved for chat attachments. */
export function browserCaptureDir(): string {
  return path.join(os.homedir(), ".ide-code", "browser-captures");
}

/**
 * agent-image-files-disk-convention (mirrors the core convention in
 * src/vs/workbench/contrib/composer/common/imageAttachments.ts until this
 * extension finishes migrating to core): user-attached composer images are
 * saved under <workspace>/.ide-code/attachments/ when a workspace folder is
 * open (so tools/subagents in the workspace can read them), otherwise
 * ~/.ide-code/attachments/. Never base64 in the context — the <image_files>
 * XML block lists the disk paths.
 */
export function userImageAttachmentsDir(workspaceFsPath?: string): string {
  if (workspaceFsPath) {
    return path.join(workspaceFsPath, ".ide-code", "attachments");
  }
  return path.join(os.homedir(), ".ide-code", "attachments");
}

const USER_IMAGE_MIME_TO_EXT: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
};

/** Max bytes per user-attached image (mirrors the core 15MB cap). */
export const USER_IMAGE_MAX_BYTES = 15 * 1024 * 1024;

/**
 * Saves a data-URL image attachment to the attachments dir. Returns the
 * absolute file path. Throws when the payload is not a supported image data
 * URL or exceeds the size cap — callers surface the failure to the user.
 */
export function saveUserImageDataUrl(dataUrl: string, workspaceFsPath?: string): string {
  const match = /^data:(image\/(?:png|jpeg|webp|gif));base64,([A-Za-z0-9+/=]+)$/.exec(
    typeof dataUrl === "string" ? dataUrl : "",
  );
  if (!match) {
    throw new Error("not a supported image attachment (expected data:image/png|jpeg|webp|gif;base64)");
  }
  const mimeType = match[1].toLowerCase();
  const ext = USER_IMAGE_MIME_TO_EXT[mimeType];
  if (!ext) {
    throw new Error(`unsupported image type: ${mimeType}`);
  }
  if (Math.floor(match[2].length * 3 / 4) > USER_IMAGE_MAX_BYTES) {
    throw new Error("image attachment exceeds the 15MB size cap");
  }
  const bytes = Buffer.from(match[2], "base64");
  if (bytes.length === 0 || bytes.length > USER_IMAGE_MAX_BYTES) {
    throw new Error("image attachment exceeds the 15MB size cap");
  }
  const dir = userImageAttachmentsDir(workspaceFsPath);
  fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const filePath = path.join(dir, `image-${stamp}-${randomBytes(4).toString("hex")}.${ext}`);
  fs.writeFileSync(filePath, bytes);
  return filePath;
}

/**
 * Unique screenshot filename: ISO timestamp + 8 random hex chars.
 * Two screenshots in the same millisecond must not share a filename
 * (QA-BROWSERTAB-01 P3 — the second would silently overwrite the first).
 */
export function screenshotFilename(now: Date = new Date()): string {
  const stamp = now.toISOString().replace(/[:.]/g, "-");
  const rand = randomBytes(4).toString("hex");
  return `browser-${stamp}-${rand}.png`;
}

/**
 * Resolve a Chromium executable: explicit setting first, then well-known
 * locations. Returns undefined when nothing is found (the tab then explains
 * honestly instead of pretending to browse).
 */
export function resolveChromiumPath(
  configured: string | undefined,
  exists: (p: string) => boolean = fs.existsSync,
): string | undefined {
  const explicit = (configured ?? "").trim();
  if (explicit) {
    try {
      if (exists(explicit)) return explicit;
    } catch {
      /* fall through to candidates */
    }
  }
  const candidates = [
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/opt/google/chrome/chrome",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  ];
  for (const c of candidates) {
    try {
      if (exists(c)) return c;
    } catch {
      /* ignore */
    }
  }
  return undefined;
}
