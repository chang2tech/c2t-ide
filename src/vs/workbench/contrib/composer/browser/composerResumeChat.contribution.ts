/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { registerAction2 } from '../../../../platform/actions/common/actions.js';
import { ComposerResumeCurrentChatAction } from './composerResumeChatAction.js';

// FEATURE-2 (`agent-resume-chat`): registers the binary-verbatim
// `composer.resumeCurrentChat` workbench command (Cursor 3.25.9 parity).
// Wired into the build via workbench.common.main.ts.
registerAction2(ComposerResumeCurrentChatAction);
