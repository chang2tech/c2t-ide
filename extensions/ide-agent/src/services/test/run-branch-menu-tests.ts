/**
 * W69C (`changes-tab-base-branch-menu`) tests (node:test, no vscode
 * needed — the git runner is injected).
 *
 * Cursor parity (binary evidence, workbench.glass.main.js 3.25.9,
 * re-verified by W69C 2026-10-20):
 * - `cursor.openBranchMenu` (ZXl @27418487, class JXl @27418510) fires
 *   `composerEventService.fireDidRequestOpenBranchMenu({composerId})`
 *   only for a loaded composer with an EMPTY conversation; the selector
 *   handler (@27425412) opens only when the id matches the selected
 *   composer and sets `isBranchSelectorOpen`.
 * - Modes `bCe` @17425789: DEFAULT="default", CURRENT="current",
 *   CURRENT_WITH_CHANGES="current-with-changes".
 * - Effective base ref `kVm` @17424779 (verbatim truth table below).
 * - Effective mode memo (@27425412): detached HEAD -> DEFAULT;
 *   CURRENT_WITH_CHANGES with no local changes and synced -> CURRENT.
 * - Default-branch fallback chain (selector loader, verbatim):
 *   main -> master -> first name -> "main".
 * - Trigger label template @27426629: `Switch base branch (${base})`.
 * - Git probes: getGitDiff() length>0 = local changes; rev-list
 *   `@{u}..HEAD --count` > 0 = "Not synced with remote"; failures
 *   degrade to flags-off.
 *
 * Run after `tsc`:  node --test out/services/test/run-branch-menu-tests.js
 */
import { describe, it } from "node:test";
import * as assert from "node:assert";
import "./vscode-stub";
import {
  BranchGitContext,
  BranchMenuService,
  BranchSelectionMode,
  baseBranchLabel,
  computeEffectiveBranchMode,
  resolveDefaultBranchFromNames,
  resolveEffectiveBaseRef,
  type GitRunner,
} from "../branchMenuService";
import { ComposerDataService } from "../composerDataService";
import { StubEngineAdapter } from "../agentService";

describe("resolveEffectiveBaseRef — verbatim kVm @17424779 truth table", () => {
  it("DEFAULT mode -> default branch", () => {
    assert.strictEqual(
      resolveEffectiveBaseRef({
        cachedMode: BranchSelectionMode.DEFAULT,
        currentBranch: "feature/x",
        defaultBranch: "main",
      }),
      "main",
    );
  });

  it("detached HEAD -> default branch regardless of mode", () => {
    assert.strictEqual(
      resolveEffectiveBaseRef({
        cachedMode: BranchSelectionMode.CURRENT,
        currentBranch: "HEAD",
        defaultBranch: "develop",
      }),
      "develop",
    );
  });

  it("CURRENT mode -> current branch", () => {
    assert.strictEqual(
      resolveEffectiveBaseRef({
        cachedMode: BranchSelectionMode.CURRENT_WITH_CHANGES,
        currentBranch: "feature/x",
        defaultBranch: "main",
      }),
      "feature/x",
    );
  });

  it("fallbacks: no current -> default; neither -> 'main'", () => {
    assert.strictEqual(
      resolveEffectiveBaseRef({
        cachedMode: BranchSelectionMode.CURRENT,
        defaultBranch: "trunk",
      }),
      "trunk",
    );
    assert.strictEqual(
      resolveEffectiveBaseRef({ cachedMode: BranchSelectionMode.CURRENT }),
      "main",
    );
    assert.strictEqual(
      resolveEffectiveBaseRef({ cachedMode: BranchSelectionMode.DEFAULT }),
      "main",
    );
  });
});

describe("computeEffectiveBranchMode — selector memo @27425412", () => {
  it("detached HEAD forces DEFAULT", () => {
    assert.strictEqual(
      computeEffectiveBranchMode({
        cachedMode: BranchSelectionMode.CURRENT_WITH_CHANGES,
        currentBranch: "HEAD",
        hasLocalChanges: true,
        notSynced: true,
      }),
      BranchSelectionMode.DEFAULT,
    );
  });

  it("CURRENT_WITH_CHANGES degrades to CURRENT when clean and synced", () => {
    assert.strictEqual(
      computeEffectiveBranchMode({
        cachedMode: BranchSelectionMode.CURRENT_WITH_CHANGES,
        currentBranch: "feature/x",
        hasLocalChanges: false,
        notSynced: false,
      }),
      BranchSelectionMode.CURRENT,
    );
  });

  it("CURRENT_WITH_CHANGES survives with local changes or unsynced", () => {
    assert.strictEqual(
      computeEffectiveBranchMode({
        cachedMode: BranchSelectionMode.CURRENT_WITH_CHANGES,
        currentBranch: "feature/x",
        hasLocalChanges: true,
        notSynced: false,
      }),
      BranchSelectionMode.CURRENT_WITH_CHANGES,
    );
    assert.strictEqual(
      computeEffectiveBranchMode({
        cachedMode: BranchSelectionMode.CURRENT_WITH_CHANGES,
        currentBranch: "feature/x",
        hasLocalChanges: false,
        notSynced: true,
      }),
      BranchSelectionMode.CURRENT_WITH_CHANGES,
    );
  });

  it("other modes pass through unchanged", () => {
    assert.strictEqual(
      computeEffectiveBranchMode({
        cachedMode: BranchSelectionMode.DEFAULT,
        currentBranch: "feature/x",
        hasLocalChanges: true,
        notSynced: true,
      }),
      BranchSelectionMode.DEFAULT,
    );
  });
});

describe("resolveDefaultBranchFromNames — binary fallback chain", () => {
  it("prefers main, then master, then first, then 'main'", () => {
    assert.strictEqual(resolveDefaultBranchFromNames(["dev", "main"]), "main");
    assert.strictEqual(resolveDefaultBranchFromNames(["dev", "master"]), "master");
    assert.strictEqual(resolveDefaultBranchFromNames(["dev", "topic"]), "dev");
    assert.strictEqual(resolveDefaultBranchFromNames([]), "main");
  });
});

describe("baseBranchLabel — verbatim template @27426629", () => {
  it("renders `Switch base branch (${base})`", () => {
    assert.strictEqual(baseBranchLabel("main"), "Switch base branch (main)");
    assert.strictEqual(
      baseBranchLabel("feature/x"),
      "Switch base branch (feature/x)",
    );
  });
});

/** Fake git: maps the joined argv to canned stdout (or throws). */
function fakeGit(responses: Record<string, string>): GitRunner {
  return async (_cwd, args) => {
    const key = args.join(" ");
    if (key in responses) {
      return responses[key]!;
    }
    throw new Error(`no fake git response for: ${key}`);
  };
}

const BRANCH_LIST_KEY = "branch -a --sort=-committerdate --format=%(refname:short)";

describe("BranchGitContext — gitContextService port", () => {
  it("getAllBranchNames strips remote prefixes, skips the HEAD symref, dedupes", async () => {
    const git = new BranchGitContext(
      fakeGit({
        [BRANCH_LIST_KEY]:
          "feature/x\nremotes/origin/feature/x\nremotes/origin/HEAD -> origin/main\nmain\nremotes/origin/main\n",
      }),
    );
    assert.deepStrictEqual(await git.getAllBranchNames("/ws"), [
      "feature/x",
      "main",
    ]);
  });

  it("getDefaultBranch uses origin/HEAD when present", async () => {
    const git = new BranchGitContext(
      fakeGit({
        "symbolic-ref --short refs/remotes/origin/HEAD": "origin/develop\n",
      }),
    );
    assert.strictEqual(await git.getDefaultBranch("/ws"), "develop");
  });

  it("getDefaultBranch falls back to the binary chain without origin/HEAD", async () => {
    const git = new BranchGitContext(
      fakeGit({ [BRANCH_LIST_KEY]: "topic\nmaster\n" }),
    );
    assert.strictEqual(await git.getDefaultBranch("/ws"), "master");
  });

  it("getGitDiff / getNotSynced mirror the binary flag semantics", async () => {
    const dirty = new BranchGitContext(
      fakeGit({
        "status --porcelain": " M a.ts\n?? b.ts\n",
        "rev-list @{u}..HEAD --count": "3\n",
      }),
    );
    assert.strictEqual((await dirty.getGitDiff("/ws")).length, 2);
    assert.strictEqual(await dirty.getNotSynced("/ws"), true);

    const clean = new BranchGitContext(
      fakeGit({
        "status --porcelain": "",
        "rev-list @{u}..HEAD --count": "0\n",
      }),
    );
    assert.deepStrictEqual(await clean.getGitDiff("/ws"), []);
    assert.strictEqual(await clean.getNotSynced("/ws"), false);

    // Failures degrade to flags-off (the binary's try/catch behavior).
    const broken = new BranchGitContext(fakeGit({}));
    assert.deepStrictEqual(await broken.getGitDiff("/ws"), []);
    assert.strictEqual(await broken.getNotSynced("/ws"), false);
    assert.strictEqual(await broken.getCurrentBranch("/ws"), undefined);
  });
});

describe("BranchMenuService — event + selector flow", () => {
  function makeService(): BranchMenuService {
    const git = new BranchGitContext(
      fakeGit({
        "rev-parse --abbrev-ref HEAD": "feature/x\n",
        "symbolic-ref --short refs/remotes/origin/HEAD": "origin/main\n",
        [BRANCH_LIST_KEY]: "feature/x\nmain\n",
        "status --porcelain": " M a.ts\n",
        "rev-list @{u}..HEAD --count": "0\n",
      }),
    );
    return new BranchMenuService(git);
  }

  it("fire/on round-trips {composerId} and dispose unsubscribes", () => {
    const svc = makeService();
    const seen: Array<{ composerId: string }> = [];
    const sub = svc.onDidRequestOpenBranchMenu((e) => seen.push(e));
    svc.fireDidRequestOpenBranchMenu({ composerId: "c1" });
    sub.dispose();
    svc.fireDidRequestOpenBranchMenu({ composerId: "c2" });
    assert.deepStrictEqual(seen, [{ composerId: "c1" }]);
  });

  it("snapshot carries the binary data set (label, mode, item tags)", async () => {
    const svc = makeService();
    const snap = await svc.loadSnapshot("/ws");
    assert.strictEqual(snap.currentBranch, "feature/x");
    assert.strictEqual(snap.defaultBranch, "main");
    assert.strictEqual(snap.hasLocalChanges, true);
    assert.strictEqual(snap.notSynced, false);
    assert.strictEqual(snap.effectiveBaseRef, "main");
    assert.strictEqual(snap.label, "Switch base branch (main)");
    const current = snap.items.find((i) => i.branch === "feature/x");
    assert.strictEqual(current?.isCurrent, true);
    assert.ok(
      current?.description?.includes("(with local changes)"),
      "current branch carries the verbatim local-changes tag",
    );
  });

  it("handleOpenRequest ignores a non-selected composer (binary handler guard)", async () => {
    const svc = makeService();
    let picked = false;
    const result = await svc.handleOpenRequest({
      composerId: "other",
      selectedComposerId: "selected",
      cwd: "/ws",
      pick: async () => {
        picked = true;
        return undefined;
      },
    });
    assert.strictEqual(result, undefined);
    assert.strictEqual(picked, false);
    assert.strictEqual(svc.isBranchSelectorOpen, false);
  });

  it("handleOpenRequest opens, records the choice, and always closes", async () => {
    const svc = makeService();
    let openDuringPick = false;
    const result = await svc.handleOpenRequest({
      composerId: "selected",
      selectedComposerId: "selected",
      cwd: "/ws",
      pick: async (items) => {
        openDuringPick = svc.isBranchSelectorOpen;
        return items.find((i) => i.branch === "feature/x");
      },
    });
    assert.strictEqual(result, "feature/x");
    assert.strictEqual(openDuringPick, true, "isBranchSelectorOpen set while picking");
    assert.strictEqual(svc.isBranchSelectorOpen, false, "closed after pick");
    // Chose the current branch with local changes -> CURRENT_WITH_CHANGES.
    assert.strictEqual(
      svc.cachedBranchSelectionMode,
      BranchSelectionMode.CURRENT_WITH_CHANGES,
    );
    const snap = await svc.loadSnapshot("/ws");
    assert.strictEqual(snap.label, "Switch base branch (feature/x)");
  });

  it("dismissal records nothing and closes", async () => {
    const svc = makeService();
    const result = await svc.handleOpenRequest({
      composerId: "selected",
      selectedComposerId: "selected",
      cwd: "/ws",
      pick: async () => undefined,
    });
    assert.strictEqual(result, undefined);
    assert.strictEqual(svc.isBranchSelectorOpen, false);
    assert.strictEqual(
      svc.cachedBranchSelectionMode,
      BranchSelectionMode.DEFAULT,
    );
    assert.strictEqual(svc.baseBranchOverride, undefined);
  });
});

describe("ComposerDataService.isComposerConversationEmpty — binary guard port", () => {
  it("a fresh composer is empty; after a submit it is not", async () => {
    const composer = new ComposerDataService(undefined, undefined);
    // Swap the sidecar adapter for the scripted stub — no engine process.
    (composer as unknown as { engine: unknown }).engine =
      new StubEngineAdapter(async () => ({ optionId: "approve" }));
    try {
      assert.strictEqual(composer.isComposerConversationEmpty(), true);
      composer.submit("hello");
      assert.strictEqual(composer.isComposerConversationEmpty(), false);
    } finally {
      composer.dispose();
    }
  });
});
