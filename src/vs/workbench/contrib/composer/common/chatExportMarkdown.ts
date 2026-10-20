/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// IDE-CODE: Pure Markdown-serialization for the Cursor `composer.exportChatAsMd`
// ("Export Transcript") command. Kept dependency-free on purpose so the
// binary-verbatim algorithm is unit-testable without the workbench.
//
// Binary evidence (Cursor 3.25.6 AND 3.25.9, workbench.glass.main.js, static
// literal extraction, verified verbatim in both versions):
// - 3.25.6: `composer.exportChatAsMd` first seen at file offset 0xf26790;
//   the Action2 descriptor (class `zxb`, offset 0x25fa681) is
//   `{id:"composer.exportChatAsMd",title:{value:"Export Transcript"},
//   f1:!1,icon:saveAll,menu:{id:ViewTitle,group:"1_chatTools",order:1,
//   when:view-regex(composer) && !composerIsBackgroundMode}}`; the run body
//   (offset 0x25fb22d) builds the Markdown below and calls
//   `trackEvent("composer.export_chat")` (command-telemetry category
//   `chat_management`).
// - 3.25.9: `composer.exportChatAsMd` at file offset 0xf2690b; the chat title
//   overflow menu registers `{id:"composer.exportChatAsMd",
//   label:"Export Transcript"}` (offset 0x1a437fe).
//
// HONEST-DIVERGENCES from the binary (product branding, not behavior):
// 1. File name: the binary hardcodes the `cursor_` prefix
//    (`cursor_<slug>.md`). This fork is "IDE Code", so the prefix is
//    `ide_code_`. The slug algorithm itself is verbatim.
// 2. Header: the binary writes `_Exported on … from Cursor (<version>)_`.
//    The fork writes `_Exported on … from <productName> (<version>)_` with
//    the real product name/version.

/** One fenced code block attached to an exported message. */
export interface ChatExportCodeBlock {
	readonly content: string;
	readonly languageId: string;
}

/** One clarifying question rendered by the binary's `DiI` renderer. */
export interface ChatExportQuestion {
	readonly id: string;
	readonly prompt: string;
	readonly options: ReadonlyArray<{ readonly id: string; readonly label: string }>;
}

/** The binary's ASK_QUESTION tool payload (`toolFormerData.params`). */
export interface ChatExportAskQuestion {
	readonly title?: string;
	readonly questions: ReadonlyArray<ChatExportQuestion>;
}

/** The binary's ASK_QUESTION tool result (`toolFormerData.result`). */
export interface ChatExportAskQuestionResult {
	readonly answers?: ReadonlyArray<{
		readonly questionId: string;
		readonly selectedOptionIds?: ReadonlyArray<string>;
		readonly freeformText?: string;
	}>;
}

/**
 * One message in Cursor's export model. `author` mirrors the binary's
 * `W.type===HUMAN ? "User" : "Cursor"` split.
 */
export interface ChatExportMessage {
	readonly author: 'User' | 'Cursor';
	readonly text: string;
	readonly codeBlocks: ReadonlyArray<ChatExportCodeBlock>;
	readonly askQuestion?: ChatExportAskQuestion;
}

/** A full transcript as produced by the chat-data owner (the extension). */
export interface ChatExportTranscript {
	readonly name: string;
	readonly messages: ReadonlyArray<ChatExportMessage>;
}

/**
 * Binary-verbatim file-name algorithm:
 * `` `cursor_${k.toLowerCase().replace(/[^a-z0-9]/g,"_").replace(/_+/g,"_")
 *     .substring(0,32).replace(/^_+|_+$/g,"")}.md` ``
 * with the `cursor_` prefix swapped for this fork's `ide_code_` prefix
 * (divergence #1 above).
 */
export function composerExportFileName(chatName: string): string {
	const slug = (chatName ?? '')
		.toLowerCase()
		.replace(/[^a-z0-9]/g, '_')
		.replace(/_+/g, '_')
		.substring(0, 32)
		.replace(/^_+|_+$/g, '');
	return `ide_code_${slug}.md`;
}

/**
 * Verbatim port of the binary's `DiI(t,e)` ASK_QUESTION renderer:
 * `**<title>**`, then per question `> **<prompt>**` and
 * `> - <label>[ ✔]` option lines (✔ = U+2714 on the selected options),
 * plus `> Answer: <freeformText>` when present.
 */
export function renderAskQuestionMarkdown(
	params: ChatExportAskQuestion,
	result?: ChatExportAskQuestionResult,
): string {
	let out = '';
	if (params.title) {
		out += `**${params.title}**\n\n`;
	}
	for (const question of params.questions ?? []) {
		// Binary quirk (DiI, Cursor 3.25.9): the prompt line is appended
		// unconditionally (comma operator); only the option loop is gated
		// on options.length. The answer lookup, the freeform `> Answer:`
		// block and the trailing `\n` sit OUTSIDE that gate.
		out += `> **${question.prompt}**\n`;
		const answer = result?.answers?.find(a => a.questionId === question.id);
		if (question.options.length > 0) {
			const selected = new Set(answer?.selectedOptionIds ?? []);
			for (const option of question.options) {
				const check = selected.has(option.id) ? ' ✔' : '';
				out += `> - ${option.label}${check}\n`;
			}
		}
		if (answer?.freeformText) {
			out += `>\n> Answer: ${answer.freeformText}\n`;
		}
		out += `\n`;
	}
	return out;
}

export interface ChatExportMarkdownOptions {
	readonly chatName: string;
	readonly productName: string;
	readonly appVersion: string;
	readonly exportedAt: Date;
	readonly messages: ReadonlyArray<ChatExportMessage>;
}

/**
 * Verbatim port of the binary's transcript builder:
 * - header `# <name>` + `_Exported on <date> at <time> from <product>
 *   (<version>)_` + `---` separator;
 * - bubbles with empty text, no code blocks and no ASK_QUESTION payload are
 *   skipped;
 * - consecutive same-author messages are grouped under one `**User**` /
 *   `**Cursor**` heading, author switches emit a `---` separator;
 * - code blocks render as fenced blocks with their language id.
 */
export function buildChatExportMarkdown(options: ChatExportMarkdownOptions): string {
	const { chatName, productName, appVersion, exportedAt, messages } = options;
	const dateStr = exportedAt.toLocaleDateString();
	const timeStr = exportedAt.toLocaleTimeString(undefined, { hour12: false, timeZoneName: 'short' });
	let out = `# ${chatName}\n_Exported on ${dateStr} at ${timeStr} from ${productName} (${appVersion})_\n\n---\n\n`;
	let prevAuthor: 'User' | 'Cursor' | undefined = undefined;
	let acc = '';
	for (const message of messages) {
		const author = message.author;
		const text = message.text || '';
		const hasAskQuestion = !!message.askQuestion;
		if (!text.trim() && (!message.codeBlocks || message.codeBlocks.length === 0) && !hasAskQuestion) {
			continue;
		}
		let rendered = '';
		if (text.trim()) {
			rendered += text + '\n\n';
		}
		if (hasAskQuestion && message.askQuestion) {
			rendered += renderAskQuestionMarkdown(message.askQuestion);
		}
		if (message.codeBlocks && message.codeBlocks.length > 0) {
			for (const block of message.codeBlocks) {
				const content = block.content;
				if (content && content.trim() !== '') {
					const language = (block.languageId ?? '').trim();
					rendered += '```' + language + '\n' + content + '\n```\n\n';
				}
			}
		}
		if (rendered.trim() !== '') {
			if (prevAuthor === undefined) {
				prevAuthor = author;
			}
			if (author === prevAuthor) {
				acc += rendered;
			} else {
				if (acc.trim() !== '') {
					out += `**${prevAuthor}**\n\n` + acc;
				}
				out += `---\n\n`;
				prevAuthor = author;
				acc = rendered;
			}
		}
	}
	if (acc.trim() !== '') {
		out += `**${prevAuthor}**\n\n` + acc;
	}
	return out;
}
