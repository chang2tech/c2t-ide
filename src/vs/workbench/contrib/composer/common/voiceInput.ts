/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// IDE-CODE: Cursor composer voice-dictation parity (feature matrix: agent-voice-dictation).
//
// Binary mechanism (Cursor 3.25.9, verified against workbench.desktop.main.js —
// the voice feature is registered in the DESKTOP bundle, not glass):
//
//   Service token:   vLe=Zu("voiceInputService")                      (@14329086 region)
//   Context key:     _dh=new Mt("voiceInputRecording",!1)             (@16723137)
//   Service class:   Qva (state machine, mic capture, stream session) (@31992069)
//   Commands:        gfm "composer.toggleVoiceDictation"              (@29975718)
//                    ffm "composer.cancelVoiceDictation"              (@29976011)
//   Recording cap:   YHS=300*1e3 (5 minutes)                          (@~31990844)
//   Hold threshold:  XHS=500 (ms)                                     (@~31990844)
//   Options builder: function GKp(e){return{ownerId:Ira(e.composerId,
//                    e.bubbleId),keywordDetectionEnabled:!0}}          (@27710393)
//   Owner-id format: function Ira(e,t){return`classic:${e}:${t??"main"}`} (@27710341)
//   Language config: voiceInputLanguage:pbe(ywt,-1,0), ywt=""         (config registry)
//                    resolveLanguage(){return sWv(ph(this.storageService,
//                    "voiceInputLanguage"))}, sWv(e)=>(e===ywt?void 0:e)
//   Error mapping:   getErrorCode / getUserFriendlyErrorMessage       (@31999315)
//
// This module is pure (ZERO imports, not even vs/base) so it can be unit
// tested standalone — same pattern as common/composerModeCommands.ts and
// common/shellAllowlistLabel.ts. Keep it that way. The DOM/platform half of
// the service lives in browser/voice/voiceInputService.ts.

/** Verbatim DI service name from the binary: `Zu("voiceInputService")`. */
export const VOICE_INPUT_SERVICE_ID = 'voiceInputService';

/**
 * Verbatim context key bound by the service: `_dh=new Mt("voiceInputRecording",!1)`.
 * True while recording, or while processing with a live stream session.
 */
export const VOICE_INPUT_RECORDING_CONTEXT_KEY = 'voiceInputRecording';

/** Verbatim configuration key (config registry: `voiceInputLanguage:pbe(ywt,-1,0)`, ywt=""). */
export const VOICE_INPUT_LANGUAGE_CONFIG_KEY = 'voiceInputLanguage';

/** Verbatim default of `voiceInputLanguage` (ywt=""); resolves to `undefined` = auto. */
export const VOICE_INPUT_LANGUAGE_DEFAULT = '';

/**
 * Verbatim getUserMedia audio constraints from the binary's start():
 * `navigator.mediaDevices.getUserMedia({audio:{deviceId:e.deviceId,
 * echoCancellation:!0,noiseSuppression:!0,autoGainControl:!0,
 * sampleRate:16e3,channelCount:1}})`.
 */
export const VOICE_INPUT_AUDIO_CONSTRAINTS = {
	audio: {
		echoCancellation: true,
		noiseSuppression: true,
		autoGainControl: true,
		sampleRate: 16000,
		channelCount: 1,
	},
} as const;

/** Verbatim worklet module URL in the binary: `$d.asBrowserUri("vs/workbench/contrib/composer/browser/voice/voice-processor.js")`. */
export const VOICE_INPUT_WORKLET_PATH = 'vs/workbench/contrib/composer/browser/voice/voice-processor.js';

/** Verbatim: `this.TARGET_CHUNK_BYTES=640` (20ms of 16kHz mono int16 PCM). */
export const VOICE_INPUT_TARGET_CHUNK_BYTES = 640;

/** Verbatim: `this.MAX_BUFFER_SIZE=50` (flush when this many chunks are buffered). */
export const VOICE_INPUT_MAX_BUFFER_SIZE = 50;

/** Verbatim recording cap: `YHS=300*1e3` — 5 minutes, then the session auto-stops. */
export const VOICE_INPUT_RECORDING_CAP_MS = 300_000;

/** Verbatim hold-to-talk grace: `XHS=500` ms in releaseHold(). */
export const VOICE_INPUT_HOLD_MIN_MS = 500;

/**
 * Verbatim voice service statuses from the binary (`o.status==="idle"`,
 * `"requesting_permission"`, `"recording"`, `"processing"`, `"error"`).
 */
export type VoiceInputStatus = 'idle' | 'requesting_permission' | 'recording' | 'processing' | 'error';

/** Verbatim error codes from the binary's getErrorCode(). */
export type VoiceInputErrorCode =
	| 'MICROPHONE_PERMISSION_DENIED'
	| 'AUDIO_DEVICE_UNAVAILABLE'
	| 'NETWORK_CONNECTION_FAILED'
	| 'SERVER_CONNECTION_FAILED'
	| 'SERVER_ERROR'
	| 'UNKNOWN'
	| 'TRANSCRIBER_NOT_CONFIGURED';

export interface VoiceInputErrorInfo {
	code: VoiceInputErrorCode;
	message: string;
	recoverable: boolean;
}

export interface VoiceInputState {
	status: VoiceInputStatus;
	ownerId?: string;
	deviceId?: string;
	error?: VoiceInputErrorInfo;
}

/** Verbatim transcript kinds fired on `_onTranscriptCommit`: "partial" | "segment" | "final". */
export type VoiceInputTranscriptKind = 'partial' | 'segment' | 'final';

export interface VoiceInputTranscriptCommit {
	text: string;
	kind: VoiceInputTranscriptKind;
	ownerId?: string;
}

/**
 * Start options. Binary `GKp(e)` builds `{ownerId:Ira(e.composerId,e.bubbleId),
 * keywordDetectionEnabled:!0}` — the ownerId is the binary's `Ira` output,
 * `classic:<composerId>:<bubbleId|"main">` (see buildVoiceInputOwnerId).
 */
export interface VoiceInputStartOptions {
	ownerId: string;
	deviceId?: string;
	keywordDetectionEnabled?: boolean;
	holdToTalk?: boolean;
}

/**
 * Verbatim port of the binary's `Ira` owner-id builder
 * (workbench.desktop.main.js @27710341):
 * `function Ira(e,t){return`classic:${e}:${t??"main"}`}` — the bubble segment
 * is `"main"` when no bubble is focused.
 */
export function buildVoiceInputOwnerId(composerId: string, bubbleId?: string): string {
	return `classic:${composerId}:${bubbleId ?? 'main'}`;
}

/**
 * Pure port of the binary's `GKp` options builder:
 * `function GKp(e){return{ownerId:Ira(e.composerId,e.bubbleId),keywordDetectionEnabled:!0}}`.
 *
 * The binary's call site always passes a composerId; the fork keeps the
 * parameter optional and substitutes `'composer'` when none is known
 * (IDE-CODE-only fallback, fed through the binary-verbatim `Ira` format).
 */
export function buildVoiceInputStartOptions(composerId?: string, bubbleId?: string): VoiceInputStartOptions {
	return {
		ownerId: buildVoiceInputOwnerId(composerId ?? 'composer', bubbleId),
		keywordDetectionEnabled: true,
	};
}

/**
 * Pure port of the binary's `setState`:
 *
 *   setState(e){
 *     const t={...this.state,...e};
 *     (t.status==="idle"||t.status==="error")&&(t.ownerId=void 0),
 *     t.status==="recording"&&this.state.status!=="recording"
 *       ?this.recordingStartedAt=Date.now()
 *       :t.status!=="recording"&&(this.recordingStartedAt=void 0),
 *     this.state=t,
 *     this.voiceInputRecordingKey.set(
 *       this.state.status==="recording"||
 *       this.state.status==="processing"&&this.streamSession!==void 0),
 *     this._onStateChanged.fire(this.state)}
 *
 * Returns the next state plus the value the `voiceInputRecording` context key
 * must take. `recordingStartedAt` tracking is the caller's responsibility
 * (the service records `Date.now()`); the pure function reports whether the
 * transition starts/stops a recording so the caller can update its clock.
 */
export function applyVoiceInputStatePatch(
	prev: VoiceInputState,
	patch: Partial<VoiceInputState>,
	nowMs: number,
	streamSessionActive: boolean,
	recordingStartedAt: number | undefined,
): { state: VoiceInputState; recordingContextKey: boolean; recordingStartedAt: number | undefined } {
	const state: VoiceInputState = { ...prev, ...patch };
	if (state.status === 'idle' || state.status === 'error') {
		state.ownerId = undefined;
	}
	let startedAt = recordingStartedAt;
	if (state.status === 'recording' && prev.status !== 'recording') {
		startedAt = nowMs;
	} else if (state.status !== 'recording') {
		startedAt = undefined;
	}
	const recordingContextKey =
		state.status === 'recording' || (state.status === 'processing' && streamSessionActive);
	return { state, recordingContextKey, recordingStartedAt: startedAt };
}

/**
 * Pure port of the binary's getErrorCode:
 * `e.name==="NotAllowedError"?"MICROPHONE_PERMISSION_DENIED":
 *  e.name==="NotFoundError"?"AUDIO_DEVICE_UNAVAILABLE":
 *  e.name==="AbortError"?"NETWORK_CONNECTION_FAILED":
 *  e.name==="ConnectError"||e.message.includes("ConnectError")?"SERVER_CONNECTION_FAILED":
 *  e.message.includes("HTTP 505")||e.message.includes("HTTP 500")?"SERVER_ERROR":"UNKNOWN"`.
 *
 * `TRANSCRIBER_NOT_CONFIGURED` is IDE-CODE-only (fork seam for the STT
 * backend — Cursor wires its AI client; see browser/voice/voiceInputService.ts).
 * The service raises errors named `TranscriberNotConfigured` for it.
 */
export function voiceInputErrorCode(error: { name?: string; message?: string }): VoiceInputErrorCode {
	const name = error.name ?? '';
	const message = error.message ?? '';
	if (name === 'NotAllowedError') {
		return 'MICROPHONE_PERMISSION_DENIED';
	}
	if (name === 'NotFoundError') {
		return 'AUDIO_DEVICE_UNAVAILABLE';
	}
	if (name === 'AbortError') {
		return 'NETWORK_CONNECTION_FAILED';
	}
	if (name === 'ConnectError' || message.includes('ConnectError')) {
		return 'SERVER_CONNECTION_FAILED';
	}
	if (message.includes('HTTP 505') || message.includes('HTTP 500')) {
		return 'SERVER_ERROR';
	}
	// IDE-CODE-only (fork seam; see above).
	if (name === 'TranscriberNotConfigured') {
		return 'TRANSCRIBER_NOT_CONFIGURED';
	}
	return 'UNKNOWN';
}

/**
 * Verbatim map from the binary's getUserFriendlyErrorMessage:
 *
 *   {MICROPHONE_PERMISSION_DENIED:"Microphone access denied. Please enable microphone permissions in your browser settings.",
 *    AUDIO_DEVICE_UNAVAILABLE:"No microphone found. Please connect a microphone and try again.",
 *    NETWORK_CONNECTION_FAILED:"Network connection failed. Please check your internet connection.",
 *    SERVER_CONNECTION_FAILED:"Failed to connect to voice service. Please try again.",
 *    SERVER_ERROR:"Voice service is temporarily unavailable. Please try again later.",
 *    UNKNOWN:"An error occurred with voice input. Please try again."}
 */
export const VOICE_INPUT_ERROR_MESSAGES: Record<VoiceInputErrorCode, string> = {
	MICROPHONE_PERMISSION_DENIED: 'Microphone access denied. Please enable microphone permissions in your browser settings.',
	AUDIO_DEVICE_UNAVAILABLE: 'No microphone found. Please connect a microphone and try again.',
	NETWORK_CONNECTION_FAILED: 'Network connection failed. Please check your internet connection.',
	SERVER_CONNECTION_FAILED: 'Failed to connect to voice service. Please try again.',
	SERVER_ERROR: 'Voice service is temporarily unavailable. Please try again later.',
	UNKNOWN: 'An error occurred with voice input. Please try again.',
	TRANSCRIBER_NOT_CONFIGURED: 'Voice dictation is not available in this build: no speech-to-text backend is configured.',
};

/**
 * Pure port of the binary's resolveLanguage: `sWv(ph(this.storageService,
 * "voiceInputLanguage"))` where `sWv(e)=>(e===ywt?void 0:e)` and `ywt=""`.
 * Empty/unset means "auto".
 */
export function resolveVoiceInputLanguage(raw: string | undefined): string | undefined {
	return raw === undefined || raw === VOICE_INPUT_LANGUAGE_DEFAULT ? undefined : raw;
}

/**
 * Keyword-detection arming rules from the binary's start():
 * `const i=e.keywordDetectionEnabled===!0&&n.length>0` (keywords from
 * `applicationUserPersistentStorage.voiceModeSubmitKeywords`),
 * `r=e.holdToTalk===!0`, `this.keywordDetectionHeld=i&&r`,
 * `i&&!r&&this.armKeywordDetection(e.ownerId)`.
 */
export function voiceInputKeywordArming(
	options: VoiceInputStartOptions,
	keywords: readonly string[],
): { armNow: boolean; held: boolean } {
	const enabled = options.keywordDetectionEnabled === true && keywords.length > 0;
	const holdToTalk = options.holdToTalk === true;
	return { armNow: enabled && !holdToTalk, held: enabled && holdToTalk };
}

/**
 * Pure port of the binary's forwardFinal:
 * `forwardFinal(e){const t=e.trim();t.length>0&&this.forwardTranscript(t,"final")}`.
 * Returns the commit to fire, or undefined when the final transcript is empty.
 */
export function voiceInputFinalCommit(ownerId: string | undefined, text: string): VoiceInputTranscriptCommit | undefined {
	const trimmed = text.trim();
	return trimmed.length > 0 ? { text: trimmed, kind: 'final', ownerId } : undefined;
}

// ---------------------------------------------------------------------------
// Command descriptors (binary-verbatim registration surface)
// ---------------------------------------------------------------------------

/**
 * Binary `gfm` (workbench.desktop.main.js @29975718):
 *
 *   id: "composer.toggleVoiceDictation"
 *   title: {value:"Toggle Voice Mode", original:"Toggle Voice Mode"}
 *   category: Yn.Cursor, f1:!0
 *   precondition: isGlass.negate()
 *   keybinding: {primary:CtrlCmd|Shift|Space, weight:201,
 *     when: isGlass.negate() && !terminalFocus}
 *
 * The `isGlass` conjuncts are desktop-only gating (this feature is registered
 * in the DESKTOP bundle; the fork is desktop-only, so the conjunct is dropped
 * — documented in browser/voiceDictationActions.ts).
 */
export const TOGGLE_VOICE_DICTATION_COMMAND_ID = 'composer.toggleVoiceDictation';
export const TOGGLE_VOICE_DICTATION_TITLE = 'Toggle Voice Mode';
export const TOGGLE_VOICE_DICTATION_IN_PALETTE = true;

/**
 * Binary `ffm` (workbench.desktop.main.js @29976011):
 *
 *   id: "composer.cancelVoiceDictation"
 *   title: {value:"Cancel Voice Mode", original:"Cancel Voice Mode"}
 *   category: Yn.Cursor, f1:!1
 *   keybinding: {primary:Escape, weight:201,
 *     when: (activeEditor=="workbench.editor.composer" ||
 *            (view=="workbench.panel.aichat.view" && composerIsVisible)) &&
 *           voiceInputRecording}
 *
 * Editor/view id mapping for the fork (binary → fork):
 *   "workbench.editor.composer" → "composer.chatEditor" (ComposerChatEditorPane.ID)
 *   "workbench.panel.aichat.view" → "composer.chat" (ComposerView.ID)
 * `composerIsVisible` has no fork equivalent and is dropped (the `view ==`
 * check already scopes to the visible chat surface); documented as an
 * accepted simplification.
 */
export const CANCEL_VOICE_DICTATION_COMMAND_ID = 'composer.cancelVoiceDictation';
export const CANCEL_VOICE_DICTATION_TITLE = 'Cancel Voice Mode';
export const CANCEL_VOICE_DICTATION_IN_PALETTE = false;

/** Verbatim keybinding weight from both actions: `weight:201`. */
export const VOICE_DICTATION_KEYBINDING_WEIGHT = 201;

/** Fork ids for the binary's editor/view references in the cancel when-clause. */
export const VOICE_DICTATION_COMPOSER_EDITOR_ID = 'composer.chatEditor';
export const VOICE_DICTATION_COMPOSER_VIEW_ID = 'composer.chat';

export interface VoiceDictationCommandDef {
	id: string;
	title: string;
	inPalette: boolean;
}

/** The two binary-registered composer voice commands. */
export const VOICE_DICTATION_COMMANDS: readonly VoiceDictationCommandDef[] = [
	{ id: TOGGLE_VOICE_DICTATION_COMMAND_ID, title: TOGGLE_VOICE_DICTATION_TITLE, inPalette: TOGGLE_VOICE_DICTATION_IN_PALETTE },
	{ id: CANCEL_VOICE_DICTATION_COMMAND_ID, title: CANCEL_VOICE_DICTATION_TITLE, inPalette: CANCEL_VOICE_DICTATION_IN_PALETTE },
];

/**
 * Verbatim settings-deep-link URLs used by the binary's microphone-permission
 * error UX (handleError):
 *   macOS:   "x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone"
 *   Windows: "ms-settings:privacy-microphone"
 * Otherwise a plain error notification is shown.
 */
export const VOICE_INPUT_MAC_MIC_SETTINGS_URL = 'x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone';
export const VOICE_INPUT_WINDOWS_MIC_SETTINGS_URL = 'ms-settings:privacy-microphone';

/**
 * Verbatim notification text from the binary's handleError (the product name is
 * injected by the caller): `"Cursor does not have access to your microphone.
 * Please enable in Settings."`.
 */
export function voiceInputMicDeniedMessage(appName: string): string {
	return `${appName} does not have access to your microphone. Please enable in Settings.`;
}

/** Storage key for submit keywords (binary: `applicationUserPersistentStorage.voiceModeSubmitKeywords`). */
export const VOICE_INPUT_SUBMIT_KEYWORDS_STORAGE_KEY = 'voiceModeSubmitKeywords';
