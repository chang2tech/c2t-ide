/**
 * ChatDownloadFileService — "Download File" for file links in the agent's chat.
 *
 * CURSOR EVIDENCE (do NOT claim beyond this):
 * - cursor.com/docs/release-notes: "Right-click a file link in an agent's
 *   chat and choose Download File to save a local copy, with ~/Downloads
 *   as the default. It also works for files a cloud agent built in its
 *   workspace."
 * - That is the ENTIRE evidence base. The release-notes sentence proves the
 *   menu item title ("Download File"), the trigger (right-click a file link
 *   in an agent's chat), the default target (~/Downloads), and that it
 *   produces a local copy. It does NOT describe Cursor's internal
 *   implementation (dialog flow, error messages, overwrite behavior).
 *
 * DIVERGENCE — cloud agent workspace:
 * - The release-notes line mentions "files a cloud agent built in its
 *   workspace". This IDE is local-first: there is no cloud-agent workspace
 *   in our product, so that part is NOT_APPLICABLE here. This module only
 *   handles LOCAL file links (file:// URIs and local filesystem paths).
 *   Remote/HTTP/cloud-scheme links are rejected explicitly.
 *
 * What this module does:
 * - defaultDownloadDir(): ~/Downloads (the documented default).
 * - resolveFileLinkToLocalPath(link): pure resolution of a chat file-link
 *   (file:// URI or local path) to an absolute filesystem path; returns
 *   undefined for unsupported (remote/cloud) schemes.
 * - safeDownloadFileName(sourcePath): basename-only extraction so a
 *   malicious/absent link can never escape the target directory
 *   (path-traversal guard).
 * - registerChatDownloadFileCommand(context): registers `ide.chatDownloadFile`.
 *   The command takes the file link (string or vscode.Uri) — supplied by the
 *   chat webview's context menu — shows a save dialog defaulting to
 *   ~/Downloads/<name> (user may pick another location), copies the file,
 *   and reports errors (missing file, folders, permission denied,
 *   unsupported link) via error messages.
 *
 * UNKNOWN (our choices, not Cursor-verified): the save-dialog UX (Cursor
 * may download silently into ~/Downloads without asking), overwrite prompt
 * behavior, and exact wording of any messages. The dialog-with-default
 * approach is chosen so the user can redirect the copy; the documented
 * default is always pre-filled.
 */
import * as vscode from "vscode";
import * as os from "os";
import * as path from "path";

/** Command id registered in package.json ("Download File"). */
export const CHAT_DOWNLOAD_FILE_COMMAND = "ide.chatDownloadFile";

/** Default download location: ~/Downloads (per the release-notes evidence). */
export function defaultDownloadDir(): string {
  return path.join(os.homedir(), "Downloads");
}

/**
 * Extract a safe file name from a source path. Only the final path segment
 * is ever used, so a link like "../../secret" or an absolute path can never
 * make the download land outside the chosen directory.
 *
 * NOTE: both "/" and "\\" are treated as separators on every platform.
 * Link strings are attacker-influenced input (they come from chat content),
 * so a Windows-style "..\..\secret" must not survive as a single file name
 * on POSIX hosts either. Empty results fall back to "download".
 */
export function safeDownloadFileName(sourcePath: string): string {
  const trimmed = (sourcePath ?? "").trim();
  if (!trimmed) {
    return "download";
  }
  const segments = trimmed.split(/[\\/]+/).filter(Boolean);
  const base = segments.length > 0 ? segments[segments.length - 1] : "";
  const clean = base.replace(/^\.+/, "").trim();
  return clean || "download";
}

/**
 * Resolve a chat file-link to an absolute local filesystem path.
 *
 * - "file://..." URIs → fsPath.
 * - Plain local paths (absolute or workspace-relative) → path.resolve.
 * - Anything else (http/https, cloud-agent workspace schemes such as
 *   "cloud://..." or Cursor remote links) → undefined.
 *
 * DIVERGENCE: cloud-agent workspace links are explicitly NOT_APPLICABLE for
 * this local-first IDE, so they are rejected rather than fetched.
 */
export function resolveFileLinkToLocalPath(link: string | vscode.Uri | undefined | null): string | undefined {
  if (link == null) {
    return undefined;
  }
  if (typeof link !== "string") {
    // A vscode.Uri object (the webview may pass one directly).
    return link.scheme === "file" ? link.fsPath : undefined;
  }
  const trimmed = link.trim();
  if (!trimmed) {
    return undefined;
  }
  if (trimmed.startsWith("file://")) {
    try {
      return vscode.Uri.parse(trimmed).fsPath;
    } catch {
      return undefined;
    }
  }
  // Remote or cloud-workspace scheme → not supported locally.
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(trimmed)) {
    return undefined;
  }
  return path.resolve(trimmed);
}

/**
 * Dependencies for the download command. Production uses vscode directly;
 * the structural type keeps the command body testable.
 */
export interface ChatDownloadFileDeps {
  /** Home directory; default os.homedir(). Exposed for tests. */
  homedir?: () => string;
}

/**
 * Register the `ide.chatDownloadFile` command ("Download File").
 *
 * Invocation: `vscode.commands.executeCommand("ide.chatDownloadFile", link)`
 * where `link` is the file link the user right-clicked in the chat webview
 * (string path, file:// URI string, or vscode.Uri).
 *
 * Flow: resolve link → verify it is an existing regular file → save dialog
 * (default ~/Downloads/<name>; user may choose elsewhere) → copy →
 * information message. Missing files, folders, unsupported links and
 * copy failures surface as error messages.
 */
export function registerChatDownloadFileCommand(
  context: vscode.ExtensionContext,
  deps: ChatDownloadFileDeps = {},
): void {
  async function downloadFile(link: string | vscode.Uri | undefined): Promise<void> {
    const home = (deps.homedir ?? os.homedir)();
    const sourcePath = resolveFileLinkToLocalPath(link);
    if (!sourcePath) {
      void vscode.window.showErrorMessage(
        "IDE Agent: cannot download this file — only local file links are supported.",
      );
      return;
    }

    let stat: vscode.FileStat;
    try {
      stat = await vscode.workspace.fs.stat(vscode.Uri.file(sourcePath));
    } catch {
      void vscode.window.showErrorMessage(`IDE Agent: cannot download — file not found: ${sourcePath}`);
      return;
    }
    if (stat.type === vscode.FileType.Directory) {
      void vscode.window.showErrorMessage(`IDE Agent: cannot download — this is a folder, not a file: ${sourcePath}`);
      return;
    }

    const fileName = safeDownloadFileName(sourcePath);
    const defaultUri = vscode.Uri.file(path.join(home, "Downloads", fileName));
    const target = await vscode.window.showSaveDialog({
      defaultUri,
      saveLabel: "Download File",
      title: "Download File",
    });
    if (!target) {
      return; // user cancelled
    }

    try {
      await vscode.workspace.fs.copy(vscode.Uri.file(sourcePath), target, { overwrite: true });
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      if (/EACCES|EPERM|denied/i.test(reason)) {
        void vscode.window.showErrorMessage(
          `IDE Agent: permission denied while downloading to ${target.fsPath}. Choose a writable location.`,
        );
      } else {
        void vscode.window.showErrorMessage(`IDE Agent: download failed: ${reason}`);
      }
      return;
    }

    void vscode.window.showInformationMessage(`IDE Agent: downloaded to ${target.fsPath}`);
  }

  context.subscriptions.push(
    vscode.commands.registerCommand(CHAT_DOWNLOAD_FILE_COMMAND, (link: string | vscode.Uri | undefined) =>
      void downloadFile(link),
    ),
  );
}
