/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * design-mode-voice — Design Mode browser pill: voice input.
 *
 * REA spec (feature-matrix.json, P2): "Design Mode: voice input during runs" —
 * "Mic stays available during agent runs; queue changes by voice"
 * (evidence: deep-docs-all.md docs sweep 2026-10-18; changelog 3.1
 * "upgraded voice input (hold Ctrl+M, batch STT, waveform UI)").
 *
 * The mic button mounts in the Design Mode pill (owned by
 * {@link BrowserDesignModeContribution}). Dictation reuses the workbench
 * {@link IChatSpeechToTextService} (batch STT). The transcript is queued into
 * chat via {@link BrowserEditorChatIntegration.queueVoiceTranscript}, which
 * queues behind any in-flight agent request instead of replacing input — so
 * the mic stays usable while the agent runs.
 */

import { $ } from '../../../../../base/browser/dom.js';
import { mainWindow } from '../../../../../base/browser/window.js';
import { Button } from '../../../../../base/browser/ui/button/button.js';
import { localize } from '../../../../../nls.js';
import { ILogService } from '../../../../../platform/log/common/log.js';
import { ChatSpeechToTextState, IChatSpeechToTextService } from '../../../chat/browser/speechToText/chatSpeechToTextService.js';
import { BrowserEditor, BrowserEditorContribution } from '../browserEditor.js';
import { BrowserDesignModeContribution } from './browserDesignModeFeature.js';
import { BrowserEditorChatIntegration } from './browserEditorChatFeatures.js';

export class BrowserDesignModeVoiceContribution extends BrowserEditorContribution {

	private readonly _micButton: Button;

	constructor(
		editor: BrowserEditor,
		@IChatSpeechToTextService private readonly speechToTextService: IChatSpeechToTextService,
		@ILogService private readonly logService: ILogService,
	) {
		super(editor);

		this._micButton = this._register(new Button($('.browser-design-mode-mic'), {
			supportIcons: true,
			title: localize('browser.designModeMic', "Voice input: dictate a change; it will be queued for the agent"),
		}));
		this._micButton.element.classList.add('browser-design-mode-mic-button');
		this._updateMicAppearance();

		// Mount into the Design Mode pill's tool area (owned by the design-mode contribution).
		const designMode = editor.getContribution(BrowserDesignModeContribution);
		if (!designMode) {
			this.logService.warn('BrowserDesignModeVoiceContribution: no design-mode contribution found; mic not mounted.');
		} else {
			designMode.pillTools.appendChild(this._micButton.element);
		}

		this._register(this._micButton.onDidClick(() => void this._toggleDictation()));
		this._register(this.speechToTextService.onDidChangeState(() => this._updateMicAppearance()));
	}

	/**
	 * Toggle dictation. Click again to stop and queue the transcript.
	 * The button is never disabled by chat/agent busy state — the transcript is
	 * queued behind in-flight requests, which is the spec's "mic stays
	 * available during agent runs".
	 */
	private async _toggleDictation(): Promise<void> {
		if (this.speechToTextService.isBusy) {
			let transcript: string | undefined;
			try {
				transcript = await this.speechToTextService.stopAndTranscribe();
			} catch (error) {
				this.logService.error('Design Mode voice: failed to stop dictation', error);
				return;
			}
			const text = transcript?.trim();
			if (text) {
				await this._queueTranscript(text);
			}
			return;
		}
		try {
			await this.speechToTextService.start(mainWindow, 'chat');
		} catch (error) {
			this.logService.error('Design Mode voice: failed to start dictation', error);
		}
	}

	private async _queueTranscript(text: string): Promise<void> {
		const chatIntegration = this.editor.getContribution(BrowserEditorChatIntegration);
		if (!chatIntegration) {
			this.logService.warn('Design Mode voice: no chat integration found; transcript dropped.');
			return;
		}
		const queued = await chatIntegration.queueVoiceTranscript(text);
		if (!queued) {
			this.logService.warn('Design Mode voice: failed to queue transcript.');
		}
	}

	private _updateMicAppearance(): void {
		const configured = this.speechToTextService.isConfigured;
		this._micButton.element.style.display = configured ? '' : 'none';
		const recording = this.speechToTextService.state !== ChatSpeechToTextState.Idle;
		this._micButton.element.classList.toggle('recording', recording);
		this._micButton.label = recording ? '$(mic-filled)' : '$(mic)';
		this._micButton.element.setAttribute('aria-label', recording
			? localize('browser.designModeMicStop', "Stop voice input and queue for the agent")
			: localize('browser.designModeMic', "Voice input: dictate a change; it will be queued for the agent"));
	}
}

BrowserEditor.registerContribution(BrowserDesignModeVoiceContribution);
