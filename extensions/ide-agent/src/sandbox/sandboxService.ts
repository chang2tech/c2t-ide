/**
 * SandboxService — JS orchestration for agent sandboxing (Cursor parity).
 *
 * Mirrors the `cursorsandbox` split: policy build → spawn → approval gate,
 * with the native helper replaced by the landlock.ts backend layer until
 * `idesandbox` (spec Phase 2) exists.
 *
 * Env contract (Cursor parity): the sandboxed child carries BOTH our
 * IDE_* names and Cursor's verbatim CURSOR_* names (same values), because
 * user scripts detect sandboxing via the documented CURSOR_* contract
 * (cursor.com/docs/agent/security/run-modes: CURSOR_SANDBOX,
 * CURSOR_ORIG_UID, CURSOR_ORIG_GID, CURSOR_SANDBOX_LANDLOCK_STATUS):
 *   - spawner sets IDE_SANDBOX=native and CURSOR_SANDBOX=native on the
 *     sandboxed child (Cursor evidence: cursor-agent-exec main.js spawn
 *     path sets `CURSOR_SANDBOX:"native"` on Linux; the native helper's
 *     strings set CURSOR_SANDBOX_LANDLOCK_STATUS and CURSOR_ORIG_UID /
 *     CURSOR_ORIG_GID next to /proc/self/uid_map handling)
 *   - we report IDE_SANDBOX_LANDLOCK_STATUS and
 *     CURSOR_SANDBOX_LANDLOCK_STATUS=fully_enforced|bubblewrap|
 *     namespaces-partial|restricted|not_enforced
 *   - spawner may set IDE_SANDBOX_LINUX_BACKEND=auto|landlock|bubblewrap
 *
 * HONESTY CONTRACT: `spawnSandboxed` NEVER claims isolation it does not have.
 * The returned `sandboxed` flag and `enforcement` level always describe what
 * the resolved backend really enforces. `enforcement: "none"` means the
 * command ran with a scrubbed environment only — the caller (UI) must render
 * "runs outside sandbox" for it, per Cursor's docs promise.
 */

import * as childProcess from "node:child_process";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as http from "node:http";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import {
  applyNetworkPolicyStrict,
  planFilesystemAccess,
  SSRF_DENY_DEFAULTS,
  validateUnifiedPolicy,
  type NetworkPolicy,
  type UnifiedPolicy,
} from "./policy.js";
import {
  findExecutable,
  LINUX_BACKEND_ENV,
  readBackendPreference,
  resolveLinuxBackend,
  spawnBackend,
  type BackendProbe,
  type EnforcementLevel,
  type SandboxBackend,
} from "./landlock.js";

export const ENV_SANDBOX = "IDE_SANDBOX";
export const ENV_LANDLOCK_STATUS = "IDE_SANDBOX_LANDLOCK_STATUS";
export const ENV_ORIG_UID = "IDE_ORIG_UID";
export const ENV_ORIG_GID = "IDE_ORIG_GID";

/**
 * Cursor's verbatim env names (docs/agent/security/run-modes). Injected
 * alongside the IDE_* names above with identical values so scripts that
 * follow Cursor's documented `${CURSOR_ORIG_UID:-$(id -u)}` pattern work
 * unchanged. DEV-GAPS-93C (closes the GAPS-86 PARTIAL: only IDE_* was set).
 */
export const ENV_CURSOR_SANDBOX = "CURSOR_SANDBOX";
export const ENV_CURSOR_LANDLOCK_STATUS = "CURSOR_SANDBOX_LANDLOCK_STATUS";
export const ENV_CURSOR_ORIG_UID = "CURSOR_ORIG_UID";
export const ENV_CURSOR_ORIG_GID = "CURSOR_ORIG_GID";

/**
 * User-supplied env may not override the sandbox marker vars. Mirrors
 * Cursor's agent-exec filter (main.js @5881599): request-scoped env keys
 * matching /CURSOR_SANDBOX/i are dropped (wt()) because the spawner owns
 * them. Applied to `opts.env` in buildSandboxEnv / the insecure_none path.
 */
export const SANDBOX_ENV_KEY_FILTER = /CURSOR_SANDBOX/i;

/* ------------------------------------------------------------------ */
/* Debug logging (DEV-GAPS-9A: composer.toggleSandboxDebugLogging)      */
/* ------------------------------------------------------------------ */

/**
 * Verbose sandbox debug logging, toggled by the `composer.toggleSandboxDebugLogging`
 * command. Source of truth is the core storage key `sandboxDebugOutputDir`
 * (Cursor 3.25.9, workbench.desktop.main.js @29974171); the core action keeps
 * this extension-host flag in sync via the `ide.toggleSandboxDebugLogging`
 * bridge, which calls `setSandboxDebugLogging`.
 * Command-ID evidence: Cursor 3.25.6 workbench.desktop.main.js /
 * workbench.glass.main.js (feature composer-plan-accept, DEEP-DIG-A 2026-10-19).
 * The minified binary does not reveal what "verbose" covers, so the coverage
 * below is our own choice (UNKNOWN parity).
 *
 * LIMITATION: only the spawn path (`spawnSandboxed`) emits verbose lines
 * today. Per-decision network-policy evaluation (NetworkProxy) stays quiet.
 * The flag is module-level so any sandbox consumer can gate extra logging
 * on `isSandboxDebugLogging()`.
 */
let sandboxDebugLogging = false;

/** Enable or disable verbose sandbox debug logging. */
export function setSandboxDebugLogging(enabled: boolean): void {
  sandboxDebugLogging = enabled;
  // Log unconditionally here (not gated) so the toggle itself is always visible.
  process.stderr.write(`[sandbox] debug logging ${enabled ? "enabled" : "disabled"}\n`);
}

/** True when verbose sandbox debug logging is on. */
export function isSandboxDebugLogging(): boolean {
  return sandboxDebugLogging;
}

/** Verbose line; no-op unless the debug flag is on. */
export function logSandboxDebug(message: string): void {
  if (sandboxDebugLogging) {
    process.stderr.write(`[sandbox:debug] ${message}\n`);
  }
}

/**
 * 24h approval TTL — UNKNOWN parity (WORKER-GAPS-15B adversarial re-check
 * 2026-10-20). The earlier claim "OBSERVED agent-exec (`864e5` ms)" did not
 * survive re-verification: `864e5` occurs 11× in workbench.glass.main.js
 * (3.25.9, e.g. offsets 1049347 `orphan_max_age_ms` schema bound, 27595203
 * cloud-handoff upsell throttle, plus date/DST/react-query constants) but in
 * NO approval context; `approval_ttl`/`approvalTtl`/`86400000` have zero hits
 * in 3.25.6 and 3.25.9. The binary's only approval-expiry mechanism is
 * server-driven (`_armCloudAgentApprovalExpiry` reads per-approval
 * `expiresAtMs`) — there is no hardcoded 24h approval TTL in the client.
 * Kept as an internal guard: stale pending approvals are swept so the
 * approval store cannot grow unbounded.
 */
export const APPROVAL_TTL_MS = 86_400_000;

/* ------------------------------------------------------------------ */
/* Preflight                                                           */
/* ------------------------------------------------------------------ */

export interface PreflightResult {
  /** false = "exit 2" equivalent: sandboxing unsupported on this machine. */
  readonly supported: boolean;
  readonly backend: SandboxBackend;
  readonly enforcement: EnforcementLevel;
  readonly reason: string;
  readonly landlockStatus: BackendProbe["landlockStatus"];
  readonly bwrapPath?: string;
}

/** Preflight once at startup (Cursor: `--preflight-only`, 15s timeout). */
export async function preflight(): Promise<PreflightResult> {
  const probe = resolveLinuxBackend();
  return {
    supported: probe.supported,
    backend: probe.backend,
    enforcement: probe.enforcement,
    reason: probe.reason,
    landlockStatus: probe.landlockStatus,
    bwrapPath: probe.bwrapPath,
  };
}

/* ------------------------------------------------------------------ */
/* Policy temp file (0600, deleted after use — Cursor parity)           */
/* ------------------------------------------------------------------ */

/** Write the unified policy to a 0600 temp file. Returns the file path. */
export function writePolicyTempFile(policy: UnifiedPolicy): string {
  const name = `sandbox-policy-${crypto.randomBytes(8).toString("hex")}.json`;
  const file = path.join(os.tmpdir(), name);
  fs.writeFileSync(file, JSON.stringify(policy), { mode: 0o600 });
  return file;
}

/** Delete the policy temp file. Never throws (ENOENT is fine). */
export function deletePolicyTempFile(file: string): void {
  try {
    fs.unlinkSync(file);
  } catch {
    // already gone — the helper may have deleted it first
  }
}

/* ------------------------------------------------------------------ */
/* SmartModeClassifier stand-in                                        */
/*                                                                     */
/* Port of the SuggestedSandboxMode proto enum (OBSERVED agent-exec).  */
/* The real SmartModeClassifier is server-side ML; this rules engine   */
/* decides the obvious cases and routes the rest to the approval gate  */
/* (docs/rea/deep-sandbox.md §4.1). `setSandboxClassifier` injects the  */
/* real classifier — the seam where ide-code's policy-engine           */
/* ApprovalGate plugs in (same DANGEROUS/READONLY_SAFE vocabulary).    */
/* ------------------------------------------------------------------ */

export type SandboxSuggestion = "SANDBOX" | "NO_SANDBOX" | "UNDETERMINED";

export interface SandboxClassifier {
  suggest(command: string, workspaceDir: string): SandboxSuggestion;
}

const DANGEROUS = [
  /^(rm|dd|mkfs|shutdown|reboot|halt|poweroff)\b/,
  /:\(\)\s*\{/, // fork bomb
  /\bmv\b.*\s\/$/,
  /chmod\s+-R\s+777/,
  /curl.*\|\s*(sh|bash)/,
  /wget.*\|\s*(sh|bash)/,
  /\|\s*&?\s*(sh|bash|zsh|dash|ksh|fish)\b/, // pipe-to-shell
];

const HAS_SHELL_EXPANSION = /(\$\(|`|\$\{|\$\[|<\()/;

const READONLY_SAFE = /^(ls|pwd|echo|cat|head|tail|wc|date|whoami|which|git\s+(status|log|diff|branch))\b/;

function rulesClassifier(command: string): SandboxSuggestion {
  const cmd = command.trim();
  if (DANGEROUS.some((re) => re.test(cmd))) return "NO_SANDBOX";
  if (HAS_SHELL_EXPANSION.test(cmd)) return "NO_SANDBOX"; // needs human review
  if (READONLY_SAFE.test(cmd)) return "SANDBOX";
  return "UNDETERMINED";
}

let activeClassifier: SandboxClassifier = { suggest: (command) => rulesClassifier(command) };

/** Inject the real classifier (e.g. policy-engine ApprovalGate adapter). */
export function setSandboxClassifier(classifier: SandboxClassifier): void {
  activeClassifier = classifier;
}

export function resetSandboxClassifier(): void {
  activeClassifier = { suggest: (command) => rulesClassifier(command) };
}

export function suggestSandboxMode(command: string, workspaceDir: string): SandboxSuggestion {
  return activeClassifier.suggest(command, workspaceDir);
}

/* ------------------------------------------------------------------ */
/* Approval store — pending requests with 24h TTL (Cursor parity)      */
/* ------------------------------------------------------------------ */

export interface ApprovalRequest {
  readonly id: string;
  readonly command: string;
  readonly workspaceDir: string;
  readonly detail: string;
  readonly createdAt: number;
  readonly expiresAt: number;
}

export type ApprovalCheck = "approved" | "denied" | "pending" | "expired" | "none";

export class SandboxApprovalStore {
  private readonly pending = new Map<string, ApprovalRequest & { decision?: boolean }>();

  constructor(private readonly ttlMs: number = APPROVAL_TTL_MS) {}

  private key(command: string, workspaceDir: string): string {
    return crypto.createHash("sha256").update(`${workspaceDir}\0${command}`).digest("hex");
  }

  requestApproval(command: string, workspaceDir: string, detail: string): ApprovalRequest {
    const k = this.key(command, workspaceDir);
    const existing = this.pending.get(k);
    if (existing && Date.now() < existing.expiresAt) return existing;
    const now = Date.now();
    const req: ApprovalRequest = {
      id: crypto.randomBytes(8).toString("hex"),
      command,
      workspaceDir,
      detail,
      createdAt: now,
      expiresAt: now + this.ttlMs,
    };
    this.pending.set(k, req);
    return req;
  }

  resolveApproval(id: string, approved: boolean): boolean {
    for (const [k, req] of this.pending) {
      if (req.id === id) {
        this.pending.set(k, { ...req, decision: approved });
        return true;
      }
    }
    return false;
  }

  checkApproval(command: string, workspaceDir: string): ApprovalCheck {
    const req = this.pending.get(this.key(command, workspaceDir));
    if (!req) return "none";
    if (Date.now() >= req.expiresAt) return "expired";
    if (req.decision === true) return "approved";
    if (req.decision === false) return "denied";
    return "pending";
  }

  /** Drop expired entries. Returns the number removed. */
  cleanupExpiredApprovals(): number {
    const now = Date.now();
    let removed = 0;
    for (const [k, req] of this.pending) {
      if (now >= req.expiresAt) {
        this.pending.delete(k);
        removed++;
      }
    }
    return removed;
  }

  get size(): number {
    return this.pending.size;
  }
}

/* ------------------------------------------------------------------ */
/* Network policy matching (exact | wildcard | CIDR)                    */
/* ------------------------------------------------------------------ */

function ipv4ToInt(ip: string): number | undefined {
  const parts = ip.split(".");
  if (parts.length !== 4) return undefined;
  let n = 0;
  for (const p of parts) {
    if (!/^\d+$/.test(p)) return undefined;
    const v = Number(p);
    if (v < 0 || v > 255) return undefined;
    n = (n << 8) + v;
  }
  return n >>> 0;
}

function matchCidrV4(pattern: string, host: string): boolean {
  const slash = pattern.indexOf("/");
  if (slash < 0) return false;
  const base = ipv4ToInt(pattern.slice(0, slash));
  const bits = Number(pattern.slice(slash + 1));
  const addr = ipv4ToInt(host);
  if (base === undefined || addr === undefined || !Number.isInteger(bits) || bits < 0 || bits > 32)
    return false;
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return (base & mask) === (addr & mask);
}

function ipv6ToBigInt(ip: string): bigint | undefined {
  // Expand :: shorthand, then parse 8 hextets.
  try {
    const halves = ip.split("::");
    if (halves.length > 2) return undefined;
    const head = halves[0] === "" ? [] : halves[0].split(":");
    const tail = halves.length === 2 ? (halves[1] === "" ? [] : halves[1].split(":")) : [];
    const missing = 8 - head.length - tail.length;
    if (missing < 0) return undefined;
    const groups = [...head, ...Array<string>(missing).fill("0"), ...tail];
    if (groups.length !== 8) return undefined;
    let n = 0n;
    for (const g of groups) {
      if (!/^[0-9a-fA-F]{1,4}$/.test(g)) return undefined;
      n = (n << 16n) + BigInt(parseInt(g, 16));
    }
    return n;
  } catch {
    return undefined;
  }
}

function matchCidrV6(pattern: string, host: string): boolean {
  const slash = pattern.indexOf("/");
  if (slash < 0) return false;
  const base = ipv6ToBigInt(pattern.slice(0, slash));
  const bits = Number(pattern.slice(slash + 1));
  const addr = ipv6ToBigInt(host);
  if (base === undefined || addr === undefined || !Number.isInteger(bits) || bits < 0 || bits > 128)
    return false;
  const mask = bits === 0 ? 0n : ((1n << 128n) - 1n) ^ ((1n << BigInt(128 - bits)) - 1n);
  return (base & mask) === (addr & mask);
}

function isLocalhostAlias(host: string): boolean {
  const h = host.toLowerCase();
  return h === "localhost" || h === "127.0.0.1" || h === "::1";
}

/** One allow/deny entry: exact domain, "*.wildcard", or CIDR. */
export function matchNetworkEntry(pattern: string, host: string): boolean {
  const p = pattern.toLowerCase().trim();
  const h = host.toLowerCase().trim();
  if (p === h) return true;
  // "localhost" in a list also covers its loopback addresses (documented).
  if (p === "localhost" && isLocalhostAlias(h)) return true;
  if (p.startsWith("*.")) {
    const suffix = p.slice(1); // ".example.com"
    return h.endsWith(suffix) && h.length > suffix.length;
  }
  if (p.includes("/")) {
    if (net.isIPv4(h) && net.isIPv4(p.split("/")[0])) return matchCidrV4(p, h);
    if (net.isIPv6(h)) return matchCidrV6(p, h);
    return false;
  }
  return false;
}

export type NetworkDecision = "allow" | "deny";

export interface NetworkDecisionDetail {
  readonly decision: NetworkDecision;
  /** which list matched, or "default" */
  readonly reason: string;
}

/**
 * Decide a host:port against the network policy. Deny ALWAYS beats allow
 * (OBSERVED). SSRF defaults are merged defensively even if the policy
 * builder didn't add them.
 */
export function decideNetworkAccess(
  policy: NetworkPolicy | undefined,
  host: string,
  port: number,
): NetworkDecisionDetail {
  void port;
  const effective: NetworkPolicy = policy ?? { version: 1, default: "deny", allow: [], deny: [] };
  const deny = [...SSRF_DENY_DEFAULTS, ...effective.deny];
  if (deny.some((entry) => matchNetworkEntry(entry, host)))
    return { decision: "deny", reason: "deny_list" };
  if (effective.allow.some((entry) => matchNetworkEntry(entry, host)))
    return { decision: "allow", reason: "allow_list" };
  return effective.default === "allow"
    ? { decision: "allow", reason: "default" }
    : { decision: "deny", reason: "default" };
}

/* ------------------------------------------------------------------ */
/* Network forwarder — HTTP CONNECT + SOCKS5 (Cursor: run-proxy)         */
/*                                                                     */
/* Transparent proxy the sandboxed child uses via http_proxy /          */
/* https_proxy / all_proxy. Decision log uses sha256 hashes, never     */
/* plaintext hosts/URLs (privacy — OBSERVED in cursorsandbox logs).    */
/*                                                                     */
/* KNOWN GAP (honest): no per-connection client auth between sandbox   */
/* and proxy — it binds 127.0.0.1 ephemeral ports, same as Cursor's    */
/* forwarder. Any local process could use it while it lives.           */
/* ------------------------------------------------------------------ */

export interface ProxyHandle {
  readonly httpPort: number;
  readonly socksPort: number;
  readonly sessionId: string;
  readonly decisionLogPath?: string;
  stop(): Promise<void>;
}

const sha256hex = (s: string): string => crypto.createHash("sha256").update(s).digest("hex");

export class NetworkProxy {
  private httpServer?: http.Server;
  private socksServer?: net.Server;
  private logStream?: fs.WriteStream;

  constructor(
    private readonly policy: NetworkPolicy | undefined,
    private readonly opts: { decisionLogPath?: string; sessionId?: string } = {},
  ) {}

  get sessionId(): string {
    return this.opts.sessionId ?? "sbx-unset";
  }

  private log(protocol: string, host: string, port: number, decision: NetworkDecisionDetail): void {
    if (!this.logStream) return;
    const entry = {
      ts: new Date().toISOString(),
      sandbox_metadata: { session_id: this.sessionId },
      protocol,
      host_hash: sha256hex(host),
      port,
      decision: decision.decision,
      reason: decision.reason,
    };
    this.logStream.write(JSON.stringify(entry) + "\n");
  }

  async start(): Promise<ProxyHandle> {
    const sessionId = this.opts.sessionId ?? `sbx-${process.pid}-${crypto.randomBytes(4).toString("hex")}`;
    const decisionLogPath = this.opts.decisionLogPath;
    if (decisionLogPath) {
      fs.mkdirSync(path.dirname(decisionLogPath), { recursive: true });
      this.logStream = fs.createWriteStream(decisionLogPath, { flags: "a", mode: 0o600 });
    }
    const self = this;

    // --- HTTP: CONNECT tunneling + plain absolute-URI forwarding ---
    const httpServer = http.createServer();
    httpServer.on("connect", (req, clientSocket, head) => {
      const [host, portStr] = (req.url ?? "").split(":");
      const port = Number(portStr ?? "443");
      const decision = decideNetworkAccess(self.policy, host ?? "", port);
      self.log("connect", host ?? "", port, decision);
      if (decision.decision === "deny" || !host) {
        clientSocket.write("HTTP/1.1 403 Blocked by sandbox network policy\r\n\r\n");
        clientSocket.destroy();
        return;
      }
      const upstream = net.connect(port, host, () => {
        clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        if (head.length > 0) upstream.write(head);
        clientSocket.pipe(upstream).pipe(clientSocket);
      });
      upstream.on("error", () => {
        clientSocket.write("HTTP/1.1 502 Bad Gateway\r\n\r\n");
        clientSocket.destroy();
      });
    });
    httpServer.on("request", (req, res) => {
      // Plain HTTP proxy request (absolute URI form).
      let url: URL;
      try {
        url = new URL(req.url ?? "");
      } catch {
        res.writeHead(400).end("bad request");
        return;
      }
      const decision = decideNetworkAccess(self.policy, url.hostname, Number(url.port || "80"));
      self.log("http", url.hostname, Number(url.port || "80"), decision);
      if (decision.decision === "deny") {
        res.writeHead(403).end("Blocked by sandbox network policy");
        return;
      }
      const upstream = http.request(
        {
          host: url.hostname,
          port: Number(url.port || "80"),
          path: url.pathname + url.search,
          method: req.method,
          headers: req.headers,
        },
        (upRes) => {
          res.writeHead(upRes.statusCode ?? 502, upRes.headers);
          upRes.pipe(res);
        },
      );
      upstream.on("error", () => res.writeHead(502).end());
      req.pipe(upstream);
    });

    // --- SOCKS5: no-auth, CONNECT only ---
    const socksServer = net.createServer((socket) => {
      socket.once("data", (greeting: Buffer) => {
        if (greeting[0] !== 0x05) return socket.destroy();
        socket.write(Buffer.from([0x05, 0x00])); // no auth
        socket.once("data", (req: Buffer) => {
          if (req[0] !== 0x05 || req[1] !== 0x01) return socket.destroy();
          let host = "";
          let offset = 4;
          const atyp = req[3];
          if (atyp === 0x01) {
            host = `${req[4]}.${req[5]}.${req[6]}.${req[7]}`;
            offset = 8;
          } else if (atyp === 0x03) {
            const len = req[4];
            host = req.subarray(5, 5 + len).toString("utf8");
            offset = 5 + len;
          } else if (atyp === 0x04) {
            host = ip6ToString(req.subarray(4, 20));
            offset = 20;
          } else {
            socket.write(Buffer.from([0x05, 0x08, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
            return socket.destroy();
          }
          const port = req.readUInt16BE(offset);
          const decision = decideNetworkAccess(self.policy, host, port);
          self.log("socks5", host, port, decision);
          if (decision.decision === "deny") {
            socket.write(Buffer.from([0x05, 0x02, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
            return socket.destroy();
          }
          const upstream = net.connect(port, host, () => {
            socket.write(Buffer.from([0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
            socket.pipe(upstream).pipe(socket);
          });
          upstream.on("error", () => {
            socket.write(Buffer.from([0x05, 0x05, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
            socket.destroy();
          });
        });
      });
    });

    await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
    await new Promise<void>((resolve) => socksServer.listen(0, "127.0.0.1", resolve));
    this.httpServer = httpServer;
    this.socksServer = socksServer;
    const httpPort = (httpServer.address() as net.AddressInfo).port;
    const socksPort = (socksServer.address() as net.AddressInfo).port;

    // Rebind session id now that it is final (log() reads via closure below).
    const handle: ProxyHandle = {
      httpPort,
      socksPort,
      sessionId,
      decisionLogPath,
      stop: async () => {
        await new Promise<void>((r) => httpServer.close(() => r()));
        await new Promise<void>((r) => socksServer.close(() => r()));
        self.logStream?.end();
        self.logStream = undefined;
      },
    };
    // Patch the session id used by log(): recreate opts reference.
    (this.opts as { sessionId?: string }).sessionId = sessionId;
    return handle;
  }
}

function ip6ToString(buf: Buffer): string {
  const groups: string[] = [];
  for (let i = 0; i < 16; i += 2) groups.push(buf.readUInt16BE(i).toString(16));
  return groups.join(":");
}

/* ------------------------------------------------------------------ */
/* spawnSandboxed                                                       */
/* ------------------------------------------------------------------ */

export interface SpawnOptions {
  readonly workspaceDir: string;
  /**
   * Last-resort fallback: run with a scrubbed environment and NO isolation.
   * The result reports sandboxed=false, enforcement="none" — the caller MUST
   * surface "runs outside sandbox". Never enable silently.
   */
  readonly allowRestrictedEnv?: boolean;
  /** Extra env for the child (already sanitized by the caller). */
  readonly env?: Record<string, string>;
  readonly stdio?: childProcess.StdioOptions;
  /** Pre-resolved backend (skips re-probing; tests use this). */
  readonly probe?: BackendProbe;
  /** Skip starting the network proxy (caller manages it). */
  readonly proxy?: ProxyHandle;
}

export interface SpawnedSandbox {
  readonly child: childProcess.ChildProcess;
  /** Cursor parity: the shell tool emits `sandboxed: bool` on start events. */
  readonly sandboxed: boolean;
  readonly enforcement: EnforcementLevel;
  readonly backend: SandboxBackend;
  readonly proxy?: ProxyHandle;
}

/** System directories executables may resolve from under readBoundary "workspace". */
const SYSTEM_RUNTIME_DIRS = ["/bin", "/usr/bin", "/usr/local/bin", "/sbin", "/usr/sbin"];

function resolveExecutable(argv0: string): string | undefined {
  if (argv0.includes(path.sep)) {
    try {
      const st = fs.statSync(argv0);
      if (st.isFile()) return fs.realpathSync(argv0);
    } catch {
      return undefined;
    }
    return undefined;
  }
  return findExecutable(argv0);
}

function isInside(child: string, parent: string): boolean {
  const rel = path.relative(parent, child);
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

/**
 * Spawn argv under the sandbox. argv[0] is the executable (no shell
 * interpretation — callers wanting a shell pass ["/bin/sh","-c",cmd]).
 *
 * Policy file lifecycle (Cursor parity): written 0600, read to build the
 * backend invocation, then DELETED — never left on disk.
 */
export function spawnSandboxed(
  argv: string[],
  policy: UnifiedPolicy,
  opts: SpawnOptions,
): SpawnedSandbox {
  const validation = validateUnifiedPolicy(policy);
  if (!validation.ok) {
    throw new Error(`invalid sandbox policy: ${validation.errors.join("; ")}`);
  }
  const effective = applyNetworkPolicyStrict(policy);
  if (argv.length === 0) throw new Error("spawnSandboxed: empty argv");
  logSandboxDebug(
    `spawn: argv=${JSON.stringify(argv)} sandbox.type=${effective.sandbox.type} ` +
      `readBoundary=${effective.sandbox.readBoundary} workspaceDir=${opts.workspaceDir}`,
  );

  // insecure_none: direct spawn, honestly unsandboxed (documented escape hatch).
  if (effective.sandbox.type === "insecure_none") {
    const child = childProcess.spawn(argv[0], argv.slice(1), {
      env: {
        ...process.env,
        ...filterSandboxOwnedEnv(opts.env ?? {}),
        [ENV_SANDBOX]: "native",
        [ENV_CURSOR_SANDBOX]: "native",
      },
      cwd: opts.workspaceDir,
      stdio: opts.stdio ?? "inherit",
    });
    return { child, sandboxed: false, enforcement: "none", backend: "unsupported" };
  }

  const workspaceDir = path.resolve(opts.workspaceDir);

  // readBoundary "workspace": the executable itself must resolve inside the
  // boundary (LIVE Cursor error shape preserved).
  if (effective.sandbox.readBoundary === "workspace") {
    const exe = resolveExecutable(argv[0]);
    const boundaryRoots = [
      workspaceDir,
      ...effective.sandbox.additionalReadwritePaths.map((p) => path.resolve(workspaceDir, p)),
      ...SYSTEM_RUNTIME_DIRS,
    ];
    if (!exe || !boundaryRoots.some((root) => isInside(exe, root) || exe === root)) {
      throw new Error(
        `Failed to plan Linux read access: IO error: command executable '${argv[0]}' is outside the Workspace read boundary`,
      );
    }
  }

  const probe = opts.probe ?? resolveLinuxBackend();
  if (probe.backend === "unsupported") {
    if (opts.allowRestrictedEnv) {
      // LAST RESORT, explicit opt-in only: scrubbed environment, zero
      // isolation. Reported honestly — sandboxed=false, enforcement="none".
      // This is NOT a sandbox; it only avoids leaking secrets via env.
      process.stderr.write(
        `[sandbox] WARNING: no isolation primitive on this machine (${probe.reason}); ` +
          `running UNSANDBOXED with a scrubbed environment (explicit allowRestrictedEnv)\n`,
      );
      const child = childProcess.spawn(argv[0], argv.slice(1), {
        env: buildSandboxEnv(effective, probe, opts),
        cwd: workspaceDir,
        stdio: opts.stdio ?? "inherit",
      });
      return { child, sandboxed: false, enforcement: "none", backend: "restricted-env" };
    }
    throw new Error(
      `sandbox unsupported on this machine and no fallback allowed: ${probe.reason} ` +
        `(install a root-owned bwrap and set ${LINUX_BACKEND_ENV}=bubblewrap, or pass allowRestrictedEnv for scrubbed-env-only execution)`,
    );
  }
  const useProbe = probe;
  logSandboxDebug(
    `spawn: backend=${useProbe.backend} supported=${useProbe.supported} ` +
      `enforcement=${useProbe.enforcement} reason=${useProbe.reason}`,
  );

  const plan = planFilesystemAccess(effective, { workspaceDir });

  // Policy file: write 0600 → build backend args → delete immediately.
  // (Cursor's binary deletes it after read; we delete after arg construction,
  // which is the last moment it is needed.)
  const policyFile = writePolicyTempFile(effective);
  let child: childProcess.ChildProcess;
  try {
    const sandboxEnv = buildSandboxEnv(effective, useProbe, opts);
    child = spawnBackend(useProbe, plan, {
      command: argv,
      env: sandboxEnv,
      cwd: workspaceDir,
      stdio: opts.stdio ?? "inherit",
    });
  } finally {
    deletePolicyTempFile(policyFile);
  }

  return {
    child,
    sandboxed: useProbe.enforcement !== "none",
    enforcement: useProbe.enforcement,
    backend: useProbe.backend,
    proxy: opts.proxy,
  };
}

/**
 * Start the network forwarder for a policy that allows network access.
 * Returns undefined when the policy denies network or the backend cannot
 * isolate it (restricted-env: proxy env vars would lie about enforcement).
 */
export async function startPolicyProxy(
  policy: UnifiedPolicy,
  opts: { sessionId?: string } = {},
): Promise<ProxyHandle | undefined> {
  if (!policy.sandbox.networkAccess) return undefined;
  const proxy = new NetworkProxy(policy.networkPolicy, {
    decisionLogPath: policy.networkPolicy?.logging?.decisionLogPath,
    sessionId: opts.sessionId,
  });
  return proxy.start();
}

/** Scrubbed environment for the sandboxed child (Cursor parity). */
function buildSandboxEnv(
  policy: UnifiedPolicy,
  probe: BackendProbe,
  opts: SpawnOptions,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined) continue;
    // Socket isolation: scrub agent-forwarding sockets (Cursor parity).
    if (k === "SSH_AUTH_SOCK") continue;
    // Never inherit the host's proxy config — we set our own or none.
    if (k.toLowerCase().endsWith("_proxy")) continue;
    env[k] = v;
  }
  env[ENV_SANDBOX] = "native";
  env[ENV_CURSOR_SANDBOX] = "native";
  env[ENV_LANDLOCK_STATUS] = probe.landlockStatus;
  env[ENV_CURSOR_LANDLOCK_STATUS] = probe.landlockStatus;
  try {
    if (typeof process.getuid === "function") {
      const uid = String(process.getuid());
      env[ENV_ORIG_UID] = uid;
      env[ENV_CURSOR_ORIG_UID] = uid;
    }
    if (typeof process.getgid === "function") {
      const gid = String(process.getgid());
      env[ENV_ORIG_GID] = gid;
      env[ENV_CURSOR_ORIG_GID] = gid;
    }
  } catch {
    // non-POSIX — skip
  }
  if (opts.proxy && policy.sandbox.networkAccess) {
    const proxyUrl = `http://127.0.0.1:${opts.proxy.httpPort}`;
    for (const name of ["http_proxy", "https_proxy", "all_proxy", "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY"]) {
      env[name] = proxyUrl;
    }
    env["no_proxy"] = "localhost,127.0.0.1,::1";
    env["NO_PROXY"] = "localhost,127.0.0.1,::1";
  }
  if (!policy.sandbox.networkAccess) {
    // Cursor parity: stub that fails with a helpful message (§4.2).
    env["GIT_SSH_COMMAND"] =
      "sh -c 'echo \"ide sandbox: git over SSH is not available with the current sandbox network policy. " +
      "Enable network access or add the git host to the network allowlist.\" >&2; exit 1'";
    env["CURSOR_SANDBOX_GIT_SSH_COMMAND"] = "1";
  }
  // KNOWN GAP (honest): when networkAccess=true, GIT_SSH_COMMAND is left alone
  // and ssh bypasses the proxy forwarder — Cursor tunnels it via git-ssh-dial.
  // Porting that requires the native helper; until then this is documented.
  Object.assign(env, filterSandboxOwnedEnv(opts.env ?? {}));
  return env;
}

/**
 * Copy caller-supplied env, dropping keys the spawner owns (any
 * /CURSOR_SANDBOX/i key — see SANDBOX_ENV_KEY_FILTER). Without this a
 * caller could spoof CURSOR_SANDBOX_LANDLOCK_STATUS=fully_enforced for a
 * child that is not enforced at all.
 */
export function filterSandboxOwnedEnv(
  env: Record<string, string>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    if (SANDBOX_ENV_KEY_FILTER.test(k)) continue;
    out[k] = v;
  }
  return out;
}

/** Re-export for consumers that only need probing knobs. */
export { LINUX_BACKEND_ENV, readBackendPreference };
