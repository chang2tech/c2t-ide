/**
 * DEV-GAPS-15 test setup: stub extras that must exist on the `vscode` stub
 * BEFORE `../bugbotReviewService` is loaded.
 *
 * The compiled service does `__importStar(require("vscode"))`, which
 * snapshots the stub's TOP-LEVEL keys at import time — keys added later
 * (as the GAPS-10 test file does for nested objects) are invisible to the
 * service. So this module is imported FIRST in run-bugbot-gaps15-tests.ts
 * and installs the extra top-level keys up front. The shared vscode-stub.ts
 * file itself is left untouched (parallel-worker convention).
 */
import "./vscode-stub";
import { vscodeStub, windowStub } from "./vscode-stub";

const stubAny = vscodeStub as unknown as Record<string, unknown>;
const windowAny = windowStub as unknown as Record<string, unknown>;

// vscode.ViewColumn (missing from the shared stub).
stubAny["ViewColumn"] = { Active: -1, Beside: -2, One: 1, Two: 2 };

// vscode.ConfigurationTarget (missing from the shared stub).
stubAny["ConfigurationTarget"] = { Global: 1, Workspace: 2, WorkspaceFolder: 3 };

// createWebviewPanel mock: records panels, supports reveal + dispose.
export interface MockPanel {
  viewType: string;
  title: string;
  webview: { html: string };
  revealCount: number;
  disposed: boolean;
  disposeListeners: Array<() => void>;
  reveal: () => void;
  onDidDispose: (fn: () => void) => { dispose: () => void };
  dispose: () => void;
}
export const panels: MockPanel[] = [];
windowAny["createWebviewPanel"] = (
  viewType: string,
  title: string,
  _showOptions: unknown,
  _options: unknown,
) => {
  const panel: MockPanel = {
    viewType,
    title,
    webview: { html: "" },
    revealCount: 0,
    disposed: false,
    disposeListeners: [],
    reveal() {
      panel.revealCount++;
    },
    onDidDispose(fn: () => void) {
      panel.disposeListeners.push(fn);
      return { dispose: () => undefined };
    },
    dispose() {
      panel.disposed = true;
      for (const fn of panel.disposeListeners) fn();
    },
  };
  panels.push(panel);
  return panel;
};

// showQuickPick mock: canned pick, consumed per test via `nextPick`.
export let nextPick: { label: string; value: boolean } | undefined;
export function setNextPick(p: { label: string; value: boolean } | undefined) {
  nextPick = p;
}
windowAny["showQuickPick"] = (
  _items: Array<{ label: string; value: boolean }>,
  _options: unknown,
) => Promise.resolve(nextPick);
