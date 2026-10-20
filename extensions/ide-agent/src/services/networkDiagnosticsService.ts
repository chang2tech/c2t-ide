/**
 * Network Diagnostics — Settings › Browser & Network parity
 * (feature `settings-network-diagnostics`, DEV-GAPS-93E).
 *
 * Cursor 3.25.9 evidence (workbench.desktop.main.js, all byte offsets in
 * that bundle, self-verified 2026-10-20):
 *  - Settings page `browser` (Browser & Network) has a "Network" section
 *    with a "Network Diagnostics" entry: label "Network Diagnostics"
 *    (@37493561 region), description "Check network connectivity to all
 *    Cursor services", button "Run Diagnostic" (@37493361) → while
 *    running: "Running Diagnostic" + spinner. Overall failure logs
 *    console.error("NetworkDiagnostics: run failed", e) (@37495503).
 *  - Check labels AOk (@37478081 region): dns:"DNS", http2:"HTTP/2",
 *    tls:"SSL", unary:"API", ping:"Ping", stream:"Chat", bidi:"Agent",
 *    marketplace:"Marketplace", auth:"Authentication",
 *    authUI:"Authentication UI", cursorTab:"Cursor Tab",
 *    agentEndpoint:"Agent Endpoint", downloads:"Downloads", cdn:"CDN".
 *    Label lookup JAr: `AOk[e] ?? e.toUpperCase()`.
 *  - Required Domains v6m (same region): domain — purpose pairs in
 *    REQUIRED_DOMAINS below; Copy Domains = `v6m.map(JOk).join("\n")`
 *    with JOk(e) = e.domain (@37495538) — domains only.
 *  - Warning class Ysn extends Error with name "Warning".
 *  - Status format MOk: undefined→"Not run", null→"Running",
 *    true→"Success", false→"Failed", Warning→`Warning: ${msg}`,
 *    Error→`Error: ${msg}`.
 *  - Copy format DOk(results, logs) (@37479188 region): header
 *    "Cursor Network Diagnostic Results", blank line, optional
 *    `FAILED (${n}): ${labels}` / `WARNINGS (${n}): ${labels}` lines
 *    (FAILED = Error but not Warning), blank line, then per check
 *    `${label}: ${status}` + "Logs:" + each log line indented 2 spaces
 *    + blank line; joined "\n" and trimmed.
 *  - Runner WOk: Promise.allSettled over Cce-wrapped checks in order
 *    dns, http2 (skipped when disableHttp2), tls, marketplace, unary,
 *    ping, stream, bidi, auth, authUI, cursorTab, agentEndpoint,
 *    downloads, cdn. Cce timeout _6m = 6e4 (60s): sink logs
 *    `Result: no response after ${l}s` and sets Error
 *    `No response after ${l}s` (l = _6m/1e3).
 *  - Sink (@37491637 region): console.log(`NetworkDiagnostics[${key}]:
 *    ${msg}`) and the stored log line is `[${ISO timestamp}] ${msg}`.
 *    Every check ends by logging `Result: ${result}`.
 *  - Initial state: { dns: undefined, ...WLa } where WLa lists every
 *    other key undefined; with disableHttp2 the http2 key is dropped
 *    (jOk = WLa minus http2).
 *  - dns check LOk: sources ["nodejs","system"] × 4 rounds of DNSLookup
 *    against the API host; first round logs `Host: ${host}` /
 *    `Servers: ${servers}`; each success logs `Resolved to ${address}
 *    in ${duration}ms`; duration > 1500 → Error
 *    `DNS lookup took ${duration}ms`; a missing response → Error
 *    "No response".
 *  - http2 check NOk: Http2Ping; pass only when protocol === "h2",
 *    else Error `Unexpected protocol: ${protocol}`.
 *  - tls check OOk: InspectTLSInfo; issuer containing "Google Trust
 *    Services" or "Amazon RSA" passes, else Warning
 *    `Encrypted traffic is being intercepted by unrecognized
 *    certificate: ${issuer}`.
 *  - marketplace check FOk: fetch of the gallery service root
 *    (default POk = "https://marketplace.cursorapi.com"); !ok → Error
 *    `Invalid response: HTTP ${status} ${statusText}...`.
 *  - auth / downloads / cdn (GLa): GET https://prod.authentication.
 *    cursor.sh / https://downloads.cursor.com / https://cursor-cdn.com;
 *    status < 500 passes; logs `Host:` / `Response: ${status}
 *    ${statusText} in ${ms}ms`.
 *  - authUI / cursorTab / agentEndpoint (jLa): DNS lookup of
 *    authenticator.cursor.sh / api3.cursor.sh / agent.api5.cursor.sh;
 *    logs `DNS lookup: ${host}`, `Resolved ${host} to ${address} in
 *    ${duration}ms`.
 *  - unary / ping / stream / bidi (BOk/UOk/$Ok/HOk) go through the
 *    aiserver v1 HealthService (deep-proto.md: Ping/Unary/Stream/
 *    StreamSSE/StreamBidi/StreamBidiPoll): ping sends payload "ping"
 *    5× and needs 5/5 with the last < 1000ms (`Incomplete response
 *    (${s}/${o.length} valid chunks)`, `Response took ${c}ms`); stream
 *    sends "foo", needs ≥5 chunks, first chunk > 2000ms → Error
 *    "Streaming responses are being buffered by a proxy in your
 *    network environment".
 *
 * Layer: Cursor runs these checks from the settings UI through its
 * everythingProvider local process + aiService. This fork has no
 * everythingProvider; the extension host is the layer with the same
 * Node network primitives (dns / http2 / tls / fetch), so the runner
 * lives here and is surfaced from Settings › Browser & Network via
 * the `ide.runNetworkDiagnostics` command.
 *
 * HONEST-DIVERGENCE (cloud): unary/ping/stream/bidi probe Cursor's
 * aiserver HealthService — a Cursor cloud backend this fork does not
 * have (the local engine speaks a different wire). Those four checks
 * are therefore only run when a health probe is injected
 * (`probes.health`); by default they are OMITTED from the results
 * (same omission mechanism the binary uses for http2 under
 * disableHttp2) and the command's report names them as skipped cloud
 * checks instead of fabricating a result.
 *
 * HONEST-DIVERGENCE (detail): the dns check collapses Cursor's
 * 2-source × 4-round loop into one lookup per source against the API
 * host (log lines and the 1500ms slow-lookup error are verbatim);
 * exact per-round repetition is UI pacing, not observable behavior.
 * The auth/downloads/cdn failure text reuses the marketplace
 * `Invalid response: HTTP …` shape; a distinct verbatim failure
 * string for GLa was not separately evidenced (UNKNOWN).
 */

import * as dnsPromises from "node:dns/promises";
import * as http2 from "node:http2";
import * as tls from "node:tls";

export type NetworkCheckKey =
  | "dns"
  | "http2"
  | "tls"
  | "unary"
  | "ping"
  | "stream"
  | "bidi"
  | "marketplace"
  | "auth"
  | "authUI"
  | "cursorTab"
  | "agentEndpoint"
  | "downloads"
  | "cdn";

/** AOk in the binary. */
export const NETWORK_CHECK_LABELS: Record<NetworkCheckKey, string> = {
  dns: "DNS",
  http2: "HTTP/2",
  tls: "SSL",
  unary: "API",
  ping: "Ping",
  stream: "Chat",
  bidi: "Agent",
  marketplace: "Marketplace",
  auth: "Authentication",
  authUI: "Authentication UI",
  cursorTab: "Cursor Tab",
  agentEndpoint: "Agent Endpoint",
  downloads: "Downloads",
  cdn: "CDN",
};

/** WOk runner order in the binary. */
export const NETWORK_CHECK_ORDER: readonly NetworkCheckKey[] = [
  "dns",
  "http2",
  "tls",
  "marketplace",
  "unary",
  "ping",
  "stream",
  "bidi",
  "auth",
  "authUI",
  "cursorTab",
  "agentEndpoint",
  "downloads",
  "cdn",
];

/** Checks that probe the Cursor aiserver HealthService (cloud-only). */
export const CLOUD_HEALTH_CHECK_KEYS: readonly NetworkCheckKey[] = [
  "unary",
  "ping",
  "stream",
  "bidi",
];

/** v6m in the binary (domain — purpose), verbatim. */
export const REQUIRED_DOMAINS: readonly { domain: string; purpose: string }[] = [
  { domain: "api2.cursor.sh", purpose: "API requests" },
  { domain: "api3.cursor.sh", purpose: "Cursor Tab" },
  { domain: "api4.cursor.sh", purpose: "Cursor Tab (regional)" },
  { domain: "*.api5.cursor.sh", purpose: "Agent requests" },
  { domain: "repo42.cursor.sh", purpose: "Training telemetry" },
  { domain: "*.authentication.cursor.sh", purpose: "Authentication" },
  { domain: "authenticator.cursor.sh", purpose: "Authentication UI (login page)" },
  { domain: "marketplace.cursorapi.com", purpose: "Extension marketplace" },
  { domain: "cursor-cdn.com", purpose: "Marketplace CDN" },
  { domain: "downloads.cursor.com", purpose: "Client updates" },
];

/** Copy Domains: `v6m.map(JOk).join("\n")`, JOk(e) = e.domain. */
export function requiredDomainsCopyText(): string {
  return REQUIRED_DOMAINS.map((d) => d.domain).join("\n");
}

/** Ysn in the binary: an Error whose name is "Warning". */
export class DiagnosticWarning extends Error {
  constructor(message: string) {
    super(message);
    this.name = "Warning";
  }
}

/**
 * A check's status value, mirroring the binary's result map:
 * undefined = not run, null = running, true/false = pass/fail,
 * DiagnosticWarning / Error for warning / failure detail.
 */
export type CheckStatus = undefined | null | boolean | Error;

export type NetworkDiagnosticResults = Partial<Record<NetworkCheckKey, CheckStatus>>;
export type NetworkDiagnosticLogs = Partial<Record<NetworkCheckKey, string[]>>;

/** JAr in the binary: `AOk[e] ?? e.toUpperCase()`. */
export function checkLabel(key: string): string {
  return (NETWORK_CHECK_LABELS as Record<string, string>)[key] ?? key.toUpperCase();
}

/** MOk in the binary, verbatim (Warning is checked before Error). */
export function formatCheckStatus(value: CheckStatus): string {
  if (value === undefined) {
    return "Not run";
  }
  if (value === null) {
    return "Running";
  }
  if (value === true) {
    return "Success";
  }
  if (value === false) {
    return "Failed";
  }
  if (value instanceof DiagnosticWarning) {
    return `Warning: ${value.message}`;
  }
  if (value instanceof Error) {
    return `Error: ${value.message}`;
  }
  return String(value);
}

/** DOk in the binary, verbatim structure. */
export function formatDiagnosticResults(
  results: NetworkDiagnosticResults,
  logs: NetworkDiagnosticLogs,
): string {
  const lines: string[] = ["Cursor Network Diagnostic Results", ""];
  const entries = Object.entries(results) as [NetworkCheckKey, CheckStatus][];
  const failed = entries.filter(
    ([, v]) => v instanceof Error && !(v instanceof DiagnosticWarning),
  );
  const warnings = entries.filter(([, v]) => v instanceof DiagnosticWarning);
  if (failed.length > 0) {
    lines.push(`FAILED (${failed.length}): ${failed.map(([k]) => checkLabel(k)).join(", ")}`);
  }
  if (warnings.length > 0) {
    lines.push(
      `WARNINGS (${warnings.length}): ${warnings.map(([k]) => checkLabel(k)).join(", ")}`,
    );
  }
  if (failed.length > 0 || warnings.length > 0) {
    lines.push("");
  }
  for (const [key, value] of entries) {
    lines.push(`${checkLabel(key)}: ${formatCheckStatus(value)}`);
    const checkLogs = logs[key] ?? [];
    if (checkLogs.length > 0) {
      lines.push("Logs:");
      lines.push(...checkLogs.map((l) => `  ${l}`));
    }
    lines.push("");
  }
  return lines.join("\n").trim();
}

/**
 * Initial results state: `{ dns: undefined, ...WLa }`; with
 * disableHttp2 the http2 key is dropped entirely (jOk).
 */
export function initialCheckResults(disableHttp2: boolean): NetworkDiagnosticResults {
  const results: NetworkDiagnosticResults = { dns: undefined };
  for (const key of NETWORK_CHECK_ORDER) {
    if (key === "dns") {
      continue;
    }
    if (disableHttp2 && key === "http2") {
      continue;
    }
    results[key] = undefined;
  }
  return results;
}

/* ------------------------------------------------------------------ */
/* Probes (injectable so tests never touch the real network)           */
/* ------------------------------------------------------------------ */

export interface DnsLookupResult {
  address: string;
  durationMs: number;
  host?: string;
  servers?: string[];
}

export interface TlsInfo {
  url: string;
  status: string;
  ip: string;
  issuer: string;
  name: string;
  altName: string;
  dnsTimeMs: number;
  connectTimeMs: number;
  tlsTimeMs: number;
}

export interface HttpFetchResult {
  ok: boolean;
  status: number;
  statusText: string;
  responseType?: string;
  server?: string;
  durationMs: number;
}

export interface NetworkDiagnosticProbes {
  dnsLookup(hostname: string, source: "nodejs" | "system"): Promise<DnsLookupResult>;
  /** Resolves with the negotiated protocol (e.g. "h2"). */
  http2Ping(url: string): Promise<{ protocol: string }>;
  inspectTls(url: string): Promise<TlsInfo>;
  httpFetch(url: string): Promise<HttpFetchResult>;
  /**
   * aiserver HealthService seam (cloud). Absent by default — the four
   * health checks are then omitted (see header HONEST-DIVERGENCE).
   * Implementations throw on failure, like the binary's checks.
   */
  health?: {
    unary(log: (msg: string) => void): Promise<void>;
    ping(log: (msg: string) => void): Promise<void>;
    stream(log: (msg: string) => void): Promise<void>;
    bidi(log: (msg: string) => void): Promise<void>;
  };
}

const API_HOST = "api2.cursor.sh";
const API_URL = `https://${API_HOST}`;
/** POk in the binary. */
export const DEFAULT_MARKETPLACE_URL = "https://marketplace.cursorapi.com";
const AUTH_URL = "https://prod.authentication.cursor.sh";
const DOWNLOADS_URL = "https://downloads.cursor.com";
const CDN_URL = "https://cursor-cdn.com";
const AUTH_UI_HOST = "authenticator.cursor.sh";
const CURSOR_TAB_HOST = "api3.cursor.sh";
const AGENT_ENDPOINT_HOST = "agent.api5.cursor.sh";

export function createNodeProbes(): NetworkDiagnosticProbes {
  return {
    async dnsLookup(hostname, _source) {
      const started = Date.now();
      const records = await dnsPromises.lookup(hostname, { all: true });
      const first = Array.isArray(records) ? records[0] : records;
      return {
        address: first?.address ?? "",
        durationMs: Date.now() - started,
        host: hostname,
        servers: dnsPromises.getServers(),
      };
    },
    http2Ping(url) {
      return new Promise((resolve, reject) => {
        const session = http2.connect(url);
        session.once("connect", () => {
          const protocol = session.alpnProtocol || "";
          session.close();
          resolve({ protocol });
        });
        session.once("error", reject);
      });
    },
    inspectTls(url) {
      return new Promise((resolve, reject) => {
        const parsed = new URL(url);
        const started = Date.now();
        const socket = tls.connect(
          { host: parsed.hostname, port: 443, servername: parsed.hostname },
          () => {
            const cert = socket.getPeerCertificate();
            const issuer =
              (cert.issuer && (cert.issuer.O || cert.issuer.CN)) || "";
            resolve({
              url,
              status: socket.authorized ? "Authorized" : "Unauthorized",
              ip: socket.remoteAddress ?? "",
              issuer: String(issuer),
              name: String(cert.subject?.CN ?? ""),
              altName: cert.subjectaltname ?? "",
              dnsTimeMs: 0,
              connectTimeMs: 0,
              tlsTimeMs: Date.now() - started,
            });
            socket.end();
          },
        );
        socket.once("error", reject);
      });
    },
    async httpFetch(url) {
      const started = Date.now();
      const res = await fetch(url, { redirect: "follow" });
      return {
        ok: res.ok,
        status: res.status,
        statusText: res.statusText,
        responseType: res.type,
        server: res.headers.get("server") ?? undefined,
        durationMs: Date.now() - started,
      };
    },
  };
}

/* ------------------------------------------------------------------ */
/* Runner (WOk + Cce)                                                  */
/* ------------------------------------------------------------------ */

export interface NetworkDiagnosticsRunOptions {
  disableHttp2?: boolean;
  /** Per-check timeout; binary _6m = 6e4 (60s). */
  timeoutMs?: number;
  marketplaceUrl?: string;
  /** Sink override (tests); default mirrors the binary's console sink. */
  log?: (key: NetworkCheckKey, msg: string) => void;
}

export interface NetworkDiagnosticsOutcome {
  results: NetworkDiagnosticResults;
  logs: NetworkDiagnosticLogs;
  /** Cloud health checks omitted because no health probe exists. */
  skippedCloudChecks: NetworkCheckKey[];
}

interface CheckContext {
  probes: NetworkDiagnosticProbes;
  marketplaceUrl: string;
  log: (msg: string) => void;
}

type CheckFn = (ctx: CheckContext) => Promise<true | DiagnosticWarning>;

function asError(e: unknown): Error {
  return e instanceof Error ? e : new Error(String(e));
}

async function checkDns(ctx: CheckContext): Promise<true> {
  let result: true | Error = true;
  for (const source of ["nodejs", "system"] as const) {
    for (let round = 0; round < 4; round++) {
      try {
        const c = await ctx.probes.dnsLookup(API_HOST, source);
        if (round === 0 && c.servers) {
          ctx.log(`Host: ${c.host ?? API_HOST}`);
          ctx.log(`Servers: ${c.servers}`);
        }
        ctx.log(`Resolved to ${c.address} in ${c.durationMs}ms`);
        if (c.durationMs > 1500) {
          result = new Error(`DNS lookup took ${c.durationMs}ms`);
        }
      } catch (e) {
        result = asError(e);
        ctx.log(`Error: ${result}`);
      }
    }
  }
  if (result instanceof Error) {
    throw result;
  }
  return true;
}

async function checkHttp2(ctx: CheckContext): Promise<true> {
  const { protocol } = await ctx.probes.http2Ping(API_URL);
  if (protocol !== "h2") {
    throw new Error(`Unexpected protocol: ${protocol}`);
  }
  return true;
}

async function checkTls(ctx: CheckContext): Promise<true | DiagnosticWarning> {
  const info = await ctx.probes.inspectTls(API_URL);
  ctx.log(`URL: ${info.url}`);
  ctx.log(`Status: ${info.status}`);
  ctx.log(`IP: ${info.ip}`);
  ctx.log(`Issuer: ${info.issuer}`);
  ctx.log(`Name: ${info.name}`);
  ctx.log(`AltName: ${info.altName}`);
  ctx.log(`DNS Time: ${info.dnsTimeMs}ms`);
  ctx.log(`Connect Time: ${info.connectTimeMs}ms`);
  ctx.log(`TLS Time: ${info.tlsTimeMs}ms`);
  if (
    info.issuer.includes("Google Trust Services") ||
    info.issuer.includes("Amazon RSA")
  ) {
    return true;
  }
  return new DiagnosticWarning(
    `Encrypted traffic is being intercepted by unrecognized certificate: ${info.issuer}`,
  );
}

async function checkMarketplace(ctx: CheckContext): Promise<true> {
  const url = ctx.marketplaceUrl;
  const host = new URL(url).host;
  const res = await ctx.probes.httpFetch(url);
  ctx.log(`Host: ${host}`);
  ctx.log(`Response: ${res.status} ${res.statusText}`);
  if (res.responseType !== undefined) {
    ctx.log(`Response Type: ${res.responseType}`);
  }
  if (res.server !== undefined) {
    ctx.log(`Server: ${res.server}`);
  }
  ctx.log(`Result: ${res.ok ? "OK" : "ERROR"} in ${res.durationMs}ms`);
  if (!res.ok) {
    throw new Error(`Invalid response: HTTP ${res.status} ${res.statusText}`);
  }
  return true;
}

async function checkHttpGet(url: string, ctx: CheckContext): Promise<true> {
  const host = new URL(url).host;
  const res = await ctx.probes.httpFetch(url);
  ctx.log(`Host: ${host}`);
  ctx.log(`Response: ${res.status} ${res.statusText} in ${res.durationMs}ms`);
  if (res.status >= 500) {
    throw new Error(`Invalid response: HTTP ${res.status} ${res.statusText}`);
  }
  return true;
}

async function checkDnsHost(host: string, ctx: CheckContext): Promise<true> {
  ctx.log(`DNS lookup: ${host}`);
  const c = await ctx.probes.dnsLookup(host, "nodejs");
  ctx.log(`Resolved ${host} to ${c.address} in ${c.durationMs}ms`);
  return true;
}

/**
 * WOk + Cce: run all checks concurrently (Promise.allSettled
 * semantics — each check captures its own failure), each wrapped in
 * the 60s timeout. A check's terminal log line is `Result: ${result}`
 * (or `Result: no response after ${l}s` on timeout), exactly as the
 * binary's sink records it.
 */
export async function runNetworkDiagnostics(
  probes: NetworkDiagnosticProbes,
  options: NetworkDiagnosticsRunOptions = {},
): Promise<NetworkDiagnosticsOutcome> {
  const disableHttp2 = options.disableHttp2 ?? false;
  const timeoutMs = options.timeoutMs ?? 60_000;
  const marketplaceUrl = options.marketplaceUrl ?? DEFAULT_MARKETPLACE_URL;
  const results = initialCheckResults(disableHttp2);
  const logs: NetworkDiagnosticLogs = {};
  const skippedCloudChecks: NetworkCheckKey[] = [];

  const sinkLog = (key: NetworkCheckKey, msg: string): void => {
    if (options.log) {
      options.log(key, msg);
    } else {
      // Binary sink: console line + timestamped stored line.
      console.log(`NetworkDiagnostics[${key}]: ${msg}`);
    }
    const line = `[${new Date().toISOString()}] ${msg}`;
    logs[key] = [...(logs[key] ?? []), line];
  };

  const checks: Partial<Record<NetworkCheckKey, CheckFn>> = {
    dns: checkDns,
    http2: checkHttp2,
    tls: checkTls,
    marketplace: checkMarketplace,
    auth: (ctx) => checkHttpGet(AUTH_URL, ctx),
    authUI: (ctx) => checkDnsHost(AUTH_UI_HOST, ctx),
    cursorTab: (ctx) => checkDnsHost(CURSOR_TAB_HOST, ctx),
    agentEndpoint: (ctx) => checkDnsHost(AGENT_ENDPOINT_HOST, ctx),
    downloads: (ctx) => checkHttpGet(DOWNLOADS_URL, ctx),
    cdn: (ctx) => checkHttpGet(CDN_URL, ctx),
  };
  if (disableHttp2) {
    // WOk: `e.disableHttp2 ? Promise.resolve() : Cce(e, "http2", ...)` —
    // the check never runs and (via jOk) the key stays absent.
    delete checks.http2;
  }
  if (probes.health) {
    const health = probes.health;
    checks.unary = async (ctx) => {
      await health.unary(ctx.log);
      return true;
    };
    checks.ping = async (ctx) => {
      await health.ping(ctx.log);
      return true;
    };
    checks.stream = async (ctx) => {
      await health.stream(ctx.log);
      return true;
    };
    checks.bidi = async (ctx) => {
      await health.bidi(ctx.log);
      return true;
    };
  } else {
    skippedCloudChecks.push(...CLOUD_HEALTH_CHECK_KEYS);
    for (const key of CLOUD_HEALTH_CHECK_KEYS) {
      delete results[key];
    }
  }

  const runOne = async (key: NetworkCheckKey, fn: CheckFn): Promise<void> => {
    results[key] = null; // Running
    const log = (msg: string): void => sinkLog(key, msg);
    let timer: NodeJS.Timeout | undefined;
    try {
      const outcome = await Promise.race([
        fn({ probes, marketplaceUrl, log }),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => {
            const seconds = timeoutMs / 1000;
            log(`Result: no response after ${seconds}s`);
            reject(new Error(`No response after ${seconds}s`));
          }, timeoutMs);
        }),
      ]);
      results[key] = outcome;
      log(`Result: ${outcome}`);
    } catch (e) {
      const err = asError(e);
      results[key] = err;
      if (!err.message.startsWith("No response after")) {
        log(`Result: ${err}`);
      }
    } finally {
      if (timer) {
        clearTimeout(timer);
      }
    }
  };

  const active = NETWORK_CHECK_ORDER.filter((key) => checks[key] !== undefined);
  await Promise.allSettled(active.map((key) => runOne(key, checks[key]!)));

  return { results, logs, skippedCloudChecks };
}
