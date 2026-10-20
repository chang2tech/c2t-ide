/**
 * Minimal `vscode` runtime stub for plain-node tests.
 *
 * Imported for its side effect BEFORE any module that does
 * `require("vscode")` (e.g. `../service`). Intercepts `Module._load` so the
 * `vscode` request resolves to this in-memory stub instead of failing under
 * node. Only the members exercised by the units under test are faked.
 *
 * NOTE: the stub is deliberately tiny — add members only when a new test
 * needs them, and keep behaviour aligned with the real API's defaults.
 *
 * IMPLEMENTATION NOTE: `require("node:module")` is used directly (not
 * `import * as Module`) because TS's `__importStar` helper builds a
 * synthetic namespace object whose properties are getter-only — assigning
 * `Module._load` on it throws under Node 24.
 */
// eslint-disable-next-line @typescript-eslint/no-var-requires
const NodeModule = require("node:module") as typeof import("node:module");

interface FakeOutputChannel {
  name: string;
  appendLine(message: string): void;
  /** LogOutputChannel levels (Cursor creates MCP channels with `{log:!0}`). */
  trace(message: string): void;
  debug(message: string): void;
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
  show(): void;
  dispose(): void;
}

const makeOutputChannel = (name: string, _options?: { log?: boolean }): FakeOutputChannel => {
  const sink = (_message: string): void => {
    /* sink */
  };
  return {
    name,
    appendLine: sink,
    trace: sink,
    debug: sink,
    info: sink,
    warn: sink,
    error: sink,
    show(): void {
      /* no-op */
    },
    dispose(): void {
      /* no-op */
    },
  };
};

const vscodeStub = {
  workspace: {
    workspaceFolders: [] as Array<{ uri: { fsPath: string } }>,
    getConfiguration(_section?: string) {
      return {
        get<T>(key: string, defaultValue: T): T {
          void key;
          return defaultValue;
        },
      };
    },
    createFileSystemWatcher() {
      return {
        onDidChange() {
          /* no-op */
        },
        onDidCreate() {
          /* no-op */
        },
        onDidDelete() {
          /* no-op */
        },
        dispose() {
          /* no-op */
        },
      };
    },
  },
  window: {
    createOutputChannel: (name: string, options?: { log?: boolean }) => makeOutputChannel(name, options),
    showWarningMessage: async (message: string, ..._args: unknown[]) => takeMessageChoice(message),
    showInformationMessage: async (message: string, ..._args: unknown[]) => takeMessageChoice(message),
    showErrorMessage: async (message: string, ..._args: unknown[]) => takeMessageChoice(message),
    showQuickPick: async (_items: unknown, _options?: unknown) => undefined,
    showInputBox: async (_options?: unknown) => undefined,
  },
  env: {
    openExternal: async (_uri: unknown) => true,
  },
  Uri: {
    parse: (value: string) => ({ toString: () => value, fsPath: value, scheme: "https" }),
  },
  commands: {
    registerCommand: () => ({ dispose: () => undefined }),
  },
  Disposable: class {
    constructor(private readonly fn: () => void) {}
    dispose(): void {
      this.fn();
    }
  },
};

const mod = NodeModule as unknown as {
  _load: (request: string, parent: unknown, isMain: boolean) => unknown;
};
const originalLoad = mod._load.bind(mod);
mod._load = function (request: string, parent: unknown, isMain: boolean): unknown {
  if (request === "vscode") {
    return vscodeStub;
  }
  return originalLoad(request, parent, isMain);
};

/**
 * Test control for message-box stubs: set `nextMessageChoice` to the button
 * label a test wants the next `show*Message` call to "click". Consumed once.
 */
export const vscodeStubControls = {
  nextMessageChoice: undefined as string | undefined,
  /** Every message-box call is recorded here (message + chosen label). */
  shownMessages: [] as Array<{ message: string; choice: string | undefined }>,
};

function takeMessageChoice(message?: string): Promise<string | undefined> {
  const choice = vscodeStubControls.nextMessageChoice;
  vscodeStubControls.nextMessageChoice = undefined;
  vscodeStubControls.shownMessages.push({ message: String(message), choice });
  return Promise.resolve(choice);
}

export { vscodeStub };
