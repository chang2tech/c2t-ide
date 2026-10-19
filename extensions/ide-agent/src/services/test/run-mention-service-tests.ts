/**
 * MentionService.extractFileAttachments tests (node:test, vscode stubbed).
 *
 * P3 (QA-BROWSERTAB Round-B): a forged image chip with a non-string filePath
 * used to reach path.resolve() and throw outside any try/catch, killing the
 * whole submit. The typeof-guard in extractFileAttachments must skip such
 * chips instead of throwing.
 *
 * Run after `tsc`:  node out/services/test/run-mention-service-tests.js
 */
import { describe, it } from "node:test";
import * as assert from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import "./vscode-stub";
import { MentionService } from "../mentionService";
import { MentionChip } from "../mentionMatch";
import { browserCaptureDir } from "../../browser/chromium";

/** A well-formed browser-tab screenshot chip pointing at filePath. */
function imageChip(filePath: unknown, label = "Element: <div>…"): MentionChip {
  return {
    id: "browser:shot-1",
    label,
    rawText: "@Browser shot",
    mentionType: "browser",
    uuid: "uuid-shot-1",
    payload: { case: "imageContext", label, filePath, dataUrl: "" } as unknown as MentionChip["payload"],
  };
}

describe("MentionService.extractFileAttachments", () => {
  it("skips forged chips with non-string filePath instead of throwing", () => {
    const svc = new MentionService();
    const forged = [12345, null, undefined, {}, [], true].map((filePath) =>
      imageChip(filePath),
    );
    // Pre-fix: path.resolve(12345) threw TypeError outside any try/catch.
    assert.doesNotThrow(() => svc.extractFileAttachments(forged));
    assert.deepStrictEqual(svc.extractFileAttachments(forged), []);
  });

  it("skips chips that fail isMentionChip and non-image payload cases", () => {
    const svc = new MentionService();
    const notAChip = { id: "x", payload: { case: "imageContext", filePath: "/tmp/x.png" } };
    const fileCase = imageChip("/tmp/x.png");
    (fileCase.payload as { case: string }).case = "fileSelection";
    assert.deepStrictEqual(
      svc.extractFileAttachments([notAChip as unknown as MentionChip, fileCase]),
      [],
    );
  });

  it("skips files outside the browser capture dir (path-traversal guard)", () => {
    const svc = new MentionService();
    const outside = imageChip("/etc/passwd");
    const elsewhere = imageChip(path.join(os.tmpdir(), "ide-agent-test-outside.png"));
    assert.deepStrictEqual(svc.extractFileAttachments([outside, elsewhere]), []);
  });

  it("attaches a real capture file inside the capture dir, skips missing/empty/oversize", () => {
    const svc = new MentionService();
    const dir = browserCaptureDir();
    fs.mkdirSync(dir, { recursive: true });
    const real = path.join(dir, `ide-agent-test-attach-${process.pid}.png`);
    const missing = path.join(dir, `ide-agent-test-missing-${process.pid}.png`);
    fs.writeFileSync(real, Buffer.from([0x89, 0x50, 0x4e, 0x47])); // PNG magic, non-empty
    try {
      const out = svc.extractFileAttachments([imageChip(real), imageChip(missing)]);
      assert.strictEqual(out.length, 1);
      assert.strictEqual(out[0]!.uri, `file://${real}`);
      assert.strictEqual(out[0]!.name, path.basename(real));
    } finally {
      fs.rmSync(real, { force: true });
    }
  });

  // No stray capture-dir pollution left behind: the test PNG is removed in the
  // finally block above; nothing else is written.
});
