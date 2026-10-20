/**
 * chatConflictService tests (node:test, zero extra deps).
 *
 * Covers Cursor's "Resolve All Conflicts in Chat" (binary-verified,
 * Cursor 3.25.9, command `composer.resolveAllConflictsInChat`):
 * verbatim conflict-marker scan, verbatim prompt strings, unmerged-file
 * discovery, and the new-tab + per-conflict chips + prefill + focus flow.
 *
 * Run after `tsc`:  node out/services/test/run-chat-conflict-tests.js
 */
import { describe, it } from "node:test";
import * as assert from "node:assert";
import { Module } from "node:module";
import type { ChatConflictHost } from "../chatConflictService";

/* ---------- minimal vscode stub (asRelativePath + Uri) ---------- */
const vscodeStub: any = {
  Uri: {
    parse: (s: string) => ({ fsPath: s.replace(/^file:\/\//, "") }),
  },
  workspace: {
    asRelativePath: (p: string) => p.split("/").slice(-1)[0],
  },
};

const origLoad = (Module as any)._load;
(Module as any)._load = function (request: string, parent: any, isMain: any) {
  if (request === "vscode") {
    return vscodeStub;
  }
  return origLoad.call(this, request, parent, isMain);
};

// eslint-disable-next-line @typescript-eslint/no-var-requires
const SvcMod = require("../chatConflictService");
const {
  findConflictMarkers,
  parseUnmergedFiles,
  buildResolvePrompt,
  ChatConflictService,
  RESOLVE_CONFLICTS_TITLE,
  RESOLVE_CONFLICTS_PROMPT_SINGLE,
  RESOLVE_CONFLICTS_ERROR_NO_COMPOSER,
} = SvcMod;

describe("chatConflictService — evidence", () => {
  it("command title is verbatim from the binary", () => {
    assert.strictEqual(RESOLVE_CONFLICTS_TITLE, "Resolve All Conflicts in Chat");
  });

  it("singular prompt is verbatim from the binary", () => {
    assert.strictEqual(RESOLVE_CONFLICTS_PROMPT_SINGLE, "Resolve this merge conflict");
  });

  it("composer-failure error is verbatim from the binary", () => {
    assert.strictEqual(
      RESOLVE_CONFLICTS_ERROR_NO_COMPOSER,
      "Failed to create or find a composer to fix merge conflicts",
    );
  });
});

describe("findConflictMarkers — binary-verbatim algorithm", () => {
  it("finds a single conflict with 1-based lines and full hunk text", () => {
    const text = [
      "line1",
      "<<<<<<< HEAD",
      "ours",
      "=======",
      "theirs",
      ">>>>>>> branch",
      "line7",
    ].join("\n");
    const out = findConflictMarkers(text);
    assert.strictEqual(out.length, 1);
    assert.strictEqual(out[0].startLine, 2);
    assert.strictEqual(out[0].endLine, 6);
    assert.strictEqual(
      out[0].text,
      ["<<<<<<< HEAD", "ours", "=======", "theirs", ">>>>>>> branch"].join("\n"),
    );
  });

  it("finds multiple conflicts in order", () => {
    const text = [
      "<<<<<<< HEAD",
      "a",
      ">>>>>>> x",
      "mid",
      "<<<<<<< HEAD",
      "b",
      ">>>>>>> y",
    ].join("\n");
    const out = findConflictMarkers(text);
    assert.strictEqual(out.length, 2);
    assert.deepStrictEqual([out[0].startLine, out[0].endLine], [1, 3]);
    assert.deepStrictEqual([out[1].startLine, out[1].endLine], [5, 7]);
  });

  it("returns [] when there are no markers", () => {
    assert.deepStrictEqual(findConflictMarkers("plain\ntext\n"), []);
  });

  it("ignores an unterminated start marker", () => {
    assert.deepStrictEqual(findConflictMarkers("<<<<<<< HEAD\nours\n"), []);
  });

  it("requires the marker at line start (binary: startsWith)", () => {
    assert.deepStrictEqual(findConflictMarkers("  <<<<<<< HEAD\nx\n"), []);
  });
});

describe("parseUnmergedFiles", () => {
  it("picks UU/AA/DD/AU/UA/UD/DU and skips the rest", () => {
    const porcelain = [
      "UU src/a.ts",
      "M  src/b.ts",
      "AA src/c.ts",
      "?? src/d.ts",
      "UD src/e.ts",
      "DU src/f.ts",
      "AU src/g.ts",
      "UA src/h.ts",
      "DD src/i.ts",
      "R  src/j.ts -> src/k.ts",
    ].join("\n");
    assert.deepStrictEqual(parseUnmergedFiles(porcelain), [
      "src/a.ts",
      "src/c.ts",
      "src/e.ts",
      "src/f.ts",
      "src/g.ts",
      "src/h.ts",
      "src/i.ts",
    ]);
  });

  it("handles rename-style unmerged entries", () => {
    assert.deepStrictEqual(parseUnmergedFiles("UD old.ts -> new.ts"), ["new.ts"]);
  });

  it("returns [] for clean output", () => {
    assert.deepStrictEqual(parseUnmergedFiles(""), []);
    assert.deepStrictEqual(parseUnmergedFiles("M  a.ts\n?? b.ts\n"), []);
  });
});

describe("buildResolvePrompt — verbatim templates", () => {
  it("plural: 'Resolve these N merge conflicts across M files'", () => {
    assert.strictEqual(
      buildResolvePrompt(3, 2),
      "Resolve these 3 merge conflicts across 2 files",
    );
  });

  it("singular file still plural conflicts", () => {
    assert.strictEqual(
      buildResolvePrompt(2, 1),
      "Resolve these 2 merge conflicts across 1 file",
    );
  });

  it("single conflict → the verbatim singular prompt", () => {
    assert.strictEqual(buildResolvePrompt(1, 1), "Resolve this merge conflict");
  });
});

function makeHost(files: Record<string, string>): {
  host: ChatConflictHost;
  posted: Array<{ tabId: string; message: any }>;
  created: string[];
  focused: string[];
  infos: string[];
  warnings: string[];
  errors: string[];
} {
  const posted: Array<{ tabId: string; message: any }> = [];
  const created: string[] = [];
  const focused: string[] = [];
  const infos: string[] = [];
  const warnings: string[] = [];
  const errors: string[] = [];
  const host: ChatConflictHost = {
    createTab: (title: string) => {
      created.push(title);
      return "tab-1";
    },
    postToWebview: (tabId: string, message: unknown) => {
      posted.push({ tabId, message });
    },
    focusChatInput: async (tabId: string) => {
      focused.push(tabId);
    },
    runGit: async () => "",
    readFile: async (p: string) => {
      if (!(p in files)) {
        throw new Error("ENOENT");
      }
      return files[p];
    },
    repoRoot: () => "/repo",
    showInformationMessage: (m: string) => void infos.push(m),
    showWarningMessage: (m: string) => void warnings.push(m),
    showErrorMessage: (m: string) => void errors.push(m),
  };
  return { host, posted, created, focused, infos, warnings, errors };
}

const CONFLICT_TEXT = [
  "top",
  "<<<<<<< HEAD",
  "ours code",
  "=======",
  "theirs code",
  ">>>>>>> feature",
  "bottom",
].join("\n");

describe("ChatConflictService.resolveAllConflicts — orchestration", () => {
  it("creates a new tab, posts one chip per conflict, prefills verbatim prompt, focuses input", async () => {
    const { host, posted, created, focused } = makeHost({ "/repo/a.ts": CONFLICT_TEXT });
    const svc: InstanceType<typeof ChatConflictService> = new ChatConflictService(host);
    const n = await svc.resolveAllConflicts({ conflictedFiles: ["/repo/a.ts"] });
    assert.strictEqual(n, 1);
    assert.deepStrictEqual(created, ["Resolve merge conflicts"]);
    const chips = posted.filter((p) => p.message.type === "addSelectionContext");
    assert.strictEqual(chips.length, 1);
    assert.strictEqual(chips[0].tabId, "tab-1");
    assert.strictEqual(chips[0].message.label, "a.ts:2-6");
    assert.strictEqual(chips[0].message.content, CONFLICT_TEXT.split("\n").slice(1, 6).join("\n"));
    const prefill = posted.filter((p) => p.message.type === "prefill");
    assert.strictEqual(prefill.length, 1);
    assert.strictEqual(prefill[0].message.text, "Resolve this merge conflict");
    assert.deepStrictEqual(focused, ["tab-1"]);
  });

  it("plural prompt counts conflicts across files (uses args.fileCount like the binary)", async () => {
    const { host, posted } = makeHost({
      "/repo/a.ts": CONFLICT_TEXT,
      "/repo/b.ts": CONFLICT_TEXT,
    });
    const svc: InstanceType<typeof ChatConflictService> = new ChatConflictService(host);
    const n = await svc.resolveAllConflicts({
      conflictedFiles: ["/repo/a.ts", "/repo/b.ts"],
      fileCount: 2,
    });
    assert.strictEqual(n, 2);
    const prefill = posted.filter((p) => p.message.type === "prefill");
    assert.strictEqual(prefill[0].message.text, "Resolve these 2 merge conflicts across 2 files");
  });

  it("skips files that fail to read (binary: warn + continue)", async () => {
    const { host, warnings, posted } = makeHost({ "/repo/a.ts": CONFLICT_TEXT });
    const svc: InstanceType<typeof ChatConflictService> = new ChatConflictService(host);
    const n = await svc.resolveAllConflicts({
      conflictedFiles: ["/repo/missing.ts", "/repo/a.ts"],
    });
    assert.strictEqual(n, 1);
    assert.strictEqual(warnings.length, 1);
    assert.ok(posted.some((p) => p.message.type === "prefill"));
  });

  it("reports when nothing is conflicted and creates no tab", async () => {
    const { host, infos, created } = makeHost({});
    const svc: InstanceType<typeof ChatConflictService> = new ChatConflictService(host);
    const n = await svc.resolveAllConflicts({ conflictedFiles: [] });
    assert.strictEqual(n, 0);
    assert.deepStrictEqual(created, []);
    assert.strictEqual(infos.length, 1);
  });

  it("reports when conflicted files have no markers", async () => {
    const { host, infos, posted } = makeHost({ "/repo/a.ts": "plain text" });
    const svc: InstanceType<typeof ChatConflictService> = new ChatConflictService(host);
    const n = await svc.resolveAllConflicts({ conflictedFiles: ["/repo/a.ts"] });
    assert.strictEqual(n, 0);
    assert.strictEqual(infos.length, 1);
    assert.strictEqual(posted.filter((p) => p.message.type === "prefill").length, 0);
  });

  it("shows the binary-verbatim error when tab creation fails", async () => {
    const { host, errors, posted } = makeHost({ "/repo/a.ts": CONFLICT_TEXT });
    host.createTab = () => {
      throw new Error("boom");
    };
    const svc: InstanceType<typeof ChatConflictService> = new ChatConflictService(host);
    const n = await svc.resolveAllConflicts({ conflictedFiles: ["/repo/a.ts"] });
    assert.strictEqual(n, 0);
    assert.strictEqual(errors.length, 1);
    assert.ok(errors[0].includes("Failed to create or find a composer to fix merge conflicts"));
    assert.deepStrictEqual(posted, []);
  });

  it("accepts file:// URIs in args", async () => {
    const { host, posted } = makeHost({ "/repo/a.ts": CONFLICT_TEXT });
    const svc: InstanceType<typeof ChatConflictService> = new ChatConflictService(host);
    const n = await svc.resolveAllConflicts({ conflictedFiles: ["file:///repo/a.ts"] });
    assert.strictEqual(n, 1);
    assert.strictEqual(posted.filter((p) => p.message.type === "addSelectionContext").length, 1);
  });
});

describe("ChatConflictService.discoverConflictedFiles", () => {
  it("maps unmerged porcelain entries to absolute paths", async () => {
    const { host } = makeHost({});
    host.runGit = async (args: string[], cwd: string) => {
      assert.deepStrictEqual(args, ["status", "--porcelain"]);
      assert.strictEqual(cwd, "/repo");
      return "UU src/a.ts\nM  src/b.ts\n";
    };
    const svc: InstanceType<typeof ChatConflictService> = new ChatConflictService(host);
    const files = await svc.discoverConflictedFiles();
    assert.deepStrictEqual(files, ["/repo/src/a.ts"]);
  });

  it("returns [] when there is no repo or git fails", async () => {
    const { host } = makeHost({});
    host.repoRoot = () => undefined;
    const svc: InstanceType<typeof ChatConflictService> = new ChatConflictService(host);
    assert.deepStrictEqual(await svc.discoverConflictedFiles(), []);
    host.repoRoot = () => "/repo";
    host.runGit = async () => {
      throw new Error("not a repo");
    };
    assert.deepStrictEqual(await svc.discoverConflictedFiles(), []);
  });
});
