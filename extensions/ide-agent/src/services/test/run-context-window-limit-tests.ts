/**
 * GAPS-183 — context ring/report denominator = the active model's REAL
 * `contextTokenLimit` (follow-up to GAPS-167, whose report/ring divided by
 * a hard-coded 200k).
 *
 * Wiring under test (ComposerDataService):
 * - the denominator resolves from the engine model catalog
 *   (EngineAdapter.listModels / getDefaultModel — the same seam the model
 *   picker uses) via modelService.resolveActiveContextTokenLimit;
 * - computeContextUsage is synchronous, so the catalog fetch is a
 *   fire-and-forget refresh: the first snapshot serves the fork fallback
 *   (FALLBACK_CONTEXT_WINDOW_TOKENS = 200k), later snapshots serve the
 *   real limit once the refresh lands;
 * - the cache is keyed by selection: switching models NEVER serves the
 *   previous model's limit — the denominator drops back to the fallback
 *   until the new model's limit resolves, then follows the new model;
 * - ring (getContextUsageSnapshot) and report (getContextUsageReport)
 *   share the one denominator.
 *
 * The engine is swapped for a fake adapter with a canned catalog — no
 * sidecar process spawns (the fake is not an IdeCodeEngineAdapter, so the
 * composer's hasStartedServer spawn-guard does not apply to it).
 *
 * Run after `tsc`:  node --test out/services/test/run-context-window-limit-tests.js
 */
import { after, describe, it } from "node:test";
import * as assert from "node:assert";
import "./vscode-stub";
import { ComposerDataService } from "../composerDataService";
import { EngineAdapter, EngineModelInfo, StubEngineAdapter, TurnContext } from "../agentService";
import { TurnEvent } from "../../model";
import { FALLBACK_CONTEXT_WINDOW_TOKENS } from "../contextUsageService";

const tracked = new Set<{ dispose(): void }>();
function track<T extends { dispose(): void }>(d: T): T {
  tracked.add(d);
  return d;
}
after(() => {
  for (const d of tracked) {
    try {
      d.dispose();
    } catch {
      /* teardown must never fail the run */
    }
  }
  tracked.clear();
});

class FakeCatalogEngine implements EngineAdapter {
  listCalls = 0;
  constructor(
    private readonly catalog: EngineModelInfo[],
    private readonly defaultModel?: EngineModelInfo,
  ) {}
  async *runTurn(_ctx: TurnContext): AsyncIterable<TurnEvent> {
    // Never used — these tests never submit a turn.
    return;
  }
  abortTurn(): void {}
  async listModels(): Promise<EngineModelInfo[]> {
    this.listCalls++;
    return this.catalog;
  }
  async getDefaultModel(): Promise<EngineModelInfo | undefined> {
    return this.defaultModel;
  }
  async setModel(): Promise<void> {}
}

function makeComposer(engine: EngineAdapter): ComposerDataService {
  const composer = track(new ComposerDataService(undefined, undefined));
  (composer as unknown as { engine: unknown }).engine = engine;
  return composer;
}

async function waitFor(cond: () => boolean, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  for (;;) {
    if (cond()) {
      return;
    }
    if (Date.now() - start > timeoutMs) {
      throw new Error("timed out waiting for condition");
    }
    await new Promise((r) => setTimeout(r, 25));
  }
}

const CATALOG: EngineModelInfo[] = [
  { id: "m128", providerID: "p", name: "M128", contextTokenLimit: 128_000 },
  { id: "m1m", providerID: "p", name: "M1M", contextTokenLimit: 1_000_000 },
  { id: "nolimit", providerID: "p", name: "NoLimit" },
];

describe("ComposerDataService context denominator (GAPS-183)", () => {
  it("explicit model: fallback first, then the catalog's real 128k in ring AND report", async () => {
    const composer = makeComposer(new FakeCatalogEngine(CATALOG));
    composer.models.setSelection({
      kind: "explicit",
      ref: { id: "m128", providerID: "p" },
      label: "M128",
    });

    // Synchronous first compute: the catalog refresh has not landed yet,
    // so the fork fallback is served honestly instead of blocking.
    const first = composer.getContextUsageSnapshot();
    assert.strictEqual(first.contextWindowTokens, FALLBACK_CONTEXT_WINDOW_TOKENS);
    assert.strictEqual(FALLBACK_CONTEXT_WINDOW_TOKENS, 200_000);

    await waitFor(() => composer.getContextUsageSnapshot().contextWindowTokens === 128_000);
    const snap = composer.getContextUsageSnapshot();
    assert.strictEqual(snap.contextWindowTokens, 128_000);
    // windowPct is computed against the SAME denominator.
    assert.strictEqual(
      snap.windowPct,
      Math.min(100, Math.round((snap.totalTokens / 128_000) * 100)),
    );

    const report = composer.getContextUsageReport({});
    assert.strictEqual(report.contextWindowSize, 128_000);
    assert.strictEqual(report.contextWindowLabel, "128,000");
    assert.strictEqual(
      report.percentFullLabel,
      `${Math.round((report.totalTokensUsed / 128_000) * 100)}% Full`,
    );
    composer.dispose();
  });

  it("model change: denominator follows the new model (1M), never the old one", async () => {
    const composer = makeComposer(new FakeCatalogEngine(CATALOG));
    composer.models.setSelection({
      kind: "explicit",
      ref: { id: "m128", providerID: "p" },
      label: "M128",
    });
    await waitFor(() => composer.getContextUsageSnapshot().contextWindowTokens === 128_000);

    composer.models.setSelection({
      kind: "explicit",
      ref: { id: "m1m", providerID: "p" },
      label: "M1M",
    });
    // Synchronously after the switch the OLD model's 128k must not be
    // served for the new model — the keyed cache misses and the fallback
    // shows until the new limit resolves.
    assert.strictEqual(
      composer.getContextUsageSnapshot().contextWindowTokens,
      FALLBACK_CONTEXT_WINDOW_TOKENS,
    );
    await waitFor(() => composer.getContextUsageSnapshot().contextWindowTokens === 1_000_000);
    const report = composer.getContextUsageReport({});
    assert.strictEqual(report.contextWindowSize, 1_000_000);
    assert.strictEqual(report.contextWindowLabel, "1,000,000");
    composer.dispose();
  });

  it("unknown model / limit-less catalog entry: stays on the 200k fallback", async () => {
    const engine = new FakeCatalogEngine(CATALOG);
    const composer = makeComposer(engine);
    composer.models.setSelection({
      kind: "explicit",
      ref: { id: "ghost", providerID: "p" },
      label: "Ghost",
    });
    composer.getContextUsageSnapshot();
    await waitFor(() => engine.listCalls >= 1);
    // Give the refresh a chance to (not) land, then confirm the fallback.
    await new Promise((r) => setTimeout(r, 100));
    assert.strictEqual(composer.getContextUsageSnapshot().contextWindowTokens, 200_000);
    assert.strictEqual(composer.getContextUsageReport({}).contextWindowSize, 200_000);

    composer.models.setSelection({
      kind: "explicit",
      ref: { id: "nolimit", providerID: "p" },
      label: "NoLimit",
    });
    composer.getContextUsageSnapshot();
    await new Promise((r) => setTimeout(r, 100));
    assert.strictEqual(composer.getContextUsageSnapshot().contextWindowTokens, 200_000);
    composer.dispose();
  });

  it("auto selection resolves through the engine default model", async () => {
    const def: EngineModelInfo = { id: "m128", providerID: "p", name: "M128", contextTokenLimit: 128_000 };
    const composer = makeComposer(new FakeCatalogEngine(CATALOG, def));
    // Default selection is "auto" (no explicit ref).
    composer.getContextUsageSnapshot();
    await waitFor(() => composer.getContextUsageSnapshot().contextWindowTokens === 128_000);
    composer.dispose();
  });

  it("stub engine (no catalog): fallback, no throw", async () => {
    const composer = makeComposer(
      new StubEngineAdapter(async () => ({ optionId: "approve" })),
    );
    const snap = composer.getContextUsageSnapshot();
    assert.strictEqual(snap.contextWindowTokens, 200_000);
    assert.strictEqual(composer.getContextUsageReport({}).contextWindowSize, 200_000);
    composer.dispose();
  });
});
