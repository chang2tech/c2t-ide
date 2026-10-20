/**
 * Sandbox tests (policy + backend probing + network proxy + spawn).
 *
 * Run after `tsc`: node --test out/services/test/run-sandbox-tests.js
 *
 * Honesty rule for these tests: they assert what the sandbox REALLY does.
 * The namespaces test performs a REAL outbound connection attempt inside
 * `unshare --net` and requires it to fail — if isolation ever silently
 * broke, this test goes red instead of green.
 */
import { describe, it, before, after } from "node:test";
import * as assert from "node:assert";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import "./vscode-stub";

import {
  applyNetworkPolicyStrict,
  buildUnifiedPolicy,
  expandAdditionalReadonlyPaths,
  HARDCODED_WRITE_PROTECTED,
  loadSandboxJsonLayers,
  planFilesystemAccess,
  SSRF_DENY_DEFAULTS,
  validateUnifiedPolicy,
  type UnifiedPolicy,
} from "../../sandbox/policy";
import {
  buildBwrapArgs,
  buildUnshareArgs,
  findExecutable,
  isRootOwnedExecutable,
  readBackendPreference,
  resolveLinuxBackend,
  LINUX_BACKEND_ENV,
} from "../../sandbox/landlock";
import {
  decideNetworkAccess,
  deletePolicyTempFile,
  filterSandboxOwnedEnv,
  matchNetworkEntry,
  NetworkProxy,
  preflight,
  resetSandboxClassifier,
  SandboxApprovalStore,
  setSandboxClassifier,
  spawnSandboxed,
  startPolicyProxy,
  suggestSandboxMode,
  writePolicyTempFile,
  APPROVAL_TTL_MS,
} from "../../sandbox/sandboxService";

const sha256hex = (s: string) => crypto.createHash("sha256").update(s).digest("hex");

function makePolicy(overrides: Partial<UnifiedPolicy["sandbox"]> = {}): UnifiedPolicy {
  return {
    sandbox: {
      type: "workspace_readwrite",
      cwd: "/tmp",
      readBoundary: "system",
      hardcodedReadPaths: [],
      additionalReadwritePaths: [],
      additionalReadonlyPaths: {},
      networkAccess: true,
      disableTmpWrite: false,
      blockGitWrite: true,
      ignoreMapping: {},
      ...overrides,
    },
    networkPolicy: { version: 1, default: "deny", allow: [], deny: [] },
  };
}

/* ---------------- policy.ts ---------------- */

describe("policy: expandAdditionalReadonlyPaths (kt() port)", () => {
  it("expands directories to {dir: ['**']}", () => {
    const out = expandAdditionalReadonlyPaths(["/usr/lib"], () => true);
    assert.deepStrictEqual(out, { "/usr/lib": ["**"] });
  });
  it("expands files to {parent: [base, 'base/**']}", () => {
    const out = expandAdditionalReadonlyPaths(["/etc/ssl/cert.pem"], () => false);
    assert.deepStrictEqual(out, { "/etc/ssl": ["cert.pem", "cert.pem/**"] });
  });
  it("merges multiple files under one parent", () => {
    const out = expandAdditionalReadonlyPaths(["/etc/a", "/etc/b"], () => false);
    assert.deepStrictEqual(out, { "/etc": ["a", "a/**", "b", "b/**"] });
  });
});

describe("policy: loadSandboxJsonLayers", () => {
  let home: string;
  let ws: string;
  before(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "sb-home-"));
    ws = fs.mkdtempSync(path.join(os.tmpdir(), "sb-ws-"));
  });
  after(() => {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(ws, { recursive: true, force: true });
  });

  it("repo config wins over user config", () => {
    fs.mkdirSync(path.join(home, ".ide"), { recursive: true });
    fs.mkdirSync(path.join(ws, ".ide"), { recursive: true });
    fs.writeFileSync(path.join(home, ".ide", "sandbox.json"), JSON.stringify({ type: "workspace_readwrite", disableTmpWrite: false }));
    fs.writeFileSync(path.join(ws, ".ide", "sandbox.json"), JSON.stringify({ disableTmpWrite: true }));
    const cfg = loadSandboxJsonLayers(home, ws);
    assert.strictEqual(cfg.type, "workspace_readwrite");
    assert.strictEqual(cfg.disableTmpWrite, true);
  });

  it("throws when layers disagree on type (Cursor: all policies same type)", () => {
    fs.writeFileSync(path.join(home, ".ide", "sandbox.json"), JSON.stringify({ type: "workspace_readonly" }));
    fs.writeFileSync(path.join(ws, ".ide", "sandbox.json"), JSON.stringify({ type: "workspace_readwrite" }));
    assert.throws(() => loadSandboxJsonLayers(home, ws), /same type/);
    fs.writeFileSync(path.join(home, ".ide", "sandbox.json"), JSON.stringify({ type: "workspace_readwrite" }));
    fs.writeFileSync(path.join(ws, ".ide", "sandbox.json"), JSON.stringify({ disableTmpWrite: true }));
  });
});

describe("policy: validateUnifiedPolicy", () => {
  it("accepts a well-formed readwrite policy", () => {
    const v = validateUnifiedPolicy(makePolicy());
    assert.ok(v.ok, v.errors.join("; "));
  });
  it("rejects additionalReadonlyPaths as a plain array (binary wants a map)", () => {
    const p = makePolicy({ additionalReadonlyPaths: [] as unknown as Record<string, string[]> });
    const v = validateUnifiedPolicy(p);
    assert.ok(!v.ok);
    assert.ok(v.errors.some((e) => e.includes("additionalReadonlyPaths")));
  });
  it("rejects readonly variant carrying readwrite fields", () => {
    const p = makePolicy({ type: "workspace_readonly", additionalReadwritePaths: ["/x"] });
    const v = validateUnifiedPolicy(p);
    assert.ok(!v.ok);
  });
  it("rejects unknown type", () => {
    const p = makePolicy({ type: "yolo" as unknown as "workspace_readwrite" });
    assert.ok(!validateUnifiedPolicy(p).ok);
  });
});

describe("policy: build + strict + plan", () => {
  it("buildUnifiedPolicy output validates clean", () => {
    const built = buildUnifiedPolicy({ type: "workspace_readwrite" }, { workspaceDir: "/tmp/ws" });
    const v = validateUnifiedPolicy(built);
    assert.ok(v.ok, v.errors.join("; "));
  });
  it("networkPolicyStrict forces default deny", () => {
    const p: UnifiedPolicy = {
      ...makePolicy(),
      networkPolicy: { version: 1, default: "allow", allow: [], deny: [] },
      networkPolicyStrict: true,
    };
    assert.strictEqual(applyNetworkPolicyStrict(p).networkPolicy?.default, "deny");
  });
  it("SSRF defaults land in the deny list", () => {
    const built = buildUnifiedPolicy({}, { workspaceDir: "/tmp/ws" });
    for (const cidr of SSRF_DENY_DEFAULTS) {
      assert.ok(built.networkPolicy?.deny.includes(cidr), `missing ${cidr}`);
    }
  });
  it("plan puts workspace RW and hardcoded paths denied", () => {
    const plan = planFilesystemAccess(makePolicy(), { workspaceDir: "/tmp/ws" });
    assert.ok(plan.readwrite.includes("/tmp/ws"));
    assert.ok(plan.denied.includes(HARDCODED_WRITE_PROTECTED[0]));
    assert.ok(plan.denied.some((d) => d.includes(".git/**")), "blockGitWrite denies .git");
  });
});

/* ---------------- landlock.ts ---------------- */

describe("landlock: probing", () => {
  const OLD_ENV = { ...process.env };
  after(() => {
    process.env = OLD_ENV;
  });

  it("readBackendPreference honors IDE_SANDBOX_LINUX_BACKEND", () => {
    process.env[LINUX_BACKEND_ENV] = "bubblewrap";
    assert.strictEqual(readBackendPreference(), "bubblewrap");
    process.env[LINUX_BACKEND_ENV] = "landlock";
    assert.strictEqual(readBackendPreference(), "landlock");
    delete process.env[LINUX_BACKEND_ENV];
    assert.strictEqual(readBackendPreference(), "auto");
  });

  it("findExecutable finds sh, misses nonsense", () => {
    assert.ok(findExecutable("sh"));
    assert.strictEqual(findExecutable("definitely-not-a-binary-xyz"), undefined);
  });

  it("isRootOwnedExecutable distinguishes owners", () => {
    const f = path.join(os.tmpdir(), `sb-own-${process.pid}`);
    fs.writeFileSync(f, "x");
    try {
      assert.ok(isRootOwnedExecutable(f), "we run as root, so our file is root-owned");
      fs.chownSync(f, 65534, 65534);
      assert.ok(!isRootOwnedExecutable(f), "nobody-owned file must not count as root-owned");
    } finally {
      fs.unlinkSync(f);
    }
  });

  it("'landlock' resolves unsupported with an honest reason (no native helper yet)", () => {
    const probe = resolveLinuxBackend("landlock");
    assert.strictEqual(probe.supported, false);
    assert.strictEqual(probe.backend, "unsupported");
    assert.ok(probe.reason.includes("idesandbox"), probe.reason);
    assert.strictEqual(probe.landlockStatus, "not_enforced");
  });

  it("'bubblewrap' with no bwrap on PATH is unsupported", () => {
    const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), "sb-empty-path-"));
    const probe = resolveLinuxBackendWithPath("bubblewrap", emptyDir);
    fs.rmSync(emptyDir, { recursive: true, force: true });
    assert.strictEqual(probe.supported, false);
    assert.ok(probe.reason.includes("no bwrap"), probe.reason);
  });

  it("'bubblewrap' with a root-owned fake bwrap is supported", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sb-fake-bwrap-"));
    const fake = path.join(dir, "bwrap");
    fs.writeFileSync(fake, "#!/bin/sh\necho fake-bwrap\n");
    fs.chmodSync(fake, 0o755); // we are root → uid 0 → root-owned
    try {
      const probe = resolveLinuxBackendWithPath("bubblewrap", dir);
      assert.strictEqual(probe.supported, true);
      assert.strictEqual(probe.backend, "bubblewrap");
      assert.strictEqual(probe.bwrapPath, fake);
      assert.strictEqual(probe.landlockStatus, "bubblewrap");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("buildBwrapArgs binds workspace RW, denies via tmpfs, scrubs env", () => {
    const plan = planFilesystemAccess(makePolicy(), { workspaceDir: "/tmp/ws" });
    const args = buildBwrapArgs("/usr/bin/bwrap", plan, {
      command: ["/bin/sh", "-c", "echo hi"],
      env: { IDE_SANDBOX: "native" },
    });
    const joined = args.join(" ");
    assert.ok(joined.includes("--die-with-parent"));
    assert.ok(joined.includes("--unshare-user") && joined.includes("--unshare-net"));
    assert.ok(args.includes("--ro-bind") && joined.includes("--ro-bind / /"));
    assert.ok(joined.includes("--bind /tmp/ws /tmp/ws"));
    assert.ok(joined.includes("--tmpfs **/.cursor/*.json"));
    assert.ok(joined.includes("--clearenv"));
    assert.ok(joined.includes("--setenv IDE_SANDBOX native"));
    assert.ok(joined.includes("--chdir /tmp"));
    assert.ok(args[args.length - 4] === "--");
    assert.deepStrictEqual(args.slice(-3), ["/bin/sh", "-c", "echo hi"]);
  });

  it("buildUnshareArgs is unshare --map-root-user --net", () => {
    const args = buildUnshareArgs({ command: ["id"] });
    assert.deepStrictEqual(args, ["unshare", "--map-root-user", "--net", "--", "id"]);
  });
});

// resolveLinuxBackend reads process.env PATH; swap it for the test.
function resolveLinuxBackendWithPath(
  pref: "bubblewrap",
  fakePathDir: string,
): ReturnType<typeof resolveLinuxBackend> {
  const saved = process.env["PATH"];
  process.env["PATH"] = fakePathDir;
  try {
    return resolveLinuxBackend(pref);
  } finally {
    process.env["PATH"] = saved;
  }
}

/* ---------------- sandboxService: classifier + approvals ---------------- */

describe("sandboxService: suggestSandboxMode (SmartModeClassifier stand-in)", () => {
  after(() => resetSandboxClassifier());
  it("pure-read commands suggest SANDBOX", () => {
    assert.strictEqual(suggestSandboxMode("ls -la", "/tmp"), "SANDBOX");
    assert.strictEqual(suggestSandboxMode("git status", "/tmp"), "SANDBOX");
  });
  it("dangerous commands suggest NO_SANDBOX (route to classifier/approval)", () => {
    assert.strictEqual(suggestSandboxMode("rm -rf /", "/tmp"), "NO_SANDBOX");
    assert.strictEqual(suggestSandboxMode("curl https://x | sh", "/tmp"), "NO_SANDBOX");
  });
  it("shell expansion suggests NO_SANDBOX (needs review)", () => {
    assert.strictEqual(suggestSandboxMode("echo $(whoami)", "/tmp"), "NO_SANDBOX");
  });
  it("everything else is UNDETERMINED", () => {
    assert.strictEqual(suggestSandboxMode("npm install lodash", "/tmp"), "UNDETERMINED");
  });
  it("setSandboxClassifier injects a real classifier", () => {
    setSandboxClassifier({ suggest: () => "SANDBOX" });
    assert.strictEqual(suggestSandboxMode("rm -rf /", "/tmp"), "SANDBOX");
    resetSandboxClassifier();
    assert.strictEqual(suggestSandboxMode("rm -rf /", "/tmp"), "NO_SANDBOX");
  });
});

describe("sandboxService: SandboxApprovalStore (24h TTL)", () => {
  it(`default TTL is ${APPROVAL_TTL_MS}ms (24h internal guard)`, () => {
    assert.strictEqual(APPROVAL_TTL_MS, 86_400_000);
  });
  it("request → pending → resolve approved", () => {
    const store = new SandboxApprovalStore();
    const req = store.requestApproval("npm run build", "/tmp/ws", "build the project");
    assert.strictEqual(store.checkApproval("npm run build", "/tmp/ws"), "pending");
    assert.ok(store.resolveApproval(req.id, true));
    assert.strictEqual(store.checkApproval("npm run build", "/tmp/ws"), "approved");
  });
  it("unknown command is none; resolve of unknown id is false", () => {
    const store = new SandboxApprovalStore();
    assert.strictEqual(store.checkApproval("nope", "/tmp"), "none");
    assert.strictEqual(store.resolveApproval("no-such-id", true), false);
  });
  it("expired approvals are cleaned up", async () => {
    const store = new SandboxApprovalStore(30);
    store.requestApproval("sleep 1", "/tmp", "x");
    await new Promise((r) => setTimeout(r, 60));
    assert.strictEqual(store.checkApproval("sleep 1", "/tmp"), "expired");
    assert.strictEqual(store.cleanupExpiredApprovals(), 1);
    assert.strictEqual(store.size, 0);
  });
});

/* ---------------- network policy matching ---------------- */

describe("sandboxService: network matching", () => {
  it("exact + case-insensitive", () => {
    assert.ok(matchNetworkEntry("Example.COM", "example.com"));
    assert.ok(!matchNetworkEntry("example.com", "other.com"));
  });
  it("wildcards", () => {
    assert.ok(matchNetworkEntry("*.example.com", "a.example.com"));
    assert.ok(!matchNetworkEntry("*.example.com", "example.com"));
    assert.ok(!matchNetworkEntry("*.example.com", "a.notexample.com"));
  });
  it("CIDR v4", () => {
    assert.ok(matchNetworkEntry("127.0.0.0/8", "127.0.0.53"));
    assert.ok(!matchNetworkEntry("127.0.0.0/8", "128.0.0.1"));
    assert.ok(matchNetworkEntry("10.0.0.0/8", "10.1.2.3"));
  });
  it("localhost alias covers loopbacks", () => {
    assert.ok(matchNetworkEntry("localhost", "127.0.0.1"));
    assert.ok(matchNetworkEntry("localhost", "::1"));
  });
  it("deny beats allow; SSRF defaults deny RFC1918 even when allowed", () => {
    const policy = { version: 1 as const, default: "deny" as const, allow: ["10.0.0.5"], deny: [] as string[] };
    const d = decideNetworkAccess(policy, "10.0.0.5", 80);
    assert.strictEqual(d.decision, "deny");
    assert.strictEqual(d.reason, "deny_list");
  });
  it("allow list permits; default deny blocks the rest", () => {
    const policy = { version: 1 as const, default: "deny" as const, allow: ["127.0.0.0/8", "localhost"], deny: [] as string[] };
    assert.strictEqual(decideNetworkAccess(policy, "127.0.0.53", 80).decision, "allow");
    assert.strictEqual(decideNetworkAccess(policy, "example.com", 443).decision, "deny");
  });
});

/* ---------------- network proxy (real CONNECT + SOCKS5) ---------------- */

function readExactly(socket: net.Socket, n: number, timeoutMs = 3000): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    let buf = Buffer.alloc(0);
    const timer = setTimeout(() => reject(new Error("read timeout")), timeoutMs);
    const onData = (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk]);
      if (buf.length >= n) {
        clearTimeout(timer);
        socket.off("data", onData);
        resolve(buf.subarray(0, n));
      }
    };
    socket.on("data", onData);
  });
}

function readHttpHead(socket: net.Socket, timeoutMs = 3000): Promise<string> {
  return new Promise((resolve, reject) => {
    let buf = "";
    const timer = setTimeout(() => reject(new Error("read timeout")), timeoutMs);
    const onData = (chunk: Buffer) => {
      buf += chunk.toString("utf8");
      if (buf.includes("\r\n\r\n")) {
        clearTimeout(timer);
        socket.off("data", onData);
        resolve(buf);
      }
    };
    socket.on("data", onData);
  });
}

describe("sandboxService: NetworkProxy", () => {
  let echoPort: number;
  let echoServer: net.Server;
  before(async () => {
    echoServer = net.createServer((s) => s.pipe(s));
    await new Promise<void>((r) => echoServer.listen(0, "127.0.0.1", r));
    echoPort = (echoServer.address() as net.AddressInfo).port;
  });
  after(async () => {
    await new Promise<void>((r) => echoServer.close(() => r()));
  });

  it("CONNECT allows allowlisted loopback, denies the outside world, logs hashed decisions", async () => {
    const logPath = path.join(os.tmpdir(), `sb-netlog-${process.pid}.jsonl`);
    const proxy = new NetworkProxy(
      { version: 1, default: "deny", allow: ["127.0.0.0/8", "localhost"], deny: [] },
      { decisionLogPath: logPath },
    );
    const handle = await proxy.start();
    try {
      // allowed
      const okSock = net.connect(handle.httpPort, "127.0.0.1");
      okSock.write(`CONNECT 127.0.0.1:${echoPort} HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n`);
      const okHead = await readHttpHead(okSock);
      assert.ok(okHead.startsWith("HTTP/1.1 200"), okHead.split("\r\n")[0]);
      okSock.destroy();

      // denied
      const badSock = net.connect(handle.httpPort, "127.0.0.1");
      badSock.write("CONNECT 93.184.216.34:80 HTTP/1.1\r\nHost: x\r\n\r\n");
      const badHead = await readHttpHead(badSock);
      assert.ok(badHead.startsWith("HTTP/1.1 403"), badHead.split("\r\n")[0]);
      assert.ok(badHead.includes("Blocked by sandbox network policy"));
      badSock.destroy();

      await handle.stop();
      const lines = fs.readFileSync(logPath, "utf8").trim().split("\n");
      assert.ok(lines.length >= 2, "decision log should have both requests");
      const deniedLine = lines.find((l) => l.includes(sha256hex("93.184.216.34")));
      assert.ok(deniedLine, "denied host must be logged by hash");
      assert.ok(deniedLine.includes('"decision":"deny"'));
      assert.ok(!lines.some((l) => l.includes("93.184.216.34")), "no plaintext hosts in log (privacy)");
    } finally {
      await handle.stop().catch(() => undefined);
      fs.rmSync(logPath, { force: true });
    }
  });

  it("SOCKS5 tunnels allowlisted hosts and refuses denied ones", async () => {
    const proxy = new NetworkProxy(
      { version: 1, default: "deny", allow: ["127.0.0.0/8"], deny: [] },
      {},
    );
    const handle = await proxy.start();
    try {
      const sock = net.connect(handle.socksPort, "127.0.0.1");
      sock.write(Buffer.from([0x05, 0x01, 0x00]));
      assert.deepStrictEqual(await readExactly(sock, 2), Buffer.from([0x05, 0x00]));
      const req = Buffer.from([0x05, 0x01, 0x00, 0x01, 127, 0, 0, 1, echoPort >> 8, echoPort & 0xff]);
      sock.write(req);
      const rep = await readExactly(sock, 10);
      assert.strictEqual(rep[1], 0x00, "SOCKS5 CONNECT to loopback must succeed");
      sock.write(Buffer.from("ping"));
      const echo = await readExactly(sock, 4);
      assert.strictEqual(echo.toString(), "ping");
      sock.destroy();

      const sock2 = net.connect(handle.socksPort, "127.0.0.1");
      sock2.write(Buffer.from([0x05, 0x01, 0x00]));
      await readExactly(sock2, 2);
      const host = Buffer.from("example.com", "utf8");
      const req2 = Buffer.concat([
        Buffer.from([0x05, 0x01, 0x00, 0x03, host.length]),
        host,
        Buffer.from([0x01, 0xbb]),
      ]);
      sock2.write(req2);
      const rep2 = await readExactly(sock2, 10);
      assert.strictEqual(rep2[1], 0x02, "SOCKS5 to denied host must be refused");
      sock2.destroy();
    } finally {
      await handle.stop();
    }
  });

  it("startPolicyProxy returns undefined when networkAccess is false", async () => {
    const handle = await startPolicyProxy(makePolicy({ networkAccess: false }));
    assert.strictEqual(handle, undefined);
  });
});

/* ---------------- policy temp file lifecycle ---------------- */

describe("sandboxService: policy temp file", () => {
  it("writes 0600 and deletes cleanly (Cursor parity)", () => {
    const file = writePolicyTempFile(makePolicy());
    try {
      const st = fs.statSync(file);
      assert.strictEqual(st.mode & 0o777, 0o600);
      const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as UnifiedPolicy;
      assert.strictEqual(parsed.sandbox.type, "workspace_readwrite");
    } finally {
      deletePolicyTempFile(file);
    }
    assert.ok(!fs.existsSync(file), "policy file must be gone after delete");
    deletePolicyTempFile(file); // second delete must not throw
  });
});

/* ---------------- spawnSandboxed ---------------- */

function runToCompletion(
  child: import("node:child_process").ChildProcess,
  stdout: NodeJS.WritableStream,
): Promise<{ code: number | null; out: string }> {
  return new Promise((resolve) => {
    let out = "";
    child.stdout?.on("data", (d: Buffer) => (out += d.toString()));
    child.on("close", (code) => resolve({ code, out }));
    child.on("error", () => resolve({ code: -1, out }));
    void stdout;
  });
}

describe("sandboxService: spawnSandboxed", () => {
  it("insecure_none spawns directly and reports unsandboxed (honest escape hatch)", async () => {
    const { child, sandboxed, enforcement } = spawnSandboxed(
      ["node", "-e", "process.stdout.write('hi')"],
      makePolicy({ type: "insecure_none" }),
      { workspaceDir: os.tmpdir(), stdio: ["ignore", "pipe", "pipe"] },
    );
    const { code, out } = await runToCompletion(child, process.stdout);
    assert.strictEqual(code, 0);
    assert.strictEqual(out, "hi");
    assert.strictEqual(sandboxed, false);
    assert.strictEqual(enforcement, "none");
  });

  it("readBoundary=workspace rejects executables outside the workspace (Cursor error shape)", () => {
    // An executable in /tmp: outside the workspace AND outside the system
    // runtime dirs (/bin, /usr/bin, ...) → must be rejected.
    const outside = path.join(os.tmpdir(), `sb-outside-exe-${process.pid}.sh`);
    fs.writeFileSync(outside, "#!/bin/sh\necho hi\n");
    fs.chmodSync(outside, 0o755);
    try {
      assert.throws(
        () =>
          spawnSandboxed([outside], makePolicy({ readBoundary: "workspace" }), {
            workspaceDir: fs.mkdtempSync(path.join(os.tmpdir(), "sb-ws-")),
            stdio: "ignore",
          }),
        /outside the Workspace read boundary/,
      );
    } finally {
      fs.unlinkSync(outside);
    }
  });

  it("readBoundary=workspace allows executables in system runtime dirs", () => {
    // /bin/sh is a supported system runtime directory (documented in
    // sandboxService.ts) — the boundary check must pass, i.e. spawn reaches
    // a real backend instead of throwing "outside the Workspace read boundary".
    const { child, backend } = spawnSandboxed(
      ["/bin/sh", "-c", "echo hi"],
      makePolicy({ readBoundary: "workspace" }),
      {
        workspaceDir: fs.mkdtempSync(path.join(os.tmpdir(), "sb-ws-")),
        stdio: "ignore",
      },
    );
    child.kill("SIGKILL");
    assert.ok(
      backend === "namespaces" || backend === "bubblewrap",
      `expected a real backend, got ${backend}`,
    );
  });

  it("unsupported backend without opt-in throws an honest error (never fakes a sandbox)", () => {
    const fakeProbe = {
      requested: "auto" as const,
      backend: "unsupported" as const,
      supported: false,
      enforcement: "none" as const,
      reason: "unit-test injected",
      landlockStatus: "not_enforced" as const,
    };
    assert.throws(
      () => spawnSandboxed(["node", "-e", "1"], makePolicy(), { workspaceDir: os.tmpdir(), probe: fakeProbe, stdio: "ignore" }),
      /sandbox unsupported/,
    );
  });

  it("allowRestrictedEnv runs scrubbed-env-only and reports sandboxed=false", async () => {
    const fakeProbe = {
      requested: "auto" as const,
      backend: "unsupported" as const,
      supported: false,
      enforcement: "none" as const,
      reason: "unit-test injected",
      landlockStatus: "not_enforced" as const,
    };
    const saved = process.env["SSH_AUTH_SOCK"];
    process.env["SSH_AUTH_SOCK"] = "/tmp/fake-agent.sock";
    try {
      const { child, sandboxed, enforcement, backend } = spawnSandboxed(
        ["node", "-e", "process.stdout.write(String(process.env.SSH_AUTH_SOCK))"],
        makePolicy(),
        { workspaceDir: os.tmpdir(), probe: fakeProbe, allowRestrictedEnv: true, stdio: ["ignore", "pipe", "pipe"] },
      );
      const { out } = await runToCompletion(child, process.stdout);
      assert.strictEqual(sandboxed, false);
      assert.strictEqual(enforcement, "none");
      assert.strictEqual(backend, "restricted-env");
      assert.strictEqual(out, "undefined", "SSH_AUTH_SOCK must be scrubbed");
    } finally {
      if (saved === undefined) delete process.env["SSH_AUTH_SOCK"];
      else process.env["SSH_AUTH_SOCK"] = saved;
    }
  });

  it("child env carries Cursor's verbatim CURSOR_* sandbox vars (DEV-GAPS-93C)", async () => {
    // GAPS-86 PARTIAL: the spawner only set IDE_* names; Cursor's documented
    // contract (docs/agent/security/run-modes) is CURSOR_SANDBOX /
    // CURSOR_ORIG_UID / CURSOR_ORIG_GID / CURSOR_SANDBOX_LANDLOCK_STATUS.
    // The restricted-env path runs buildSandboxEnv without any isolation
    // primitive, so it works on every machine; values must mirror IDE_*.
    const fakeProbe = {
      requested: "auto" as const,
      backend: "unsupported" as const,
      supported: false,
      enforcement: "none" as const,
      reason: "unit-test injected",
      landlockStatus: "not_enforced" as const,
    };
    const script = [
      "console.log('CS=' + process.env.CURSOR_SANDBOX);",
      "console.log('CSL=' + process.env.CURSOR_SANDBOX_LANDLOCK_STATUS);",
      "console.log('CUID=' + process.env.CURSOR_ORIG_UID);",
      "console.log('CGID=' + process.env.CURSOR_ORIG_GID);",
      "console.log('IS=' + process.env.IDE_SANDBOX);",
      "console.log('ISL=' + process.env.IDE_SANDBOX_LANDLOCK_STATUS);",
    ].join("");
    const { child } = spawnSandboxed(["node", "-e", script], makePolicy(), {
      workspaceDir: os.tmpdir(),
      probe: fakeProbe,
      allowRestrictedEnv: true,
      stdio: ["ignore", "pipe", "pipe"],
      // A caller must NOT be able to spoof the spawner-owned CURSOR_SANDBOX*
      // vars (Cursor agent-exec filters /CURSOR_SANDBOX/i from user env).
      env: { CURSOR_SANDBOX_LANDLOCK_STATUS: "fully_enforced", CURSOR_SANDBOX: "spoofed" },
    });
    const { code, out } = await runToCompletion(child, process.stdout);
    assert.strictEqual(code, 0);
    assert.ok(out.includes("CS=native"), `CURSOR_SANDBOX must be native, got: ${out}`);
    assert.ok(
      out.includes("CSL=not_enforced"),
      `CURSOR_SANDBOX_LANDLOCK_STATUS must be the probe value (spoof attempt ignored), got: ${out}`,
    );
    if (typeof process.getuid === "function") {
      assert.ok(out.includes(`CUID=${process.getuid()}`), `CURSOR_ORIG_UID mismatch, got: ${out}`);
    }
    if (typeof process.getgid === "function") {
      assert.ok(out.includes(`CGID=${process.getgid()}`), `CURSOR_ORIG_GID mismatch, got: ${out}`);
    }
    assert.ok(out.includes("IS=native"), `IDE_SANDBOX kept for compat, got: ${out}`);
    assert.ok(out.includes("ISL=not_enforced"), `IDE_SANDBOX_LANDLOCK_STATUS kept, got: ${out}`);
  });

  it("filterSandboxOwnedEnv drops only /CURSOR_SANDBOX/i keys", () => {
    const filtered = filterSandboxOwnedEnv({
      CURSOR_SANDBOX: "x",
      cursor_sandbox_debug: "x",
      CURSOR_SANDBOX_LANDLOCK_STATUS: "x",
      CURSOR_ORIG_UID: "123",
      PATH: "/usr/bin",
    });
    assert.deepStrictEqual(filtered, { CURSOR_ORIG_UID: "123", PATH: "/usr/bin" });
  });

  it("namespaces backend: REAL network isolation (connect must fail) + IDE_SANDBOX=native", async function () {
    const probe = resolveLinuxBackend("auto");
    if (probe.backend !== "namespaces") {
      console.log(`[skip] namespaces test: backend is ${probe.backend} on this machine`);
      return;
    }
    const script = [
      "const net=require('net');",
      "console.log('SB='+process.env.IDE_SANDBOX);",
      "console.log('ST='+process.env.IDE_SANDBOX_LANDLOCK_STATUS);",
      "const s=net.connect(80,'93.184.216.34');",
      "s.on('connect',()=>{console.log('CONNECTED');process.exit(2)});",
      "s.on('error',(e)=>{console.log('ERR:'+e.code);process.exit(0)});",
      "setTimeout(()=>{console.log('TIMEOUT');process.exit(3)},8000);",
    ].join("");
    const { child, sandboxed, enforcement, backend } = spawnSandboxed(
      ["node", "-e", script],
      makePolicy(),
      { workspaceDir: os.tmpdir(), stdio: ["ignore", "pipe", "pipe"] },
    );
    const { code, out } = await runToCompletion(child, process.stdout);
    assert.strictEqual(backend, "namespaces");
    assert.strictEqual(sandboxed, true, "namespaces gives partial-but-real isolation");
    assert.strictEqual(enforcement, "partial");
    assert.ok(out.includes("SB=native"), `child env must carry IDE_SANDBOX=native, got: ${out}`);
    assert.ok(out.includes("ST=namespaces-partial"), `status must be honest, got: ${out}`);
    assert.ok(out.includes("ERR:ENETUNREACH"), `outbound connect must fail ENETUNREACH, got: ${out}`);
    assert.strictEqual(code, 0);
  });
});

describe("sandboxService: preflight", () => {
  it("returns a well-formed result", async () => {
    const p = await preflight();
    assert.strictEqual(typeof p.supported, "boolean");
    assert.ok(["full", "partial", "none"].includes(p.enforcement));
    assert.ok(typeof p.reason === "string" && p.reason.length > 0);
  });
});
