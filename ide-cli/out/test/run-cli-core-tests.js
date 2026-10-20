"use strict";
/**
 * run-cli-core-tests.ts — node:test suite for the CLI core worker.
 *
 * Covers: parser, option registry (153 flags), help output, dispatch
 * routing, --file-write, the --wait marker protocol, and open-path spawn
 * failure. All externals are injected fakes — no network, no real apps.
 *
 * Run:  npx tsc && node --test out/test/run-cli-core-tests.js
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
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const node_test_1 = require("node:test");
const strict_1 = __importDefault(require("node:assert/strict"));
const child_process = __importStar(require("node:child_process"));
const fs = __importStar(require("node:fs"));
const os = __importStar(require("node:os"));
const path = __importStar(require("node:path"));
const node_events_1 = require("node:events");
const options_1 = require("../options");
const parse_1 = require("../parse");
const help_1 = require("../help");
const dispatch_1 = require("../dispatch");
function capture() {
    const c = {
        out: [],
        err: [],
        stdout: (s) => c.out.push(s),
        stderr: (s) => c.err.push(s),
    };
    return c;
}
let tmpRoot = "";
(0, node_test_1.before)(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ide-cli-core-test-"));
});
(0, node_test_1.after)(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
    delete process.env.FAKE_APP_CAPTURE;
    delete process.env.FAKE_APP_EXIT;
    delete process.env.FAKE_UPSTREAM_CAPTURE;
});
function tmpFile(name, content) {
    const p = path.join(tmpRoot, name);
    fs.writeFileSync(p, content);
    return p;
}
/**
 * A fake "Electron app" executable: node script with shebang. Behavior:
 *  - appends its argv (JSON) to $FAKE_APP_CAPTURE if set,
 *  - if --waitMarkerFilePath <p> present: deletes <p> after 300ms, then
 *    exits $FAKE_APP_EXIT (default 0) after $FAKE_APP_EXIT_DELAY ms
 *    (default 800),
 *  - else exits $FAKE_APP_EXIT (default 0) immediately.
 */
function writeFakeApp() {
    const p = path.join(tmpRoot, "fake-app.js");
    fs.writeFileSync(p, `#!/usr/bin/env node
const fs = require("fs");
const argv = process.argv.slice(2);
if (process.env.FAKE_APP_CAPTURE) {
  fs.appendFileSync(process.env.FAKE_APP_CAPTURE, JSON.stringify(argv) + "\\n");
}
const exitCode = Number(process.env.FAKE_APP_EXIT || 0);
const exitDelay = Number(process.env.FAKE_APP_EXIT_DELAY || 800);
const i = argv.indexOf("--waitMarkerFilePath");
if (i !== -1 && argv[i + 1]) {
  const marker = argv[i + 1];
  setTimeout(() => { try { fs.unlinkSync(marker); } catch {} }, 300);
  setTimeout(() => process.exit(exitCode), exitDelay);
} else {
  process.exit(exitCode);
}
`);
    fs.chmodSync(p, 0o755);
    return p;
}
/** Poll for a file to appear (the fake app's node needs ~1s cold start here). */
async function waitForFile(p, timeoutMs = 15000) {
    const start = Date.now();
    for (;;) {
        if (fs.existsSync(p)) {
            return;
        }
        if (Date.now() - start > timeoutMs) {
            throw new Error(`timed out waiting for ${p}`);
        }
        await new Promise((r) => setTimeout(r, 100));
    }
}
function lastCaptureLine(capFile) {
    const lines = fs.readFileSync(capFile, "utf8").trim().split("\n");
    return JSON.parse(lines[lines.length - 1]);
}
// ---------------------------------------------------------------------------
// parser
// ---------------------------------------------------------------------------
(0, node_test_1.describe)("parseArgv", () => {
    (0, node_test_1.it)("parses --flag value and --flag=value", () => {
        strict_1.default.equal((0, parse_1.parseArgv)(["--locale", "en-US"]).flags["locale"], "en-US");
        strict_1.default.equal((0, parse_1.parseArgv)(["--locale=en-US"]).flags["locale"], "en-US");
    });
    (0, node_test_1.it)("parses boolean flags", () => {
        const p = (0, parse_1.parseArgv)(["--wait"]);
        strict_1.default.equal(p.flags["wait"], true);
        strict_1.default.ok((0, parse_1.hasFlag)(p, "wait"));
    });
    (0, node_test_1.it)("parses short flags and clusters", () => {
        strict_1.default.equal((0, parse_1.parseArgv)(["-w"]).flags["wait"], true);
        const p = (0, parse_1.parseArgv)(["-wn"]);
        strict_1.default.equal(p.flags["wait"], true);
        strict_1.default.equal(p.flags["new-window"], true);
    });
    (0, node_test_1.it)("honors the -- terminator for flags (but the subcommand scan is raw)", () => {
        const p = (0, parse_1.parseArgv)(["--", "--wait", "desktop"]);
        strict_1.default.equal((0, parse_1.hasFlag)(p, "wait"), false);
        strict_1.default.deepEqual(p._.concat(), ["--wait", "desktop"]);
        // Cursor's fl()/Ln() scan the RAW argv: the first non-dash token names
        // the subcommand even after `--` (OBSERVED binary behavior).
        strict_1.default.equal(p.subcommand, "desktop");
        strict_1.default.equal(p.subcommandIndex, 2);
    });
    (0, node_test_1.it)("keeps lone - as a positional", () => {
        const p = (0, parse_1.parseArgv)(["-"]);
        strict_1.default.deepEqual(p._.concat(), ["-"]);
    });
    (0, node_test_1.it)("accumulates string[] flags", () => {
        const p = (0, parse_1.parseArgv)(["--install-extension", "a", "--install-extension", "b"]);
        strict_1.default.deepEqual(p.flags["install-extension"], ["a", "b"]);
    });
    (0, node_test_1.it)("collects unknown flags without crashing (minimist-flavored)", () => {
        const p = (0, parse_1.parseArgv)(["--frobnicate", "x", "--other"]);
        strict_1.default.deepEqual(p.unknown, ["frobnicate", "other"]);
        strict_1.default.equal(p.flags["frobnicate"], "x");
        strict_1.default.equal(p.flags["other"], true);
        const q = (0, parse_1.parseArgv)(["--weird=1"]);
        strict_1.default.equal(q.flags["weird"], "1");
    });
    (0, node_test_1.it)("records string flags missing a value (Cursor: notice + ignore)", () => {
        const p = (0, parse_1.parseArgv)(["--locale"]);
        strict_1.default.deepEqual(p.missingValue, ["locale"]);
        strict_1.default.equal(p.flags["locale"], undefined);
    });
    (0, node_test_1.it)("mirrors aliases onto the canonical name", () => {
        const p = (0, parse_1.parseArgv)(["--no-sandbox"]);
        strict_1.default.equal(p.flags["no-sandbox"], true);
        strict_1.default.equal(p.flags["sandbox"], true);
    });
    (0, node_test_1.it)("detects the subcommand as the first raw non-dash token (Cursor fl()/Ln())", () => {
        const p = (0, parse_1.parseArgv)(["desktop", "ls"]);
        strict_1.default.equal(p.subcommand, "desktop");
        strict_1.default.equal(p.subcommandIndex, 0);
        const q = (0, parse_1.parseArgv)(["--wait", "agent", "-p", "hi"]);
        strict_1.default.equal(q.subcommand, "agent");
        strict_1.default.equal(q.subcommandIndex, 1);
    });
    (0, node_test_1.it)("scans raw argv: a flag value naming a subcommand still routes (OBSERVED)", () => {
        // Binary-verified: fl(e) = e.find(f => f.length>0 && f[0]!=="-").
        const p = (0, parse_1.parseArgv)(["--locale", "desktop"]);
        strict_1.default.equal(p.subcommand, "desktop");
        strict_1.default.equal(p.flags["locale"], "desktop");
    });
    (0, node_test_1.it)("flagString returns the first value", () => {
        const p = (0, parse_1.parseArgv)(["--log", "debug", "--log", "trace"]);
        strict_1.default.equal((0, parse_1.flagString)(p, "log"), "debug");
        strict_1.default.equal((0, parse_1.flagString)(p, "wait"), undefined);
    });
    (0, node_test_1.it)("parses --chat/--glass/--classic as public bool flags (P0 cli-glass-classic-chat-flags)", () => {
        const p = (0, parse_1.parseArgv)(["--chat"]);
        strict_1.default.equal(p.flags["chat"], true);
        strict_1.default.ok((0, parse_1.hasFlag)(p, "chat"));
        // None of the three is a subcommand: --chat must not route to the
        // desktop bridge or the agent CLI.
        strict_1.default.equal(p.subcommand, undefined);
        const g = (0, parse_1.parseArgv)(["--glass"]);
        strict_1.default.equal(g.flags["glass"], true);
        strict_1.default.ok((0, parse_1.hasFlag)(g, "glass"));
        const c = (0, parse_1.parseArgv)(["--classic"]);
        strict_1.default.equal(c.flags["classic"], true);
        strict_1.default.ok((0, parse_1.hasFlag)(c, "classic"));
    });
});
// ---------------------------------------------------------------------------
// registry
// ---------------------------------------------------------------------------
(0, node_test_1.describe)("option registry", () => {
    (0, node_test_1.it)("registers exactly 153 flags (binary-verified count)", () => {
        strict_1.default.equal(options_1.OPTIONS.length, 153);
    });
    (0, node_test_1.it)("has 42 public flags, each with a section and non-empty description", () => {
        const pub = options_1.OPTIONS.filter((o) => o.visibility === "public");
        strict_1.default.equal(pub.length, 42);
        for (const o of pub) {
            strict_1.default.ok(o.description.length > 0, o.name);
            strict_1.default.ok(o.section === "o" || o.section === "e" || o.section === "t", o.name);
        }
    });
    (0, node_test_1.it)("keeps the Cursor-specific public descriptions verbatim", () => {
        strict_1.default.equal((0, options_1.getOption)("chat")?.description, "Open a standalone chat window without the full IDE.");
        strict_1.default.equal((0, options_1.getOption)("glass")?.description, "Enable the multi-workbench architecture (dev-only).");
        // --log carries the full NLS text (spec table truncated it).
        strict_1.default.ok(((0, options_1.getOption)("log")?.description ?? "").includes("For example: 'vscode.csharp:trace'."));
        // --add-mcp: verbatim NLS text, with the phantom --mcp-workspace marked.
        const addMcp = (0, options_1.getOption)("add-mcp")?.description ?? "";
        strict_1.default.ok(addMcp.startsWith("Adds a Model Context Protocol server definition to the user profile,"));
        strict_1.default.ok(addMcp.includes("--mcp-workspace (not yet implemented)"));
        strict_1.default.ok(addMcp.includes('\'{"name":"server-name","command":...}\''));
    });
    (0, node_test_1.it)("does not register the phantom --mcp-workspace", () => {
        strict_1.default.equal((0, options_1.getOption)("mcp-workspace"), undefined);
    });
    (0, node_test_1.it)("does not register --remote-debugging-port (binary: injected, not registered)", () => {
        strict_1.default.equal((0, options_1.getOption)("remote-debugging-port"), undefined);
    });
    (0, node_test_1.it)("registers short aliases", () => {
        const cases = [
            ["d", "diff"], ["m", "merge"], ["a", "add"], ["g", "goto"],
            ["n", "new-window"], ["r", "reuse-window"], ["w", "wait"],
            ["h", "help"], ["v", "version"], ["s", "status"],
        ];
        for (const [alias, name] of cases) {
            strict_1.default.equal((0, options_1.getOptionByAlias)(alias)?.name, name, alias);
        }
        // --no-sandbox carries alias "sandbox" (binary-verified).
        strict_1.default.equal((0, options_1.getOptionByAlias)("sandbox")?.name, "no-sandbox");
        strict_1.default.equal((0, options_1.getOption)("sandbox")?.type, "bool");
    });
    (0, node_test_1.it)("has the binary-verified types", () => {
        strict_1.default.equal((0, options_1.getOption)("install-extension")?.type, "string[]");
        strict_1.default.equal((0, options_1.getOption)("file-write")?.type, "bool"); // spec §6 correction
        strict_1.default.equal((0, options_1.getOption)("log")?.type, "string[]");
        strict_1.default.equal((0, options_1.getOption)("_urls")?.type, "string[]");
    });
    (0, node_test_1.it)("marks all 111 hidden flags with a class", () => {
        const hidden = options_1.OPTIONS.filter((o) => o.visibility === "hidden");
        strict_1.default.equal(hidden.length, 111);
        for (const o of hidden) {
            strict_1.default.ok(o.optionClass === "HU" || o.optionClass === "INT" ||
                o.optionClass === "DEV" || o.optionClass === "TEST", o.name);
        }
    });
    (0, node_test_1.it)("exposes the upstream management flag list (spec §1 step 5)", () => {
        strict_1.default.deepEqual(options_1.UPSTREAM_MANAGEMENT_FLAGS.concat().sort(), [
            "add-mcp", "install-extension", "install-source", "list-extensions",
            "locate-extension", "telemetry", "uninstall-extension", "update-extensions",
        ]);
    });
});
// ---------------------------------------------------------------------------
// help
// ---------------------------------------------------------------------------
(0, node_test_1.describe)("help/version", () => {
    (0, node_test_1.it)("prints the 3 sections plus usage with verbatim descriptions", () => {
        const c = capture();
        const code = (0, help_1.printHelp)({ ...c, getVersion: () => "9.9.9" });
        strict_1.default.equal(code, 0);
        const text = c.out.join("\n");
        strict_1.default.ok(text.includes("IDE Code 9.9.9"));
        strict_1.default.ok(text.includes("Usage: ide-code [options][paths...]"));
        strict_1.default.ok(text.includes("To read from stdin, append '-'"));
        strict_1.default.ok(text.includes("\nOptions\n"));
        strict_1.default.ok(text.includes("\nExtensions Management\n"));
        strict_1.default.ok(text.includes("\nTroubleshooting\n"));
        // Descriptions wrap (as Cursor's do); normalize whitespace for checks.
        const flat = text.replace(/\s+/g, " ");
        strict_1.default.ok(flat.includes("Compare two files with each other."));
        strict_1.default.ok(flat.includes("Open a standalone chat window without the full IDE."));
        strict_1.default.ok(text.includes("--add-mcp <json>"));
        strict_1.default.ok(flat.includes("(not yet implemented)"));
    });
    (0, node_test_1.it)("matches Cursor's exact table layout (ported Rn/nl formatter)", () => {
        const c = capture();
        (0, help_1.printHelp)({ ...c, getVersion: () => "3.25.9", columns: 80 });
        const text = c.out.join("\n");
        // Byte-exact rows copied from Cursor 3.25.9 `--help` (only the product
        // name/version differ, plus our intentional --add-mcp/subcommand deltas).
        strict_1.default.ok(text.includes("  -d --diff <file> <file>                    Compare two files with each\n" +
            "                                             other.\n"));
        // Overlong flag text: single space, no padding (OBSERVED quirk).
        strict_1.default.ok(text.includes("  -m --merge <path1> <path2> <base> <result> Perform a three-way merge by\n" +
            "                                             providing paths for two modified\n"));
        strict_1.default.ok(text.includes("  --verbose                               Print verbose output (implies\n" +
            "                                          --wait).\n"));
        strict_1.default.ok(text.includes("  --chat                                     Open a standalone chat window\n" +
            "                                             without the full IDE.\n"));
        // Extensions Management column (38) and Troubleshooting column (42).
        strict_1.default.ok(text.includes("  --install-extension <ext-id | path> Installs or updates an extension. The\n"));
        strict_1.default.ok(text.includes("  -v --version                            Print version.\n"));
        // Subcommands section uses the min-12 +3 column rule (= 15).
        strict_1.default.ok(text.includes("Subcommands\n  agent        Start the IDE Code agent in your terminal.\n"));
        // Our --add-mcp text: verbatim NLS + the phantom marked honestly.
        strict_1.default.ok(text.includes("                                             when used with --mcp-workspace\n" +
            "                                             (not yet implemented). Accepts\n"));
    });
    (0, node_test_1.it)("falls back to flag-per-line layout on narrow terminals (OBSERVED)", () => {
        const c = capture();
        (0, help_1.printHelp)({ ...c, getVersion: () => "3.25.9", columns: 40 });
        const text = c.out.join("\n");
        strict_1.default.ok(text.includes("  -d --diff <file> <file>\n      Compare two files with each other.\n"));
    });
    (0, node_test_1.it)("prints version, then arch (commit omitted when unknown)", () => {
        const c = capture();
        strict_1.default.equal((0, help_1.printVersion)({ ...c, getVersion: () => "9.9.9" }), 0);
        strict_1.default.deepEqual(c.out, [`9.9.9\n${process.arch}`]);
    });
    (0, node_test_1.it)("prints the commit when the packager provides one", () => {
        const c = capture();
        (0, help_1.printVersion)({ ...c, getVersion: () => "9.9.9", getCommit: () => "abc123" });
        strict_1.default.deepEqual(c.out, [`9.9.9\nabc123\n${process.arch}`]);
    });
    (0, node_test_1.it)("rejects an invalid shell for --locate-shell-integration-path", () => {
        const c = capture();
        strict_1.default.equal((0, help_1.locateShellIntegrationPath)("bogus", { ...c, appDir: tmpRoot }), 1);
        strict_1.default.ok(c.err.join("\n").includes("Error using --locate-shell-integration-path: Invalid shell type"));
    });
    (0, node_test_1.it)("resolves the shell integration path when the script exists", () => {
        const scriptDir = path.join(tmpRoot, "out", "vs", "workbench", "contrib", "terminal", "common", "scripts");
        fs.mkdirSync(scriptDir, { recursive: true });
        const script = path.join(scriptDir, "shellIntegration-bash.sh");
        fs.writeFileSync(script, "# fake\n");
        const c = capture();
        strict_1.default.equal((0, help_1.locateShellIntegrationPath)("bash", { ...c, appDir: tmpRoot }), 0);
        strict_1.default.deepEqual(c.out, [script]);
    });
    (0, node_test_1.it)("errors honestly when the script is missing", () => {
        const c = capture();
        strict_1.default.equal((0, help_1.locateShellIntegrationPath)("fish", { ...c, appDir: tmpRoot }), 1);
        strict_1.default.ok(c.err.join("\n").includes("not found"));
    });
});
// ---------------------------------------------------------------------------
// dispatch routing
// ---------------------------------------------------------------------------
(0, node_test_1.describe)("dispatch routing", () => {
    (0, node_test_1.it)("routes desktop to the bridge client with the rest argv", async () => {
        const c = capture();
        const seen = [];
        const code = await (0, dispatch_1.dispatch)(["desktop", "ls", "--json"], {
            ...c,
            runDesktopBridge: async (argv) => { seen.push(argv); return 7; },
        });
        strict_1.default.equal(code, 7);
        strict_1.default.deepEqual(seen, [["ls", "--json"]]);
    });
    (0, node_test_1.it)("routes desktop after leading flags", async () => {
        const c = capture();
        const seen = [];
        const code = await (0, dispatch_1.dispatch)(["--wait", "desktop", "send", "abc"], {
            ...c,
            runDesktopBridge: async (argv) => { seen.push(argv); return 0; },
        });
        strict_1.default.equal(code, 0);
        strict_1.default.deepEqual(seen, [["send", "abc"]]);
    });
    (0, node_test_1.it)("rejects tunnel honestly (not available in this build)", async () => {
        const c = capture();
        const code = await (0, dispatch_1.dispatch)(["tunnel", "status"], { ...c });
        strict_1.default.equal(code, 1);
        strict_1.default.ok(c.err.join("\n").includes("ide-code tunnel is not available in this build"));
    });
    (0, node_test_1.it)("routes agent to the real agent CLI with the rest argv", async () => {
        const c = capture();
        const seen = [];
        const code = await (0, dispatch_1.dispatch)(["agent", "-p", "hello"], {
            ...c,
            runAgent: async (argv) => { seen.push(argv); return 3; },
        });
        strict_1.default.equal(code, 3);
        strict_1.default.deepEqual(seen, [["-p", "hello"]]);
    });
    (0, node_test_1.it)("handles --help and --version", async () => {
        const c = capture();
        strict_1.default.equal(await (0, dispatch_1.dispatch)(["--help"], { ...c }), 0);
        strict_1.default.ok(c.out.join("\n").includes("Troubleshooting"));
        const c2 = capture();
        strict_1.default.equal(await (0, dispatch_1.dispatch)(["-v"], { ...c2 }), 0);
        strict_1.default.ok(c2.out.join("\n").includes(process.arch));
    });
    (0, node_test_1.it)("notices a valueless --locate-shell-integration-path and continues", async () => {
        const c = capture();
        // Falls through to the open path, which fails honestly with no binary.
        const code = await (0, dispatch_1.dispatch)(["--locate-shell-integration-path"], {
            ...c,
            electronBinaryPath: path.join(tmpRoot, "no-such-binary"),
        });
        strict_1.default.equal(code, 1);
        strict_1.default.ok(c.out.join("\n").includes("requires a non empty value. Ignoring the option."));
    });
    (0, node_test_1.it)("errors on --file-write with invalid arguments", async () => {
        const c = capture();
        const code = await (0, dispatch_1.dispatch)(["--file-write"], { ...c });
        strict_1.default.equal(code, 1);
        strict_1.default.ok(c.err.join("\n").includes("Using --file-write with invalid arguments."));
    });
    (0, node_test_1.it)("delegates management flags to the upstream entry when present", async () => {
        const seenFile = path.join(tmpRoot, "upstream-args.json");
        process.env.FAKE_UPSTREAM_CAPTURE = seenFile;
        const upstream = path.join(tmpRoot, "fake-cliProcessMain.js");
        fs.writeFileSync(upstream, `module.exports = { main: async (args) => { require("fs").writeFileSync(process.env.FAKE_UPSTREAM_CAPTURE, JSON.stringify(args)); } };\n`);
        const c = capture();
        const code = await (0, dispatch_1.dispatch)(["--list-extensions", "--show-versions"], {
            ...c, upstreamEntry: upstream,
        });
        strict_1.default.equal(code, 0);
        const got = JSON.parse(fs.readFileSync(seenFile, "utf8"));
        strict_1.default.equal(got["list-extensions"], true);
        strict_1.default.equal(got["show-versions"], true);
    });
    (0, node_test_1.it)("errors honestly when the upstream entry is missing", async () => {
        const c = capture();
        const code = await (0, dispatch_1.dispatch)(["--list-extensions"], {
            ...c, upstreamEntry: path.join(tmpRoot, "missing-cliProcessMain.js"),
        });
        strict_1.default.equal(code, 1);
        strict_1.default.ok(c.err.join("\n").includes("not available in this build"));
    });
});
// ---------------------------------------------------------------------------
// --chat dispatch (P0 cli-glass-classic-chat-flags)
// ---------------------------------------------------------------------------
(0, node_test_1.describe)("--chat dispatch", () => {
    (0, node_test_1.it)("launches the app with the --chat intent forwarded (explicit step, not a silent fallthrough)", async () => {
        const c = capture();
        const fakeApp = writeFakeApp();
        const capFile = path.join(tmpRoot, "chat-capture.txt");
        process.env.FAKE_APP_CAPTURE = capFile;
        try {
            const code = await (0, dispatch_1.dispatch)(["--chat"], {
                ...c, electronBinaryPath: fakeApp,
            });
            strict_1.default.equal(code, 0);
            await waitForFile(capFile);
            const forwarded = lastCaptureLine(capFile);
            strict_1.default.ok(forwarded.includes("--chat"), "the chat intent must reach the app binary");
        }
        finally {
            delete process.env.FAKE_APP_CAPTURE;
        }
    });
    (0, node_test_1.it)("does not route --chat to the desktop bridge", async () => {
        const c = capture();
        const fakeApp = writeFakeApp();
        const capFile = path.join(tmpRoot, "chat-nobridge-capture.txt");
        process.env.FAKE_APP_CAPTURE = capFile;
        let bridged = false;
        try {
            const code = await (0, dispatch_1.dispatch)(["--chat"], {
                ...c,
                electronBinaryPath: fakeApp,
                runDesktopBridge: async () => { bridged = true; return 0; },
            });
            strict_1.default.equal(code, 0);
            strict_1.default.equal(bridged, false);
            await waitForFile(capFile);
        }
        finally {
            delete process.env.FAKE_APP_CAPTURE;
        }
    });
    (0, node_test_1.it)("--help wins over --chat (dispatch order: help is step 4, chat is step 6b)", async () => {
        const c = capture();
        const code = await (0, dispatch_1.dispatch)(["--chat", "--help"], {
            ...c,
            electronBinaryPath: path.join(tmpRoot, "no-such-binary"),
        });
        strict_1.default.equal(code, 0);
        // Descriptions wrap in the table; normalize whitespace like the help tests do.
        const flat = c.out.join("\n").replace(/\s+/g, " ");
        strict_1.default.ok(flat.includes("Open a standalone chat window without the full IDE."));
        strict_1.default.ok(flat.includes("--chat"));
    });
    (0, node_test_1.it)("--glass and --classic forward to the app like any open-path flag", async () => {
        const c = capture();
        const fakeApp = writeFakeApp();
        const capFile = path.join(tmpRoot, "glass-classic-capture.txt");
        process.env.FAKE_APP_CAPTURE = capFile;
        try {
            strict_1.default.equal(await (0, dispatch_1.dispatch)(["--glass"], { ...c, electronBinaryPath: fakeApp }), 0);
            await waitForFile(capFile);
            strict_1.default.ok(lastCaptureLine(capFile).includes("--glass"));
            fs.unlinkSync(capFile);
            strict_1.default.equal(await (0, dispatch_1.dispatch)(["--classic"], { ...c, electronBinaryPath: fakeApp }), 0);
            await waitForFile(capFile);
            strict_1.default.ok(lastCaptureLine(capFile).includes("--classic"));
        }
        finally {
            delete process.env.FAKE_APP_CAPTURE;
        }
    });
});
// ---------------------------------------------------------------------------
// --file-write
// ---------------------------------------------------------------------------
(0, node_test_1.describe)("--file-write", () => {
    (0, node_test_1.it)("copies source to target from the JSON file", async () => {
        const c = capture();
        const src = tmpFile("fw-src.txt", "file-write payload");
        const dst = tmpFile("fw-dst.txt", "old");
        const json = tmpFile("fw.json", JSON.stringify({ source: src, target: dst }));
        const code = await (0, dispatch_1.runFileWrite)((0, parse_1.parseArgv)(["--file-write", json]), c);
        strict_1.default.equal(code, 0);
        strict_1.default.equal(fs.readFileSync(dst, "utf8"), "file-write payload");
    });
    (0, node_test_1.it)("honors --file-chmod: temp owner-write on a read-only target, then restores", async () => {
        const c = capture();
        const src = tmpFile("fw2-src.txt", "chmod payload");
        const dst = tmpFile("fw2-dst.txt", "old");
        fs.chmodSync(dst, 0o444);
        const json = tmpFile("fw2.json", JSON.stringify({ source: src, target: dst }));
        const code = await (0, dispatch_1.runFileWrite)((0, parse_1.parseArgv)(["--file-write", "--file-chmod", json]), c);
        strict_1.default.equal(code, 0);
        strict_1.default.equal(fs.readFileSync(dst, "utf8"), "chmod payload");
        strict_1.default.equal(fs.statSync(dst).mode & 0o777, 0o444);
    });
    (0, node_test_1.it)("rejects non-absolute or missing paths", async () => {
        const c = capture();
        const json = tmpFile("fw3.json", JSON.stringify({ source: "rel.txt", target: "/tmp/x" }));
        strict_1.default.equal(await (0, dispatch_1.runFileWrite)((0, parse_1.parseArgv)(["--file-write", json]), c), 1);
        strict_1.default.ok(c.err.join("\n").includes("Using --file-write with invalid arguments."));
        const c2 = capture();
        strict_1.default.equal(await (0, dispatch_1.runFileWrite)((0, parse_1.parseArgv)(["--file-write", "not-json"]), c2), 1);
    });
    (0, node_test_1.it)("reports copy failures verbatim-style", async () => {
        const c = capture();
        const src = tmpFile("fw4-src.txt", "x");
        // target is a directory -> stat isFile() false -> invalid arguments
        const json = tmpFile("fw4.json", JSON.stringify({ source: src, target: tmpRoot }));
        strict_1.default.equal(await (0, dispatch_1.runFileWrite)((0, parse_1.parseArgv)(["--file-write", json]), c), 1);
        strict_1.default.ok(c.err.join("\n").includes("Using --file-write with invalid arguments."));
    });
});
// ---------------------------------------------------------------------------
// open path: --wait marker protocol + spawn failure
// ---------------------------------------------------------------------------
(0, node_test_1.describe)("open path", () => {
    (0, node_test_1.it)("implements the --wait marker protocol with a fake app that deletes the marker", async () => {
        const c = capture();
        const fakeApp = writeFakeApp();
        // The fake deletes the marker at ~300ms but exits 42 much later. If the
        // CLI returns 0, it waited on the MARKER file (not on child exit).
        process.env.FAKE_APP_EXIT = "42";
        process.env.FAKE_APP_EXIT_DELAY = "4000";
        try {
            const code = await (0, dispatch_1.dispatch)(["--wait", "somefile.txt"], {
                ...c, electronBinaryPath: fakeApp,
            });
            strict_1.default.equal(code, 0);
        }
        finally {
            delete process.env.FAKE_APP_EXIT;
            delete process.env.FAKE_APP_EXIT_DELAY;
        }
    });
    (0, node_test_1.it)("--verbose implies --wait (marker appended to forwarded argv)", async () => {
        const c = capture();
        const fakeApp = writeFakeApp();
        const capFile = path.join(tmpRoot, "verbose-capture.txt");
        process.env.FAKE_APP_CAPTURE = capFile;
        const code = await (0, dispatch_1.dispatch)(["--verbose", "somefile.txt"], {
            ...c, electronBinaryPath: fakeApp,
        });
        strict_1.default.equal(code, 0);
        const forwarded = lastCaptureLine(capFile);
        const i = forwarded.indexOf("--waitMarkerFilePath");
        strict_1.default.ok(i !== -1, "marker flag forwarded");
        strict_1.default.ok(forwarded[i + 1].includes("ide-code-wait-"));
        strict_1.default.ok(!fs.existsSync(forwarded[i + 1]), "marker cleaned up");
    });
    (0, node_test_1.it)("buffers stdin - to a temp file (spec §4.4)", async () => {
        const c = capture();
        const fakeApp = writeFakeApp();
        const capFile = path.join(tmpRoot, "stdin-capture.txt");
        process.env.FAKE_APP_CAPTURE = capFile;
        const code = await (0, dispatch_1.dispatch)(["-"], {
            ...c,
            electronBinaryPath: fakeApp,
            stdinIsTTY: false,
            readStdin: async () => Buffer.from("hello-stdin"),
        });
        strict_1.default.equal(code, 0);
        strict_1.default.ok(c.out.join("\n").includes("Reading from stdin via: "));
        // Fire-and-forget returns on "spawn"; the fake's node needs a moment.
        await waitForFile(capFile);
        const forwarded = lastCaptureLine(capFile);
        strict_1.default.ok(!forwarded.includes("-"), "lone - stripped");
        strict_1.default.ok(forwarded.includes("--skip-add-to-recently-opened"));
        const tmpIdx = forwarded.findIndex((a) => a.includes("ide-code-stdin-"));
        strict_1.default.ok(tmpIdx !== -1);
        strict_1.default.equal(fs.readFileSync(forwarded[tmpIdx], "utf8"), "hello-stdin");
    });
    (0, node_test_1.it)("returns exit 1 with stderr on spawn failure (never silent)", async () => {
        const c = capture();
        const code = await (0, dispatch_1.dispatch)(["somefile.txt"], {
            ...c,
            electronBinaryPath: path.join(tmpRoot, "no-such-electron-binary"),
            spawn: child_process.spawn,
        });
        strict_1.default.equal(code, 1);
        strict_1.default.ok(c.err.join("\n").includes("error: could not start the IDE Code app:"));
    });
    (0, node_test_1.it)("forwards argv and env through to the app binary", async () => {
        const c = capture();
        const fakeApp = writeFakeApp();
        const capFile = path.join(tmpRoot, "fwd-capture.txt");
        process.env.FAKE_APP_CAPTURE = capFile;
        const code = await (0, dispatch_1.dispatch)(["--new-window", "mydir"], {
            ...c, electronBinaryPath: fakeApp,
        });
        strict_1.default.equal(code, 0);
        await waitForFile(capFile);
        strict_1.default.deepEqual(lastCaptureLine(capFile), ["--new-window", "mydir"]);
    });
    (0, node_test_1.it)("openApp surfaces a throwing spawn as exit 1", async () => {
        const c = capture();
        const boom = () => { throw new Error("spawn ENOMEM"); };
        const code = await (0, dispatch_1.openApp)(["x"], (0, parse_1.parseArgv)(["x"]), {
            electronBinaryPath: "/bin/false",
            spawn: boom,
            readStdin: async () => Buffer.from(""),
            stdinIsTTY: true,
            stdout: c.stdout,
            stderr: c.stderr,
        });
        strict_1.default.equal(code, 1);
        strict_1.default.ok(c.err.join("\n").includes("spawn ENOMEM"));
    });
    (0, node_test_1.it)("openApp handles an 'error'-emitting child in fire-and-forget mode", async () => {
        const c = capture();
        const fakeSpawn = (() => {
            const ee = new node_events_1.EventEmitter();
            setImmediate(() => ee.emit("error", new Error("spawn ENOENT")));
            return ee;
        });
        const code = await (0, dispatch_1.openApp)(["x"], (0, parse_1.parseArgv)(["x"]), {
            electronBinaryPath: "/bin/false",
            spawn: fakeSpawn,
            readStdin: async () => Buffer.from(""),
            stdinIsTTY: true,
            stdout: c.stdout,
            stderr: c.stderr,
        });
        strict_1.default.equal(code, 1);
        strict_1.default.ok(c.err.join("\n").includes("spawn ENOENT"));
    });
});
// ---------------------------------------------------------------------------
// delegateToUpstream unit
// ---------------------------------------------------------------------------
(0, node_test_1.describe)("delegateToUpstream", () => {
    (0, node_test_1.it)("returns 1 when the module has no main()", async () => {
        const c = capture();
        const mod = path.join(tmpRoot, "no-main.js");
        fs.writeFileSync(mod, `module.exports = {};\n`);
        const code = await (0, dispatch_1.delegateToUpstream)((0, parse_1.parseArgv)(["--telemetry"]), {
            upstreamEntry: mod, stdout: c.stdout, stderr: c.stderr,
        });
        strict_1.default.equal(code, 1);
        strict_1.default.ok(c.err.join("\n").includes("no main()"));
    });
});
