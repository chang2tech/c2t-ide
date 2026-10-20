/**
 * DEV-GAPS-88 — models-catalog context-window field.
 *
 * Evidence: Cursor 3.25.9 `aiserver.v1.AvailableModelsResponse.AvailableModel`
 * carries `context_token_limit` (field 15, int32) and
 * `context_token_limit_for_max_mode` (field 16) — JS `contextTokenLimit` /
 * `contextTokenLimitForMaxMode` (workbench.glass.main.js ~offset 1947656).
 * The fork engine's wire source is Model.Info `limit.context`
 * (ide-code packages/schema/src/model.ts). These tests cover the type,
 * the wire→catalog mapping in IdeCodeEngineAdapter.listModels /
 * getDefaultModel, the pure extractor, and the picker-entry consumer.
 *
 * The vscode-shim import MUST stay first: it stubs require("vscode")
 * before the adapter chain loads under plain node.
 */
import "../mcp/test/vscode-shim";
import { describe, it } from "node:test";
import * as assert from "node:assert";
import type { EngineModelInfo } from "./agentService";
import {
  buildModelPickerEntries,
  contextTokenLimitFromEngineModel,
  resolveActiveContextTokenLimit,
} from "./modelService";
import { IdeCodeEngineAdapter } from "./ideCodeEngineAdapter";

/** Adapter with the server boundary stubbed: api() serves canned wire data. */
function adapterServing(routes: Record<string, unknown>): IdeCodeEngineAdapter {
  const adapter = new IdeCodeEngineAdapter({
    enginePath: "/nonexistent-engine",
    output: { appendLine: () => undefined } as never,
    requestApproval: async () => ({ optionId: "skip" }) as never,
  });
  const anyAdapter = adapter as unknown as Record<string, unknown>;
  anyAdapter.ensureServer = async () => undefined;
  anyAdapter.api = async (_method: string, route: string) => {
    if (!(route in routes)) throw new Error(`unstubbed route ${route}`);
    return routes[route];
  };
  return adapter;
}

describe("contextTokenLimitFromEngineModel (DEV-GAPS-88)", () => {
  it("reads limit.context (engine Model.Info wire shape)", () => {
    assert.strictEqual(
      contextTokenLimitFromEngineModel({ limit: { context: 200_000, output: 32_000 } }),
      200_000,
    );
    assert.strictEqual(contextTokenLimitFromEngineModel({ limit: { context: 1_000_000 } }), 1_000_000);
  });

  it("returns undefined when the engine reports no usable limit — never a guess", () => {
    assert.strictEqual(contextTokenLimitFromEngineModel({}), undefined);
    assert.strictEqual(contextTokenLimitFromEngineModel({ limit: {} }), undefined);
    assert.strictEqual(contextTokenLimitFromEngineModel({ limit: { context: 0 } }), undefined);
    assert.strictEqual(contextTokenLimitFromEngineModel({ limit: { context: -5 } }), undefined);
    assert.strictEqual(contextTokenLimitFromEngineModel({ limit: { context: "200000" } }), undefined);
    assert.strictEqual(contextTokenLimitFromEngineModel({ limit: { context: Number.NaN } }), undefined);
    assert.strictEqual(contextTokenLimitFromEngineModel({ limit: null }), undefined);
    assert.strictEqual(contextTokenLimitFromEngineModel(null), undefined);
    assert.strictEqual(contextTokenLimitFromEngineModel("model"), undefined);
  });
});

describe("IdeCodeEngineAdapter model catalog mapping (DEV-GAPS-88)", () => {
  it("listModels maps limit.context → contextTokenLimit; omits it when absent", async () => {
    const adapter = adapterServing({
      "/api/model": {
        data: [
          {
            id: "big-context",
            providerID: "prov",
            name: "Big Context",
            limit: { context: 400_000, input: 380_000, output: 64_000 },
          },
          { id: "no-limit", providerID: "prov", name: "No Limit" },
          { id: "bad-limit", providerID: "prov", limit: { context: "lots" } },
          { name: "missing ids are filtered out" },
        ],
      },
    });
    const models = await adapter.listModels();
    assert.strictEqual(models.length, 3);
    const big = models.find((m) => m.id === "big-context");
    assert.strictEqual(big?.contextTokenLimit, 400_000);
    // The engine has no max-mode limit: the field must stay absent.
    assert.strictEqual(big?.contextTokenLimitForMaxMode, undefined);
    assert.ok(big && !("contextTokenLimitForMaxMode" in big));
    const noLimit = models.find((m) => m.id === "no-limit");
    assert.ok(noLimit && !("contextTokenLimit" in noLimit), "no fabricated context limit");
    const badLimit = models.find((m) => m.id === "bad-limit");
    assert.ok(badLimit && !("contextTokenLimit" in badLimit));
    assert.strictEqual(badLimit?.name, "bad-limit", "name still falls back to id");
  });

  it("getDefaultModel carries contextTokenLimit from the same wire shape", async () => {
    const adapter = adapterServing({
      "/api/model/default": {
        data: { id: "def", providerID: "prov", name: "Default", limit: { context: 128_000, output: 8_192 } },
      },
    });
    const def = await adapter.getDefaultModel();
    assert.strictEqual(def?.contextTokenLimit, 128_000);
  });
});

describe("resolveActiveContextTokenLimit (GAPS-183)", () => {
  const catalog: EngineModelInfo[] = [
    { id: "small", providerID: "p", name: "Small", contextTokenLimit: 128_000 },
    { id: "big", providerID: "p", name: "Big", contextTokenLimit: 1_000_000 },
    { id: "varianty", providerID: "p", name: "Varianty", variant: "thinking", contextTokenLimit: 262_144 },
    { id: "no-limit", providerID: "p", name: "No Limit" },
  ];

  it("explicit selection resolves the catalog entry's real limit (128k / 1M)", () => {
    assert.strictEqual(
      resolveActiveContextTokenLimit({
        selection: { kind: "explicit", ref: { id: "small", providerID: "p" }, label: "Small" },
        catalog,
      }),
      128_000,
    );
    assert.strictEqual(
      resolveActiveContextTokenLimit({
        selection: { kind: "explicit", ref: { id: "big", providerID: "p" }, label: "Big" },
        catalog,
      }),
      1_000_000,
    );
  });

  it("explicit selection prefers the exact variant match, then provider+id", () => {
    assert.strictEqual(
      resolveActiveContextTokenLimit({
        selection: { kind: "explicit", ref: { id: "varianty", providerID: "p", variant: "thinking" }, label: "V" },
        catalog,
      }),
      262_144,
    );
    // Selection without the variant still resolves the same underlying model.
    assert.strictEqual(
      resolveActiveContextTokenLimit({
        selection: { kind: "explicit", ref: { id: "varianty", providerID: "p" }, label: "V" },
        catalog,
      }),
      262_144,
    );
  });

  it("unknown model or limit-less entry → undefined (caller falls back, never guesses)", () => {
    assert.strictEqual(
      resolveActiveContextTokenLimit({
        selection: { kind: "explicit", ref: { id: "ghost", providerID: "p" }, label: "Ghost" },
        catalog,
      }),
      undefined,
    );
    assert.strictEqual(
      resolveActiveContextTokenLimit({
        selection: { kind: "explicit", ref: { id: "no-limit", providerID: "p" }, label: "No Limit" },
        catalog,
      }),
      undefined,
    );
    assert.strictEqual(
      resolveActiveContextTokenLimit({
        selection: { kind: "explicit", ref: { id: "small", providerID: "other" }, label: "Small" },
        catalog,
      }),
      undefined,
    );
  });

  it("auto / cursor-default resolve through the engine default model only", () => {
    const def: EngineModelInfo = { id: "small", providerID: "p", name: "Small", contextTokenLimit: 128_000 };
    assert.strictEqual(
      resolveActiveContextTokenLimit({ selection: { kind: "auto", label: "Auto" }, catalog, defaultModel: def }),
      128_000,
    );
    assert.strictEqual(
      resolveActiveContextTokenLimit({
        selection: { kind: "cursor-default", label: "Cursor Default" },
        catalog,
        defaultModel: def,
      }),
      128_000,
    );
    // No default model known → unresolved (the catalog alone cannot name the default).
    assert.strictEqual(
      resolveActiveContextTokenLimit({ selection: { kind: "auto", label: "Auto" }, catalog }),
      undefined,
    );
  });

  it("non-positive / non-finite catalog limits are not usable", () => {
    const bad: EngineModelInfo[] = [
      { id: "zero", providerID: "p", name: "Zero", contextTokenLimit: 0 },
      { id: "nan", providerID: "p", name: "NaN", contextTokenLimit: Number.NaN },
    ];
    assert.strictEqual(
      resolveActiveContextTokenLimit({
        selection: { kind: "explicit", ref: { id: "zero", providerID: "p" }, label: "Zero" },
        catalog: bad,
      }),
      undefined,
    );
    assert.strictEqual(
      resolveActiveContextTokenLimit({
        selection: { kind: "explicit", ref: { id: "nan", providerID: "p" }, label: "NaN" },
        catalog: bad,
      }),
      undefined,
    );
  });
});

describe("model picker consumer (DEV-GAPS-88)", () => {
  it("buildModelPickerEntries carries contextTokenLimit through to the entry", () => {
    const catalog: EngineModelInfo[] = [
      { id: "a", providerID: "p", name: "A", contextTokenLimit: 262_144 },
      { id: "b", providerID: "p", name: "B" },
    ];
    const entries = buildModelPickerEntries(catalog, []);
    const a = entries.find((e) => e.ref?.id === "a");
    const b = entries.find((e) => e.ref?.id === "b");
    assert.strictEqual(a?.contextTokenLimit, 262_144);
    assert.strictEqual(b?.contextTokenLimit, undefined);
    // Virtual entries never carry a context limit.
    assert.strictEqual(entries[0]?.contextTokenLimit, undefined);
    assert.strictEqual(entries[1]?.contextTokenLimit, undefined);
  });

  it("EngineModelInfo type carries both Cursor fields (compile-time shape)", () => {
    const info: EngineModelInfo = {
      id: "x",
      providerID: "p",
      name: "X",
      contextTokenLimit: 200_000,
      contextTokenLimitForMaxMode: 1_000_000,
    };
    assert.strictEqual(info.contextTokenLimit, 200_000);
    assert.strictEqual(info.contextTokenLimitForMaxMode, 1_000_000);
  });
});
