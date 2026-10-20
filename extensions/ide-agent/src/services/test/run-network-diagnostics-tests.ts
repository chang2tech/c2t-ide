/**
 * Network Diagnostics tests (feature `settings-network-diagnostics`,
 * DEV-GAPS-93E).
 *
 * Run after `tsc`: node --test out/services/test/run-network-diagnostics-tests.js
 *
 * All probes are fakes — no real network. Assertions pin the Cursor
 * 3.25.9 verbatim surface (labels AOk, status format MOk, copy format
 * DOk, Required Domains v6m, 60s timeout error, http2 omission under
 * disableHttp2) plus the fork's HONEST-DIVERGENCE: the four aiserver
 * HealthService checks (unary/ping/stream/bidi) are omitted — never
 * fabricated — when no health probe is injected.
 */
import { describe, it } from "node:test";
import * as assert from "node:assert";

import {
  CLOUD_HEALTH_CHECK_KEYS,
  DEFAULT_MARKETPLACE_URL,
  DiagnosticWarning,
  NETWORK_CHECK_LABELS,
  NETWORK_CHECK_ORDER,
  REQUIRED_DOMAINS,
  checkLabel,
  formatCheckStatus,
  formatDiagnosticResults,
  initialCheckResults,
  requiredDomainsCopyText,
  runNetworkDiagnostics,
  type NetworkDiagnosticProbes,
} from "../networkDiagnosticsService";

function fakeProbes(overrides: Partial<NetworkDiagnosticProbes> = {}): NetworkDiagnosticProbes {
  return {
    dnsLookup: async (hostname) => ({
      address: "203.0.113.10",
      durationMs: 12,
      host: hostname,
      servers: ["203.0.113.53"],
    }),
    http2Ping: async () => ({ protocol: "h2" }),
    inspectTls: async (url) => ({
      url,
      status: "Authorized",
      ip: "203.0.113.10",
      issuer: "Google Trust Services",
      name: "api2.cursor.sh",
      altName: "DNS:api2.cursor.sh",
      dnsTimeMs: 1,
      connectTimeMs: 2,
      tlsTimeMs: 3,
    }),
    httpFetch: async () => ({
      ok: true,
      status: 200,
      statusText: "OK",
      responseType: "basic",
      server: "fake",
      durationMs: 9,
    }),
    ...overrides,
  };
}

const silent = { log: () => {} };

describe("network diagnostics — verbatim constants", () => {
  it("check labels match AOk and order matches WOk", () => {
    assert.strictEqual(NETWORK_CHECK_LABELS.dns, "DNS");
    assert.strictEqual(NETWORK_CHECK_LABELS.http2, "HTTP/2");
    assert.strictEqual(NETWORK_CHECK_LABELS.tls, "SSL");
    assert.strictEqual(NETWORK_CHECK_LABELS.unary, "API");
    assert.strictEqual(NETWORK_CHECK_LABELS.stream, "Chat");
    assert.strictEqual(NETWORK_CHECK_LABELS.bidi, "Agent");
    assert.strictEqual(NETWORK_CHECK_LABELS.cdn, "CDN");
    assert.deepStrictEqual([...NETWORK_CHECK_ORDER], [
      "dns", "http2", "tls", "marketplace", "unary", "ping", "stream",
      "bidi", "auth", "authUI", "cursorTab", "agentEndpoint", "downloads",
      "cdn",
    ]);
    // JAr fallback: unknown key upper-cases.
    assert.strictEqual(checkLabel("somethingElse"), "SOMETHINGELSE");
  });

  it("required domains match v6m; copy text is domains joined by \\n (JOk)", () => {
    assert.strictEqual(REQUIRED_DOMAINS.length, 10);
    assert.deepStrictEqual(REQUIRED_DOMAINS[0], {
      domain: "api2.cursor.sh",
      purpose: "API requests",
    });
    assert.deepStrictEqual(REQUIRED_DOMAINS[4], {
      domain: "repo42.cursor.sh",
      purpose: "Training telemetry",
    });
    const copy = requiredDomainsCopyText();
    assert.strictEqual(copy.split("\n").length, 10);
    assert.ok(copy.startsWith("api2.cursor.sh\napi3.cursor.sh\n"));
    assert.ok(!copy.includes("API requests"));
  });

  it("status format matches MOk (Warning before Error)", () => {
    assert.strictEqual(formatCheckStatus(undefined), "Not run");
    assert.strictEqual(formatCheckStatus(null), "Running");
    assert.strictEqual(formatCheckStatus(true), "Success");
    assert.strictEqual(formatCheckStatus(false), "Failed");
    assert.strictEqual(formatCheckStatus(new Error("boom")), "Error: boom");
    const warn = new DiagnosticWarning("iffy");
    assert.strictEqual(warn.name, "Warning");
    assert.strictEqual(formatCheckStatus(warn), "Warning: iffy");
  });

  it("initial state mirrors { dns: undefined, ...WLa }; disableHttp2 drops http2 (jOk)", () => {
    const all = initialCheckResults(false);
    assert.ok("dns" in all && "http2" in all);
    assert.strictEqual(Object.keys(all).length, 14);
    const noH2 = initialCheckResults(true);
    assert.ok(!("http2" in noH2));
    assert.strictEqual(Object.keys(noH2).length, 13);
  });
});

describe("network diagnostics — runner with fake probes", () => {
  it("all local checks pass; cloud health checks omitted and reported skipped", async () => {
    const outcome = await runNetworkDiagnostics(fakeProbes(), silent);
    assert.deepStrictEqual(outcome.skippedCloudChecks, [...CLOUD_HEALTH_CHECK_KEYS]);
    for (const key of ["unary", "ping", "stream", "bidi"] as const) {
      assert.ok(!(key in outcome.results), `${key} must be omitted, not faked`);
    }
    for (const key of [
      "dns", "http2", "tls", "marketplace", "auth", "authUI", "cursorTab",
      "agentEndpoint", "downloads", "cdn",
    ] as const) {
      assert.strictEqual(outcome.results[key], true, `${key} should pass`);
    }
    // Stored log lines carry the binary sink's [ISO timestamp] prefix.
    assert.match(outcome.logs.dns![0], /^\[\d{4}-\d{2}-\d{2}T.*\] Host: api2\.cursor\.sh$/);
    assert.ok(outcome.logs.dns!.some((l) => l.includes("Resolved to 203.0.113.10 in 12ms")));
    assert.ok(outcome.logs.dns!.some((l) => l.endsWith("Result: true")));
    assert.ok(
      outcome.logs.authUI!.some((l) =>
        l.includes("Resolved authenticator.cursor.sh to 203.0.113.10 in 12ms"),
      ),
    );
  });

  it("disableHttp2 omits the http2 check entirely", async () => {
    const outcome = await runNetworkDiagnostics(fakeProbes(), {
      ...silent,
      disableHttp2: true,
    });
    assert.ok(!("http2" in outcome.results));
  });

  it("http2 wrong protocol fails verbatim; slow DNS fails verbatim; TLS bad issuer warns", async () => {
    const outcome = await runNetworkDiagnostics(
      fakeProbes({
        http2Ping: async () => ({ protocol: "http/1.1" }),
        dnsLookup: async (hostname) => ({
          address: "203.0.113.10",
          durationMs: 2000,
          host: hostname,
          servers: ["203.0.113.53"],
        }),
        inspectTls: async (url) => ({
          url,
          status: "Authorized",
          ip: "203.0.113.10",
          issuer: "Sketchy CA",
          name: "api2.cursor.sh",
          altName: "",
          dnsTimeMs: 0,
          connectTimeMs: 0,
          tlsTimeMs: 1,
        }),
      }),
      silent,
    );
    const h2 = outcome.results.http2;
    assert.ok(h2 instanceof Error && h2.message === "Unexpected protocol: http/1.1");
    const dnsResult = outcome.results.dns;
    assert.ok(
      dnsResult instanceof Error && dnsResult.message === "DNS lookup took 2000ms",
    );
    const tlsResult = outcome.results.tls;
    assert.ok(tlsResult instanceof DiagnosticWarning);
    assert.strictEqual(
      (tlsResult as Error).message,
      "Encrypted traffic is being intercepted by unrecognized certificate: Sketchy CA",
    );
  });

  it("marketplace non-OK and 5xx GET fail; per-check timeout errors verbatim", async () => {
    const outcome = await runNetworkDiagnostics(
      fakeProbes({
        httpFetch: async (url) =>
          url === DEFAULT_MARKETPLACE_URL
            ? { ok: false, status: 503, statusText: "Service Unavailable", durationMs: 5 }
            : { ok: true, status: 200, statusText: "OK", durationMs: 5 },
      }),
      silent,
    );
    const mp = outcome.results.marketplace;
    assert.ok(
      mp instanceof Error &&
        mp.message === "Invalid response: HTTP 503 Service Unavailable",
    );

    const slow = await runNetworkDiagnostics(
      fakeProbes({
        httpFetch: async () => new Promise(() => {}),
      }),
      { ...silent, timeoutMs: 50 },
    );
    const auth = slow.results.auth;
    assert.ok(auth instanceof Error && auth.message === "No response after 0.05s");
    assert.ok(slow.logs.auth!.some((l) => l.includes("Result: no response after 0.05s")));
  });

  it("injected health probe runs the four cloud checks", async () => {
    const calls: string[] = [];
    const outcome = await runNetworkDiagnostics(
      fakeProbes({
        health: {
          unary: async () => { calls.push("unary"); },
          ping: async () => { calls.push("ping"); },
          stream: async () => { calls.push("stream"); },
          bidi: async () => { calls.push("bidi"); },
        },
      }),
      silent,
    );
    assert.deepStrictEqual(outcome.skippedCloudChecks, []);
    assert.deepStrictEqual(calls.sort(), ["bidi", "ping", "stream", "unary"]);
    assert.strictEqual(outcome.results.ping, true);
  });
});

describe("network diagnostics — copy format (DOk)", () => {
  it("header, FAILED/WARNINGS summary, per-check lines and indented logs", () => {
    const text = formatDiagnosticResults(
      {
        dns: true,
        http2: new Error("Unexpected protocol: http/1.1"),
        tls: new DiagnosticWarning("Encrypted traffic is being intercepted by unrecognized certificate: Sketchy CA"),
        auth: undefined,
      },
      { dns: ["[2026-10-20T00:00:00.000Z] Resolved to 203.0.113.10 in 12ms"] },
    );
    const lines = text.split("\n");
    assert.strictEqual(lines[0], "Cursor Network Diagnostic Results");
    assert.ok(lines.includes("FAILED (1): HTTP/2"));
    assert.ok(lines.includes("WARNINGS (1): SSL"));
    assert.ok(lines.includes("DNS: Success"));
    assert.ok(lines.includes("HTTP/2: Error: Unexpected protocol: http/1.1"));
    assert.ok(
      lines.includes(
        "SSL: Warning: Encrypted traffic is being intercepted by unrecognized certificate: Sketchy CA",
      ),
    );
    assert.ok(lines.includes("Authentication: Not run"));
    assert.ok(lines.includes("Logs:"));
    assert.ok(
      lines.includes("  [2026-10-20T00:00:00.000Z] Resolved to 203.0.113.10 in 12ms"),
    );
  });
});
