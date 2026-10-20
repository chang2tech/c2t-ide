/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

declare module 'vscode' {

	/**
	 * The `cursor` API namespace — IDE Code's counterpart of Cursor's
	 * `vscode.cursor.*` extension-host API surface (Cursor 3.25.6 reference:
	 * `extensions/cursor-agent-host/dist/main.js` uses 51 distinct members;
	 * `out/vs/workbench/api/node/extensionHostProcess.js` exposes the full
	 * namespace object).
	 *
	 * Only the agent-hosting-critical subset is implemented. Every member is
	 * gated by the `cursor` API proposal (`enabledApiProposals: ["cursor"]`).
	 *
	 * HONEST-DIVERGENCE: Cursor backs most of these members with server-side
	 * services (experiment service / Statsig-style gates, Cursor auth service,
	 * leased MCP infrastructure). This fork backs them with local equivalents
	 * (workspace configuration, in-memory registries, local MCP definitions).
	 * Members whose semantics could only be inferred from the minified
	 * reference are marked as such; nothing is faked to look server-driven.
	 */
	namespace cursor {

		/**
		 * Privacy mode. Values are verbatim from Cursor 3.25.6
		 * (`aiserver.v1.PrivacyMode` protobuf enum in
		 * `workbench.desktop.main.js`).
		 */
		export enum PrivacyMode {
			Unspecified = 0,
			/** Do not store code on Cursor's servers. */
			NoStorage = 1,
			/** Do not train on the user's code. */
			NoTraining = 2,
			/** Usage-data training allowed. */
			UsageDataTrainingAllowed = 3,
			/** Codebase training allowed. */
			UsageCodebaseTrainingAllowed = 4,
		}

		/**
		 * A provider that hosts agent sessions, as passed to
		 * {@link cursor.registerAgentHostProvider}. Shape inferred from the
		 * minified call site in Cursor 3.25.6 `cursor-agent-host/dist/main.js`
		 * (`{client, clientInstanceId, loop, hostedMcpRoutingEnabled,
		 * workspacePaths}`) — additional provider-specific fields are allowed.
		 */
		export interface AgentHostProvider {
			readonly client?: unknown;
			readonly clientInstanceId?: string;
			readonly loop?: unknown;
			readonly hostedMcpRoutingEnabled?: () => boolean;
			readonly workspacePaths?: () => string[];
			readonly [key: string]: unknown;
		}

		/**
		 * Registers the extension's agent-host provider. Mirrors
		 * `cursor.registerAgentHostProvider` (Cursor 3.25.6): the provider is
		 * kept in a single slot (re-registering replaces the previous one);
		 * disposing the returned disposable unregisters it.
		 */
		export function registerAgentHostProvider(provider: AgentHostProvider): Disposable;

		/**
		 * Registers the agent-host runtime object made available to
		 * {@link cursor.acquireAgentHostRuntime}. Not observed being called by
		 * `cursor-agent-host` itself in the 3.25.6 reference, but it is part of
		 * the namespace and is the natural pair of `acquireAgentHostRuntime`.
		 */
		export function registerAgentHostRuntime(runtime: unknown): Disposable;

		/**
		 * Returns the currently registered agent-host runtime.
		 * Mirrors `cursor.acquireAgentHostRuntime` (Cursor 3.25.6), which
		 * throws when no runtime has been registered.
		 *
		 * NOTE: `agentHostTurnRuntime` (named in the feature evidence) is NOT
		 * a `cursor.*` namespace member in the 3.25.6 reference — it is an
		 * internal dependency-injection token
		 * (`Symbol.for("cursor.agentHostTurnRuntime")`) inside the
		 * `cursor-agent-host` bundle. It is therefore intentionally absent
		 * here; turn-scoped state should travel on the runtime object
		 * returned by this function.
		 */
		export function acquireAgentHostRuntime(): unknown;

		/**
		 * Options accepted by {@link cursor.checkFeatureGate}. The options
		 * object shape is observed in the 3.25.6+ reference bundles:
		 * `checkFeatureGate("cursor_blame", {disableExposureLog:!1})`.
		 */
		export interface FeatureGateOptions {
			/**
			 * When true, Cursor skips exposure logging for this gate check.
			 * Accepted for call-shape parity; it has no effect in this fork
			 * (no experiment service to suppress logging on).
			 */
			readonly disableExposureLog?: boolean;
		}

		/**
		 * Checks a feature gate. Mirrors `cursor.checkFeatureGate(gateName)`
		 * (Cursor 3.25.6); the binary also passes
		 * `{disableExposureLog: true}` options, which this signature accepts.
		 *
		 * HONEST-DIVERGENCE: Cursor delegates to its server-driven experiment
		 * service. This fork reads the local `ide.agent.featureGates`
		 * configuration record instead; unknown gates resolve to `false`.
		 */
		export function checkFeatureGate(gateName: string, options?: FeatureGateOptions): Promise<boolean>;

		/**
		 * Fires when feature-gate values may have changed. Mirrors
		 * `cursor.onDidChangeGates` (Cursor 3.25.6).
		 */
		export const onDidChangeGates: Event<void>;

		/**
		 * Reads a dynamic (server-pushed) config value. Mirrors
		 * `cursor.getDynamicConfigValue(key)` (Cursor 3.25.6); the keys
		 * OBSERVED in the reference bundle are `"http1_keepalive_config"`,
		 * `"http2_agent_connection_pool_config"`, `"http2_ping_config"`,
		 * `"http2_session_establish_timeout"`, `"retry_interceptor_config"`.
		 *
		 * HONEST-DIVERGENCE: Cursor serves these from its experiment service.
		 * This fork reads the local `ide.agent.dynamicConfig` configuration
		 * record instead; unknown keys resolve to `undefined`.
		 */
		export function getDynamicConfigValue(key: string): Promise<unknown>;

		/**
		 * A point-in-time view of one MCP server, as returned by
		 * {@link cursor.getMcpSnapshots}. Field names are verbatim from the
		 * 3.25.6 reference call sites (`serverId`, `serverName`,
		 * `serverIdentifier`, `instructions`).
		 */
		export interface McpSnapshot {
			readonly serverId: string;
			readonly serverName: string;
			readonly serverIdentifier: string;
			readonly instructions?: string;
		}

		/**
		 * Returns the current MCP server snapshots. Mirrors
		 * `cursor.getMcpSnapshots(serializableContext)` (Cursor 3.25.6).
		 *
		 * HONEST-DIVERGENCE: Cursor resolves these through its leased-MCP
		 * infrastructure on the main thread. This fork derives snapshots from
		 * the extension host's registered MCP server definitions, so
		 * `serverId`/`serverIdentifier` are the definition labels and
		 * lease-specific fields (tools, per-lease state) are absent.
		 */
		export function getMcpSnapshots(serializableContext?: unknown): Promise<McpSnapshot[]>;

		/**
		 * Result of {@link cursor.callMcpLeaseTool}. Field names are verbatim
		 * from the 3.25.6 reference call sites (`content`, `isError`,
		 * `structuredContent`).
		 */
		export interface McpLeaseToolResult {
			readonly content: Array<{ type: string; text?: string; [key: string]: unknown }>;
			readonly isError: boolean;
			readonly structuredContent?: unknown;
		}

		/**
		 * Calls a tool on a leased MCP server. Mirrors
		 * `cursor.callMcpLeaseTool(...)` (Cursor 3.25.6).
		 *
		 * UNKNOWN: the full 8-argument internal call shape could not be
		 * recovered from the minified reference, and this fork has no MCP
		 * lease infrastructure, so tool execution is not performed. The
		 * promise resolves with `isError: true` and an explanatory message —
		 * it never fakes a successful tool result.
		 */
		export function callMcpLeaseTool(serverIdentifier: string, toolName: string, args: unknown): Promise<McpLeaseToolResult>;

		/**
		 * Returns the current privacy mode. Mirrors
		 * `cursor.getPrivacyModeEnum()` (Cursor 3.25.6), which the reference
		 * extension calls synchronously.
		 *
		 * HONEST-DIVERGENCE: Cursor reads this from its authentication
		 * service (per-account, server-known). This fork reads the local
		 * `ide.agent.privacyMode` configuration, defaulting to
		 * {@link PrivacyMode.NoStorage}.
		 */
		export function getPrivacyModeEnum(): PrivacyMode;

		/**
		 * Fires when the privacy mode enum changes. Mirrors
		 * `cursor.onDidChangePrivacyModeEnum` (Cursor 3.25.6) — the event the
		 * reference extension listens to so tracking respects privacy mode.
		 * The event payload in the reference is UNKNOWN; this fork fires void.
		 */
		export const onDidChangePrivacyModeEnum: Event<void>;

		/**
		 * One row of Cursor's per-feature egress disclosure table — the
		 * canonical "what leaves your machine" list for privacy mode
		 * (feature key → why-text → RPCs), verbatim from the 3.25.6 reference
		 * bundle. There are 18 keys: `chat-auto-title`, `commit-message`,
		 * `branch-name`, `conversation-classification`, `transcript-overview`,
		 * `agent-review`, `codebase-indexing`, `prompt-quality-upload`,
		 * `share-conversation`, `knowledge-base`, `web-fetch`,
		 * `image-generation`, `video-generation`, `x-search`,
		 * `scm-integration`, `online-metrics`, `codebase-telemetry`,
		 * `github-context`.
		 */
		export interface FeatureEgressDisclosure {
			/** Feature key, verbatim (e.g. `'chat-auto-title'`). */
			readonly key: string;
			/** Verbatim "why does this leave your machine" text. */
			readonly why: string;
			/** The RPCs the egress travels over, verbatim service/method names. */
			readonly rpcs: readonly string[];
		}

		/**
		 * Returns the per-feature egress disclosure table. Mirrors the
		 * disclosure table embedded in Cursor's extension bundle (3.25.6).
		 */
		export function getFeatureEgressDisclosures(): readonly FeatureEgressDisclosure[];

		/**
		 * Whether a privacy egress gate is defined for `featureKey` (i.e. the
		 * key appears in the canonical egress disclosure table).
		 */
		export function hasFeatureEgressGate(featureKey: string): boolean;

		/**
		 * Whether network egress for the given feature is currently allowed
		 * under privacy mode.
		 *
		 * Gated features are blocked while privacy mode is on (the
		 * no-storage / no-training modes); they are allowed once the mode
		 * explicitly permits training/usage, except `github-context`, which
		 * stays off until it is explicitly decided via the
		 * `ide.agent.egressAllowedFeatures` configuration (verbatim: "all
		 * GitHub egress stays off until it is decided").
		 */
		export function isFeatureEgressAllowed(featureKey: string): boolean;

		/**
		 * Whether the agent is running in local mode. Mirrors
		 * `cursor.isLocalMode` (Cursor 3.25.6), which the reference extension
		 * reads as a property (not a function call). Backed by the existing
		 * `ide.agent.localMode` setting.
		 */
		export const isLocalMode: boolean;

		// #region checkout provider (cursor-checkout)

		/**
		 * Options for {@link CheckoutProvider.checkoutBranch}. Verbatim from
		 * the decompiled `cursor-checkout` extension (Cursor 3.25.9):
		 * `checkoutBranch(delegate, branchName, { commitSha?, localOnly? }, token)`.
		 */
		export interface CheckoutBranchOptions {
			/**
			 * When set and fetchable from origin, the provider checks out
			 * this exact commit instead of resolving a branch name.
			 */
			readonly commitSha?: string;
			/**
			 * When true, only a local `refs/heads/<branch>` is verified and
			 * checked out — no fetch, no remote branch creation.
			 */
			readonly localOnly?: boolean;
		}

		/**
		 * Options for {@link CheckoutProvider.ensureCurrentBranchPushed}.
		 * Verbatim from the decompiled `cursor-checkout` extension.
		 */
		export interface EnsureBranchPushedOptions {
			readonly cwd?: string;
			readonly remoteName?: string;
			readonly branchName?: string;
			readonly forcePush?: boolean;
		}

		/**
		 * Options for {@link CheckoutProvider.snapshotAndPushCurrentBranch} —
		 * the "move to cloud" primitive. Verbatim from the decompiled
		 * `cursor-checkout` extension.
		 */
		export interface SnapshotPushOptions {
			readonly cwd?: string;
			readonly remoteName?: string;
			readonly commitMessage?: string;
			readonly branchPrefix?: string;
			readonly stashLocalChangesAfterPush?: boolean;
			readonly stashMessage?: string;
		}

		/**
		 * The user's answer to the dirty-working-tree conflict prompt offered
		 * during {@link CheckoutProvider.checkoutBranch}: stash, commit, or
		 * discard local changes. Verbatim set from the decompiled
		 * `cursor-checkout` extension.
		 */
		export type CheckoutConflictResolution = 'stash' | 'commit' | 'discard';

		/**
		 * The conflict delegate handed to the extension provider as the first
		 * argument of {@link CheckoutProvider.checkoutBranch}.
		 *
		 * Verbatim from Cursor 3.25.9 (`ExtHostCheckoutProvider.$checkoutBranch`
		 * builds `{ resolveConflict: () => $resolveCheckoutConflict(id),
		 * onNoConflictDetected: () => $notifyCheckoutNoConflict(id) }` and
		 * calls `provider.checkoutBranch(delegate, branchName, options,
		 * token)`): `resolveConflict()` RPCs back to the main thread, where
		 * the core-side delegate shows the stash/commit/discard/cancel
		 * QuickPick in workbench core. Resolves `'abort'` when dismissed or
		 * when no delegate is registered.
		 */
		export interface CheckoutConflictDelegate {
			resolveConflict(): Promise<CheckoutConflictResolution | 'abort' | undefined>;
			onNoConflictDetected(): void;
		}

		/**
		 * The checkout provider protocol. Implemented by the `ide-checkout`
		 * built-in extension and registered with the workbench via
		 * {@link cursor.registerCheckoutProvider}. This is the machine behind
		 * branch migration / local↔cloud handoff (Agents Window "move to
		 * cloud", `/in-cloud`, cloud subagents): a hardened,
		 * cancellation-aware git operation layer with conflict-resolution UX.
		 *
		 * Method set and semantics are verbatim from the decompiled
		 * `cursor-checkout` v0.0.1 extension (Cursor 3.25.9), structure and
		 * behavior only.
		 */
		export interface CheckoutProvider {
			/**
			 * Full branch-checkout flow.
			 *
			 * Verbatim signature from the decompiled `cursor-checkout` v0.0.1
			 * (Cursor 3.25.9): `checkoutBranch(delegate, branchName,
			 * { commitSha?, localOnly? }, token)` — the conflict delegate
			 * comes **first**.
			 * When the working tree is dirty the provider calls
			 * `delegate.resolveConflict()` (which shows the core QuickPick via
			 * RPC) and applies the chosen git commands: stash →
			 * `git stash --include-untracked`; commit → `git add -A` +
			 * `git commit -m "checkpoint before checking out <branch>"`;
			 * discard → `git reset --quiet --hard HEAD` +
			 * `git clean --quiet -fd`; anything else → throw
			 * `Aborting checkout`.
			 */
			checkoutBranch(delegate: CheckoutConflictDelegate, branchName: string, options: CheckoutBranchOptions, token: CancellationToken): Promise<void>;
			/**
			 * Pre-fetches `+refs/heads/<branch>:refs/remotes/origin/<branch>`.
			 * Results are cached for 30 s (`recentlyWarmedBranches`); a later
			 * {@link checkoutBranch} skips its fetch while the entry is warm.
			 */
			warmCheckoutBranch(branchName: string, token: CancellationToken): Promise<void>;
			/**
			 * Pushes `HEAD:refs/heads/<branch>` to the remote, optionally with
			 * `--force-with-lease`.
			 */
			ensureCurrentBranchPushed(options: EnsureBranchPushedOptions, token: CancellationToken): Promise<void>;
			/**
			 * Snapshots the dirty working tree into a commit built on a
			 * throwaway index (the user's working tree is untouched) and
			 * pushes it to a new `<branchPrefix>cloud-agent-<timestamp>-<rand>`
			 * branch (default prefix `cursor/`). Resolves with the pushed
			 * branch name.
			 */
			snapshotAndPushCurrentBranch(options: SnapshotPushOptions, token: CancellationToken): Promise<string>;
			/**
			 * Streaming dirty check: resolves `true` on the first byte of
			 * `git status --porcelain` output, `false` when git exits clean.
			 */
			hasDirtyWorkingTree(token: CancellationToken): Promise<boolean>;
		}

		/**
		 * Registers the extension's checkout provider. Mirrors
		 * `cursor.registerCheckoutProvider` (Cursor 3.25.9): the provider is
		 * kept in a single slot (re-registering replaces the previous one);
		 * disposing the returned disposable unregisters it.
		 */
		export function registerCheckoutProvider(provider: CheckoutProvider): Disposable;

		// #endregion

		// #region mcp (programmatic server registration)

		/**
		 * MCP extension API surface (feature `mcp-extension-api`).
		 *
		 * Mirrors `vscode.cursor.mcp.registerServer()` (cursor.com/docs,
		 * "MCP" section): "Extension API: `vscode.cursor.mcp.registerServer()`
		 * for programmatic registration". Only the API name and its purpose
		 * are evidenced; the argument shape follows the `mcp.json` server
		 * schema and is this fork's design.
		 */
		namespace mcp {
			/**
			 * A programmatically registered MCP server. Shape follows the
			 * `mcp.json` server schema.
			 */
			export interface McpServerRegistration {
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
				/** Free-form instructions surfaced alongside the server. */
				readonly instructions?: string;
			}

			/**
			 * Registers an MCP server programmatically. Re-registering the
			 * same name replaces the previous registration; disposing the
			 * returned disposable unregisters it. Registered servers are
			 * surfaced through `getRegisteredServers()` and included in
			 * `cursor.getMcpSnapshots()`.
			 */
			export function registerServer(server: McpServerRegistration): Disposable;

			/** The servers currently registered via {@link registerServer}. */
			export function getRegisteredServers(): readonly McpServerRegistration[];

			/** Fires when the set of programmatically registered servers changes. */
			export const onDidChangeRegisteredServers: Event<void>;
		}

		// #endregion
	}
}
