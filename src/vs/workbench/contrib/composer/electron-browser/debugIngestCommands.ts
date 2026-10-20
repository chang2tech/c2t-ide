/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// IDE-CODE: handler logic for the NDJSON ingest server palette commands —
// the workbench-core analog of the `cursor.ndjsonIngest.*` commands from
// Cursor's `cursor-ndjson-ingest` extension.
//
// Binary evidence [BIN] (Cursor 3.25.x,
// `reference/cursor/squashfs-root/usr/share/cursor/resources/app/extensions/cursor-ndjson-ingest/`):
//   package.json `contributes.commands` (no `category` field; activationEvents
//     only onCommand:start + onCommand:reassignPort):
//     cursor.ndjsonIngest.start         "Cursor NDJSON Ingest: Start Server"
//     cursor.ndjsonIngest.stop          "Cursor NDJSON Ingest: Stop Server"
//     cursor.ndjsonIngest.copyCurl      "Cursor NDJSON Ingest: Copy curl command"
//     cursor.ndjsonIngest.reassignPort  "Cursor NDJSON Ingest: Reassign port and restart server"
//     cursor.ndjsonIngest.showStatus    "Cursor NDJSON Ingest: Show server info"
//   dist/main.js (module 93 = NdjsonIngestServer; activate ≈ offset 2800):
//     start @2960         → wrapper normalizes the arg (string →
//                            {sessionId:string}; object → as-is; nullish → {})
//                            and runs $() serialized through N() (the
//                            promise chain @5087). $() @6484: untrusted →
//                            warn "debug mode disabled in untrusted
//                            workspace." + return undefined; already running
//                            with the same logDir + surface → return
//                            {externalUrl, logPath} with NO restart and NO
//                            message; otherwise chooseNdjsonPort (7242-7942)
//                            + new NdjsonIngestServer + start, returning
//                            {externalUrl, logPath}. Port/listen failures
//                            show "NDJSON Ingest: …" and return an error
//                            STRING. No success message. (GAPS-161 re-dissect
//                            of 3.25.9 — full table in work-notes-gaps161.md.)
//     stop @~3158         → L() = serialized D(): stops the server, clears
//                            p/h/f/w, NO ui message.
//     copyCurl @~3245      → !h ? warn "Server is not running." :
//                            clipboard := `curl -sS -H "Content-Type:
//                            application/x-ndjson" --data-binary
//                            '{"hello":"world"}' "<h>"`
//                            (verbatim — notably WITHOUT an X-Debug-Session-Id
//                            header; kept verbatim per QA rule) then info
//                            "NDJSON Ingest: curl command copied to clipboard."
//     reassignPort @~3641  → serialized; if ndjson.port pinned (≠0):
//                            j() = error "NDJSON Ingest: Cannot reassign the
//                            port while ndjson.port is pinned to ${o}. Set
//                            ndjson.port to 0 to use automatic workspace port
//                            assignment." with a "Change Port" button opening
//                            workspace settings at ndjson.port; return
//                            `Cannot reassign pinned port ${o}`.
//                            Else: clear sticky port, D(), restart with
//                            ignoreStickyPort + excludedPorts=[oldPort]; then
//                            info "NDJSON Ingest: Reassigned workspace port from
//                            ${old} to ${new} and restarted the server." (or
//                            "NDJSON Ingest: Restarted the server on port
//                            ${new}.").
//     showStatus @~4779    → h ? info `URL: ${h}` : info "NDJSON: server not running."
//     deactivate           → clear config-change debounce + L().
//
// Deliberate adaptations (documented, not forgotten):
//   - Command ids use the fork's `ide.*` core prefix (F7 precedent), not
//     `cursor.*`; titles drop the "Cursor" brand.
//   - The pinned-port message + settings query reference the fork's real
//     setting `ide.debug.ndjsonPort` (the binary's `ndjson.port` does not
//     exist in this fork).
//   - The copied URL is the loopback URL — core has no
//     `vscode.env.asExternalUri`; the binary falls back to the loopback URL
//     when `asExternalUri` fails.
//
// Layer note: this module is node-safe and workbench-free (no vs/platform
// imports) so the handlers are unit-testable against a real
// DebugServerService. The thin Action2 registrations live in
// debugIngestActions.ts (F7 precedent: glassWindowActions.ts).

import { DebugServerService } from "./debugServerService.js";

/** Command ids — the fork's `ide.*` core analogs of Cursor's `cursor.ndjsonIngest.*`. */
export const NDJSON_INGEST_COMMAND_IDS = {
  start: "ide.ndjsonIngest.start",
  stop: "ide.ndjsonIngest.stop",
  copyCurl: "ide.ndjsonIngest.copyCurl",
  reassignPort: "ide.ndjsonIngest.reassignPort",
  showStatus: "ide.ndjsonIngest.showStatus",
} as const;

/** Palette titles — the binary's "Cursor NDJSON Ingest: …" minus the brand. */
export const NDJSON_INGEST_COMMAND_TITLES = {
  start: "NDJSON Ingest: Start Server",
  stop: "NDJSON Ingest: Stop Server",
  copyCurl: "NDJSON Ingest: Copy curl command",
  reassignPort: "NDJSON Ingest: Reassign port and restart server",
  showStatus: "NDJSON Ingest: Show server info",
} as const;

/** A clickable action on an error message (the binary's "Change Port" button). */
export interface IDebugIngestMessageAction {
  label: string;
  run: () => void;
}

/** UI surface the handlers need — the core analog of `vscode.window` + `vscode.env.clipboard`. */
export interface IDebugIngestCommandUi {
  showInformationMessage(message: string): void | Promise<unknown>;
  showWarningMessage(message: string): void | Promise<unknown>;
  showErrorMessage(message: string, actions?: IDebugIngestMessageAction[]): void | Promise<unknown>;
  clipboardWriteText(text: string): Promise<void>;
  /** Open Settings filtered to `query` (binary: `workbench.action.openWorkspaceSettings`, "ndjson.port"). */
  openSettings(query: string): void | Promise<unknown>;
}

export interface IDebugIngestCommandDeps {
  /** The ingest server the commands act on (the binary's module-level `p`). */
  server: DebugServerService;
  /** Fork analog of Cursor's `ndjson.port` config: 0 = auto-allocate. */
  getConfiguredPort(): number;
  ui: IDebugIngestCommandUi;
}

/**
 * Serialization for the mutating commands — the binary funnels start/stop/
 * reassign through one module-level promise chain (`N()`), swallowing chain
 * errors so later commands still run while each caller still sees its own
 * rejection.
 */
let commandChain: Promise<unknown> = Promise.resolve();
function serialize<T>(fn: () => Promise<T>): Promise<T> {
  const run = commandChain.then(fn, fn);
  commandChain = run.catch(() => undefined);
  return run;
}

/**
 * Return shape of the binary's `$()` on success ([BIN] @6484): the external
 * (loopback in this fork) URL + the session's log path.
 */
export interface StartDebugIngestResult {
  externalUrl: string;
  logPath: string;
}

/**
 * Arg accepted by the binary's start command ([BIN] wrapper @2960): a bare
 * session-id string, or an object with `sessionId` (the desk caller also
 * passes `surface` — accepted here for arg compatibility and ignored: this
 * fork keeps ONE ingest identity per window, not the binary's
 * classic/glass sticky pair).
 */
export type StartDebugIngestArg =
  | string
  | { sessionId?: unknown; surface?: unknown }
  | undefined
  | null;

/** [BIN] wrapper @2960 verbatim normalization: string → {sessionId}; object → as-is; nullish → {}. */
function sessionIdFromStartArg(arg: StartDebugIngestArg): string | undefined {
  if (typeof arg === "string") {
    return arg;
  }
  if (arg && typeof arg.sessionId === "string") {
    return arg.sessionId;
  }
  return undefined;
}

/**
 * `cursor.ndjsonIngest.start` analog — the binary's `$()` (@6484), serialized
 * through the same chain as stop/reassign (the binary's `N()`).
 *
 * Return contract mirrors the binary, because Cursor's core
 * `debugServerService.getConfig()` consumes exactly this shape (desk bundle
 * @31597924: a string return is a failure, an object is the config):
 *   - success → `{externalUrl, logPath}`; NO UI message (the binary shows
 *     none on a successful start);
 *   - already running (same/no session) → the running server's config,
 *     no restart (via `DebugServerService.start()`);
 *   - untrusted workspace → warning `debug mode disabled in untrusted
 *     workspace.` (binary-verbatim) and `undefined`;
 *   - start failure → error `NDJSON Ingest: ${message}` (the binary's
 *     choose-port failure shape) and the message string. The binary's finer
 *     EADDRINUSE/EACCES texts are NOT reproduced: this fork's server throws
 *     plain Errors without code/port, so that mapping is UNKNOWN here.
 */
export function startDebugIngestServer(
  deps: IDebugIngestCommandDeps,
  arg?: StartDebugIngestArg,
): Promise<StartDebugIngestResult | string | undefined> {
  return serialize(async () => {
    try {
      const config = await deps.server.start(sessionIdFromStartArg(arg));
      return { externalUrl: config.serverEndpoint, logPath: config.logPath };
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      if (message === "debug mode disabled in untrusted workspace.") {
        await deps.ui.showWarningMessage(message);
        return undefined;
      }
      await deps.ui.showErrorMessage(`NDJSON Ingest: ${message}`);
      return message;
    }
  });
}

/**
 * `cursor.ndjsonIngest.stop` analog — the binary's `L()`: serialized `D()`,
 * silent (no UI message).
 */
export function stopDebugIngestServer(deps: IDebugIngestCommandDeps): Promise<void> {
  return serialize(() => deps.server.stop());
}

/**
 * `cursor.ndjsonIngest.copyCurl` analog — binary-verbatim curl template
 * (main.js @~3245). NOTE: the template carries NO X-Debug-Session-Id
 * header — that is Cursor's actual behavior, kept verbatim per the QA rule
 * (the task description's "session header thật" is not what the binary does).
 */
export async function copyDebugIngestCurl(deps: IDebugIngestCommandDeps): Promise<void> {
  // NOTE: not serialized — the binary registers copyCurl as a plain async
  // handler reading `h` directly; only start/stop/reassign go through N().
  const url = deps.server.getServerUrl();
  if (!url) {
    await deps.ui.showWarningMessage("Server is not running.");
    return;
  }
  const curl = `curl -sS -H "Content-Type: application/x-ndjson" --data-binary '{"hello":"world"}' "${url}"`;
  await deps.ui.clipboardWriteText(curl);
  await deps.ui.showInformationMessage("NDJSON Ingest: curl command copied to clipboard.");
}

export interface ReassignPortResult {
  oldPort: number;
  newPort: number;
}

/**
 * `cursor.ndjsonIngest.reassignPort` analog — binary flow @~3641.
 * Returns the ports on success, or the `Cannot reassign pinned port …`
 * string when the port is pinned (the binary returns that string too).
 */
export function reassignDebugIngestPort(
  deps: IDebugIngestCommandDeps,
): Promise<ReassignPortResult | string> {
  return serialize(async () => {
    const pinned = deps.getConfiguredPort();
    if (pinned !== 0) {
      // The binary's j(): error with a "Change Port" button that opens
      // settings at the port key. Key adapted to the fork's real setting.
      await deps.ui.showErrorMessage(
        `NDJSON Ingest: Cannot reassign the port while ide.debug.ndjsonPort is pinned to ${pinned}. ` +
          `Set ide.debug.ndjsonPort to 0 to use automatic port assignment.`,
        [
          {
            label: "Change Port",
            run: () => {
              void deps.ui.openSettings("ide.debug.ndjsonPort");
            },
          },
        ],
      );
      return `Cannot reassign pinned port ${pinned}`;
    }
    const { oldPort, newPort } = await deps.server.reassignPort();
    if (oldPort !== 0 && newPort !== oldPort) {
      await deps.ui.showInformationMessage(
        `NDJSON Ingest: Reassigned workspace port from ${oldPort} to ${newPort} and restarted the server.`,
      );
    } else {
      await deps.ui.showInformationMessage(`NDJSON Ingest: Restarted the server on port ${newPort}.`);
    }
    return { oldPort, newPort };
  });
}

/**
 * `cursor.ndjsonIngest.showStatus` analog — binary-verbatim @~4779: only the
 * URL (or the not-running line). NOT port/logDir/sessions — the binary does
 * not show those.
 */
export function showDebugIngestStatus(deps: IDebugIngestCommandDeps): void | Promise<unknown> {
  const url = deps.server.getServerUrl();
  return deps.ui.showInformationMessage(url ? `URL: ${url}` : "NDJSON: server not running.");
}
