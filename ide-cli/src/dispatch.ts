/**
 * dispatch.ts — CLI dispatch for `ide-code`.
 *
 * Dispatch order (spec §1, adapted honestly):
 *  1. `desktop` as first positional -> desktop bridge (../desktop/client).
 *     Cursor silently falls through to the open path when no live instance
 *     exists (spec §3.1, §6.3) — we do NOT copy that quirk (spec §5 P2-9):
 *     the bridge client prints `error: no running IDE Code desktop instance
 *     found` and returns 1 (implemented in ../desktop/client).
 *  2. `tunnel` -> honest error: tunneling is not built (spec §5 P4).
 *  3. `agent` -> the REAL agent CLI (../agent/cli), not a stub.
 *  4. --help / --version / --locate-shell-integration-path.
 *  5. Stock management flags -> upstream vs/code/node/cliProcessMain.js
 *     (lazy require, injectable path; honest error if missing).
 *  6. --file-write internal plumbing (binary-verified semantics).
 *  6b. --chat: explicit standalone-chat step — reuses the open path to
 *     launch the app with the chat intent; the app opens the dedicated
 *     chat window (never a silent fallthrough for this public flag).
 *  7. Else: open path — respawn the app binary (process.execPath, i.e. the
 *     Electron binary running this CLI via ELECTRON_RUN_AS_NODE=1, exactly
 *     the binary the launcher resolved), env minus ELECTRON_RUN_AS_NODE
 *     plus ELECTRON_NO_ATTACH_CONSOLE=1, forwarding argv. --wait/--verbose
 *     use the marker-file protocol (spec §4.3); `-` stdin is buffered to a
 *     temp file (spec §4.4).
 *
 * Every behavior cites the spec section or the binary observation it
 * mirrors; UNKNOWNs are marked, never invented.
 */

import * as child_process from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as process from "node:process";
import { runDesktopBridge } from "./desktop/client";
import { runAgent } from "./agent/cli";
import { UPSTREAM_MANAGEMENT_FLAGS } from "./options";
import { ParsedArgv, flagString, hasFlag, parseArgv } from "./parse";
import {
  locateShellIntegrationPath,
  printHelp,
  printVersion,
  resolveAppVersion,
} from "./help";

export interface DispatchOut {
  stdout: (s: string) => void;
  stderr: (s: string) => void;
}

export interface DispatchDeps {
  /** Defaults to the real bridge client. Injected in tests. */
  runDesktopBridge?: (argv: string[]) => Promise<number>;
  /** Defaults to the real agent CLI. Injected in tests. */
  runAgent?: (argv: string[]) => Promise<number>;
  /**
   * Upstream management entry. Defaults to
   * `<appDir>/out/vs/code/node/cliProcessMain.js` — OBSERVED in Cursor's
   * bundle (`await (await import("./vs/code/node/cliProcessMain.js")).main(t)`
   * from out/cli.js). Only exists in the built app.
   */
  upstreamEntry?: string;
  /**
   * App binary for the open path. Defaults to `process.execPath` — when run
   * via bin/ide-code this IS the Electron binary (ELECTRON_RUN_AS_NODE=1),
   * i.e. exactly the binary the launcher resolved, so no install-layout
   * guessing is needed. Injectable for tests.
   */
  electronBinaryPath?: string;
  /** Defaults to child_process.spawn. Injected in tests. */
  spawn?: (
    cmd: string,
    args: string[],
    opts: child_process.SpawnOptions
  ) => child_process.ChildProcess;
  /** Defaults to <cliDir>/.. (resources/app). */
  appDir?: string;
  stdout?: (s: string) => void;
  stderr?: (s: string) => void;
  /** Read stdin fully (default: process.stdin). Injected in tests. */
  readStdin?: () => Promise<Buffer>;
  /** stdin is a TTY? Default: process.stdin.isTTY. Injected in tests. */
  stdinIsTTY?: boolean;
}

function defaultOut(deps: DispatchDeps): DispatchOut {
  return {
    stdout: deps.stdout ?? ((s: string) => process.stdout.write(s + "\n")),
    stderr: deps.stderr ?? ((s: string) => process.stderr.write(s + "\n")),
  };
}

function defaultAppDir(): string {
  // Compiled entry is out/cli.js; the app dir is resources/app.
  return path.resolve(__dirname, "..");
}

/**
 * Delegate stock management flags to the upstream VS Code CLI main.
 * The require is LAZY and the entry path INJECTABLE; a missing module is
 * an honest error, never faked success.
 */
export async function delegateToUpstream(
  parsed: ParsedArgv,
  opts: { upstreamEntry: string; stdout: (s: string) => void; stderr: (s: string) => void }
): Promise<number> {
  let mod: { main?: (args: unknown) => Promise<unknown> | unknown };
  try {
    mod = (await import(opts.upstreamEntry)) as typeof mod;
  } catch {
    opts.stderr(
      `error: extension management is not available in this build (upstream CLI module not found: ${opts.upstreamEntry})`
    );
    return 1;
  }
  type UpstreamMain = (args: unknown) => Promise<unknown> | unknown;
  let mainFn: UpstreamMain | undefined = mod.main as UpstreamMain | undefined;
  if (typeof mainFn !== "function") {
    // CJS interop: `module.exports = { main }` may surface under `.default`.
    const def = (mod as { default?: { main?: unknown } }).default;
    if (def && typeof def.main === "function") {
      mainFn = def.main as UpstreamMain;
    }
  }
  if (typeof mainFn !== "function") {
    opts.stderr(
      `error: extension management is not available in this build (upstream CLI module has no main(): ${opts.upstreamEntry})`
    );
    return 1;
  }
  // Cursor passes its parsed-args object; we pass the equivalent shape.
  await mainFn({ ...parsed.flags, _: parsed._ });
  return 0;
}

/**
 * --file-write internal plumbing. Binary-verified semantics (Cursor 3.25.9):
 *  - JSON file path = first positional `_`; must exist, be absolute, be a file.
 *  - JSON must parse to {source, target}; both must exist, be absolute,
 *    be files, and differ — else `Using --file-write with invalid arguments.`
 *  - Copies source -> target. With --file-chmod: if the TARGET lacks the
 *    owner-write bit, it is temporarily granted for the copy and then the
 *    original mode is restored. (The spec doc glosses this as "chmod +x";
 *    the binary does temp-owner-write + restore — binary wins.)
 *  - Any failure inside -> `Error using --file-write: <message>`.
 */
export async function runFileWrite(
  parsed: ParsedArgv,
  out: DispatchOut
): Promise<number> {
  const invalid = (): number => {
    out.stderr("Using --file-write with invalid arguments.");
    return 1;
  };
  const jsonFile = parsed._[0];
  if (!jsonFile || !path.isAbsolute(jsonFile)) {
    return invalid();
  }
  let stat: fs.Stats;
  try {
    stat = fs.statSync(jsonFile);
  } catch {
    return invalid();
  }
  if (!stat.isFile()) {
    return invalid();
  }
  let source: unknown;
  let target: unknown;
  try {
    const n = JSON.parse(fs.readFileSync(jsonFile, "utf8"));
    source = n.source;
    target = n.target;
  } catch {
    return invalid();
  }
  const okPath = (p: unknown): p is string => {
    if (typeof p !== "string" || p.length === 0 || !path.isAbsolute(p)) {
      return false;
    }
    try {
      return fs.statSync(p).isFile();
    } catch {
      return false;
    }
  };
  if (!okPath(source) || !okPath(target) || source === target) {
    return invalid();
  }
  try {
    let originalMode = 0;
    let modeChanged = false;
    if (hasFlag(parsed, "file-chmod")) {
      originalMode = fs.statSync(target).mode;
      // 0o200 = owner-write. Temporarily grant it so a read-only target
      // can be overwritten; restored after the copy (binary-verified).
      if (!(originalMode & 0o200)) {
        fs.chmodSync(target, originalMode | 0o200);
        modeChanged = true;
      }
    }
    const data = fs.readFileSync(source);
    fs.writeFileSync(target, data);
    if (modeChanged) {
      fs.chmodSync(target, originalMode);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    out.stderr(`Error using --file-write: ${msg}`);
    return 1;
  }
  return 0;
}

function readAllStdin(): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    process.stdin.on("data", (c) => chunks.push(Buffer.from(c as Uint8Array)));
    process.stdin.on("end", () => resolve(Buffer.concat(chunks)));
    process.stdin.on("error", reject);
  });
}

/** Poll until the marker file is gone (Cursor uses a file watcher; polling is the honest equivalent). */
function waitForMarkerDeletion(markerPath: string): Promise<void> {
  return new Promise<void>((resolve) => {
    const check = () => {
      if (!fs.existsSync(markerPath)) {
        resolve();
      } else {
        setTimeout(check, 200);
      }
    };
    check();
  });
}

export interface OpenPathDeps {
  electronBinaryPath: string;
  spawn: NonNullable<DispatchDeps["spawn"]>;
  readStdin: NonNullable<DispatchDeps["readStdin"]>;
  stdinIsTTY: boolean;
  stdout: (s: string) => void;
  stderr: (s: string) => void;
}

/**
 * The open path: respawn the app binary forwarding argv.
 * - `-` in positionals: stdin buffered to a temp file (spec §4.4); the temp
 *   path replaces `-` and `--skip-add-to-recently-opened` is appended;
 *   prints `Reading from stdin via: <tmp>` (OBSERVED).
 * - `--wait` (and `--verbose`, which implies `--wait` per spec §4.3):
 *   marker-file protocol — temp marker created, `--waitMarkerFilePath <tmp>`
 *   appended, wait until the app deletes it or the app exits.
 * - env: minus ELECTRON_RUN_AS_NODE, plus ELECTRON_NO_ATTACH_CONSOLE=1
 *   (OBSERVED); plus ELECTRON_ENABLE_LOGGING=1 when --verbose (OBSERVED).
 * - Without --wait: spawn detached and return once spawned (fire-and-forget,
 *   like Cursor); spawn failure -> stderr + exit 1 (honest, unlike Cursor's
 *   silent fallthrough).
 */
export async function openApp(
  rawArgv: string[],
  parsed: ParsedArgv,
  deps: OpenPathDeps
): Promise<number> {
  const { stdout, stderr } = deps;
  const forwarded = [...rawArgv];
  let stdinTmp: string | undefined;

  // stdin `-` -> temp file (spec §4.4). Cursor strips `-` from the forwarded
  // argv in all cases; the temp file is only created when stdin is piped.
  if (parsed._.includes("-")) {
    for (let i = 0; i < forwarded.length; i++) {
      if (forwarded[i] === "-") {
        forwarded.splice(i, 1);
        i--;
      }
    }
    if (!deps.stdinIsTTY) {
      try {
        const data = await deps.readStdin();
        stdinTmp = path.join(
          fs.mkdtempSync(path.join(os.tmpdir(), "ide-code-stdin-")),
          "stdin"
        );
        fs.writeFileSync(stdinTmp, data);
        forwarded.push(stdinTmp, "--skip-add-to-recently-opened");
        stdout(`Reading from stdin via: ${stdinTmp}`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        // OBSERVED Cursor message on this failure (stdout, then continues).
        stdout(`Failed to create file to read via stdin: ${msg}`);
        stdinTmp = undefined;
      }
    }
  }

  // --verbose implies --wait (spec §4.3).
  const wait = hasFlag(parsed, "wait") || hasFlag(parsed, "verbose");
  let markerPath: string | undefined;
  if (wait) {
    markerPath = path.join(
      fs.mkdtempSync(path.join(os.tmpdir(), "ide-code-wait-")),
      "marker"
    );
    fs.writeFileSync(markerPath, "");
    forwarded.push("--waitMarkerFilePath", markerPath);
  }

  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  env.ELECTRON_NO_ATTACH_CONSOLE = "1";
  if (hasFlag(parsed, "verbose")) {
    env.ELECTRON_ENABLE_LOGGING = "1"; // OBSERVED in the binary.
  }

  const verbose = hasFlag(parsed, "verbose");
  let child: child_process.ChildProcess;
  try {
    child = deps.spawn(deps.electronBinaryPath, forwarded, {
      env,
      stdio: verbose ? "inherit" : "ignore",
      detached: true,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    stderr(`error: could not start the IDE Code app: ${msg}`);
    return 1;
  }

  const cleanup = () => {
    // Cursor deletes the marker dir and the stdin temp file when done.
    for (const p of [markerPath, stdinTmp]) {
      if (p) {
        try {
          fs.rmSync(path.dirname(p), { recursive: true, force: true });
        } catch {
          // best effort
        }
      }
    }
  };

  if (!wait) {
    // Fire-and-forget like Cursor, but honest about spawn failure:
    // wait for "spawn" vs "error" before returning.
    const code = await new Promise<number>((resolve) => {
      let settled = false;
      const done = (c: number) => {
        if (!settled) {
          settled = true;
          resolve(c);
        }
      };
      child.on("error", (err) => {
        stderr(`error: could not start the IDE Code app: ${err.message}`);
        done(1);
      });
      child.on("spawn", () => {
        // unref may be absent on injected test doubles.
        (child as unknown as { unref?: () => void }).unref?.();
        done(0);
      });
    });
    return code;
  }

  // --wait marker protocol (spec §4.3): the app deletes the marker file
  // when the files are closed; we also stop waiting if the app exits.
  const code = await new Promise<number>((resolve) => {
    let settled = false;
    const done = (c: number) => {
      if (!settled) {
        settled = true;
        resolve(c);
      }
    };
    child.on("error", (err) => {
      stderr(`error: could not start the IDE Code app: ${err.message}`);
      done(1);
    });
    child.on("exit", (exitCode, signal) => {
      done(exitCode ?? (signal ? 1 : 0));
    });
    void waitForMarkerDeletion(markerPath as string).then(() => done(0));
  });
  cleanup();
  return code;
}

/** Main dispatch. Returns the process exit code; never calls process.exit. */
export async function dispatch(rawArgv: string[], deps: DispatchDeps = {}): Promise<number> {
  const out = defaultOut(deps);
  const appDir = deps.appDir ?? defaultAppDir();
  const parsed = parseArgv(rawArgv);

  // 1. `desktop` as first positional -> desktop bridge.
  if (parsed.subcommand === "desktop") {
    const rest = rawArgv.slice((parsed.subcommandIndex ?? -1) + 1);
    const bridge = deps.runDesktopBridge ?? runDesktopBridge;
    return bridge(rest);
  }

  // 2. `tunnel` -> honest error (spec §5 P4: only if we build remote tunneling; we haven't).
  if (parsed.subcommand === "tunnel") {
    out.stderr("ide-code tunnel is not available in this build");
    return 1;
  }

  // 3. `agent` -> the real agent CLI (not a stub).
  if (parsed.subcommand === "agent") {
    const rest = rawArgv.slice((parsed.subcommandIndex ?? -1) + 1);
    const agent = deps.runAgent ?? runAgent;
    return agent(rest);
  }

  // 4. --help / --version / --locate-shell-integration-path.
  if (hasFlag(parsed, "help")) {
    return printHelp({
      stdout: out.stdout,
      appDir,
      getVersion: () => resolveAppVersion(appDir),
    });
  }
  if (hasFlag(parsed, "version")) {
    return printVersion({
      stdout: out.stdout,
      appDir,
      getVersion: () => resolveAppVersion(appDir),
    });
  }
  const locateShell = flagString(parsed, "locate-shell-integration-path");
  if (parsed.missingValue.includes("locate-shell-integration-path") || locateShell === "") {
    // OBSERVED Cursor: stdout notice, option ignored, dispatch continues.
    out.stdout("Option 'locate-shell-integration-path' requires a non empty value. Ignoring the option.");
  } else if (locateShell !== undefined) {
    return locateShellIntegrationPath(locateShell, { stdout: out.stdout, stderr: out.stderr, appDir });
  }

  // 5. Stock management flags -> upstream CLI main (lazy, injectable).
  if (UPSTREAM_MANAGEMENT_FLAGS.some((f) => hasFlag(parsed, f))) {
    const upstreamEntry =
      deps.upstreamEntry ?? path.join(appDir, "out", "vs", "code", "node", "cliProcessMain.js");
    return delegateToUpstream(parsed, { upstreamEntry, stdout: out.stdout, stderr: out.stderr });
  }

  // 6. --file-write internal plumbing.
  if (hasFlag(parsed, "file-write")) {
    return runFileWrite(parsed, out);
  }

  // 6b. --chat: standalone chat window (Cursor NLS 1905: "Open a standalone
  // chat window without the full IDE."). The CLI cannot create windows
  // itself — like Cursor's out/cli.js, it launches the app binary and the
  // APP opens the window: the app parser preserves the bool `--chat` form
  // (see src/vs/platform/environment/node/argv.ts) and the main process
  // routes `args.chat === true` to a dedicated chat window (see
  // src/vs/code/electron-main/app.ts openStandaloneChatWindow). This step
  // exists so the flag has explicit dispatch (never a silent fallthrough):
  // the full open-path machinery (argv forwarding, --wait marker protocol,
  // stdin buffering, env setup) is exactly what the chat window launch
  // needs, so it is reused rather than duplicated.
  if (hasFlag(parsed, "chat")) {
    return openApp(rawArgv, parsed, {
      electronBinaryPath: deps.electronBinaryPath ?? process.execPath,
      spawn: deps.spawn ?? child_process.spawn,
      readStdin: deps.readStdin ?? readAllStdin,
      stdinIsTTY: deps.stdinIsTTY ?? process.stdin.isTTY ?? false,
      stdout: out.stdout,
      stderr: out.stderr,
    });
  }

  // 7. Else: open path.
  return openApp(rawArgv, parsed, {
    electronBinaryPath: deps.electronBinaryPath ?? process.execPath,
    spawn: deps.spawn ?? child_process.spawn,
    readStdin: deps.readStdin ?? readAllStdin,
    stdinIsTTY: deps.stdinIsTTY ?? process.stdin.isTTY ?? false,
    stdout: out.stdout,
    stderr: out.stderr,
  });
}
