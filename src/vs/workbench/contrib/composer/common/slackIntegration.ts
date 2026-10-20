/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// IDE-CODE: Slack integration connect — Cursor parity (feature
// `slack-integration-connect`, P2, category integrations).
//
// Binary evidence (verbatim — kept character-for-character), from Cursor
// 3.25.6 `workbench.desktop.main.js` / `workbench.glass.main.js` (systematic
// ID extraction, DEEP-DIG-A 2026-10-19), mirrored in the feature matrix
// (docs/product/feature-matrix.json):
//   - `Command cursor.connectSlack titled "Connect Slack" (not in command palette).`
//   - Telemetry `LogClickedConnectSlack` present in the workbench inventory
//     (dig-root-team/scratch-redig/inventory-3.25.9-FINAL.json) — the command
//     is fired from a click surface, not from the palette.
// Cursor's backend wire for this is the generic connector framework
// (`aiserver.v1.GkwService`: ListGkwConnectors, GetGkwConnectorAuthUrl, …);
// per dig-root-team/findings-root-matrix.json that framework is backend
// wire, not a standalone user feature, so the connect surface here is the
// `cursor.connectSlack` command itself.
//
// Expected behavior (feature matrix, verbatim): "User can connect a Slack
// workspace from within the IDE."
//
// LAYER NOTE: the binary shows the command id, title and palette-hidden
// flag, but not which workbench layer registers it, so the Cursor layer is
// UNKNOWN. This lives next to the other composer workbench contributions
// (browser/contrib/composer), the repo's Cursor-parity home.
//
// HONEST-DIVERGENCE: Cursor's canonical connect exchange is server-driven
// (GetGkwConnectorAuthUrl opens an OAuth URL for the Slack workspace) and
// has NO binary evidence in the dissected bundles beyond the command id,
// title, palette-hidden flag and the click telemetry. This fork has no
// GkwService backend, so no OAuth exchange is claimed or implemented.
// The handler opens the IDE's integrations settings surface
// (`workbench.action.openSettings` with query "integrations"), which is the
// entry point a connector backend would attach to. No parity is claimed for
// the connect handshake itself.

/** Command id — verbatim binary evidence. */
export const CONNECT_SLACK_COMMAND_ID = 'cursor.connectSlack';

/** Command title — verbatim binary evidence. */
export const CONNECT_SLACK_COMMAND_TITLE = 'Connect Slack';

/**
 * Whether the command appears in the command palette.
 * Verbatim binary evidence: "not in command palette" → false.
 */
export const CONNECT_SLACK_IN_COMMAND_PALETTE = false;

/** Settings search query opened by the connect command (integrations surface). */
export const INTEGRATIONS_SETTINGS_QUERY = 'integrations';

/** Stock command that opens the settings editor (id copied from the workbench preferences contrib). */
export const OPEN_SETTINGS_COMMAND_ID = 'workbench.action.openSettings';

export interface ICommandServiceLike {
	executeCommand(id: string, ...args: unknown[]): Promise<unknown>;
}

/**
 * The `cursor.connectSlack` connect flow. Opens the IDE integrations
 * settings surface — the place a Slack connector auth URL (Cursor's
 * GetGkwConnectorAuthUrl) would be offered from. The OAuth exchange itself
 * is out of scope (HONEST-DIVERGENCE above).
 */
export function openIntegrationsSettings(commandService: ICommandServiceLike): Promise<unknown> {
	return commandService.executeCommand(OPEN_SETTINGS_COMMAND_ID, { query: INTEGRATIONS_SETTINGS_QUERY });
}
