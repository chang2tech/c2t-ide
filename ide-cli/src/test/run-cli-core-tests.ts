/**
 * run-cli-core-tests.ts — node:test suite for the CLI core worker.
 *
 * Covers: parser, option registry (153 flags), help output, dispatch
 * routing, --file-write, the --wait marker protocol, and open-path spawn
 * failure. All externals are injected fakes — no network, no real apps.
 *
 * Run:  npx tsc && node --test out/test/run-cli-core-tests.js
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import * as child_process from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { EventEmitter } from "node:events";

import { OPTIONS, UPSTREAM_MANAGEMENT_FLAGS, getOption, getOptionByAlias } from "../options";
import { parseArgv, hasFlag, flagString } from "../parse";
import { printHelp, printVersion, locateShellIntegrationPath } from "../help";
import { dispatch, delegateToUpstream, runFileWrite, openApp } from "../dispatch";

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

interface Capture {
  out: string[];
  err: string[];
  stdout: (s: string) => void;
  stderr: (s: string) => void;
}

function capture(): Capture {
  const c: Capture = {
    out: [],
    err: [],
    stdout: (s: string) => c.out.push(s),
    stderr: (s: string) => c.err.push(s),
  };
  return c;
}

let tmpRoot = "";

before(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ide-cli-core-test-"));
});

after(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  delete process.env.FAKE_APP_CAPTURE;
  delete process.env.FAKE_APP_EXIT;
  delete process.env.FAKE_UPSTREAM_CAPTURE;
});

function tmpFile(name: string, content: string): string {
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
function writeFakeApp(): string {
  const p = path.join(tmpRoot, "fake-app.js");
  fs.writeFileSync(
    p,
    `#!/usr/bin/env node
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
`
  );
  fs.chmodSync(p, 0o755);
  return p;
}

/** Poll for a file to appear (the fake app's node needs ~1s cold start here). */
async function waitForFile(p: string, timeoutMs = 15000): Promise<void> {
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

function lastCaptureLine(capFile: string): string[] {
  const lines = fs.readFileSync(capFile, "utf8").trim().split("\n");
  return JSON.parse(lines[lines.length - 1] as string) as string[];
}

// ---------------------------------------------------------------------------
// parser
// ---------------------------------------------------------------------------

describe("parseArgv", () => {
  it("parses --flag value and --flag=value", () => {
    assert.equal(parseArgv(["--locale", "en-US"]).flags["locale"], "en-US");
    assert.equal(parseArgv(["--locale=en-US"]).flags["locale"], "en-US");
  });

  it("parses boolean flags", () => {
    const p = parseArgv(["--wait"]);
    assert.equal(p.flags["wait"], true);
    assert.ok(hasFlag(p, "wait"));
  });

  it("parses short flags and clusters", () => {
    assert.equal(parseArgv(["-w"]).flags["wait"], true);
    const p = parseArgv(["-wn"]);
    assert.equal(p.flags["wait"], true);
    assert.equal(p.flags["new-window"], true);
  });

  it("honors the -- terminator for flags (but the subcommand scan is raw)", () => {
    const p = parseArgv(["--", "--wait", "desktop"]);
    assert.equal(hasFlag(p, "wait"), false);
    assert.deepEqual(p._.concat(), ["--wait", "desktop"]);
    // Cursor's fl()/Ln() scan the RAW argv: the first non-dash token names
    // the subcommand even after `--` (OBSERVED binary behavior).
    assert.equal(p.subcommand, "desktop");
    assert.equal(p.subcommandIndex, 2);
  });

  it("keeps lone - as a positional", () => {
    const p = parseArgv(["-"]);
    assert.deepEqual(p._.concat(), ["-"]);
  });

  it("accumulates string[] flags", () => {
    const p = parseArgv(["--install-extension", "a", "--install-extension", "b"]);
    assert.deepEqual(p.flags["install-extension"], ["a", "b"]);
  });

  it("collects unknown flags without crashing (minimist-flavored)", () => {
    const p = parseArgv(["--frobnicate", "x", "--other"]);
    assert.deepEqual(p.unknown, ["frobnicate", "other"]);
    assert.equal(p.flags["frobnicate"], "x");
    assert.equal(p.flags["other"], true);
    const q = parseArgv(["--weird=1"]);
    assert.equal(q.flags["weird"], "1");
  });

  it("records string flags missing a value (Cursor: notice + ignore)", () => {
    const p = parseArgv(["--locale"]);
    assert.deepEqual(p.missingValue, ["locale"]);
    assert.equal(p.flags["locale"], undefined);
  });

  it("mirrors aliases onto the canonical name", () => {
    const p = parseArgv(["--no-sandbox"]);
    assert.equal(p.flags["no-sandbox"], true);
    assert.equal(p.flags["sandbox"], true);
  });

  it("detects the subcommand as the first raw non-dash token (Cursor fl()/Ln())", () => {
    const p = parseArgv(["desktop", "ls"]);
    assert.equal(p.subcommand, "desktop");
    assert.equal(p.subcommandIndex, 0);
    const q = parseArgv(["--wait", "agent", "-p", "hi"]);
    assert.equal(q.subcommand, "agent");
    assert.equal(q.subcommandIndex, 1);
  });

  it("scans raw argv: a flag value naming a subcommand still routes (OBSERVED)", () => {
    // Binary-verified: fl(e) = e.find(f => f.length>0 && f[0]!=="-").
    const p = parseArgv(["--locale", "desktop"]);
    assert.equal(p.subcommand, "desktop");
    assert.equal(p.flags["locale"], "desktop");
  });

  it("flagString returns the first value", () => {
    const p = parseArgv(["--log", "debug", "--log", "trace"]);
    assert.equal(flagString(p, "log"), "debug");
    assert.equal(flagString(p, "wait"), undefined);
  });

  it("parses --chat/--glass/--classic as public bool flags (P0 cli-glass-classic-chat-flags)", () => {
    const p = parseArgv(["--chat"]);
    assert.equal(p.flags["chat"], true);
    assert.ok(hasFlag(p, "chat"));
    // None of the three is a subcommand: --chat must not route to the
    // desktop bridge or the agent CLI.
    assert.equal(p.subcommand, undefined);
    const g = parseArgv(["--glass"]);
    assert.equal(g.flags["glass"], true);
    assert.ok(hasFlag(g, "glass"));
    const c = parseArgv(["--classic"]);
    assert.equal(c.flags["classic"], true);
    assert.ok(hasFlag(c, "classic"));
  });
});

// ---------------------------------------------------------------------------
// registry
// ---------------------------------------------------------------------------

describe("option registry", () => {
  it("registers exactly 153 flags (binary-verified count)", () => {
    assert.equal(OPTIONS.length, 153);
  });

  it("has 42 public flags, each with a section and non-empty description", () => {
    const pub = OPTIONS.filter((o) => o.visibility === "public");
    assert.equal(pub.length, 42);
    for (const o of pub) {
      assert.ok(o.description.length > 0, o.name);
      assert.ok(o.section === "o" || o.section === "e" || o.section === "t", o.name);
    }
  });

  it("keeps the Cursor-specific public descriptions verbatim", () => {
    assert.equal(
      getOption("chat")?.description,
      "Open a standalone chat window without the full IDE."
    );
    assert.equal(
      getOption("glass")?.description,
      "Enable the multi-workbench architecture (dev-only)."
    );
    // --log carries the full NLS text (spec table truncated it).
    assert.ok(
      (getOption("log")?.description ?? "").includes("For example: 'vscode.csharp:trace'.")
    );
    // --add-mcp: verbatim NLS text, with the phantom --mcp-workspace marked.
    const addMcp = getOption("add-mcp")?.description ?? "";
    assert.ok(addMcp.startsWith("Adds a Model Context Protocol server definition to the user profile,"));
    assert.ok(addMcp.includes("--mcp-workspace (not yet implemented)"));
    assert.ok(addMcp.includes('\'{"name":"server-name","command":...}\''));
  });

  it("does not register the phantom --mcp-workspace", () => {
    assert.equal(getOption("mcp-workspace"), undefined);
  });

  it("does not register --remote-debugging-port (binary: injected, not registered)", () => {
    assert.equal(getOption("remote-debugging-port"), undefined);
  });

  it("registers short aliases", () => {
    const cases: Array<[string, string]> = [
      ["d", "diff"], ["m", "merge"], ["a", "add"], ["g", "goto"],
      ["n", "new-window"], ["r", "reuse-window"], ["w", "wait"],
      ["h", "help"], ["v", "version"], ["s", "status"],
    ];
    for (const [alias, name] of cases) {
      assert.equal(getOptionByAlias(alias)?.name, name, alias);
    }
    // --no-sandbox carries alias "sandbox" (binary-verified).
    assert.equal(getOptionByAlias("sandbox")?.name, "no-sandbox");
    assert.equal(getOption("sandbox")?.type, "bool");
  });

  it("has the binary-verified types", () => {
    assert.equal(getOption("install-extension")?.type, "string[]");
    assert.equal(getOption("file-write")?.type, "bool"); // spec §6 correction
    assert.equal(getOption("log")?.type, "string[]");
    assert.equal(getOption("_urls")?.type, "string[]");
  });

  it("marks all 111 hidden flags with a class", () => {
    const hidden = OPTIONS.filter((o) => o.visibility === "hidden");
    assert.equal(hidden.length, 111);
    for (const o of hidden) {
      assert.ok(
        o.optionClass === "HU" || o.optionClass === "INT" ||
          o.optionClass === "DEV" || o.optionClass === "TEST",
        o.name
      );
    }
  });

  it("exposes the upstream management flag list (spec §1 step 5)", () => {
    assert.deepEqual(UPSTREAM_MANAGEMENT_FLAGS.concat().sort(), [
      "add-mcp", "install-extension", "install-source", "list-extensions",
      "locate-extension", "telemetry", "uninstall-extension", "update-extensions",
    ]);
  });
});

// ---------------------------------------------------------------------------
// help
// ---------------------------------------------------------------------------

describe("help/version", () => {
  it("prints the 3 sections plus usage with verbatim descriptions", () => {
    const c = capture();
    const code = printHelp({ ...c, getVersion: () => "9.9.9" });
    assert.equal(code, 0);
    const text = c.out.join("\n");
    assert.ok(text.includes("IDE Code 9.9.9"));
    assert.ok(text.includes("Usage: ide-code [options][paths...]"));
    assert.ok(text.includes("To read from stdin, append '-'"));
    assert.ok(text.includes("\nOptions\n"));
    assert.ok(text.includes("\nExtensions Management\n"));
    assert.ok(text.includes("\nTroubleshooting\n"));
    // Descriptions wrap (as Cursor's do); normalize whitespace for checks.
    const flat = text.replace(/\s+/g, " ");
    assert.ok(flat.includes("Compare two files with each other."));
    assert.ok(flat.includes("Open a standalone chat window without the full IDE."));
    assert.ok(text.includes("--add-mcp <json>"));
    assert.ok(flat.includes("(not yet implemented)"));
  });

  it("matches Cursor's exact table layout (ported Rn/nl formatter)", () => {
    const c = capture();
    printHelp({ ...c, getVersion: () => "3.25.9", columns: 80 });
    const text = c.out.join("\n");
    // Byte-exact rows copied from Cursor 3.25.9 `--help` (only the product
    // name/version differ, plus our intentional --add-mcp/subcommand deltas).
    assert.ok(
      text.includes(
        "  -d --diff <file> <file>                    Compare two files with each\n" +
        "                                             other.\n"
      )
    );
    // Overlong flag text: single space, no padding (OBSERVED quirk).
    assert.ok(
      text.includes(
        "  -m --merge <path1> <path2> <base> <result> Perform a three-way merge by\n" +
        "                                             providing paths for two modified\n"
      )
    );
    assert.ok(
      text.includes(
        "  --verbose                               Print verbose output (implies\n" +
        "                                          --wait).\n"
      )
    );
    assert.ok(
      text.includes(
        "  --chat                                     Open a standalone chat window\n" +
        "                                             without the full IDE.\n"
      )
    );
    // Extensions Management column (38) and Troubleshooting column (42).
    assert.ok(
      text.includes(
        "  --install-extension <ext-id | path> Installs or updates an extension. The\n"
      )
    );
    assert.ok(
      text.includes(
        "  -v --version                            Print version.\n"
      )
    );
    // Subcommands section uses the min-12 +3 column rule (= 15).
    assert.ok(
      text.includes(
        "Subcommands\n  agent        Start the IDE Code agent in your terminal.\n"
      )
    );
    // Our --add-mcp text: verbatim NLS + the phantom marked honestly.
    assert.ok(
      text.includes(
        "                                             when used with --mcp-workspace\n" +
        "                                             (not yet implemented). Accepts\n"
      )
    );
  });

  it("falls back to flag-per-line layout on narrow terminals (OBSERVED)", () => {
    const c = capture();
    printHelp({ ...c, getVersion: () => "3.25.9", columns: 40 });
    const text = c.out.join("\n");
    assert.ok(text.includes("  -d --diff <file> <file>\n      Compare two files with each other.\n"));
  });

  it("prints version, then arch (commit omitted when unknown)", () => {
    const c = capture();
    assert.equal(printVersion({ ...c, getVersion: () => "9.9.9" }), 0);
    assert.deepEqual(c.out, [`9.9.9\n${process.arch}`]);
  });

  it("prints the commit when the packager provides one", () => {
    const c = capture();
    printVersion({ ...c, getVersion: () => "9.9.9", getCommit: () => "abc123" });
    assert.deepEqual(c.out, [`9.9.9\nabc123\n${process.arch}`]);
  });

  it("rejects an invalid shell for --locate-shell-integration-path", () => {
    const c = capture();
    assert.equal(locateShellIntegrationPath("bogus", { ...c, appDir: tmpRoot }), 1);
    assert.ok(c.err.join("\n").includes("Error using --locate-shell-integration-path: Invalid shell type"));
  });

  it("resolves the shell integration path when the script exists", () => {
    const scriptDir = path.join(tmpRoot, "out", "vs", "workbench", "contrib", "terminal", "common", "scripts");
    fs.mkdirSync(scriptDir, { recursive: true });
    const script = path.join(scriptDir, "shellIntegration-bash.sh");
    fs.writeFileSync(script, "# fake\n");
    const c = capture();
    assert.equal(locateShellIntegrationPath("bash", { ...c, appDir: tmpRoot }), 0);
    assert.deepEqual(c.out, [script]);
  });

  it("errors honestly when the script is missing", () => {
    const c = capture();
    assert.equal(locateShellIntegrationPath("fish", { ...c, appDir: tmpRoot }), 1);
    assert.ok(c.err.join("\n").includes("not found"));
  });
});

// ---------------------------------------------------------------------------
// dispatch routing
// ---------------------------------------------------------------------------

describe("dispatch routing", () => {
  it("routes desktop to the bridge client with the rest argv", async () => {
    const c = capture();
    const seen: string[][] = [];
    const code = await dispatch(["desktop", "ls", "--json"], {
      ...c,
      runDesktopBridge: async (argv: string[]) => { seen.push(argv); return 7; },
    });
    assert.equal(code, 7);
    assert.deepEqual(seen, [["ls", "--json"]]);
  });

  it("routes desktop after leading flags", async () => {
    const c = capture();
    const seen: string[][] = [];
    const code = await dispatch(["--wait", "desktop", "send", "abc"], {
      ...c,
      runDesktopBridge: async (argv: string[]) => { seen.push(argv); return 0; },
    });
    assert.equal(code, 0);
    assert.deepEqual(seen, [["send", "abc"]]);
  });

  it("rejects tunnel honestly (not available in this build)", async () => {
    const c = capture();
    const code = await dispatch(["tunnel", "status"], { ...c });
    assert.equal(code, 1);
    assert.ok(c.err.join("\n").includes("ide-code tunnel is not available in this build"));
  });

  it("routes agent to the real agent CLI with the rest argv", async () => {
    const c = capture();
    const seen: string[][] = [];
    const code = await dispatch(["agent", "-p", "hello"], {
      ...c,
      runAgent: async (argv: string[]) => { seen.push(argv); return 3; },
    });
    assert.equal(code, 3);
    assert.deepEqual(seen, [["-p", "hello"]]);
  });

  it("handles --help and --version", async () => {
    const c = capture();
    assert.equal(await dispatch(["--help"], { ...c }), 0);
    assert.ok(c.out.join("\n").includes("Troubleshooting"));
    const c2 = capture();
    assert.equal(await dispatch(["-v"], { ...c2 }), 0);
    assert.ok(c2.out.join("\n").includes(process.arch));
  });

  it("notices a valueless --locate-shell-integration-path and continues", async () => {
    const c = capture();
    // Falls through to the open path, which fails honestly with no binary.
    const code = await dispatch(["--locate-shell-integration-path"], {
      ...c,
      electronBinaryPath: path.join(tmpRoot, "no-such-binary"),
    });
    assert.equal(code, 1);
    assert.ok(c.out.join("\n").includes("requires a non empty value. Ignoring the option."));
  });

  it("errors on --file-write with invalid arguments", async () => {
    const c = capture();
    const code = await dispatch(["--file-write"], { ...c });
    assert.equal(code, 1);
    assert.ok(c.err.join("\n").includes("Using --file-write with invalid arguments."));
  });

  it("delegates management flags to the upstream entry when present", async () => {
    const seenFile = path.join(tmpRoot, "upstream-args.json");
    process.env.FAKE_UPSTREAM_CAPTURE = seenFile;
    const upstream = path.join(tmpRoot, "fake-cliProcessMain.js");
    fs.writeFileSync(
      upstream,
      `module.exports = { main: async (args) => { require("fs").writeFileSync(process.env.FAKE_UPSTREAM_CAPTURE, JSON.stringify(args)); } };\n`
    );
    const c = capture();
    const code = await dispatch(["--list-extensions", "--show-versions"], {
      ...c, upstreamEntry: upstream,
    });
    assert.equal(code, 0);
    const got = JSON.parse(fs.readFileSync(seenFile, "utf8"));
    assert.equal(got["list-extensions"], true);
    assert.equal(got["show-versions"], true);
  });

  it("errors honestly when the upstream entry is missing", async () => {
    const c = capture();
    const code = await dispatch(["--list-extensions"], {
      ...c, upstreamEntry: path.join(tmpRoot, "missing-cliProcessMain.js"),
    });
    assert.equal(code, 1);
    assert.ok(c.err.join("\n").includes("not available in this build"));
  });
});

// ---------------------------------------------------------------------------
// --chat dispatch (P0 cli-glass-classic-chat-flags)
// ---------------------------------------------------------------------------

describe("--chat dispatch", () => {
  it("launches the app with the --chat intent forwarded (explicit step, not a silent fallthrough)", async () => {
    const c = capture();
    const fakeApp = writeFakeApp();
    const capFile = path.join(tmpRoot, "chat-capture.txt");
    process.env.FAKE_APP_CAPTURE = capFile;
    try {
      const code = await dispatch(["--chat"], {
        ...c, electronBinaryPath: fakeApp,
      });
      assert.equal(code, 0);
      await waitForFile(capFile);
      const forwarded = lastCaptureLine(capFile);
      assert.ok(forwarded.includes("--chat"), "the chat intent must reach the app binary");
    } finally {
      delete process.env.FAKE_APP_CAPTURE;
    }
  });

  it("does not route --chat to the desktop bridge", async () => {
    const c = capture();
    const fakeApp = writeFakeApp();
    const capFile = path.join(tmpRoot, "chat-nobridge-capture.txt");
    process.env.FAKE_APP_CAPTURE = capFile;
    let bridged = false;
    try {
      const code = await dispatch(["--chat"], {
        ...c,
        electronBinaryPath: fakeApp,
        runDesktopBridge: async () => { bridged = true; return 0; },
      });
      assert.equal(code, 0);
      assert.equal(bridged, false);
      await waitForFile(capFile);
    } finally {
      delete process.env.FAKE_APP_CAPTURE;
    }
  });

  it("--help wins over --chat (dispatch order: help is step 4, chat is step 6b)", async () => {
    const c = capture();
    const code = await dispatch(["--chat", "--help"], {
      ...c,
      electronBinaryPath: path.join(tmpRoot, "no-such-binary"),
    });
    assert.equal(code, 0);
    // Descriptions wrap in the table; normalize whitespace like the help tests do.
    const flat = c.out.join("\n").replace(/\s+/g, " ");
    assert.ok(flat.includes("Open a standalone chat window without the full IDE."));
    assert.ok(flat.includes("--chat"));
  });

  it("--glass and --classic forward to the app like any open-path flag", async () => {
    const c = capture();
    const fakeApp = writeFakeApp();
    const capFile = path.join(tmpRoot, "glass-classic-capture.txt");
    process.env.FAKE_APP_CAPTURE = capFile;
    try {
      assert.equal(await dispatch(["--glass"], { ...c, electronBinaryPath: fakeApp }), 0);
      await waitForFile(capFile);
      assert.ok(lastCaptureLine(capFile).includes("--glass"));
      fs.unlinkSync(capFile);
      assert.equal(await dispatch(["--classic"], { ...c, electronBinaryPath: fakeApp }), 0);
      await waitForFile(capFile);
      assert.ok(lastCaptureLine(capFile).includes("--classic"));
    } finally {
      delete process.env.FAKE_APP_CAPTURE;
    }
  });
});

// ---------------------------------------------------------------------------
// --file-write
// ---------------------------------------------------------------------------

describe("--file-write", () => {
  it("copies source to target from the JSON file", async () => {
    const c = capture();
    const src = tmpFile("fw-src.txt", "file-write payload");
    const dst = tmpFile("fw-dst.txt", "old");
    const json = tmpFile("fw.json", JSON.stringify({ source: src, target: dst }));
    const code = await runFileWrite(parseArgv(["--file-write", json]), c);
    assert.equal(code, 0);
    assert.equal(fs.readFileSync(dst, "utf8"), "file-write payload");
  });

  it("honors --file-chmod: temp owner-write on a read-only target, then restores", async () => {
    const c = capture();
    const src = tmpFile("fw2-src.txt", "chmod payload");
    const dst = tmpFile("fw2-dst.txt", "old");
    fs.chmodSync(dst, 0o444);
    const json = tmpFile("fw2.json", JSON.stringify({ source: src, target: dst }));
    const code = await runFileWrite(parseArgv(["--file-write", "--file-chmod", json]), c);
    assert.equal(code, 0);
    assert.equal(fs.readFileSync(dst, "utf8"), "chmod payload");
    assert.equal(fs.statSync(dst).mode & 0o777, 0o444);
  });

  it("rejects non-absolute or missing paths", async () => {
    const c = capture();
    const json = tmpFile("fw3.json", JSON.stringify({ source: "rel.txt", target: "/tmp/x" }));
    assert.equal(await runFileWrite(parseArgv(["--file-write", json]), c), 1);
    assert.ok(c.err.join("\n").includes("Using --file-write with invalid arguments."));
    const c2 = capture();
    assert.equal(await runFileWrite(parseArgv(["--file-write", "not-json"]), c2), 1);
  });

  it("reports copy failures verbatim-style", async () => {
    const c = capture();
    const src = tmpFile("fw4-src.txt", "x");
    // target is a directory -> stat isFile() false -> invalid arguments
    const json = tmpFile("fw4.json", JSON.stringify({ source: src, target: tmpRoot }));
    assert.equal(await runFileWrite(parseArgv(["--file-write", json]), c), 1);
    assert.ok(c.err.join("\n").includes("Using --file-write with invalid arguments."));
  });
});

// ---------------------------------------------------------------------------
// open path: --wait marker protocol + spawn failure
// ---------------------------------------------------------------------------

describe("open path", () => {
  it("implements the --wait marker protocol with a fake app that deletes the marker", async () => {
    const c = capture();
    const fakeApp = writeFakeApp();
    // The fake deletes the marker at ~300ms but exits 42 much later. If the
    // CLI returns 0, it waited on the MARKER file (not on child exit).
    process.env.FAKE_APP_EXIT = "42";
    process.env.FAKE_APP_EXIT_DELAY = "4000";
    try {
      const code = await dispatch(["--wait", "somefile.txt"], {
        ...c, electronBinaryPath: fakeApp,
      });
      assert.equal(code, 0);
    } finally {
      delete process.env.FAKE_APP_EXIT;
      delete process.env.FAKE_APP_EXIT_DELAY;
    }
  });

  it("--verbose implies --wait (marker appended to forwarded argv)", async () => {
    const c = capture();
    const fakeApp = writeFakeApp();
    const capFile = path.join(tmpRoot, "verbose-capture.txt");
    process.env.FAKE_APP_CAPTURE = capFile;
    const code = await dispatch(["--verbose", "somefile.txt"], {
      ...c, electronBinaryPath: fakeApp,
    });
    assert.equal(code, 0);
    const forwarded = lastCaptureLine(capFile);
    const i = forwarded.indexOf("--waitMarkerFilePath");
    assert.ok(i !== -1, "marker flag forwarded");
    assert.ok(forwarded[i + 1].includes("ide-code-wait-"));
    assert.ok(!fs.existsSync(forwarded[i + 1]), "marker cleaned up");
  });

  it("buffers stdin - to a temp file (spec §4.4)", async () => {
    const c = capture();
    const fakeApp = writeFakeApp();
    const capFile = path.join(tmpRoot, "stdin-capture.txt");
    process.env.FAKE_APP_CAPTURE = capFile;
    const code = await dispatch(["-"], {
      ...c,
      electronBinaryPath: fakeApp,
      stdinIsTTY: false,
      readStdin: async () => Buffer.from("hello-stdin"),
    });
    assert.equal(code, 0);
    assert.ok(c.out.join("\n").includes("Reading from stdin via: "));
    // Fire-and-forget returns on "spawn"; the fake's node needs a moment.
    await waitForFile(capFile);
    const forwarded = lastCaptureLine(capFile);
    assert.ok(!forwarded.includes("-"), "lone - stripped");
    assert.ok(forwarded.includes("--skip-add-to-recently-opened"));
    const tmpIdx = forwarded.findIndex((a) => a.includes("ide-code-stdin-"));
    assert.ok(tmpIdx !== -1);
    assert.equal(fs.readFileSync(forwarded[tmpIdx], "utf8"), "hello-stdin");
  });

  it("returns exit 1 with stderr on spawn failure (never silent)", async () => {
    const c = capture();
    const code = await dispatch(["somefile.txt"], {
      ...c,
      electronBinaryPath: path.join(tmpRoot, "no-such-electron-binary"),
      spawn: child_process.spawn,
    });
    assert.equal(code, 1);
    assert.ok(c.err.join("\n").includes("error: could not start the IDE Code app:"));
  });

  it("forwards argv and env through to the app binary", async () => {
    const c = capture();
    const fakeApp = writeFakeApp();
    const capFile = path.join(tmpRoot, "fwd-capture.txt");
    process.env.FAKE_APP_CAPTURE = capFile;
    const code = await dispatch(["--new-window", "mydir"], {
      ...c, electronBinaryPath: fakeApp,
    });
    assert.equal(code, 0);
    await waitForFile(capFile);
    assert.deepEqual(lastCaptureLine(capFile), ["--new-window", "mydir"]);
  });

  it("openApp surfaces a throwing spawn as exit 1", async () => {
    const c = capture();
    const boom = () => { throw new Error("spawn ENOMEM"); };
    const code = await openApp(
      ["x"],
      parseArgv(["x"]),
      {
        electronBinaryPath: "/bin/false",
        spawn: boom as unknown as typeof child_process.spawn,
        readStdin: async () => Buffer.from(""),
        stdinIsTTY: true,
        stdout: c.stdout,
        stderr: c.stderr,
      }
    );
    assert.equal(code, 1);
    assert.ok(c.err.join("\n").includes("spawn ENOMEM"));
  });

  it("openApp handles an 'error'-emitting child in fire-and-forget mode", async () => {
    const c = capture();
    const fakeSpawn = (() => {
      const ee = new EventEmitter();
      setImmediate(() => ee.emit("error", new Error("spawn ENOENT")));
      return ee;
    }) as unknown as typeof child_process.spawn;
    const code = await openApp(
      ["x"],
      parseArgv(["x"]),
      {
        electronBinaryPath: "/bin/false",
        spawn: fakeSpawn,
        readStdin: async () => Buffer.from(""),
        stdinIsTTY: true,
        stdout: c.stdout,
        stderr: c.stderr,
      }
    );
    assert.equal(code, 1);
    assert.ok(c.err.join("\n").includes("spawn ENOENT"));
  });
});

// ---------------------------------------------------------------------------
// delegateToUpstream unit
// ---------------------------------------------------------------------------

describe("delegateToUpstream", () => {
  it("returns 1 when the module has no main()", async () => {
    const c = capture();
    const mod = path.join(tmpRoot, "no-main.js");
    fs.writeFileSync(mod, `module.exports = {};\n`);
    const code = await delegateToUpstream(parseArgv(["--telemetry"]), {
      upstreamEntry: mod, stdout: c.stdout, stderr: c.stderr,
    });
    assert.equal(code, 1);
    assert.ok(c.err.join("\n").includes("no main()"));
  });
});
