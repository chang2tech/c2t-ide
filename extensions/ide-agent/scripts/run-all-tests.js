#!/usr/bin/env node
/**
 * run-all-tests.js — runs every ide-agent test suite, sequentially.
 *
 * Wires the drift-guard suite (`browser/test/run-native-menu-tests.js`, the
 * package.json/nativeMenu.ts drift guard) into CI: it is imported by
 * `browser/test/run-tests.js`, which this runner executes.
 *
 * Suite discovery: every `run-*.js` and `*.test.js` under `out/` EXCEPT files
 * already imported by an aggregator (listed in EXCLUDE — they run inside it).
 * New suites are picked up automatically; no manual list to keep in sync.
 *
 * Each suite runs in its own `node --test` child process with a per-suite
 * timeout, so one hanging suite (e.g. the known integrations OAuth flake)
 * cannot hang the whole run. Suites run sequentially: parallel execution
 * thrashes small CI machines and makes timing-sensitive suites flaky.
 *
 * Suites needing a real headless Chromium gate on `IDE_BROWSER_CHROME` and
 * skip cleanly when it is unset (see browser/test/run-tests.ts).
 *
 * Exit code: 0 only if every suite passes; 1 otherwise.
 */
"use strict";

const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const OUT = path.join(ROOT, "out");
const SUITE_TIMEOUT_MS = 180_000;

// Already imported by an aggregator — running them standalone too would only
// double-run the same tests.
const EXCLUDE = new Set([
  "browser/test/run-native-menu-tests.js", // drift-guard, imported by browser/test/run-tests.js
  "browser/test/browser-tab.test.js", // imported by browser/test/run-tests.js
  "browser/test/browser-tab-state.test.js", // imported by browser/test/run-tests.js
  "browser/test/browser-menu-handlers.test.js", // imported by browser/test/run-tests.js
]);

function collectSuites(dir, rel = "") {
  const suites = [];
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return suites;
  }
  for (const entry of entries) {
    const r = rel ? `${rel}/${entry.name}` : entry.name;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      suites.push(...collectSuites(full, r));
    } else if (/^run-.*\.js$/.test(entry.name) || /\.test\.js$/.test(entry.name)) {
      if (!EXCLUDE.has(r)) suites.push(r);
    }
  }
  return suites.sort();
}

function runSuite(rel) {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(process.execPath, ["--test", path.join(OUT, rel)], {
      cwd: ROOT,
      timeout: SUITE_TIMEOUT_MS,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("error", (e) =>
      resolve({ rel, status: "ERROR", detail: e.message, ms: Date.now() - started })
    );
    child.on("close", (code, signal) => {
      const ms = Date.now() - started;
      const timedOut = signal === "SIGTERM" && ms >= SUITE_TIMEOUT_MS - 1000;
      const summary = {};
      for (const m of out.matchAll(/^ℹ (tests|suites|pass|fail|cancelled|skipped|todo) (\d+)/gm)) {
        summary[m[1]] = Number(m[2]);
      }
      if (timedOut) {
        resolve({ rel, status: "TIMEOUT", detail: `no result within ${SUITE_TIMEOUT_MS / 1000}s`, ms });
      } else if (code !== 0) {
        const failing = out.match(/✖ failing tests:[\s\S]{0,800}/);
        resolve({
          rel,
          status: "FAIL",
          detail: failing ? failing[0].trim().slice(0, 400) : `exit ${code}`,
          ms,
          summary,
        });
      } else {
        resolve({ rel, status: "PASS", ms, summary });
      }
    });
  });
}

async function main() {
  const onlyIdx = process.argv.indexOf("--only");
  const only = onlyIdx >= 0 ? process.argv[onlyIdx + 1] : null;
  let suites = collectSuites(OUT);
  if (only) suites = suites.filter((s) => s.includes(only));
  if (suites.length === 0) {
    console.error(`No test suites found under ${OUT} — run \`npm run compile\` first.`);
    process.exit(1);
  }
  const chrome = process.env.IDE_BROWSER_CHROME;
  console.log(`ide-agent test run: ${suites.length} suites, sequential, ${SUITE_TIMEOUT_MS / 1000}s per-suite timeout`);
  console.log(`IDE_BROWSER_CHROME=${chrome ? chrome : "<unset — Chromium integration tests will skip>"}`);
  console.log("");

  const totals = { tests: 0, pass: 0, fail: 0, skipped: 0, cancelled: 0 };
  let failed = 0;
  for (const rel of suites) {
    const r = await runSuite(rel);
    const s = r.summary || {};
    for (const k of Object.keys(totals)) totals[k] += s[k] || 0;
    const counts = s.tests !== undefined ? ` tests=${s.tests} pass=${s.pass} fail=${s.fail}` : "";
    const secs = (r.ms / 1000).toFixed(1);
    if (r.status === "PASS") {
      console.log(`PASS    ${rel}${counts} (${secs}s)`);
    } else {
      failed++;
      console.log(`${r.status.padEnd(7)} ${rel}${counts} (${secs}s) — ${r.detail}`);
    }
  }

  console.log("");
  console.log(
    `TOTAL suites=${suites.length} failed=${failed} | tests=${totals.tests} pass=${totals.pass} fail=${totals.fail} skipped=${totals.skipped} cancelled=${totals.cancelled}`
  );
  if (failed > 0) {
    console.log("RESULT: FAIL");
    process.exit(1);
  }
  console.log("RESULT: PASS");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
