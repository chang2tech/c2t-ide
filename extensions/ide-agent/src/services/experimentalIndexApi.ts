/**
 * experimentalIndexApi — typed model + in-process implementation of the
 * experimental codebase-index API. REWORKED 2026-10-20 (DEV-GAPS-62, W62C)
 * after W58E flagged fabrication in the previous revision.
 *
 * REWORK METHOD: every message shape below was re-verified directly against
 * the reference Cursor binaries (READ-ONLY reference material) before
 * writing, using the protobuf descriptors embedded in:
 * - `extensions/cursor-always-local/dist/main.js` (3.25.6) — compact
 *   protobuf-es descriptors (`ClassName|1 field_name <type>...`) for all
 *   `Create/List/ListenExperimentalIndex*`, `IndexFileData`,
 *   `RegisterFileToIndex*`, `ChooseCodeReferences*`,
 *   `SummarizeWithReferences*`, and
 *   `UpdateBackgroundComposerExperimentalModelOptOut{Request,Response}`.
 * - `out/vs/workbench/workbench.glass.main.js` (3.25.6) — non-compact
 *   `aiserver.v1.*` descriptors confirming field numbers, field names,
 *   repeated flags, and message types (e.g. `IndexFileData.files`,
 *   `ErrorItem.request` oneof cases register|choose|summarize).
 * Spot-checked 3.25.9 (`reference/cursor-3.25.9/...`): Create/List/Listen
 * descriptors match 3.25.6.
 *
 * Corrections vs the previous revision (QA step 1 — "does Cursor do this?"):
 * - `ListExperimentalIndexFilesResponse.files` is `IndexFileData[]`
 *   (binary: `files #0*` resolving to `IndexFileData`), NOT `string[]`.
 *   `CreateExperimentalIndexRequest.files` stays `string[]` (binary:
 *   `files 9*` — repeated string in ALL bundles). W58E's blanket
 *   "`files` must be IndexFileData[]" was only half right.
 * - The "exactly three RPCs" claim was wrong: the AiService family contains
 *   the three top-level RPCs PLUS pipeline RPCs
 *   (`RegisterFileToIndex`, `SetupIndexDependencies`, `ComputeIndexTopoSort`,
 *   `ChooseCodeReferences`, `RegisterCodeReferences`,
 *   `SummarizeWithReferences`) — see deep-proto.md (binary-derived) and
 *   the stage items below, which wrap the pipeline RPCs' request/response
 *   messages verbatim.
 * - The listen-stage items are NOT minimal invented payloads: each stage
 *   carries the real pipeline request+response message shapes, oneof field
 *   numbers 2–6 (ready|register|choose|summarize|error), `reqUuid` (f3),
 *   and `ErrorItem` fields `message`(f1)/`statusCode`(f2)/`request`(oneof
 *   register|choose|summarize)/`reqUuid`(f6) — all descriptor-verified.
 * - `IndexFileData`: {indexId, workspaceRelativePath, stage, order,
 *   nodes: NodeData[]} (fields 1–5);
 *   `NodeData`: {nodeId, stage, content, summary} (fields 1–4).
 * - JS field case is camelCase throughout (verified: `this.reqUuid`,
 *   `this.statusCode`, `this.indexId`, `this.workspaceRelativePath`).
 * - `UpdateBackgroundComposerExperimentalModelOptOutResponse` exists and
 *   is EMPTY (no fields) — re-verified W72A 2026-10-20 against 3.25.9:
 *   always-local compact descriptor `["UpdateBackgroundComposerExperimentalModelOptOutResponse"]`
 *   (byte ~2,874,281) and glass `makeMessageType(..., [])` (byte ~17,079,442).
 *   The earlier "{bcId} (field 1)" claim was a misread: the `bcId` class
 *   immediately following it is `RefreshGithubAccessTokenInBackgroundComposerRequest`.
 *
 * UNKNOWN (descriptor-verified as existing, but unresolvable values):
 * - `IndexFileData.stage` / `NodeData.stage`: string enum, but no stage
 *   value literals appear in the client bundles — the legal set is UNKNOWN.
 * - `CodeSymbolWithAction.action`: enum, default `UNSPECIFIED` (=0);
 *   member names beyond that were not extracted → UNKNOWN.
 * - `FileCodeSnippets.snippets` element type → UNKNOWN.
 * - The SERVER-side temporal order of listen items (whether the server
 *   really emits register → choose → summarize in that order) is INFERRED
 *   from the request/response flow; only the oneof shapes/order are
 *   binary-observed.
 *
 * LOCAL STAND-IN (explicitly not Cursor parity): the `ExperimentalIndexApi`
 * class below is an in-process stand-in for the connect-transport-dispatched
 * pipeline (which runs server-side). It keeps the verified message shapes
 * and oneof structure, generates placeholder summaries, and is NOT claimed
 * to perform the real server pipeline.
 */

// ---------------------------------------------------------------------------
// Messages (descriptor-verified; JS props camelCase)
// ---------------------------------------------------------------------------

/** `CreateExperimentalIndexRequest`: files (f1, repeated STRING), target_dir (f2), repo (f3) */
export interface CreateExperimentalIndexRequest {
  /** files — repeated string (descriptor `files 9*` in ALL bundles) */
  files: string[];
  targetDir: string;
  repo: string;
}

/** `CreateExperimentalIndexResponse`: index_id (f1) */
export interface CreateExperimentalIndexResponse {
  indexId: string;
}

/**
 * `IndexFileData`: index_id (f1), workspace_relative_path (f2), stage (f3),
 * order (f4, int32), nodes (f5, repeated NodeData).
 * NOTE: `stage` is a server-defined string; the legal value set is UNKNOWN
 * (no literals in client bundles).
 */
export interface IndexFileData {
  indexId: string;
  workspaceRelativePath: string;
  stage: string;
  order: number;
  nodes: IndexFileDataNodeData[];
}

/** `IndexFileData.NodeData`: node_id (f1), stage (f2), content (f3), summary (f4) */
export interface IndexFileDataNodeData {
  nodeId: string;
  /** server-defined; value set UNKNOWN */
  stage: string;
  content: string;
  summary: string;
}

/** `ListExperimentalIndexFilesRequest`: index_id (f1) */
export interface ListExperimentalIndexFilesRequest {
  indexId: string;
}

/**
 * `ListExperimentalIndexFilesResponse`: index_id (f1) + files (f2, repeated
 * INDEXFILEDATA — descriptor `files #0*` → `IndexFileData`).
 */
export interface ListExperimentalIndexFilesResponse {
  indexId: string;
  files: IndexFileData[];
}

/** `ListenExperimentalIndexRequest`: index_id (f1) */
export interface ListenExperimentalIndexRequest {
  indexId: string;
}

// ---------------------------------------------------------------------------
// Index-pipeline RPC messages (wrapped by the listen-stage items;
// descriptor-verified)
// ---------------------------------------------------------------------------

/**
 * `SerializedContextNode`: workspace_relative_path (f1), start_line_number
 * (f2, int32), end_line_number (f3, int32), children (f4, repeated
 * SerializedContextNode), node_snippets (f5, repeated FileCodeSnippets).
 */
export interface SerializedContextNode {
  workspaceRelativePath: string;
  startLineNumber: number;
  endLineNumber: number;
  children: SerializedContextNode[];
  nodeSnippets: FileCodeSnippets[];
}

/** `FileCodeSnippets`: relative_workspace_path (f1), total_lines (f2, int32), snippets (f3, repeated; element type UNKNOWN) */
export interface FileCodeSnippets {
  relativeWorkspacePath: string;
  totalLines: number;
  /** element type unresolved in the extracted descriptors — UNKNOWN */
  snippets: unknown[];
}

/**
 * `CodeSymbolWithAction`: workspace_relative_path (f1),
 * line_number (f2, int32), symbol_start_column (f3, int32),
 * symbol_end_column (f4, int32), action (f5, enum; default UNSPECIFIED=0,
 * other member names UNKNOWN), symbol (f6).
 */
export interface CodeSymbolWithAction {
  workspaceRelativePath: string;
  lineNumber: number;
  symbolStartColumn: number;
  symbolEndColumn: number;
  /** enum — default UNSPECIFIED=0; remaining member names UNKNOWN */
  action: number;
  symbol: string;
}

/** `URIResolutionAttempt`: workspace_relative_path (f1), node_id (f2), symbol (f3, CodeSymbolWithAction) */
export interface URIResolutionAttempt {
  workspaceRelativePath: string;
  nodeId: string;
  symbol: CodeSymbolWithAction;
}

/**
 * `RegisterFileToIndexRequest`: index_id (f1), workspace_relative_path
 * (f2), root_context_node (f3, SerializedContextNode), content (f4,
 * repeated string).
 */
export interface RegisterFileToIndexRequest {
  indexId: string;
  workspaceRelativePath: string;
  rootContextNode?: SerializedContextNode;
  content: string[];
}

/**
 * `RegisterFileToIndexResponse`: file_id (f1), root_context_node_id (f2),
 * dependency_resolution_attempts (f3, repeated URIResolutionAttempt),
 * file_data (f4, IndexFileData).
 */
export interface RegisterFileToIndexResponse {
  fileId: string;
  rootContextNodeId: string;
  dependencyResolutionAttempts: URIResolutionAttempt[];
  fileData?: IndexFileData;
}

/**
 * `ChooseCodeReferencesRequest`: index_id (f1),
 * file (f2, FileRequest{file_id}), node (f3, NodeRequest{node_id}),
 * recompute (f4, bool).
 */
export interface ChooseCodeReferencesRequest {
  indexId: string;
  file?: { fileId: string };
  node?: { nodeId: string };
  recompute: boolean;
}

/**
 * `ChooseCodeReferencesResponse`: file (f1, FileResponse{file_id,
 * node_responses}), node (f2, NodeResponse{node_id, actions, skipped,
 * dependencies}).
 */
export interface ChooseCodeReferencesResponse {
  file?: { fileId: string; nodeResponses: ChooseCodeReferencesNodeResponse[] };
  node?: ChooseCodeReferencesNodeResponse;
}

export interface ChooseCodeReferencesNodeResponse {
  nodeId: string;
  /** repeated CodeSymbolWithAction */
  actions: CodeSymbolWithAction[];
  skipped: boolean;
  /** repeated string */
  dependencies: string[];
}

/**
 * `SummarizeWithReferencesRequest`: index_id (f1), node_id (f2),
 * recompute (f3, bool).
 */
export interface SummarizeWithReferencesRequest {
  indexId: string;
  nodeId: string;
  recompute: boolean;
}

/**
 * `SummarizeWithReferencesResponse`: success (f1, Success{summary}),
 * dependency (f2, Dependency{nodes}), node_id (f3).
 */
export interface SummarizeWithReferencesResponse {
  success?: { summary: string };
  dependency?: { nodes: string[] };
  nodeId: string;
}

// ---------------------------------------------------------------------------
// Listen stage items (oneof `item` on ListenExperimentalIndexResponse:
// ready=2 | register=3 | choose=4 | summarize=5 | error=6)
// ---------------------------------------------------------------------------

/** `ListenExperimentalIndexResponse.ReadyItem`: index_id (f1), request (f2) */
export interface ExperimentalIndexReadyItem {
  indexId: string;
  request?: ListenExperimentalIndexRequest;
}

/** `ListenExperimentalIndexResponse.RegisterItem`: response (f1), request (f2), req_uuid (f3) */
export interface ExperimentalIndexRegisterItem {
  response?: RegisterFileToIndexResponse;
  request?: RegisterFileToIndexRequest;
  reqUuid: string;
}

/** `ListenExperimentalIndexResponse.ChooseItem`: response (f1), request (f2), req_uuid (f3) */
export interface ExperimentalIndexChooseItem {
  response?: ChooseCodeReferencesResponse;
  request?: ChooseCodeReferencesRequest;
  reqUuid: string;
}

/** `ListenExperimentalIndexResponse.SummarizeItem`: response (f1), request (f2), req_uuid (f3) */
export interface ExperimentalIndexSummarizeItem {
  response?: SummarizeWithReferencesResponse;
  request?: SummarizeWithReferencesRequest;
  reqUuid: string;
}

/**
 * `ListenExperimentalIndexResponse.ErrorItem`: message (f1),
 * status_code (f2, int32), request (oneof register|choose|summarize),
 * req_uuid (f6).
 */
export interface ExperimentalIndexErrorItem {
  message: string;
  statusCode: number;
  request:
    | { case: "register"; value: RegisterFileToIndexRequest }
    | { case: "choose"; value: ChooseCodeReferencesRequest }
    | { case: "summarize"; value: SummarizeWithReferencesRequest }
    | { case: undefined };
  reqUuid: string;
}

export type ExperimentalIndexStageItem =
  | { case: "ready"; value: ExperimentalIndexReadyItem }
  | { case: "register"; value: ExperimentalIndexRegisterItem }
  | { case: "choose"; value: ExperimentalIndexChooseItem }
  | { case: "summarize"; value: ExperimentalIndexSummarizeItem }
  | { case: "error"; value: ExperimentalIndexErrorItem };

/** `ListenExperimentalIndexResponse`: index_id (f1) + oneof `item` (f2–f6) */
export interface ListenExperimentalIndexResponse {
  indexId: string;
  item: ExperimentalIndexStageItem;
}

/** `UpdateBackgroundComposerExperimentalModelOptOutRequest`: bc_id (f1), use_experimental_model_opt_out (f2, bool) */
export interface UpdateBackgroundComposerExperimentalModelOptOutRequest {
  bcId: string;
  useExperimentalModelOptOut: boolean;
}

/**
 * `UpdateBackgroundComposerExperimentalModelOptOutResponse`: EMPTY message
 * (no fields) — descriptor-verified in 3.25.9 (see header note). Do NOT add
 * `bcId` here; that field belongs to the following message,
 * `RefreshGithubAccessTokenInBackgroundComposerRequest`.
 */
export interface UpdateBackgroundComposerExperimentalModelOptOutResponse {
  // intentionally empty — matches the binary descriptor
}

// ---------------------------------------------------------------------------
// Field numbers (descriptor-verified)
// ---------------------------------------------------------------------------

export const EXPERIMENTAL_INDEX_MESSAGE_FIELDS = {
  CreateExperimentalIndexRequest: { files: 1, targetDir: 2, repo: 3 },
  CreateExperimentalIndexResponse: { indexId: 1 },
  IndexFileData: { indexId: 1, workspaceRelativePath: 2, stage: 3, order: 4, nodes: 5 },
  IndexFileDataNodeData: { nodeId: 1, stage: 2, content: 3, summary: 4 },
  ListExperimentalIndexFilesRequest: { indexId: 1 },
  ListExperimentalIndexFilesResponse: { indexId: 1, files: 2 },
  ListenExperimentalIndexRequest: { indexId: 1 },
  /** oneof `item`: ready=2 | register=3 | choose=4 | summarize=5 | error=6 */
  ListenExperimentalIndexResponse: {
    indexId: 1,
    ready: 2,
    register: 3,
    choose: 4,
    summarize: 5,
    error: 6,
  },
  ListenExperimentalIndexResponseReadyItem: { indexId: 1, request: 2 },
  ListenExperimentalIndexResponseRegisterItem: { response: 1, request: 2, reqUuid: 3 },
  ListenExperimentalIndexResponseChooseItem: { response: 1, request: 2, reqUuid: 3 },
  ListenExperimentalIndexResponseSummarizeItem: { response: 1, request: 2, reqUuid: 3 },
  ListenExperimentalIndexResponseErrorItem: {
    message: 1,
    statusCode: 2,
    register: 3,
    choose: 4,
    summarize: 5,
    reqUuid: 6,
  },
  RegisterFileToIndexRequest: { indexId: 1, workspaceRelativePath: 2, rootContextNode: 3, content: 4 },
  RegisterFileToIndexResponse: {
    fileId: 1,
    rootContextNodeId: 2,
    dependencyResolutionAttempts: 3,
    fileData: 4,
  },
  ChooseCodeReferencesRequest: { indexId: 1, file: 2, node: 3, recompute: 4 },
  ChooseCodeReferencesResponse: { file: 1, node: 2 },
  ChooseCodeReferencesNodeResponse: { nodeId: 1, actions: 2, skipped: 3, dependencies: 4 },
  SummarizeWithReferencesRequest: { indexId: 1, nodeId: 2, recompute: 3 },
  SummarizeWithReferencesResponse: { success: 1, dependency: 2, nodeId: 3 },
  UpdateBackgroundComposerExperimentalModelOptOutRequest: { bcId: 1, useExperimentalModelOptOut: 2 },
  UpdateBackgroundComposerExperimentalModelOptOutResponse: {},
} as const;

// ---------------------------------------------------------------------------
// RPC names (OBSERVED in AiService, deep-proto.md — binary-derived)
// ---------------------------------------------------------------------------

/** The three top-level experimental-index RPCs. */
export const EXPERIMENTAL_INDEX_RPCS = [
  "CreateExperimentalIndex",
  "ListExperimentalIndexFiles",
  "ListenExperimentalIndex",
] as const;

/**
 * The experimental-index PIPELINE RPCs on the same AiService family.
 * These are the RPCs whose request/response messages are wrapped by the
 * listen-stage items (RegisterItem ↔ RegisterFileToIndex, etc.).
 */
export const EXPERIMENTAL_INDEX_PIPELINE_RPCS = [
  "RegisterFileToIndex",
  "SetupIndexDependencies",
  "ComputeIndexTopoSort",
  "ChooseCodeReferences",
  "RegisterCodeReferences",
  "SummarizeWithReferences",
] as const;

/** Background-composer opt-out RPC name (observed descriptor). */
export const EXPERIMENTAL_MODEL_OPT_OUT_RPC = "UpdateBackgroundComposerExperimentalModelOptOut";

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class ExperimentalIndexError extends Error {
  constructor(message: string) {
    super(`ExperimentalIndexError: ${message}`);
    this.name = "ExperimentalIndexError";
  }
}

// ---------------------------------------------------------------------------
// In-process API — LOCAL STAND-IN for the connect-transport-dispatched
// pipeline (which runs server-side in Cursor). Keeps the VERIFIED message
// shapes and oneof structure; emits register → choose → summarize → ready
// stage items built from the real pipeline message types. The temporal
// order of the items is INFERRED (server-side behavior is not observable
// client-side); placeholder summaries are honest stand-in content.
// ---------------------------------------------------------------------------

export type ExperimentalIndexRecordStatus = "building" | "ready" | "error";

export interface ExperimentalIndexRecord {
  indexId: string;
  files: string[];
  targetDir: string;
  repo: string;
  status: ExperimentalIndexRecordStatus;
  error?: { message: string; statusCode: number };
}

function newIndexId(): string {
  return `exidx_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

function newReqUuid(): string {
  return `req_${Math.random().toString(36).slice(2, 10)}`;
}

export class ExperimentalIndexApi {
  private indexes = new Map<string, ExperimentalIndexRecord>();
  /** index_id → queued stage responses not yet consumed by listeners */
  private queues = new Map<string, ListenExperimentalIndexResponse[]>();
  /** index_id → listeners waiting for the next stage response */
  private waiters = new Map<string, Array<(r: ListenExperimentalIndexResponse) => void>>();
  /** index_id → terminal (ready|error) stage response, replayed once per listener */
  private terminalResponses = new Map<string, ListenExperimentalIndexResponse>();
  private consumedTerminal = new Set<string>();
  /** bc_id → use_experimental_model_opt_out */
  private modelOptOuts = new Map<string, boolean>();

  /**
   * CreateExperimentalIndex: {files (string[]), targetDir, repo} → {indexId}.
   */
  createIndex(request: CreateExperimentalIndexRequest): CreateExperimentalIndexResponse {
    if (!request.repo) throw new ExperimentalIndexError("repo is required");
    if (!request.targetDir) throw new ExperimentalIndexError("targetDir is required");
    const indexId = newIndexId();
    this.indexes.set(indexId, {
      indexId,
      files: [...request.files],
      targetDir: request.targetDir,
      repo: request.repo,
      status: "building",
    });
    void this.runPipeline(indexId);
    return { indexId };
  }

  /**
   * ListExperimentalIndexFiles: {indexId} → {indexId, files: IndexFileData[]}.
   * The per-file records are stand-in entries; `stage` uses the binary class
   * default ("") because the server-defined stage value set is UNKNOWN.
   */
  listIndexFiles(request: ListExperimentalIndexFilesRequest): ListExperimentalIndexFilesResponse {
    const record = this.requireRecord(request.indexId);
    return {
      indexId: record.indexId,
      files: record.files.map((workspaceRelativePath, order) => ({
        indexId: record.indexId,
        workspaceRelativePath,
        stage: "",
        order,
        nodes: [],
      })),
    };
  }

  /**
   * ListenExperimentalIndex: {indexId} → async stream of
   * {indexId, item: oneof ready|register|choose|summarize|error}.
   * A listener that subscribes after completion replays the terminal stage
   * once (so it still learns the outcome), then the stream ends.
   */
  async *listen(request: ListenExperimentalIndexRequest): AsyncGenerator<ListenExperimentalIndexResponse> {
    const record = this.requireRecord(request.indexId);
    for (;;) {
      const next = await this.dequeueOrWait(record.indexId);
      if (!next) break;
      yield next;
      if (next.item.case === "ready" || next.item.case === "error") break;
    }
  }

  /**
   * UpdateBackgroundComposerExperimentalModelOptOut:
   * {bcId, useExperimentalModelOptOut} → {} (the binary Response message
   * has no fields — descriptor-verified, see header note).
   */
  updateBackgroundComposerExperimentalModelOptOut(
    request: UpdateBackgroundComposerExperimentalModelOptOutRequest,
  ): UpdateBackgroundComposerExperimentalModelOptOutResponse {
    if (!request.bcId) throw new ExperimentalIndexError("bcId is required");
    this.modelOptOuts.set(request.bcId, request.useExperimentalModelOptOut);
    return {};
  }

  /** Current opt-out state for a Background Composer (default false). LOCAL stand-in state. */
  isExperimentalModelOptedOut(bcId: string): boolean {
    return this.modelOptOuts.get(bcId) ?? false;
  }

  /** LOCAL stand-in introspection. */
  getIndex(indexId: string): ExperimentalIndexRecord | undefined {
    const record = this.indexes.get(indexId);
    return record ? { ...record, files: [...record.files] } : undefined;
  }

  // -- internals -----------------------------------------------------------

  private requireRecord(indexId: string): ExperimentalIndexRecord {
    const record = this.indexes.get(indexId);
    if (!record) throw new ExperimentalIndexError(`unknown indexId: ${indexId}`);
    return record;
  }

  private emit(indexId: string, item: ExperimentalIndexStageItem): void {
    const response: ListenExperimentalIndexResponse = { indexId, item };
    if (item.case === "ready" || item.case === "error") {
      this.terminalResponses.set(indexId, response);
    }
    const waiterList = this.waiters.get(indexId);
    if (waiterList && waiterList.length > 0) {
      const resolve = waiterList.shift()!;
      resolve(response);
      return;
    }
    let queue = this.queues.get(indexId);
    if (!queue) {
      queue = [];
      this.queues.set(indexId, queue);
    }
    queue.push(response);
  }

  private dequeueOrWait(indexId: string): Promise<ListenExperimentalIndexResponse | undefined> {
    const queue = this.queues.get(indexId);
    if (queue && queue.length > 0) return Promise.resolve(queue.shift());
    const record = this.indexes.get(indexId);
    const terminal = this.terminalResponses.get(indexId);
    // Pipeline finished and queue drained: replay the terminal stage once so a
    // late listener still learns the outcome, then the stream ends.
    if (record && (record.status === "ready" || record.status === "error")) {
      if (terminal && !this.consumedTerminal.has(indexId)) {
        this.consumedTerminal.add(indexId);
        return Promise.resolve(terminal);
      }
      return Promise.resolve(undefined);
    }
    return new Promise((resolve) => {
      let waiterList = this.waiters.get(indexId);
      if (!waiterList) {
        waiterList = [];
        this.waiters.set(indexId, waiterList);
      }
      waiterList.push(resolve);
    });
  }

  /**
   * The experimental index pipeline — INFERRED emission order
   * (register → choose → summarize → ready, error terminal). The item
   * SHAPES are descriptor-verified; per-stage request/response contents are
   * stand-in values. A blank workspace-relative path is a LOCAL stand-in
   * failure trigger that produces an ErrorItem (the real server decides).
   */
  private async runPipeline(indexId: string): Promise<void> {
    const record = this.requireRecord(indexId);
    try {
      // register: files were registered to the index.
      for (const workspaceRelativePath of record.files) {
        if (workspaceRelativePath.length === 0) {
          throw new ExperimentalIndexError("blank workspace-relative path");
        }
        this.emit(indexId, {
          case: "register",
          value: {
            request: {
              indexId,
              workspaceRelativePath,
              rootContextNode: undefined,
              content: [],
            },
            response: {
              fileId: `file_${workspaceRelativePath}`,
              rootContextNodeId: "",
              dependencyResolutionAttempts: [],
              fileData: {
                indexId,
                workspaceRelativePath,
                stage: "",
                order: record.files.indexOf(workspaceRelativePath),
                nodes: [],
              },
            },
            reqUuid: newReqUuid(),
          },
        });
        await Promise.resolve();
      }
      // choose: code references chosen for summarization.
      for (const workspaceRelativePath of record.files) {
        this.emit(indexId, {
          case: "choose",
          value: {
            request: {
              indexId,
              file: { fileId: `file_${workspaceRelativePath}` },
              node: undefined,
              recompute: false,
            },
            response: {
              file: { fileId: `file_${workspaceRelativePath}`, nodeResponses: [] },
              node: undefined,
            },
            reqUuid: newReqUuid(),
          },
        });
        await Promise.resolve();
      }
      // summarize: reference summaries produced. The summary text is
      // stand-in placeholder content — the real pipeline produces it
      // server-side; the response SHAPE (success{summary}, nodeId) is
      // descriptor-verified.
      for (const workspaceRelativePath of record.files) {
        const nodeId = `node_${workspaceRelativePath}`;
        this.emit(indexId, {
          case: "summarize",
          value: {
            request: { indexId, nodeId, recompute: false },
            response: {
              success: {
                summary: `(experimental index stand-in) summary for ${workspaceRelativePath}`,
              },
              dependency: { nodes: [] },
              nodeId,
            },
            reqUuid: newReqUuid(),
          },
        });
        await Promise.resolve();
      }
      record.status = "ready";
      this.emit(indexId, {
        case: "ready",
        value: { indexId, request: { indexId } },
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      record.status = "error";
      record.error = { message, statusCode: 13 }; // status_code is int32; 13 mirrors INTERNAL
      this.emit(indexId, {
        case: "error",
        value: {
          message,
          statusCode: 13,
          request: { case: undefined },
          reqUuid: newReqUuid(),
        },
      });
    }
  }
}
