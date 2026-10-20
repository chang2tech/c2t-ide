/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// IDE-CODE: registers the IdeTabContribution workbench contribution.
// (Cursor analog: the cppService client lives in the workbench
// inline-completions area, not in an extension.)
// Imported from vs/workbench/workbench.common.main.ts.

import { registerWorkbenchContribution2, WorkbenchPhase } from '../../../../common/contributions.js';
import { IdeTabContribution } from './tabContribution.js';

registerWorkbenchContribution2(IdeTabContribution.ID, IdeTabContribution, WorkbenchPhase.Eventually);
