/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// IDE-CODE: AudioWorklet processor for composer voice dictation.
//
// Binary reference (Cursor 3.25.9, workbench.desktop.main.js): the voice input
// service loads its capture processor from the verbatim URL
//   vs/workbench/contrib/composer/browser/voice/voice-processor.js
// via `$d.asBrowserUri(...)`, creates an `AudioContext({sampleRate:16e3})`,
// feeds it with `createMediaStreamSource(stream)`, and instantiates an
// `AudioWorkletNode(audioContext, "voice-processor")`. The worklet posts
// messages that the service consumes as:
//   s.port.onmessage = o => { this.handleAudioChunk(new Uint8Array(o.data)) }
//
// The binary's worklet source is not statically recoverable from the bundle,
// so this file is a faithful reimplementation of its OBSERVABLE CONTRACT:
//   - processor name "voice-processor"
//   - input: 128-sample float32 quanta at 16kHz mono (the service configures
//     the AudioContext and MediaStreamSource for 16kHz mono)
//   - output: `postMessage` with raw little-endian int16 PCM bytes matching
//     the service's TARGET_CHUNK_BYTES=640 (320 samples = 20ms at 16kHz)
//   - the service wraps each message in `new Uint8Array(o.data)`, so the
//     posted value must be an ArrayBuffer (or a view whose .buffer/byteOffset
//     semantics survive that wrap — ArrayBuffer is the exact contract).
//
// The service's handleAudioChunk pushes the bytes into the stream session
// that forwards them to the speech-to-text backend (binary:
// `aiService.aiClient().streamStt(stream, {signal})`).

class VoiceProcessor extends AudioWorkletProcessor {
	constructor() {
		super();
		// 640 bytes / 2 bytes-per-sample = 320 samples per posted chunk.
		this._samplesPerChunk = 320;
		this._buffer = new Int16Array(this._samplesPerChunk);
		this._buffered = 0;
	}

	_postFullChunks() {
		while (this._buffered >= this._samplesPerChunk) {
			// Copy (not transfer) so a late-arriving message consumer never
			// aliases our ring buffer.
			const out = new Int16Array(this._samplesPerChunk);
			out.set(this._buffer.subarray(0, this._samplesPerChunk));
			this._buffer.copyWithin(0, this._samplesPerChunk, this._buffered);
			this._buffered -= this._samplesPerChunk;
			this.port.postMessage(out.buffer);
		}
	}

	process(inputs) {
		const input = inputs[0];
		if (input && input.length > 0) {
			const channel = input[0]; // mono; service captures channelCount: 1
			for (let i = 0; i < channel.length; i++) {
				// float32 [-1, 1] -> int16 PCM
				const s = Math.max(-1, Math.min(1, channel[i]));
				this._buffer[this._buffered++] = s < 0 ? s * 0x8000 : s * 0x7fff;
				if (this._buffered === this._samplesPerChunk) {
					this._postFullChunks();
				}
			}
		}
		return true; // keep the processor alive
	}
}

registerProcessor('voice-processor', VoiceProcessor);
