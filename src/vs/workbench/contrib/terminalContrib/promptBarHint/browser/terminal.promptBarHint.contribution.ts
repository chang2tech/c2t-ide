/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { registerTerminalContribution } from '../../../terminal/browser/terminalExtensions.js';
import { TerminalPromptBarHintContribution } from './terminalPromptBarHint.js';

// #region Terminal Contributions

registerTerminalContribution(TerminalPromptBarHintContribution.ID, TerminalPromptBarHintContribution, false);

// #endregion
