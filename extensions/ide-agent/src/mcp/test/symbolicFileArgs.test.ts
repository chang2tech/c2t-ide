/**
 * Tests for `$file:` symbolic MCP arguments (mcp-symbolic-file-args).
 *
 * Binary source of truth: Cursor 3.25.6 + 3.25.9
 * `extensions/cursor-agent-exec/dist/main.js` (self-verified 2026-10-20,
 * W50D). Verbatim strings/caps asserted below:
 *   prefix "$file:", slice(6), isAbsolute check, max 4/call (too_many),
 *   total cap 16777216 (over_budget), error template, per-file too_large,
 *   not_text / not_found / permission_denied / read_error / no_read_executor /
 *   outdated_executor / content_changed outcomes, review route (described) +
 *   local route (expanded), metrics mcp.symbolic_args.{expansion,bytes,paths}
 *   (+ describe), hook-interplay + first-party scoping refusals.
 *
 * Imported by run-tests.ts AFTER ./vscode-shim (plain-node execution).
 */
import { describe, it } from "node:test";
import * as assert from "node:assert";
import { createHash } from "node:crypto";
import {
  SYMBOLIC_FILE_ARG_PREFIX,
  MAX_SYMBOLIC_FILE_ARGS_PER_CALL,
  MAX_SYMBOLIC_FILE_ARGS_TOTAL_BYTES,
  SymbolicArgError,
  InMemorySymbolicArgsMetrics,
  detectSymbolicFileArg,
  collectSymbolicFileArgs,
  substituteSymbolicFileArgs,
  symbolicArgFailure,
  toSymbolicArgFailure,
  refuseSymbolicArgsForHooks,
  refuseSymbolicArgsForFirstPartyTool,
  describeSymbolicFileArgs,
  expandSymbolicFileArgs,
  type SymbolicFileRead,
  type SymbolicFileReader,
} from "../symbolicFileArgs";
import { McpService } from "../service";
import type { McpProvider } from "../providerRegistry";

/* ---------- fake read executor ---------- */

function sha256Hex(text: string): string {
  return createHash("sha256").update(Buffer.from(text, "utf8")).digest("hex");
}

/** In-memory reader. `files` maps absPath → text, or the sentinel NOT_TEXT. */
const NOT_TEXT = Symbol("not_text");
function makeReader(
  files: Record<string, string | typeof NOT_TEXT>,
  opts: { throwOn?: (absPath: string) => Error } = {},
): SymbolicFileReader & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async readFile(absPath: string): Promise<SymbolicFileRead> {
      calls.push(absPath);
      if (opts.throwOn) {
        throw opts.throwOn(absPath);
      }
      const entry = files[absPath];
      if (entry === undefined) {
        throw new SymbolicArgError(symbolicArgFailure("not_found", absPath, "the file does not exist."));
      }
      if (entry === NOT_TEXT) {
        const bytes = Buffer.from([0xff, 0xfe, 0x00]);
        return { text: undefined, bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };
      }
      const bytes = Buffer.from(entry, "utf8");
      return { text: entry, bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };
    },
  };
}

const freshMetrics = () => new InMemorySymbolicArgsMetrics();
function counter(m: InMemorySymbolicArgsMetrics, metric: string, labels: string): number {
  return m.getCounters().get(`${metric}{${labels}}`) ?? 0;
}

/* ---------- detection (binary tr) ---------- */

describe("symbolicFileArgs: detectSymbolicFileArg (binary tr)", () => {
  it("detects the verbatim $file: prefix and slices 6 chars", () => {
    assert.strictEqual(SYMBOLIC_FILE_ARG_PREFIX, "$file:");
    assert.strictEqual(detectSymbolicFileArg("$file:/abs/path"), "/abs/path");
  });
  it("rejects relative paths (binary isAbsolute check)", () => {
    assert.strictEqual(detectSymbolicFileArg("$file:relative/path"), undefined);
    assert.strictEqual(detectSymbolicFileArg("$file:"), undefined);
  });
  it("rejects non-strings and non-prefix strings", () => {
    assert.strictEqual(detectSymbolicFileArg(42), undefined);
    assert.strictEqual(detectSymbolicFileArg(null), undefined);
    assert.strictEqual(detectSymbolicFileArg({}), undefined);
    assert.strictEqual(detectSymbolicFileArg("see $file:/x"), undefined);
    assert.strictEqual(detectSymbolicFileArg("$FILE:/x"), undefined);
  });
});

/* ---------- collection (binary rr) ---------- */

describe("symbolicFileArgs: collectSymbolicFileArgs (binary rr)", () => {
  it("recursively collects from nested arrays/objects, deduplicated", () => {
    const args = {
      prompt: "read $file:/a please",
      nested: { list: ["$file:/b", "$file:/a", "plain"], deep: { x: "$file:/c" } },
      rel: "$file:relative",
    };
    // NOTE: "read $file:/a please" does NOT start with the prefix — only
    // prefix-leading strings are symbolic (binary startsWith check).
    assert.deepStrictEqual(collectSymbolicFileArgs(args), ["/b", "/a", "/c"]);
  });
  it("returns [] when nothing is symbolic", () => {
    assert.deepStrictEqual(collectSymbolicFileArgs({ a: 1, b: ["x"] }), []);
  });
});

/* ---------- substitution ---------- */

describe("symbolicFileArgs: substituteSymbolicFileArgs", () => {
  it("replaces every occurrence in a deep clone; input untouched", () => {
    const args = { p: "$file:/a", n: { l: ["$file:/a", "$file:/b", 1] } };
    const out = substituteSymbolicFileArgs(args, new Map([["/a", "AAA"], ["/b", "BBB"]]));
    assert.deepStrictEqual(out, { p: "AAA", n: { l: ["AAA", "BBB", 1] } });
    assert.deepStrictEqual(args, { p: "$file:/a", n: { l: ["$file:/a", "$file:/b", 1] } });
  });
  it("leaves unknown $file: strings as-is", () => {
    const out = substituteSymbolicFileArgs({ p: "$file:/zzz" }, new Map());
    assert.deepStrictEqual(out, { p: "$file:/zzz" });
  });
});

/* ---------- error template (binary ar, verbatim) ---------- */

describe("symbolicFileArgs: error template (binary ar)", () => {
  it("uses the verbatim message template", () => {
    const f = symbolicArgFailure("too_many", "/x", "some reason");
    assert.strictEqual(f.kind, "too_many");
    assert.strictEqual(
      f.message,
      `Could not resolve the symbolic argument "$file:/x": some reason ` +
        `A string argument of the form "$file:/absolute/path" is replaced with that file's ` +
        `contents before the tool runs; pass the literal text instead if you did not intend that.`,
    );
  });
  it("SymbolicArgError carries .failure; toSymbolicArgFailure maps foreign errors to read_error", () => {
    const f = symbolicArgFailure("not_found", "/x", "the file does not exist.");
    const err = new SymbolicArgError(f);
    assert.strictEqual(err.failure, f);
    assert.strictEqual(err.message, f.message);
    const mapped = toSymbolicArgFailure(new Error("boom"), "/y");
    assert.strictEqual(mapped.kind, "read_error");
    assert.ok(mapped.message.includes("boom"), mapped.message);
    assert.ok(mapped.message.startsWith(`Could not resolve the symbolic argument "$file:/y":`), mapped.message);
  });
});

/* ---------- refusal strings (binary hook interplay + scoping) ---------- */

describe("symbolicFileArgs: hook + scoping refusals", () => {
  it("hooks refusal uses the verbatim binary string", () => {
    const f = refuseSymbolicArgsForHooks("/x");
    assert.strictEqual(f.kind, "hooks_configured");
    assert.ok(f.message.includes(`"$file:" arguments can't be used on this computer`), f.message);
    assert.ok(f.message.includes("hooks that inspect MCP calls are configured here"), f.message);
    assert.ok(f.message.includes("would not see the file's contents"), f.message);
  });
  it("first-party scoping refusal names the tool", () => {
    const f = refuseSymbolicArgsForFirstPartyTool("/x", "demo");
    assert.strictEqual(f.kind, "first_party_tool");
    assert.ok(f.message.includes("only supported for external MCP tools"), f.message);
    assert.ok(f.message.includes("demo is a first-party tool"), f.message);
  });
});

/* ---------- executor boundary (binary lr + pr) ---------- */

describe("symbolicFileArgs: expandSymbolicFileArgs (binary lr/pr)", () => {
  it("kind none when no symbolic args; no metrics; args untouched", async () => {
    const m = freshMetrics();
    const args = { q: "hello" };
    const out = await expandSymbolicFileArgs(args, { metrics: m });
    assert.strictEqual(out.kind, "none");
    assert.strictEqual(out.args, args);
    assert.strictEqual(m.getCounters().size, 0);
  });

  it("too_many: >4 symbolic args rejected with verbatim message", async () => {
    const m = freshMetrics();
    const args = { a: "$file:/1", b: "$file:/2", c: "$file:/3", d: "$file:/4", e: "$file:/5" };
    await assert.rejects(() => expandSymbolicFileArgs(args, { metrics: m, reader: makeReader({}) }), (e: unknown) => {
      assert.ok(e instanceof SymbolicArgError);
      assert.strictEqual(e.failure.kind, "too_many");
      assert.ok(e.failure.message.includes("at most 4 symbolic arguments may be used in one call (5 given)"), e.failure.message);
      return true;
    });
    assert.strictEqual(MAX_SYMBOLIC_FILE_ARGS_PER_CALL, 4);
    assert.strictEqual(counter(m, "mcp.symbolic_args.expansion", `route="local",outcome="too_many"`), 1);
  });

  it("no_read_executor when no reader is supplied", async () => {
    await assert.rejects(() => expandSymbolicFileArgs({ a: "$file:/x" }, { metrics: freshMetrics() }), (e: unknown) => {
      assert.ok(e instanceof SymbolicArgError);
      assert.strictEqual(e.failure.kind, "no_read_executor");
      assert.ok(e.failure.message.includes("this environment cannot read files on behalf of a tool call"), e.failure.message);
      return true;
    });
  });

  it("hooks refusal at the executor boundary", async () => {
    const m = freshMetrics();
    await assert.rejects(
      () => expandSymbolicFileArgs({ a: "$file:/x" }, { metrics: m, hooksInspectMcpCalls: true }),
      (e: unknown) => {
        assert.ok(e instanceof SymbolicArgError);
        assert.strictEqual(e.failure.kind, "hooks_configured");
        return true;
      },
    );
    assert.strictEqual(counter(m, "mcp.symbolic_args.expansion", `route="local",outcome="hooks_configured"`), 1);
  });

  it("expands contents, records bytes/paths/describe metrics", async () => {
    const m = freshMetrics();
    const reader = makeReader({ "/a": "hello", "/b": "world!" });
    const args = { prompt: "$file:/a", nested: { x: "$file:/b", y: "$file:/a" } };
    const out = await expandSymbolicFileArgs(args, { metrics: m, reader });
    assert.strictEqual(out.kind, "expanded");
    assert.deepStrictEqual(out.args, { prompt: "hello", nested: { x: "world!", y: "hello" } });
    assert.deepStrictEqual(reader.calls.sort(), ["/a", "/b"]);
    assert.strictEqual(out.bindings.length, 2);
    assert.strictEqual(out.bindings[0].sha256, sha256Hex("hello"));
    assert.strictEqual(out.bindings[0].sizeBytes, 5);
    assert.strictEqual(counter(m, "mcp.symbolic_args.expansion", `route="local",outcome="expanded"`), 1);
    assert.strictEqual(counter(m, "mcp.symbolic_args.bytes", `route="local"`), 11);
    assert.strictEqual(counter(m, "mcp.symbolic_args.paths", `route="local"`), 2);
    assert.strictEqual(counter(m, "mcp.symbolic_args.describe", `source="vm_digest"`), 2);
  });

  it("read_error surfaces the reader message inside the template", async () => {
    const reader = makeReader({}, { throwOn: () => new Error("disk gone") });
    await assert.rejects(() => expandSymbolicFileArgs({ a: "$file:/x" }, { metrics: freshMetrics(), reader }), (e: unknown) => {
      assert.ok(e instanceof SymbolicArgError);
      assert.strictEqual(e.failure.kind, "read_error");
      assert.ok(e.failure.message.includes("disk gone"), e.failure.message);
      return true;
    });
  });

  it("not_text for undecodable files", async () => {
    const reader = makeReader({ "/bin": NOT_TEXT });
    await assert.rejects(() => expandSymbolicFileArgs({ a: "$file:/bin" }, { metrics: freshMetrics(), reader }), (e: unknown) => {
      assert.ok(e instanceof SymbolicArgError);
      assert.strictEqual(e.failure.kind, "not_text");
      return true;
    });
  });

  it("too_large: per-file cap with verbatim message", async () => {
    const reader = makeReader({ "/big": "0123456789ABCDEF" });
    await assert.rejects(
      () => expandSymbolicFileArgs({ a: "$file:/big" }, { metrics: freshMetrics(), reader, maxFileBytes: 10 }),
      (e: unknown) => {
        assert.ok(e instanceof SymbolicArgError);
        assert.strictEqual(e.failure.kind, "too_large");
        assert.ok(
          e.failure.message.includes("the file is too large to inline (16 bytes; at most 10 bytes per file may be substituted)"),
          e.failure.message,
        );
        return true;
      },
    );
  });

  it("over_budget: 16777216 total cap enforced", async () => {
    assert.strictEqual(MAX_SYMBOLIC_FILE_ARGS_TOTAL_BYTES, 16777216);
    const reader = makeReader({ "/a": "12345678", "/b": "12345678" });
    await assert.rejects(
      () => expandSymbolicFileArgs({ a: "$file:/a", b: "$file:/b" }, { metrics: freshMetrics(), reader, maxTotalBytes: 10 }),
      (e: unknown) => {
        assert.ok(e instanceof SymbolicArgError);
        assert.strictEqual(e.failure.kind, "over_budget");
        assert.ok(e.failure.message.includes("exceed the 10 bytes that may be substituted per call"), e.failure.message);
        return true;
      },
    );
  });

  it("content_changed: TOCTOU refusal when the file changed after review", async () => {
    const reader = makeReader({ "/a": "new-content" });
    const stale = [{ path: "/a", sha256: sha256Hex("old-content"), sizeBytes: 11 }];
    await assert.rejects(
      () =>
        expandSymbolicFileArgs({ a: "$file:/a" }, { metrics: freshMetrics(), reader, expectedBindings: stale }),
      (e: unknown) => {
        assert.ok(e instanceof SymbolicArgError);
        assert.strictEqual(e.failure.kind, "content_changed");
        assert.ok(e.failure.message.includes("the file changed after the call was reviewed"), e.failure.message);
        assert.ok(e.failure.message.includes("so its new contents were not sent"), e.failure.message);
        return true;
      },
    );
  });

  it("no content_changed when the review descriptor matches", async () => {
    const reader = makeReader({ "/a": "stable" });
    const fresh = [{ path: "/a", sha256: sha256Hex("stable"), sizeBytes: 6 }];
    const out = await expandSymbolicFileArgs({ a: "$file:/a" }, { metrics: freshMetrics(), reader, expectedBindings: fresh });
    assert.strictEqual(out.kind, "expanded");
    assert.deepStrictEqual(out.args, { a: "stable" });
  });
});

/* ---------- review boundary: describe (binary dr) ---------- */

describe("symbolicFileArgs: describeSymbolicFileArgs (binary dr)", () => {
  it("described: bindings carry path + sha256 + size_bytes", async () => {
    const m = freshMetrics();
    const reader = makeReader({ "/a": "hello" });
    const out = await describeSymbolicFileArgs(["/a"], { metrics: m, reader });
    assert.strictEqual(out.kind, "described");
    if (out.kind === "described") {
      assert.strictEqual(out.bindings.length, 1);
      assert.strictEqual(out.bindings[0].path, "/a");
      assert.strictEqual(out.bindings[0].sha256, sha256Hex("hello"));
      assert.strictEqual(out.bindings[0].sizeBytes, 5);
    }
    assert.strictEqual(counter(m, "mcp.symbolic_args.expansion", `route="review",outcome="described"`), 1);
  });

  it("failed: describe refusal maps to the failure kind metric", async () => {
    const m = freshMetrics();
    const out = await describeSymbolicFileArgs(["/missing"], { metrics: m, reader: makeReader({}) });
    assert.strictEqual(out.kind, "failed");
    if (out.kind === "failed") {
      assert.strictEqual(out.failure.kind, "not_found");
    }
    assert.strictEqual(counter(m, "mcp.symbolic_args.expansion", `route="review",outcome="not_found"`), 1);
  });

  it("hooks refusal at the review boundary", async () => {
    const out = await describeSymbolicFileArgs(["/a"], { metrics: freshMetrics(), hooksInspectMcpCalls: true });
    assert.strictEqual(out.kind, "failed");
    if (out.kind === "failed") {
      assert.strictEqual(out.failure.kind, "hooks_configured");
    }
  });
});

/* ---------- service integration: provider-path scoping ---------- */

describe("symbolicFileArgs: McpService provider-path scoping", () => {
  const makeService = () => {
    const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
    const provider: McpProvider = {
      id: "demo",
      instructions: "demo provider",
      async listOfferings() {
        return {
          tools: [{ name: "ping", description: "ping", parameters: { type: "object" } }],
          prompts: [],
          resources: [],
        };
      },
      async callTool(name, args) {
        calls.push({ name, args });
        return { content: [{ type: "text", text: `ok:${name}` }] };
      },
    };
    const fakeComposer = {
      composerId: "composer-sym",
      reviews: {
        requestApproval: async () => ({ optionId: "approve-once" }),
      },
    };
    const globalStateBacking = new Map<string, unknown>();
    const service = new McpService(
      {
        subscriptions: [],
        globalState: {
          get<T>(key: string, def: T): T {
            return (globalStateBacking.has(key) ? globalStateBacking.get(key) : def) as T;
          },
          update(key: string, value: unknown): Promise<void> {
            globalStateBacking.set(key, value);
            return Promise.resolve();
          },
        },
      } as never,
      () => fakeComposer as never,
    );
    service.registerMcpProvider(provider);
    return { service, calls };
  };

  it("provider (first-party) tool call with $file: args is refused; provider never invoked", async () => {
    const { service, calls } = makeService();
    try {
      await service.refreshProviderTools("demo");
      await assert.rejects(
        () => service.callTool("mcp__demo__ping", { msg: "$file:/etc/hostname" }, { toolCallId: "tc-sym-1" }),
        (e: unknown) => {
          assert.ok(e instanceof SymbolicArgError, `expected SymbolicArgError, got ${e}`);
          assert.strictEqual(e.failure.kind, "first_party_tool");
          assert.ok(e.failure.message.includes("only supported for external MCP tools"), e.failure.message);
          assert.ok(e.failure.message.includes("demo is a first-party tool"), e.failure.message);
          return true;
        },
      );
      assert.strictEqual(calls.length, 0, "provider must not be invoked on scoping refusal");
    } finally {
      service.dispose();
    }
  });

  it("provider call without $file: args still works", async () => {
    const { service, calls } = makeService();
    try {
      await service.refreshProviderTools("demo");
      const result = await service.callTool("mcp__demo__ping", { msg: "hi" }, { toolCallId: "tc-sym-2" });
      assert.strictEqual(calls.length, 1);
      assert.deepStrictEqual(calls[0].args, { msg: "hi" });
      assert.ok(result, "expected a result");
    } finally {
      service.dispose();
    }
  });
});
