/**
 * terminalUtils — pure, vscode-free helpers for TerminalService.
 *
 * Kept dependency-free so they can be unit-tested under plain node
 * (see test/run-terminal-tests.ts). The framing protocol:
 *   __IDE_RUN_BEGIN__\n<command output>\n__IDE_RUN_END__=<code>
 */
export const RUN_BEGIN = "__IDE_RUN_BEGIN__";
export const RUN_END_PREFIX = "__IDE_RUN_END__=";

/** Strip ANSI/VT escape sequences and control chars from PTY output. */
export function stripAnsiText(s: string): string {
  return s
    .replace(
      // eslint-disable-next-line no-control-regex
      /[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g,
      "",
    )
    .replace(
      // eslint-disable-next-line no-control-regex
      /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g,
      "",
    );
}

/**
 * Extract the framed command output from accumulated raw PTY data.
 *
 * The marker must sit alone on its own line: the PTY *echo* of the typed
 * wrapper also contains the marker text (e.g. `printf '__IDE_RUN_BEGIN__\n'`
 * or `echo __IDE_RUN_BEGIN__`), but there it is always preceded by other
 * characters on the same line, so anchoring to line-start excludes it.
 */
export function extractRunOutput(raw: string): string | null {
  const clean = stripAnsiText(raw);
  const m = /(?:^|\r\n|\n)__IDE_RUN_BEGIN__(?:\r\n|\n)/.exec(clean);
  if (!m) {
    return null;
  }
  let out = clean.slice(m.index + m[0].length);
  const endMatch = /__IDE_RUN_END__=-?\d+/.exec(out);
  if (endMatch) {
    out = out.slice(0, endMatch.index);
  }
  return out.replace(/^[\r\n]+/, "").replace(/[\r\n]+$/, "");
}

/** Parse the exit-code marker from accumulated raw PTY data. */
export function parseRunEnd(raw: string): number | null {
  const m = /__IDE_RUN_END__=(-?\d+)/.exec(stripAnsiText(raw));
  return m ? parseInt(m[1], 10) : null;
}

/** Escape a value interpolated into an XML attribute of a context block. */
export function escapeXmlAttr(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/** Shell families the background-run wrapper supports. */
export type TerminalShellKind = "posix" | "fish" | "powershell" | "cmd";

/**
 * Detect the shell family from a terminal's configured shell path.
 * Falls back to posix off-Windows, powershell on Windows (VS Code's
 * default terminal there).
 */
export function detectShellKind(shellPath?: string): TerminalShellKind {
  const base = (shellPath ?? "").split(/[\\/]/).pop()?.toLowerCase() ?? "";
  if (/^(pwsh|powershell)(\.exe)?$/.test(base)) {
    return "powershell";
  }
  if (/^cmd(\.exe)?$/.test(base)) {
    return "cmd";
  }
  if (/^fish(\.exe)?$/.test(base)) {
    return "fish";
  }
  if (base) {
    return "posix";
  }
  return process.platform === "win32" ? "powershell" : "posix";
}

/**
 * Wrap a user command so its output is framed with __IDE_RUN_BEGIN__ /
 * __IDE_RUN_END__=<code> markers. Runs in a subshell (where the shell
 * supports it) so `exit` inside the command can't kill our terminal, and
 * the echoed wrapper line is excluded from the chat output by
 * extractRunOutput. One variant per shell family — the POSIX form would
 * silently misbehave on PowerShell/cmd.exe/fish.
 */
export function buildRunWrapper(cmd: string, kind: TerminalShellKind): string {
  switch (kind) {
    case "powershell":
      return [
        `Write-Output '${RUN_BEGIN}'`,
        `$__ide_code = 0`,
        `try { & { ${cmd} }; if (-not $?) { $__ide_code = 1 } } catch { $__ide_code = 1 }`,
        `Write-Output ("${RUN_END_PREFIX}" + $__ide_code)`,
      ].join("\n");
    case "cmd":
      return [
        "@echo off",
        `echo ${RUN_BEGIN}`,
        `( ${cmd} )`,
        `echo ${RUN_END_PREFIX}%ERRORLEVEL%`,
      ].join("\r\n");
    case "fish":
      return `printf '${RUN_BEGIN}\\n'; begin\n${cmd}\nend; printf '${RUN_END_PREFIX}%s\\n' $status`;
    case "posix":
    default:
      return `printf '${RUN_BEGIN}\\n'; (\n${cmd}\n); printf '${RUN_END_PREFIX}%s\\n' "$?"`;
  }
}
