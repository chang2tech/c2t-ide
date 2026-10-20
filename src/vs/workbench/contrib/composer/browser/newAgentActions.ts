/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// IDE-CODE: the New Agent command family — Cursor 3.25.9 parity (WORKER-GAPS-22A,
// auditor run 30, 2026-10-20).
//
// Binary evidence (workbench.glass.main.js 3.25.9, byte offsets verified by
// direct reads — do NOT "fix" these from memory):
// - `newAgent` @45354742:
//   `Ir({id:"newAgent",title:"New Agent",icon:"agent",glassCategory:"Agent",
//   f1:!0,keybindingCommandId:pJg,run:async(t,...e)=>{...}})`
//   where `pJg="glass.newAgentFromKeyboard"` (menubar list PEd uses the same
//   `glass.`-prefixed ids). Run: trackEvent("agent_layout.new_agent_clicked",
//   {source: n?.source ?? "command_palette"}); if args[0].cloudRepoUrls is an
//   array -> emit newAgentWithCloudTargetRequested; else if args[0].folderUri
//   is a non-empty file-scheme string -> resolve the single-folder workspace
//   identifier and emit newAgentWithWorkspaceTargetRequested (with
//   presentation "picker-with-files" when source==="cli"); else emit
//   newAgentRequested.
// - `newAgentFromKeyboard` @45356179:
//   `Ir({id:p$l /* "newAgentFromKeyboard" */,title:"New Agent",icon:"agent",
//   f1:!1,keybindingCategory:Sa.GENERAL,
//   keybinding:{weight:yk,primary:dt.CtrlCmd|Xe.KeyN},   // yk=250, NO when
//   menu:{column:Nt.MenubarFileMenu,group:"1_new",order:0,title:"New Agent"},
//   run:t=>{trackEvent(...,{source:"keyboard_shortcut",keybinding:"Ctrl+N"}),
//   emit newAgentRequested}})`
// - `newAgentKeepPaneFromKeyboard` @45356565:
//   `Ir({id:"newAgentKeepPaneFromKeyboard",
//   title:"New Agent (preserve editor panel)",icon:"agent",f1:!1,
//   keybindingCategory:Sa.GENERAL,
//   keybinding:{weight:yk,primary:dt.CtrlCmd|dt.Alt|Xe.KeyN},  // NO when
//   run:t=>{trackEvent(...,{source:"keyboard_shortcut",keybinding:"Ctrl+Alt+N"}),
//   emit newAgentRequested with payload {shouldOpenEditorPanel:!0}}})`
// - `newAgentWithModel` @45358929:
//   `Ir({id:"newAgentWithModel",title:"New Agent with Model",icon:"sparkle",
//   glassCategory:"Agent",
//   run:(t,e)=>{typeof e!="string"||e.trim().length===0||XQb(t,{modelId:e})}})`
//   (no f1 -> palette-visible; no keybinding). XQb: emit newAgentRequested,
//   then resolveModelParametersForSubmission(modelId, parameters, maxMode)
//   and setModelConfigForComposer({selectedModels:[{modelId, parameters}]},
//   updateGlobalConfig:!0), incrementModelVersion.
// - `newAgentWithContext` @45477543:
//   `Ir({id:lWl /* "newAgentWithContext" */,title:"New Agent with Context",
//   icon:"sparkle",f1:!1,hidden:!0,scope:wl.AGENT_WORKSPACE,
//   keybinding:{weight:1602,primary:dt.CtrlCmd|dt.Shift|Xe.KeyL,
//   secondary:[dt.CtrlCmd|dt.Shift|Xe.KeyI],
//   when:ft.or(cf.isEqualTo(Ot.File),cf.isEqualTo(Ot.Terminal),
//   ft.and(ft.or(cf.isEqualTo(Ot.Diff),cf.isEqualTo(Ot.Pr)),ZDi))},
//   run:async(t,e)=>{...trackEvent(...,{source:"keyboard_shortcut",
//   keybinding:"Ctrl+Shift+L"}),
//   emit newAgentWithContextRequested with {mentions: args??auto-gathered,
//   sourceAgentId: activeAgentId?}}})`
//   (`cf` = the "glassActiveTabKind" context key; `ZDi` =
//   "glassDiffLineSelectionActive".)
//
// SEPARATE COMMAND (do NOT merge): "New Chat Tab" (class Q_e, f1:!0, icon
// add, Ctrl+T @600 / Ctrl+N @600 with chat-surface when-clauses) is a
// DIFFERENT binary command that opens a tab in the agents pane / chat editor
// surface. This file is the Ir `newAgent*` family only (the glass event-bus
// `newAgentRequested` / `newAgentWithContextRequested` emitters).
//
// FAITHFUL-PORT NOTES (verified against this fork's sources):
// - Command ids: Cursor's Ir auto-prefixes plain ids with `glass.` (the
//   menubar list PEd and keybindingCommandId:pJg both reference
//   `glass.newAgentFromKeyboard` while Ir registered `newAgentFromKeyboard`).
//   The fork registers the effective ids verbatim — `glass.newAgent`,
//   `glass.newAgentFromKeyboard`, `glass.newAgentKeepPaneFromKeyboard`,
//   `glass.newAgentWithModel`, `glass.newAgentWithContext` — the same
//   precedent as `glass.enterEditorPanelFullscreen` (WORKER-GAPS-20C).
// - `keybindingCommandId` (binary `newAgent` -> `glass.newAgentFromKeyboard`):
//   VS Code's `IAction2Options` has NO such field (verified: only occurrence
//   in this fork's src is this comment). The Ctrl+N binding lives on
//   `glass.newAgentFromKeyboard` verbatim, so the palette entry's chord is
//   shown through the normal Keyboard Shortcuts resolution instead.
// - `keybindingCategory: Sa.GENERAL` (binary, both keyboard variants): VS
//   Code's `IKeybindingRule` has NO `keybindingCategory` field (same as
//   `Sa.EDITOR_PANEL` on the fullscreen commands — documented, not portable).
// - Category: binary `glassCategory:"Agent"` is ported verbatim as the
//   palette category "Agent" for the two f1-visible commands (this is a
//   deliberate Cursor-parity choice, NOT the fork's usual "Composer"
//   category).
// - Icons: binary icon ids "agent"/"sparkle" map to the fork's
//   `Codicon.agent` (codiconsLibrary.ts:627) / `Codicon.sparkle`
//   (codiconsLibrary.ts:538) — same codicon names, verbatim.
// - `hidden:!0` (binary `newAgentWithContext`): VS Code's `IAction2Options`
//   has no `hidden` field; f1:false keeps it out of the command palette and
//   no menu items are registered for it, which is the faithful equivalent.
// - `scope:wl.AGENT_WORKSPACE` (binary `newAgentWithContext`): Cursor-only
//   command scope; no VS Code analog. Documented, not ported.
// - Weights: binary `yk` = 250 (single def @45343380) =
//   `KeybindingWeight.SessionsContrib` (keybindingsRegistry.ts:66). Binary
//   1602 (`newAgentWithContext`) is above the enum (max 400) and is cast,
//   the same pattern as the 600-weight open-mode-menu port.
// - newAgentWithContext `when` port (`cf` = "glassActiveTabKind"):
//   - `cf.isEqualTo(Ot.File)`      -> `EditorContextKeys.editorTextFocus`
//   - `cf.isEqualTo(Ot.Terminal)`  -> `TerminalContextKeys.focus`
//   - `(cf.isEqualTo(Ot.Diff) || cf.isEqualTo(Ot.Pr)) && ZDi`
//     ("glassDiffLineSelectionActive") ->
//     `EditorContextKeys.inDiffEditor && EditorContextKeys.hasNonEmptySelection`
//     (context-key strings 'inDiffEditor' / 'editorHasSelection'). HONEST
//     DIVERGENCE: the fork has no PR-review-editor context key in core and no
//     glass diff-line-selection key; `inDiffEditor && hasNonEmptySelection`
//     is the closest behavioral equivalent (a selection active inside a diff
//     editor). QA-CATCH (WORKER-GAPS-24A): the first draft used the
//     non-existent `EditorContextKeys.isInDiffEditor` /
//     `EditorContextKeys.editorHasSelection` identifiers — both are
//     `undefined`, so `ContextKeyExpr.and(undefined, undefined)` returned
//     `undefined` and the whole diff branch silently vanished from the
//     when-clause (serialized `when` was just
//     `editorTextFocus || terminalFocus`). Fixed to the real exports.
// - Conflict resolution (binary-verbatim weights do the work, exactly like
//   Cursor):
//   - Ctrl+N: `glass.newAgentFromKeyboard` @250 beats stock
//     `workbench.action.files.newUntitledFile` @200 and the legacy
//     `composer.newAgentChat` Ctrl+N entry @200 — both without `when`
//     clauses. The outcome is the same user-visible action (a new agent
//     tab) as the fork had before; the Cursor-verbatim command now owns
//     the chord, matching the deliberate global override documented in
//     docs/rea/parity-keybindings.md ("The one deliberate global override
//     is Ctrl+N (matches Cursor exactly)").
//   - Ctrl+Alt+N: `glass.newAgentKeepPaneFromKeyboard` @250 beats the
//     legacy `composer.newAgentChat` Ctrl+Alt+N entry @200. The old entry
//     is kept (another worker's command; harmless shadow) — do NOT delete
//     it from composerActions.ts.
//   - Ctrl+Shift+L: binary-verbatim owner is `glass.newAgentWithContext`
//     @1602 (the fork's old mapping of Ctrl+Shift+L -> "New Agent Chat" was
//     wrong per the binary). Where the when-clause holds, the context-
//     seeded variant wins; where it does not (e.g. chat view focused),
//     the legacy `composer.newAgentChat` @200 entry still fires — a new
//     agent tab with no context, graceful degradation, no dead chord.
//   - Ctrl+Shift+I (secondary): `glass.newAgentWithContext` @1602 with the
//     restricted when-clause beats stock
//     `workbench.action.toggleDevTools` @250 (when: IsDevelopmentContext)
//     exactly where Cursor's 1602 beats its 250 — DevTools keeps the chord
//     everywhere else. (The binary's own `toggleDevTools` glass Ir is
//     weight VJi=250 with the same chords — same resolution.)
// - Telemetry: the binary's `trackEvent("agent_layout.new_agent_clicked",
//   {...})` calls have no fork telemetry service; the event name + payload
//   are forwarded as part of the `ide.newAgent` args (`telemetry` field) so
//   the extension can log them to the IDE Agent output channel. No fake
//   analytics — the payload is inspectable in the command args.
// - Run bodies delegate to the ide-agent extension (`ide.newAgent`,
//   `ide.newAgentWithModel`, `ide.addToChat`) via ICommandService — the
//   extension owns the real ChatTabService/engine (same delegation pattern
//   as every other action in composerActions.ts).

import { localize2 } from '../../../../nls.js';
import { KeyCode, KeyMod } from '../../../../base/common/keyCodes.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { ContextKeyExpr } from '../../../../platform/contextkey/common/contextkey.js';
import { Action2, MenuId, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { KeybindingWeight } from '../../../../platform/keybinding/common/keybindingsRegistry.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { EditorContextKeys } from '../../../../editor/common/editorContextKeys.js';
import { TerminalContextKeys } from '../../terminal/common/terminalContextKey.js';

/** Localized "Agent" category — the binary-verbatim `glassCategory:"Agent"`. */
export const AgentActionCategory = localize2('agent.category', 'Agent');

/**
 * WORKER-GAPS-22A: binary `yk` = 250 (single def
 * workbench.glass.main.js @45343380) — the keybinding weight of
 * `newAgentFromKeyboard` and `newAgentKeepPaneFromKeyboard`.
 */
const newAgentKeybindingWeight = KeybindingWeight.SessionsContrib; // 250

/**
 * WORKER-GAPS-22A: binary-verbatim weight 1602 for `newAgentWithContext`
 * (workbench.glass.main.js @45477543). Above the KeybindingWeight enum
 * (max 400 = ExternalExtension); the raw value is cast, the same pattern as
 * the 600-weight `composer.openModeMenu` port. 1602 beats stock
 * `workbench.action.toggleDevTools` (250) and the legacy
 * `composer.newAgentChat` Ctrl+Shift+L entry (200) exactly where the
 * when-clause holds — Cursor's own weight resolution.
 */
const newAgentWithContextKeybindingWeight = 1602 as KeybindingWeight;

/**
 * WORKER-GAPS-22A: `newAgentWithContext` when-clause port.
 * Binary: ft.or(cf.isEqualTo(Ot.File), cf.isEqualTo(Ot.Terminal),
 *   ft.and(ft.or(cf.isEqualTo(Ot.Diff), cf.isEqualTo(Ot.Pr)), ZDi))
 * where `cf` = "glassActiveTabKind" and `ZDi` = "glassDiffLineSelectionActive".
 * Ported term-by-term (see the file docblock for the Diff/Pr honest
 * divergence).
 */
const newAgentWithContextWhen = ContextKeyExpr.or(
	EditorContextKeys.editorTextFocus,
	TerminalContextKeys.focus,
	ContextKeyExpr.and(EditorContextKeys.inDiffEditor, EditorContextKeys.hasNonEmptySelection)
);

/** Payload forwarded to the extension's `ide.newAgent` runtime command. */
export interface NewAgentCommandArgs {
	/** Binary telemetry source: "command_palette" | "keyboard_shortcut" | ... */
	source?: string;
	/** Binary telemetry keybinding label, e.g. "Ctrl+N". */
	keybinding?: string;
	/** Binary branch: args[0].cloudRepoUrls (array) -> cloud-target agent. */
	cloudRepoUrls?: string[];
	/** Binary branch: args[0].folderUri (file-scheme string) -> workspace-target agent. */
	folderUri?: string;
	/** Binary branch: newAgentKeepPaneFromKeyboard payload. */
	shouldOpenEditorPanel?: boolean;
}

/**
 * Sanitize the raw first arg of `glass.newAgent` the way the binary reads it
 * (`n?.source`, `n?.cloudRepoUrls`, `n?.folderUri`): accept only a plain
 * object, keep only the known keys, and only in the right shapes. Anything
 * else -> undefined (plain "new agent" — the binary's default branch).
 */
export function sanitizeNewAgentArgs(raw: unknown): NewAgentCommandArgs | undefined {
	if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
		return undefined;
	}
	const record = raw as Record<string, unknown>;
	const out: NewAgentCommandArgs = {};
	let known = false;
	if (typeof record.source === 'string') {
		out.source = record.source;
		known = true;
	}
	if (typeof record.keybinding === 'string') {
		out.keybinding = record.keybinding;
		known = true;
	}
	if (Array.isArray(record.cloudRepoUrls)) {
		const urls = record.cloudRepoUrls.filter((u): u is string => typeof u === 'string' && u.trim().length > 0);
		if (urls.length > 0) {
			out.cloudRepoUrls = urls;
			known = true;
		}
	}
	if (typeof record.folderUri === 'string' && record.folderUri.length > 0) {
		out.folderUri = record.folderUri;
		known = true;
	}
	if (record.shouldOpenEditorPanel === true) {
		out.shouldOpenEditorPanel = true;
		known = true;
	}
	return known ? out : undefined;
}

export class NewAgentAction extends Action2 {
	static readonly ID = 'glass.newAgent';

	constructor() {
		super({
			id: NewAgentAction.ID,
			// Binary-verbatim: title "New Agent", icon "agent",
			// glassCategory "Agent", f1:!0 (palette-visible).
			title: localize2('glass.newAgent', 'New Agent'),
			icon: Codicon.agent,
			category: AgentActionCategory,
			f1: true,
			// NOTE: binary `keybindingCommandId:pJg` ("glass.newAgentFromKeyboard")
			// has no VS Code `IAction2Options` analog — the Ctrl+N binding is
			// registered verbatim on NewAgentFromKeyboardAction below (where
			// Cursor binds it), so Keyboard Shortcuts resolves the chord the
			// same way.
		});
	}

	async run(accessor: ServicesAccessor, ...args: unknown[]): Promise<void> {
		// Binary run: trackEvent("agent_layout.new_agent_clicked",
		// {source: n?.source ?? "command_palette"}) then the cloudRepoUrls /
		// folderUri / default branches. The telemetry payload travels with
		// the args (the extension logs it); the branches run in the
		// extension's `ide.newAgent` (it owns ChatTabService + workspace).
		const sanitized = sanitizeNewAgentArgs(args[0]);
		await accessor.get(ICommandService).executeCommand(
			'ide.newAgent',
			sanitized ?? { source: 'command_palette' }
		);
	}
}

export class NewAgentFromKeyboardAction extends Action2 {
	static readonly ID = 'glass.newAgentFromKeyboard';

	constructor() {
		super({
			id: NewAgentFromKeyboardAction.ID,
			// Binary-verbatim: title "New Agent", icon "agent", f1:!1.
			title: localize2('glass.newAgentFromKeyboard', 'New Agent'),
			icon: Codicon.agent,
			f1: false,
			keybinding: {
				// Binary: weight yk=250, primary CtrlCmd|KeyN, NO when clause.
				weight: newAgentKeybindingWeight,
				primary: KeyMod.CtrlCmd | KeyCode.KeyN,
			},
			// Binary: menu {column: MenubarFileMenu, group:"1_new", order:0,
			// title:"New Agent"} — sits ABOVE stock "New Text File" (order 1).
			menu: {
				id: MenuId.MenubarFileMenu,
				group: '1_new',
				order: 0,
			},
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		// Binary: trackEvent("agent_layout.new_agent_clicked",
		// {source:"keyboard_shortcut",keybinding:"Ctrl+N"}), emit
		// newAgentRequested.
		await accessor.get(ICommandService).executeCommand('ide.newAgent', {
			source: 'keyboard_shortcut',
			keybinding: 'Ctrl+N',
		} satisfies NewAgentCommandArgs);
	}
}

export class NewAgentKeepPaneFromKeyboardAction extends Action2 {
	static readonly ID = 'glass.newAgentKeepPaneFromKeyboard';

	constructor() {
		super({
			id: NewAgentKeepPaneFromKeyboardAction.ID,
			// Binary-verbatim: title "New Agent (preserve editor panel)",
			// icon "agent", f1:!1.
			title: localize2('glass.newAgentKeepPaneFromKeyboard', 'New Agent (preserve editor panel)'),
			icon: Codicon.agent,
			f1: false,
			keybinding: {
				// Binary: weight yk=250, primary CtrlCmd|Alt|KeyN, NO when.
				weight: newAgentKeybindingWeight,
				primary: KeyMod.CtrlCmd | KeyMod.Alt | KeyCode.KeyN,
			},
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		// Binary: trackEvent(...,{source:"keyboard_shortcut",
		// keybinding:"Ctrl+Alt+N"}), emit newAgentRequested with payload
		// {shouldOpenEditorPanel:!0}.
		await accessor.get(ICommandService).executeCommand('ide.newAgent', {
			source: 'keyboard_shortcut',
			keybinding: 'Ctrl+Alt+N',
			shouldOpenEditorPanel: true,
		} satisfies NewAgentCommandArgs);
	}
}

export class NewAgentWithModelAction extends Action2 {
	static readonly ID = 'glass.newAgentWithModel';

	constructor() {
		super({
			id: NewAgentWithModelAction.ID,
			// Binary-verbatim: title "New Agent with Model", icon "sparkle",
			// glassCategory "Agent"; the Ir carries NO f1 -> palette-visible.
			// No keybinding in the binary.
			title: localize2('glass.newAgentWithModel', 'New Agent with Model'),
			icon: Codicon.sparkle,
			category: AgentActionCategory,
			f1: true,
		});
	}

	async run(accessor: ServicesAccessor, modelId: unknown): Promise<void> {
		// Binary-verbatim guard: typeof e!="string"||e.trim().length===0 -> no-op.
		if (typeof modelId !== 'string' || modelId.trim().length === 0) {
			return;
		}
		// Binary XQb: emit newAgentRequested, then seed the new session's
		// model config (selectedModels:[{modelId, parameters}],
		// updateGlobalConfig). The extension's `ide.newAgentWithModel`
		// creates the agent tab and applies the model to it (engine
		// setModel + composer selection, the fork's setModelConfigForComposer
		// analog).
		await accessor.get(ICommandService).executeCommand('ide.newAgentWithModel', modelId);
	}
}

export class NewAgentWithContextAction extends Action2 {
	static readonly ID = 'glass.newAgentWithContext';

	constructor() {
		super({
			id: NewAgentWithContextAction.ID,
			// Binary-verbatim: title "New Agent with Context", icon "sparkle",
			// f1:!1, hidden:!0 (no palette entry, no menu items — the VS Code
			// equivalent of Cursor's `hidden`).
			title: localize2('glass.newAgentWithContext', 'New Agent with Context'),
			icon: Codicon.sparkle,
			f1: false,
			keybinding: {
				// Binary: weight 1602, primary CtrlCmd|Shift|KeyL, secondary
				// [CtrlCmd|Shift|KeyI], when = active-tab-kind File|Terminal|
				// ((Diff|Pr) + diff-line-selection).
				weight: newAgentWithContextKeybindingWeight,
				primary: KeyMod.CtrlCmd | KeyMod.Shift | KeyCode.KeyL,
				secondary: [KeyMod.CtrlCmd | KeyMod.Shift | KeyCode.KeyI],
				when: newAgentWithContextWhen,
			},
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		// Binary: trackEvent(...,{source:"keyboard_shortcut",
		// keybinding:"Ctrl+Shift+L"}), emit newAgentWithContextRequested with
		// {mentions: auto-gathered-from-current-context, sourceAgentId?}.
		// The extension's `ide.addToChat` with {newChat:true} is the real
		// implementation: it creates a FRESH agent tab and attaches the
		// current context (terminal selection probe -> editor selection) as
		// a chip in the new tab — the fork's auto-gather + new-agent emit.
		await accessor.get(ICommandService).executeCommand('ide.addToChat', { newChat: true });
	}
}

/** Register the New Agent command family (called from registerComposerActions). */
export function registerNewAgentActions(): void {
	registerAction2(NewAgentAction);
	registerAction2(NewAgentFromKeyboardAction);
	registerAction2(NewAgentKeepPaneFromKeyboardAction);
	registerAction2(NewAgentWithModelAction);
	registerAction2(NewAgentWithContextAction);
	registerAction2(NewProjectSubagentAction);
}

/**
 * WORKER-GAPS-40B (keybindings-inventory-newAgent-family, auditor run 30,
 * 2026-10-20): `glass.newProjectSubagent` — Cursor 3.25.9 parity.
 *
 * Binary evidence (workbench.glass.main.js 3.25.9 @45345682, `Ir({id:H$l,...})`;
 * corroborated by docs/ui/keybindings-inventory.md and
 * docs/rea/dig-deeper-keyboard-2026-10-19.md row 5 + §3b row 2):
 * title "New Agent", icon "plus", glassCategory "Agent", f1:!1
 * (palette-hidden), keybinding CtrlCmd|KeyT,
 * when `JDi && !GMe && !focusInAny`, scope wl.AGENT_WORKSPACE, keywords
 * project/subagent/new/agent/thread/tab, run emits `newProjectSubagentRequested`
 * with {source:"keyboard_shortcut"}.
 *
 * This is the "global" Ctrl+T the keyboard audit flagged as missing
 * (dig-deeper-keyboard §3b: "Mình thiếu binding global; khi focus ngoài
 * chatView thì Ctrl+T không làm gì"): in Cursor, Ctrl+T opens a new agent
 * even when focus is outside the chat view; the fork's Ctrl+T only worked
 * inside the chat surface (the invented `composer.newChat` binding, which
 * Cursor does not have — its keybinding is removed in composerActions.ts).
 */
export class NewProjectSubagentAction extends Action2 {
	static readonly ID = 'glass.newProjectSubagent';

	constructor() {
		super({
			id: NewProjectSubagentAction.ID,
			// Binary-verbatim (workbench.glass.main.js 3.25.9 @45345682):
			// `Ir({id:H$l,title:"New Agent",icon:"plus",
			// glassCategory:"Agent",
			// keywords:["project","subagent","new","agent","thread","tab"],
			// f1:!1,scope:wl.AGENT_WORKSPACE,...})` — the earlier claim
			// "Icon: NOT in the recovered evidence" was WRONG; the binary
			// plainly has `icon:"plus"` (QA W42F catch, fixed WORKER-GAPS-56A).
			title: localize2('glass.newProjectSubagent', 'New Agent'),
			icon: Codicon.plus,
			category: AgentActionCategory,
			f1: false,
			keybinding: {
				// Binary: primary CtrlCmd|KeyT, when JDi && !GMe && !focusInAny.
				// Port notes:
				// - `focusInAny` -> TerminalContextKeys.focusInAny.negate():
				//   verbatim key string 'terminalFocusInAny' (established in
				//   the composer.openModeMenu port in composerActions.ts).
				// - `JDi` = the agent-workspace scope (binary
				//   scope:wl.AGENT_WORKSPACE — Cursor's multi-workbench "agent
				//   workspace" window type, cf. the `--glass` CLI flag
				//   "Enable the multi-workbench architecture"). The fork has a
				//   single window type whose agent surface is always present:
				//   no VS Code analog — documented, not ported (same precedent
				//   as scope:wl.AGENT_WORKSPACE on newAgentWithContext and the
				//   omitted `!isGlass` term in the shell-approval port).
				// - `GMe`: UNDECODABLE from static evidence (appears only in
				//   this and reopenLastClosedProjectConversationTab's
				//   when-clauses; no context-key legend recovered). Omitted as
				//   honest divergence — never guessed.
				// - Weight: binary weight is 601 — evidence:
				//   workbench.glass.main.js 3.25.9 @44200152 declares
				//   `var isu=601,...,DZI=dt.CtrlCmd|Xe.KeyT,
				//   VHb=ft.and(JDi,GMe.negate(),
				//   is.focusInAny.negate()),...` — this action's own
				//   Ctrl+T binding definition (weight var `isu`, aliased
				//   as MZI/KHb/HZI for the sibling bindings). The earlier
				//   claim "Weight: NOT in the recovered evidence" was
				//   WRONG. The fork deliberately keeps 200
				//   (WorkbenchContrib) instead of 601: the browser's
				//   Ctrl+T=new-tab sits at 250 with a browser-editor
				//   when-clause, so 200 keeps that ✅-verified behavior
				//   deterministic (a sibling-style 250 would tie-break
				//   by registration order inside the browser editor —
				//   fragile). Deliberate, documented divergence — not
				//   a gap in the evidence.
				weight: KeybindingWeight.WorkbenchContrib,
				primary: KeyMod.CtrlCmd | KeyCode.KeyT,
				when: TerminalContextKeys.focusInAny.negate(),
			},
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		// Binary: trackEvent(...,{source:"keyboard_shortcut",
		// keybinding:"Ctrl+T"}), emit newProjectSubagentRequested. The
		// extension's `ide.newProjectSubagent` is the runtime — the same
		// core-delegates-to-extension pattern as the rest of this family.
		await accessor.get(ICommandService).executeCommand('ide.newProjectSubagent', {
			source: 'keyboard_shortcut',
			keybinding: 'Ctrl+T',
		});
	}
}
