/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import {
	VOICE_INPUT_SERVICE_ID,
	VOICE_INPUT_RECORDING_CONTEXT_KEY,
	VOICE_INPUT_LANGUAGE_CONFIG_KEY,
	VOICE_INPUT_LANGUAGE_DEFAULT,
	VOICE_INPUT_AUDIO_CONSTRAINTS,
	VOICE_INPUT_WORKLET_PATH,
	VOICE_INPUT_TARGET_CHUNK_BYTES,
	VOICE_INPUT_MAX_BUFFER_SIZE,
	VOICE_INPUT_RECORDING_CAP_MS,
	VOICE_INPUT_HOLD_MIN_MS,
	VOICE_INPUT_ERROR_MESSAGES,
	VOICE_INPUT_MAC_MIC_SETTINGS_URL,
	VOICE_INPUT_WINDOWS_MIC_SETTINGS_URL,
	VOICE_INPUT_SUBMIT_KEYWORDS_STORAGE_KEY,
	TOGGLE_VOICE_DICTATION_COMMAND_ID,
	TOGGLE_VOICE_DICTATION_TITLE,
	TOGGLE_VOICE_DICTATION_IN_PALETTE,
	CANCEL_VOICE_DICTATION_COMMAND_ID,
	CANCEL_VOICE_DICTATION_TITLE,
	CANCEL_VOICE_DICTATION_IN_PALETTE,
	VOICE_DICTATION_KEYBINDING_WEIGHT,
	VOICE_DICTATION_COMMANDS,
	VoiceInputState,
	VoiceInputStartOptions,
	applyVoiceInputStatePatch,
	voiceInputErrorCode,
	resolveVoiceInputLanguage,
	voiceInputKeywordArming,
	voiceInputFinalCommit,
	buildVoiceInputStartOptions,
	buildVoiceInputOwnerId,
	voiceInputMicDeniedMessage,
} from '../../common/voiceInput.js';

/**
 * WORKER-GAPS-54C (agent-voice-dictation) — Cursor parity for composer voice
 * dictation (Cursor 3.25.9, workbench.desktop.main.js).
 *
 * Binary evidence (offsets in workbench.desktop.main.js):
 *   vLe=Zu("voiceInputService")            @14002850 region (command consts)
 *   _dh=new Mt("voiceInputRecording",!1)   @16723137
 *   gfm "composer.toggleVoiceDictation"    @29975718
 *   ffm "composer.cancelVoiceDictation"    @29976011
 *   Qva voice service class               @31992069
 *   YHS=300*1e3 (recording cap), XHS=500   @~31990844
 *   GKp(e)={ownerId:Ira(...),keywordDetectionEnabled:!0}
 *   getErrorCode/getUserFriendlyErrorMessage @31999315
 *   voiceInputLanguage:pbe(ywt,-1,0), ywt=""
 *   worklet URL "vs/workbench/contrib/composer/browser/voice/voice-processor.js"
 */

suite('voiceInput (GAPS-54C) — verbatim binary constants', () => {

	test('DI service name is verbatim: voiceInputService', () => {
		assert.strictEqual(VOICE_INPUT_SERVICE_ID, 'voiceInputService');
	});

	test('context key is verbatim: voiceInputRecording', () => {
		assert.strictEqual(VOICE_INPUT_RECORDING_CONTEXT_KEY, 'voiceInputRecording');
	});

	test('config key + default are verbatim: voiceInputLanguage, ""', () => {
		assert.strictEqual(VOICE_INPUT_LANGUAGE_CONFIG_KEY, 'voiceInputLanguage');
		assert.strictEqual(VOICE_INPUT_LANGUAGE_DEFAULT, '');
	});

	test('getUserMedia audio constraints are verbatim', () => {
		assert.deepStrictEqual(VOICE_INPUT_AUDIO_CONSTRAINTS, {
			audio: {
				echoCancellation: true,
				noiseSuppression: true,
				autoGainControl: true,
				sampleRate: 16000,
				channelCount: 1,
			},
		});
	});

	test('worklet path is verbatim', () => {
		assert.strictEqual(VOICE_INPUT_WORKLET_PATH, 'vs/workbench/contrib/composer/browser/voice/voice-processor.js');
	});

	test('chunk constants are verbatim: 640 bytes, buffer 50', () => {
		assert.strictEqual(VOICE_INPUT_TARGET_CHUNK_BYTES, 640);
		assert.strictEqual(VOICE_INPUT_MAX_BUFFER_SIZE, 50);
	});

	test('recording cap = 5 min (YHS=300*1e3), hold threshold = 500ms (XHS=500)', () => {
		assert.strictEqual(VOICE_INPUT_RECORDING_CAP_MS, 300_000);
		assert.strictEqual(VOICE_INPUT_HOLD_MIN_MS, 500);
	});

	test('mic settings deep links are verbatim', () => {
		assert.strictEqual(VOICE_INPUT_MAC_MIC_SETTINGS_URL, 'x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone');
		assert.strictEqual(VOICE_INPUT_WINDOWS_MIC_SETTINGS_URL, 'ms-settings:privacy-microphone');
	});

	test('submit keywords storage key is verbatim', () => {
		assert.strictEqual(VOICE_INPUT_SUBMIT_KEYWORDS_STORAGE_KEY, 'voiceModeSubmitKeywords');
	});

	test('command descriptors: verbatim ids, titles, palette flags', () => {
		assert.strictEqual(TOGGLE_VOICE_DICTATION_COMMAND_ID, 'composer.toggleVoiceDictation');
		assert.strictEqual(TOGGLE_VOICE_DICTATION_TITLE, 'Toggle Voice Mode');
		assert.strictEqual(TOGGLE_VOICE_DICTATION_IN_PALETTE, true);
		assert.strictEqual(CANCEL_VOICE_DICTATION_COMMAND_ID, 'composer.cancelVoiceDictation');
		assert.strictEqual(CANCEL_VOICE_DICTATION_TITLE, 'Cancel Voice Mode');
		assert.strictEqual(CANCEL_VOICE_DICTATION_IN_PALETTE, false);
		assert.strictEqual(VOICE_DICTATION_KEYBINDING_WEIGHT, 201);
		assert.strictEqual(VOICE_DICTATION_COMMANDS.length, 2);
	});
});

suite('voiceInput (GAPS-54C) — GKp start-options builder', () => {

	test('keywordDetectionEnabled is always true (binary GKp)', () => {
		assert.strictEqual(buildVoiceInputStartOptions('c1').keywordDetectionEnabled, true);
		assert.strictEqual(buildVoiceInputStartOptions().keywordDetectionEnabled, true);
	});

	test('ownerId is the binary Ira format: classic:<composerId>:<bubbleId|"main">', () => {
		assert.strictEqual(buildVoiceInputStartOptions('c1', 'b2').ownerId, 'classic:c1:b2');
		assert.strictEqual(buildVoiceInputStartOptions('c1').ownerId, 'classic:c1:main');
	});

	test('ownerId falls back to "composer" when no composer is known (documented)', () => {
		assert.strictEqual(buildVoiceInputStartOptions().ownerId, 'classic:composer:main');
		assert.strictEqual(buildVoiceInputStartOptions(undefined, 'b2').ownerId, 'classic:composer:b2');
	});

	test('Ira port is binary-verbatim: classic:${e}:${t??"main"} (@27710341)', () => {
		assert.strictEqual(buildVoiceInputOwnerId('c1', 'b2'), 'classic:c1:b2');
		assert.strictEqual(buildVoiceInputOwnerId('c1'), 'classic:c1:main');
		assert.strictEqual(buildVoiceInputOwnerId('c1', undefined), 'classic:c1:main');
	});
});

suite('voiceInput (GAPS-54C) — setState port (applyVoiceInputStatePatch)', () => {

	const idle: VoiceInputState = { status: 'idle' };

	test('idle/error transitions clear ownerId', () => {
		const prev: VoiceInputState = { status: 'recording', ownerId: 'c1:b2' };
		const r1 = applyVoiceInputStatePatch(prev, { status: 'idle' }, 1000, false, 500);
		assert.strictEqual(r1.state.ownerId, undefined);
		const r2 = applyVoiceInputStatePatch(prev, { status: 'error', error: { code: 'UNKNOWN', message: 'x', recoverable: true } }, 1000, false, 500);
		assert.strictEqual(r2.state.ownerId, undefined);
	});

	test('non-idle/error transitions keep ownerId', () => {
		const prev: VoiceInputState = { status: 'recording', ownerId: 'c1:b2' };
		const r = applyVoiceInputStatePatch(prev, { status: 'processing' }, 1000, true, 500);
		assert.strictEqual(r.state.ownerId, 'c1:b2');
	});

	test('recordingStartedAt set when entering recording, cleared when leaving', () => {
		const r1 = applyVoiceInputStatePatch(idle, { status: 'recording' }, 1234, false, undefined);
		assert.strictEqual(r1.recordingStartedAt, 1234);
		const r2 = applyVoiceInputStatePatch({ status: 'recording' }, { status: 'processing' }, 2000, true, 1234);
		assert.strictEqual(r2.recordingStartedAt, undefined);
	});

	test('re-entering recording keeps the original startedAt (binary: only on transition)', () => {
		const prev: VoiceInputState = { status: 'recording' };
		const r = applyVoiceInputStatePatch(prev, { status: 'recording' }, 2000, false, 1234);
		assert.strictEqual(r.recordingStartedAt, 1234);
	});

	test('voiceInputRecording key: true while recording', () => {
		const r = applyVoiceInputStatePatch(idle, { status: 'recording' }, 1, false, undefined);
		assert.strictEqual(r.recordingContextKey, true);
	});

	test('voiceInputRecording key: processing+session => true, processing alone => false (binary edge)', () => {
		const prev: VoiceInputState = { status: 'recording' };
		assert.strictEqual(applyVoiceInputStatePatch(prev, { status: 'processing' }, 1, true, 5).recordingContextKey, true);
		assert.strictEqual(applyVoiceInputStatePatch(prev, { status: 'processing' }, 1, false, 5).recordingContextKey, false);
	});

	test('voiceInputRecording key: false when idle', () => {
		const r = applyVoiceInputStatePatch({ status: 'error' }, { status: 'idle' }, 1, false, undefined);
		assert.strictEqual(r.recordingContextKey, false);
	});
});

suite('voiceInput (GAPS-54C) — getErrorCode port (voiceInputErrorCode)', () => {

	test('NotAllowedError -> MICROPHONE_PERMISSION_DENIED', () => {
		assert.strictEqual(voiceInputErrorCode({ name: 'NotAllowedError', message: 'x' }), 'MICROPHONE_PERMISSION_DENIED');
	});

	test('NotFoundError -> AUDIO_DEVICE_UNAVAILABLE', () => {
		assert.strictEqual(voiceInputErrorCode({ name: 'NotFoundError', message: 'x' }), 'AUDIO_DEVICE_UNAVAILABLE');
	});

	test('AbortError -> NETWORK_CONNECTION_FAILED', () => {
		assert.strictEqual(voiceInputErrorCode({ name: 'AbortError', message: 'x' }), 'NETWORK_CONNECTION_FAILED');
	});

	test('ConnectError (name or message) -> SERVER_CONNECTION_FAILED', () => {
		assert.strictEqual(voiceInputErrorCode({ name: 'ConnectError', message: '' }), 'SERVER_CONNECTION_FAILED');
		assert.strictEqual(voiceInputErrorCode({ name: 'Error', message: 'wrap: ConnectError boom' }), 'SERVER_CONNECTION_FAILED');
	});

	test('HTTP 500/505 -> SERVER_ERROR', () => {
		assert.strictEqual(voiceInputErrorCode({ name: 'Error', message: 'HTTP 500 oops' }), 'SERVER_ERROR');
		assert.strictEqual(voiceInputErrorCode({ name: 'Error', message: 'HTTP 505 oops' }), 'SERVER_ERROR');
	});

	test('anything else -> UNKNOWN', () => {
		assert.strictEqual(voiceInputErrorCode({ name: 'Error', message: 'weird' }), 'UNKNOWN');
		assert.strictEqual(voiceInputErrorCode({}), 'UNKNOWN');
	});

	test('TranscriberNotConfigured -> TRANSCRIBER_NOT_CONFIGURED (IDE-CODE-only code)', () => {
		assert.strictEqual(voiceInputErrorCode({ name: 'TranscriberNotConfigured', message: 'x' }), 'TRANSCRIBER_NOT_CONFIGURED');
	});
});

suite('voiceInput (GAPS-54C) — getUserFriendlyErrorMessage port', () => {

	test('all six binary messages are verbatim', () => {
		assert.strictEqual(VOICE_INPUT_ERROR_MESSAGES.MICROPHONE_PERMISSION_DENIED, 'Microphone access denied. Please enable microphone permissions in your browser settings.');
		assert.strictEqual(VOICE_INPUT_ERROR_MESSAGES.AUDIO_DEVICE_UNAVAILABLE, 'No microphone found. Please connect a microphone and try again.');
		assert.strictEqual(VOICE_INPUT_ERROR_MESSAGES.NETWORK_CONNECTION_FAILED, 'Network connection failed. Please check your internet connection.');
		assert.strictEqual(VOICE_INPUT_ERROR_MESSAGES.SERVER_CONNECTION_FAILED, 'Failed to connect to voice service. Please try again.');
		assert.strictEqual(VOICE_INPUT_ERROR_MESSAGES.SERVER_ERROR, 'Voice service is temporarily unavailable. Please try again later.');
		assert.strictEqual(VOICE_INPUT_ERROR_MESSAGES.UNKNOWN, 'An error occurred with voice input. Please try again.');
	});
});

suite('voiceInput (GAPS-54C) — resolveVoiceInputLanguage (sWv)', () => {

	test('empty/unset resolves to undefined (auto)', () => {
		assert.strictEqual(resolveVoiceInputLanguage(''), undefined);
		assert.strictEqual(resolveVoiceInputLanguage(undefined), undefined);
	});

	test('non-empty passes through', () => {
		assert.strictEqual(resolveVoiceInputLanguage('en'), 'en');
		assert.strictEqual(resolveVoiceInputLanguage('vi'), 'vi');
	});
});

suite('voiceInput (GAPS-54C) — keyword detection arming', () => {

	const opts: VoiceInputStartOptions = { ownerId: 'c1', keywordDetectionEnabled: true };

	test('armed when enabled and keywords exist, not hold-to-talk', () => {
		assert.deepStrictEqual(voiceInputKeywordArming(opts, ['send it']), { armNow: true, held: false });
	});

	test('held (not armed) in hold-to-talk mode', () => {
		assert.deepStrictEqual(voiceInputKeywordArming({ ...opts, holdToTalk: true }, ['send it']), { armNow: false, held: true });
	});

	test('not armed without keywords or when disabled', () => {
		assert.deepStrictEqual(voiceInputKeywordArming(opts, []), { armNow: false, held: false });
		assert.deepStrictEqual(voiceInputKeywordArming({ ownerId: 'c1' }, ['send it']), { armNow: false, held: false });
	});
});

suite('voiceInput (GAPS-54C) — forwardFinal port', () => {

	test('trims and drops empty finals', () => {
		assert.strictEqual(voiceInputFinalCommit('c1', '   '), undefined);
		assert.strictEqual(voiceInputFinalCommit('c1', ''), undefined);
	});

	test('non-empty final becomes a commit with kind "final"', () => {
		assert.deepStrictEqual(voiceInputFinalCommit('c1:b2', '  hello world  '), {
			text: 'hello world',
			kind: 'final',
			ownerId: 'c1:b2',
		});
	});
});

suite('voiceInput (GAPS-54C) — mic-denied notification text', () => {

	test('message template matches the binary ("<App> does not have access to your microphone. Please enable in Settings.")', () => {
		assert.strictEqual(
			voiceInputMicDeniedMessage('IDE Code'),
			'IDE Code does not have access to your microphone. Please enable in Settings.');
	});
});
