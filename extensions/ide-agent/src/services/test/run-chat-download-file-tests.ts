/**
 * Chat Download File tests (node:test, vscode stubbed via ./vscode-stub).
 *
 * Covers:
 * - defaultDownloadDir: ends in /Downloads under the home directory.
 * - safeDownloadFileName: basename-only; strips ".." segments, separators,
 *   trailing slashes; falls back to "download" for empty input.
 * - resolveFileLinkToLocalPath: file:// URIs, plain paths, vscode.Uri
 *   objects; rejects http/https/cloud schemes and empty links.
 * - registerChatDownloadFileCommand: registers exactly `ide.chatDownloadFile`;
 *   save dialog defaults to ~/Downloads/<name>; copy lands where the user
 *   picks (default or custom dir); missing file / folder / unsupported link
 *   surface errors and perform no copy; dialog cancel performs no copy;
 *   copy permission failures surface a permission error; success shows an
 *   information message.
 *
 * Run after `tsc`:  node --test out/services/test/run-chat-download-file-tests.js
 */
import { describe, it, beforeEach } from "node:test";
import * as assert from "node:assert";
import * as os from "node:os";
import * as path from "node:path";
import "./vscode-stub";
import "./chat-download-file-stub-ext";
import { vscodeStub } from "./vscode-stub";
import {
  CHAT_DOWNLOAD_FILE_COMMAND,
  defaultDownloadDir,
  registerChatDownloadFileCommand,
  resolveFileLinkToLocalPath,
  safeDownloadFileName,
} from "../chatDownloadFileService";

type Mutable = Record<string, unknown>;
const asMutable = (v: unknown): Mutable => v as Mutable;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// Runtime seam extensions on the vscode stub (untouched vscode-stub.ts).
// ---------------------------------------------------------------------------

const registered = new Map<string, (...args: unknown[]) => unknown>();

// commands.registerCommand
asMutable(vscodeStub.commands).registerCommand = (id: string, fn: (...args: unknown[]) => unknown) => {
  registered.set(id, fn);
  return { dispose(): void { /* stub */ } };
};

// Uri.file / Uri.parse — parse decodes file:// URIs into fsPath.
// (FileType is set earlier by ./chat-download-file-stub-ext, which must run
// before the service module loads — see that file.)
const uriMutable = asMutable((vscodeStub as Mutable).Uri);
uriMutable.file = (p: string) => ({ scheme: "file", fsPath: p, toString: () => `file://${p}` });
uriMutable.parse = (s: string) => {
  if (s.startsWith("file://")) {
    const fsPath = decodeURIComponent(s.slice("file://".length));
    return { scheme: "file", fsPath, toString: () => s };
  }
  throw new Error(`unsupported scheme in stub parse: ${s}`);
};

// (FileType is set earlier by ./chat-download-file-stub-ext, which must run
// before the service module loads — see that file.)

// window.showSaveDialog / messages — canned answers, replaceable per test.
const windowMutable = asMutable((vscodeStub as Mutable).window);
windowMutable.lastSaveDialogOptions = undefined as unknown;
windowMutable.nextSaveUri = undefined as unknown;
windowMutable.lastInfoMessage = undefined as unknown;
windowMutable.lastErrorMessage = undefined as unknown;
windowMutable.showSaveDialog = async (options: unknown) => {
  windowMutable.lastSaveDialogOptions = options;
  const uri = windowMutable.nextSaveUri;
  windowMutable.nextSaveUri = undefined;
  return uri;
};
windowMutable.showInformationMessage = (message: string): void => {
  windowMutable.lastInfoMessage = message;
};
windowMutable.showErrorMessage = (message: string): void => {
  windowMutable.lastErrorMessage = message;
};

// workspace.fs.stat / copy — canned per test.
const workspaceMutable = asMutable((vscodeStub as Mutable).workspace);
type StatResult = { type: number } | { error: string };
const statResults = new Map<string, StatResult>();
const copies: Array<{ from: string; to: string }> = [];
let copyError: Error | undefined;
workspaceMutable.fs = {
  async stat(uri: { fsPath: string }): Promise<{ type: number }> {
    const r = statResults.get(uri.fsPath);
    if (!r) {
      throw Object.assign(new Error(`ENOENT: no such file, stat '${uri.fsPath}'`), { code: "ENOENT" });
    }
    if ("error" in r) {
      throw new Error(r.error);
    }
    return { type: r.type };
  },
  async copy(from: { fsPath: string }, to: { fsPath: string }): Promise<void> {
    if (copyError) {
      const e = copyError;
      copyError = undefined;
      throw e;
    }
    copies.push({ from: from.fsPath, to: to.fsPath });
  },
};

function fakeContext(): { subscriptions: Array<{ dispose(): void }> } {
  return { subscriptions: [] };
}

const HOME = "/home/testuser";

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("defaultDownloadDir", () => {
  it("resolves to ~/Downloads under the real home directory", () => {
    assert.equal(defaultDownloadDir(), path.join(os.homedir(), "Downloads"));
  });
});

describe("safeDownloadFileName", () => {
  it("returns the basename for a normal path", () => {
    assert.equal(safeDownloadFileName("/work/report.pdf"), "report.pdf");
  });

  it("strips traversal segments so the name can never escape the target dir", () => {
    assert.equal(safeDownloadFileName("../../etc/passwd"), "passwd");
    assert.equal(safeDownloadFileName("..\\..\\secret.txt"), "secret.txt");
    assert.equal(safeDownloadFileName("/abs/path/../../x.js"), "x.js");
  });

  it("handles trailing separators and dot-only names", () => {
    assert.equal(safeDownloadFileName("/work/folder/"), "folder");
    assert.equal(safeDownloadFileName("..."), "download");
  });

  it("falls back to 'download' for empty input", () => {
    assert.equal(safeDownloadFileName(""), "download");
    assert.equal(safeDownloadFileName("   "), "download");
  });
});

describe("resolveFileLinkToLocalPath", () => {
  it("resolves file:// URIs to fs paths", () => {
    assert.equal(resolveFileLinkToLocalPath("file:///work/a.ts"), "/work/a.ts");
    assert.equal(resolveFileLinkToLocalPath("file:///C:/work/a.ts"), "/C:/work/a.ts");
  });

  it("resolves plain local paths", () => {
    assert.equal(resolveFileLinkToLocalPath("/work/a.ts"), path.resolve("/work/a.ts"));
  });

  it("rejects remote and cloud-workspace schemes (DIVERGENCE: local-first only)", () => {
    assert.equal(resolveFileLinkToLocalPath("https://example.com/a.ts"), undefined);
    assert.equal(resolveFileLinkToLocalPath("http://example.com/a.ts"), undefined);
    assert.equal(resolveFileLinkToLocalPath("cloud://agent-workspace/a.ts"), undefined);
  });

  it("rejects empty and missing links", () => {
    assert.equal(resolveFileLinkToLocalPath(""), undefined);
    assert.equal(resolveFileLinkToLocalPath("   "), undefined);
    assert.equal(resolveFileLinkToLocalPath(undefined), undefined);
    assert.equal(resolveFileLinkToLocalPath(null), undefined);
  });
});

describe("registerChatDownloadFileCommand", () => {
  beforeEach(() => {
    registered.clear();
    statResults.clear();
    copies.length = 0;
    copyError = undefined;
    windowMutable.nextSaveUri = undefined;
    windowMutable.lastSaveDialogOptions = undefined;
    windowMutable.lastInfoMessage = undefined;
    windowMutable.lastErrorMessage = undefined;
    const ctx = fakeContext();
    registerChatDownloadFileCommand(ctx as never, { homedir: () => HOME });
    assert.equal(ctx.subscriptions.length, 1);
  });

  function command(): (link: unknown) => unknown {
    const fn = registered.get(CHAT_DOWNLOAD_FILE_COMMAND);
    assert.ok(fn, `command ${CHAT_DOWNLOAD_FILE_COMMAND} must be registered`);
    return fn as (link: unknown) => unknown;
  }

  it("registers exactly the ide.chatDownloadFile id", () => {
    assert.equal(CHAT_DOWNLOAD_FILE_COMMAND, "ide.chatDownloadFile");
    assert.ok(registered.has("ide.chatDownloadFile"));
    assert.equal(registered.size, 1);
  });

  it("defaults the save dialog to ~/Downloads/<name> and copies there", async () => {
    statResults.set("/work/report.pdf", { type: 1 });
    // User accepts the default: dialog returns the default URI it was given.
    windowMutable.nextSaveUri = undefined; // dialog is stubbed below
    const realShowSave = windowMutable.showSaveDialog;
    windowMutable.showSaveDialog = async (options: unknown) => {
      windowMutable.lastSaveDialogOptions = options;
      const opts = asMutable(options);
      return opts.defaultUri as never; // user accepts the pre-filled default
    };
    try {
      await command()("/work/report.pdf");
      await sleep(10);
    } finally {
      windowMutable.showSaveDialog = realShowSave;
    }
    const opts = asMutable(windowMutable.lastSaveDialogOptions);
    const defaultUri = asMutable(opts.defaultUri) as { fsPath: string };
    assert.equal(defaultUri.fsPath, path.join(HOME, "Downloads", "report.pdf"));
    assert.equal((opts.saveLabel as string), "Download File");
    assert.equal(copies.length, 1);
    assert.equal(copies[0].from, "/work/report.pdf");
    assert.equal(copies[0].to, path.join(HOME, "Downloads", "report.pdf"));
    assert.ok(
      String(windowMutable.lastInfoMessage).includes(path.join(HOME, "Downloads", "report.pdf")),
      "success info message names the target",
    );
  });

  it("copies to a custom directory when the user picks one", async () => {
    statResults.set("/work/report.pdf", { type: 1 });
    windowMutable.nextSaveUri = { scheme: "file", fsPath: "/custom/dir/renamed.pdf", toString: () => "file:///custom/dir/renamed.pdf" };
    await command()("/work/report.pdf");
    await sleep(10);
    assert.equal(copies.length, 1);
    assert.equal(copies[0].to, "/custom/dir/renamed.pdf");
    assert.ok(String(windowMutable.lastInfoMessage).includes("/custom/dir/renamed.pdf"));
  });

  it("shows an error and performs no copy when the file is missing", async () => {
    await command()("/work/gone.pdf");
    await sleep(10);
    assert.equal(copies.length, 0);
    assert.ok(String(windowMutable.lastErrorMessage).includes("file not found"));
  });

  it("shows an error and performs no copy for a folder link", async () => {
    statResults.set("/work/folder", { type: 2 });
    await command()("/work/folder");
    await sleep(10);
    assert.equal(copies.length, 0);
    assert.ok(String(windowMutable.lastErrorMessage).includes("folder"));
  });

  it("shows an error for unsupported (remote/cloud) links", async () => {
    await command()("https://example.com/a.ts");
    await sleep(10);
    assert.equal(copies.length, 0);
    assert.ok(String(windowMutable.lastErrorMessage).includes("only local file links"));
  });

  it("does nothing when the save dialog is cancelled", async () => {
    statResults.set("/work/report.pdf", { type: 1 });
    windowMutable.nextSaveUri = undefined; // cancel
    await command()("/work/report.pdf");
    await sleep(10);
    assert.equal(copies.length, 0);
    assert.equal(windowMutable.lastErrorMessage, undefined);
    assert.equal(windowMutable.lastInfoMessage, undefined);
  });

  it("surfaces a permission error when the copy fails with EACCES", async () => {
    statResults.set("/work/report.pdf", { type: 1 });
    windowMutable.nextSaveUri = { scheme: "file", fsPath: "/root-only/report.pdf", toString: () => "file:///root-only/report.pdf" };
    copyError = Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" });
    await command()("/work/report.pdf");
    await sleep(10);
    assert.equal(copies.length, 0);
    assert.ok(String(windowMutable.lastErrorMessage).includes("permission denied"));
  });

  it("path-traversal link cannot make the default target escape ~/Downloads", async () => {
    const tricky = "/work/../../etc/passwd";
    statResults.set(path.resolve(tricky), { type: 1 });
    const realShowSave = windowMutable.showSaveDialog;
    windowMutable.showSaveDialog = async (options: unknown) => {
      windowMutable.lastSaveDialogOptions = options;
      return (asMutable(options).defaultUri as never); // accept default
    };
    try {
      await command()(tricky);
      await sleep(10);
    } finally {
      windowMutable.showSaveDialog = realShowSave;
    }
    assert.equal(copies.length, 1);
    assert.equal(path.dirname(copies[0].to), path.join(HOME, "Downloads"));
    assert.equal(path.basename(copies[0].to), "passwd");
  });
});
