/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// IDE-CODE: Settings registration for the Composer (AI chat) workbench contribution.
//
// Migrated from `extensions/ide-agent/package.json` -> `contributes.configuration`
// (7 sections, 40 properties). See `docs/rea/contributes-migration-map.md`.
//
// DECISION (recorded 2026-10-19): property ids KEEP the `ide.` prefix.
// Rationale:
//  1. Backwards compatibility — existing user settings.json files already use
//     `ide.tab.enabled`, `ide.agent.engineMode`, ... Renaming would silently
//     orphan every existing user setting.
//  2. The ide-agent extension runtime reads these ids directly
//     (`vscode.workspace.getConfiguration("ide.agent")` etc.); a rename would
//     require touching extension runtime code, which is out of scope for this
//     migration.
//  3. Keybinding `when` clauses reference `config.ide.tab.enablePartialAccepts`
//     (composerActions.ts); the kept prefix keeps them working unchanged.

import { localize } from '../../../../nls.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { Extensions as ConfigurationExtensions, ConfigurationScope, IConfigurationRegistry } from '../../../../platform/configuration/common/configurationRegistry.js';

const configurationRegistry = Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration);


// --- IDE Code › General (11 properties) ---
configurationRegistry.registerConfiguration({
	id: 'ideCode.ide-code.general',
	title: 'IDE Code › General',
	type: 'object',
	properties: {
		'ide.chat.openAsEditorTabs': {
			type: 'boolean',
			default: true,
			description: localize('composer.configuration.ide.chat.openAsEditorTabs', 'Open chats as editor tabs instead of the legacy stacked sidebar view (Cursor "Open Chat as Editor Tabs" parity).'),
			scope: ConfigurationScope.WINDOW
		},
		'ide.composer.showEmptyStateTips': {
			type: 'boolean',
			default: true,
			description: localize('composer.configuration.ide.composer.showEmptyStateTips', 'Show rotating tips on the empty chat screen. Mirrors cursor.composer.showEmptyStateTips.')
		},
		'ide.window.openAgentsWindowOnStartup': {
			type: 'boolean',
			default: false,
			description: localize('composer.configuration.ide.window.openAgentsWindowOnStartup', 'Open the Agents Window instead of the default window on startup.'),
			scope: ConfigurationScope.APPLICATION
		},
		// DEV-GAPS-83 (settings-window-layout): Cursor 3.25.9 evidence —
		// Settings › General › Layout entry "Window Layout" —
		// "Switch between Agent and Editor default layouts" — segmented
		// Agent | Editor (live CDP docs/rea/detail-settings-2026-10-19.md:52;
		// binary settings entry @28560353, presets
		// defaultLayoutPresets.js @24309085). Cursor's entry is not a
		// persisted config: its displayed value is DERIVED from the primary
		// side bar position (left = Editor, right = Agent) and selecting a
		// value APPLIES the matching preset. This enum is the fork's
		// settings-surface equivalent: the WindowLayoutContribution
		// (browser/windowLayoutActions.ts) watches it and applies the
		// verbatim preset (part visibility + sidebar location + the
		// binary's last-selected-layout storage key). The default 'editor'
		// matches the derived value for the fork's default left sidebar;
		// it is only applied when the user changes the setting.
		'ide.window.defaultLayout': {
			type: 'string',
			enum: ['agent', 'editor'],
			enumDescriptions: [
				localize('composer.configuration.ide.window.defaultLayout.agent', 'Agent'),
				localize('composer.configuration.ide.window.defaultLayout.editor', 'Editor')
			],
			default: 'editor',
			description: localize('composer.configuration.ide.window.defaultLayout', 'Window Layout: switch between Agent and Editor default layouts. Changing this applies the selected layout preset (chat, panel, primary side bar visibility and side bar location). Mirrors Cursor Settings › General › Layout › "Window Layout".'),
			scope: ConfigurationScope.APPLICATION
		},
		// DEV-GAPS-103 (settings-autohide-editor): Cursor 3.25.9 evidence,
		// self-verified in workbench.desktop.main.js — storage descriptor
		// `autoHideEditorWhenEmpty:Jh(!1,-1,0)` @14325017 (boolean, default
		// false, storageScope -1 = APPLICATION, storageTarget 0 = USER;
		// storage key `cursor/autoHideEditorWhenEmpty` via `uGt` @14321085);
		// settings registry `hl("general","auto-hide-editor",{label:
		// "Auto-Hide Editor When Empty",surface:"ide"})` @37325620 (General
		// › Layout); settings control @37533928 with the description below
		// VERBATIM and searchAliases ["editor","hide","empty","maximize
		// chat"]. Cursor stores this as a reactive storage preference, not
		// a configuration property; per the fork precedent for such
		// settings (ide.window.defaultLayout above), this configuration is
		// the fork's settings surface for it — same default, same verbatim
		// description, APPLICATION scope matching storageScope -1. The
		// layout behavior lives in browser/autoHideEditorActions.ts; pure
		// definitions/guards in common/autoHideEditor.ts.
		'ide.window.autoHideEditorWhenEmpty': {
			type: 'boolean',
			default: false,
			description: localize('composer.configuration.ide.window.autoHideEditorWhenEmpty', 'When all editors are closed, hide the editor area and maximize chat'),
			scope: ConfigurationScope.APPLICATION
		},
		// DEV-GAPS-75 (settings-continue-interrupted): Cursor 3.25.9 evidence,
		// live CDP (docs/rea/detail-settings-2026-10-19.md:63): Settings ›
		// General › Startup entry "Continue Interrupted Agents" —
		// "Automatically resume working on agents and their subagents after
		// a reload or restart" — toggle ON (live: checked). Read by the
		// ide-agent extension's startup resume sweep
		// (services/continueInterruptedAgents.ts).
		'ide.agent.continueInterruptedAgents': {
			type: 'boolean',
			default: true,
			description: localize('composer.configuration.ide.agent.continueInterruptedAgents', 'Automatically resume working on agents and their subagents after a reload or restart. Cursor: Settings › General › Startup › "Continue Interrupted Agents" (default on).')
		},
		// DEV-GAPS-81 (F6, QA GAPS-79C): SINGLE registration for this key.
		// It was also declared in extensions/ide-agent/package.json
		// (contributes.configuration) — that duplicate is removed; core
		// is the canonical home per this file's migration decision
		// (settings moved from package.json into core; sibling
		// `ide.agent.continueInterruptedAgents` above lives only here).
		// Description is the binary/live-verbatim one (Cursor Settings ›
		// General › Notifications › "Completion Sound", default OFF;
		// binary key cursor.composer.shouldChimeAfterChatFinishes).
		// Readers (extension chime hooks + core chime.ts) resolve the key
		// through the configuration service either way, so behavior is
		// unchanged: default false, finish/attention hooks untouched.
		'ide.composer.shouldChimeAfterChatFinishes': {
			type: 'boolean',
			default: false,
			description: localize('composer.configuration.ide.composer.shouldChimeAfterChatFinishes', 'Play a sound when agents finish or need attention.')
		},
		// GAPS-152 (agent-notification-actions): Cursor's "System
		// Notifications" toggle (Settings › Notifications; binary
		// workbench.desktop.main.js 3.25.9 @37564909 — description verbatim
		// "Show system notifications when Agent completes or needs
		// attention"). The binary stores it as the persistent-storage key
		// `systemNotificationsEnabled`, gated everywhere as
		// `systemNotificationsEnabled ?? !1` — DEFAULT OFF (desk@31367250).
		// The fork's analog is this config key, read by the ide-agent
		// notification producers (completed turn + pending decision).
		'ide.composer.systemNotificationsEnabled': {
			type: 'boolean',
			default: false,
			description: localize('composer.configuration.ide.composer.systemNotificationsEnabled', 'Show system notifications when Agent completes or needs attention.')
		},
		// DEV-GAPS-85: SINGLE registration for this key — same dedupe as
		// `ide.composer.shouldChimeAfterChatFinishes` above (DEV-GAPS-81).
		// It was also declared in extensions/ide-agent/package.json
		// (contributes.configuration, "IDE Composer" section) — that
		// duplicate is removed; core is the canonical home per this
		// file's migration decision. Description adopts the package.json
		// wording where it was more accurate ("default chime", not
		// "default sound"); no binary-verbatim description for this key
		// is on record. Behavior unchanged: type string, default '',
		// and the package.json scope ("window") matches core's platform
		// default scope (WINDOW). Readers (extension composerDataService
		// afterTurnCompleted + extension.ts attention chime; core
		// composerDataService afterTurnCompleted) resolve the key through
		// the configuration service either way.
		'ide.composer.customChimeSoundPath': {
			type: 'string',
			default: '',
			description: localize('composer.configuration.ide.composer.customChimeSoundPath', 'Path to a custom sound file (mp3, wav, ogg) to play when the agent finishes responding. Leave empty to use the default chime. Mirrors cursor.composer.customChimeSoundPath.')
		},
		'ide.agent.terminal.notifyOnApproval': {
			type: 'boolean',
			default: true,
			description: localize('composer.configuration.ide.agent.terminal.notifyOnApproval', 'Show an OS-level notification when the agent needs tool approval while the IDE window is in the background.')
		},
		'ide.general.privacyMode': {
			type: 'boolean',
			default: true,
			description: localize('composer.configuration.ide.general.privacyMode', 'Privacy Mode: disable telemetry and keep all processing local. IDE Code is local-first, so this is on by default.')
		},
		'ide.general.leakDetectionEnabled': {
			type: 'boolean',
			default: true,
			description: localize('composer.configuration.ide.general.leakDetectionEnabled', 'Warn before sending a chat message that looks like it contains a secret (API keys, tokens, private keys).')
		},
		'ide.general.globalCursorIgnoreList': {
			type: 'array',
			default: [],
			items: {
					'type': 'string'
				},
			description: localize('composer.configuration.ide.general.globalCursorIgnoreList', 'Global list of files to always ignore in IDE features, across all workspaces. Glob patterns — same effect as adding them to a .cursorignore file in every workspace. Mirrors cursor.general.globalCursorIgnoreList.')
		},
		'ide.general.fontSmoothingAntialiased': {
			type: 'boolean',
			default: true,
			description: localize('composer.configuration.ide.general.fontSmoothingAntialiased', 'Use grayscale antialiased text rendering in the chat view for thinner, crisper text. Mirrors cursor.general.fontSmoothingAntialiased_v2.')
		},
		'ide.composer.cmdPFilePicker2': {
			type: 'boolean',
			default: true,
			description: localize('composer.configuration.ide.composer.cmdPFilePicker2', 'Enable Cmd+P / Ctrl+P shortcut for the file picker in the chat input. Mirrors cursor.composer.cmdPFilePicker2.')
		},
		'ide.general.glassShowWarningNotifications': {
			type: 'boolean',
			default: false,
			description: localize('composer.configuration.ide.general.glassShowWarningNotifications', 'Show notifications for less urgent issues. Mirrors cursor.general.glassShowWarningNotifications (Cursor "Warning Notifications"). Default: our choice; Cursor canonical default UNKNOWN.')
		},
		'ide.general.reduceTransparency': {
			type: 'boolean',
			default: false,
			description: localize('composer.configuration.ide.general.reduceTransparency', 'Replace translucent surfaces with opaque backgrounds. Mirrors cursor.general.reduceTransparency (Cursor "Reduce Transparency"). Default: our choice; Cursor canonical default UNKNOWN.')
		},
		'ide.general.indexRepositoriesForInstantGrep': {
			type: 'boolean',
			default: true,
			description: localize('composer.configuration.ide.general.indexRepositoriesForInstantGrep', 'Automatically index repositories to speed up Grep searches. All data is stored locally. Mirrors cursor.general.indexRepositoriesForInstantGrep (Cursor "Index Repositories for Instant Grep"). Default: our choice; Cursor canonical default UNKNOWN.')
		},
		'ide.general.disableHttp2': {
			type: 'boolean',
			default: false,
			description: localize('composer.configuration.ide.general.disableHttp2', 'Disable HTTP/2 (fall back to HTTP/1.1). Part of Cursor\'s HTTP Compatibility Mode. Mirrors cursor.general.disableHttp2. Default: our choice; Cursor canonical default UNKNOWN.')
		},
		'ide.general.disableHttp1SSE': {
			type: 'boolean',
			default: false,
			description: localize('composer.configuration.ide.general.disableHttp1SSE', 'Disable HTTP/1 SSE transport. Part of Cursor\'s HTTP Compatibility Mode. Mirrors cursor.general.disableHttp1SSE. Default: our choice; Cursor canonical default UNKNOWN.')
		},
		'ide.general.emailPrivacyEnabled': {
			type: 'boolean',
			default: true,
			description: localize('composer.configuration.ide.general.emailPrivacyEnabled', 'Enable email privacy protections. Mirrors cursor.general.emailPrivacyEnabled. Default: our choice; Cursor canonical default UNKNOWN.')
		},
		'ide.general.gitGraphIndexing': {
			type: 'boolean',
			default: true,
			description: localize('composer.configuration.ide.general.gitGraphIndexing', 'Enable git graph indexing for code intelligence. Mirrors cursor.general.gitGraphIndexing. Default: our choice; Cursor canonical default UNKNOWN.')
		},
		'ide.general.pinnedTitleActions': {
			type: 'boolean',
			default: true,
			description: localize('composer.configuration.ide.general.pinnedTitleActions', 'Show pinned title bar actions. Mirrors cursor.general.pinnedTitleActions. Default: our choice; Cursor canonical default UNKNOWN.')
		},
		// WORKER-GAPS-24C (Cursor 3.25.6 binary evidence,
		// workbench.glass.main.js): config key
		// `cursor.composer.editorConversationDensity` ("Controls how shell
		// and edit-file tool calls are displayed and grouped in Editor Agent
		// conversations."), canonical default "detailed". Edited in Cursor
		// via the "Conversation Density" entry ("Choose how much detail
		// Agent tool calls show in the conversation") in the settings
		// layout section. enumDescriptions VERBATIM from
		// cursor.com/changelog/page/7 ("Compact chat responses").
		'ide.composer.editorConversationDensity': {
			type: 'string',
			enum: [ 'compact-all-grouped', 'compact-ungrouped', 'detailed' ],
			enumDescriptions: [
				localize('composer.configuration.ide.composer.editorConversationDensity.compact', 'Compact: shows concise results with minimal tool traces'),
				localize('composer.configuration.ide.composer.editorConversationDensity.balanced', 'Balanced: includes important intermediate steps'),
				localize('composer.configuration.ide.composer.editorConversationDensity.detailed', 'Detailed: provides near-complete step-by-step context')
			],
			default: 'detailed',
			description: localize('composer.configuration.ide.composer.editorConversationDensity', 'Controls how shell and edit-file tool calls are displayed and grouped in Editor Agent conversations. Mirrors cursor.composer.editorConversationDensity.')
		},
		'ide.composer.planTextSizeScale': {
			type: 'number',
			default: 1,
			description: localize('composer.configuration.ide.composer.planTextSizeScale', 'Text size scale for plan mode display. Mirrors cursor.composer.planTextSizeScale. Default: our choice; Cursor canonical default UNKNOWN.')
		},
		'ide.composer.queueManualSendBehavior2': {
			type: 'string',
			enum: [ 'send', 'stop-and-send', 'queue' ],
			default: 'stop-and-send',
			description: localize('composer.configuration.ide.composer.queueManualSendBehavior2', 'Updated behavior of manually sending a message while the agent is streaming. Mirrors cursor.composer.queueManualSendBehavior2. Default: our choice; Cursor canonical default UNKNOWN.')
		},
		'ide.composer.shouldShowMarkdownHoverParticipantActions2': {
			type: 'boolean',
			default: true,
			description: localize('composer.configuration.ide.composer.shouldShowMarkdownHoverParticipantActions2', 'Show participant actions on markdown hover. Mirrors cursor.composer.shouldShowMarkdownHoverParticipantActions2. Default: our choice; Cursor canonical default UNKNOWN.')
		},
		'ide.composer.usageSummaryDisplay': {
			type: 'string',
			enum: [ 'detailed', 'compact', 'hidden' ],
			default: 'detailed',
			description: localize('composer.configuration.ide.composer.usageSummaryDisplay', 'How the usage summary is displayed in chat. Mirrors cursor.composer.usageSummaryDisplay. Default: our choice; Cursor canonical default UNKNOWN.')
		},
		// DEV-GAPS-9B: gate for the `glass.openChangesTab` Changes tab.
		// Cursor gates its new-tab-model "changes" action on a `showChangesAction`
		// flag whose semantics are UNKNOWN (binary shows the gate, not its
		// source). Ours is an explicit user-facing setting, default on.
		'composer.changesTab.enabled': {
			type: 'boolean',
			default: true,
			description: localize('composer.configuration.composer.changesTab.enabled', 'Show the Changes tab action (command composer.openChangesTab) in the command palette. Cursor gates this on a showChangesAction flag of unknown semantics; this setting is our explicit equivalent.')
		},
		// DEV-GAPS-53 (inline-diff-performance-protection, Cursor 3.25.9
		// binary evidence, workbench.glass.main.js): config key
		// `cursor.inlineDiff.enablePerformanceProtection` (default true),
		// section `general`: "Enable performance protection for inline
		// diffs. When enabled, inline diff decorations will be suppressed if
		// there are too many changes to prevent editor unresponsiveness."
		'ide.inlineDiff.enablePerformanceProtection': {
			type: 'boolean',
			default: true,
			description: localize('composer.configuration.ide.inlineDiff.enablePerformanceProtection', 'Enable performance protection for inline diffs. When enabled, inline diff decorations will be suppressed if there are too many changes to prevent editor unresponsiveness. Mirrors cursor.inlineDiff.enablePerformanceProtection.')
		},
		// DEV-GAPS-53: Cursor's `inline_diff_performance_config.maxDecorations`
		// (default 100) — the change-count limit above which the protection
		// suppresses inline-diff decorations.
		'ide.inlineDiff.maxDecorations': {
			type: 'number',
			default: 100,
			minimum: 1,
			description: localize('composer.configuration.ide.inlineDiff.maxDecorations', 'Maximum number of inline diff changes rendered before performance protection suppresses the decorations. Mirrors cursor inline_diff_performance_config.maxDecorations.')
		},
	}
});

// --- IDE Code › Appearance (5 properties) ---
configurationRegistry.registerConfiguration({
	id: 'ideCode.ide-code.appearance',
	title: 'IDE Code › Appearance',
	type: 'object',
	properties: {
		// WORKER-GAPS-24C (Cursor 3.25.6 binary evidence,
		// workbench.glass.main.js):
		//  - config key: `cursor.composer.conversationDensity`
		//    ("Controls how shell and edit-file tool calls are displayed and
		//    grouped in Glass Agent conversations."), default
		//    "compact-all-grouped" (Compact)
		//  - glass settings UI: Settings → Appearance → "Agent Conversations"
		//    section → "Tool Call Density" entry ("Adjust how much detail is
		//    shown for tool calls"), dropdown Compact / Balanced / Detailed.
		//    Placed in this Appearance section to mirror Cursor.
		//  - enum values: "compact-all-grouped" (Compact),
		//    "compact-ungrouped" (Balanced), "detailed" (Detailed).
		//  - enumDescriptions below are VERBATIM from
		//    cursor.com/changelog/page/7 ("Compact chat responses").
		'ide.composer.conversationDensity': {
			type: 'string',
			enum: [ 'compact-all-grouped', 'compact-ungrouped', 'detailed' ],
			enumDescriptions: [
				localize('composer.configuration.ide.composer.conversationDensity.compact', 'Compact: shows concise results with minimal tool traces'),
				localize('composer.configuration.ide.composer.conversationDensity.balanced', 'Balanced: includes important intermediate steps'),
				localize('composer.configuration.ide.composer.conversationDensity.detailed', 'Detailed: provides near-complete step-by-step context')
			],
			default: 'compact-all-grouped',
			description: localize('composer.configuration.ide.composer.conversationDensity', 'Tool Call Density: controls how shell and edit-file tool calls are displayed and grouped in agent conversations. Change it in Settings › IDE Code › Appearance (Cursor: Settings › Appearance › Agent Conversations › Tool Call Density). Mirrors cursor.composer.conversationDensity.')
		},
		'ide.composer.textSizeScale': {
			type: 'number',
			enum: [ 0.85, 1, 1.15, 1.3 ],
			default: 1,
			description: localize('composer.configuration.ide.composer.textSizeScale', 'Text size scale (relative to base) of AI chat messages. Mirrors cursor.composer.textSizeScale.')
		},
		'ide.composer.codeBlockWordWrap': {
			type: 'boolean',
			default: false,
			description: localize('composer.configuration.ide.composer.codeBlockWordWrap', 'Wrap long lines in agent chat code blocks. Mirrors cursor.composer.codeBlockWordWrap.')
		},
		'ide.cmdk.useThemedDiffBackground': {
			type: 'boolean',
			default: true,
			description: localize('composer.configuration.ide.cmdk.useThemedDiffBackground', 'Use themed background colors for inline diffs. Mirrors cursor.cmdk.useThemedDiffBackground2.')
		},
		// CHAT-WIDTH (binary evidence, Cursor 3.25.9 workbench.glass.main.js,
		// AppearanceSettings.js): QKe={label:"Chat Width",
		//   description:"Set the maximum width of Agent conversations",
		//   searchAliases:["chat width","max width","conversation width",
		//   "wide","narrow","tables","chatMaxWidth"]}
		// Docs (cursor.com/docs/release-notes): "A new Chat Width slider in
		// Settings > Appearance > Agent Conversations sets how wide agent
		// conversations can grow, from Narrow to Wide (600 to 1600px).
		// Widen it to give tables and code more room, or narrow it for
		// easier reading."
		// UNKNOWN: the binary/docs do not reveal the canonical default —
		// default 900px is OUR CHOICE. The binary property id is not visible
		// in the minified bundle; "chatMaxWidth" comes from the binary's own
		// searchAliases. VS Code's configuration schema has no
		// "searchAliases" field, so the alias keywords are folded into the
		// description (Settings search matches description text).
		'ide.composer.chatMaxWidth': {
			type: 'number',
			default: 900,
			minimum: 600,
			maximum: 1600,
			description: localize('composer.configuration.ide.composer.chatMaxWidth', 'Chat Width: set the maximum width of Agent conversations, from Narrow (600px) to Wide (1600px). Widen it to give tables and code more room, or narrow it for easier reading. Mirrors cursor.composer.chatMaxWidth. Default 900px is our choice; Cursor canonical default UNKNOWN.')
		},
	}
});

// --- IDE Code › Agents (9 properties) ---
configurationRegistry.registerConfiguration({
	id: 'ideCode.ide-code.agents',
	title: 'IDE Code › Agents',
	type: 'object',
	properties: {
		'ide.composer.runMode': {
			type: 'string',
			enum: [ 'autoReview', 'allowlist', 'runEverything' ],
			default: 'autoReview',
			description: localize('composer.configuration.ide.composer.runMode', 'Agent tool approval mode (Cursor\'s Run Modes). autoReview: ask before each tool call. allowlist: auto-approve safe read-only tools (read, grep, web search...), ask for the rest. runEverything: approve everything without asking — use with care.')
		},
		'ide.agent.smart_mode_classifier_shadow_mode': {
			type: 'boolean',
			default: false,
			description: localize('composer.configuration.ide.agent.smart_mode_classifier_shadow_mode', 'Approval shadow mode (Cursor\'s `smart_mode_classifier_shadow_mode` concept): approval evaluation runs and is logged but does not enforce — approvals auto-resolve as approve-once so turns are never blocked. For evaluation only. HONEST-DIVERGENCE: in Cursor this is a server-controlled feature flag plus an aiserver protocol field (workbench.glass.main.js 3.25.9 offsets 984622, 37516979), not a local config key; here it is a local toggle.'),
			scope: ConfigurationScope.MACHINE
		},
		// DEV-GAPS-10 (agent-git-branch-reminder): Cursor featureFlags.enableTrackedGitRepoState parity.
		'ide.agent.enableTrackedGitRepoState': {
			type: 'boolean',
			default: true,
			description: localize('composer.configuration.ide.agent.enableTrackedGitRepoState', 'Track the workspace git repo\'s current branch during agent turns. When the branch changes mid-turn, a system reminder ("Branch changed from X to Y") is injected into the conversation (Cursor featureFlags.enableTrackedGitRepoState parity).')
		},
		'ide.agent.fallbackModels': {
			type: 'array',
			default: [],
			items: {
					'type': 'string'
				},
			description: localize('composer.configuration.ide.agent.fallbackModels', 'Fallback models for DD-AR-6 (InferenceProviderWarning ON_ERROR parity): on a 429/rate-limit from the engine the adapter warns and switches to the first entry. Entries are "providerID/modelId". HONEST-DIVERGENCE: Cursor\'s fallback_models list is server-driven (AvailableModelsResponse.FeatureModelConfig); our engine declares none, so this client-side list is used until the engine declares its own.'),
			scope: ConfigurationScope.MACHINE
		},
		'ide.composer.queueMessageDefaultBehavior': {
			type: 'string',
			enum: [ 'send', 'stop-and-send', 'queue' ],
			default: 'send',
			description: localize('composer.configuration.ide.composer.queueMessageDefaultBehavior', 'Default behavior of sending a message (Enter) while the agent is streaming. send: deliver at the next opportune time. stop-and-send: stop the agent immediately and send. queue: queue after the current turn finishes. Mirrors cursor.composer.queueMessageDefaultBehavior.')
		},
		'ide.composer.queueManualSendBehavior': {
			type: 'string',
			enum: [ 'send', 'stop-and-send', 'queue' ],
			default: 'stop-and-send',
			description: localize('composer.configuration.ide.composer.queueManualSendBehavior', 'Behavior of manually sending a message (Send button / Cmd+Enter) while the agent is streaming. Mirrors cursor.composer.queueManualSendBehavior.')
		},
		'ide.composer.shouldAutoSaveNonAgent': {
			type: 'boolean',
			default: true,
			description: localize('composer.configuration.ide.composer.shouldAutoSaveNonAgent', 'Automatically save open files when a chat turn completes. Mirrors cursor.composer.shouldAutoSaveNonAgent.')
		},
		'ide.agent.terminal.enableAiChecks': {
			type: 'boolean',
			default: true,
			description: localize('composer.configuration.ide.agent.terminal.enableAiChecks', 'Allow AI features (@Terminal mentions, the terminal Cmd+K prompt) to read terminal output. Mirrors Cursor\'s terminal.enableAiChecks.'),
			scope: ConfigurationScope.WINDOW
		},
		'ide.agent.terminal.maxBufferChars': {
			type: 'number',
			default: 20000,
			description: localize('composer.configuration.ide.agent.terminal.maxBufferChars', 'Maximum characters of terminal output attached as chat context by @Terminal.'),
			scope: ConfigurationScope.WINDOW
		},
		'ide.terminal.toolbarOnSelection': {
			type: 'boolean',
			default: true,
			description: localize('composer.configuration.ide.terminal.toolbarOnSelection', 'Show the Add to Chat button when selecting text in the terminal.'),
			scope: ConfigurationScope.WINDOW
		},
		'ide.terminal.usePreviewBox': {
			type: 'boolean',
			default: false,
			description: localize('composer.configuration.ide.terminal.usePreviewBox', 'Use the preview box instead of shell streaming for Terminal Cmd/Ctrl+K. Mirrors cursor.terminal.usePreviewBox (Cursor "Preview Box for Terminal Cmd/Ctrl+K"). Default: our choice; Cursor canonical default UNKNOWN.'),
			scope: ConfigurationScope.WINDOW
		},
		// GAPS-142 (settings-terminal-hint): Cursor 3.25.9 evidence,
		// self-verified in workbench.desktop.main.js — settings registry
		// @37340021 `hl("chat","terminal-hint",{label:"Terminal Hint",
		// surface:"ide",description:"Show the Cmd/Ctrl+K hint in Terminal"})`.
		// Cursor backs the entry with the reactive storage key
		// `hideTerminalTooltip` (settings control @37442481; selector
		// @37443354 `e.hideTerminalTooltip===!1`): the hint renders only
		// when that value is exactly false, and with no initializer in the
		// bundle the unset state is OFF — so this positive fork key
		// defaults to false, which reproduces Cursor's visible behavior in
		// every state (unset/off → hidden, on → shown). Consumer: the
		// workbench-core terminal contribution in
		// contrib/terminalContrib/promptBarHint (pure logic + evidence in
		// its common/terminalPromptBarHint.ts).
		'ide.terminal.showCmdkHint': {
			type: 'boolean',
			default: false,
			description: localize('composer.configuration.ide.terminal.showCmdkHint', 'Show the Cmd/Ctrl+K hint in Terminal. Mirrors Cursor\'s "Terminal Hint" setting (chat/terminal-hint, storage hideTerminalTooltip === false). In Cursor the hint is off until enabled, so this defaults to false.'),
			scope: ConfigurationScope.WINDOW
		},
	}
});

// NOTE (W-DEV1, 2026-10-20): the `composer.sandbox.debugLogging` configuration
// that DEV-GAPS-9A registered here has been REMOVED. Cursor 3.25.9 implements
// `composer.toggleSandboxDebugLogging` against the storage key
// `sandboxDebugOutputDir` (workbench.desktop.main.js @29974171) — there is no
// such configuration key in Cursor, and nothing in the fork ever read this
// config (the extension flag is driven by the `ide.toggleSandboxDebugLogging`
// bridge instead). Do not re-add it; see ComposerToggleSandboxDebugLoggingAction
// in browser/composerActions.ts.

// --- IDE Code › Models (4 properties) ---
configurationRegistry.registerConfiguration({
	id: 'ideCode.ide-code.models',
	title: 'IDE Code › Models',
	type: 'object',
	properties: {
		'ide.agent.enabledModels': {
			type: 'array',
			default: [],
			items: {
					'type': 'string'
				},
			description: localize('composer.configuration.ide.agent.enabledModels', 'Models enabled for agent turns, as "providerID/modelID[#variant]" entries (see IDE Agent: Manage Models…). Empty (default) = every model the engine reports is enabled. Non-empty = exact allowlist: only listed models appear in the picker and the model cycler. Manage via the "IDE Agent: Manage Models…" command instead of editing raw strings.'),
			scope: ConfigurationScope.WINDOW
		},
		'ide.agent.engineMode': {
			type: 'string',
			enum: [ 'stub', 'sidecar' ],
			default: 'sidecar',
			description: localize('composer.configuration.ide.agent.engineMode', 'Agent engine backend: \'stub\' runs the scripted demo engine, \'sidecar\' spawns the real ide-code engine as a sidecar process.'),
			scope: ConfigurationScope.MACHINE
		},
		'ide.agent.enginePath': {
			type: 'string',
			default: '',
			description: localize('composer.configuration.ide.agent.enginePath', 'Path to the ide-code engine checkout (empty = auto-detect ~/workspace/ide-code). Used when ide.agent.engineMode is \'sidecar\'.'),
			scope: ConfigurationScope.MACHINE
		},
		// DEV-GAPS-9B: backing store for the `cursor.selectBackend` switcher.
		// HONEST-DIVERGENCE: Cursor's canonical backend list is server-driven
		// (binary evidence covers only the switcher UI: command
		// `cursor.selectBackend` titled "Select Backend Server", status bar
		// `Server: ${name}`). Our product is local-first, so configured
		// backends are an explicit local list appended after the built-in
		// "Local Engine (sidecar)". Entries may be plain name strings or
		// objects with name/id/url fields.
		'ide.agent.backendServers': {
			type: 'array',
			default: [],
			description: localize('composer.configuration.ide.agent.backendServers', 'Additional backend servers offered by the "Select Backend Server" command (cursor.selectBackend), after the built-in Local Engine (sidecar). Entries may be plain name strings or objects with name/id/url fields.'),
			scope: ConfigurationScope.MACHINE
		},
		'ide.debug.ndjsonPort': {
			type: 'number',
			default: 0,
			description: localize('composer.configuration.ide.debug.ndjsonPort', 'Port for the Debug-mode NDJSON log ingest server (0 = auto-allocate in 7242–7942, mirroring Cursor\'s cursor-ndjson-ingest).'),
			// DEV-GAPS-54A: scope WINDOW, not MACHINE. Binary evidence:
			// Cursor's debug-server failure UI links to
			// workbench.action.openWorkspaceSettings?["ndjson.port"]
			// (workbench.desktop.main.js @31596778, glass @40014061) — the
			// Workspace settings editor, where a MACHINE-scoped setting is not
			// editable. The binary never declares a scope for ndjson.port, so it
			// takes the platform default: WINDOW
			// (configurationRegistry.ts:846 validateAndRegisterProperties default).
			scope: ConfigurationScope.WINDOW
		},
		'ide.composer.subagentModel': {
			type: 'string',
			default: '',
			description: localize('composer.configuration.ide.composer.subagentModel', 'Choose the model used by Explore subagent for initial research. Empty = use default. Mirrors cursor.composer.subagentModel (Cursor "Explore Subagent Model").'),
			scope: ConfigurationScope.WINDOW
		},
	}
});

// --- IDE Code › Customize (1 properties) ---
configurationRegistry.registerConfiguration({
	id: 'ideCode.ide-code.customize',
	title: 'IDE Code › Customize',
	type: 'object',
	properties: {
		'ide.customize.migrationBanner': {
			type: 'boolean',
			default: true,
			description: localize('composer.configuration.ide.customize.migrationBanner', 'Show the "Plugins, MCPs, Skills, and Rules have moved to Customize" migration banner (Settings > General only).'),
			markdownDescription: localize('composer.configuration.ide.customize.migrationBanner.md', 'Show the "Plugins, MCPs, Skills, and Rules have moved to Customize" migration banner in Settings > General (General only — never on other sections). [Open the Customize view](command:ide.openCustomize).')
		},
	}
});

// --- IDE Code › Voice (1 property) ---
// WORKER-GAPS-54C: binary-verbatim config key (Cursor 3.25.9 config registry:
// `voiceInputLanguage:pbe(ywt,-1,0)`, ywt="" — read by the voice input service
// as `ph(storageService,"voiceInputLanguage")`; empty resolves to "auto").
configurationRegistry.registerConfiguration({
	id: 'ideCode.ide-code.voice',
	title: 'IDE Code › Voice',
	type: 'object',
	properties: {
		'voiceInputLanguage': {
			type: 'string',
			default: '',
			description: localize('composer.configuration.voiceInputLanguage', 'Language for composer voice dictation (empty = auto-detect). Mirrors Cursor\'s voiceInputLanguage.'),
			scope: ConfigurationScope.APPLICATION
		},
	}
});
// --- IDE Code › Browser & Network (2 properties) ---
configurationRegistry.registerConfiguration({
	id: 'ideCode.ide-code.browser-network',
	title: 'IDE Code › Browser & Network',
	type: 'object',
	properties: {
		'ide.browser.chromiumPath': {
			type: 'string',
			default: '',
			description: localize('composer.configuration.ide.browser.chromiumPath', 'Path to a Chrome/Chromium (or chrome-headless-shell) executable used by the in-IDE browser tab. When empty, well-known install locations are probed.'),
			// DEV-GAPS-93E (settings-network-diagnostics): Cursor's Browser
			// & Network settings page carries a "Network" section with
			// "Required Domains" and a "Network Diagnostics" entry
			// (description "Check network connectivity to all Cursor
			// services", button "Run Diagnostic" — Cursor 3.25.9
			// workbench.desktop.main.js @37493361). This fork's settings
			// page is the configuration registry, so the entry is surfaced
			// as command links here (same precedent as the Customize
			// migration banner → ide.openCustomize above).
			markdownDescription: localize('composer.configuration.ide.browser.chromiumPath.md', 'Path to a Chrome/Chromium (or chrome-headless-shell) executable used by the in-IDE browser tab. When empty, well-known install locations are probed.\n\n**Network Diagnostics** — Check network connectivity to all Cursor services. [Run Diagnostic](command:ide.runNetworkDiagnostics)\n\n**Required Domains** — api2.cursor.sh, api3.cursor.sh, api4.cursor.sh, *.api5.cursor.sh, repo42.cursor.sh, *.authentication.cursor.sh, authenticator.cursor.sh, marketplace.cursorapi.com, cursor-cdn.com, downloads.cursor.com. [Copy Domains](command:ide.copyNetworkRequiredDomains)')
		},
		// DEV-GAPS-147 (settings-open-local-links): Cursor 3.25.9 evidence,
		// self-verified in workbench.desktop.main.js (glass identical) —
		// Settings › Browser entry "Open Local Links in Cursor Browser",
		// description "Automatically open localhost links in the Browser
		// Tab" VERBATIM (settings-search row `setting:browser:
		// show-localhost-links` @37322502; settings UI entry @37476953).
		// Cursor stores this as the reactive storage preference
		// `autoOpenLocalhostUrls:Jh(!0,-1,0)` (@14326223; physical key
		// `cursor/autoOpenLocalhostUrls`, storageScope -1 = APPLICATION,
		// storageTarget 0 = USER), NOT a configuration property; per the
		// fork precedent for such settings (ide.window.autoHideEditor
		// WhenEmpty above), this configuration is the fork's settings
		// surface for it — same default (true), same verbatim description,
		// APPLICATION scope matching storageScope -1. The behavior (the
		// OpenerService localhost interceptor, binary @32435883) lives in
		// contrib/browserView/electron-browser/features/
		// openLocalLinksOpener.ts; pure definitions (verbatim `lqt`
		// classifier, `pBn`, `gph`, decision) in
		// contrib/browserView/common/openLocalLinks.ts. The glass-only
		// sibling "Open Web Links in Cursor Browser"
		// (`glassOpenWebLinksInBrowser`, default false) is NOT registered:
		// the fork has no glass surface, so it would be a dead setting.
		'ide.browser.openLocalhostLinks': {
			type: 'boolean',
			default: true,
			description: localize('composer.configuration.ide.browser.openLocalhostLinks', 'Automatically open localhost links in the Browser Tab'),
			scope: ConfigurationScope.APPLICATION
		},
	}
});

// --- IDE Code › Code Intelligence (11 properties) ---
configurationRegistry.registerConfiguration({
	id: 'ideCode.ide-code.code-intelligence',
	title: 'IDE Code › Code Intelligence',
	type: 'object',
	properties: {
		'ide.tab.enabled': {
			type: 'boolean',
			default: true,
			description: localize('composer.configuration.ide.tab.enabled', 'Enable IDE Tab inline completions.')
		},
		'ide.tab.model': {
			type: 'string',
			default: '',
			description: localize('composer.configuration.ide.tab.model', 'Tab model id (empty = server default). Change via the "IDE Agent: Select Tab Model" command or the Tab status bar item.')
		},
		'ide.tab.enablePartialAccepts': {
			type: 'boolean',
			default: true,
			description: localize('composer.configuration.ide.tab.enablePartialAccepts', 'Allow partial (next-word) accepts of Tab completions via Ctrl+Right.')
		},
		'ide.tab.suggestionWhileCommenting': {
			type: 'boolean',
			default: true,
			description: localize('composer.configuration.ide.tab.suggestionWhileCommenting', 'Show Tab suggestions while typing inside comments. When off, no suggestion is offered on comment lines.')
		},
		'ide.tab.ignorePatterns': {
			type: 'array',
			default: [],
			description: localize('composer.configuration.ide.tab.ignorePatterns', 'Glob patterns of files Tab completion ignores (analog of .cursorignore).')
		},
		'ide.tab.disabledLanguages': {
			type: 'array',
			default: [ 'markdown' ],
			description: localize('composer.configuration.ide.tab.disabledLanguages', 'Language IDs where Tab completion is disabled.')
		},
		'ide.tab.maxConcurrentRequests': {
			type: 'number',
			default: 4,
			description: localize('composer.configuration.ide.tab.maxConcurrentRequests', 'Max concurrent in-flight Tab requests; oldest is evicted.')
		},
		'ide.tab.suggestionDelayMs': {
			type: 'number',
			default: 25,
			minimum: 0,
			maximum: 1000,
			description: localize('composer.configuration.ide.tab.suggestionDelayMs', 'Delay in milliseconds before requesting a Tab suggestion after you stop typing.')
		},
		'ide.tab.promptDisableCopilot': {
			type: 'boolean',
			default: true,
			description: localize('composer.configuration.ide.tab.promptDisableCopilot', 'Offer to disable GitHub Copilot on first Tab suggestion.')
		},
		'ide.tab.telemetryEnabled': {
			type: 'boolean',
			default: true,
			description: localize('composer.configuration.ide.tab.telemetryEnabled', 'Record Tab session events and fate locally (privacy gate).')
		},
		// NOTE (ext-global-ignore, WORKER-GAPS-22E 2026-10-20): the earlier
		// `ide.indexing.globalIgnore` key (added by DEV-GAPS-14) was removed.
		// It duplicated `ide.general.globalCursorIgnoreList` above, and its
		// comment wrongly claimed Cursor's canonical key was unknown — the
		// REA evidence (dig-ast-ext-2026-10-19, deep-env-config.md,
		// parity-settings.md, contributes-migration-source.json) identifies
		// it as `cursor.general.globalCursorIgnoreList`, mirrored here as
		// `ide.general.globalCursorIgnoreList`. One key, no duplicates.
	}
});