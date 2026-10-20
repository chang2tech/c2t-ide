/**
 * Desktop bridge CLIENT — `ide-code desktop ls|send`.
 *
 * Spec: ~/workspace/ide-code-mission/docs/rea/dig-cli-2026-10-19.md
 * §3.1 (OBSERVED wire spec), §4.2, §5 P2. Every behavior below cites the
 * spec section it mirrors.
 *
 * Transport (spec §3.1, explicitly verified): HTTP POST to `/` over a unix
 * domain socket + `Authorization: Bearer <token>` — NOT newline-delimited
 * JSON. 10 s request timeout.
 */

import * as http from "node:http";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/** Spec §5 P2: bridge dir override env. */
export const BRIDGE_DIR_ENV = "IDE_CODE_DESKTOP_BRIDGE_DIR";
/** Spec §3.1 R1: discovery dir default. */
export const DEFAULT_BRIDGE_DIR = path.join(os.homedir(), ".ide-code", "desktop-bridge");
/** Spec §3.1 R1: protocolVersion must equal 1. */
export const PROTOCOL_VERSION = 1;
/** Spec §3.1: 10 s request timeout (ao=1e4). */
export const REQUEST_TIMEOUT_MS = 10_000;

/**
 * Usage text — mirrors the spec's verbatim usage block (§3.1), with
 * `ide-code` as the binary name (spec §5).
 */
export const USAGE = `Usage: ide-code desktop <command>

Interact with chat threads in a running IDE Code desktop app.

Commands
  ls                                List threads live in running desktop instances
  send <thread> [text...]           Send a message to a live desktop thread

Options
  --json                            Machine-readable output
  --force                           (send) Submit immediately, interrupting a running turn
  --stdin                           (send) Read message text from stdin
  -h --help                         Print usage

<thread> is a thread id from \`ide-code desktop ls\`, or a unique prefix of one.`;

export interface LiveInstance {
  /** Spec §3.1 R1: label = "<appName> <appVersion>". */
  label: string;
  appName: string;
  appVersion: string;
  userDataDir: string;
  socketPath: string;
  token: string;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.length > 0;
}

/**
 * Validate one discovery file (spec §3.1 R1): {protocolVersion: 1,
 * pid: integer>0 AND alive via process.kill(pid, 0), socketPath: non-empty
 * string, token: /^[0-9a-f]{64}$/, appName/appVersion/userDataDir:
 * non-empty strings, createdAt: number>=0}. Invalid/stale → undefined
 * (skipped silently, spec §3.1 R1).
 */
export function validateInstance(raw: unknown): Omit<LiveInstance, "label"> | undefined {
  if (!isRecord(raw)) {
    return undefined;
  }
  const { protocolVersion, pid, socketPath, token, appName, appVersion, userDataDir, createdAt } = raw;
  if (protocolVersion !== PROTOCOL_VERSION) {
    return undefined;
  }
  if (!Number.isInteger(pid) || (pid as number) <= 0) {
    return undefined;
  }
  try {
    process.kill(pid as number, 0); // spec §3.1 R1: pid must be alive
  } catch {
    return undefined;
  }
  if (!isNonEmptyString(socketPath)) {
    return undefined;
  }
  if (typeof token !== "string" || !/^[0-9a-f]{64}$/.test(token)) {
    return undefined;
  }
  if (!isNonEmptyString(appName) || !isNonEmptyString(appVersion) || !isNonEmptyString(userDataDir)) {
    return undefined;
  }
  if (typeof createdAt !== "number" || createdAt < 0) {
    return undefined;
  }
  return {
    appName: appName as string,
    appVersion: appVersion as string,
    userDataDir: userDataDir as string,
    socketPath: socketPath as string,
    token: token as string,
  };
}

/**
 * Instance discovery (spec §3.1 R1): read `*.json` from the bridge dir
 * (override: IDE_CODE_DESKTOP_BRIDGE_DIR). Invalid/stale → skipped silently.
 */
export function discoverInstances(dir?: string): LiveInstance[] {
  const d = dir ?? process.env[BRIDGE_DIR_ENV] ?? DEFAULT_BRIDGE_DIR;
  let files: string[];
  try {
    files = fs.readdirSync(d);
  } catch {
    return [];
  }
  const out: LiveInstance[] = [];
  for (const f of files) {
    if (!f.endsWith(".json")) {
      continue;
    }
    let raw: unknown;
    try {
      raw = JSON.parse(fs.readFileSync(path.join(d, f), "utf8"));
    } catch {
      continue;
    }
    const v = validateInstance(raw);
    if (!v) {
      continue;
    }
    out.push({ ...v, label: `${v.appName} ${v.appVersion}` });
  }
  return out;
}

/** Distinct error for the 10 s timeout (spec §3.1 timeout message). */
export class BridgeTimeoutError extends Error {
  constructor(label: string) {
    super(`${label} desktop bridge request timed out`);
    this.name = "BridgeTimeoutError";
  }
}

interface BridgeHttpResult {
  statusCode: number;
  json: unknown;
}

/**
 * Wire call (spec §3.1): HTTP POST to `/` over the unix domain socket,
 * `Authorization: Bearer <token>`, JSON body, request timeout.
 */
export function postBridge(
  inst: LiveInstance,
  body: unknown,
  timeoutMs: number = REQUEST_TIMEOUT_MS,
): Promise<BridgeHttpResult> {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    let timedOut = false;
    const req = http.request(
      {
        socketPath: inst.socketPath,
        path: "/",
        method: "POST",
        headers: {
          Authorization: `Bearer ${inst.token}`,
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(payload),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          let json: unknown;
          try {
            json = text ? JSON.parse(text) : undefined;
          } catch {
            json = undefined;
          }
          resolve({ statusCode: res.statusCode ?? 0, json });
        });
      },
    );
    req.setTimeout(timeoutMs, () => {
      timedOut = true;
      req.destroy();
    });
    req.on("error", (err) => {
      reject(timedOut ? new BridgeTimeoutError(inst.label) : err);
    });
    req.end(payload);
  });
}

/**
 * Non-200 handling (spec §3.1): non-200 with `{status:"error"}` → surface
 * the message; other non-200 → "<label> desktop bridge returned HTTP
 * <code>[: body.error]". Returns the stderr line, or undefined when the
 * response is 200.
 */
export function non200Error(inst: LiveInstance, code: number, json: unknown): string | undefined {
  if (code === 200) {
    return undefined;
  }
  if (isRecord(json) && json.status === "error") {
    const message = typeof json.message === "string" && json.message ? json.message : "unknown error";
    return `error: ${message}`;
  }
  const suffix = isRecord(json) && typeof json.error === "string" && json.error ? `: ${json.error}` : "";
  return `${inst.label} desktop bridge returned HTTP ${code}${suffix}`;
}

// ---------------------------------------------------------------------------
// ls
// ---------------------------------------------------------------------------

export interface ListedThread {
  id: string;
  title: string;
  source: string;
  status: string;
  lastUpdatedAt: number;
  windowId: string;
}

interface ThreadWithInstance {
  thread: ListedThread;
  instance: LiveInstance;
}

function coerceThread(raw: unknown): ListedThread | undefined {
  if (!isRecord(raw) || typeof raw.id !== "string" || !raw.id) {
    return undefined;
  }
  return {
    id: raw.id,
    title: typeof raw.title === "string" ? raw.title : "",
    source: typeof raw.source === "string" ? raw.source : "local",
    status: typeof raw.status === "string" ? raw.status : "unknown",
    lastUpdatedAt: typeof raw.lastUpdatedAt === "number" ? raw.lastUpdatedAt : 0,
    windowId: typeof raw.windowId === "string" ? raw.windowId : "",
  };
}

/** Strip ANSI escape sequences from a thread title (spec §3.1 ls). */
export function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g, "");
}

function displayTitle(title: string): string {
  const t = stripAnsi(title).trim();
  return t ? t : "(untitled)"; // spec §3.1: (untitled) fallback
}

function renderTable(rows: ThreadWithInstance[]): string {
  const headers = ["THREAD ID", "TITLE", "SOURCE", "STATUS", "WHERE"];
  const data = rows.map((r) => [
    r.thread.id,
    displayTitle(r.thread.title),
    r.thread.source,
    r.thread.status,
    r.thread.windowId, // WHERE ← windowId, the only location-ish field in the response
  ]);
  const widths = headers.map((h, i) =>
    Math.max(h.length, ...data.map((row) => row[i].length)),
  );
  const lines = [
    headers.map((h, i) => h.padEnd(widths[i])).join("  ").trimEnd(),
    ...data.map((row) => row.map((c, i) => c.padEnd(widths[i])).join("  ").trimEnd()),
  ];
  return lines.join("\n");
}

interface Out {
  stdout: (line: string) => void;
  stderr: (line: string) => void;
}

const defaultOut: Out = {
  stdout: (line) => process.stdout.write(line + "\n"),
  stderr: (line) => process.stderr.write(line + "\n"),
};

/**
 * `ls` (spec §3.1): `{type:"listThreads"}` to every live instance, table or
 * --json output, footer "N thread(s) across M running IDE Code instance(s)".
 */
export async function cmdLs(
  instances: LiveInstance[],
  flags: { json: boolean },
  timeoutMs: number,
  out: Out = defaultOut,
): Promise<number> {
  const rows: ThreadWithInstance[] = [];
  let okInstances = 0;
  for (const inst of instances) {
    let result: BridgeHttpResult;
    try {
      result = await postBridge(inst, { type: "listThreads" }, timeoutMs);
    } catch (err) {
      out.stderr(
        err instanceof BridgeTimeoutError
          ? err.message
          : `${inst.label} desktop bridge request failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      continue;
    }
    const httpErr = non200Error(inst, result.statusCode, result.json);
    if (httpErr) {
      out.stderr(httpErr);
      continue;
    }
    okInstances++;
    const threads = isRecord(result.json) && Array.isArray(result.json.threads) ? result.json.threads : [];
    for (const t of threads) {
      const thread = coerceThread(t);
      if (thread) {
        rows.push({ thread, instance: inst });
      }
    }
  }
  if (flags.json) {
    out.stdout(
      JSON.stringify(
        rows.map((r) => ({
          id: r.thread.id,
          title: r.thread.title,
          source: r.thread.source,
          status: r.thread.status,
          lastUpdatedAt: r.thread.lastUpdatedAt,
          windowId: r.thread.windowId,
          instance: {
            label: r.instance.label,
            appName: r.instance.appName,
            appVersion: r.instance.appVersion,
            userDataDir: r.instance.userDataDir,
          },
        })),
        null,
        2,
      ),
    );
  } else {
    if (rows.length > 0) {
      out.stdout(renderTable(rows));
    }
    out.stdout(`${rows.length} thread(s) across ${okInstances} running IDE Code instance(s)`);
    // No instance answered: the listing failed (not an empty-but-healthy result).
    return okInstances > 0 ? 0 : 1;
  }
  return 0;
}

// ---------------------------------------------------------------------------
// send
// ---------------------------------------------------------------------------

/** Spec §3.1 Gl: UUID-shaped = UUID regex or length ≥ 36. */
export function isUuidShaped(ref: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(ref) || ref.length >= 36;
}

type RefResolution =
  | { kind: "resolved"; thread: ListedThread; instance: LiveInstance }
  | { kind: "pseudo"; instances: LiveInstance[] }
  | { kind: "ambiguous"; ref: string; matches: ThreadWithInstance[] }
  | { kind: "unknown"; ref: string };

/**
 * Thread-ref resolution (spec §3.1 Gl): trim ref; UUID refs lowercased.
 * Exact id match → most-recently-updated wins; else unique prefix match;
 * else ambiguous → error; else UUID-shaped → pseudo-thread per instance;
 * else unknown.
 */
export function resolveRef(rawRef: string, rows: ThreadWithInstance[], instances: LiveInstance[]): RefResolution {
  let ref = rawRef.trim();
  if (isUuidShaped(ref)) {
    ref = ref.toLowerCase(); // spec §3.1 Gl: UUID refs lowercased
  }
  const exact = rows.filter((r) => r.thread.id === ref);
  if (exact.length > 0) {
    // Most-recently-updated wins (spec §3.1 Gl / ql).
    const best = [...exact].sort((a, b) => b.thread.lastUpdatedAt - a.thread.lastUpdatedAt)[0];
    return { kind: "resolved", thread: best.thread, instance: best.instance };
  }
  const prefixed = rows.filter((r) => r.thread.id.startsWith(ref));
  if (prefixed.length === 1) {
    return { kind: "resolved", thread: prefixed[0].thread, instance: prefixed[0].instance };
  }
  if (prefixed.length > 1) {
    return { kind: "ambiguous", ref, matches: prefixed };
  }
  if (isUuidShaped(ref)) {
    return { kind: "pseudo", instances }; // spec §3.1 Gl: pseudo-thread per instance, send proceeds
  }
  return { kind: "unknown", ref };
}

function readStdinFully(): Promise<string> {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) {
      resolve("");
      return;
    }
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (c: string) => {
      data += c;
    });
    process.stdin.on("end", () => resolve(data));
    process.stdin.resume();
  });
}

/**
 * `send` (spec §3.1): `{type:"sendMessage", threadId, text, force}` and the
 * six status outcomes with their exact messages/exit codes.
 */
export async function cmdSend(
  args: string[],
  flags: { json: boolean; force: boolean; stdin: boolean },
  instances: LiveInstance[],
  timeoutMs: number,
  out: Out = defaultOut,
): Promise<number> {
  const ref = args[0];
  if (!ref) {
    out.stderr("error: missing <thread> (usage: ide-code desktop send <thread> [text...])");
    return 1;
  }
  const text = flags.stdin ? await readStdinFully() : args.slice(1).join(" "); // spec §3.1: args joined with single spaces, or full stdin
  if (text.trim().length === 0) {
    out.stderr("error: message text is empty (provide text or use --stdin)");
    return 1;
  }

  // Resolve against the union of all instances' threads (needs listThreads).
  const rows: ThreadWithInstance[] = [];
  for (const inst of instances) {
    try {
      const result = await postBridge(inst, { type: "listThreads" }, timeoutMs);
      if (result.statusCode === 200 && isRecord(result.json) && Array.isArray(result.json.threads)) {
        for (const t of result.json.threads) {
          const thread = coerceThread(t);
          if (thread) {
            rows.push({ thread, instance: inst });
          }
        }
      }
    } catch {
      // Resolution is best-effort per instance; a dead socket surfaces at send time.
    }
  }

  const resolution = resolveRef(ref, rows, instances);
  if (resolution.kind === "ambiguous") {
    const list = resolution.matches
      .map((m) => `${m.thread.id} "${displayTitle(m.thread.title)}"`)
      .join(", ");
    out.stderr(`Desktop thread ref "${resolution.ref}" is ambiguous: ${list}`);
    return 1;
  }
  if (resolution.kind === "unknown") {
    out.stderr(`Unknown desktop thread ref "${resolution.ref}"`);
    return 1;
  }

  // Targets to try, in order. Pseudo-threads target every live instance
  // (spec §3.1 Gl); resolved refs target their single owning instance.
  const targets: Array<{ threadId: string; title: string; status: string; instance: LiveInstance }> =
    resolution.kind === "pseudo"
      ? resolution.instances.map((inst) => ({
          threadId: ref.trim().toLowerCase(),
          title: "",
          status: "idle", // spec §3.1 Gl pseudo-thread: {source:"local", status:"idle", …}
          instance: inst,
        }))
      : [
          {
            threadId: resolution.thread.id,
            title: resolution.thread.title,
            status: resolution.thread.status,
            instance: resolution.instance,
          },
        ];

  let lastTransportError: string | undefined;
  for (const target of targets) {
    let result: BridgeHttpResult;
    try {
      result = await postBridge(
        target.instance,
        { type: "sendMessage", threadId: target.threadId, text, force: flags.force },
        timeoutMs,
      );
    } catch (err) {
      lastTransportError =
        err instanceof BridgeTimeoutError
          ? err.message
          : `${target.instance.label} desktop bridge request failed: ${err instanceof Error ? err.message : String(err)}`;
      continue; // try the next instance (only reachable for pseudo-threads)
    }
    const httpErr = non200Error(target.instance, result.statusCode, result.json);
    if (httpErr) {
      out.stderr(httpErr);
      return 1;
    }
    const body = isRecord(result.json) ? result.json : {};
    const status = typeof body.status === "string" ? body.status : "";
    const title =
      typeof body.threadTitle === "string" && body.threadTitle
        ? body.threadTitle
        : displayTitle(target.title) === "(untitled)" && !target.title
          ? target.threadId
          : displayTitle(target.title);
    const id = typeof body.threadId === "string" && body.threadId ? body.threadId : target.threadId;

    if (flags.json) {
      out.stdout(JSON.stringify(result.json ?? {}, null, 2));
    }
    switch (status) {
      case "submitted": {
        // Spec §3.1: `Submitted to "<title>" (<id>)` (+ interrupted suffix
        // when --force and the thread was running).
        const suffix = flags.force && target.status === "running" ? " (interrupted running turn)" : "";
        if (!flags.json) {
          out.stdout(`Submitted to "${title}" (${id})${suffix}`);
        }
        return 0;
      }
      case "queued":
        if (!flags.json) {
          out.stdout(`Queued in "${title}" (agent is running; will submit when the current turn ends)`);
        }
        return 0;
      case "unknown-thread":
        out.stderr(`error: thread "${id}" is no longer available`);
        return 1;
      case "timeout":
        out.stderr("error: desktop did not confirm the message before timeout; it may have been submitted");
        return 1;
      case "not-sendable": {
        const reason = typeof body.reason === "string" && body.reason ? body.reason : "unknown reason";
        out.stderr(`error: thread "${title}" is not sendable: ${reason}`);
        return 1;
      }
      case "error": {
        const message = typeof body.message === "string" && body.message ? body.message : "unknown error";
        out.stderr(`error: ${message}`);
        return 1;
      }
      default:
        out.stderr(`error: unexpected desktop bridge response: ${JSON.stringify(result.json ?? {})}`);
        return 1;
    }
  }
  out.stderr(lastTransportError ?? "error: desktop bridge request failed");
  return 1;
}

// ---------------------------------------------------------------------------
// entry
// ---------------------------------------------------------------------------

export interface BridgeOptions {
  /** Injected for tests (default: REQUEST_TIMEOUT_MS = 10 s, spec §3.1). */
  requestTimeoutMs?: number;
  /**
   * Injectable output sinks (default: process.stdout/stderr). Lets tests
   * capture output without patching process.stdout.write — which would
   * corrupt the node:test TAP stream in the child process.
   */
  stdout?: (line: string) => void;
  stderr?: (line: string) => void;
}

interface ParsedFlags {
  json: boolean;
  force: boolean;
  stdin: boolean;
  help: boolean;
}

function parseArgv(argv: string[]): { flags: ParsedFlags; positional: string[]; error?: string } {
  const flags: ParsedFlags = { json: false, force: false, stdin: false, help: false };
  const positional: string[] = [];
  let endOfFlags = false;
  for (const a of argv) {
    if (!endOfFlags && a === "--") {
      endOfFlags = true;
      continue;
    }
    if (!endOfFlags && a.startsWith("-") && a.length > 1) {
      switch (a) {
        case "--json":
          flags.json = true;
          break;
        case "--force":
          flags.force = true;
          break;
        case "--stdin":
          flags.stdin = true;
          break;
        case "-h":
        case "--help":
          flags.help = true;
          break;
        default:
          return { flags, positional, error: `error: unknown option "${a}"` };
      }
      continue;
    }
    positional.push(a);
  }
  return { flags, positional };
}

/**
 * `ide-code desktop …` entry (spec §3.1, §5 P2). Returns the process exit
 * code; never calls process.exit itself (testable).
 */
export async function runDesktopBridge(argv: string[], opts: BridgeOptions = {}): Promise<number> {
  const out: Out = {
    stdout: opts.stdout ?? ((line) => process.stdout.write(line + "\n")),
    stderr: opts.stderr ?? ((line) => process.stderr.write(line + "\n")),
  };
  const timeoutMs = opts.requestTimeoutMs ?? REQUEST_TIMEOUT_MS;
  const parsed = parseArgv(argv);
  if (parsed.error) {
    out.stderr(parsed.error);
    out.stderr(USAGE);
    return 1;
  }
  if (parsed.flags.help || parsed.positional.length === 0) {
    out.stdout(USAGE);
    return 0;
  }
  const [command, ...rest] = parsed.positional;
  if (command !== "ls" && command !== "send") {
    out.stderr(`error: unknown desktop command "${command}"`);
    out.stderr(USAGE);
    return 1;
  }
  const instances = discoverInstances();
  if (instances.length === 0) {
    // Spec §5 P2-9: do NOT copy Cursor's silent-fallthrough quirk — print the
    // no-instance error properly.
    out.stderr("error: no running IDE Code desktop instance found");
    return 1;
  }
  if (command === "ls") {
    return cmdLs(instances, parsed.flags, timeoutMs, out);
  }
  return cmdSend(rest, parsed.flags, instances, timeoutMs, out);
}
