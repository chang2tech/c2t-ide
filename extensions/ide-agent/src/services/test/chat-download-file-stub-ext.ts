/**
 * Pre-service stub extensions for the chat-download-file tests.
 *
 * `chatDownloadFileService` reads `vscode.FileType` at call time, but tsc's
 * `__importStar(require("vscode"))` snapshots the stub's KEYS when the
 * service module loads. Keys added to the stub afterwards (e.g. by the test
 * file's top-level statements, which run after the service import) are
 * invisible to the service. So `FileType` must exist on the stub BEFORE
 * `chatDownloadFileService` is imported — this module runs first.
 *
 * Import order in run-chat-download-file-tests.ts:
 *   "./vscode-stub" → "./chat-download-file-stub-ext" → "../chatDownloadFileService"
 */
import "./vscode-stub";
import { vscodeStub } from "./vscode-stub";

type Mutable = Record<string, unknown>;

asMutable(vscodeStub).FileType = { File: 1, Directory: 2, SymbolicLink: 64, Unknown: 0 };

function asMutable(v: unknown): Mutable {
  return v as Mutable;
}
