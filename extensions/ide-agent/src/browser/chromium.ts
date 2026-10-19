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
