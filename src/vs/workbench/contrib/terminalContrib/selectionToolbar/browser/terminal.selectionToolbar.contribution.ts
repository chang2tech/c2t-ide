/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { registerTerminalContribution } from '../../../terminal/browser/terminalExtensions.js';
import { TerminalSelectionToolbarContribution } from './terminalSelectionToolbar.js';

// #region Terminal Contributions

registerTerminalContribution(TerminalSelectionToolbarContribution.ID, TerminalSelectionToolbarContribution, false);

// #endregion
