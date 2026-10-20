/**
 * modelParameterService tests (node:test, zero extra deps).
 *
 * Covers the DEV-GAPS-29 mechanism for Cursor 3.25.9's "Cycle Model
 * Parameter" (composer.cycleModelParameter): the binary scans the current
 * model's parameterDefinitions for `isCycleableByHotkey && count > 1` and
 * cycles the focused parameter through its options, falling back to cycling
 * the model when nothing is cycleable.
 *
 * Run after `tsc`:  node out/services/modelParameterService.test.js
 */
import { describe, it } from "node:test";
import * as assert from "node:assert";
import {
  MODEL_VARIANT_PARAMETER_ID,
  buildModelParameterDefinitions,
  findCycleableParameters,
  nextParameterOption,
  type ModelParameterDefinition,
} from "./modelParameterService";
import type { EngineModelInfo } from "./agentService";

function def(over: Partial<ModelParameterDefinition>): ModelParameterDefinition {
  return {
    id: "p",
    label: "P",
    keywords: [],
    options: ["a", "b"],
    isCycleableByHotkey: true,
    ...over,
  };
}

describe("findCycleableParameters (binary isCycleableByHotkey && count > 1)", () => {
  it("keeps parameters with isCycleableByHotkey and more than one option", () => {
    const kept = findCycleableParameters([def({})]);
    assert.strictEqual(kept.length, 1);
  });

  it("drops parameters without isCycleableByHotkey", () => {
    assert.deepStrictEqual(findCycleableParameters([def({ isCycleableByHotkey: false })]), []);
  });

  it("drops parameters with a single option (binary count > 1 gate)", () => {
    assert.deepStrictEqual(findCycleableParameters([def({ options: ["only"] })]), []);
  });

  it("drops parameters with no options", () => {
    assert.deepStrictEqual(findCycleableParameters([def({ options: [] })]), []);
  });
});

describe("nextParameterOption (wrap-around)", () => {
  const d = def({ options: ["low", "high"] });

  it("advances to the next option", () => {
    assert.strictEqual(nextParameterOption(d, "low"), "high");
  });

  it("wraps from the last option to the first", () => {
    assert.strictEqual(nextParameterOption(d, "high"), "low");
  });

  it("starts at the first option when the current value is unknown", () => {
    assert.strictEqual(nextParameterOption(d, "nope"), "low");
    assert.strictEqual(nextParameterOption(d, undefined), "low");
  });
});

describe("buildModelParameterDefinitions (engine catalog variants)", () => {
  const catalog: EngineModelInfo[] = [
    { id: "gpt-5", providerID: "openai", name: "GPT-5" },
    { id: "gpt-5", providerID: "openai", name: "GPT-5", variant: "thinking" },
    { id: "gpt-5", providerID: "openai", name: "GPT-5", variant: "standard" },
    { id: "sonnet", providerID: "anthropic", name: "Sonnet" },
  ];

  it("builds a cycleable variant parameter for a multi-variant model", () => {
    const defs = buildModelParameterDefinitions(catalog, {
      id: "gpt-5",
      providerID: "openai",
      variant: "thinking",
    });
    assert.strictEqual(defs.length, 1);
    const v = defs[0]!;
    assert.strictEqual(v.id, MODEL_VARIANT_PARAMETER_ID);
    assert.strictEqual(v.isCycleableByHotkey, true);
    assert.deepStrictEqual(v.options, ["", "thinking", "standard"]);
    // The binary's count>1 gate passes → the extension will cycle it.
    assert.strictEqual(findCycleableParameters(defs).length, 1);
  });

  it("a single-variant model is NOT cycleable (binary count>1 gate)", () => {
    const defs = buildModelParameterDefinitions(catalog, { id: "sonnet", providerID: "anthropic" });
    assert.strictEqual(defs.length, 1);
    assert.deepStrictEqual(findCycleableParameters(defs), []);
  });

  it("returns no definitions for the virtual auto/cursor-default selectors", () => {
    assert.deepStrictEqual(buildModelParameterDefinitions(catalog, undefined), []);
  });

  it("returns no definitions for a model missing from the catalog", () => {
    assert.deepStrictEqual(
      buildModelParameterDefinitions(catalog, { id: "ghost", providerID: "openai" }),
      [],
    );
  });
});
