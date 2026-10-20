/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Extension-host side of the `cursor` API namespace — IDE Code's counterpart
 * of Cursor's `vscode.cursor.*` extension-host API surface.
 *
 * Reference: Cursor 3.25.6
 * - consumer: `resources/app/extensions/cursor-agent-host/dist/main.js`
 *   (51 distinct `cursor.*` members used)
 * - provider: `resources/app/out/vs/workbench/api/node/extensionHostProcess.js`
 *   (`ExtHostCursor` + the assembled `cursor` namespace object)
 *
 * Like Cursor, this lives in the extension host (same layer). The checkout
 * provider (`cursor.registerCheckoutProvider`) is NOT backed here: it goes
 * through the real extHost↔mainThread RPC bridge
 * (`ExtHostCheckoutProvider`/`MainThreadCheckoutProvider`), like Cursor.
 * Every other member is backed locally (in-memory registries, workspace
 * configuration, local MCP definitions). Server-driven members are honest
 * local stubs — see HONEST-DIVERGENCE notes.
 */

import { Emitter, Event } from '../../../base/common/event.js';
import { Disposable, toDisposable } from '../../../base/common/lifecycle.js';
import type * as vscode from 'vscode';
import { ExtHostConfigProvider, IExtHostConfiguration } from './extHostConfiguration.js';
import { IExtHostMpcService } from './extHostMcp.js';

/**
 * Privacy mode. Numeric values are verbatim from Cursor 3.25.6
 * (`aiserver.v1.PrivacyMode` protobuf enum in `workbench.desktop.main.js`).
 */
export enum ExtHostCursorPrivacyMode {
	Unspecified = 0,
	NoStorage = 1,
	NoTraining = 2,
	UsageDataTrainingAllowed = 3,
	UsageCodebaseTrainingAllowed = 4,
}

const _privacyModeByName: Record<string, ExtHostCursorPrivacyMode> = {
	'UNSPECIFIED': ExtHostCursorPrivacyMode.Unspecified,
	'NO_STORAGE': ExtHostCursorPrivacyMode.NoStorage,
	'NO_TRAINING': ExtHostCursorPrivacyMode.NoTraining,
	'USAGE_DATA_TRAINING_ALLOWED': ExtHostCursorPrivacyMode.UsageDataTrainingAllowed,
	'USAGE_CODEBASE_TRAINING_ALLOWED': ExtHostCursorPrivacyMode.UsageCodebaseTrainingAllowed,
};

export interface IAgentHostProvider {
	readonly client?: unknown;
	readonly clientInstanceId?: string;
	readonly loop?: unknown;
	readonly hostedMcpRoutingEnabled?: () => boolean;
	readonly workspacePaths?: () => string[];
	readonly [key: string]: unknown;
}

/**
 * Options accepted by {@link ExtHostCursor.checkFeatureGate}. The options
 * object shape is OBSERVED in the 3.25.6+ reference bundles:
 * `checkFeatureGate("cursor_blame", {disableExposureLog:!1})` and the glass
 * bundle's `experimentService.checkFeatureGate(..., {disableExposureLog: true})`.
 */
export interface ICursorFeatureGateOptions {
	/**
	 * When true, Cursor skips exposure logging for this gate check.
	 * Accepted for call-shape parity; it has no effect in this fork because
	 * there is no experiment service to suppress logging on.
	 */
	readonly disableExposureLog?: boolean;
}

/**
 * One row of Cursor's per-feature egress disclosure table — the canonical
 * "what leaves your machine" list for privacy mode (keys, why-texts and RPCs
 * OBSERVED verbatim in the 3.25.6 reference bundle; see
 * `harvest-cursor-commits-2026-10-19.md` §7 "Privacy-mode gating").
 */
export interface ICursorFeatureEgressDisclosure {
	/**
	 * Feature key, verbatim from the reference bundle
	 * (e.g. `'chat-auto-title'`, `'codebase-indexing'`, `'github-context'`).
	 */
	readonly key: string;
	/**
	 * Verbatim "why does this leave your machine" text for the feature.
	 */
	readonly why: string;
	/**
	 * The RPCs the egress travels over, as verbatim service/method names.
	 */
	readonly rpcs: readonly string[];
}

/**
 * The per-feature egress disclosure table, verbatim from the 3.25.6 reference
 * bundle (`harvest-cursor-commits-2026-10-19.md` §7). The bundle embeds this
 * table as the canonical "what leaves your machine" list for privacy mode,
 * and the extension listens to `onDidChangePrivacyModeEnum` so tracking
 * respects privacy mode.
 *
 * Multi-method RPC lists are normalized to one string per method; the
 * service names and method names are verbatim.
 */
export const CURSOR_FEATURE_EGRESS_DISCLOSURES: readonly ICursorFeatureEgressDisclosure[] = Object.freeze([
	{
		key: 'chat-auto-title',
		why: 'Sends the first user message to Cursor; the chat\'s own model names it on the team\'s gateway instead.',
		rpcs: ['aiserver.v1.AiService/NameTab'],
	},
	{
		key: 'commit-message',
		why: 'Sends the staged diff to Cursor.',
		rpcs: ['aiserver.v1.AiService/WriteGitCommitMessage'],
	},
	{
		key: 'branch-name',
		why: 'Sends the diff or prompt to Cursor.',
		rpcs: ['aiserver.v1.AiService/WriteGitBranchName'],
	},
	{
		key: 'conversation-classification',
		why: 'Uploads the full conversation for analytics.',
		rpcs: ['aiserver.v1.AnalyticsService/IngestConversation'],
	},
	{
		key: 'transcript-overview',
		why: 'The overview is generated server-side from the conversation text.',
		rpcs: ['agent.v1.AgentService/CreateTranscriptOverview'],
	},
	{
		key: 'agent-review',
		why: 'Streams the working-tree diff to Cursor.',
		rpcs: ['aiserver.v1.AiService/StreamBugBotAgentic'],
	},
	{
		key: 'codebase-indexing',
		why: 'Uploads file contents and paths to Cursor\'s embedding service.',
		rpcs: [
			'RepositoryService FastRepoInitHandshakeV2',
			'RepositoryService SyncMerkleSubtreeV2',
			'RepositoryService FastUpdateFileV2',
			'RepositoryService FastRepoSyncComplete',
			'RepositoryService EnsureIndexCreated',
		],
	},
	{
		key: 'prompt-quality-upload',
		why: 'Uploads a local agent run (every model invocation) to Cursor.',
		rpcs: ['agent.v1.AgentService/UploadLocalAgentRunToPromptQuality'],
	},
	{
		key: 'share-conversation',
		why: 'Publishes the transcript to Cursor.',
		rpcs: ['aiserver.v1.DashboardService/ShareConversation'],
	},
	{
		key: 'knowledge-base',
		why: 'Knowledge base items and agent memories are stored on Cursor\'s servers.',
		rpcs: [
			'AiService KnowledgeBaseAdd',
			'AiService KnowledgeBaseUpdate',
			'AiService KnowledgeBaseList',
		],
	},
	{
		key: 'web-fetch',
		why: 'The agent\'s web fetch tool sends the URL to Cursor; the private-inference tool client refuses it.',
		rpcs: ['AiService/RunWebFetch'],
	},
	{
		key: 'image-generation',
		why: 'Sends the description and reference images to Cursor; the private-inference tool client refuses it.',
		rpcs: ['AiService/RunGenerateImage'],
	},
	{
		key: 'video-generation',
		why: 'Sends the prompt, source image, and reference images to Cursor; the private-inference tool client refuses it.',
		rpcs: ['AiService/RunGenerateVideo'],
	},
	{
		key: 'x-search',
		why: 'The agent\'s X search tool sends the query to Cursor; the private-inference tool client refuses it.',
		rpcs: ['AiService/RunXSearch'],
	},
	{
		key: 'scm-integration',
		why: 'Pull-request metadata, diffs, checks, comments and merge actions go through Cursor\'s SCM service, as does the GitHub/GitLab connection probe.',
		rpcs: [
			'27 RPCs across SCMService (GetPullRequest, MergePullRequest, ...)',
			'BackgroundComposerService (GetPullRequestDiscussions, DeletePullRequestReviewComment)',
			'DashboardService/GetScmConnectionStatus',
		],
	},
	{
		key: 'online-metrics',
		why: 'After an agent turn edits files, uploads each file\'s path and diff to Cursor, plus the added lines and original contents when the server config asks for them.',
		rpcs: ['aiserver.v1.OnlineMetricsService/ReportAgentSnapshot'],
	},
	{
		key: 'codebase-telemetry',
		why: 'Uploads git packfiles of the workspace\'s repositories to Cursor and reports which repositories the workspace contains.',
		rpcs: [
			'CodebaseSnapshotService RegisterCodebase',
			'CodebaseSnapshotService CreatePackfileUpload',
			'CodebaseSnapshotService UploadPackfileChunk',
			'CodebaseSnapshotService CompletePackfileUpload',
			'CodebaseProtectionService ReportWorkspaceRepositories',
			'CodebaseProtectionService CheckCodebaseTelemetryPolicy',
		],
	},
	{
		key: 'github-context',
		why: 'Pull-request, issue and commit context is fetched from GitHub with the user\'s GitHub token, proxied through Cursor when the gate is on; all GitHub egress stays off until it is decided.',
		rpcs: ['BackgroundComposerService/MakeGithubRequest'],
	},
]);

export interface IExtHostCursorMcpSnapshot {
	readonly serverId: string;
	readonly serverName: string;
	readonly serverIdentifier: string;
	readonly instructions?: string;
}

export interface IExtHostCursorMcpLeaseToolResult {
	readonly content: Array<{ type: string; text?: string; [key: string]: unknown }>;
	readonly isError: boolean;
	readonly structuredContent?: unknown;
}

/**
 * A programmatically registered MCP server (feature `mcp-extension-api`).
 *
 * Mirrors `vscode.cursor.mcp.registerServer()` (cursor.com/docs, "MCP"
 * section): "Extension API: `vscode.cursor.mcp.registerServer()` for
 * programmatic registration". Only the API name and its purpose are
 * evidenced; the argument shape is this fork's design (kept close to the
 * `mcp.json` server schema) and is documented as such.
 */
export interface ICursorMcpServerRegistration {
	/** Unique server name (used as its identifier). */
	readonly name: string;
	/** Command for a stdio server. Exactly one of `command` / `url` is required. */
	readonly command?: string;
	readonly args?: readonly string[];
	readonly env?: Readonly<Record<string, string>>;
	readonly cwd?: string;
	/** URL for a remote (HTTP) server. Exactly one of `command` / `url` is required. */
	readonly url?: string;
	readonly headers?: Readonly<Record<string, string>>;
	/** Free-form instructions surfaced alongside the server (e.g. in snapshots). */
	readonly instructions?: string;
}

function validateMcpServerRegistration(server: ICursorMcpServerRegistration): void {
	if (!server || typeof server.name !== 'string' || server.name.length === 0) {
		throw new Error('cursor.mcp.registerServer: `name` must be a non-empty string.');
	}
	const hasCommand = typeof server.command === 'string' && server.command.length > 0;
	const hasUrl = typeof server.url === 'string' && server.url.length > 0;
	if (hasCommand === hasUrl) {
		throw new Error('cursor.mcp.registerServer: exactly one of `command` or `url` must be provided.');
	}
}

/**
 * In-memory registry backing `cursor.mcp.registerServer()`.
 *
 * HONEST-DIVERGENCE: Cursor hosts registered servers through its MCP
 * process/lease infrastructure. This fork keeps programmatic registrations
 * in the extension host (same layer as the rest of the `cursor` namespace)
 * and surfaces them through `getMcpSnapshots()` / `getRegisteredServers()`;
 * launching connections for them goes through the workbench MCP stack once
 * the definition is synced, which is future work.
 */
export class ExtHostCursorMcpServerRegistry extends Disposable {
	private readonly _onDidChange = this._register(new Emitter<void>());
	readonly onDidChange: Event<void> = this._onDidChange.event;

	private readonly _servers = new Map<string, ICursorMcpServerRegistration>();

	registerServer(server: ICursorMcpServerRegistration): vscode.Disposable {
		validateMcpServerRegistration(server);
		const snapshot: ICursorMcpServerRegistration = { ...server };
		// Last registration wins on duplicate names (documented choice;
		// Cursor's conflict semantics are UNKNOWN).
		this._servers.set(server.name, snapshot);
		this._onDidChange.fire();
		return toDisposable(() => {
			if (this._servers.get(server.name) === snapshot) {
				this._servers.delete(server.name);
				this._onDidChange.fire();
			}
		});
	}

	getRegisteredServers(): readonly ICursorMcpServerRegistration[] {
		return [...this._servers.values()];
	}
}

export class ExtHostCursor extends Disposable {

	private readonly _onDidChangeGates = this._register(new Emitter<void>());
	readonly onDidChangeGates: Event<void> = this._onDidChangeGates.event;

	private readonly _onDidChangePrivacyModeEnum = this._register(new Emitter<void>());
	/**
	 * Mirrors Cursor's `cursor.onDidChangePrivacyModeEnum` (3.25.6) — the
	 * event the reference extension listens to so tracking respects privacy
	 * mode. Fires when the resolved privacy mode enum changes. The event
	 * payload in the reference is UNKNOWN; this fork fires void.
	 */
	readonly onDidChangePrivacyModeEnum: Event<void> = this._onDidChangePrivacyModeEnum.event;

	/**
	 * Last resolved privacy mode enum; used to fire
	 * {@link onDidChangePrivacyModeEnum} only on genuine changes.
	 */
	private _lastPrivacyModeEnum: ExtHostCursorPrivacyMode;

	/**
	 * Mirrors Cursor's single provider slot (`this._provider.set(e)` in the
	 * 3.25.6 reference): re-registering replaces the previous provider.
	 */
	private _agentHostProvider: IAgentHostProvider | undefined;
	private _agentHostRuntime: unknown | undefined;
	private _hasAgentHostRuntime = false;

	private readonly _mcpServerRegistry = this._register(new ExtHostCursorMcpServerRegistry());

	/**
	 * Configuration reads go through the barrier-backed
	 * {@link ExtHostConfigProvider} (`IExtHostConfiguration` itself exposes
	 * no `getConfiguration`; the provider only exists after `$initializeConfiguration`).
	 * Until the provider resolves, synchronous readers see the defaults
	 * (NoStorage / false / undefined) — the privacy-safe values.
	 */
	private _configProvider: ExtHostConfigProvider | undefined;
	private readonly _configProviderReady: Promise<ExtHostConfigProvider>;

	constructor(
		private readonly _configuration: IExtHostConfiguration,
		private readonly _mcpService: IExtHostMpcService,
	) {
		super();
		this._lastPrivacyModeEnum = this.getPrivacyModeEnum();
		this._configProviderReady = this._configuration.getConfigProvider().then(provider => {
			this._configProvider = provider;
			this._register(provider.onDidChangeConfiguration(e => this._onConfigurationChanged(e)));
			// The provider may resolve with a non-default privacy mode even
			// though the pre-init reads saw the default; reconcile + fire.
			const next = this.getPrivacyModeEnum();
			if (next !== this._lastPrivacyModeEnum) {
				this._lastPrivacyModeEnum = next;
				this._onDidChangePrivacyModeEnum.fire();
			}
			return provider;
		});
	}

	/** The `ide.agent` section of the resolved configuration, if initialized. */
	private _getAgentConfig(): vscode.WorkspaceConfiguration | undefined {
		return this._configProvider?.getConfiguration('ide.agent');
	}

	private _onConfigurationChanged(e: vscode.ConfigurationChangeEvent): void {
		if (e.affectsConfiguration('ide.agent.featureGates') || e.affectsConfiguration('ide.agent.dynamicConfig')) {
			this._onDidChangeGates.fire();
		}
		if (e.affectsConfiguration('ide.agent.privacyMode')) {
			const next = this.getPrivacyModeEnum();
			if (next !== this._lastPrivacyModeEnum) {
				this._lastPrivacyModeEnum = next;
				this._onDidChangePrivacyModeEnum.fire();
			}
		}
	}

	// #region agent hosting

	registerAgentHostProvider(provider: IAgentHostProvider): vscode.Disposable {
		this._agentHostProvider = provider;
		return toDisposable(() => {
			// Only clear if this registration is still the current one,
			// mirroring Cursor's provider-slot semantics.
			if (this._agentHostProvider === provider) {
				this._agentHostProvider = undefined;
			}
		});
	}

	registerAgentHostRuntime(runtime: unknown): vscode.Disposable {
		this._agentHostRuntime = runtime;
		this._hasAgentHostRuntime = true;
		return toDisposable(() => {
			this._agentHostRuntime = undefined;
			this._hasAgentHostRuntime = false;
		});
	}

	acquireAgentHostRuntime(): unknown {
		// Mirrors Cursor's `nn(this._runtime)` — throw when nothing registered.
		if (!this._hasAgentHostRuntime) {
			throw new Error('No agent host runtime has been registered (cursor.acquireAgentHostRuntime).');
		}
		return this._agentHostRuntime;
	}

	// #endregion

	// #region feature gates / dynamic config

	async checkFeatureGate(gateName: string, _options?: ICursorFeatureGateOptions): Promise<boolean> {
		// HONEST-DIVERGENCE: Cursor delegates to its server-driven experiment
		// service (`experimentService.checkFeatureGate(name,
		// {disableExposureLog: true})`). This fork has no experiment service,
		// so gates are read from the local `ide.agent.featureGates`
		// configuration record; unknown gates resolve to false.
		// `_options.disableExposureLog` is accepted for call-shape parity with
		// the binary and has no local effect (nothing logs exposures).
		const gates = (await this._configProviderReady).getConfiguration('ide.agent').get<Record<string, boolean>>('featureGates');
		return gates?.[gateName] ?? false;
	}

	async getDynamicConfigValue(key: string): Promise<unknown> {
		// HONEST-DIVERGENCE: Cursor serves these from its experiment service
		// (`experimentService.getDynamicConfig(key, {disableExposureLog:
		// true})`). The 5 keys OBSERVED in the 3.25.6 reference bundle
		// (harvest-cursor-always-local-2026-10-19.md §1): "http1_keepalive_config",
		// "http2_agent_connection_pool_config", "http2_ping_config",
		// "http2_session_establish_timeout", "retry_interceptor_config".
		// This fork reads the local `ide.agent.dynamicConfig` configuration
		// record instead; unknown keys resolve to undefined.
		const config = (await this._configProviderReady).getConfiguration('ide.agent').get<Record<string, unknown>>('dynamicConfig');
		return config?.[key] ?? undefined;
	}

	// #endregion

	// #region MCP

	/**
	 * Programmatic MCP server registration.
	 * Mirrors `vscode.cursor.mcp.registerServer()` (cursor.com/docs).
	 */
	registerServer(server: ICursorMcpServerRegistration): vscode.Disposable {
		return this._mcpServerRegistry.registerServer(server);
	}

	/** The servers currently registered via {@link registerServer}. */
	getRegisteredServers(): readonly ICursorMcpServerRegistration[] {
		return this._mcpServerRegistry.getRegisteredServers();
	}

	/** Fires when the set of programmatically registered servers changes. */
	readonly onDidChangeRegisteredServers: Event<void> = this._mcpServerRegistry.onDidChange;

	async getMcpSnapshots(_serializableContext?: unknown): Promise<IExtHostCursorMcpSnapshot[]> {
		// HONEST-DIVERGENCE: Cursor resolves snapshots through its leased-MCP
		// infrastructure on the main thread
		// (`MainThreadCursor.$getMcpSnapshots` →
		// `mcpService.getResolvedMcpSnapshots()`). This fork has no MCP lease
		// layer, so snapshots are derived from the extension host's
		// registered MCP server definitions. `serverId`/`serverIdentifier`
		// are the definition labels and lease-specific fields (tools,
		// per-lease state) are absent. Programmatically registered servers
		// (via `cursor.mcp.registerServer`) are appended.
		const fromDefinitions = this._mcpService.mcpServerDefinitions.map(def => ({
			serverId: def.label,
			serverName: def.label,
			serverIdentifier: def.label,
			instructions: undefined,
		}));
		const fromRegistrations = this._mcpServerRegistry.getRegisteredServers().map(reg => ({
			serverId: reg.name,
			serverName: reg.name,
			serverIdentifier: reg.name,
			instructions: reg.instructions,
		}));
		return [...fromDefinitions, ...fromRegistrations];
	}

	async callMcpLeaseTool(serverIdentifier: string, toolName: string, _args: unknown): Promise<IExtHostCursorMcpLeaseToolResult> {
		// UNKNOWN: the full internal call shape in the 3.25.6 reference takes
		// 8 positional arguments whose meanings could not be recovered from
		// the minified bundle, and this fork has no MCP lease infrastructure
		// to execute the call against. This stub never fakes a successful
		// tool result: it resolves with isError=true and an explanatory
		// message.
		const known = this._mcpService.mcpServerDefinitions.some(def => def.label === serverIdentifier);
		return {
			content: [{
				type: 'text',
				text: `callMcpLeaseTool is not implemented in this build (UNKNOWN): ` +
					`no MCP lease infrastructure to execute tool "${toolName}" on ` +
					`${known ? `server "${serverIdentifier}"` : `unknown server "${serverIdentifier}"`}.`,
			}],
			isError: true,
		};
	}

	// #endregion

	// #region privacy / mode

	getPrivacyModeEnum(): ExtHostCursorPrivacyMode {
		// HONEST-DIVERGENCE: Cursor reads this from its authentication
		// service (`cursorAuthenticationService.granularPrivacyModeRawEnum()`),
		// which is per-account and server-known. This fork has no Cursor
		// account, so the value comes from the local `ide.agent.privacyMode`
		// configuration (one of the verbatim enum names), defaulting to
		// NoStorage — the privacy-safe choice.
		const raw = this._getAgentConfig()?.get<string>('privacyMode');
		if (typeof raw === 'string') {
			const mapped = _privacyModeByName[raw.toUpperCase()];
			if (mapped !== undefined) {
				return mapped;
			}
		}
		return ExtHostCursorPrivacyMode.NoStorage;
	}

	get isLocalMode(): boolean {
		// Backed by the existing `ide.agent.localMode` setting (default
		// false); same setting already consulted by the terminal Cmd+K flow.
		return this._getAgentConfig()?.get<boolean>('localMode') ?? false;
	}

	// #endregion

	// #region privacy egress gates (`privacy-mode-feature-egress-gates`)

	/**
	 * The per-feature egress disclosure table — the canonical "what leaves
	 * your machine" list for privacy mode, verbatim from the 3.25.6 reference
	 * bundle (see {@link CURSOR_FEATURE_EGRESS_DISCLOSURES}).
	 */
	getFeatureEgressDisclosures(): readonly ICursorFeatureEgressDisclosure[] {
		return CURSOR_FEATURE_EGRESS_DISCLOSURES;
	}

	/**
	 * Whether a privacy egress gate is defined for `featureKey` — i.e.
	 * whether the key appears in the canonical egress disclosure table.
	 */
	hasFeatureEgressGate(featureKey: string): boolean {
		return CURSOR_FEATURE_EGRESS_DISCLOSURES.some(d => d.key === featureKey);
	}

	/**
	 * Whether network egress for the given feature is currently allowed under
	 * privacy mode.
	 *
	 * Semantics (fork mapping, documented):
	 * - Features not in the disclosure table have no egress gate and are
	 *   allowed — the table is the canonical gated list.
	 * - When privacy mode is on — resolved enum in {Unspecified, NoStorage,
	 *   NoTraining}, i.e. the modes where code is never stored nor used for
	 *   training — egress for every gated feature is blocked.
	 * - When the mode explicitly allows training/usage
	 *   ({UsageDataTrainingAllowed, UsageCodebaseTrainingAllowed}), gated
	 *   features are allowed, except `github-context`, which the reference
	 *   documents as staying off "until it is decided": it additionally
	 *   requires the key to be listed in the `ide.agent.egressAllowedFeatures`
	 *   configuration.
	 *
	 * HONEST-DIVERGENCE: the binary's exact per-mode enforcement matrix for
	 * the per-feature gates was not recovered from the minified bundle (only
	 * the disclosure table and the `onDidChangePrivacyModeEnum` listener
	 * were), so this fork uses the no-training boundary above. The exact
	 * binary boundary for the boolean `getPrivacyMode()` is likewise
	 * UNVERIFIED.
	 */
	isFeatureEgressAllowed(featureKey: string): boolean {
		if (!this.hasFeatureEgressGate(featureKey)) {
			return true;
		}
		if (this._isPrivacyEgressGated()) {
			return false;
		}
		if (featureKey === 'github-context') {
			// Verbatim: "all GitHub egress stays off until it is decided".
			const decided = this._getAgentConfig()?.get<string[]>('egressAllowedFeatures');
			return Array.isArray(decided) && decided.includes('github-context');
		}
		return true;
	}

	/**
	 * Privacy mode is "on" for egress purposes when the resolved enum forbids
	 * storage/training: Unspecified (safe default), NoStorage or NoTraining.
	 * Modes that explicitly allow usage-data/codebase training open the
	 * egress gates (except `github-context`, gated separately above).
	 */
	private _isPrivacyEgressGated(): boolean {
		const mode = this.getPrivacyModeEnum();
		return mode === ExtHostCursorPrivacyMode.Unspecified
			|| mode === ExtHostCursorPrivacyMode.NoStorage
			|| mode === ExtHostCursorPrivacyMode.NoTraining;
	}

	// #endregion
}
