/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// IDE-CODE: Migrated — vscode API → DI (2026-10-19).
//
// vscode API → core mapping used here:
//   vscode.window.onDidWriteTerminalData      → ITerminalService.onAnyInstanceData
//       (multiplexed { instance, data }; the proposed per-terminal event does not exist
//       in core — subscribing once is cheaper than one listener per instance)
//   vscode.window.onDidCloseTerminal          → ITerminalService.onDidDisposeInstance
//   vscode.window.activeTerminal             → ITerminalService.activeInstance
//   vscode.window.createTerminal({ name, hideFromUser })
//       → ITerminalService.createTerminal({ config: { name, hideFromUser } })
//   terminal.sendText / terminal.show()       → ITerminalInstance.sendText /
//                                              ITerminalService.revealTerminal
//   terminal.creationOptions.shellPath        → ITerminalInstance.shellLaunchConfig.executable
//   vscode.window.showInputBox               → IQuickInputService.input
//   vscode.window.createInputBox (+buttons)  → IQuickInputService.createInputBox
//       (buttons use iconClass: ThemeIcon.asClassName — core IQuickInputButton
//       has no ThemeIcon iconPath)
//   vscode.window.showInformationMessage / showErrorMessage
//       → INotificationService.info / error
//   vscode.workspace.getConfiguration("ide.agent.terminal")
//       → IConfigurationService.getValue('ide.agent.terminal')
//   vscode.commands.executeCommand            → ICommandService.executeCommand
//
// Behavioral notes:
//   - createTerminal is async in core, so getBackgroundTerminal/execInBackground
//     became async (callers already treated them as promises via bgChain).
//   - BG_TIMEOUT_MS is inlined (10 min); the original read SHELL_BACKGROUND_TIMEOUT_MS
//     from agentRuntime.ts (CAT-A). Keep the values in sync.
//   - Composer collaboration surface is the structural ITerminalComposer interface,
//     satisfied by the migrated ComposerDataService (CAT-B, sibling agent).
//   - terminalUtils.ts (CAT-A) is copied verbatim into this folder.

import { Disposable } from '../../../../base/common/lifecycle.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IQuickInputService, IQuickInputButton } from '../../../../platform/quickinput/common/quickInput.js';
import { ITerminalInstance, ITerminalService } from '../../../contrib/terminal/browser/terminal.js';
import {
	buildRunWrapper,
	detectShellKind,
	escapeXmlAttr,
	extractRunOutput,
	parseRunEnd,
	stripAnsiText,
} from './terminalUtils.js';

/**
 * TerminalService — Cursor-style terminal integration for the agent.
 *
 * Cursor surface (docs + deep-docs-all.md):
 *   - Cmd+K prompt bar in the terminal (describe a command in plain language;
 *     Enter sends it to the agent with terminal context, Esc/insert puts the
 *     text into the terminal without running it)
 *   - @Terminal(s) mention attaching terminal output to chat
 *   - agent runs commands in the background and sees exit codes
 *   - commands editable before they run (via the existing approval card)
 *   - `terminal.enableAiChecks`-style setting gating AI access to terminals
 *
 * Implementation notes:
 * - Terminal *output* capture uses the core multiplexed onAnyInstanceData
 *   event — a per-terminal ring buffer feeds @Terminal and the background-run
 *   streamer.
 * - Background runs execute with a shell-family-aware wrapper
 *   (buildRunWrapper: posix/fish/powershell/cmd detected from
 *   shellLaunchConfig.executable) so `exit` inside the command cannot
 *   kill the terminal, and output is framed with
 *   __IDE_RUN_BEGIN__ / __IDE_RUN_END__=<code> markers so the exit code is
 *   recovered exactly and the echoed wrapper line is excluded from chat.
 */
const MAX_RAW_BUFFER = 256 * 1024;
/** Default cap for terminal chars attached as chat context. */
const DEFAULT_CONTEXT_CHARS = 20000; // curation restored 2026-10-19: tail window keeps @Terminal context focused; user-configurable via ide.agent.terminal.maxBufferChars
/**
 * Background command timeout — then Ctrl+C is sent.
 * DD-AR-10 (Cursor parity): 10 min = SHELL_BACKGROUND_TIMEOUT_MS.
 * (Foreground 30s / hard 24h / default 5min live in agentRuntime.ts; the
 * engine's own shell tool enforces them server-side.)
 */
const BG_TIMEOUT_MS = 10 * 60 * 1000;
/** Chat bubble refresh throttle while streaming (ms). */
const STREAM_FLUSH_MS = 500;

interface ActiveRun {
	raw: string;
	resolve: (exitCode: number) => void;
	reject: (err: Error) => void;
	timer: ReturnType<typeof setTimeout>;
	startedAt: number;
	bubbleId: string;
	lastFlush: number;
}

interface ITerminalConfig {
	maxBufferChars?: number;
	enableAiChecks?: boolean;
}

/**
 * Structural surface this service needs from the chat composer.
 * Satisfied by the migrated ComposerDataService (CAT-B, sibling agent).
 */
export interface ITerminalComposer {
	updateTerminalOutput(bubbleId: string, text: string): void;
	finishTerminalRun(bubbleId: string, exitCode: number, durationMs: number, timedOut: boolean): void;
	postTerminalRun(command: string): string;
	submit(text: string): void;
}

export class TerminalService extends Disposable {
	private readonly buffers = new Map<
		ITerminalInstance,
		{ chunks: string[]; total: number }
	>();
	private bgTerminal: ITerminalInstance | undefined;
	/** Serializes background runs — one at a time. */
	private bgChain: Promise<void> = Promise.resolve();
	private activeRun: ActiveRun | null = null;

	constructor(
		private readonly terminalService: ITerminalService,
		private readonly notificationService: INotificationService,
		private readonly quickInputService: IQuickInputService,
		private readonly configurationService: IConfigurationService,
		private readonly commandService: ICommandService,
		private readonly getComposer: () => ITerminalComposer,
	) {
		super();
	}

	/** The active tab's composer — terminal output always lands in the visible chat. */
	private get composer(): ITerminalComposer { return this.getComposer(); }

	/** Subscribe to terminal data/close events. Call once from the contribution. */
	initialize(): void {
		this._register(this.terminalService.onAnyInstanceData(({ instance, data }) =>
			this.onTerminalData(instance, data),
		));
		this._register(this.terminalService.onDidDisposeInstance((t) => this.onTerminalClosed(t)));
	}

	override dispose(): void {
		if (this.activeRun) {
			clearTimeout(this.activeRun.timer);
			this.activeRun = null;
		}
		this.buffers.clear();
		super.dispose();
	}

	// ---- output capture ----------------------------------------------------

	private onTerminalData(instance: ITerminalInstance, data: string): void {
		let buf = this.buffers.get(instance);
		if (!buf) {
			buf = { chunks: [], total: 0 };
			this.buffers.set(instance, buf);
		}
		buf.chunks.push(data);
		buf.total += data.length;
		while (buf.total > MAX_RAW_BUFFER && buf.chunks.length > 1) {
			const dropped = buf.chunks.shift();
			buf.total -= dropped ? dropped.length : 0;
		}

		if (this.activeRun && instance === this.bgTerminal) {
			const run = this.activeRun;
			run.raw += data;
			const now = Date.now();
			if (now - run.lastFlush >= STREAM_FLUSH_MS) {
				run.lastFlush = now;
				const display = extractRunOutput(run.raw);
				if (display !== null) {
					this.composer.updateTerminalOutput(run.bubbleId, display);
				}
			}
			const exitCode = parseRunEnd(run.raw);
			if (exitCode !== null) {
				this.activeRun = null;
				clearTimeout(run.timer);
				const display = extractRunOutput(run.raw) ?? '';
				this.composer.updateTerminalOutput(run.bubbleId, display);
				this.composer.finishTerminalRun(
					run.bubbleId,
					exitCode,
					Date.now() - run.startedAt,
					false,
				);
				run.resolve(exitCode);
			}
		}
	}

	private onTerminalClosed(t: ITerminalInstance): void {
		this.buffers.delete(t);
		if (this.bgTerminal === t) {
			this.bgTerminal = undefined;
			if (this.activeRun) {
				const run = this.activeRun;
				this.activeRun = null;
				clearTimeout(run.timer);
				this.composer.finishTerminalRun(
					run.bubbleId,
					-1,
					Date.now() - run.startedAt,
					false,
				);
				run.reject(new Error('the IDE Agent terminal was closed'));
			}
		}
	}

	private terminalConfig(): ITerminalConfig {
		return this.configurationService.getValue<ITerminalConfig>('ide.agent.terminal') ?? {};
	}

	/** Recent output of a terminal, ANSI-stripped, tail-capped. */
	getTerminalText(
		instance: ITerminalInstance,
	): { name: string; text: string } | undefined {
		const buf = this.buffers.get(instance);
		if (!buf || buf.total === 0) {
			return undefined;
		}
		const maxChars = this.terminalConfig().maxBufferChars ?? DEFAULT_CONTEXT_CHARS;
		const clean = stripAnsiText(buf.chunks.join(''));
		const text = clean.slice(Math.max(0, clean.length - maxChars));
		return text ? { name: instance.title, text } : undefined;
	}

	getActiveTerminalText(): { name: string; text: string } | undefined {
		const term = this.terminalService.activeInstance;
		return term ? this.getTerminalText(term) : undefined;
	}

	/**
	 * Expand `@Terminal` / `@Terminals` mentions in chat text into a context
	 * block with the active terminal's recent output (Cursor's @Terminals).
	 */
	expandTerminalMentions(text: string): string {
		if (!/(^|[\s(])@Terminals?\b/.test(text)) {
			return text;
		}
		const aiChecks = this.terminalConfig().enableAiChecks ?? true;
		let context: string;
		if (!aiChecks) {
			context =
				'(terminal context is disabled by ide.agent.terminal.enableAiChecks)';
		} else {
			const t = this.getActiveTerminalText();
			context = t
				? `<terminal name="${escapeXmlAttr(t.name)}">\n${t.text}\n</terminal>`
				: '(no active terminal with captured output)';
		}
		// Replacer function: context may contain `$` (shell prompts).
		return text.replace(/(^|[\s(])@Terminals?\b/g, (_m, p1: string) => p1 + context);
	}

	// ---- Cmd+K prompt bar in the terminal -----------------------------------

	/**
	 * Cursor's terminal Cmd+K: describe a command in plain language.
	 * Enter → sends to the agent with the terminal's output as context
	 * (commands are reviewed in the approval card before they run).
	 * Insert button → puts the text into the terminal without running it
	 * (Cursor's "Escape accepts into the terminal").
	 */
	async openTerminalPrompt(): Promise<void> {
		const term = this.terminalService.activeInstance;
		if (!term) {
			this.notificationService.info(
				'IDE Agent: open a terminal first, then press Cmd+K (Ctrl+K).',
			);
			return;
		}
		const input = this.quickInputService.createInputBox();
		input.title = 'Terminal AI command';
		input.prompt =
			'Describe the command in plain language. Enter sends it to the agent with terminal context; Esc accepts your text into the terminal without running it; the insert button does the same explicitly.';
		input.placeholder = 'e.g. find the largest files in this repo';
		const insertBtn: IQuickInputButton = {
			iconClass: ThemeIcon.asClassName({ id: 'insert' }),
			tooltip: 'Insert into terminal without running',
		};
		input.buttons = [insertBtn];
		let done = false;
		const close = () => {
			done = true;
			input.dispose();
		};
		input.onDidAccept(() => {
			const desc = input.value.trim();
			close();
			if (desc) {
				this.sendTerminalRequest(term, desc);
			}
		});
		input.onDidTriggerButton((btn) => {
			if (btn === insertBtn) {
				const desc = input.value.trim();
				close();
				if (desc) {
					void term.sendText(desc, false);
				}
				void this.terminalService.revealTerminal(term);
			}
		});
		input.onDidHide(() => {
			if (!done) {
				// Cursor parity: Escape accepts the typed text into the terminal
				// without running it (same as the insert button).
				const desc = input.value.trim();
				input.dispose();
				if (desc) {
					void term.sendText(desc, false);
					void this.terminalService.revealTerminal(term);
				}
			} else {
				input.dispose();
			}
		});
		input.show();
	}

	private sendTerminalRequest(term: ITerminalInstance, desc: string): void {
		const ctx = this.getTerminalText(term);
		const contextBlock = ctx
			? `<terminal name="${escapeXmlAttr(ctx.name)}">\n${ctx.text}\n</terminal>\n\n`
			: '';
		this.composer.submit(
			`${contextBlock}Terminal request: ${desc}\n\nRun the needed shell commands for this request via the shell tool. Present each command in the approval card before running so it can be reviewed.`,
		);
		void this.commandService.executeCommand('ideAgent.chatView.focus');
	}

	// ---- background command execution ---------------------------------------

	/**
	 * Run a shell command in the background "IDE Agent" terminal, streaming
	 * its output into the chat and reporting the exit code when done.
	 * Runs are serialized; a 10-minute timeout sends Ctrl+C.
	 */
	runBackgroundCommand(command?: string): Promise<void> {
		const task = async (): Promise<void> => {
			let cmd = (command ?? '').trim();
			if (!cmd) {
				const picked = await this.quickInputService.input({
					prompt: 'Run a command in the background (output streams to chat)',
					placeHolder: 'npm test',
				});
				if (!picked?.trim()) {
					return;
				}
				cmd = picked.trim();
			}
			try {
				await this.execInBackground(cmd);
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				this.notificationService.error(
					`IDE Agent: background command failed — ${message}`,
				);
			}
		};
		this.bgChain = this.bgChain.then(task, task);
		return this.bgChain;
	}

	private async getBackgroundTerminal(): Promise<ITerminalInstance> {
		if (!this.bgTerminal) {
			this.bgTerminal = await this.terminalService.createTerminal({
				config: { name: 'IDE Agent', hideFromUser: true },
			});
		}
		return this.bgTerminal;
	}

	private async execInBackground(cmd: string): Promise<void> {
		const term = await this.getBackgroundTerminal();
		const bubbleId = this.composer.postTerminalRun(cmd);
		const startedAt = Date.now();
		// Shell-family-aware wrapper: exit inside the command can't kill our
		// terminal, and the framing markers recover the exit code and exclude
		// the echoed wrapper line from the chat output.
		const kind = detectShellKind(term.shellLaunchConfig.executable);
		const wrapped = buildRunWrapper(cmd, kind);
		return new Promise<void>((resolve, reject) => {
			const timer = setTimeout(() => {
				const run = this.activeRun;
				this.activeRun = null;
				if (run) {
					void term.sendText('\u0003', false); // Ctrl+C
					const display = extractRunOutput(run.raw) ?? '';
					this.composer.updateTerminalOutput(run.bubbleId, display);
					this.composer.finishTerminalRun(
						run.bubbleId,
						-1,
						Date.now() - run.startedAt,
						true,
					);
					run.reject(new Error('timed out after 10 minutes (sent Ctrl+C)'));
				}
			}, BG_TIMEOUT_MS);
			this.activeRun = {
				raw: '',
				resolve: () => resolve(),
				reject,
				timer,
				startedAt,
				bubbleId,
				lastFlush: 0,
			};
			void term.sendText(wrapped, true);
		});
	}
}
