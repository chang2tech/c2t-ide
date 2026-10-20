/**
 * chime service tests (node:test, zero extra deps).
 *
 * Cursor parity (DEV-GAPS-45, chat-sound-notify): REA evidence —
 * `cursor.composer.shouldChimeAfterChatFinishes` ("Sound on agent
 * completion", deep-docs-refs.md:66), `cursor.composer.customChimeSoundPath`
 * ("Custom chime audio file", deep-env-config.md:201), and the Settings UI
 * entry "Completion Sound" — "Play a sound when agents finish or need
 * attention" (detail-settings-2026-10-19.md:70, default OFF).
 *
 * These tests pin the host-side resolution rules:
 *   - a valid custom path wins over the bundled default;
 *   - a bad custom path falls through to the bundled default;
 *   - with no playable file, playChime resolves silently (never rejects);
 *   - defaultChimePath points at media/chime.wav under the extension dir.
 *
 * Run after `tsc`:  node out/services/chime.test.js
 */
import { describe, it } from "node:test";
import * as assert from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { resolveChimeFile, playChime, defaultChimePath } from "./chime";

describe("chime — file resolution", () => {
  it("defaultChimePath points at media/chime.wav under the extension dir", () => {
    const p = defaultChimePath("/fake/ext");
    assert.strictEqual(p, path.join("/fake/ext", "media", "chime.wav"));
  });

  it("a valid custom path wins over the bundled default", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "chime-"));
    const custom = path.join(dir, "custom.mp3");
    const fallback = path.join(dir, "default.wav");
    fs.writeFileSync(custom, "x");
    fs.writeFileSync(fallback, "y");
    try {
      assert.strictEqual(resolveChimeFile({ customPath: custom, defaultPath: fallback }), custom);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("a bad custom path falls through to the bundled default", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "chime-"));
    const fallback = path.join(dir, "default.wav");
    fs.writeFileSync(fallback, "y");
    try {
      assert.strictEqual(
        resolveChimeFile({ customPath: path.join(dir, "nope.mp3"), defaultPath: fallback }),
        fallback,
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns undefined when nothing playable exists", () => {
    assert.strictEqual(resolveChimeFile({ customPath: "", defaultPath: undefined }), undefined);
    assert.strictEqual(
      resolveChimeFile({ customPath: "/definitely/not/here.wav" }),
      undefined,
    );
  });
});

describe("chime — playback never throws", () => {
  it("playChime resolves silently with no playable file", async () => {
    await playChime({ customPath: "", defaultPath: undefined });
  });

  it("playChime resolves silently with a garbage custom path", async () => {
    await playChime({ customPath: "/definitely/not/here.wav" });
  });
});
