/**
 * ExperimentalIndex API tests — GAPS-62 rework (node:test, zero extra
 * deps). Assertions pin BINARY-VERIFIED descriptor facts from the
 * reference Cursor app (3.25.6; spot-checked 3.25.9):
 * - `extensions/cursor-always-local/dist/main.js` compact protobuf-es
 *   descriptors for Create/List/ListenExperimentalIndex*, IndexFileData,
 *   and the pipeline RPC messages.
 * - `out/vs/workbench/workbench.glass.main.js` non-compact `aiserver.v1`
 *   descriptors confirming field numbers/repeated/message types.
 *
 * Non-tautology guards:
 * - `CreateExperimentalIndexRequest.files` must be `string[]` (binary
 *   `files 9*`) while `ListExperimentalIndexFilesResponse.files` must be
 *   `IndexFileData[]` (binary `files #0*` — objects, not strings).
 * - The RPC family is NOT "exactly three": the pipeline RPC list is
 *   asserted verbatim.
 * - Stage item shapes (request+response pairing, reqUuid, ErrorItem
 *   fields) are asserted against the descriptor layouts.
 * - The stage emission ORDER (register → choose → summarize → ready) is
 *   INFERRED per the module header; this test pins the stand-in behavior,
 *   not a server-side claim.
 *
 * Run after `tsc`:  node --test out/services/test/run-gaps62-experimental-index-tests.js
 */
import { describe, it } from "node:test";
import * as assert from "node:assert";
import {
  ExperimentalIndexApi,
  ExperimentalIndexError,
  EXPERIMENTAL_INDEX_RPCS,
  EXPERIMENTAL_INDEX_PIPELINE_RPCS,
  EXPERIMENTAL_MODEL_OPT_OUT_RPC,
  EXPERIMENTAL_INDEX_MESSAGE_FIELDS,
  type ListenExperimentalIndexResponse,
} from "../experimentalIndexApi";

async function collect(api: ExperimentalIndexApi, indexId: string): Promise<ListenExperimentalIndexResponse[]> {
  const out: ListenExperimentalIndexResponse[] = [];
  for await (const r of api.listen({ indexId })) out.push(r);
  return out;
}

describe("RPC names (binary-derived AiService family)", () => {
  it("top-level RPCs are the three observed", () => {
    assert.deepStrictEqual([...EXPERIMENTAL_INDEX_RPCS], [
      "CreateExperimentalIndex",
      "ListExperimentalIndexFiles",
      "ListenExperimentalIndex",
    ]);
  });

  it("the family is NOT 'exactly three' — pipeline RPCs exist (fabrication guard)", () => {
    assert.deepStrictEqual([...EXPERIMENTAL_INDEX_PIPELINE_RPCS], [
      "RegisterFileToIndex",
      "SetupIndexDependencies",
      "ComputeIndexTopoSort",
      "ChooseCodeReferences",
      "RegisterCodeReferences",
      "SummarizeWithReferences",
    ]);
    assert.strictEqual(EXPERIMENTAL_MODEL_OPT_OUT_RPC, "UpdateBackgroundComposerExperimentalModelOptOut");
  });
});

describe("field numbers (descriptor-verified)", () => {
  it("Create/List/IndexFileData fields", () => {
    assert.deepStrictEqual(EXPERIMENTAL_INDEX_MESSAGE_FIELDS.CreateExperimentalIndexRequest, {
      files: 1,
      targetDir: 2,
      repo: 3,
    });
    assert.deepStrictEqual(EXPERIMENTAL_INDEX_MESSAGE_FIELDS.ListExperimentalIndexFilesResponse, {
      indexId: 1,
      files: 2,
    });
    assert.deepStrictEqual(EXPERIMENTAL_INDEX_MESSAGE_FIELDS.IndexFileData, {
      indexId: 1,
      workspaceRelativePath: 2,
      stage: 3,
      order: 4,
      nodes: 5,
    });
    assert.deepStrictEqual(EXPERIMENTAL_INDEX_MESSAGE_FIELDS.IndexFileDataNodeData, {
      nodeId: 1,
      stage: 2,
      content: 3,
      summary: 4,
    });
  });

  it("listen oneof fields are 2-6 and ErrorItem fields are 1-6", () => {
    assert.deepStrictEqual(EXPERIMENTAL_INDEX_MESSAGE_FIELDS.ListenExperimentalIndexResponse, {
      indexId: 1,
      ready: 2,
      register: 3,
      choose: 4,
      summarize: 5,
      error: 6,
    });
    assert.deepStrictEqual(EXPERIMENTAL_INDEX_MESSAGE_FIELDS.ListenExperimentalIndexResponseErrorItem, {
      message: 1,
      statusCode: 2,
      register: 3,
      choose: 4,
      summarize: 5,
      reqUuid: 6,
    });
    assert.deepStrictEqual(
      EXPERIMENTAL_INDEX_MESSAGE_FIELDS.UpdateBackgroundComposerExperimentalModelOptOutResponse,
      {},
    );
    assert.deepStrictEqual(EXPERIMENTAL_INDEX_MESSAGE_FIELDS.RegisterFileToIndexResponse, {
      fileId: 1,
      rootContextNodeId: 2,
      dependencyResolutionAttempts: 3,
      fileData: 4,
    });
  });
});

describe("CreateExperimentalIndex / ListExperimentalIndexFiles", () => {
  it("creates an index and lists IndexFileData records (NOT strings)", () => {
    const api = new ExperimentalIndexApi();
    const { indexId } = api.createIndex({
      files: ["src/a.ts", "src/b.ts"],
      targetDir: "/repo/target",
      repo: "acme/repo",
    });
    assert.ok(indexId.length > 0);
    const listed = api.listIndexFiles({ indexId });
    assert.strictEqual(listed.indexId, indexId);
    assert.strictEqual(listed.files.length, 2);
    for (const f of listed.files) {
      assert.strictEqual(typeof f, "object"); // IndexFileData, not a string path
      assert.strictEqual(f.indexId, indexId);
      assert.deepStrictEqual(f.nodes, []);
    }
    assert.deepStrictEqual(
      listed.files.map((f) => f.workspaceRelativePath),
      ["src/a.ts", "src/b.ts"],
    );
    assert.deepStrictEqual(
      listed.files.map((f) => f.order),
      [0, 1],
    );
  });

  it("requires repo and targetDir", () => {
    const api = new ExperimentalIndexApi();
    assert.throws(
      () => api.createIndex({ files: [], targetDir: "/t", repo: "" }),
      ExperimentalIndexError,
    );
    assert.throws(
      () => api.createIndex({ files: [], targetDir: "", repo: "r" }),
      ExperimentalIndexError,
    );
  });

  it("throws for an unknown indexId", () => {
    const api = new ExperimentalIndexApi();
    assert.throws(() => api.listIndexFiles({ indexId: "nope" }), ExperimentalIndexError);
  });
});

describe("ListenExperimentalIndex stage stream (shapes binary-verified)", () => {
  it("emits register/choose/summarize items with request+response pairing, then ready", async () => {
    const api = new ExperimentalIndexApi();
    const { indexId } = api.createIndex({
      files: ["src/x.ts"],
      targetDir: "/t",
      repo: "acme/r",
    });
    const items = await collect(api, indexId);
    assert.deepStrictEqual(
      items.map((i) => i.item.case),
      ["register", "choose", "summarize", "ready"],
    );
    for (const item of items) assert.strictEqual(item.indexId, indexId);

    // register item: {request: RegisterFileToIndexRequest, response: RegisterFileToIndexResponse, reqUuid}
    const register = items[0]!.item;
    if (register.case !== "register") throw new Error("unreachable");
    assert.strictEqual(register.value.request?.indexId, indexId);
    assert.strictEqual(register.value.request?.workspaceRelativePath, "src/x.ts");
    assert.strictEqual(register.value.response?.fileData?.workspaceRelativePath, "src/x.ts");
    assert.deepStrictEqual(register.value.response?.dependencyResolutionAttempts, []);
    assert.ok(register.value.reqUuid.length > 0);

    // choose item: {request: ChooseCodeReferencesRequest, response, reqUuid}
    const choose = items[1]!.item;
    if (choose.case !== "choose") throw new Error("unreachable");
    assert.strictEqual(choose.value.request?.indexId, indexId);
    assert.strictEqual(choose.value.request?.recompute, false);
    assert.ok(choose.value.reqUuid.length > 0);

    // summarize item: {request, response: {success{summary}, nodeId}, reqUuid}
    const summarize = items[2]!.item;
    if (summarize.case !== "summarize") throw new Error("unreachable");
    assert.strictEqual(typeof summarize.value.response?.success?.summary, "string");
    assert.ok((summarize.value.response?.success?.summary ?? "").length > 0);
    assert.strictEqual(summarize.value.response?.nodeId, summarize.value.request?.nodeId);

    // ready item: {indexId, request}
    const ready = items[3]!.item;
    if (ready.case !== "ready") throw new Error("unreachable");
    assert.strictEqual(ready.value.indexId, indexId);
    assert.strictEqual(api.getIndex(indexId)!.status, "ready");
  });

  it("a blank file path produces the terminal ErrorItem with binary-verified fields", async () => {
    const api = new ExperimentalIndexApi();
    const { indexId } = api.createIndex({
      files: [""],
      targetDir: "/t",
      repo: "r",
    });
    const items = await collect(api, indexId);
    const last = items[items.length - 1]!;
    assert.strictEqual(last.item.case, "error");
    if (last.item.case !== "error") throw new Error("unreachable");
    assert.ok(last.item.value.message.length > 0);
    assert.strictEqual(typeof last.item.value.statusCode, "number");
    assert.ok(last.item.value.reqUuid.length > 0);
    assert.strictEqual(api.getIndex(indexId)!.status, "error");
  });

  it("listen on an unknown indexId rejects", async () => {
    const api = new ExperimentalIndexApi();
    await assert.rejects(async () => {
      for await (const _ of api.listen({ indexId: "missing" })) {
        void _;
      }
    }, ExperimentalIndexError);
  });

  it("a late listener replays the terminal stage so it learns the outcome", async () => {
    const api = new ExperimentalIndexApi();
    const { indexId } = api.createIndex({
      files: ["a.ts"],
      targetDir: "/t",
      repo: "r",
    });
    await collect(api, indexId);
    await new Promise((r) => setImmediate(r));
    const late = await collect(api, indexId);
    assert.deepStrictEqual(
      late.map((i) => i.item.case),
      ["ready"],
    );
  });
});

describe("UpdateBackgroundComposerExperimentalModelOptOut", () => {
  it("returns {} (binary Response is an EMPTY message) and stores per-BC opt-outs (default false)", () => {
    const api = new ExperimentalIndexApi();
    assert.strictEqual(api.isExperimentalModelOptedOut("bc_1"), false);
    const res = api.updateBackgroundComposerExperimentalModelOptOut({
      bcId: "bc_1",
      useExperimentalModelOptOut: true,
    });
    // Binary-verified (W72A, 3.25.9): the Response descriptor has NO
    // fields (`makeMessageType(..., [])`); `bcId` belongs to the next
    // message (RefreshGithubAccessTokenInBackgroundComposerRequest).
    assert.deepStrictEqual(res, {});
    assert.strictEqual(api.isExperimentalModelOptedOut("bc_1"), true);
    assert.strictEqual(api.isExperimentalModelOptedOut("bc_other"), false);
    api.updateBackgroundComposerExperimentalModelOptOut({
      bcId: "bc_1",
      useExperimentalModelOptOut: false,
    });
    assert.strictEqual(api.isExperimentalModelOptedOut("bc_1"), false);
    assert.throws(
      () =>
        api.updateBackgroundComposerExperimentalModelOptOut({
          bcId: "",
          useExperimentalModelOptOut: true,
        }),
      ExperimentalIndexError,
    );
  });
});
