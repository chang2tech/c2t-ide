/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// IDE-CODE: Cursor composer voice-dictation parity (feature matrix: agent-voice-dictation).
//
// Binary mechanism (Cursor 3.25.9, verified against workbench.desktop.main.js):
//
//   vLe=Zu("voiceInputService")                                    — DI token name
//   _dh=new Mt("voiceInputRecording",!1)                           — context key
//   Qva (constructor(e,t,n,i,r,s): aiService, contextKeyService,
//        notificationService, openerService, storageService,
//        reactiveStorageService)                                   (@31992069)
//   Events: onDidChangeMicrophoneReserved, onStateChanged, onError,
//           onTranscriptCommit, onSubmitRequested, onCancelled
//   Methods: start({ownerId,deviceId,keywordDetectionEnabled,holdToTalk}),
//            stop(), cancel(), releaseHold(), armKeywordDetection(ownerId),
//            endKeywordSession(), getAvailableDevices(), setDevice(id),
//            getMediaStream(), getState(), reserveMicrophone(),
//            releaseMicrophone(), isMicrophoneReserved(), recordedMs()
//
// The full binary excerpts this file ports are quoted in the method comments
// below. Divergences are marked HONEST-DIVERGENCE.

import { Emitter, Event } from '../../../../../base/common/event.js';
import { Disposable, IDisposable, toDisposable } from '../../../../../base/common/lifecycle.js';
import { AppResourcePath, FileAccess } from '../../../../../base/common/network.js';
import { isMacintosh, isWindows } from '../../../../../base/common/platform.js';
import { createDecorator } from '../../../../../platform/instantiation/common/instantiation.js';
import { ContextKeyExpr, IContextKey, IContextKeyService, RawContextKey } from '../../../../../platform/contextkey/common/contextkey.js';
import { INotificationService, Severity } from '../../../../../platform/notification/common/notification.js';
import { IOpenerService } from '../../../../../platform/opener/common/opener.js';
import { IProductService } from '../../../../../platform/product/common/productService.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { IStorageService, StorageScope } from '../../../../../platform/storage/common/storage.js';
import { URI } from '../../../../../base/common/uri.js';
import {
	VOICE_INPUT_SERVICE_ID,
	VOICE_INPUT_RECORDING_CONTEXT_KEY,
	VOICE_INPUT_LANGUAGE_CONFIG_KEY,
	VOICE_INPUT_AUDIO_CONSTRAINTS,
	VOICE_INPUT_WORKLET_PATH,
	VOICE_INPUT_MAX_BUFFER_SIZE,
	VOICE_INPUT_RECORDING_CAP_MS,
	VOICE_INPUT_HOLD_MIN_MS,
	VOICE_INPUT_ERROR_MESSAGES,
	VOICE_INPUT_MAC_MIC_SETTINGS_URL,
	VOICE_INPUT_WINDOWS_MIC_SETTINGS_URL,
	VOICE_INPUT_SUBMIT_KEYWORDS_STORAGE_KEY,
	VoiceInputState,
	VoiceInputStartOptions,
	VoiceInputTranscriptCommit,
	VoiceInputTranscriptKind,
	applyVoiceInputStatePatch,
	voiceInputErrorCode,
	resolveVoiceInputLanguage,
	voiceInputKeywordArming,
	voiceInputFinalCommit,
	voiceInputMicDeniedMessage,
} from '../../common/voiceInput.js';

export const IVoiceInputService = createDecorator<IVoiceInputService>(VOICE_INPUT_SERVICE_ID);

/** Outcome vocabulary of the streaming STT session — verbatim from the binary's onStreamSessionSettled. */
export type VoiceInputSttOutcome =
	| { kind: 'final'; text: string }
	| { kind: 'no-final'; lastPartial?: string }
	| { kind: 'cancelled' }
	| { kind: 'error'; error: Error };

/**
 * Streaming speech-to-text backend seam.
 *
 * Binary: the service builds `new zHS({streamStt: async (s,o) =>
 * (await this.aiService.aiClient()).streamStt(s, {signal:o}), ...})` — the
 * transcription backend is Cursor's own AI client. The fork has no such
 * backend, so it is expressed as this interface instead; the rest of the
 * service ports the binary 1:1 around it.
 *
 * HONEST-DIVERGENCE: the fork ships no backend by default — the contribution
 * registers {@link NullVoiceInputTranscriptionBackend} (`isAvailable=false`),
 * so `start()` moves to the `error` state with the fork-only code
 * `TRANSCRIBER_NOT_CONFIGURED` until a real backend is registered (it would
 * override the singleton registration). The fork's DI has no `optional`
 * decorator, so the seam is a capability flag, not an absent service.
 */
export const IVoiceInputTranscriptionBackend = createDecorator<IVoiceInputTranscriptionBackend>('voiceInputTranscriptionBackend');

export interface IVoiceInputTranscriptionBackend {
	readonly _serviceBrand: undefined;
	/** False when this backend cannot transcribe (e.g. the null backend). */
	readonly isAvailable: boolean;
	streamStt(
		stream: AsyncIterable<Uint8Array>,
		options: { signal: AbortSignal; language?: string; keyterms: string[] },
	): Promise<{
		readonly onPartial: Event<string>;
		readonly onSegment: Event<string>;
		readonly outcome: Promise<VoiceInputSttOutcome>;
	}>;
}

/**
 * Default backend: reports itself unavailable. Registered by the composer
 * contribution so the DI graph always resolves; a real backend (engine /
 * cloud STT) overrides the `IVoiceInputTranscriptionBackend` singleton.
 */
export class NullVoiceInputTranscriptionBackend implements IVoiceInputTranscriptionBackend {

	declare readonly _serviceBrand: undefined;

	readonly isAvailable = false;

	async streamStt(): Promise<{
		readonly onPartial: Event<string>;
		readonly onSegment: Event<string>;
		readonly outcome: Promise<VoiceInputSttOutcome>;
	}> {
		const error = new Error(VOICE_INPUT_ERROR_MESSAGES.TRANSCRIBER_NOT_CONFIGURED);
		error.name = 'TranscriberNotConfigured';
		throw error;
	}
}

/**
 * Keyword detector (submit-keywords / wake-word). The binary arms one via
 * `buildDetector(ownerId)` when `keywordDetectionEnabled && keywords.length>0`;
 * its ML internals are not statically recoverable, so the fork ships a
 * phrase-matching default behind this seam.
 */
export interface IVoiceInputKeywordDetector extends IDisposable {
	start(): void;
	handleTranscript(text: string, kind: VoiceInputTranscriptKind): void;
}

export interface IVoiceInputService {
	readonly _serviceBrand: undefined;
	readonly onDidChangeMicrophoneReserved: Event<boolean>;
	readonly onStateChanged: Event<VoiceInputState>;
	readonly onError: Event<Error>;
	readonly onTranscriptCommit: Event<VoiceInputTranscriptCommit>;
	readonly onSubmitRequested: Event<{ ownerId: string | undefined }>;
	readonly onCancelled: Event<{ ownerId: string | undefined }>;
	getState(): VoiceInputState;
	start(options: VoiceInputStartOptions): Promise<void>;
	stop(): Promise<void>;
	cancel(): Promise<void>;
	releaseHold(): Promise<void>;
	getAvailableDevices(): Promise<MediaDeviceInfo[]>;
	setDevice(deviceId: string): Promise<void>;
	getMediaStream(): MediaStream | undefined;
	reserveMicrophone(): IDisposable;
	isMicrophoneReserved(): boolean;
	recordedMs(): number;
}

/**
 * Default phrase-matching keyword detector: forwards every transcript to the
 * commit sink, and when a configured submit keyword appears, asks the service
 * to submit (stop) the session.
 *
 * HONEST-DIVERGENCE: the binary's `buildDetector` ML semantics are not
 * recoverable; this is a best-effort port of the observable behavior
 * (keywords from `voiceModeSubmitKeywords`, `_onSubmitRequested` event).
 */
class SubmitKeywordDetector extends Disposable implements IVoiceInputKeywordDetector {
	constructor(
		private readonly keywords: readonly string[],
		private readonly onKeyword: () => void,
		private readonly forward: (text: string, kind: VoiceInputTranscriptKind) => void,
	) {
		super();
	}
	start(): void { /* phrase matching needs no warmup */ }
	handleTranscript(text: string, kind: VoiceInputTranscriptKind): void {
		this.forward(text, kind);
		const lowered = text.toLowerCase();
		if (this.keywords.some(k => k.length > 0 && lowered.includes(k.toLowerCase()))) {
			this.onKeyword();
		}
	}
}

/**
 * Port of the binary's `zHS` stream-session wrapper:
 * `new zHS({streamStt, config:{language, keyterms}, onPartial, onSegment})`,
 * `r.outcome.then(s=>this.onStreamSessionSettled(r,s))`, `e.pushChunk(t)`,
 * `e.stop()`, `e.cancel()`, `await e.outcome`.
 */
class VoiceInputSttStreamSession extends Disposable {
	readonly outcome: Promise<VoiceInputSttOutcome>;
	private readonly chunkQueue: Uint8Array[] = [];
	private chunkWaiters: Array<() => void> = [];
	private closed = false;
	private result: { readonly onPartial: Event<string>; readonly onSegment: Event<string>; readonly outcome: Promise<VoiceInputSttOutcome> } | undefined;

	constructor(
		private readonly backend: IVoiceInputTranscriptionBackend,
		private readonly language: string | undefined,
		private readonly keyterms: string[],
		private readonly signal: AbortSignal,
		private readonly onPartial: (text: string) => void,
		private readonly onSegment: (text: string) => void,
	) {
		super();
		this.outcome = this.run();
	}

	private async *chunks(): AsyncIterable<Uint8Array> {
		while (!this.closed || this.chunkQueue.length > 0) {
			const next = this.chunkQueue.shift();
			if (next) {
				yield next;
			} else if (!this.closed) {
				await new Promise<void>(resolve => this.chunkWaiters.push(resolve));
			}
		}
	}

	private async run(): Promise<VoiceInputSttOutcome> {
		try {
			this.result = await this.backend.streamStt(this.chunks(), { signal: this.signal, language: this.language, keyterms: this.keyterms });
			const d1 = this.result.onPartial(text => this.onPartial(text));
			const d2 = this.result.onSegment(text => this.onSegment(text));
			try {
				return await this.result.outcome;
			} finally {
				d1.dispose();
				d2.dispose();
			}
		} catch (e) {
			if (this.signal.aborted) {
				return { kind: 'cancelled' };
			}
			return { kind: 'error', error: e instanceof Error ? e : new Error(String(e)) };
		}
	}

	pushChunk(bytes: Uint8Array): void {
		if (this.closed) {
			return;
		}
		this.chunkQueue.push(bytes);
		const waiter = this.chunkWaiters.shift();
		waiter?.();
	}

	stop(): void {
		this.closed = true;
		while (this.chunkWaiters.length > 0) {
			this.chunkWaiters.shift()?.();
		}
	}

	cancel(): void {
		this.stop();
	}
}

export class VoiceInputService extends Disposable implements IVoiceInputService {

	declare readonly _serviceBrand: undefined;

	private readonly _onDidChangeMicrophoneReserved = this._register(new Emitter<boolean>());
	readonly onDidChangeMicrophoneReserved: Event<boolean> = this._onDidChangeMicrophoneReserved.event;

	private readonly _onStateChanged = this._register(new Emitter<VoiceInputState>());
	readonly onStateChanged: Event<VoiceInputState> = this._onStateChanged.event;

	private readonly _onError = this._register(new Emitter<Error>());
	readonly onError: Event<Error> = this._onError.event;

	private readonly _onTranscriptCommit = this._register(new Emitter<VoiceInputTranscriptCommit>());
	readonly onTranscriptCommit: Event<VoiceInputTranscriptCommit> = this._onTranscriptCommit.event;

	private readonly _onSubmitRequested = this._register(new Emitter<{ ownerId: string | undefined }>());
	readonly onSubmitRequested: Event<{ ownerId: string | undefined }> = this._onSubmitRequested.event;

	private readonly _onCancelled = this._register(new Emitter<{ ownerId: string | undefined }>());
	readonly onCancelled: Event<{ ownerId: string | undefined }> = this._onCancelled.event;

	private state: VoiceInputState = { status: 'idle' };
	private readonly voiceInputRecordingKey: IContextKey<boolean>;
	private currentOptions: VoiceInputStartOptions | undefined;
	private currentOwnerId: string | undefined;
	private keywordDetector: IVoiceInputKeywordDetector | undefined;
	private keywordDetectionHeld = false;
	private microphoneReservations = 0;
	private startRequestId = 0;
	private mediaStream: MediaStream | undefined;
	private audioContext: AudioContext | undefined;
	private sourceNode: MediaStreamAudioSourceNode | undefined;
	private processorNode: AudioWorkletNode | undefined;
	private audioBuffer: Uint8Array[] = [];
	private accumulatedBytes = 0;
	private streamSession: VoiceInputSttStreamSession | undefined;
	private sessionAbort: AbortController | undefined;
	private recordingCapTimer: ReturnType<typeof setTimeout> | undefined;
	private recordingStartedAt: number | undefined;

	constructor(
		@IContextKeyService contextKeyService: IContextKeyService,
		@INotificationService private readonly notificationService: INotificationService,
		@IOpenerService private readonly openerService: IOpenerService,
		@IStorageService private readonly storageService: IStorageService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@IProductService private readonly productService: IProductService,
		@IVoiceInputTranscriptionBackend private readonly transcriptionBackend: IVoiceInputTranscriptionBackend,
	) {
		super();
		// Binary: `this.voiceInputRecordingKey=_dh.bindTo(t)` where
		// `_dh=new Mt("voiceInputRecording",!1)`.
		this.voiceInputRecordingKey = new RawContextKey<boolean>(VOICE_INPUT_RECORDING_CONTEXT_KEY, false).bindTo(contextKeyService);
	}

	// -- state ----------------------------------------------------------------

	getState(): VoiceInputState {
		return this.state;
	}

	/**
	 * Pure port of the binary's setState:
	 * merges the patch, clears ownerId on idle/error, tracks
	 * recordingStartedAt, syncs the `voiceInputRecording` context key, and
	 * fires onStateChanged.
	 */
	private setState(patch: Partial<VoiceInputState>): void {
		const { state, recordingContextKey, recordingStartedAt } = applyVoiceInputStatePatch(
			this.state, patch, Date.now(),
			this.streamSession !== undefined, this.recordingStartedAt);
		this.recordingStartedAt = recordingStartedAt;
		this.state = state;
		this.voiceInputRecordingKey.set(recordingContextKey);
		this._onStateChanged.fire(this.state);
	}

	recordedMs(): number {
		return this.recordingStartedAt !== undefined ? Date.now() - this.recordingStartedAt : 0;
	}

	// -- microphone reservation (binary: reserveMicrophone/releaseMicrophone) -

	reserveMicrophone(): IDisposable {
		this.microphoneReservations++;
		this._onDidChangeMicrophoneReserved.fire(this.microphoneReservations > 0);
		let released = false;
		return toDisposable(() => {
			if (released) {
				return;
			}
			released = true;
			this.microphoneReservations = Math.max(0, this.microphoneReservations - 1);
			this._onDidChangeMicrophoneReserved.fire(this.microphoneReservations > 0);
		});
	}

	isMicrophoneReserved(): boolean {
		return this.microphoneReservations > 0;
	}

	// -- session lifecycle -----------------------------------------------------

	/**
	 * Binary start():
	 * ```
	 * async start(e){
	 *   if(this.microphoneReservations>0||
	 *      this.state.status!=="idle"&&this.state.status!=="error")return;
	 *   const t=++this.startRequestId,
	 *     n=c1r(this.reactiveStorageService.applicationUserPersistentStorage.voiceModeSubmitKeywords),
	 *     i=e.keywordDetectionEnabled===!0&&n.length>0,
	 *     r=e.holdToTalk===!0;
	 *   this.currentOptions=e,this.keywordDetector?.dispose(),
	 *   this.keywordDetector=void 0,this.keywordDetectionHeld=i&&r,
	 *   this.currentOwnerId=e.ownerId,
	 *   i&&!r&&this.armKeywordDetection(e.ownerId),
	 *   this.setState({status:"requesting_permission",ownerId:e.ownerId});
	 *   try{
	 *     const s=await navigator.mediaDevices.getUserMedia({audio:{deviceId:e.deviceId,
	 *       echoCancellation:!0,noiseSuppression:!0,autoGainControl:!0,sampleRate:16e3,channelCount:1}});
	 *     if(t!==this.startRequestId){s.getTracks().forEach(o=>o.stop());return}
	 *     this.mediaStream=s,await this.startStream(s,t,n)
	 *   }catch(s){
	 *     if(t!==this.startRequestId)return;
	 *     this.endKeywordSession(),this.stopStreamCapture();
	 *     const o=s instanceof Error&&s.name==="NotAllowedError";
	 *     this.handleError(s,!o)
	 *   }}
	 * ```
	 *
	 * HONEST-DIVERGENCE: `reactiveStorageService.applicationUserPersistentStorage`
	 * has no fork equivalent; submit keywords are read from IStorageService
	 * (APPLICATION scope, JSON array).
	 */
	async start(options: VoiceInputStartOptions): Promise<void> {
		if (this.microphoneReservations > 0 || (this.state.status !== 'idle' && this.state.status !== 'error')) {
			return;
		}
		if (!this.transcriptionBackend.isAvailable) {
			const error = new Error(VOICE_INPUT_ERROR_MESSAGES.TRANSCRIBER_NOT_CONFIGURED);
			error.name = 'TranscriberNotConfigured';
			this.setState({ status: 'error', ownerId: options.ownerId, error: { code: 'TRANSCRIBER_NOT_CONFIGURED', message: error.message, recoverable: false } });
			this._onError.fire(error);
			return;
		}
		const requestId = ++this.startRequestId;
		const keywords = this.readSubmitKeywords();
		const { armNow, held } = voiceInputKeywordArming(options, keywords);
		this.currentOptions = options;
		this.keywordDetector?.dispose();
		this.keywordDetector = undefined;
		this.keywordDetectionHeld = held;
		this.currentOwnerId = options.ownerId;
		if (armNow) {
			this.armKeywordDetection(options.ownerId, keywords);
		}
		this.setState({ status: 'requesting_permission', ownerId: options.ownerId });
		try {
			const stream = await navigator.mediaDevices.getUserMedia({
				audio: { ...VOICE_INPUT_AUDIO_CONSTRAINTS.audio, deviceId: options.deviceId },
			});
			if (requestId !== this.startRequestId) {
				stream.getTracks().forEach(track => track.stop());
				return;
			}
			this.mediaStream = stream;
			await this.startStream(stream, requestId, keywords);
		} catch (e) {
			if (requestId !== this.startRequestId) {
				return;
			}
			this.endKeywordSession();
			this.stopStreamCapture();
			const denied = e instanceof Error && e.name === 'NotAllowedError';
			this.handleError(e instanceof Error ? e : new Error(String(e)), !denied);
		}
	}

	/**
	 * Binary stop():
	 * ```
	 * async stop(){
	 *   if(this.state.status==="requesting_permission"){this.cancelSession();return}
	 *   if(this.state.status==="processing"&&this.streamSession!==void 0){
	 *     await this.streamSession.outcome;return}
	 *   const e=this.streamSession;
	 *   if(this.state.status!=="recording"||e===void 0)return;
	 *   this.setState({status:"processing"});
	 *   const t=this.flushBuffer();
	 *   t.length>0&&e.pushChunk(t),
	 *   this.stopStreamCapture(),e.stop(),await e.outcome}
	 * ```
	 */
	async stop(): Promise<void> {
		if (this.state.status === 'requesting_permission') {
			this.cancelSession();
			return;
		}
		if (this.state.status === 'processing' && this.streamSession !== undefined) {
			await this.streamSession.outcome;
			return;
		}
		const session = this.streamSession;
		if (this.state.status !== 'recording' || session === undefined) {
			return;
		}
		this.setState({ status: 'processing' });
		const flushed = this.flushBuffer();
		if (flushed.length > 0) {
			session.pushChunk(flushed);
		}
		this.stopStreamCapture();
		session.stop();
		await session.outcome;
	}

	/**
	 * Binary cancel():
	 * ```
	 * async cancel(){
	 *   const{ownerId:e}=this.state;
	 *   e!==void 0&&this._onCancelled.fire({ownerId:e}),this.cancelSession()}
	 * ```
	 */
	async cancel(): Promise<void> {
		const { ownerId } = this.state;
		if (ownerId !== undefined) {
			this._onCancelled.fire({ ownerId });
		}
		this.cancelSession();
	}

	/**
	 * Binary releaseHold():
	 * ```
	 * async releaseHold(){
	 *   const{status:e}=this.state;
	 *   if(!(e==="requesting_permission"||e==="recording"&&this.recordedMs()<XHS)){
	 *     await this.stop();return}
	 *   const n=this.currentOptions;
	 *   n!==void 0&&(this.currentOptions={...n,holdToTalk:!1},
	 *     this.keywordDetectionHeld&&(
	 *       this.keywordDetectionHeld=!1,this.armKeywordDetection(n.ownerId)))}
	 * ```
	 */
	async releaseHold(): Promise<void> {
		const { status } = this.state;
		if (!(status === 'requesting_permission' || (status === 'recording' && this.recordedMs() < VOICE_INPUT_HOLD_MIN_MS))) {
			await this.stop();
			return;
		}
		const options = this.currentOptions;
		if (options !== undefined) {
			this.currentOptions = { ...options, holdToTalk: false };
			if (this.keywordDetectionHeld) {
				this.keywordDetectionHeld = false;
				this.armKeywordDetection(options.ownerId, this.readSubmitKeywords());
			}
		}
	}

	// -- keyword detection ------------------------------------------------------

	private armKeywordDetection(ownerId: string, keywords: readonly string[]): void {
		this.keywordDetector = this._register(new SubmitKeywordDetector(
			keywords,
			() => {
				this._onSubmitRequested.fire({ ownerId });
				void this.stop();
			},
			(text, kind) => this.forwardTranscript(text, kind),
		));
		this.keywordDetector.start();
	}

	private endKeywordSession(): void {
		this.keywordDetector?.dispose();
		this.keywordDetector = undefined;
		this.keywordDetectionHeld = false;
		this.currentOwnerId = undefined;
	}

	private readSubmitKeywords(): string[] {
		try {
			const raw = this.storageService.get(VOICE_INPUT_SUBMIT_KEYWORDS_STORAGE_KEY, StorageScope.APPLICATION);
			if (!raw) {
				return [];
			}
			const parsed: unknown = JSON.parse(raw);
			return Array.isArray(parsed) ? parsed.filter((k): k is string => typeof k === 'string') : [];
		} catch {
			return [];
		}
	}

	// -- audio capture ----------------------------------------------------------

	private resolveLanguage(): string | undefined {
		return resolveVoiceInputLanguage(
			this.configurationService.getValue<string | undefined>(VOICE_INPUT_LANGUAGE_CONFIG_KEY));
	}

	/**
	 * Binary initAudioContext:
	 * ```
	 * async initAudioContext(e){
	 *   const t=new AudioContext({sampleRate:16e3}),
	 *     n=t.createMediaStreamSource(e);
	 *   let i;
	 *   try{
	 *     const r=$d.asBrowserUri("vs/workbench/contrib/composer/browser/voice/voice-processor.js").toString(!0);
	 *     await t.audioWorklet.addModule(r);
	 *     const s=new AudioWorkletNode(t,"voice-processor");
	 *     s.port.onmessage=o=>{this.handleAudioChunk(new Uint8Array(o.data))};
	 *     ...
	 * ```
	 */
	private async initAudioContext(stream: MediaStream): Promise<{ audioContext: AudioContext; sourceNode: MediaStreamAudioSourceNode; processorNode: AudioWorkletNode }> {
		const w = window as unknown as { AudioContext?: typeof AudioContext; webkitAudioContext?: typeof AudioContext };
		const AC = w.AudioContext ?? w.webkitAudioContext;
		if (!AC) {
			throw new Error('AudioContext is not available in this environment.');
		}
		const audioContext = new AC({ sampleRate: VOICE_INPUT_AUDIO_CONSTRAINTS.audio.sampleRate });
		const sourceNode = audioContext.createMediaStreamSource(stream);
		const workletUrl = FileAccess.asBrowserUri(VOICE_INPUT_WORKLET_PATH as AppResourcePath).toString(true);
		await audioContext.audioWorklet.addModule(workletUrl);
		const processorNode = new AudioWorkletNode(audioContext, 'voice-processor');
		processorNode.port.onmessage = (event: MessageEvent) => {
			this.handleAudioChunk(new Uint8Array(event.data as ArrayBuffer));
		};
		sourceNode.connect(processorNode);
		processorNode.connect(audioContext.destination);
		return { audioContext, sourceNode, processorNode };
	}

	private handleAudioChunk(bytes: Uint8Array): void {
		this.audioBuffer.push(bytes);
		this.accumulatedBytes += bytes.length;
		if (this.audioBuffer.length >= VOICE_INPUT_MAX_BUFFER_SIZE) {
			const flushed = this.flushBuffer();
			if (flushed.length > 0) {
				this.streamSession?.pushChunk(flushed);
			}
		}
	}

	private flushBuffer(): Uint8Array {
		if (this.audioBuffer.length === 0) {
			return new Uint8Array(0);
		}
		const out = new Uint8Array(this.accumulatedBytes);
		let offset = 0;
		for (const chunk of this.audioBuffer) {
			out.set(chunk, offset);
			offset += chunk.length;
		}
		this.audioBuffer = [];
		this.accumulatedBytes = 0;
		return out;
	}

	private stopStreamCapture(): void {
		this.mediaStream?.getTracks().forEach(track => track.stop());
		this.mediaStream = undefined;
		if (this.audioContext !== undefined && this.sourceNode !== undefined && this.processorNode !== undefined) {
			try { this.processorNode.disconnect(); } catch { /* noop */ }
			try { this.sourceNode.disconnect(); } catch { /* noop */ }
			if (this.audioContext.state !== 'closed') {
				void this.audioContext.close().catch(() => { /* noop */ });
			}
		}
		this.audioContext = undefined;
		this.processorNode = undefined;
		this.sourceNode = undefined;
		this.audioBuffer = [];
		this.accumulatedBytes = 0;
	}

	// -- streaming session ------------------------------------------------------

	/**
	 * Binary startStream:
	 * ```
	 * async startStream(e,t,n){
	 *   const i=await this.initAudioContext(e);
	 *   if(t!==this.startRequestId){this.discardCapture(i,e);return}
	 *   this.commitCapture(i);
	 *   const r=new zHS({streamStt:async(s,o)=>(await this.aiService.aiClient()).streamStt(s,{signal:o}),
	 *     config:{language:this.resolveLanguage(),keyterms:this.keywordDetector!==void 0?n:[]},
	 *     onPartial:s=>this.forwardTranscript(s,"partial"),
	 *     onSegment:s=>this.forwardTranscript(s,"segment")});
	 *   this.streamSession=r,
	 *   this.recordingCapTimer.value=nl(()=>void this.stop(),YHS),
	 *   this.setState({status:"recording"}),
	 *   r.outcome.then(s=>this.onStreamSessionSettled(r,s))}
	 * ```
	 *
	 * HONEST-DIVERGENCE: `aiService.aiClient().streamStt` is Cursor's cloud
	 * backend; here it is the injected IVoiceInputTranscriptionBackend.
	 */
	private async startStream(stream: MediaStream, requestId: number, keywords: readonly string[]): Promise<void> {
		let capture;
		try {
			capture = await this.initAudioContext(stream);
		} catch (e) {
			if (requestId === this.startRequestId) {
				this.handleError(e instanceof Error ? e : new Error(String(e)), true);
			}
			return;
		}
		if (requestId !== this.startRequestId) {
			capture.audioContext.close().catch(() => { /* noop */ });
			return;
		}
		this.audioContext = capture.audioContext;
		this.sourceNode = capture.sourceNode;
		this.processorNode = capture.processorNode;

		if (!this.transcriptionBackend.isAvailable) {
			this.handleError(Object.assign(new Error(VOICE_INPUT_ERROR_MESSAGES.TRANSCRIBER_NOT_CONFIGURED), { name: 'TranscriberNotConfigured' }), false);
			return;
		}
		const abort = new AbortController();
		this.sessionAbort = abort;
		const session = new VoiceInputSttStreamSession(
			this.transcriptionBackend,
			this.resolveLanguage(),
			this.keywordDetector !== undefined ? [...keywords] : [],
			abort.signal,
			text => this.forwardTranscript(text, 'partial'),
			text => this.forwardTranscript(text, 'segment'),
		);
		this.streamSession = session;
		this.clearRecordingCapTimer();
		this.recordingCapTimer = setTimeout(() => { void this.stop(); }, VOICE_INPUT_RECORDING_CAP_MS);
		this.setState({ status: 'recording' });
		void session.outcome.then(outcome => this.onStreamSessionSettled(session, outcome));
	}

	/**
	 * Binary onStreamSessionSettled:
	 * ```
	 * onStreamSessionSettled(e,t){
	 *   if(this.streamSession===e){
	 *     switch(this.streamSession=void 0,this.recordingCapTimer.clear(),
	 *       this.stopStreamCapture(),t.kind){
	 *       case"error":this.endKeywordSession(),
	 *         this.setState({status:"error",error:{code:this.getErrorCode(t.error),
	 *           message:this.getUserFriendlyErrorMessage(t.error),recoverable:!0}}),
	 *         this._onError.fire(t.error);return;
	 *       case"final":this.forwardFinal(t.text);break;
	 *       case"no-final":this.forwardFinal(t.lastPartial);break;
	 *       case"cancelled":break;
	 *       default:eN(t)}
	 *     this.endKeywordSession(),this.setState({status:"idle",error:void 0})}}
	 * ```
	 */
	private onStreamSessionSettled(session: VoiceInputSttStreamSession, outcome: VoiceInputSttOutcome): void {
		if (this.streamSession !== session) {
			return;
		}
		this.streamSession = undefined;
		this.clearRecordingCapTimer();
		this.stopStreamCapture();
		switch (outcome.kind) {
			case 'error': {
				this.endKeywordSession();
				const error = outcome.error;
				this.setState({
					status: 'error',
					error: { code: voiceInputErrorCode(error), message: VOICE_INPUT_ERROR_MESSAGES[voiceInputErrorCode(error)], recoverable: true },
				});
				this._onError.fire(error);
				return;
			}
			case 'final':
				this.forwardFinal(outcome.text);
				break;
			case 'no-final':
				this.forwardFinal(outcome.lastPartial ?? '');
				break;
			case 'cancelled':
				break;
		}
		this.endKeywordSession();
		this.setState({ status: 'idle', error: undefined });
	}

	// -- transcripts -------------------------------------------------------------

	/**
	 * Binary forwardTranscript:
	 * ```
	 * forwardTranscript(e,t){
	 *   if(this.currentOwnerId===void 0)return;
	 *   const n=t!=="final"&&this.state.status==="processing";
	 *   if(this.keywordDetector!==void 0&&!n){this.keywordDetector.handleTranscript(e,t);return}
	 *   this._onTranscriptCommit.fire({text:e,kind:t,ownerId:this.currentOwnerId})}
	 * ```
	 */
	private forwardTranscript(text: string, kind: VoiceInputTranscriptKind): void {
		if (this.currentOwnerId === undefined) {
			return;
		}
		const detectorBypass = kind !== 'final' && this.state.status === 'processing';
		if (this.keywordDetector !== undefined && !detectorBypass) {
			this.keywordDetector.handleTranscript(text, kind);
			return;
		}
		this._onTranscriptCommit.fire({ text, kind, ownerId: this.currentOwnerId });
	}

	/** Binary forwardFinal: trims and drops empty finals. */
	private forwardFinal(text: string): void {
		const commit = voiceInputFinalCommit(this.currentOwnerId, text);
		if (commit) {
			this._onTranscriptCommit.fire(commit);
		}
	}

	// -- errors -------------------------------------------------------------------

	/**
	 * Binary handleError:
	 * ```
	 * handleError(e,t=!0){
	 *   const n=this.getErrorCode(e),i=this.getUserFriendlyErrorMessage(e);
	 *   if(this.setState({status:"error",error:{code:n,message:i,recoverable:t}}),
	 *     this._onError.fire(e),n==="MICROPHONE_PERMISSION_DENIED")
	 *     if(Di||Ho){
	 *       const r=Di?"x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone"
	 *                 :"ms-settings:privacy-microphone";
	 *       this.notificationService.prompt(_i.Error,
	 *         "Cursor does not have access to your microphone. Please enable in Settings.",
	 *         [{label:"Open Settings",run:()=>{this.openerService.open(Ae.parse(r),{openExternal:!0})}}])
	 *     }else this.notificationService.notify({severity:_i.Error,
	 *       message:"Cursor does not have access to your microphone. Please enable in Settings."});
	 *   t||this.cleanup()}
	 * ```
	 */
	private handleError(error: Error, recoverable: boolean = true): void {
		const code = voiceInputErrorCode(error);
		const message = VOICE_INPUT_ERROR_MESSAGES[code];
		this.setState({ status: 'error', error: { code, message, recoverable } });
		this._onError.fire(error);
		if (code === 'MICROPHONE_PERMISSION_DENIED') {
			const appName = this.productService.applicationName || 'IDE Code';
			const text = voiceInputMicDeniedMessage(appName);
			if (isMacintosh || isWindows) {
				const url = isMacintosh ? VOICE_INPUT_MAC_MIC_SETTINGS_URL : VOICE_INPUT_WINDOWS_MIC_SETTINGS_URL;
				this.notificationService.prompt(Severity.Error, text, [{
					label: 'Open Settings',
					run: () => this.openerService.open(URI.parse(url), { openExternal: true }),
				}]);
			} else {
				this.notificationService.notify({ severity: Severity.Error, message: text });
			}
		}
		if (!recoverable) {
			this.cleanup();
		}
	}

	// -- teardown ------------------------------------------------------------------

	private clearRecordingCapTimer(): void {
		if (this.recordingCapTimer !== undefined) {
			clearTimeout(this.recordingCapTimer);
			this.recordingCapTimer = undefined;
		}
	}

	/**
	 * Binary cancelSession: `cancelSession(){this.startRequestId++,this.cleanup()}`.
	 */
	private cancelSession(): void {
		this.startRequestId++;
		this.cleanup();
	}

	/**
	 * Binary cleanup:
	 * ```
	 * cleanup(){this.endKeywordSession();
	 *   const e=this.streamSession;this.streamSession=void 0,
	 *   this.recordingCapTimer.clear(),e?.cancel(),
	 *   this.stopStreamCapture(),this.setState({status:"idle",error:void 0})}
	 * ```
	 */
	private cleanup(): void {
		this.endKeywordSession();
		const session = this.streamSession;
		this.streamSession = undefined;
		this.sessionAbort?.abort();
		this.sessionAbort = undefined;
		this.clearRecordingCapTimer();
		session?.cancel();
		this.stopStreamCapture();
		this.setState({ status: 'idle', error: undefined });
	}

	override dispose(): void {
		this.cleanup();
		super.dispose();
	}

	// -- devices --------------------------------------------------------------------

	/** Binary: `async getAvailableDevices(){return(await navigator.mediaDevices.enumerateDevices()).filter(t=>t.kind==="audioinput")}`. */
	async getAvailableDevices(): Promise<MediaDeviceInfo[]> {
		return (await navigator.mediaDevices.enumerateDevices()).filter(d => d.kind === 'audioinput');
	}

	/**
	 * Binary: `async setDevice(e){const t=this.state.status==="recording";
	 * t&&this.cancelSession(),this.setState({deviceId:e}),
	 * t&&this.currentOptions&&await this.start({...this.currentOptions,deviceId:e})}`.
	 */
	async setDevice(deviceId: string): Promise<void> {
		const wasRecording = this.state.status === 'recording';
		if (wasRecording) {
			this.cancelSession();
		}
		this.setState({ deviceId });
		if (wasRecording && this.currentOptions) {
			await this.start({ ...this.currentOptions, deviceId });
		}
	}

	getMediaStream(): MediaStream | undefined {
		return this.mediaStream;
	}
}

/** Context-key expression form of the `voiceInputRecording` key for keybinding when-clauses. */
export const VoiceInputRecordingContextKey = new RawContextKey<boolean>(VOICE_INPUT_RECORDING_CONTEXT_KEY, false);

/** `terminalFocus` negation used by the toggle action's keybinding when-clause (binary: `he.not("terminalFocus")`). */
export const VoiceInputToggleKeybindingWhen = ContextKeyExpr.not('terminalFocus');
