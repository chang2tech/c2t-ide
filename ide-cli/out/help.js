"use strict";
/**
 * help.ts — `--help` / `--version` / `--locate-shell-integration-path`.
 *
 * Evidence: Cursor 3.25.9 executed live (`node out/cli.js --help`,
 * `--version`, `--locate-shell-integration-path bash|bogus`). Layout,
 * columns, wrapping and error strings below reproduce the OBSERVED output
 * with `ide-code` as the binary/product name.
 * Spec: dig-cli §2 (flag descriptions), §1 step 4 (dispatch position).
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
exports.resolveAppVersion = resolveAppVersion;
exports.printHelp = printHelp;
exports.printVersion = printVersion;
exports.locateShellIntegrationPath = locateShellIntegrationPath;
const fs = __importStar(require("node:fs"));
const path = __importStar(require("node:path"));
const process = __importStar(require("node:process"));
const options_1 = require("./options");
const PRODUCT_NAME = "IDE Code";
const BINARY_NAME = "ide-code";
const FALLBACK_VERSION = "0.1.0-alpha";
function defaultOut(deps) {
    return {
        stdout: deps.stdout ?? ((s) => process.stdout.write(s + "\n")),
        stderr: deps.stderr ?? ((s) => process.stderr.write(s + "\n")),
    };
}
/** Version of the app, read from the app's package.json at runtime. */
function resolveAppVersion(appDir) {
    try {
        const dir = appDir ?? path.resolve(__dirname, "..");
        const pkg = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8"));
        if (typeof pkg.version === "string" && pkg.version.length > 0) {
            return pkg.version;
        }
    }
    catch {
        // Fall through to the fallback — never crash on version lookup.
    }
    return FALLBACK_VERSION;
}
function flagText(opt) {
    const alias = opt.alias ? `-${opt.alias} ` : "";
    const args = opt.args ? ` ${opt.args}` : "";
    return `${alias}--${opt.name}${args}`;
}
/**
 * Word-wrap ported EXACTLY from Cursor's `nl(e,t)` (cli.js):
 * break at the last space at-or-before index `width` (inclusive — so a
 * line can reach exactly `width` chars); a word longer than `width`
 * produces the observed hard-break quirk (see --add-mcp's JSON line).
 */
function nl(text, width) {
    const out = [];
    let e = text;
    while (e.length > 0) {
        let s = e.length < width ? e.length : e.lastIndexOf(" ", width);
        if (s === 0) {
            s = width;
        }
        out.push(e.slice(0, s).trim());
        e = e.slice(s).trimStart();
    }
    return out;
}
function xn(n) {
    return " ".repeat(n);
}
/**
 * Option-table formatter ported EXACTLY from Cursor's `Rn(e,t)` (cli.js):
 * description column = max(12, longest flag text) + 3; description wrap
 * width = totalWidth - descCol - 1; narrow terminals fall back to
 * flag-on-one-line / description-on-next.
 */
function formatTable(rows, totalWidth) {
    const descCol = rows.reduce((a, r) => Math.max(a, r[0].length), 12) + 2 + 1;
    if (totalWidth - descCol < 25) {
        return rows.flatMap(([flag, desc]) => [`  ${flag}`, `      ${desc}`]);
    }
    const w = totalWidth - descCol - 1;
    const out = [];
    for (const [flag, desc] of rows) {
        const lines = nl(desc, w);
        out.push("  " + flag + xn(descCol - flag.length - 2) + lines[0]);
        for (let h = 1; h < lines.length; h++) {
            out.push(xn(descCol) + lines[h]);
        }
    }
    return out;
}
function defaultColumns(deps) {
    if (deps.columns !== undefined) {
        return deps.columns;
    }
    return (process.stdout.isTTY && process.stdout.columns) || 80; // OBSERVED
}
/**
 * Print --help. Returns 0. Layout ported from Cursor's `ol(...)` (cli.js):
 *   <Product> <version>
 *   Usage: ide-code [options][paths...]
 *   To read from stdin, append '-' (...)
 *   Options / Extensions Management / Troubleshooting / Subcommands
 * Sections group public options by `section` in registry order (OBSERVED).
 */
function printHelp(deps = {}) {
    const { stdout } = defaultOut(deps);
    const width = defaultColumns(deps);
    const version = (deps.getVersion ?? (() => resolveAppVersion(deps.appDir)))();
    const lines = [
        `${PRODUCT_NAME} ${version}`,
        "",
        `Usage: ${BINARY_NAME} [options][paths...]`,
        "",
        `To read from stdin, append '-' (e.g. 'ps aux | grep code | ${BINARY_NAME} -')`,
        "",
    ];
    const sectionName = (s) => s === "o" ? "Options" : s === "e" ? "Extensions Management" : "Troubleshooting";
    for (const s of ["o", "e", "t"]) {
        const opts = options_1.OPTIONS.filter((o) => o.visibility === "public" && o.section === s);
        lines.push(sectionName(s));
        lines.push(...formatTable(opts.map((o) => [flagText(o), o.description]), width));
        lines.push("");
    }
    // Subcommands section: OBSERVED in Cursor's --help ("tunnel" + "agent").
    // For ide-code, `tunnel` is not available in this build (honest omission);
    // `agent` is real. `desktop` is intentionally not listed, matching Cursor
    // (its bridge client has its own --help).
    lines.push("Subcommands");
    lines.push(...formatTable([["agent", "Start the IDE Code agent in your terminal."]], width));
    lines.push("");
    stdout(lines.join("\n"));
    return 0;
}
/**
 * Print --version. OBSERVED format: `<version>\n<commit>\n<arch>`, one per
 * line. Only fields we can actually resolve are printed — the commit is
 * omitted when unknown (never fabricated).
 */
function printVersion(deps = {}) {
    const { stdout } = defaultOut(deps);
    const version = (deps.getVersion ?? (() => resolveAppVersion(deps.appDir)))();
    const commit = deps.getCommit?.();
    const lines = [version];
    if (commit) {
        lines.push(commit);
    }
    lines.push(process.arch);
    stdout(lines.join("\n"));
    return 0;
}
const SHELLS = ["bash", "pwsh", "zsh", "fish"];
/**
 * --locate-shell-integration-path <shell>. OBSERVED:
 *  - invalid shell -> stderr "Error using --locate-shell-integration-path:
 *    Invalid shell type", exit 1.
 *  - valid shell -> stdout with the resolved script path. The real layout is
 *    <appDir>/out/vs/workbench/contrib/terminal/common/scripts/
 *    shellIntegration-<shell>.sh ; the file must exist or we error honestly.
 */
function locateShellIntegrationPath(shell, deps = {}) {
    const { stdout, stderr } = defaultOut(deps);
    if (!SHELLS.includes(shell)) {
        stderr("Error using --locate-shell-integration-path: Invalid shell type");
        return 1;
    }
    const appDir = deps.appDir ?? path.resolve(__dirname, "..");
    const scriptPath = path.join(appDir, "out", "vs", "workbench", "contrib", "terminal", "common", "scripts", `shellIntegration-${shell}.sh`);
    if (!fs.existsSync(scriptPath)) {
        stderr(`Error using --locate-shell-integration-path: shell integration script not found for '${shell}'`);
        return 1;
    }
    stdout(scriptPath);
    return 0;
}
