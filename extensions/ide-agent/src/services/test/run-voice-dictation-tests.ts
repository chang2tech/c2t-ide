/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * WORKER-GAPS-54C (agent-voice-dictation) — extension-side wiring tests for the
 * composer voice-dictation parity work.
 *
 * The feature's logic lives in workbench core (Cursor's layer). This suite pins
 * the wiring contract from the extension side:
 *   1. the core files exist at the binary-verbatim locations,
 *   2. the binary-verbatim ids/titles/keys survive into the core sources,
 *   3. the pure core module behaves per the binary (state machine, error
 *      codes, options builder) — transpiled and loaded for REAL coverage.
 *
 * Binary evidence (Cursor 3.25.9, workbench.desktop.main.js):
 *   gfm "composer.toggleVoiceDictation" @29975718
 *   ffm "composer.cancelVoiceDictation" @29976011
 *   Qva voice service @31992069; vLe=Zu("voiceInputService"); _dh="voiceInputRecording"
 *   YHS=300*1e3 (recording cap); XHS=500 (hold threshold)
 *
 * NOTE: the extension's full `tsc -p ./` is currently blocked by a
 * pre-existing TS1005 syntax error in components/composer.ts:2799 (noted by
 * WORKER-GAPS-22B, out of this task's scope), so this file is transpiled
 * standalone into out/services/test/ and run with node --test, like
 * run-mode-palette-commands-tests.js.
 */

import { describe, it } from "node:test";
import * as assert from "node:assert";
import * as fs from "node:fs";
import * as path from "node:path";
import * as ts from "typescript";

// Compiled into out/services/test/ — 5 ups = repo root.
const repoRoot = path.join(__dirname, "..", "..", "..", "..", "..");
const COMPOSER = path.join(repoRoot, "src", "vs", "workbench", "contrib", "composer");

function read(rel: string): string {
	return fs.readFileSync(path.join(COMPOSER, rel), "utf8");
}

// --- behavioral: transpile the zero-dependency core module and load it ---
const pureSrc = read(path.join("common", "voiceInput.ts"));
const pureJs = ts.transpileModule(pureSrc, {
	compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const pureMod = { exports: {} as Record<string, unknown> };
// The module has no imports; `require` is passed but never called.
new Function("module", "exports", "require", pureJs)(pureMod, pureMod.exports, require);
const M = pureMod.exports as Record<string, any>;

describe("voice-dictation wiring (GAPS-54C)", () => {

	it("core files exist at the binary-verbatim layout", () => {
		assert.ok(fs.existsSync(path.join(COMPOSER, "common", "voiceInput.ts")), "common/voiceInput.ts");
		assert.ok(fs.existsSync(path.join(COMPOSER, "browser", "voice", "voiceInputService.ts")), "browser/voice/voiceInputService.ts");
		assert.ok(fs.existsSync(path.join(COMPOSER, "browser", "voice", "voice-processor.js")), "browser/voice/voice-processor.js");
		assert.ok(fs.existsSync(path.join(COMPOSER, "browser", "voiceDictationActions.ts")), "browser/voiceDictationActions.ts");
	});

	it("service keeps the verbatim DI name + context key binding", () => {
		const svc = read(path.join("browser", "voice", "voiceInputService.ts"));
		assert.ok(svc.includes("createDecorator<IVoiceInputService>(VOICE_INPUT_SERVICE_ID)"), "DI decorator uses VOICE_INPUT_SERVICE_ID");
		assert.ok(svc.includes("VOICE_INPUT_RECORDING_CONTEXT_KEY"), "binds the verbatim context key");
		assert.strictEqual(M.VOICE_INPUT_SERVICE_ID, "voiceInputService");
		assert.strictEqual(M.VOICE_INPUT_RECORDING_CONTEXT_KEY, "voiceInputRecording");
	});

	it("service ports the verbatim getUserMedia constraints + audio pipeline", () => {
		const svc = read(path.join("browser", "voice", "voiceInputService.ts"));
		assert.ok(svc.includes("VOICE_INPUT_AUDIO_CONSTRAINTS"), "verbatim constraints constant used");
		assert.ok(svc.includes("VOICE_INPUT_WORKLET_PATH"), "verbatim worklet path used");
		assert.ok(svc.includes("'voice-processor'"), "AudioWorkletNode name verbatim");
		assert.ok(svc.includes("VOICE_INPUT_MAX_BUFFER_SIZE"), "buffer cap referenced");
		assert.ok(svc.includes("VOICE_INPUT_RECORDING_CAP_MS"), "recording cap (YHS) referenced");
		assert.ok(svc.includes("VOICE_INPUT_HOLD_MIN_MS"), "hold threshold (XHS) referenced");
	});

	it("service drives the state machine through the pure setState port", () => {
		const svc = read(path.join("browser", "voice", "voiceInputService.ts"));
		assert.ok(svc.includes("applyVoiceInputStatePatch"), "setState delegates to the pure port");
		assert.ok(svc.includes("'requesting_permission'"), "status vocabulary verbatim");
		assert.ok(svc.includes("'recording'"), "status vocabulary verbatim");
		assert.ok(svc.includes("'processing'"), "status vocabulary verbatim");
	});

	it("service keeps the verbatim mic-denied settings UX", () => {
		const svc = read(path.join("browser", "voice", "voiceInputService.ts"));
		assert.ok(svc.includes("VOICE_INPUT_MAC_MIC_SETTINGS_URL"), "macOS settings deep link");
		assert.ok(svc.includes("VOICE_INPUT_WINDOWS_MIC_SETTINGS_URL"), "Windows settings deep link");
		assert.ok(svc.includes("voiceInputMicDeniedMessage"), "verbatim notification text template");
	});

	it("actions register the two binary-verbatim commands", () => {
		const act = read(path.join("browser", "voiceDictationActions.ts"));
		assert.ok(act.includes(M.TOGGLE_VOICE_DICTATION_COMMAND_ID), "toggle id");
		assert.ok(act.includes(M.CANCEL_VOICE_DICTATION_COMMAND_ID), "cancel id");
		assert.ok(act.includes(M.TOGGLE_VOICE_DICTATION_TITLE), 'toggle title "Toggle Voice Mode"');
		assert.ok(act.includes(M.CANCEL_VOICE_DICTATION_TITLE), 'cancel title "Cancel Voice Mode"');
		assert.strictEqual(M.TOGGLE_VOICE_DICTATION_COMMAND_ID, "composer.toggleVoiceDictation");
		assert.strictEqual(M.CANCEL_VOICE_DICTATION_COMMAND_ID, "composer.cancelVoiceDictation");
		assert.strictEqual(M.VOICE_DICTATION_KEYBINDING_WEIGHT, 201);
	});

	it("toggle run() mirrors the binary: idle|error -> focus+start, recording -> stop", () => {
		const act = read(path.join("browser", "voiceDictationActions.ts"));
		assert.ok(act.includes("status === 'idle' || status === 'error'"), "idle|error branch");
		assert.ok(act.includes("executeCommand('composer.focusComposer')"), "ensures composer visible (binary showAndFocus) via the binary-verbatim focus command");
		assert.ok(act.includes("buildVoiceInputStartOptions"), "GKp options builder");
		assert.ok(act.includes("status === 'recording'"), "recording branch");
		assert.ok(act.includes("voiceService.stop()"), "recording -> stop()");
	});

	it("cancel run() mirrors the binary: recording|processing -> cancel()", () => {
		const act = read(path.join("browser", "voiceDictationActions.ts"));
		assert.ok(act.includes("status === 'recording' || status === 'processing'"), "cancel guard");
		assert.ok(act.includes("voiceService.cancel()"), "cancel() call");
	});

	it('worklet registers "voice-processor" and posts int16 PCM chunks', () => {
		const w = read(path.join("browser", "voice", "voice-processor.js"));
		assert.ok(w.includes("registerProcessor('voice-processor'"), "processor name verbatim");
		assert.ok(w.includes(".postMessage("), "posts messages");
		assert.ok(w.includes("Int16Array"), "int16 PCM output");
		// 320 int16 samples = 640 bytes = the binary's TARGET_CHUNK_BYTES.
		assert.ok(w.includes("320"), "worklet chunks 320 samples (640 bytes)");
	});

	it("contribution registers the singleton + actions", () => {
		const c = read(path.join("browser", "composer.contribution.ts"));
		assert.ok(c.includes("registerSingleton(IVoiceInputService, VoiceInputService"), "singleton registered");
		assert.ok(c.includes("registerVoiceDictationActions()"), "actions registered");
	});

	it("voiceInputLanguage config key is registered (binary-verbatim)", () => {
		const cfg = read(path.join("common", "composerConfiguration.ts"));
		assert.ok(cfg.includes("'voiceInputLanguage'"), "config key registered");
	});

	it("behavior: GKp builder always enables keyword detection", () => {
		const o = M.buildVoiceInputStartOptions("c9", "b3");
		assert.strictEqual(o.ownerId, "classic:c9:b3");
		assert.strictEqual(o.keywordDetectionEnabled, true);
	});

	it("behavior: full state cycle idle -> requesting_permission -> recording -> processing -> idle", () => {
		const apply = M.applyVoiceInputStatePatch as (...a: unknown[]) => { state: Record<string, unknown>; recordingContextKey: boolean; recordingStartedAt: number | undefined };
		let r = apply({ status: "idle" }, { status: "requesting_permission", ownerId: "c1" }, 100, false, undefined);
		assert.strictEqual(r.state.status, "requesting_permission");
		assert.strictEqual(r.recordingContextKey, false);
		r = apply(r.state, { status: "recording" }, 200, false, r.recordingStartedAt);
		assert.strictEqual(r.recordingContextKey, true);
		assert.strictEqual(r.recordingStartedAt, 200);
		r = apply(r.state, { status: "processing" }, 300, true, r.recordingStartedAt);
		assert.strictEqual(r.recordingContextKey, true); // processing WITH live session
		r = apply(r.state, { status: "idle" }, 400, false, r.recordingStartedAt);
		assert.strictEqual(r.state.ownerId, undefined); // ownerId cleared
		assert.strictEqual(r.recordingContextKey, false);
	});

	it("behavior: error mapping + final-commit trim + language resolution", () => {
		assert.strictEqual(M.voiceInputErrorCode({ name: "NotAllowedError", message: "" }), "MICROPHONE_PERMISSION_DENIED");
		assert.strictEqual(M.voiceInputErrorCode({ name: "Error", message: "HTTP 500" }), "SERVER_ERROR");
		assert.strictEqual(M.voiceInputFinalCommit("c1", "  "), undefined);
		assert.deepStrictEqual(M.voiceInputFinalCommit("c1", " hi "), { text: "hi", kind: "final", ownerId: "c1" });
		assert.strictEqual(M.resolveVoiceInputLanguage(""), undefined);
	});

	it("behavior: recording cap is 5 minutes (binary YHS=300*1e3)", () => {
		assert.strictEqual(M.VOICE_INPUT_RECORDING_CAP_MS, 300_000);
	});
});
