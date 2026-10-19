/**
 * terminalUtils tests (node:test, zero extra deps).
 *
 * Unit: ANSI stripping, run-output extraction, exit-code parsing,
 * XML-attr escaping, shell detection, per-shell run wrappers.
 *
 * Run after `tsc`:  node out/services/test/run-terminal-tests.mjs
 */
import { describe, it } from "node:test";
import * as assert from "node:assert";
import {
  buildRunWrapper,
  detectShellKind,
  escapeXmlAttr,
  extractRunOutput,
  parseRunEnd,
  stripAnsiText,
} from "../terminalUtils";

describe("stripAnsiText", () => {
  it("removes SGR color sequences", () => {
    assert.strictEqual(
      stripAnsiText("\u001b[31merror\u001b[0m: boom"),
      "error: boom",
    );
  });
  it("removes cursor movement and clear sequences", () => {
    assert.strictEqual(
      stripAnsiText("\u001b[2K\u001b[1Ghello"),
      "hello",
    );
  });
  it("removes control chars but keeps newlines and tabs", () => {
    assert.strictEqual(stripAnsiText("a\u0007b\nc\td"), "ab\nc\td");
  });
  it("leaves plain text untouched", () => {
    assert.strictEqual(stripAnsiText("npm test"), "npm test");
  });
});

describe("extractRunOutput", () => {
  it("returns null when the begin marker is missing", () => {
    assert.strictEqual(extractRunOutput("just some output"), null);
  });
  it("extracts output between the markers", () => {
    const raw =
      "$ wrapper-echo\n__IDE_RUN_BEGIN__\nline1\nline2\n__IDE_RUN_END__=0\n";
    assert.strictEqual(extractRunOutput(raw), "line1\nline2");
  });
  it("returns output so far when the end marker has not arrived yet", () => {
    const raw = "__IDE_RUN_BEGIN__\npartial";
    assert.strictEqual(extractRunOutput(raw), "partial");
  });
  it("handles non-zero exit codes", () => {
    const raw = "__IDE_RUN_BEGIN__\noops\n__IDE_RUN_END__=127\n";
    assert.strictEqual(extractRunOutput(raw), "oops");
    assert.strictEqual(parseRunEnd(raw), 127);
  });
  it("strips ANSI before framing", () => {
    const raw =
      "\u001b[32m__IDE_RUN_BEGIN__\u001b[0m\n\u001b[1mok\u001b[0m\n__IDE_RUN_END__=0";
    assert.strictEqual(extractRunOutput(raw), "ok");
  });
});

describe("parseRunEnd", () => {
  it("parses zero and non-zero codes", () => {
    assert.strictEqual(parseRunEnd("x\n__IDE_RUN_END__=0"), 0);
    assert.strictEqual(parseRunEnd("x\n__IDE_RUN_END__=1"), 1);
  });
  it("returns null when no marker", () => {
    assert.strictEqual(parseRunEnd("no marker here"), null);
  });
});

describe("escapeXmlAttr", () => {
  it("escapes quotes, angle brackets and ampersands", () => {
    assert.strictEqual(
      escapeXmlAttr('a"b<c>d&e'),
      "a&quot;b&lt;c&gt;d&amp;e",
    );
  });
});

describe("detectShellKind", () => {
  it("detects powershell variants", () => {
    assert.strictEqual(detectShellKind("C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe"), "powershell");
    assert.strictEqual(detectShellKind("/usr/local/bin/pwsh"), "powershell");
  });
  it("detects cmd.exe", () => {
    assert.strictEqual(detectShellKind("C:\\Windows\\System32\\cmd.exe"), "cmd");
  });
  it("detects fish", () => {
    assert.strictEqual(detectShellKind("/usr/bin/fish"), "fish");
  });
  it("treats other shells as posix", () => {
    assert.strictEqual(detectShellKind("/bin/bash"), "posix");
    assert.strictEqual(detectShellKind("/bin/zsh"), "posix");
  });
});

describe("buildRunWrapper", () => {
  it("posix wraps in a subshell and captures $?", () => {
    const w = buildRunWrapper("npm test", "posix");
    assert.ok(w.includes("__IDE_RUN_BEGIN__"));
    assert.ok(w.includes("(npm test)") || w.includes("(\nnpm test\n)"));
    assert.ok(w.includes('"$?"'));
    assert.ok(w.includes("__IDE_RUN_END__="));
  });
  it("powershell captures failure via try/catch", () => {
    const w = buildRunWrapper("npm test", "powershell");
    assert.ok(w.includes("__IDE_RUN_BEGIN__"));
    assert.ok(w.includes("try { & { npm test }"));
    assert.ok(w.includes("__IDE_RUN_END__="));
  });
  it("cmd uses ERRORLEVEL after the command line", () => {
    const w = buildRunWrapper("npm test", "cmd");
    const echoLine = w.split("\r\n").find((l) => l.includes("__IDE_RUN_END__"));
    const cmdLine = w.split("\r\n").find((l) => l.includes("npm test"));
    assert.ok(echoLine && cmdLine);
    assert.ok(
      w.indexOf("npm test") < w.indexOf("__IDE_RUN_END__"),
      "end marker must be emitted after the command",
    );
    assert.ok(echoLine.includes("%ERRORLEVEL%"));
  });
  it("fish uses begin/end and $status", () => {
    const w = buildRunWrapper("npm test", "fish");
    assert.ok(w.includes("begin"));
    assert.ok(w.includes("$status"));
    assert.ok(w.includes("__IDE_RUN_END__="));
  });
  it("ignores the PTY echo of the wrapper itself", () => {
    // Realistic bash transcript: the typed wrapper is echoed (containing the
    // marker text inside `printf '...'`), then the shell prints the real
    // marker alone on its own line.
    const raw = [
      "$ printf '__IDE_RUN_BEGIN__\\n'; (",
      "> echo hi",
      "> ); printf '__IDE_RUN_END__=%s\\n' \"$?\"",
      "__IDE_RUN_BEGIN__",
      "hi",
      "__IDE_RUN_END__=0",
      "$ ",
    ].join("\n");
    assert.strictEqual(extractRunOutput(raw), "hi");
    assert.strictEqual(parseRunEnd(raw), 0);
  });
  it("round-trips through extractRunOutput for every shell", () => {
    const kinds = ["posix", "fish", "powershell", "cmd"] as const;
    for (const k of kinds) {
      const w = buildRunWrapper("echo hi", k);
      // Simulate a PTY transcript: echo of the wrapper + command output + end marker.
      const transcript = `${w}\n__IDE_RUN_BEGIN__\nhi\n__IDE_RUN_END__=0\n`;
      assert.strictEqual(extractRunOutput(transcript), "hi", `kind=${k}`);
      assert.strictEqual(parseRunEnd(transcript), 0, `kind=${k}`);
    }
  });
});
