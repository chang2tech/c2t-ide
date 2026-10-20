"use strict";
/**
 * options.ts — the IDE Code CLI option registry (153 flags).
 *
 * Evidence: Cursor 3.25.9 `out/cli.js`, OBSERVED two ways —
 *   (a) executed live: `node out/cli.js --help` / `--version` /
 *       `--locate-shell-integration-path`,
 *   (b) static extraction of the minified option registry (`Ot`) from the
 *       bundle: 154 entries = 153 registered flags + the `_` catch-all,
 *       with per-flag {type, alias, cat, args, deprecates} — see the
 *       extraction notes in code comments below.
 * Spec: ~/workspace/ide-code-mission/docs/rea/dig-cli-2026-10-19.md §2.
 *
 * Where the spec doc and the binary disagree, the BINARY wins (per the
 * workspace hard rule: binary reverse > docs). Known deltas, all marked:
 *  - `--sandbox` IS a registered hidden bool in the binary (spec §2.4 lists
 *    it, but the 153-count discussion is ambiguous; binary entry confirmed).
 *  - `--no-sandbox` is a separate entry with `alias: "sandbox"`.
 *  - `--remote-debugging-port` is NOT registered (spec §2.4 table lists it,
 *    but the binary only *injects* `--remote-debugging-port=<port>` during
 *    `--prof-startup`; 0 registry hits). It is intentionally absent here.
 *  - Spec §2.4 lists `--smoke-test-nal-retry-delay-ms` twice (duplicate
 *    table row); the binary registers it once.
 *  - `--folder-uri` / `--file-uri` carry `cat: "o"` in the binary but are
 *    NOT printed by `--help` (OBSERVED) — visibility below follows the
 *    observed --help output, not the cat tag.
 *  - The binary has `deprecates: [...]` on 4 options (extensions-dir,
 *    disable-extensions, inspect-extensions, inspect-brk-extensions):
 *    these options *replace* older names; the options themselves are NOT
 *    deprecated, so nothing is rendered as deprecated in --help.
 *  - Public descriptions are VERBATIM from the binary's NLS strings
 *    (out/nls.messages.json indices 1864–1905), which are more complete
 *    than the paraphrases in the spec tables (e.g. --log, --disable-extension,
 *    --inspect-extensions/--inspect-brk-extensions gain their full text).
 *  - `--mcp-workspace` is PHANTOM: 0 hits in the binary registry (spec §2.1
 *    note). It is NOT registered. The --add-mcp description keeps Cursor's
 *    mention but appends "(not yet implemented)" instead of repeating the
 *    phantom as if it existed.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.SUBCOMMANDS = exports.UPSTREAM_MANAGEMENT_FLAGS = exports.OPTIONS = void 0;
exports.getOption = getOption;
exports.getOptionByAlias = getOptionByAlias;
exports.isSubcommand = isSubcommand;
/**
 * All 153 registered flags, in the binary's registry order.
 * (The binary's 154th registry entry is the `_` positional catch-all,
 * handled by the parser — not a flag, so not listed here.)
 */
exports.OPTIONS = [
    // ------------------------------------------------------------------
    // PUBLIC — Options (section "o"). Descriptions verbatim from NLS.
    // ------------------------------------------------------------------
    { name: "diff", alias: "d", type: "bool", args: "<file> <file>", section: "o", visibility: "public", description: "Compare two files with each other." },
    { name: "merge", alias: "m", type: "bool", args: "<path1> <path2> <base> <result>", section: "o", visibility: "public", description: "Perform a three-way merge by providing paths for two modified versions of a file, the common origin of both modified versions and the output file to save merge results." },
    { name: "add", alias: "a", type: "bool", args: "<folder>", section: "o", visibility: "public", description: "Add folder(s) to the last active window." },
    { name: "remove", type: "bool", args: "<folder>", section: "o", visibility: "public", description: "Remove folder(s) from the last active window." },
    { name: "goto", alias: "g", type: "bool", args: "<file:line[:character]>", section: "o", visibility: "public", description: "Open a file at the path on the specified line and character position." },
    { name: "new-window", alias: "n", type: "bool", section: "o", visibility: "public", description: "Force to open a new window." },
    { name: "reuse-window", alias: "r", type: "bool", section: "o", visibility: "public", description: "Force to open a file or folder in an already opened window." },
    { name: "suppress-popups-on-startup", type: "bool", section: "o", visibility: "public", description: "Suppress notification popups on startup." },
    { name: "web-worker-exthost", type: "bool", section: "o", visibility: "public", description: "Run all web-capable extensions in a web worker extension host." },
    { name: "glass", type: "bool", section: "o", visibility: "public", description: "Enable the multi-workbench architecture (dev-only)." },
    { name: "classic", type: "bool", section: "o", visibility: "public", description: "Disable glass mode and force classic windows (dev-only)." },
    { name: "wait", alias: "w", type: "bool", section: "o", visibility: "public", description: "Wait for the files to be closed before returning." },
    { name: "locale", type: "string", args: "<locale>", section: "o", visibility: "public", description: "The locale to use (e.g. en-US or zh-TW)." },
    { name: "user-data-dir", type: "string", args: "<dir>", section: "o", visibility: "public", description: "Specifies the directory that user data is kept in. Can be used to open multiple distinct instances of Code." },
    { name: "profile", type: "string", args: "<profileName>", section: "o", visibility: "public", description: "Opens the provided folder or workspace with the given profile and associates the profile with the workspace. If the profile does not exist, a new empty one is created." },
    { name: "help", alias: "h", type: "bool", section: "o", visibility: "public", description: "Print usage." },
    { name: "add-mcp", type: "string[]", args: "<json>", section: "o", visibility: "public", description: "Adds a Model Context Protocol server definition to the user profile, or workspace or folder when used with --mcp-workspace (not yet implemented). Accepts JSON input in the form '{\"name\":\"server-name\",\"command\":...}'" },
    // ------------------------------------------------------------------
    // PUBLIC — Extensions Management (section "e")
    // ------------------------------------------------------------------
    { name: "extensions-dir", type: "string", args: "<dir>", section: "e", visibility: "public", description: "Set the root path for extensions.", deprecates: ["extensionHomePath"] },
    { name: "list-extensions", type: "bool", section: "e", visibility: "public", description: "List the installed extensions." },
    { name: "show-versions", type: "bool", section: "e", visibility: "public", description: "Show versions of installed extensions, when using --list-extensions." },
    { name: "category", type: "string", args: "<category>", section: "e", visibility: "public", description: "Filters installed extensions by provided category, when using --list-extensions." },
    { name: "install-extension", type: "string[]", args: "<ext-id | path>", section: "e", visibility: "public", description: "Installs or updates an extension. The argument is either an extension id or a path to a VSIX. The identifier of an extension is '${publisher}.${name}'. Use '--force' argument to update to latest version. To install a specific version provide '@${version}'. For example: 'vscode.csharp@1.2.3'." },
    { name: "pre-release", type: "bool", section: "e", visibility: "public", description: "Installs the pre-release version of the extension, when using --install-extension" },
    { name: "uninstall-extension", type: "string[]", args: "<ext-id>", section: "e", visibility: "public", description: "Uninstalls an extension." },
    { name: "update-extensions", type: "bool", section: "e", visibility: "public", description: "Update the installed extensions." },
    { name: "enable-proposed-api", type: "string[]", args: "<ext-id>", section: "e", visibility: "public", description: "Enables proposed API features for extensions. Can receive one or more extension IDs to enable individually." },
    // ------------------------------------------------------------------
    // PUBLIC — Troubleshooting (section "t")
    // ------------------------------------------------------------------
    { name: "version", alias: "v", type: "bool", section: "t", visibility: "public", description: "Print version." },
    { name: "verbose", type: "bool", section: "t", visibility: "public", description: "Print verbose output (implies --wait)." },
    { name: "log", type: "string[]", args: "<level>", section: "t", visibility: "public", description: "Log level to use. Default is 'info'. Allowed values are 'critical', 'error', 'warn', 'info', 'debug', 'trace', 'off'. You can also configure the log level of an extension by passing extension id and log level in the following format: '${publisher}.${name}:${logLevel}'. For example: 'vscode.csharp:trace'. Can receive one or more such entries." },
    { name: "status", alias: "s", type: "bool", section: "t", visibility: "public", description: "Print process usage and diagnostics information." },
    { name: "prof-startup", type: "bool", section: "t", visibility: "public", description: "Run CPU profiler during startup." },
    { name: "disable-extensions", type: "bool", section: "t", visibility: "public", description: "Disable all installed extensions. This option is not persisted and is effective only when the command opens a new window.", deprecates: ["disableExtensions"] },
    { name: "disable-extension", type: "string[]", args: "<ext-id>", section: "t", visibility: "public", description: "Disable the provided extension. This option is not persisted and is effective only when the command opens a new window." },
    { name: "sync", type: "string", args: "<on | off>", section: "t", visibility: "public", description: "Turn sync on or off." },
    { name: "inspect-extensions", type: "string", args: "<port>", section: "t", visibility: "public", description: "Allow debugging and profiling of extensions. Check the developer tools for the connection URI.", deprecates: ["debugPluginHost"] },
    { name: "inspect-brk-extensions", type: "string", args: "<port>", section: "t", visibility: "public", description: "Allow debugging and profiling of extensions with the extension host being paused after start. Check the developer tools for the connection URI.", deprecates: ["debugBrkPluginHost"] },
    { name: "disable-lcd-text", type: "bool", section: "t", visibility: "public", description: "Disable LCD font rendering." },
    { name: "disable-gpu", type: "bool", section: "t", visibility: "public", description: "Disable GPU hardware acceleration." },
    { name: "disable-chromium-sandbox", type: "bool", section: "t", visibility: "public", description: "Use this option only when there is requirement to launch the application as sudo user on Linux or when running as an elevated user in an applocker environment on Windows." },
    { name: "locate-shell-integration-path", type: "string", args: "<shell>", section: "t", visibility: "public", description: "Print the path to a terminal shell integration script. Allowed values are 'bash', 'pwsh', 'zsh' or 'fish'." },
    { name: "telemetry", type: "bool", section: "t", visibility: "public", description: "Shows all telemetry events which VS code collects." },
    { name: "chat", type: "bool", section: "o", visibility: "public", description: "Open a standalone chat window without the full IDE." },
    // ------------------------------------------------------------------
    // HIDDEN (111). Order follows the binary registry. Descriptions are
    // short glosses from spec §2.4 notes (not shown in --help); purposes
    // marked UNKNOWN are name-only in the binary.
    // ------------------------------------------------------------------
    { name: "waitMarkerFilePath", type: "string", visibility: "hidden", optionClass: "INT", description: "Internal plumbing: marker file path for --wait, generated by the CLI as a temp file." },
    { name: "local-mode-data-import-token", type: "string", visibility: "hidden", optionClass: "INT", description: "Internal plumbing. Purpose UNKNOWN (name-only in the registry)." },
    { name: "extensions-download-dir", type: "string", visibility: "hidden", optionClass: "HU", description: "Directory used to download extensions (stock)." },
    { name: "builtin-extensions-dir", type: "string", visibility: "hidden", optionClass: "INT", description: "Directory of built-in extensions (stock)." },
    { name: "prof-append-timers", type: "string", visibility: "hidden", optionClass: "DEV", description: "CPU profiler: append timers output." },
    { name: "prof-duration-markers", type: "string[]", visibility: "hidden", optionClass: "DEV", description: "CPU profiler: duration markers." },
    { name: "prof-duration-markers-file", type: "string", visibility: "hidden", optionClass: "DEV", description: "CPU profiler: duration markers file." },
    { name: "prof-v8-extensions", type: "bool", visibility: "hidden", optionClass: "DEV", description: "CPU profiler: V8 extensions." },
    { name: "no-cached-data", type: "bool", visibility: "hidden", optionClass: "DEV", description: "Disable cached data; injected by the CLI alongside --prof-startup." },
    { name: "prof-startup-prefix", type: "string", visibility: "hidden", optionClass: "DEV", description: "CPU profiler output directory (the CLI injects $HOME/prof)." },
    { name: "sandbox", type: "bool", visibility: "hidden", optionClass: "INT", description: "Chromium sandbox flag (stock). OBSERVED: registered as its own entry, separate from --no-sandbox." },
    { name: "remote", type: "string", visibility: "hidden", optionClass: "HU", description: "Open a remote window (stock)." },
    { name: "folder-uri", type: "string[]", visibility: "hidden", optionClass: "HU", description: "Open a folder by URI (stock). Carries cat \"o\" in the binary but is NOT printed by --help (OBSERVED)." },
    { name: "file-uri", type: "string[]", visibility: "hidden", optionClass: "HU", description: "Open a file by URI (stock). Carries cat \"o\" in the binary but is NOT printed by --help (OBSERVED)." },
    { name: "locate-extension", type: "string[]", visibility: "hidden", optionClass: "DEV", description: "Locate an installed extension (stock); delegated to the upstream CLI main." },
    { name: "extensionDevelopmentPath", type: "string[]", visibility: "hidden", optionClass: "DEV", description: "Extension development harness: extension path (stock)." },
    { name: "extensionDevelopmentKind", type: "string[]", visibility: "hidden", optionClass: "DEV", description: "Extension development harness: extension kind (stock)." },
    { name: "extensionTestsPath", type: "string", visibility: "hidden", optionClass: "DEV", description: "Extension development harness: tests path (stock)." },
    { name: "extensionEnvironment", type: "string", visibility: "hidden", optionClass: "DEV", description: "Extension development harness: environment (stock)." },
    { name: "debugId", type: "string", visibility: "hidden", optionClass: "DEV", description: "Debug session id." },
    { name: "debugRenderer", type: "bool", visibility: "hidden", optionClass: "DEV", description: "Debug the renderer process." },
    { name: "inspect-ptyhost", type: "string", visibility: "hidden", optionClass: "DEV", description: "Debugger port for the pty host process." },
    { name: "inspect-brk-ptyhost", type: "string", visibility: "hidden", optionClass: "DEV", description: "Debugger port for the pty host process, breaking on start." },
    { name: "inspect-search", type: "string", visibility: "hidden", optionClass: "DEV", description: "Debugger port for the search process." },
    { name: "inspect-brk-search", type: "string", visibility: "hidden", optionClass: "DEV", description: "Debugger port for the search process, breaking on start." },
    { name: "inspect-sharedprocess", type: "string", visibility: "hidden", optionClass: "DEV", description: "Debugger port for the shared process." },
    { name: "inspect-brk-sharedprocess", type: "string", visibility: "hidden", optionClass: "DEV", description: "Debugger port for the shared process, breaking on start." },
    { name: "export-default-configuration", type: "string", visibility: "hidden", optionClass: "INT", description: "Export the default configuration." },
    { name: "install-source", type: "string", visibility: "hidden", optionClass: "INT", description: "Install-flow source tag; delegated to the upstream CLI main." },
    { name: "enable-smoke-test-driver", type: "bool", visibility: "hidden", optionClass: "TEST", description: "Smoke-test driver." },
    { name: "telemetry-source", type: "string", visibility: "hidden", optionClass: "TEST", description: "Telemetry source override for tests." },
    { name: "smoke-test-use-real-agent-http", type: "bool", visibility: "hidden", optionClass: "TEST", description: "Smoke test: use the real agent HTTP endpoint." },
    { name: "smoke-test-nal-stream-timeout-ms", type: "string", visibility: "hidden", optionClass: "TEST", description: "Smoke test: NAL stream timeout in ms." },
    { name: "smoke-test-nal-endless-retries", type: "bool", visibility: "hidden", optionClass: "TEST", description: "Smoke test: NAL endless retries." },
    { name: "smoke-test-nal-retry-delay-ms", type: "string", visibility: "hidden", optionClass: "TEST", description: "Smoke test: NAL retry delay in ms." },
    { name: "debug-slow-window-unload-ms", type: "string", visibility: "hidden", optionClass: "DEV", description: "Simulate a slow window unload (ms)." },
    { name: "headless", type: "bool", visibility: "hidden", optionClass: "HU", description: "Headless open flows (stock)." },
    { name: "test-backend-url", type: "string", visibility: "hidden", optionClass: "TEST", description: "Test override: backend URL." },
    { name: "test-feature-flags", type: "string", visibility: "hidden", optionClass: "TEST", description: "Test override: feature flags." },
    { name: "test-experiments", type: "string", visibility: "hidden", optionClass: "TEST", description: "Test override: experiments." },
    { name: "test-dynamic-configs", type: "string", visibility: "hidden", optionClass: "TEST", description: "Test override: dynamic configs." },
    { name: "test-layers", type: "string", visibility: "hidden", optionClass: "TEST", description: "Test override: layers." },
    { name: "test-composer-chat-script", type: "string", visibility: "hidden", optionClass: "TEST", description: "Test override: composer chat script." },
    { name: "logExtensionHostCommunication", type: "bool", visibility: "hidden", optionClass: "DEV", description: "Log extension host communication." },
    { name: "skip-release-notes", type: "bool", visibility: "hidden", optionClass: "HU", description: "Skip release notes on startup." },
    { name: "skip-welcome", type: "bool", visibility: "hidden", optionClass: "HU", description: "Skip the welcome page on startup." },
    { name: "skip-onboarding", type: "bool", visibility: "hidden", optionClass: "HU", description: "Skip onboarding on startup." },
    { name: "override-cursor-auth-token", type: "string", visibility: "hidden", optionClass: "INT", description: "Dev/test auth token override (Cursor-specific; kept for registry parity)." },
    { name: "disable-telemetry", type: "bool", visibility: "hidden", optionClass: "HU", description: "Disable telemetry (Cursor-specific)." },
    { name: "disable-updates", type: "bool", visibility: "hidden", optionClass: "HU", description: "Disable automatic update checks (Cursor-specific)." },
    { name: "agent-harness-trust-dev-key", type: "bool", visibility: "hidden", optionClass: "INT", description: "Trust the agent harness dev key." },
    { name: "use-inmemory-secretstorage", type: "bool", visibility: "hidden", optionClass: "HU", description: "Use in-memory secret storage." },
    { name: "password-store", type: "string", visibility: "hidden", optionClass: "HU", description: "Password store backend (stock)." },
    { name: "disable-workspace-trust", type: "bool", visibility: "hidden", optionClass: "HU", description: "Disable workspace trust (stock)." },
    { name: "disable-crash-reporter", type: "bool", visibility: "hidden", optionClass: "DEV", description: "Disable the crash reporter." },
    { name: "crash-reporter-directory", type: "string", visibility: "hidden", optionClass: "DEV", description: "Crash reporter directory." },
    { name: "crash-reporter-id", type: "string", visibility: "hidden", optionClass: "DEV", description: "Crash reporter id." },
    { name: "skip-add-to-recently-opened", type: "bool", visibility: "hidden", optionClass: "INT", description: "Do not add opened entries to recently-opened; injected when opening stdin temp files." },
    { name: "open-url", type: "bool", visibility: "hidden", optionClass: "INT", description: "URL-open plumbing." },
    { name: "file-write", type: "bool", visibility: "hidden", optionClass: "INT", description: "Internal file-write IPC: JSON file (first positional) with {source,target}; copies source to target, honors --file-chmod." },
    { name: "file-chmod", type: "bool", visibility: "hidden", optionClass: "INT", description: "Companion to --file-write: temporarily grant owner-write to a read-only target while copying, then restore." },
    { name: "install-builtin-extension", type: "string[]", visibility: "hidden", optionClass: "INT", description: "Install a built-in extension." },
    { name: "force", type: "bool", visibility: "hidden", optionClass: "INT", description: "Install-flow force flag (unrelated to the agent CLI --force)." },
    { name: "do-not-sync", type: "bool", visibility: "hidden", optionClass: "INT", description: "Install flow: do not sync." },
    { name: "do-not-include-pack-dependencies", type: "bool", visibility: "hidden", optionClass: "INT", description: "Install flow: exclude pack dependencies." },
    { name: "trace", type: "bool", visibility: "hidden", optionClass: "DEV", description: "Enable tracing." },
    { name: "trace-memory-infra", type: "bool", visibility: "hidden", optionClass: "DEV", description: "Trace memory infra." },
    { name: "trace-category-filter", type: "string", visibility: "hidden", optionClass: "DEV", description: "Trace category filter." },
    { name: "trace-options", type: "string", visibility: "hidden", optionClass: "DEV", description: "Trace options." },
    { name: "preserve-env", type: "bool", visibility: "hidden", optionClass: "HU", description: "Preserve the environment for launched processes." },
    { name: "force-user-env", type: "bool", visibility: "hidden", optionClass: "HU", description: "Force the user environment for launched processes." },
    { name: "force-disable-user-env", type: "bool", visibility: "hidden", optionClass: "HU", description: "Force-disable the user environment for launched processes." },
    { name: "open-devtools", type: "bool", visibility: "hidden", optionClass: "HU", description: "Open developer tools (Cursor-specific)." },
    { name: "enable-react-devtools", type: "bool", visibility: "hidden", optionClass: "DEV", description: "Enable React devtools (Cursor-specific)." },
    { name: "disable-react-devtools", type: "bool", visibility: "hidden", optionClass: "DEV", description: "Disable React devtools (Cursor-specific)." },
    { name: "react-production-bundles", type: "bool", visibility: "hidden", optionClass: "DEV", description: "Use React production bundles (Cursor-specific)." },
    { name: "react-performance-tracks", type: "bool", visibility: "hidden", optionClass: "DEV", description: "Enable React performance tracks (Cursor-specific)." },
    { name: "shadow-window-for-workspace-id", type: "string", visibility: "hidden", optionClass: "INT", description: "Internal plumbing. Purpose UNKNOWN (name-only in the registry)." },
    { name: "is-vm-daemon-parallel-process", type: "bool", visibility: "hidden", optionClass: "INT", description: "Internal plumbing. Purpose UNKNOWN (name-only in the registry)." },
    { name: "disable-gpu-sandbox", type: "bool", visibility: "hidden", optionClass: "INT", description: "Disable the GPU sandbox." },
    { name: "logsPath", type: "string", visibility: "hidden", optionClass: "INT", description: "Override the logs directory." },
    { name: "__enable-file-policy", type: "bool", visibility: "hidden", optionClass: "INT", description: "Internal plumbing. Purpose UNKNOWN (name-only in the registry)." },
    { name: "continueOn", type: "string", visibility: "hidden", optionClass: "INT", description: "Internal plumbing. Purpose UNKNOWN (name-only in the registry)." },
    { name: "enable-coi", type: "bool", visibility: "hidden", optionClass: "DEV", description: "Enable cross-origin isolation." },
    { name: "unresponsive-sample-interval", type: "string", visibility: "hidden", optionClass: "DEV", description: "Unresponsive-renderer sampling interval." },
    { name: "unresponsive-sample-period", type: "string", visibility: "hidden", optionClass: "DEV", description: "Unresponsive-renderer sampling period." },
    { name: "no-proxy-server", type: "bool", visibility: "hidden", optionClass: "HU", description: "Disable the proxy server." },
    { name: "no-sandbox", alias: "sandbox", type: "bool", visibility: "hidden", optionClass: "INT", description: "Chromium passthrough: disable the sandbox." },
    { name: "proxy-server", type: "string", visibility: "hidden", optionClass: "HU", description: "Proxy server." },
    { name: "proxy-bypass-list", type: "string", visibility: "hidden", optionClass: "HU", description: "Proxy bypass list." },
    { name: "proxy-pac-url", type: "string", visibility: "hidden", optionClass: "HU", description: "Proxy PAC URL." },
    { name: "js-flags", type: "string", visibility: "hidden", optionClass: "DEV", description: "V8 flags passthrough." },
    { name: "inspect", type: "string", visibility: "hidden", optionClass: "DEV", description: "Node/Electron inspector port." },
    { name: "inspect-brk", type: "string", visibility: "hidden", optionClass: "DEV", description: "Node/Electron inspector port, breaking on start; the CLI injects it during --prof-startup." },
    { name: "nolazy", type: "bool", visibility: "hidden", optionClass: "DEV", description: "Disable lazy compilation." },
    { name: "force-device-scale-factor", type: "string", visibility: "hidden", optionClass: "DEV", description: "Force the device scale factor." },
    { name: "force-renderer-accessibility", type: "bool", visibility: "hidden", optionClass: "DEV", description: "Force renderer accessibility." },
    { name: "ignore-certificate-errors", type: "bool", visibility: "hidden", optionClass: "DEV", description: "Ignore certificate errors." },
    { name: "allow-insecure-localhost", type: "bool", visibility: "hidden", optionClass: "DEV", description: "Allow insecure localhost." },
    { name: "log-net-log", type: "string", visibility: "hidden", optionClass: "DEV", description: "Write a NetLog." },
    { name: "vmodule", type: "string", visibility: "hidden", optionClass: "DEV", description: "V8 vmodule filter." },
    { name: "_urls", type: "string[]", visibility: "hidden", optionClass: "INT", description: "Internal URL list." },
    { name: "disable-dev-shm-usage", type: "bool", visibility: "hidden", optionClass: "HU", description: "Disable /dev/shm usage (Docker/low-shm environments)." },
    { name: "profile-temp", type: "bool", visibility: "hidden", optionClass: "DEV", description: "Use a temporary profile." },
    { name: "ozone-platform", type: "string", visibility: "hidden", optionClass: "DEV", description: "Ozone platform." },
    { name: "enable-tracing", type: "string", visibility: "hidden", optionClass: "DEV", description: "Enable startup tracing." },
    { name: "trace-startup-format", type: "string", visibility: "hidden", optionClass: "DEV", description: "Startup trace format." },
    { name: "trace-startup-file", type: "string", visibility: "hidden", optionClass: "DEV", description: "Startup trace file." },
    { name: "trace-startup-duration", type: "string", visibility: "hidden", optionClass: "DEV", description: "Startup trace duration." },
    { name: "xdg-portal-required-version", type: "string", visibility: "hidden", optionClass: "DEV", description: "Required xdg-portal version." },
    { name: "hmr", type: "bool", visibility: "hidden", optionClass: "DEV", description: "Hot module reload." },
    // NOTE (binary evidence): `--remote-debugging-port` is NOT a registered
    // flag — the binary only injects `--remote-debugging-port=<port>` into the
    // forwarded argv during --prof-startup. Deliberately absent here.
];
/** Lookup by flag name (without dashes). */
const byName = new Map();
/** Lookup by alias (single-char and long aliases). */
const byAlias = new Map();
for (const opt of exports.OPTIONS) {
    byName.set(opt.name, opt);
    if (opt.alias) {
        byAlias.set(opt.alias, opt);
    }
}
function getOption(name) {
    return byName.get(name);
}
function getOptionByAlias(alias) {
    return byAlias.get(alias);
}
/** Flags delegated to the upstream VS Code CLI main (spec §1 step 5). */
exports.UPSTREAM_MANAGEMENT_FLAGS = [
    "install-source",
    "list-extensions",
    "install-extension",
    "uninstall-extension",
    "update-extensions",
    "locate-extension",
    "add-mcp",
    "telemetry",
];
/** Subcommands routed before flag dispatch (spec §1). */
exports.SUBCOMMANDS = ["desktop", "tunnel", "agent"];
function isSubcommand(name) {
    return exports.SUBCOMMANDS.includes(name);
}
