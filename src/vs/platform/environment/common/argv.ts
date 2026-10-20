/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

export interface INativeCliOptions {
	'cli-data-dir'?: string;
	'disable-telemetry'?: boolean;
	'telemetry-level'?: string;
}

/**
 * A list of command line arguments we support natively.
 */
export interface NativeParsedArgs {

	// subcommands
	tunnel?: INativeCliOptions & {
		user: {
			login: {
				'access-token'?: string;
				'provider'?: string;
			};
		};
	};
	'serve-web'?: INativeCliOptions;
	'agent'?: INativeCliOptions;
	// IDE-CODE: `chat` has TWO shapes. The positional form (`chat <prompt>`)
	// is the stock subcommand (object with `_`, `mode`, ...). The dash-flag
	// form (`--chat`, Cursor's public bool flag "Open a standalone chat
	// window without the full IDE.", NLS 1905) is preserved as `true` by
	// parseArgs (see node/argv.ts) and means "open the standalone chat
	// window" — see openStandaloneChatWindow in electron-main/app.ts.
	chat?: {
		_: string[];
		'add-file'?: string[];
		mode?: string;
		maximize?: boolean;
		'reuse-window'?: boolean;
		'new-window'?: boolean;
		profile?: string;
		help?: boolean;
	} | boolean;

	// arguments
	_: string[];
	'folder-uri'?: string[]; // undefined or array of 1 or more
	'file-uri'?: string[]; // undefined or array of 1 or more
	_urls?: string[];
	help?: boolean;
	version?: boolean;
	telemetry?: boolean;
	status?: boolean;
	wait?: boolean;
	waitMarkerFilePath?: string;
	diff?: boolean;
	merge?: boolean;
	add?: boolean;
	remove?: boolean;
	goto?: boolean;
	'new-window'?: boolean;
	'reuse-window'?: boolean;
	'agents'?: boolean;
	// IDE-CODE: marks the window as a dedicated Agents ("glass") window, the
	// analog of Cursor's `--glass` CLI flag (binary: out/main.js,
	// `openGlassWindowAsNewUser` spawns with `--glass`; window config carries
	// `glass: true` and is matched via `config?.glass === true`).
	'glass'?: boolean;
	// IDE-CODE: Cursor's `--classic` CLI flag ("Disable glass mode and force
	// classic windows (dev-only).", NLS 1874, binary-verified in out/cli.js
	// 3.25.6 + 3.25.9). Takes precedence over the agents/glass routing in
	// openFirstWindow: forces a classic (normal) window even when glass mode
	// would otherwise open (e.g. `ide.window.openAgentsWindowOnStartup`).
	'classic'?: boolean;
	'session-title-base64'?: string;
	locale?: string;
	'user-data-dir'?: string;
	'prof-startup'?: boolean;
	'prof-startup-prefix'?: string;
	'prof-append-timers'?: string;
	'prof-duration-markers'?: string[];
	'prof-duration-markers-file'?: string;
	'prof-v8-extensions'?: boolean;
	'no-cached-data'?: boolean;
	verbose?: boolean;
	trace?: boolean;
	'trace-memory-infra'?: boolean;
	'trace-category-filter'?: string;
	'trace-options'?: string;
	'open-devtools'?: boolean;
	log?: string[];
	logExtensionHostCommunication?: boolean;
	'extensions-dir'?: string;
	'extensions-download-dir'?: string;
	'builtin-extensions-dir'?: string;
	'shared-data-dir'?: string;
	'agent-plugins-dir'?: string;
	'agents-user-data-dir'?: string;
	'agents-extensions-dir'?: string;
	extensionDevelopmentPath?: string[]; // undefined or array of 1 or more local paths or URIs
	extensionTestsPath?: string; // either a local path or a URI
	extensionDevelopmentKind?: string[];
	extensionEnvironment?: string; // JSON-stringified Record<string, string> object
	'inspect-extensions'?: string;
	'inspect-brk-extensions'?: string;
	debugId?: string;
	debugRenderer?: boolean; // whether we expect a debugger (js-debug) to attach to the renderer, incl webviews+webworker
	'inspect-ptyhost'?: string;
	'inspect-brk-ptyhost'?: string;
	'inspect-agenthost'?: string;
	'inspect-brk-agenthost'?: string;
	'inspect-sharedprocess'?: string;
	'inspect-brk-sharedprocess'?: string;
	'disable-extensions'?: boolean;
	'disable-extension'?: string[]; // undefined or array of 1 or more
	'list-extensions'?: boolean;
	'show-versions'?: boolean;
	'category'?: string;
	'install-extension'?: string[]; // undefined or array of 1 or more
	'pre-release'?: boolean;
	'install-builtin-extension'?: string[]; // undefined or array of 1 or more
	'uninstall-extension'?: string[]; // undefined or array of 1 or more
	'update-extensions'?: boolean;
	'do-not-include-pack-dependencies'?: boolean;
	'locate-extension'?: string[]; // undefined or array of 1 or more
	'enable-proposed-api'?: string[]; // undefined or array of 1 or more
	'open-url'?: boolean;
	'skip-release-notes'?: boolean;
	'skip-welcome'?: boolean;
	// IDE-CODE (GAPS-148, onboarding-flow): Cursor 3.25.9's environment service
	// exposes `skipOnboarding` from the `skip-onboarding` launch arg / payload
	// (workbench.desktop.main.js @18758384 / @32547757); the onboarding
	// service's maybeOnboard() consults it before auto-showing the flow.
	'skip-onboarding'?: boolean;
	'disable-telemetry'?: boolean;
	'telemetry-level'?: string;
	'export-default-configuration'?: string;
	'export-policy-data'?: string;
	'export-default-keybindings'?: string;
	'install-source'?: string;
	'add-mcp'?: string[];
	'disable-updates'?: boolean;
	'share-secrets-with-agents-app'?: boolean;
	'transient'?: boolean;
	'use-inmemory-secretstorage'?: boolean;
	'password-store'?: string;
	'disable-workspace-trust'?: boolean;
	'disable-crash-reporter'?: boolean;
	'crash-reporter-directory'?: string;
	'crash-reporter-id'?: string;
	'skip-add-to-recently-opened'?: boolean;
	'file-write'?: boolean;
	'file-chmod'?: boolean;
	'enable-smoke-test-driver'?: boolean;
	'skip-sessions-welcome'?: boolean;
	'remote'?: string;
	'force'?: boolean;
	'do-not-sync'?: boolean;
	'preserve-env'?: boolean;
	'force-user-env'?: boolean;
	'force-disable-user-env'?: boolean;
	'sync'?: 'on' | 'off';
	'logsPath'?: string;
	'__enable-file-policy'?: boolean;
	editSessionId?: string;
	continueOn?: string;
	'locate-shell-integration-path'?: string;
	'profile'?: string;
	'profile-temp'?: boolean;
	'disable-chromium-sandbox'?: boolean;
	sandbox?: boolean;
	'enable-coi'?: boolean;
	'unresponsive-sample-interval'?: string;
	'unresponsive-sample-period'?: string;
	'enable-rdp-display-tracking'?: boolean;
	'disable-layout-restore'?: boolean;
	'disable-experiments'?: boolean;

	// chromium command line args: https://electronjs.org/docs/all#supported-chrome-command-line-switches
	'no-proxy-server'?: boolean;
	'no-sandbox'?: boolean;
	'proxy-server'?: string;
	'proxy-bypass-list'?: string;
	'proxy-pac-url'?: string;
	'inspect'?: string;
	'inspect-brk'?: string;
	'js-flags'?: string;
	'disable-lcd-text'?: boolean;
	'disable-gpu'?: boolean;
	'disable-gpu-sandbox'?: boolean;
	'nolazy'?: boolean;
	'force-device-scale-factor'?: string;
	'force-renderer-accessibility'?: boolean;
	'ignore-certificate-errors'?: boolean;
	'allow-insecure-localhost'?: boolean;
	'log-net-log'?: string;
	'vmodule'?: string;
	'disable-dev-shm-usage'?: boolean;
	'ozone-platform'?: string;
	'enable-tracing'?: string;
	'trace-startup-format'?: string;
	'trace-startup-file'?: string;
	'trace-startup-duration'?: string;
	'xdg-portal-required-version'?: string;
}

/**
 * Narrows `NativeParsedArgs['chat']` to the positional-subcommand object
 * form (`chat <prompt>`). The dash-flag form (`--chat`, Cursor's public
 * "standalone chat window" flag) parses to boolean `true` and must NOT be
 * treated as a chat request carrying a prompt.
 */
export function isChatSubcommand(chat: NativeParsedArgs['chat']): chat is Exclude<NativeParsedArgs['chat'], boolean | undefined> {
	return typeof chat === 'object';
}
