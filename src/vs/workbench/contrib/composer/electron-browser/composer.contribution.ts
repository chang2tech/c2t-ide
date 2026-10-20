/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// IDE-CODE: Composer (AI chat) electron-browser contribution — desktop-only DI wiring.
//
// Layer split (P0 node-free common/): the node-dependent service
// implementations live in this layer (electron-browser/). This module wires
// them to their node-free contracts in common/ via the instantiation service,
// the same pattern other workbench contribs use (interface in common/,
// implementation in electron-browser/, registerSingleton here).
//
// Only services whose constructors are pure DI (every parameter a service
// decorator) are registered:
//   IIdeCodeEngineAdapterFactory -> IdeCodeEngineAdapterFactory (the factory
//       is the seam browser//common/ code uses to create per-site configured
//       engine adapters without importing node builtins)
//   IMentionService              -> MentionService
//   ICodebaseIndexService        -> CodebaseIndexService
//   IProjectRulesService         -> ProjectRulesService
//
// Deliberately NOT registered (documented, not forgotten):
//   ISlashCommandService / IMcpService — constructors take a non-service
//       `getComposer` factory callback; registerSingleton would construct
//       them with `undefined` and break at runtime.
//   IComposerDataService — constructor takes an optional non-service
//       `hookService`; registering it bare would silently run the composer
//       without hooks. Wire it explicitly when the per-tab composer lands.

import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { IIdeCodeEngineAdapterFactory } from '../common/ideCodeEngineAdapter.js';
import { IdeCodeEngineAdapterFactory } from './ideCodeEngineAdapter.js';
import { IMentionService } from '../common/mentionService.js';
import { MentionService } from './mentionService.js';
import { ICodebaseIndexService } from '../common/codebaseIndexService.js';
import { CodebaseIndexService } from './codebaseIndexService.js';
import { IProjectRulesService } from '../common/projectRulesService.js';
import { ProjectRulesService } from './projectRulesService.js';
import { IInlinePromptSelectionService, InlinePromptSelectionService } from '../common/inlinePromptSelection.js';
import { IInlineEditService } from '../common/inlineEditService.js';
import { InlineEditService } from './inlineEditService.js';

registerSingleton(IIdeCodeEngineAdapterFactory, IdeCodeEngineAdapterFactory, InstantiationType.Delayed);
registerSingleton(IMentionService, MentionService, InstantiationType.Delayed);
registerSingleton(ICodebaseIndexService, CodebaseIndexService, InstantiationType.Delayed);
registerSingleton(IProjectRulesService, ProjectRulesService, InstantiationType.Delayed);
// F2-A (2026-10-20): the Cmd+K inline-edit live path. `IInlineEditService`
// drives the native view-zone prompt bar (`IInlineEditPromptBar`) for the
// open → generate → preview → accept/reject → follow-up → escalate flow
// (Cursor's workbench-core layer). Both constructors are pure DI, so the
// services are registered here; `IInlinePromptSelectionService` backs the
// "attach selection" (K-08) step (command/palette only — its former
// Ctrl/Cmd+Shift+K chord was reassigned to `aipopup.action.modal.generate`,
// see GAPS-171 in composerActions.ts).
registerSingleton(IInlinePromptSelectionService, InlinePromptSelectionService, InstantiationType.Delayed);
registerSingleton(IInlineEditService, InlineEditService, InstantiationType.Delayed);

// F7 (2026-10-20): register the `ide.openOrFocusGlassWindow` core command —
// the Cursor `cursor.openOrFocusGlassWindow` analog that opens/focuses the
// IDE's dedicated Agents ("glass") window. Imported for its side effect
// (registerAction2); see glassWindowActions.ts for the binary evidence.
import './glassWindowActions.js';

// GAPS-46B (2026-10-20): register the `ide.ndjsonIngest.*` core commands —
// the workbench-core analogs of the `cursor.ndjsonIngest.*` commands from
// Cursor's `cursor-ndjson-ingest` extension (stop / copy curl / reassign
// port / show status). Imported for its side effect (registerAction2); see
// debugIngestActions.ts for the binary evidence.
import './debugIngestActions.js';

// DEV-GAPS-64 (2026-10-20): register the workbench-core command
// `deeplink.command.create` — the workbench-side half of Cursor's one-click
// command deeplink (matrix feature `deeplink-create-command`). The command
// id is verbatim from the binary (`workbench.desktop.main.js` @ 29972167)
// because it is the extension↔workbench wire id. Imported for its side
// effect (CommandsRegistry.registerCommand); see deeplinkActions.ts.
import './deeplinkActions.js';

// DEV-GAPS-53 (inline-diff-suppression-warning, Cursor 3.25.9 binary):
// the "too many changes" warning with never-show-again
// `inlineDiff.tooManyChangesWarning`, shown when performance protection
// suppresses inline-diff decorations. Registered here (desktop-only):
// the constructor takes the core `IInlineEditService`, which only exists
// on the electron-browser layer.
import { registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';
import { InlineDiffSuppressionNotification } from '../browser/inlineDiffSuppressionNotification.js';
registerWorkbenchContribution2(
	InlineDiffSuppressionNotification.ID,
	InlineDiffSuppressionNotification,
	WorkbenchPhase.BlockRestore,
);
