/**
 * ModelService tests (node:test, zero extra deps).
 *
 * Unit: selection state, workspaceState-backed persistence (via a fake store),
 * change notification + dispose, labelFor / refEquals / refToString helpers.
 *
 * Run after `tsc`:  node out/services/test/run-model-tests.mjs
 */
import { describe, it } from "node:test";
import * as assert from "node:assert";
import {
  AUTO_MODEL_DESCRIPTION,
  AUTO_MODEL_LABEL,
  AUTO_MODEL_VALUE,
  CURSOR_DEFAULT_DESCRIPTION,
  CURSOR_DEFAULT_LABEL,
  CURSOR_DEFAULT_VALUE,
  DEFAULT_MODEL_LABEL,
  InMemoryModelStore,
  ModelService,
  ModelSelection,
  ModelSelectionStore,
  autoSelection,
  buildModelPickerEntries,
  cursorDefaultSelection,
  filterEnabledModels,
  isModelEnabled,
  nextEnabledModel,
  selectionKind,
  selectionValue,
} from "../modelService";

function makeStore(saved?: ModelSelection): ModelSelectionStore & { saved?: ModelSelection } {
  return {
    saved,
    load() {
      return this.saved;
    },
    save(selection: ModelSelection) {
      this.saved = selection;
    },
  };
}

describe("ModelService", () => {
  it("defaults to auto with no persisted selection", () => {
    const svc = new ModelService(new InMemoryModelStore());
    const sel = svc.getSelection();
    assert.strictEqual(sel.label, DEFAULT_MODEL_LABEL);
    assert.strictEqual(sel.ref, undefined);
  });

  it("restores the persisted selection from the store", () => {
    const ref = { id: "claude-sonnet-4", providerID: "anthropic" };
    const store = makeStore({ ref, label: "Claude Sonnet 4" });
    const svc = new ModelService(store);
    assert.deepStrictEqual(svc.getSelection().ref, ref);
    assert.strictEqual(svc.getSelection().label, "Claude Sonnet 4");
  });

  it("setSelection persists and notifies listeners", () => {
    const store = makeStore();
    const svc = new ModelService(store);
    const seen: ModelSelection[] = [];
    svc.onDidChangeModel((sel) => seen.push(sel));
    const ref = { id: "gpt-5", providerID: "openai" };
    svc.setSelection({ ref, label: "GPT-5" });
    assert.deepStrictEqual(svc.getSelection().ref, ref);
    assert.deepStrictEqual(store.saved?.ref, ref);
    assert.strictEqual(seen.length, 1);
    assert.deepStrictEqual(seen[0].ref, ref);
  });

  it("a fresh service reads the persisted selection (workspace reload)", () => {
    const store = makeStore();
    new ModelService(store).setSelection({
      ref: { id: "deepseek-chat", providerID: "deepseek" },
      label: "DeepSeek Chat",
    });
    const reloaded = new ModelService(store);
    assert.strictEqual(reloaded.getSelection().label, "DeepSeek Chat");
    assert.deepStrictEqual(reloaded.getSelection().ref, { id: "deepseek-chat", providerID: "deepseek" });
  });

  it("switching back to auto clears the ref but keeps a label", () => {
    const svc = new ModelService(new InMemoryModelStore());
    svc.setSelection({ ref: { id: "x", providerID: "y" }, label: "X" });
    svc.setSelection({ label: "auto" });
    assert.strictEqual(svc.getSelection().ref, undefined);
    assert.strictEqual(svc.getSelection().label, "auto");
  });

  it("listener dispose stops notifications", () => {
    const svc = new ModelService(new InMemoryModelStore());
    let calls = 0;
    const sub = svc.onDidChangeModel(() => calls++);
    sub.dispose();
    svc.setSelection({ label: "auto" });
    assert.strictEqual(calls, 0);
  });

  it("a throwing listener does not break persistence", () => {
    const store = makeStore();
    const svc = new ModelService(store);
    svc.onDidChangeModel(() => {
      throw new Error("boom");
    });
    svc.setSelection({ label: "auto" });
    assert.deepStrictEqual(store.saved, { label: "auto" });
  });

  it("ignores a malformed persisted selection", () => {
    const store = makeStore({ label: "" } as unknown as ModelSelection);
    const svc = new ModelService(store);
    assert.strictEqual(svc.getSelection().label, DEFAULT_MODEL_LABEL);
  });
});

describe("ModelService helpers", () => {
  it("labelFor prefers the friendly name, falls back to id", () => {
    assert.strictEqual(
      ModelService.labelFor({ id: "claude-sonnet-4-5", providerID: "anthropic", name: "Claude Sonnet 4.5" }),
      "Claude Sonnet 4.5",
    );
    assert.strictEqual(
      ModelService.labelFor({ id: "mystery-1", providerID: "x", name: "" }),
      "mystery-1",
    );
  });

  it("refEquals compares provider + id + variant", () => {
    const a = { id: "m", providerID: "p" };
    assert.ok(ModelService.refEquals(a, { id: "m", providerID: "p" }));
    assert.ok(!ModelService.refEquals(a, { id: "m", providerID: "q" }));
    assert.ok(!ModelService.refEquals(a, { id: "n", providerID: "p" }));
    assert.ok(!ModelService.refEquals(a, undefined));
    assert.ok(ModelService.refEquals(undefined, undefined));
    assert.ok(
      !ModelService.refEquals({ id: "m", providerID: "p", variant: "v1" }, { id: "m", providerID: "p" }),
    );
  });

  it("refToString renders the wire form", () => {
    assert.strictEqual(ModelService.refToString({ id: "m", providerID: "p" }), "p/m");
    assert.strictEqual(
      ModelService.refToString({ id: "m", providerID: "p", variant: "v2" }),
      "p/m#v2",
    );
  });

  it("refFromString round-trips the wire form and rejects garbage", () => {
    assert.deepStrictEqual(ModelService.refFromString("p/m"), { providerID: "p", id: "m" });
    assert.deepStrictEqual(ModelService.refFromString("p/m#v2"), {
      providerID: "p",
      id: "m",
      variant: "v2",
    });
    assert.strictEqual(ModelService.refFromString(""), undefined);
    assert.strictEqual(ModelService.refFromString("noslash"), undefined);
    assert.strictEqual(ModelService.refFromString("/m"), undefined);
    assert.strictEqual(ModelService.refFromString("p/"), undefined);
    assert.strictEqual(ModelService.refFromString("  "), undefined);
  });
});

describe("M-04 enabled-models allowlist", () => {
  const models = [
    { id: "a", providerID: "p1", name: "A" },
    { id: "b", providerID: "p1", name: "B", variant: "v2" },
    { id: "c", providerID: "p2", name: "C" },
  ];

  it("empty list enables every model", () => {
    for (const m of models) {
      assert.ok(isModelEnabled({ id: m.id, providerID: m.providerID }, []));
    }
    assert.deepStrictEqual(filterEnabledModels(models, []).length, 3);
  });

  it("non-empty list is an exact allowlist (variant-aware)", () => {
    const allow = ["p1/a", "p1/b#v2"];
    assert.ok(isModelEnabled({ id: "a", providerID: "p1" }, allow));
    assert.ok(isModelEnabled({ id: "b", providerID: "p1", variant: "v2" }, allow));
    assert.ok(!isModelEnabled({ id: "b", providerID: "p1" }, allow)); // variant mismatch
    assert.ok(!isModelEnabled({ id: "c", providerID: "p2" }, allow));
    assert.deepStrictEqual(
      filterEnabledModels(models, allow).map((m) => m.id),
      ["a", "b"],
    );
  });

  it("ignores malformed/non-string entries instead of throwing", () => {
    const allow = ["p1/a", "garbage", "", 42 as unknown as string];
    assert.ok(isModelEnabled({ id: "a", providerID: "p1" }, allow));
    assert.ok(!isModelEnabled({ id: "c", providerID: "p2" }, allow));
  });
});

describe("ide.cycleModel order", () => {  const models = [
    { id: "a", providerID: "p1", name: "A" },
    { id: "b", providerID: "p1", name: "B" },
    { id: "c", providerID: "p2", name: "C" },
  ];

  it("cycles forward and wraps around", () => {
    assert.strictEqual(nextEnabledModel(models, [], undefined)?.id, "a");
    assert.strictEqual(nextEnabledModel(models, [], { id: "a", providerID: "p1" })?.id, "b");
    assert.strictEqual(nextEnabledModel(models, [], { id: "c", providerID: "p2" })?.id, "a");
  });

  it("skips disabled models", () => {
    const allow = ["p1/a", "p2/c"];
    assert.strictEqual(nextEnabledModel(models, allow, { id: "a", providerID: "p1" })?.id, "c");
    assert.strictEqual(nextEnabledModel(models, allow, { id: "c", providerID: "p2" })?.id, "a");
  });

  it("a disabled current selection restarts from the first enabled model", () => {
    const allow = ["p2/c"];
    assert.strictEqual(nextEnabledModel(models, allow, { id: "b", providerID: "p1" })?.id, "c");
  });

  it("returns undefined when nothing is enabled", () => {
    assert.strictEqual(nextEnabledModel(models, ["p9/zzz"], undefined), undefined);
    assert.strictEqual(nextEnabledModel([], [], undefined), undefined);
  });
});

describe("P1 DEV-MODEL-PICKER-ENTRIES: Auto + Cursor Default picker entries", () => {
  const models = [
    { id: "a", providerID: "p1", name: "A" },
    { id: "b", providerID: "p1", name: "B" },
  ];

  it("picker list starts with Auto and Cursor Default, verbatim labels/values/descriptions", () => {
    const entries = buildModelPickerEntries(models, []);
    assert.strictEqual(entries[0].value, AUTO_MODEL_VALUE);
    assert.strictEqual(entries[0].value, "auto");
    assert.strictEqual(entries[0].label, "Auto");
    assert.strictEqual(entries[0].label, AUTO_MODEL_LABEL);
    assert.strictEqual(entries[0].description, "Balanced quality and speed, recommended for most tasks");
    assert.strictEqual(entries[0].description, AUTO_MODEL_DESCRIPTION);
    assert.strictEqual(entries[0].ref, undefined);

    assert.strictEqual(entries[1].value, CURSOR_DEFAULT_VALUE);
    assert.strictEqual(entries[1].value, "cursor-default");
    assert.strictEqual(entries[1].label, "Cursor Default");
    assert.strictEqual(entries[1].label, CURSOR_DEFAULT_LABEL);
    assert.strictEqual(entries[1].description, CURSOR_DEFAULT_DESCRIPTION);
    assert.strictEqual(entries[1].ref, undefined);
  });

  it("engine models follow the two virtual entries, with wire-form values", () => {
    const entries = buildModelPickerEntries(models, []);
    assert.strictEqual(entries.length, 4);
    assert.strictEqual(entries[2].value, "p1/a");
    assert.strictEqual(entries[2].label, "A");
    assert.deepStrictEqual(entries[2].ref, { id: "a", providerID: "p1" });
    assert.strictEqual(entries[3].value, "p1/b");
  });

  it("disabled engine models are filtered but the virtual entries always stay", () => {
    const entries = buildModelPickerEntries(models, ["p1/b"]);
    assert.deepStrictEqual(
      entries.map((e) => e.value),
      ["auto", "cursor-default", "p1/b"],
    );
  });

  it("autoSelection()/cursorDefaultSelection() build the canonical selections", () => {
    assert.deepStrictEqual(autoSelection(), { kind: "auto", label: "Auto" });
    assert.deepStrictEqual(cursorDefaultSelection(), { kind: "cursor-default", label: "Cursor Default" });
  });
});

describe("selection kind + value (virtual selectors are automatic, not fixed models)", () => {
  it("legacy persisted { label: 'auto' } (no kind/ref) is auto", () => {
    assert.strictEqual(selectionKind({ label: "auto" }), "auto");
    assert.strictEqual(selectionValue({ label: "auto" }), "auto");
  });

  it("legacy persisted explicit ref is explicit", () => {
    const sel: ModelSelection = { ref: { id: "m", providerID: "p" }, label: "M" };
    assert.strictEqual(selectionKind(sel), "explicit");
    assert.strictEqual(selectionValue(sel), "p/m");
  });

  it("cursor-default selection round-trips through the store", () => {
    const store = new InMemoryModelStore();
    const svc = new ModelService(store);
    svc.setSelection(cursorDefaultSelection());
    const reloaded = new ModelService(store);
    assert.strictEqual(selectionKind(reloaded.getSelection()), "cursor-default");
    assert.strictEqual(selectionValue(reloaded.getSelection()), "cursor-default");
    assert.strictEqual(reloaded.getSelection().label, "Cursor Default");
    assert.strictEqual(reloaded.getSelection().ref, undefined);
  });

  it("cycling from cursor-default restarts at the first enabled model (automatic, not fixed)", () => {
    const models = [
      { id: "a", providerID: "p1", name: "A" },
      { id: "b", providerID: "p1", name: "B" },
    ];
    // Both virtual selectors carry no ref — the cycler treats them as automatic.
    assert.strictEqual(selectionValue(autoSelection()), "auto");
    assert.strictEqual(selectionValue(cursorDefaultSelection()), "cursor-default");
    assert.strictEqual(nextEnabledModel(models, [], cursorDefaultSelection().ref)?.id, "a");
    assert.strictEqual(nextEnabledModel(models, [], autoSelection().ref)?.id, "a");
  });
});
