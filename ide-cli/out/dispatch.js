"use strict";
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
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.delegateToUpstream = delegateToUpstream;
exports.runFileWrite = runFileWrite;
exports.openApp = openApp;
exports.dispatch = dispatch;
const child_process = __importStar(require("node:child_process"));
const fs = __importStar(require("node:fs"));
const os = __importStar(require("node:os"));
const path = __importStar(require("node:path"));
const process = __importStar(require("node:process"));
const client_1 = require("./desktop/client");
const cli_1 = require("./agent/cli");
const options_1 = require("./options");
const parse_1 = require("./parse");
const help_1 = require("./help");
function defaultOut(deps) {
    return {
        stdout: deps.stdout ?? ((s) => process.stdout.write(s + "\n")),
        stderr: deps.stderr ?? ((s) => process.stderr.write(s + "\n")),
    };
}
function defaultAppDir() {
    // Compiled entry is out/cli.js; the app dir is resources/app.
    return path.resolve(__dirname, "..");
}
/**
 * Delegate stock management flags to the upstream VS Code CLI main.
 * The require is LAZY and the entry path INJECTABLE; a missing module is
 * an honest error, never faked success.
 */
async function delegateToUpstream(parsed, opts) {
    let mod;
    try {
        mod = (await Promise.resolve(`${opts.upstreamEntry}`).then(s => __importStar(require(s))));
    }
    catch {
        opts.stderr(`error: extension management is not available in this build (upstream CLI module not found: ${opts.upstreamEntry})`);
        return 1;
    }
    let mainFn = mod.main;
    if (typeof mainFn !== "function") {
        // CJS interop: `module.exports = { main }` may surface under `.default`.
        const def = mod.default;
        if (def && typeof def.main === "function") {
            mainFn = def.main;
        }
    }
    if (typeof mainFn !== "function") {
        opts.stderr(`error: extension management is not available in this build (upstream CLI module has no main(): ${opts.upstreamEntry})`);
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
async function runFileWrite(parsed, out) {
    const invalid = () => {
        out.stderr("Using --file-write with invalid arguments.");
        return 1;
    };
    const jsonFile = parsed._[0];
    if (!jsonFile || !path.isAbsolute(jsonFile)) {
        return invalid();
    }
    let stat;
    try {
        stat = fs.statSync(jsonFile);
    }
    catch {
        return invalid();
    }
    if (!stat.isFile()) {
        return invalid();
    }
    let source;
    let target;
    try {
        const n = JSON.parse(fs.readFileSync(jsonFile, "utf8"));
        source = n.source;
        target = n.target;
    }
    catch {
        return invalid();
    }
    const okPath = (p) => {
        if (typeof p !== "string" || p.length === 0 || !path.isAbsolute(p)) {
            return false;
        }
        try {
            return fs.statSync(p).isFile();
        }
        catch {
            return false;
        }
    };
    if (!okPath(source) || !okPath(target) || source === target) {
        return invalid();
    }
    try {
        let originalMode = 0;
        let modeChanged = false;
        if ((0, parse_1.hasFlag)(parsed, "file-chmod")) {
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
    }
    catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        out.stderr(`Error using --file-write: ${msg}`);
        return 1;
    }
    return 0;
}
function readAllStdin() {
    return new Promise((resolve, reject) => {
        const chunks = [];
        process.stdin.on("data", (c) => chunks.push(Buffer.from(c)));
        process.stdin.on("end", () => resolve(Buffer.concat(chunks)));
        process.stdin.on("error", reject);
    });
}
/** Poll until the marker file is gone (Cursor uses a file watcher; polling is the honest equivalent). */
function waitForMarkerDeletion(markerPath) {
    return new Promise((resolve) => {
        const check = () => {
            if (!fs.existsSync(markerPath)) {
                resolve();
            }
            else {
                setTimeout(check, 200);
            }
        };
        check();
    });
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
async function openApp(rawArgv, parsed, deps) {
    const { stdout, stderr } = deps;
    const forwarded = [...rawArgv];
    let stdinTmp;
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
                stdinTmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "ide-code-stdin-")), "stdin");
                fs.writeFileSync(stdinTmp, data);
                forwarded.push(stdinTmp, "--skip-add-to-recently-opened");
                stdout(`Reading from stdin via: ${stdinTmp}`);
            }
            catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                // OBSERVED Cursor message on this failure (stdout, then continues).
                stdout(`Failed to create file to read via stdin: ${msg}`);
                stdinTmp = undefined;
            }
        }
    }
    // --verbose implies --wait (spec §4.3).
    const wait = (0, parse_1.hasFlag)(parsed, "wait") || (0, parse_1.hasFlag)(parsed, "verbose");
    let markerPath;
    if (wait) {
        markerPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "ide-code-wait-")), "marker");
        fs.writeFileSync(markerPath, "");
        forwarded.push("--waitMarkerFilePath", markerPath);
    }
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    env.ELECTRON_NO_ATTACH_CONSOLE = "1";
    if ((0, parse_1.hasFlag)(parsed, "verbose")) {
        env.ELECTRON_ENABLE_LOGGING = "1"; // OBSERVED in the binary.
    }
    const verbose = (0, parse_1.hasFlag)(parsed, "verbose");
    let child;
    try {
        child = deps.spawn(deps.electronBinaryPath, forwarded, {
            env,
            stdio: verbose ? "inherit" : "ignore",
            detached: true,
        });
    }
    catch (err) {
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
                }
                catch {
                    // best effort
                }
            }
        }
    };
    if (!wait) {
        // Fire-and-forget like Cursor, but honest about spawn failure:
        // wait for "spawn" vs "error" before returning.
        const code = await new Promise((resolve) => {
            let settled = false;
            const done = (c) => {
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
                child.unref?.();
                done(0);
            });
        });
        return code;
    }
    // --wait marker protocol (spec §4.3): the app deletes the marker file
    // when the files are closed; we also stop waiting if the app exits.
    const code = await new Promise((resolve) => {
        let settled = false;
        const done = (c) => {
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
        void waitForMarkerDeletion(markerPath).then(() => done(0));
    });
    cleanup();
    return code;
}
/** Main dispatch. Returns the process exit code; never calls process.exit. */
async function dispatch(rawArgv, deps = {}) {
    const out = defaultOut(deps);
    const appDir = deps.appDir ?? defaultAppDir();
    const parsed = (0, parse_1.parseArgv)(rawArgv);
    // 1. `desktop` as first positional -> desktop bridge.
    if (parsed.subcommand === "desktop") {
        const rest = rawArgv.slice((parsed.subcommandIndex ?? -1) + 1);
        const bridge = deps.runDesktopBridge ?? client_1.runDesktopBridge;
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
        const agent = deps.runAgent ?? cli_1.runAgent;
        return agent(rest);
    }
    // 4. --help / --version / --locate-shell-integration-path.
    if ((0, parse_1.hasFlag)(parsed, "help")) {
        return (0, help_1.printHelp)({
            stdout: out.stdout,
            appDir,
            getVersion: () => (0, help_1.resolveAppVersion)(appDir),
        });
    }
    if ((0, parse_1.hasFlag)(parsed, "version")) {
        return (0, help_1.printVersion)({
            stdout: out.stdout,
            appDir,
            getVersion: () => (0, help_1.resolveAppVersion)(appDir),
        });
    }
    const locateShell = (0, parse_1.flagString)(parsed, "locate-shell-integration-path");
    if (parsed.missingValue.includes("locate-shell-integration-path") || locateShell === "") {
        // OBSERVED Cursor: stdout notice, option ignored, dispatch continues.
        out.stdout("Option 'locate-shell-integration-path' requires a non empty value. Ignoring the option.");
    }
    else if (locateShell !== undefined) {
        return (0, help_1.locateShellIntegrationPath)(locateShell, { stdout: out.stdout, stderr: out.stderr, appDir });
    }
    // 5. Stock management flags -> upstream CLI main (lazy, injectable).
    if (options_1.UPSTREAM_MANAGEMENT_FLAGS.some((f) => (0, parse_1.hasFlag)(parsed, f))) {
        const upstreamEntry = deps.upstreamEntry ?? path.join(appDir, "out", "vs", "code", "node", "cliProcessMain.js");
        return delegateToUpstream(parsed, { upstreamEntry, stdout: out.stdout, stderr: out.stderr });
    }
    // 6. --file-write internal plumbing.
    if ((0, parse_1.hasFlag)(parsed, "file-write")) {
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
    if ((0, parse_1.hasFlag)(parsed, "chat")) {
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
