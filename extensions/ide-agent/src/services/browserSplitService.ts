/**
 * browser-split-tab — Split browser tab into editor groups.
 *
 * Cursor parity (binary evidence: Cursor 3.25.6, workbench.glass.main.js):
 * workbench commands 'browser.splitEditorWithNewBrowserTab' and
 * 'browser.splitEditorWithNewBrowserTabToDirection' are registered; the former
 * "splits the active cursor-browser editor into a new browser tab in another
 * group". The binary evidence covers the command ids and that one-line
 * behavior only — Cursor's exact internal mechanics (duplicate tab vs. new
 * navigation, history/session sharing, which group "another group" means) are
 * UNKNOWN and are not claimed here.
 *
 * Extension-level implementation (this fork):
 * - Detection of the active browser tab uses the vscode.window API
 *   (window.tabGroups). The ide-agent legacy webview tab is identified by its
 *   viewType "ideAgent.browserTab" (see src/browser/browserTab.ts). The fork's
 *   NATIVE browser editor (workbench.editor.browser) maps to
 *   TabInputKind.UnknownInput in mainThreadEditorTabs.ts, so it is NOT
 *   identifiable through the public tabGroups API — UNKNOWN/limitation, see
 *   below; callers may inject `isActiveBrowserTab` to cover it.
 * - The new tab is opened through the fork's real command
 *   'workbench.action.browser.open' (BrowserViewCommandId.Open), which accepts
 *   a URL string or { url, openToSide } (IOpenBrowserOptions). This is the same
 *   command extension.ts already uses for 'ide.openBrowserTab', and it opens
 *   the native Integrated Browser tab (the Cursor-equivalent path).
 * - The current page URL of the source tab is NOT readable through the public
 *   vscode API: the webview tab keeps it in BrowserService session state
 *   (private to BrowserTabManager) and the native tab input is opaque to
 *   extensions. So the URL is supplied via the injectable
 *   `getActiveBrowserTabUrl` dep (wiring note at the bottom). Without it the
 *   split opens a blank tab — the command still works, it just can't preserve
 *   the URL.
 *
 * WIRING (1 line, in extension.ts activate, next to the other browser tab
 * command registrations):
 *   registerBrowserSplitCommands(context, { getActiveBrowserTabUrl: () => browserTabs.getCurrentUrl?.() });
 * (requires a follow-up exposing the current URL on BrowserTabManager; until
 * then pass no deps — the commands register and work, opening blank tabs.)
 */
import * as vscode from "vscode";

/** Cursor workbench command: split the active browser editor into a new browser tab in another group. */
export const SPLIT_BROWSER_TAB_COMMAND = "browser.splitEditorWithNewBrowserTab";
/** Cursor workbench command: same, but into the group in the given direction. */
export const SPLIT_BROWSER_TAB_TO_DIRECTION_COMMAND = "browser.splitEditorWithNewBrowserTabToDirection";

/** viewType of the ide-agent legacy webview browser tab (src/browser/browserTab.ts). */
export const IDE_AGENT_BROWSER_TAB_VIEW_TYPE = "ideAgent.browserTab";

/** Fork command that opens the native Integrated Browser tab (BrowserViewCommandId.Open). */
const OPEN_BROWSER_COMMAND = "workbench.action.browser.open";

export type SplitDirection = "up" | "down" | "left" | "right";

export type SplitResult =
  | "split"
  | "not-a-browser-tab"
  | "invalid-direction";

/**
 * Injectable pieces the host (extension.ts) provides. Everything else runs on
 * the vscode API so this module stays unit-testable without a workbench.
 */
export interface BrowserSplitDeps {
  /**
   * URL of the currently active browser tab, or undefined when unknown.
   * Default: undefined (not readable via the public vscode API — see header).
   */
  getActiveBrowserTabUrl?: () => string | undefined | Promise<string | undefined>;
  /**
   * Whether the active editor is a browser tab. Default: true only for the
   * ide-agent webview tab (viewType check); the fork native browser tab is
   * opaque to tabGroups (UnknownInput) — UNKNOWN limitation, inject to cover.
   */
  isActiveBrowserTab?: () => boolean;
}

/** Minimal vscode surface this module touches (faked in tests). */
export interface BrowserSplitHost {
  getActiveTabInput(): unknown;
  executeCommand(command: string, ...args: unknown[]): Promise<unknown>;
  showInformationMessage(message: string): void;
  registerCommand(id: string, handler: (...args: unknown[]) => unknown): vscode.Disposable;
}

/** True when the tab input belongs to the ide-agent webview browser tab. */
export function isIdeAgentWebviewBrowserTab(input: unknown): boolean {
  if (typeof input !== "object" || input === null) return false;
  return (input as { viewType?: unknown }).viewType === IDE_AGENT_BROWSER_TAB_VIEW_TYPE;
}

function defaultHost(): BrowserSplitHost {
  return {
    getActiveTabInput: () => {
      try {
        const groups = vscode.window.tabGroups;
        return groups?.activeTabGroup?.activeTab?.input;
      } catch {
        return undefined;
      }
    },
    executeCommand: async (command: string, ...args: unknown[]) =>
      vscode.commands.executeCommand(command, ...args),
    showInformationMessage: (message: string) => {
      void vscode.window.showInformationMessage(message);
    },
    registerCommand: (id: string, handler: (...args: unknown[]) => unknown) =>
      vscode.commands.registerCommand(id, handler),
  };
}

function resolveDeps(deps: BrowserSplitDeps | undefined, host: BrowserSplitHost): Required<BrowserSplitDeps> {
  return {
    getActiveBrowserTabUrl: deps?.getActiveBrowserTabUrl ?? (() => undefined),
    isActiveBrowserTab:
      deps?.isActiveBrowserTab ?? (() => isIdeAgentWebviewBrowserTab(host.getActiveTabInput())),
  };
}

/**
 * Normalize the direction argument. Accepts "up" | "down" | "left" | "right"
 * (case-insensitive) or { direction: ... }. Missing arg defaults to "right"
 * (the same default as VS Code's own split/move commands). Anything else
 * yields undefined.
 */
export function normalizeSplitDirection(arg: unknown): SplitDirection | undefined {
  // Missing argument (or an options object without `direction`) → default.
  // A present-but-wrong-typed value is invalid, NOT missing.
  let raw: unknown;
  let missing: boolean;
  if (typeof arg === "string") {
    raw = arg;
    missing = false;
  } else if (arg === undefined || arg === null) {
    raw = undefined;
    missing = true;
  } else if (typeof arg === "object") {
    raw = (arg as { direction?: unknown }).direction;
    missing = raw === undefined || raw === null;
  } else {
    raw = arg;
    missing = false;
  }
  if (missing) return "right";
  if (typeof raw !== "string") return undefined;
  const d = raw.toLowerCase();
  return d === "up" || d === "down" || d === "left" || d === "right" ? d : undefined;
}

const MOVE_COMMAND_BY_DIRECTION: Record<SplitDirection, string> = {
  up: "workbench.action.moveEditorToAboveGroup",
  down: "workbench.action.moveEditorToBelowGroup",
  left: "workbench.action.moveEditorToLeftGroup",
  right: "workbench.action.moveEditorToRightGroup",
};

async function requireBrowserTab(
  resolved: Required<BrowserSplitDeps>,
  host: BrowserSplitHost,
): Promise<boolean> {
  let ok = false;
  try {
    ok = resolved.isActiveBrowserTab();
  } catch {
    ok = false;
  }
  if (!ok) {
    host.showInformationMessage("Split browser tab is only available on a browser tab.");
    return false;
  }
  return true;
}

/**
 * Implements 'browser.splitEditorWithNewBrowserTab': opens a new browser tab
 * with the active tab's URL in another group (openToSide).
 */
export async function splitBrowserTab(
  deps?: BrowserSplitDeps,
  host: BrowserSplitHost = defaultHost(),
): Promise<SplitResult> {
  const resolved = resolveDeps(deps, host);
  if (!(await requireBrowserTab(resolved, host))) return "not-a-browser-tab";
  const url = await resolved.getActiveBrowserTabUrl();
  // { openToSide: true } → fork opens in the side group (getPreferredGroup(SIDE_GROUP)).
  await host.executeCommand(OPEN_BROWSER_COMMAND, { url, openToSide: true });
  return "split";
}

/**
 * Implements 'browser.splitEditorWithNewBrowserTabToDirection': opens a new
 * browser tab with the active tab's URL, then moves it into the group in the
 * given direction. UNKNOWN (beyond the command ids, the binary evidence does
 * not pin down Cursor's exact direction mechanics) — this is the faithful
 * extension-level equivalent built from public workbench commands.
 */
export async function splitBrowserTabToDirection(
  directionArg: unknown,
  deps?: BrowserSplitDeps,
  host: BrowserSplitHost = defaultHost(),
): Promise<SplitResult> {
  const resolved = resolveDeps(deps, host);
  if (!(await requireBrowserTab(resolved, host))) return "not-a-browser-tab";
  const direction = normalizeSplitDirection(directionArg);
  if (!direction) {
    host.showInformationMessage(
      'Split browser tab: direction must be "up", "down", "left" or "right".',
    );
    return "invalid-direction";
  }
  const url = await resolved.getActiveBrowserTabUrl();
  // The newly opened browser tab becomes the active editor; moving the active
  // editor into the directional group places the new tab where asked.
  await host.executeCommand(OPEN_BROWSER_COMMAND, { url });
  await host.executeCommand(MOVE_COMMAND_BY_DIRECTION[direction]);
  return "split";
}

/**
 * Register both commands on the extension context. Returns the registered
 * command ids.
 */
export function registerBrowserSplitCommands(
  context: vscode.ExtensionContext,
  deps?: BrowserSplitDeps,
  host: BrowserSplitHost = defaultHost(),
): string[] {
  const d1 = host.registerCommand(SPLIT_BROWSER_TAB_COMMAND, () => splitBrowserTab(deps, host));
  const d2 = host.registerCommand(SPLIT_BROWSER_TAB_TO_DIRECTION_COMMAND, (arg: unknown) =>
    splitBrowserTabToDirection(arg, deps, host),
  );
  context.subscriptions.push(d1, d2);
  return [SPLIT_BROWSER_TAB_COMMAND, SPLIT_BROWSER_TAB_TO_DIRECTION_COMMAND];
}
