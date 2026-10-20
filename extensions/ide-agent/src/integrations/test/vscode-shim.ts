/**
 * Minimal `vscode` runtime stub for the integrations tests (plain node).
 *
 * Mirrors `src/mcp/test/vscode-shim.ts` (same interception technique) but
 * covers the members the integrations surface touches: `env.openExternal`
 * (records opened URLs), message boxes with a one-shot choice control,
 * `workspace.getConfiguration`, `commands.registerCommand`, `Uri.parse`.
 */
// eslint-disable-next-line @typescript-eslint/no-var-requires
const NodeModule = require("node:module") as typeof import("node:module");

/** Test controls: one-shot message-box choice + a log of opened URLs. */
export const integrationStubControls = {
  nextMessageChoice: undefined as string | undefined,
  openedUrls: [] as string[],
  shownMessages: [] as Array<{ message: string; choice: string | undefined }>,
  /** DEV-GAPS-80: every commands.registerCommand call, by id (dispose removes). */
  registeredCommands: new Map<string, (...args: unknown[]) => unknown>(),
  reset(): void {
    this.nextMessageChoice = undefined;
    this.openedUrls = [];
    this.shownMessages = [];
    this.registeredCommands.clear();
  },
};

function takeMessageChoice(message: string): Promise<string | undefined> {
  const choice = integrationStubControls.nextMessageChoice;
  integrationStubControls.nextMessageChoice = undefined;
  integrationStubControls.shownMessages.push({ message, choice });
  return Promise.resolve(choice);
}

const vscodeStub = {
  workspace: {
    workspaceFolders: [] as Array<{ uri: { fsPath: string } }>,
    getConfiguration(_section?: string) {
      return {
        get<T>(_key: string, defaultValue?: T): T | undefined {
          return defaultValue;
        },
      };
    },
  },
  window: {
    showInformationMessage: async (message: string, ..._args: unknown[]) =>
      takeMessageChoice(message),
    showErrorMessage: async (message: string, ..._args: unknown[]) => takeMessageChoice(message),
    showWarningMessage: async (message: string, ..._args: unknown[]) => takeMessageChoice(message),
    showQuickPick: async (_items: unknown, _options?: unknown) => undefined,
    showInputBox: async (_options?: unknown) => undefined,
  },
  env: {
    openExternal: async (uri: { toString(): string }) => {
      integrationStubControls.openedUrls.push(uri.toString());
      return true;
    },
  },
  Uri: {
    parse: (value: string) => ({ toString: () => value, fsPath: value }),
  },
  commands: {
    // DEV-GAPS-80: record registrations like the real extension host —
    // a duplicate id registration is an error there, so it is here too.
    registerCommand: (id: string, handler: (...args: unknown[]) => unknown) => {
      if (integrationStubControls.registeredCommands.has(id)) {
        throw new Error(`command '${id}' already exists`);
      }
      integrationStubControls.registeredCommands.set(id, handler);
      return {
        dispose: () => {
          integrationStubControls.registeredCommands.delete(id);
        },
      };
    },
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

export { vscodeStub };
