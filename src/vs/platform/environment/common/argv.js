/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
/**
 * Narrows `NativeParsedArgs['chat']` to the positional-subcommand object
 * form (`chat <prompt>`). The dash-flag form (`--chat`, Cursor's public
 * "standalone chat window" flag) parses to boolean `true` and must NOT be
 * treated as a chat request carrying a prompt.
 */
export function isChatSubcommand(chat) {
    return typeof chat === 'object';
}
