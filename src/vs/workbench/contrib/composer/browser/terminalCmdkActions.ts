/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// IDE-CODE: terminal Cmd+K ("Generate in Terminal") command family — Cursor parity.
//
// PARITY EVIDENCE STATUS (rule: ~/AGENTS.md "KHÔNG BỊA ĐẶT", 2026-10-19):
//   OBSERVED (docs/rea/audit-fix-queue.md run 19:07, feature `terminal-ai-cmdk`,
//     app-verified in workbench.desktop.main.js 3.25.6 — minified `eC({id:…})`
//     registrations with titles/keybindings):
//     - `cursorai.action.generateInTerminal` "Generate in Terminal", CtrlCmd+K,
//       weight 10200, when terminalFocus || promptBarVisible,
//       precondition terminal process supported,
//       eligibility gate XD(modelAccess,"cmdk") — fail → log `Cmd-K: ${reason}`,
//       no open; `localMode` → return immediately (no-op);
//       telemetry `terminal.cmdk.show`
//     - `cursorai.action.hideGenerateInTerminal` "Hide Prompt Bar", Esc
//     - `cursorai.action.cancelGenerateInTerminal` "Cancel Generation",
//       CtrlCmd+Backspace, when promptBarCanCancelGeneration
//     - `cursorai.action.acceptGenerateInTerminal` "Accept Generated Command",
//       CtrlCmd+Enter, when terminalFocus && promptBarVisible — DESKTOP-BUILD
//       ONLY (0 hits in the glass bundle)
//     - `cursorai.action.acceptAndRunGenerateInTerminal`
//       "Accept & Run Generated Command", CtrlCmd+Enter, weight 10201
//     - `cursorai.action.rejectGenerateInTerminal` "Reject Generated Command",
//       CtrlCmd+Backspace, weight 10201, when promptBarCanRejectGeneration
//     - model switcher: `cursorai.action.switchToModel` "Switch to model",
//       `cursorai.action.switchToModelSlug` "Switch to Model Slug",
//       `cursorai.action.addModelToSwitcher` "Add model to switcher"
//       (all palette-hidden, f1:false);
//       glass-only `cursorai.action.switchToModelSlugInGlass`
//   BUILD-DIVERGENCE DECISION (documented per auditor; desktop fork):
//     - keep BOTH `acceptGenerateInTerminal` and `acceptAndRunGenerateInTerminal`
//       (desktop behavior). Glass drops `acceptGenerateInTerminal`; we build
//       the desktop app, so we keep the desktop set.
//     - `cursorai.action.switchToModelSlugInGlass` is glass-only in Cursor
//       (0 hits in the desktop bundle) → NOT registered here.
//   KEYBINDING-WEIGHT MAPPING (Cursor scale → this build's scale):
//     - The binary's w10200/w10201 are Cursor-internal (their workbench scale).
//       This build uses the VS Code scale (KeybindingWeight.WorkbenchContrib
//       = 200, NOT 10000). The fork preserves the exact priority RELATIONSHIPS:
//       +200 for generate/hide (400), +201 for accept&run/reject (401).
//       400 outranks `workbench.action.terminal.clear` (mac Cmd+K, 201), so
//       Cursor's Cmd+K takes over terminal clear; 401 outranks 400, so
//       accept&run/reject win over accept/cancel when both when-clauses match.
//       The raw numbers 10200/10201 are NOT used verbatim — they belong to
//       Cursor's scale, not this build's.
//     - `hideGenerateInTerminal` Esc: evidence gives w10200,
//       when terminalFocus&&promptBarVisible → mapped to 400 with the verbatim
//       when-clause below.
//   UNKNOWN / our choices (NOT in evidence — do not treat as Cursor-verified):
//     - `acceptAndRunGenerateInTerminal` when-clause: evidence gives only the
//       weight (10201). Scoped to `promptBarCanRejectGeneration` — a generated
//       command must be pending to accept&run; mirrors `rejectGenerateInTerminal`.
//       INFERRED, not observed.
//     - keybinding weights for cancel/accept: evidence silent →
//       KeybindingWeight.WorkbenchContrib (200) for cancel, +200 (400) for
//       accept (same tier as generate, matching the family's base weight).
//     - command categories / palette visibility of the six main commands:
//       evidence silent → defaults (f1:true, no category).
//     - `XD` is a minified name: `checkModelAccessForCmdk()` below is the
//       SEMANTIC equivalent (model access for the cmdk feature), not a
//       de-minified symbol. The real gate signal available in this tree is
//       `ide.agent.terminal.enableAiChecks`.
//     - `localMode` maps to the `ide.agent.localMode` setting (default false);
//       Cursor's exact localMode trigger conditions are UNKNOWN.
//     - the command-generation pipeline behind canCancelGeneration /
//       canRejectGeneration is not wired yet: the controller below owns the
//       real state machine (AbortController, generated-command slot) but no
//       generator feeds it — those keys stay false until the engine hook
//       exists. Registered when-clauses are verbatim; the states are honest.

import { localize2 } from '../../../../nls.js';
import { KeyCode, KeyMod } from '../../../../base/common/keyCodes.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { CommandsRegistry, ICommandService } from '../../../../platform/commands/common/commands.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { ContextKeyExpr, IContextKey, IContextKeyService, RawContextKey } from '../../../../platform/contextkey/common/contextkey.js';
import { ServicesAccessor, createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { KeybindingWeight } from '../../../../platform/keybinding/common/keybindingsRegistry.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { ITelemetryService } from '../../../../platform/telemetry/common/telemetry.js';
import { TerminalContextKeys } from '../../terminal/common/terminalContextKey.js';
import { ITerminalInstance, ITerminalService } from '../../terminal/browser/terminal.js';
import { ITooltipService } from './tooltipService.js';

// ---- prompt-bar context keys (verbatim names from the evidence when-clauses) ----

/** `promptBarVisible` — the terminal Cmd+K prompt bar is currently open. */
export const terminalPromptBarVisible = new RawContextKey<boolean>('promptBarVisible', false);
/** `promptBarCanCancelGeneration` — a command generation is in flight. */
export const terminalPromptBarCanCancelGeneration = new RawContextKey<boolean>('promptBarCanCancelGeneration', false);
/** `promptBarCanRejectGeneration` — a generated command is pending accept/reject. */
export const terminalPromptBarCanRejectGeneration = new RawContextKey<boolean>('promptBarCanRejectGeneration', false);

// ---- prompt-bar state ---------------------------------------------------------

export const ITerminalGeneratePromptBar = createDecorator<ITerminalGeneratePromptBar>('terminalGeneratePromptBar');

export interface ITerminalGeneratePromptBar {
	readonly _serviceBrand: undefined;

	readonly isPromptBarVisible: boolean;
	readonly canCancelGeneration: boolean;
	readonly canRejectGeneration: boolean;

	/** Mark the prompt bar visible for this terminal (set by generateInTerminal). */
	showForTerminal(term: ITerminalInstance): void;
	/** Hide the prompt bar and clear all prompt-bar state. */
	hide(): void;
	/**
	 * Called by the `composer.terminalPromptBar.setVisible` bridge command,
	 * which the ide-agent extension fires when its QuickInput prompt bar
	 * actually opens/closes (cross-extension-host visibility sync).
	 */
	setPromptBarVisible(visible: boolean): void;

	/**
	 * Begin a command-generation run. Returns an AbortSignal the generator
	 * must honor; sets promptBarCanCancelGeneration. UNKNOWN: no generator is
	 * wired yet — exposed for the future engine hook.
	 */
	beginGeneration(): AbortSignal;
	/** Abort the in-flight generation, if any (back to the editing state). */
	cancelGeneration(): void;
	/** A generated command is ready for accept/reject. */
	setGeneratedCommand(command: string): void;
	/** Discard the pending generated command (reject path). */
	clearGeneratedCommand(): void;

	/** "Accept Generated Command": insert into the terminal WITHOUT running. */
	accept(): void;
	/** "Accept & Run Generated Command": insert into the terminal AND run. */
	acceptAndRun(): void;
	/** "Reject Generated Command": discard the generated command. */
	reject(): void;
}

export class TerminalGeneratePromptBar extends Disposable implements ITerminalGeneratePromptBar {

	declare readonly _serviceBrand: undefined;

	private readonly visibleKey: IContextKey<boolean>;
	private readonly canCancelKey: IContextKey<boolean>;
	private readonly canRejectKey: IContextKey<boolean>;

	private target: ITerminalInstance | undefined;
	private generationAbort: AbortController | undefined;
	private generatedCommand: string | undefined;

	constructor(
		@IContextKeyService contextKeyService: IContextKeyService,
	) {
		super();
		this.visibleKey = terminalPromptBarVisible.bindTo(contextKeyService);
		this.canCancelKey = terminalPromptBarCanCancelGeneration.bindTo(contextKeyService);
		this.canRejectKey = terminalPromptBarCanRejectGeneration.bindTo(contextKeyService);
	}

	get isPromptBarVisible(): boolean {
		return !!this.visibleKey.get();
	}

	get canCancelGeneration(): boolean {
		return !!this.canCancelKey.get();
	}

	get canRejectGeneration(): boolean {
		return !!this.canRejectKey.get();
	}

	showForTerminal(term: ITerminalInstance): void {
		this.target = term;
		this.visibleKey.set(true);
	}

	hide(): void {
		this.cancelGeneration();
		this.clearGeneratedCommand();
		this.target = undefined;
		this.visibleKey.set(false);
	}

	setPromptBarVisible(visible: boolean): void {
		if (visible) {
			this.visibleKey.set(true);
		} else {
			// The real prompt UI closed (Esc/accept in the extension host):
			// clear the state the same way hide() does.
			this.hide();
		}
	}

	beginGeneration(): AbortSignal {
		this.cancelGeneration();
		this.generationAbort = new AbortController();
		this.canCancelKey.set(true);
		return this.generationAbort.signal;
	}

	cancelGeneration(): void {
		if (this.generationAbort) {
			this.generationAbort.abort();
			this.generationAbort = undefined;
		}
		this.canCancelKey.set(false);
	}

	setGeneratedCommand(command: string): void {
		this.cancelGeneration();
		this.generatedCommand = command;
		this.canRejectKey.set(true);
	}

	clearGeneratedCommand(): void {
		this.generatedCommand = undefined;
		this.canRejectKey.set(false);
	}

	accept(): void {
		// "Accept Generated Command" acts on the GENERATED command. With no
		// generated command pending there is nothing to accept (the typed
		// description goes to the agent via Enter, not via accept).
		const command = this.generatedCommand;
		if (command === undefined || !this.target) {
			return;
		}
		this.target.sendText(command, false);
		this.hide();
	}

	acceptAndRun(): void {
		const command = this.generatedCommand;
		if (command === undefined || !this.target) {
			return;
		}
		this.target.sendText(command, true);
		this.hide();
	}

	reject(): void {
		// Reject discards the generated command; the prompt bar stays open so
		// the user can describe the command again.
		this.clearGeneratedCommand();
	}
}

// ---- eligibility gate + localMode ---------------------------------------------

/**
 * Semantic equivalent of Cursor's minified `XD(modelAccess, "cmdk")`:
 * whether the cmdk feature currently has model access. `XD` itself is a
 * minified symbol — this is NOT a de-minified name, it is the behavior the
 * gate implements. The real signal available in this tree is the terminal AI
 * checks setting; when it is off, Cmd+K must not open.
 */
function checkModelAccessForCmdk(configurationService: IConfigurationService): { ok: boolean; reason?: string } {
	const aiChecks = configurationService.getValue<boolean>('ide.agent.terminal.enableAiChecks') ?? true;
	if (!aiChecks) {
		return { ok: false, reason: 'terminal AI features are disabled (ide.agent.terminal.enableAiChecks)' };
	}
	return { ok: true };
}

/**
 * Cursor's `localMode` short-circuit. Maps to the `ide.agent.localMode`
 * setting (default false). Cursor's exact localMode trigger conditions are
 * UNKNOWN — the return-immediately/no-op behavior is what's mirrored.
 */
function isLocalMode(configurationService: IConfigurationService): boolean {
	return configurationService.getValue<boolean>('ide.agent.localMode') ?? false;
}

// ---- the verbatim command family ------------------------------------------------

/**
 * `cursorai.action.generateInTerminal` — "Generate in Terminal".
 * CtrlCmd+K, Cursor weight 10200 → fork 400 (WorkbenchContrib+200),
 * when terminalFocus || promptBarVisible,
 * precondition terminal process supported. Eligibility gate + localMode
 * short-circuit + `terminal.cmdk.show` telemetry per the binary.
 *
 * NOTE: fork weight 400 intentionally outranks
 * `workbench.action.terminal.clear` (mac CtrlCmd+K, WorkbenchContrib+1 = 201)
 * when the terminal is focused — Cursor's Cmd+K takes over terminal clear.
 */
class GenerateInTerminalAction extends Action2 {
	static readonly ID = 'cursorai.action.generateInTerminal';
	constructor() {
		super({
			id: GenerateInTerminalAction.ID,
			title: localize2('cursorai.action.generateInTerminal', 'Generate in Terminal'),
			precondition: TerminalContextKeys.processSupported,
			keybinding: {
				weight: KeybindingWeight.WorkbenchContrib + 200, // Cursor w10200 → fork 400
				primary: KeyMod.CtrlCmd | KeyCode.KeyK,
				when: ContextKeyExpr.or(TerminalContextKeys.focus, terminalPromptBarVisible),
			},
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		const configurationService = accessor.get(IConfigurationService);
		// Eligibility gate: XD(modelAccess,"cmdk") — fail → log `Cmd-K: ${reason}`, do not open.
		const access = checkModelAccessForCmdk(configurationService);
		if (!access.ok) {
			accessor.get(ILogService).warn(`Cmd-K: ${access.reason}`);
			return;
		}
		// localMode → return immediately (no-op).
		if (isLocalMode(configurationService)) {
			return;
		}
		accessor.get(ITelemetryService).publicLog2<{}, { owner: 'ide-code'; comment: 'Terminal Cmd+K prompt bar shown' }>('terminal.cmdk.show');
		// GAPS-170: tooltip pipeline producer — the binary emits
		// `terminal.cmdk.show` at exactly this point (desk@36730861,
		// next to the same trackEvent), beside the `terminal.cmdk.show`
		// telemetry above.
		accessor.get(ITooltipService).registerEvent('terminal.cmdk.show');
		const term = accessor.get(ITerminalService).activeInstance;
		if (term) {
			accessor.get(ITerminalGeneratePromptBar).showForTerminal(term);
		}
		// The prompt-bar UI currently lives in the ide-agent extension host
		// (ide.terminalAiCommand → TerminalService.openTerminalPrompt); it
		// reports real open/close back via `composer.terminalPromptBar.setVisible`.
		await accessor.get(ICommandService).executeCommand('ide.terminalAiCommand');
	}
}

/**
 * `cursorai.action.hideGenerateInTerminal` — "Hide Prompt Bar", Esc.
 * Evidence: Escape keybinding w10200 (→ fork 400, WorkbenchContrib+200),
 * when terminalFocus && promptBarVisible (verbatim from the binary).
 */
class HideGenerateInTerminalAction extends Action2 {
	static readonly ID = 'cursorai.action.hideGenerateInTerminal';
	constructor() {
		super({
			id: HideGenerateInTerminalAction.ID,
			title: localize2('cursorai.action.hideGenerateInTerminal', 'Hide Prompt Bar'),
			keybinding: {
				weight: KeybindingWeight.WorkbenchContrib + 200, // Cursor w10200 → fork 400
				primary: KeyCode.Escape,
				when: ContextKeyExpr.and(TerminalContextKeys.focus, terminalPromptBarVisible),
			},
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		accessor.get(ITerminalGeneratePromptBar).hide();
	}
}

/**
 * `cursorai.action.cancelGenerateInTerminal` — "Cancel Generation",
 * CtrlCmd+Backspace, when promptBarCanCancelGeneration.
 */
class CancelGenerateInTerminalAction extends Action2 {
	static readonly ID = 'cursorai.action.cancelGenerateInTerminal';
	constructor() {
		super({
			id: CancelGenerateInTerminalAction.ID,
			title: localize2('cursorai.action.cancelGenerateInTerminal', 'Cancel Generation'),
			keybinding: {
				weight: KeybindingWeight.WorkbenchContrib,
				primary: KeyMod.CtrlCmd | KeyCode.Backspace,
				when: terminalPromptBarCanCancelGeneration,
			},
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		accessor.get(ITerminalGeneratePromptBar).cancelGeneration();
	}
}

/**
 * `cursorai.action.acceptGenerateInTerminal` — "Accept Generated Command",
 * CtrlCmd+Enter, when terminalFocus && promptBarVisible.
 * DESKTOP-BUILD ONLY in Cursor (0 hits in the glass bundle) — registered
 * here because this fork builds the desktop app (build-divergence decision,
 * see PARITY header).
 */
class AcceptGenerateInTerminalAction extends Action2 {
	static readonly ID = 'cursorai.action.acceptGenerateInTerminal';
	constructor() {
		super({
			id: AcceptGenerateInTerminalAction.ID,
			title: localize2('cursorai.action.acceptGenerateInTerminal', 'Accept Generated Command'),
			keybinding: {
				weight: KeybindingWeight.WorkbenchContrib,
				primary: KeyMod.CtrlCmd | KeyCode.Enter,
				when: ContextKeyExpr.and(TerminalContextKeys.focus, terminalPromptBarVisible),
			},
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		accessor.get(ITerminalGeneratePromptBar).accept();
	}
}

/**
 * `cursorai.action.acceptAndRunGenerateInTerminal` — "Accept & Run Generated
 * Command", CtrlCmd+Enter, Cursor weight 10201 → fork 401
 * (WorkbenchContrib+201).
 * When-clause INFERRED (evidence silent): promptBarCanRejectGeneration — a
 * generated command must be pending to accept&run. See PARITY header.
 */
class AcceptAndRunGenerateInTerminalAction extends Action2 {
	static readonly ID = 'cursorai.action.acceptAndRunGenerateInTerminal';
	constructor() {
		super({
			id: AcceptAndRunGenerateInTerminalAction.ID,
			title: localize2('cursorai.action.acceptAndRunGenerateInTerminal', 'Accept & Run Generated Command'),
			keybinding: {
				weight: KeybindingWeight.WorkbenchContrib + 201, // Cursor w10201 → fork 401
				primary: KeyMod.CtrlCmd | KeyCode.Enter,
				when: terminalPromptBarCanRejectGeneration,
			},
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		accessor.get(ITerminalGeneratePromptBar).acceptAndRun();
	}
}

/**
 * `cursorai.action.rejectGenerateInTerminal` — "Reject Generated Command",
 * CtrlCmd+Backspace, Cursor weight 10201 → fork 401 (WorkbenchContrib+201),
 * when promptBarCanRejectGeneration.
 */
class RejectGenerateInTerminalAction extends Action2 {
	static readonly ID = 'cursorai.action.rejectGenerateInTerminal';
	constructor() {
		super({
			id: RejectGenerateInTerminalAction.ID,
			title: localize2('cursorai.action.rejectGenerateInTerminal', 'Reject Generated Command'),
			keybinding: {
				weight: KeybindingWeight.WorkbenchContrib + 201, // Cursor w10201 → fork 401
				primary: KeyMod.CtrlCmd | KeyCode.Backspace,
				when: terminalPromptBarCanRejectGeneration,
			},
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		accessor.get(ITerminalGeneratePromptBar).reject();
	}
}

// ---- model switcher (all palette-hidden, f1:false) -------------------------------

/**
 * `cursorai.action.switchToModel` — "Switch to model" (f1:false).
 * Drives the composer's real model picker (the per-prompt-bar model state in
 * Cursor's terminal prompt bar has no equivalent in this tree yet — UNKNOWN).
 */
class SwitchToModelAction extends Action2 {
	static readonly ID = 'cursorai.action.switchToModel';
	constructor() {
		super({
			id: SwitchToModelAction.ID,
			title: localize2('cursorai.action.switchToModel', 'Switch to model'),
			f1: false,
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		await accessor.get(ICommandService).executeCommand('ide.openModelPicker');
	}
}

/**
 * `cursorai.action.switchToModelSlug` — "Switch to Model Slug" (f1:false).
 * Forwards the slug arg to the model picker; exact slug-routing behavior is
 * UNKNOWN (the picker's arg contract was not captured by REA).
 */
class SwitchToModelSlugAction extends Action2 {
	static readonly ID = 'cursorai.action.switchToModelSlug';
	constructor() {
		super({
			id: SwitchToModelSlugAction.ID,
			title: localize2('cursorai.action.switchToModelSlug', 'Switch to Model Slug'),
			f1: false,
		});
	}

	async run(accessor: ServicesAccessor, ...args: unknown[]): Promise<void> {
		await accessor.get(ICommandService).executeCommand('ide.openModelPicker', ...args);
	}
}

/**
 * `cursorai.action.addModelToSwitcher` — "Add model to switcher" (f1:false).
 * Drives the real model manager (ide.agent.enabledModels).
 */
class AddModelToSwitcherAction extends Action2 {
	static readonly ID = 'cursorai.action.addModelToSwitcher';
	constructor() {
		super({
			id: AddModelToSwitcherAction.ID,
			title: localize2('cursorai.action.addModelToSwitcher', 'Add model to switcher'),
			f1: false,
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		await accessor.get(ICommandService).executeCommand('ide.manageModels');
	}
}

// NOTE: `cursorai.action.switchToModelSlugInGlass` is glass-only in Cursor
// (0 hits in the desktop bundle) → intentionally NOT registered in this
// desktop build. See PARITY EVIDENCE STATUS header.

/**
 * Bridge command the ide-agent extension host calls when its terminal prompt
 * bar actually opens/closes, so the `promptBarVisible`-gated actions above
 * track reality. Args are JSON-safe (boolean) for the extension-host boundary.
 */
const TERMINAL_PROMPT_BAR_SET_VISIBLE_ID = 'composer.terminalPromptBar.setVisible';

/** Register the whole `cursorai.action.*` terminal Cmd+K family. */
export function registerTerminalCmdkActions(): void {
	CommandsRegistry.registerCommand(TERMINAL_PROMPT_BAR_SET_VISIBLE_ID, (accessor, visible: unknown) => {
		accessor.get(ITerminalGeneratePromptBar).setPromptBarVisible(visible === true);
	});
	registerAction2(GenerateInTerminalAction);
	registerAction2(HideGenerateInTerminalAction);
	registerAction2(CancelGenerateInTerminalAction);
	registerAction2(AcceptGenerateInTerminalAction);
	registerAction2(AcceptAndRunGenerateInTerminalAction);
	registerAction2(RejectGenerateInTerminalAction);
	registerAction2(SwitchToModelAction);
	registerAction2(SwitchToModelSlugAction);
	registerAction2(AddModelToSwitcherAction);
}
