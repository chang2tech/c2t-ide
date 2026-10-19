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

const windowStub = {
  lastWarning: undefined as string | undefined,
  showWarningMessage(message: string): void {
    windowStub.lastWarning = message;
  },
  /** Read and clear the last warning (avoids TS narrowing pitfalls in tests). */
  consumeWarning(): string | undefined {
    const w = windowStub.lastWarning;
    windowStub.lastWarning = undefined;
    return w;
  },
  showInformationMessage(_message: string): void {
    /* stub */
  },
  showErrorMessage(_message: string): void {
    /* stub */
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
};

const vscodeStub = {
  EventEmitter: StubEventEmitter,
  window: windowStub,
  workspace: {
    getConfiguration() {
      return { get: (_key: string, def?: unknown) => def };
    },
  },
  env: { language: "en" },
  Uri: { parse: (s: string) => ({ toString: () => s }) },
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

export { vscodeStub, windowStub };
