/**
 * Minimal `vscode` module stub for node:test unit tests.
 *
 * Import this module FIRST (before any module that imports "vscode"); it
 * patches `Module.prototype.require` so `require("vscode")` returns the stub.
 * (Node 24 made `Module._load` getter-only, so the classic `_load` patch no
 * longer works; `Module.prototype.require` is the supported seam — every
 * CJS module's local `require` delegates to it.) Only the surface actually
 * touched by the units under test is implemented — EventEmitter plus the
 * window notification/output APIs.
 *
 * Usage (top of a run-*-tests.ts file, before other relative imports):
 *   import "./vscode-stub";
 */
import * as Module from "node:module";

type Listener<T> = (e: T) => void;

class StubEventEmitter<T> {
  private listeners: Listener<T>[] = [];
  get event(): (fn: Listener<T>) => { dispose(): void } {
    return (fn: Listener<T>) => {
      this.listeners.push(fn);
      return { dispose: () => undefined };
    };
  }
  fire(e: T): void {
    for (const fn of [...this.listeners]) {
      fn(e);
    }
  }
  dispose(): void {
    this.listeners = [];
  }
}

// GAPS-14: fire-able terminal event emitters for tests (the stub only
// exposed the .event accessors before, which cannot be fired).
const terminalDataEmitter = new StubEventEmitter<{ terminal: unknown; data: string }>();
const terminalCloseEmitter = new StubEventEmitter<unknown>();

const windowStub = {
  lastWarning: undefined as string | undefined,
  lastWarningItems: [] as string[],
  /** Canned answer for the next showWarningMessage call (consumed on use). */
  nextWarningChoice: undefined as string | undefined,
  showWarningMessage(message: string, ...items: string[]): Promise<string | undefined> {
    windowStub.lastWarning = message;
    windowStub.lastWarningItems = items;
    const choice = windowStub.nextWarningChoice;
    windowStub.nextWarningChoice = undefined;
    return Promise.resolve(choice);
  },
  /** Read and clear the last warning (avoids TS narrowing pitfalls in tests). */
  consumeWarning(): string | undefined {
    const w = windowStub.lastWarning;
    windowStub.lastWarning = undefined;
    return w;
  },
  /** Read and clear the last warning's action items. */
  consumeWarningItems(): string[] {
    const items = windowStub.lastWarningItems;
    windowStub.lastWarningItems = [];
    return items;
  },
  showInformationMessage(_message: string): void {
    /* stub */
  },
  // Extended for chat-editor tests: tests replace `tabGroups` as needed.
  tabGroups: { all: [], activeTabGroup: undefined } as {
    all: Array<{ activeTab?: { input?: unknown }; tabs: Array<{ input?: unknown }> }>;
    activeTabGroup?: { activeTab?: { input?: unknown }; tabs: Array<{ input?: unknown }> };
  },
  showErrorMessage(_message: string): void {
    /* stub */
  },
  // WORKER-GAPS-22A: loadEngineModels wraps the catalog load in
  // withProgress — the stub runs the task immediately (additive).
  async withProgress<R>(_options: unknown, task: () => Promise<R> | R): Promise<R> {
    return task();
  },
  createOutputChannel() {
    return {
      append(_v: string): void {
        /* stub */
      },
      appendLine(_v: string): void {
        /* stub */
      },
      dispose(): void {
        /* stub */
      },
    };
  },
  // Extended for shell-approval keyboard-flow tests (GAPS-14): minimal
  // terminal surface — TerminalService only needs createTerminal +
  // sendText + the two terminal event emitters.
  terminals: [] as Array<{
    name: string;
    creationOptions: Record<string, unknown>;
    sentTexts: Array<{ text: string; addNewLine: boolean }>;
    sendText(text: string, addNewLine?: boolean): void;
    dispose(): void;
  }>,
  createTerminal(options?: { name?: string; hideFromUser?: boolean }) {
    const term = {
      name: options?.name ?? "terminal",
      creationOptions: (options ?? {}) as Record<string, unknown>,
      sentTexts: [] as Array<{ text: string; addNewLine: boolean }>,
      sendText(text: string, addNewLine?: boolean): void {
        term.sentTexts.push({ text, addNewLine: addNewLine ?? true });
      },
      dispose(): void {
        /* stub */
      },
    };
    windowStub.terminals.push(term);
    return term;
  },
  onDidWriteTerminalData: terminalDataEmitter.event,
  onDidCloseTerminal: terminalCloseEmitter.event,
};

// GAPS-37B: configurable workspace configuration for unit tests. Overrides
// are additive — with none set, getConfiguration behaves exactly as before
// (returns the supplied default). Tests set values with __setConfig and
// clear them with __clearConfig; both are exported for test files.
const configOverrides = new Map<string, unknown>();
export function __setConfig(section: string, key: string, value: unknown): void {
  configOverrides.set(`${section}.${key}`, value);
}
export function __clearConfig(): void {
  configOverrides.clear();
}

const vscodeStub = {
  EventEmitter: StubEventEmitter,
  window: windowStub,
  workspace: {
    workspaceFolders: [] as Array<{ uri: { fsPath: string }; name: string }>,
    // DEV-GAPS-40: minimal FileSystemWatcher for SlashCommandService's
    // constructor (watchers are never fired in unit tests).
    createFileSystemWatcher(_pattern: unknown) {
      const noop = () => ({ dispose(): void {} });
      return { onDidChange: noop, onDidCreate: noop, onDidDelete: noop, dispose(): void {} };
    },
    getConfiguration(section?: string) {
      return {
        get: (key: string, def?: unknown) => {
          const full = section ? `${section}.${key}` : key;
          return configOverrides.has(full) ? configOverrides.get(full) : def;
        },
      };
    },
    // GAPS-11B: ComposerDataService.afterTurnCompleted calls saveAll() on a
    // clean turn finish (autosave setting default true) — stub it.
    async saveAll(): Promise<boolean> {
      return true;
    },
  },
  env: { language: "en" },
  Uri: {
    // WORKER-GAPS-22A: parse also reports the scheme (additive — the old
    // shape only had toString), so newAgent's folderUri file-scheme branch
    // is testable.
    parse: (s: string) => {
      const m = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(s);
      return { scheme: m ? m[1] : "", toString: () => s };
    },
    // Extended for chat-editor tests: minimal Uri with scheme/path.
    from: (parts: { scheme: string; path: string }) => ({
      scheme: parts.scheme,
      path: parts.path,
      toString: () => `${parts.scheme}:${parts.path}`,
    }),
  },
  // Extended for chat-editor tests: records executeCommand calls; tests may
  // replace `impl` to control behavior.
  commands: {
    calls: [] as Array<{ command: string; args: unknown[] }>,
    impl: null as null | ((command: string, ...args: unknown[]) => Promise<unknown>),
    async executeCommand(command: string, ...args: unknown[]): Promise<unknown> {
      (vscodeStub.commands.calls as Array<{ command: string; args: unknown[] }>).push({ command, args });
      const impl = (vscodeStub.commands as { impl: null | ((c: string, ...a: unknown[]) => Promise<unknown>) }).impl;
      return impl ? impl(command, ...args) : undefined;
    },
    // Extended for browserViewCommands tests: records registerCommand calls;
    // tests invoke handlers from `registrations`.
    registrations: [] as Array<{ id: string; handler: (...args: unknown[]) => unknown }>,
    registerCommand(id: string, handler: (...args: unknown[]) => unknown) {
      const rec = { id, handler };
      (vscodeStub.commands.registrations as Array<{ id: string; handler: (...args: unknown[]) => unknown }>).push(rec);
      return {
        dispose() {
          const arr = vscodeStub.commands.registrations as Array<{ id: string; handler: (...args: unknown[]) => unknown }>;
          const i = arr.indexOf(rec);
          if (i >= 0) {
            arr.splice(i, 1);
          }
        },
      };
    },
  },
  // Extended for chat-editor tests: minimal TabInputCustom for instanceof checks.
  TabInputCustom: class {
    constructor(
      readonly uri: unknown,
      readonly viewType: string,
    ) {}
  },
  // Extended for inbox tests: minimal tree-view surface (TreeDataProvider).
  TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
  // WORKER-GAPS-22A: loadEngineModels uses withProgress + ProgressLocation
  // (additive).
  ProgressLocation: { SourceControl: 1, Window: 10, Notification: 15 },
  TreeItem: class {
    description?: string;
    tooltip?: string;
    contextValue?: string;
    iconPath?: unknown;
    command?: { command: string; title: string; arguments?: unknown[] };
    constructor(
      readonly label: string,
      readonly collapsibleState: number = 0,
    ) {}
  },
  ThemeIcon: class {
    constructor(readonly id: string) {}
  },
  // Extended for onboarding checklist: tree-view checkbox states.
  TreeItemCheckboxState: { Unchecked: 0, Checked: 1 },
  // DEV-GAPS-40: minimal RelativePattern for SlashCommandService's
  // constructor (personal-dir watcher).
  RelativePattern: class {
    constructor(
      readonly base: unknown,
      readonly pattern: string,
    ) {}
  },
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const proto = Module.prototype as any;
const originalRequire = proto.require;
proto.require = function (this: unknown, request: string, ...rest: unknown[]) {
  if (request === "vscode") {
    return vscodeStub;
  }
  return originalRequire.call(this, request, ...rest);
};

export { vscodeStub, windowStub, terminalDataEmitter, terminalCloseEmitter };
