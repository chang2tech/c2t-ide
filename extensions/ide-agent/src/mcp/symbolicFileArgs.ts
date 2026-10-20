/**
 * symbolicFileArgs — Cursor `$file:/abs/path` symbolic MCP argument parity
 * (feature-matrix: mcp-symbolic-file-args).
 *
 * A model may emit `$file:/absolute/path` string literals inside MCP tool-call
 * arguments. The client late-binds them: the file's contents are substituted
 * for the literal at the executor boundary, just before the tool runs.
 *
 * BINARY EVIDENCE (self-verified 2026-10-20, W50D — RULE QA 2 BƯỚC step 1):
 *   - Cursor 3.25.6: extensions/cursor-agent-exec/dist/main.js — literal
 *     `$file:` ×1 (export `Eyz:()=>"$file:"`), `16777216` ×3,
 *     `mcp.symbolic_args.{bytes,describe,expansion,paths}`,
 *     `too_many` ×2, `over_budget` ×1, `no_read_executor` ×1.
 *   - Cursor 3.25.9: same file — identical markers (also ×1 `$file:`,
 *     `16777216` present, all four metric names, `too_many` ×2,
 *     `over_budget` ×1, `no_read_executor` ×1).
 *   - Full algorithm recovered from 3.25.9 @~1629379..1635000 and mirrored
 *     against 3.25.6 (same structure):
 *       detection  tr(e): startsWith("$file:") → e.slice(6) → isAbsolute
 *       collect    rr(e): recursive Set walk over nested arrays/objects
 *       expand     lr(...): max 4/call ("too_many"), per-file maxFileBytes
 *                  ("too_large"), total 16777216 ("over_budget"),
 *                  "no_read_executor"/"read_error"/"not_text"/"not_found"/
 *                  "permission_denied"/"rejected"/"outdated_executor"
 *                  outcomes; success clones args and substitutes.
 *       review     dr(...): route "review", digestOnly describe → outcome
 *                  "described" + McpSymbolicPathArgument{path,sha256,size_bytes}
 *                  descriptors flowing as `symbolicPathArgumentsForClassifier`/
 *                  `symbolicPathArgumentBindings` into the Smart Mode approval
 *                  review; failure → outcome = failure kind.
 *       execute   pr(...): route "local", re-read + sha256 TOCTOU check
 *                  ("content_changed" refusal), substitute, clear
 *                  symbolicPathArguments, metrics outcome "expanded".
 *       errors    ar(kind,path,reason) template (verbatim below);
 *                  cr extends Error carries `.failure`.
 *   - Hook interplay + scoping (audit-fix-queue 2026-10-19, from binary):
 *       hooks: "$file:" arguments can't be used on this computer: hooks that
 *              inspect MCP calls are configured here, and they would not see
 *              the file's contents. Read the file and pass its contents instead.
 *       scope: "$file:" arguments are only supported for external MCP tools,
 *              and ${e} is a first-party tool … Pass the file path if the tool
 *              accepts one, or read the file and pass its contents.
 *   - Proto (audit): agent.v1.McpSymbolicPathArgument{1:path,2:sha256,3:size_bytes},
 *     McpArgs.symbolic_path_arguments field 10 (repeated).
 *
 * HONEST-DIVERGENCE (documented, not hidden):
 *   1. Cursor reads through a VM read-executor with digestOnly describe
 *      (`vm_digest` = hashed where the file lives). We have no VM; our read
 *      executor reads via node:fs and hashes locally with sha256 — every
 *      describe is therefore `vm_digest`-equivalent, and the
 *      `outdated_executor` outcome cannot occur here (kind kept for parity).
 *   2. Cursor's read executor can `reject` reads ("Only files the Read tool
 *      can read without approval can be substituted"). Our architecture has
 *      no per-read approval layer — the tool call itself passed the approval
 *      gate — so the `rejected` kind is never emitted here.
 *   3. Cursor flows bindings into Smart Mode approval + classifier
 *      fingerprint. We have no Smart Mode classifier; the review boundary
 *      surfaces the described files (path, bytes, sha256) as approval-card
 *      reason lines, which is our review surface.
 *   4. Metrics: Cursor increments prometheus `mcp.symbolic_args.*` in the
 *      agent host. The extension host has no metrics pipeline, so this
 *      module records to a pluggable `SymbolicArgsMetrics` sink (default: a
 *      shared in-memory recorder). Names + label names are verbatim.
 *   5. Per-file `maxFileBytes` default is minified in the binary (`er`) —
 *      its value is UNKNOWN. We default to 4 MiB and say so.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";

/** Verbatim prefix literal (`Zt="$file:"` in the binary). */
export const SYMBOLIC_FILE_ARG_PREFIX = "$file:";

/** Max distinct symbolic args per call — verbatim binary limit (`too_many`). */
export const MAX_SYMBOLIC_FILE_ARGS_PER_CALL = 4;

/**
 * Total substituted-bytes cap per call — verbatim binary constant
 * (`over_budget`, 16 MiB).
 */
export const MAX_SYMBOLIC_FILE_ARGS_TOTAL_BYTES = 16777216;

/**
 * Default per-file substitution cap. The binary's default is minified
 * (`er`) and its value is UNKNOWN — this is an implementation choice,
 * documented here rather than invented as Cursor's.
 */
export const DEFAULT_MAX_SYMBOLIC_FILE_ARG_BYTES = 4 * 1024 * 1024;

/** Expansion routes — verbatim from the binary (`route:"review"|"local"`). */
export type SymbolicArgsRoute = "review" | "local";

/**
 * Mirrors the binary's proto `agent.v1.McpSymbolicPathArgument`
 * ({1:path string, 2:sha256 string, 3:size_bytes int64}) and the review
 * boundary's `symbolicPathArgumentsForClassifier` /
 * `symbolicPathArgumentBindings`.
 */
export interface SymbolicFileArgBinding {
  path: string;
  sha256: string;
  sizeBytes: number;
}

/**
 * Failure/outcome kinds — verbatim binary kinds, plus two local refusals
 * (`hooks_configured`, `first_party_tool`) from the binary's hook-interplay
 * and scoping strings.
 */
export type SymbolicArgFailureKind =
  | "too_many"
  | "too_large"
  | "no_read_executor"
  | "not_text"
  | "not_found"
  | "permission_denied"
  | "rejected"
  | "read_error"
  | "over_budget"
  | "outdated_executor"
  | "content_changed"
  | "hooks_configured"
  | "first_party_tool";

/** Structured failure carried on `SymbolicArgError.failure` (binary `cr`). */
export interface SymbolicArgFailure {
  kind: SymbolicArgFailureKind;
  message: string;
}

/**
 * Build a structured failure — mirrors the binary's `ar(kind, path, reason)`.
 * The message template is VERBATIM from the binary:
 * `Could not resolve the symbolic argument "${Zt}${t}": ${r} A string
 *  argument of the form "${Zt}/absolute/path" is replaced with that file's
 *  contents before the tool runs; pass the literal text instead if you did
 *  not intend that.`
 */
export function symbolicArgFailure(
  kind: SymbolicArgFailureKind,
  symbolicPath: string,
  reason: string,
): SymbolicArgFailure {
  return {
    kind,
    message:
      `Could not resolve the symbolic argument "${SYMBOLIC_FILE_ARG_PREFIX}${symbolicPath}": ${reason} ` +
      `A string argument of the form "${SYMBOLIC_FILE_ARG_PREFIX}/absolute/path" is replaced with that file's ` +
      `contents before the tool runs; pass the literal text instead if you did not intend that.`,
  };
}

/**
 * Error carrying a structured `failure` — mirrors the binary's
 * `cr extends Error` (`this.failure = e`).
 */
export class SymbolicArgError extends Error {
  readonly failure: SymbolicArgFailure;
  constructor(failure: SymbolicArgFailure) {
    super(failure.message);
    this.name = "SymbolicArgError";
    this.failure = failure;
  }
}

/**
 * Map any thrown value to a structured failure — mirrors the binary's
 * `ur(e,t)`: a SymbolicArgError keeps its failure, anything else becomes
 * `read_error` with the raw message.
 */
export function toSymbolicArgFailure(thrown: unknown, symbolicPath: string): SymbolicArgFailure {
  if (thrown instanceof SymbolicArgError) {
    return thrown.failure;
  }
  const reason = thrown instanceof Error ? thrown.message : String(thrown);
  return symbolicArgFailure("read_error", symbolicPath, reason);
}

// ---- detection + collection (binary tr / rr) -------------------------------

/**
 * Detection — mirrors the binary's `tr(e)`:
 * `typeof e === "string" && e.startsWith("$file:")` → `t = e.slice(6)` →
 * absolute-path check → path, else undefined.
 */
export function detectSymbolicFileArg(value: unknown): string | undefined {
  if (typeof value !== "string" || !value.startsWith(SYMBOLIC_FILE_ARG_PREFIX)) {
    return undefined;
  }
  const candidate = value.slice(SYMBOLIC_FILE_ARG_PREFIX.length);
  return path.isAbsolute(candidate) ? candidate : undefined;
}

/**
 * Collection — mirrors the binary's `rr(e)`: recursively walks nested
 * arrays/objects, collecting distinct symbolic paths into a Set.
 */
export function collectSymbolicFileArgs(args: unknown): string[] {
  const found = new Set<string>();
  const walk = (node: unknown): void => {
    const detected = detectSymbolicFileArg(node);
    if (detected !== undefined) {
      found.add(detected);
      return;
    }
    if (Array.isArray(node)) {
      for (const item of node) {
        walk(item);
      }
    } else if (node !== null && typeof node === "object") {
      for (const value of Object.values(node)) {
        walk(value);
      }
    }
  };
  walk(args);
  return [...found];
}

/**
 * Substitution — mirrors the recursive replacer inside the binary's `pr`:
 * every `$file:` string whose path is in `contents` is replaced by the file
 * text; anything else (including unknown `$file:` strings) is left as-is.
 * Returns a deep clone; the input is never mutated.
 */
export function substituteSymbolicFileArgs(
  args: Record<string, unknown>,
  contents: ReadonlyMap<string, string>,
): Record<string, unknown> {
  const replace = (node: unknown): unknown => {
    const detected = detectSymbolicFileArg(node);
    if (detected !== undefined) {
      return contents.has(detected) ? contents.get(detected) : node;
    }
    if (Array.isArray(node)) {
      return node.map(replace);
    }
    if (node !== null && typeof node === "object") {
      const out: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(node)) {
        out[key] = replace(value);
      }
      return out;
    }
    return node;
  };
  return replace(args) as Record<string, unknown>;
}

// ---- read executor -----------------------------------------------------------

/** One file read through the read-executor abstraction. */
export interface SymbolicFileRead {
  /** Decoded UTF-8 text (undefined when the file is not text). */
  text: string | undefined;
  /** Raw byte length. */
  bytes: number;
  /** sha256 hex of the raw bytes (the binary's `vm_digest`). */
  sha256: string;
}

/**
 * Read-executor abstraction. Cursor's executor is a VM RPC
 * (`readArgs`/`readResult`) with digestOnly describe mode; ours reads via
 * node:fs and hashes locally (see HONEST-DIVERGENCE 1 in the header).
 */
export interface SymbolicFileReader {
  readFile(absPath: string): Promise<SymbolicFileRead>;
}

/** Map node:fs errors onto the binary's read outcomes. */
function fsErrorToFailureKind(err: NodeJS.ErrnoException): "not_found" | "permission_denied" | "read_error" {
  if (err.code === "ENOENT" || err.code === "ENOTDIR") {
    return "not_found";
  }
  if (err.code === "EACCES" || err.code === "EPERM") {
    return "permission_denied";
  }
  return "read_error";
}

/**
 * Default read executor: node:fs + local sha256.
 * Binary outcome mapping: ENOENT → "not_found" ("the file does not exist.");
 * EACCES/EPERM → "permission_denied" ("reading it was not permitted.");
 * undecodable bytes → "not_text" ("the file cannot be read as text.");
 * anything else → "read_error".
 */
export function nodeFsSymbolicFileReader(): SymbolicFileReader {
  const decoder = new TextDecoder("utf-8", { fatal: true });
  return {
    async readFile(absPath: string): Promise<SymbolicFileRead> {
      let bytes: Buffer;
      try {
        bytes = await fs.promises.readFile(absPath);
      } catch (err) {
        const kind = fsErrorToFailureKind(err as NodeJS.ErrnoException);
        const reason =
          kind === "not_found"
            ? "the file does not exist."
            : kind === "permission_denied"
              ? "reading it was not permitted."
              : (err as Error).message;
        throw new SymbolicArgError(symbolicArgFailure(kind, absPath, reason));
      }
      const sha256 = createHash("sha256").update(bytes).digest("hex");
      let text: string | undefined;
      try {
        text = decoder.decode(bytes);
      } catch {
        text = undefined;
      }
      return { text, bytes: bytes.length, sha256 };
    },
  };
}

// ---- metrics (binary mcp.symbolic_args.*) --------------------------------------

/**
 * Pluggable metrics sink. Names, descriptions and label names are VERBATIM
 * from the binary:
 * - `mcp.symbolic_args.expansion` — "Outcome of late-binding $file:/abs/path
 *   MCP argument expansion at the executor boundary", labels: route, outcome
 * - `mcp.symbolic_args.bytes` — "Total bytes substituted into one MCP tool
 *   call by $file:/abs/path arguments", labels: route
 * - `mcp.symbolic_args.describe` — "Per-file $file:/abs/path describe reads:
 *   `vm_digest` when the read executor hashed the file where it lives,
 *   `outdated_executor` when it returned the text instead (it predates $file:
 *   expansion, so the call is refused)", labels: source
 * - `mcp.symbolic_args.paths` — "Number of distinct $file:/abs/path arguments
 *   expanded in one MCP tool call", labels: route
 *
 * HONEST-DIVERGENCE 4: no prometheus pipeline exists in the extension host,
 * so the default sink is an in-memory recorder (see
 * `sharedSymbolicArgsMetrics`); inject your own to forward elsewhere.
 */
export interface SymbolicArgsMetrics {
  expansion(route: SymbolicArgsRoute, outcome: string): void;
  bytes(route: SymbolicArgsRoute, totalBytes: number): void;
  describe(source: "vm_digest" | "outdated_executor"): void;
  paths(route: SymbolicArgsRoute, count: number): void;
}

/** In-memory metrics recorder (default sink; inspectable in tests). */
export class InMemorySymbolicArgsMetrics implements SymbolicArgsMetrics {
  private readonly counters = new Map<string, number>();
  private key(metric: string, labels: Record<string, string | number>): string {
    return `${metric}{${Object.entries(labels)
      .map(([k, v]) => `${k}="${v}"`)
      .join(",")}}`;
  }
  private add(metric: string, labels: Record<string, string | number>, delta: number): void {
    const k = this.key(metric, labels);
    this.counters.set(k, (this.counters.get(k) ?? 0) + delta);
  }
  expansion(route: SymbolicArgsRoute, outcome: string): void {
    this.add("mcp.symbolic_args.expansion", { route, outcome }, 1);
  }
  bytes(route: SymbolicArgsRoute, totalBytes: number): void {
    this.add("mcp.symbolic_args.bytes", { route }, totalBytes);
  }
  describe(source: "vm_digest" | "outdated_executor"): void {
    this.add("mcp.symbolic_args.describe", { source }, 1);
  }
  paths(route: SymbolicArgsRoute, count: number): void {
    this.add("mcp.symbolic_args.paths", { route }, count);
  }
  /** Test/observability accessor. */
  getCounters(): ReadonlyMap<string, number> {
    return this.counters;
  }
}

/** Shared default sink used when callers don't inject their own. */
export const sharedSymbolicArgsMetrics = new InMemorySymbolicArgsMetrics();

/** No-op sink for callers that don't want recording. */
export const noopSymbolicArgsMetrics: SymbolicArgsMetrics = {
  expansion: () => undefined,
  bytes: () => undefined,
  describe: () => undefined,
  paths: () => undefined,
};

// ---- refusal helpers (hook interplay + scoping) --------------------------------

/**
 * Hook-interplay refusal — verbatim binary string:
 * `"$file:" arguments can't be used on this computer: hooks that inspect MCP
 *  calls are configured here, and they would not see the file's contents.
 *  Read the file and pass its contents instead.`
 */
export function refuseSymbolicArgsForHooks(symbolicPath: string): SymbolicArgFailure {
  return symbolicArgFailure(
    "hooks_configured",
    symbolicPath,
    `"$file:" arguments can't be used on this computer: hooks that inspect MCP calls are configured here, ` +
      `and they would not see the file's contents. Read the file and pass its contents instead.`,
  );
}

/**
 * Scoping refusal — verbatim binary string (with the `${e}` tool label slot):
 * `"$file:" arguments are only supported for external MCP tools, and ${e} is
 *  a first-party tool … Pass the file path if the tool accepts one, or read
 *  the file and pass its contents.`
 */
export function refuseSymbolicArgsForFirstPartyTool(
  symbolicPath: string,
  toolLabel: string,
): SymbolicArgFailure {
  return symbolicArgFailure(
    "first_party_tool",
    symbolicPath,
    `"$file:" arguments are only supported for external MCP tools, and ${toolLabel} is a first-party tool … ` +
      `Pass the file path if the tool accepts one, or read the file and pass its contents.`,
  );
}

// ---- review boundary: describe (binary dr) --------------------------------------

export interface DescribeSymbolicArgsOptions {
  reader?: SymbolicFileReader;
  toolCallId?: string;
  metrics?: SymbolicArgsMetrics;
  maxFileBytes?: number;
  maxTotalBytes?: number;
  /** True when hooks inspecting MCP calls are configured (binary refusal). */
  hooksInspectMcpCalls?: boolean;
}

export type DescribeSymbolicArgsResult =
  | { kind: "described"; bindings: SymbolicFileArgBinding[] }
  | { kind: "failed"; failure: SymbolicArgFailure };

/**
 * Review boundary — mirrors the binary's `dr` (route "review"): digestOnly
 * describe of each symbolic path. Success → `{kind:"described", bindings}`
 * (the `McpSymbolicPathArgument` descriptors that flow into the approval
 * review); any refusal → `{kind:"failed", failure}`. Metrics:
 * `mcp.symbolic_args.expansion{route:"review", outcome:"described"|<kind>}`.
 */
export async function describeSymbolicFileArgs(
  symbolicPaths: readonly string[],
  opts: DescribeSymbolicArgsOptions = {},
): Promise<DescribeSymbolicArgsResult> {
  const metrics = opts.metrics ?? sharedSymbolicArgsMetrics;
  const fail = (failure: SymbolicArgFailure): DescribeSymbolicArgsResult => {
    metrics.expansion("review", failure.kind);
    return { kind: "failed", failure };
  };
  const unique = [...new Set(symbolicPaths)];
  if (unique.length === 0) {
    return { kind: "described", bindings: [] };
  }
  if (opts.hooksInspectMcpCalls) {
    return fail(refuseSymbolicArgsForHooks(unique[0]));
  }
  try {
    const reads = await readAllSymbolicFiles(unique, {
      reader: opts.reader,
      describeOnly: true,
      metrics,
      maxFileBytes: opts.maxFileBytes,
      maxTotalBytes: opts.maxTotalBytes,
    });
    const bindings: SymbolicFileArgBinding[] = [...reads].map(([filePath, read]) => ({
      path: filePath,
      sha256: read.sha256,
      sizeBytes: read.bytes,
    }));
    metrics.expansion("review", "described");
    return { kind: "described", bindings };
  } catch (thrown) {
    return fail(toSymbolicArgFailure(thrown, unique[0]));
  }
}

// ---- executor boundary: expand (binary lr + pr) ----------------------------------

export interface ExpandSymbolicArgsOptions {
  reader?: SymbolicFileReader;
  toolCallId?: string;
  metrics?: SymbolicArgsMetrics;
  maxFileBytes?: number;
  maxTotalBytes?: number;
  /** True when hooks inspecting MCP calls are configured (binary refusal). */
  hooksInspectMcpCalls?: boolean;
  /**
   * Review-time bindings (from `describeSymbolicFileArgs`) for the
   * sha256 TOCTOU check — mirrors the binary's `content_changed` refusal.
   */
  expectedBindings?: readonly SymbolicFileArgBinding[];
}

export interface ExpandedSymbolicArgs {
  kind: "expanded" | "none";
  /** Args with `$file:` literals substituted (deep clone of the input). */
  args: Record<string, unknown>;
  /** Per-file substituted byte counts (binary `files` list). */
  files: Array<{ path: string; bytes: number }>;
  bindings: SymbolicFileArgBinding[];
}

/**
 * Executor boundary — mirrors the binary's `lr` + `pr` (route "local"):
 * reads each symbolic file, enforces caps, checks the review-time sha256
 * (TOCTOU → `content_changed`), substitutes contents into a cloned args
 * object, and records `mcp.symbolic_args.{expansion,bytes,paths}`.
 *
 * Binary outcomes, verbatim:
 * - >4 symbolic args → `too_many`: "at most 4 symbolic arguments may be used
 *   in one call (N given). Split the call or pass paths to tools that accept them."
 * - no read executor → `no_read_executor`: "this environment cannot read
 *   files on behalf of a tool call."
 * - file over per-file cap → `too_large`: "the file is too large to inline
 *   (B bytes; at most M bytes per file may be substituted). Pass the path to
 *   a tool that accepts one, or read a range of it."
 * - cumulative over 16777216 → `over_budget`: "together the N symbolic
 *   arguments exceed the 16777216 bytes that may be substituted per call.
 *   Pass paths to tools that accept them instead."
 * - sha256 differs from the review descriptor → `content_changed`: "the file
 *   changed after the call was reviewed (A bytes then, B bytes now), so its
 *   new contents were not sent. Re-run the call to review the current contents."
 */
export async function expandSymbolicFileArgs(
  args: Record<string, unknown>,
  opts: ExpandSymbolicArgsOptions = {},
): Promise<ExpandedSymbolicArgs> {
  const metrics = opts.metrics ?? sharedSymbolicArgsMetrics;
  const symbolicPaths = collectSymbolicFileArgs(args);
  if (symbolicPaths.length === 0) {
    // Mirrors `pr`'s early return: {kind:"none"} before any metric.
    return { kind: "none", args, files: [], bindings: [] };
  }
  if (opts.hooksInspectMcpCalls) {
    const failure = refuseSymbolicArgsForHooks(symbolicPaths[0]);
    metrics.expansion("local", failure.kind);
    throw new SymbolicArgError(failure);
  }
  let reads: Map<string, SymbolicFileRead>;
  try {
    reads = await readAllSymbolicFiles(symbolicPaths, {
      reader: opts.reader,
      describeOnly: false,
      metrics,
      maxFileBytes: opts.maxFileBytes,
      maxTotalBytes: opts.maxTotalBytes,
    });
  } catch (thrown) {
    const failure = toSymbolicArgFailure(thrown, symbolicPaths[0]);
    metrics.expansion("local", failure.kind);
    throw new SymbolicArgError(failure);
  }

  // TOCTOU freshness check (binary `content_changed`): the file must hash
  // the same as when the call was reviewed.
  const expected = new Map((opts.expectedBindings ?? []).map((b) => [b.path, b]));
  for (const [filePath, read] of reads) {
    const reviewed = expected.get(filePath);
    if (reviewed && reviewed.sha256 !== read.sha256) {
      const failure = symbolicArgFailure(
        "content_changed",
        filePath,
        `the file changed after the call was reviewed (${reviewed.sizeBytes} bytes then, ${read.bytes} bytes now), ` +
          `so its new contents were not sent. Re-run the call to review the current contents.`,
      );
      metrics.expansion("local", failure.kind);
      throw new SymbolicArgError(failure);
    }
  }

  const contents = new Map<string, string>();
  const files: Array<{ path: string; bytes: number }> = [];
  let totalBytes = 0;
  for (const [filePath, read] of reads) {
    // `not_text` can't survive readAllSymbolicFiles (it throws there), but
    // the type allows undefined — guard anyway.
    contents.set(filePath, read.text ?? "");
    files.push({ path: filePath, bytes: read.bytes });
    totalBytes += read.bytes;
  }
  const expandedArgs = substituteSymbolicFileArgs(args, contents);
  const bindings: SymbolicFileArgBinding[] = [...reads].map(([filePath, read]) => ({
    path: filePath,
    sha256: read.sha256,
    sizeBytes: read.bytes,
  }));
  metrics.expansion("local", "expanded");
  metrics.bytes("local", totalBytes);
  metrics.paths("local", symbolicPaths.length);
  return { kind: "expanded", args: expandedArgs, files, bindings };
}

/**
 * Shared read loop — the binary's `lr` core. Reads each path (concurrency is
 * not observable here; the binary uses max 4 in flight), enforcing the
 * per-file cap (`too_large`) and the total cap (`over_budget`).
 */
async function readAllSymbolicFiles(
  symbolicPaths: readonly string[],
  opts: {
    reader?: SymbolicFileReader;
    describeOnly: boolean;
    metrics: SymbolicArgsMetrics;
    maxFileBytes?: number;
    maxTotalBytes?: number;
  },
): Promise<Map<string, SymbolicFileRead>> {
  const maxFileBytes = opts.maxFileBytes ?? DEFAULT_MAX_SYMBOLIC_FILE_ARG_BYTES;
  const maxTotalBytes = opts.maxTotalBytes ?? MAX_SYMBOLIC_FILE_ARGS_TOTAL_BYTES;
  if (symbolicPaths.length > MAX_SYMBOLIC_FILE_ARGS_PER_CALL) {
    throw new SymbolicArgError(
      symbolicArgFailure(
        "too_many",
        symbolicPaths[MAX_SYMBOLIC_FILE_ARGS_PER_CALL] ?? "",
        `at most ${MAX_SYMBOLIC_FILE_ARGS_PER_CALL} symbolic arguments may be used in one call ` +
          `(${symbolicPaths.length} given). Split the call or pass paths to tools that accept them.`,
      ),
    );
  }
  const reader = opts.reader;
  if (!reader) {
    throw new SymbolicArgError(
      symbolicArgFailure(
        "no_read_executor",
        symbolicPaths[0] ?? "",
        "this environment cannot read files on behalf of a tool call.",
      ),
    );
  }
  const out = new Map<string, SymbolicFileRead>();
  let totalBytes = 0;
  for (const filePath of symbolicPaths) {
    const read = await reader.readFile(filePath);
    // In our architecture the reader always hashes locally, so every
    // describe is `vm_digest`-equivalent; `outdated_executor` cannot occur
    // (HONEST-DIVERGENCE 1).
    opts.metrics.describe("vm_digest");
    if (read.text === undefined) {
      throw new SymbolicArgError(
        symbolicArgFailure("not_text", filePath, "the file cannot be read as text."),
      );
    }
    if (read.bytes > maxFileBytes) {
      throw new SymbolicArgError(
        symbolicArgFailure(
          "too_large",
          filePath,
          `the file is too large to inline (${read.bytes} bytes; at most ${maxFileBytes} bytes per file may be ` +
            `substituted). Pass the path to a tool that accepts one, or read a range of it.`,
        ),
      );
    }
    totalBytes += read.bytes;
    if (totalBytes > maxTotalBytes) {
      throw new SymbolicArgError(
        symbolicArgFailure(
          "over_budget",
          filePath,
          `together the ${symbolicPaths.length} symbolic arguments exceed the ${maxTotalBytes} bytes that may be ` +
            `substituted per call. Pass paths to tools that accept them instead.`,
        ),
      );
    }
    out.set(filePath, read);
  }
  return out;
}
