/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * IDE-CODE (DEV-GAPS-83, settings-window-layout): pure definitions for
 * Cursor's Settings › General › Layout › "Window Layout" entry.
 *
 * QA step 1 — evidence, self-verified 2026-10-20:
 * - Live CDP (docs/rea/detail-settings-2026-10-19.md:52): entry
 *   "Window Layout" — "Switch between Agent and Editor default layouts" —
 *   segmented control: Agent | Editor.
 * - Cursor 3.25.9 `workbench.glass.main.js`, settings entry component
 *   (byte ~28560353): Entry { label: "Window Layout", description:
 *   "Switch between Agent and Editor default layouts", searchAliases:
 *   ["layout", "agent", "editor", "window layout"] }; segmented options
 *   (layout-picker.react.js, byte ~28557762):
 *   `[{ value: "agent", label: "Agent" }, { value: "editor", label: "Editor" }]`.
 * - Presets (`defaultLayoutPresets.js`, byte ~24309085), VERBATIM:
 *   "default-agent":  { agentsVisible: true,  chatVisible: true,
 *     editorsVisible: true, panelVisible: false, sidebarVisible: false,
 *     sidebarLocation: "left",  panelMaximized: false }
 *   "default-editor": { agentsVisible: false, chatVisible: true,
 *     editorsVisible: true, panelVisible: false, sidebarVisible: true,
 *     sidebarLocation: "right", panelMaximized: false }
 * - The settings picker's current value is DERIVED, not stored (same
 *   component): `getSideBarPosition() === 0 ? "editor" : "agent"`, where
 *   Position 0 is LEFT. It re-derives on part-visibility changes and on
 *   `workbench.sideBar.location` configuration changes.
 * - Applying a preset (binary `g2g`, byte ~24324237): stores the layout id
 *   under the storage key {@link LAST_SELECTED_LAYOUT_STORAGE_KEY}
 *   (APPLICATION scope, USER target), fires telemetry
 *   `agent_layout.switch_layout` with `{ selectedLayout: "Agent" | "Editor" }`
 *   (done by the settings component, byte ~28560353), then applies part
 *   visibility/location (binary `h20`): unified sidebar, auxiliary bar
 *   (chat), editor area, panel, primary sidebar, sidebar location.
 *
 * HONEST-DIVERGENCE (fork architecture): the fork has no
 * `workbench.parts.unifiedsidebar` part and no unified-sidebar-location
 * service. `agentsVisible` — the Agents list sidebar — therefore has no
 * fork counterpart and is NOT mapped to anything (in the glass build it
 * is forced hidden anyway: `a = isGlass ? false : t.agentsVisible`).
 * `sidebarLocation` is applied through the stock
 * `workbench.sideBar.location` configuration, the same value Cursor's own
 * Move Primary Side Bar actions write (binary `layoutActions.js`:
 * `workbench.sideBar.location`) and the same value the settings picker
 * watches. Editor-area visibility uses the layout service's editor part
 * visibility (the fork has no `setUnifiedMaximizeState`; hiding the
 * editor part is the observable equivalent for these two presets, whose
 * `editorsVisible` is true in both).
 * The fork also has no glass React settings page; the setting is exposed
 * as the VS Code configuration {@link WINDOW_LAYOUT_CONFIG_KEY} (enum
 * agent/editor) in the IDE Code › General section, and changing it
 * applies the chosen preset — the fork's settings-UI equivalent of the
 * segmented control.
 */

export type WindowLayoutId = 'agent' | 'editor';

export const WINDOW_LAYOUT_LABEL = 'Window Layout';
export const WINDOW_LAYOUT_DESCRIPTION = 'Switch between Agent and Editor default layouts';
export const WINDOW_LAYOUT_SEARCH_ALIASES: readonly string[] = ['layout', 'agent', 'editor', 'window layout'];
export const WINDOW_LAYOUT_TELEMETRY_EVENT = 'agent_layout.switch_layout';

/** Binary preset ids (`defaultLayoutPresets.js` keys / ENi layout ids). */
export const AGENT_LAYOUT_PRESET_ID = 'default-agent';
export const EDITOR_LAYOUT_PRESET_ID = 'default-editor';

/** Binary storage key (`wNi`, agentLayoutQuickMenuTypes.js). */
export const LAST_SELECTED_LAYOUT_STORAGE_KEY = 'cursor/agentLayout.quickMenu.lastSelectedLayoutId';

/** Fork configuration key backing the segmented setting. */
export const WINDOW_LAYOUT_CONFIG_KEY = 'ide.window.defaultLayout';

export interface IWindowLayoutPresetState {
	readonly agentsVisible: boolean;
	readonly chatVisible: boolean;
	readonly editorsVisible: boolean;
	readonly panelVisible: boolean;
	readonly sidebarVisible: boolean;
	readonly sidebarLocation: 'left' | 'right';
	readonly panelMaximized: boolean;
}

export interface IWindowLayoutPreset {
	readonly id: string;
	readonly layout: WindowLayoutId;
	/** Binary telemetry value: `Mj.Agent` / `Mj.Editor` serialize as these names. */
	readonly telemetryName: 'Agent' | 'Editor';
	readonly state: IWindowLayoutPresetState;
}

/** VERBATIM binary presets (defaultLayoutPresets.js, byte ~24309085). */
export const WINDOW_LAYOUT_PRESETS: readonly IWindowLayoutPreset[] = [
	{
		id: AGENT_LAYOUT_PRESET_ID,
		layout: 'agent',
		telemetryName: 'Agent',
		state: {
			agentsVisible: true,
			chatVisible: true,
			editorsVisible: true,
			panelVisible: false,
			sidebarVisible: false,
			sidebarLocation: 'left',
			panelMaximized: false
		}
	},
	{
		id: EDITOR_LAYOUT_PRESET_ID,
		layout: 'editor',
		telemetryName: 'Editor',
		state: {
			agentsVisible: false,
			chatVisible: true,
			editorsVisible: true,
			panelVisible: false,
			sidebarVisible: true,
			sidebarLocation: 'right',
			panelMaximized: false
		}
	}
];

export function windowLayoutPreset(layout: WindowLayoutId): IWindowLayoutPreset {
	return WINDOW_LAYOUT_PRESETS.find(p => p.layout === layout) ?? WINDOW_LAYOUT_PRESETS[0];
}

/**
 * The settings picker's derived current value (binary, verbatim logic):
 * `getSideBarPosition() === 0 ? "editor" : "agent"` — Position.LEFT is 0.
 */
export function windowLayoutFromSideBarPosition(sideBarPosition: number): WindowLayoutId {
	return sideBarPosition === 0 ? 'editor' : 'agent';
}

/** One part-visibility/location operation needed to reach a preset. */
export type WindowLayoutOperation =
	| { readonly kind: 'sidebar'; readonly visible: boolean }
	| { readonly kind: 'chat'; readonly visible: boolean }
	| { readonly kind: 'panel'; readonly visible: boolean }
	| { readonly kind: 'editors'; readonly visible: boolean }
	| { readonly kind: 'sidebarLocation'; readonly location: 'left' | 'right' };

export interface IWindowLayoutCurrentState {
	readonly sidebarVisible: boolean;
	readonly chatVisible: boolean;
	readonly panelVisible: boolean;
	readonly editorsVisible: boolean;
	readonly sidebarLocation: 'left' | 'right';
}

/**
 * Diff a preset against the current layout, in the binary `h20` order:
 * (unified sidebar — no fork counterpart, skipped), chat (auxiliary bar),
 * editors, panel, sidebar, then sidebar location. Only parts whose
 * visibility differs produce an operation, exactly like the binary's
 * `isVisible(...) !== target && apply` guards; the location is always
 * set (binary calls `setUnifiedSidebarLocation` unconditionally).
 */
export function planWindowLayoutOperations(preset: IWindowLayoutPresetState, current: IWindowLayoutCurrentState): WindowLayoutOperation[] {
	const ops: WindowLayoutOperation[] = [];
	if (current.chatVisible !== preset.chatVisible) {
		ops.push({ kind: 'chat', visible: preset.chatVisible });
	}
	if (current.editorsVisible !== preset.editorsVisible) {
		ops.push({ kind: 'editors', visible: preset.editorsVisible });
	}
	if (current.panelVisible !== preset.panelVisible) {
		ops.push({ kind: 'panel', visible: preset.panelVisible });
	}
	if (current.sidebarVisible !== preset.sidebarVisible) {
		ops.push({ kind: 'sidebar', visible: preset.sidebarVisible });
	}
	ops.push({ kind: 'sidebarLocation', location: preset.sidebarLocation });
	return ops;
}
