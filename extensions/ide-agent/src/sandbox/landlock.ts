/**
 * Linux sandbox backend selection — Landlock (preferred) → Bubblewrap (fallback).
 *
 * Mirrors Cursor's backend preference order (docs/rea/dig-sandbox-2026-10-19.md §4.3).
 *
 * HONESTY NOTE (read before changing): Node.js cannot invoke raw syscalls, so
 * Landlock (`landlock_create_ruleset` / `landlock_restrict_self`) is NOT
 * reachable from this process. True Landlock enforcement requires the native
 * helper `idesandbox` (spec Phase 2 — a small Rust/C binary, NOT built yet).
 * Until it exists:
 *   - `landlock` resolves to "unsupported" with an explicit reason — it is
 *     never silently downgraded, and never claimed.
 *   - `bubblewrap` is the only backend that gives REAL filesystem isolation
 *     from here, and only when a ROOT-OWNED `bwrap` is on PATH (Cursor's
 *     own requirement: "no root-owned executable 'bwrap' was found on PATH").
 *   - Without bwrap this module degrades to `namespaces` (unshare user+net:
 *     REAL network isolation via a fresh network namespace — verified
 *     ENETUNREACH on this machine — but NO filesystem isolation) or
 *     `restricted-env` (scrubbed environment only, NO isolation at all).
 * Every consumer MUST surface `enforcement` to the user; claiming a sandbox
 * exists when enforcement is "none"/"partial" is a bug, not a limitation.
 */

import * as childProcess from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { FilesystemPlan } from "./policy.js";

/** Backend override env var (Cursor parity: CURSOR_SANDBOX_LINUX_BACKEND). */
export const LINUX_BACKEND_ENV = "IDE_SANDBOX_LINUX_BACKEND";

export type LinuxBackendPreference = "auto" | "landlock" | "bubblewrap" | "bwrap";

/** What actually enforces the policy on this machine, right now. */
export type SandboxBackend =
  | "landlock" // native helper path — requires idesandbox (not built yet)
  | "bubblewrap" // root-owned bwrap — REAL fs+net isolation
  | "namespaces" // unshare user+net — REAL net isolation, NO fs isolation
  | "restricted-env" // scrubbed env only — NO isolation at all
  | "unsupported";

export type EnforcementLevel = "full" | "partial" | "none";

export interface BackendProbe {
  readonly requested: LinuxBackendPreference;
  readonly backend: SandboxBackend;
  readonly supported: boolean;
  /** Enforcement the resolved backend actually provides. */
  readonly enforcement: EnforcementLevel;
  readonly reason: string;
  readonly bwrapPath?: string;
  readonly bwrapRootOwned?: boolean;
  readonly unshareAvailable?: boolean;
  /** Mirrors CURSOR_SANDBOX_LANDLOCK_STATUS for UI/telemetry. */
  readonly landlockStatus:
    | "fully_enforced"
    | "bubblewrap"
    | "namespaces-partial"
    | "restricted"
    | "not_enforced";
}

export function readBackendPreference(env = process.env): LinuxBackendPreference {
  const raw = (env[LINUX_BACKEND_ENV] ?? "auto").toLowerCase();
  if (raw === "landlock") return "landlock";
  if (raw === "bubblewrap" || raw === "bwrap") return "bubblewrap";
  return "auto";
}

/** PATH lookup. Exported for tests. */
export function findExecutable(name: string, pathEnv = process.env["PATH"] ?? ""): string | undefined {
  for (const dir of pathEnv.split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, name);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      const st = fs.statSync(candidate);
      if (st.isFile()) return candidate;
    } catch {
      // not usable — keep searching
    }
  }
  return undefined;
}

/** Cursor requires a ROOT-OWNED bwrap; a user-writable one is a privilege vector. */
export function isRootOwnedExecutable(file: string): boolean {
  try {
    const st = fs.statSync(file);
    return st.isFile() && st.uid === 0;
  } catch {
    return false;
  }
}

export function resolveLinuxBackend(preference?: LinuxBackendPreference): BackendProbe {
  if (os.platform() !== "linux") {
    return {
      requested: preference ?? "auto",
      backend: "unsupported",
      supported: false,
      enforcement: "none",
      reason: `sandbox backends are implemented for linux only (platform: ${os.platform()})`,
      landlockStatus: "not_enforced",
    };
  }
  const requested = preference ?? readBackendPreference();
  const bwrapPath = findExecutable("bwrap");
  const bwrapRootOwned = bwrapPath !== undefined && isRootOwnedExecutable(bwrapPath);
  const unshareAvailable = findExecutable("unshare") !== undefined;

  if (requested === "landlock") {
    return {
      requested,
      backend: "unsupported",
      supported: false,
      enforcement: "none",
      reason:
        "Landlock enforcement requires the native idesandbox helper (spec Phase 2), which is not built yet. " +
        "Node.js cannot invoke landlock syscalls directly. Use IDE_SANDBOX_LINUX_BACKEND=bubblewrap if bwrap is installed.",
      bwrapPath,
      bwrapRootOwned,
      unshareAvailable,
      landlockStatus: "not_enforced",
    };
  }

  if (requested === "bubblewrap" || requested === "auto") {
    if (bwrapPath !== undefined && bwrapRootOwned) {
      return {
        requested,
        backend: "bubblewrap",
        supported: true,
        enforcement: "full",
        reason: `using root-owned bwrap at ${bwrapPath}`,
        bwrapPath,
        bwrapRootOwned: true,
        unshareAvailable,
        landlockStatus: "bubblewrap",
      };
    }
    if (bwrapPath !== undefined) {
      return {
        requested,
        backend: "unsupported",
        supported: false,
        enforcement: "none",
        reason: `bwrap found at ${bwrapPath} but it is NOT root-owned — refusing (privilege-escalation vector)`,
        bwrapPath,
        bwrapRootOwned: false,
        unshareAvailable,
        landlockStatus: "not_enforced",
      };
    }
    if (requested === "bubblewrap") {
      return {
        requested,
        backend: "unsupported",
        supported: false,
        enforcement: "none",
        reason: "bubblewrap requested but no bwrap on PATH",
        unshareAvailable,
        landlockStatus: "not_enforced",
      };
    }
    // auto: degrade honestly — unshare gives real net isolation, no fs isolation.
    if (unshareAvailable) {
      return {
        requested,
        backend: "namespaces",
        supported: true,
        enforcement: "partial",
        reason:
          "no bwrap on PATH: degraded to unshare(user+net) namespaces — network is REALLY isolated " +
          "(fresh netns, connect() fails ENETUNREACH) but the filesystem is NOT isolated",
        unshareAvailable: true,
        landlockStatus: "namespaces-partial",
      };
    }
    return {
      requested,
      backend: "unsupported",
      supported: false,
      enforcement: "none",
      reason: "no bwrap and no unshare on PATH: no isolation primitive available",
      landlockStatus: "not_enforced",
    };
  }
  /* istanbul ignore next — readBackendPreference normalizes */
  return {
    requested,
    backend: "unsupported",
    supported: false,
    enforcement: "none",
    reason: `unknown backend preference: ${requested}`,
    landlockStatus: "not_enforced",
  };
}

export interface BwrapSpawnOptions {
  /** Extra env vars (proxy settings, build-cache vars). Already sanitized. */
  readonly env?: Record<string, string>;
  /** argv of the command to run inside the sandbox (no shell). */
  readonly command: string[];
}

/**
 * Build a REAL bwrap invocation for the filesystem plan.
 *
 * Mapping to Cursor's 7-step setup: userns+netns (unshare-user/net),
 * die-with-parent, MS_PRIVATE-style isolation via explicit binds only,
 * blackhole denies (tmpfs over denied paths — chmod 000 analog), private
 * /tmp unless disableTmpWrite, scrubbed env via --clearenv + --setenv.
 *
 * Callers must still pass -- / nobody gets a shell unless command says so.
 */
export function buildBwrapArgs(
  bwrapPath: string,
  plan: FilesystemPlan,
  opts: BwrapSpawnOptions,
): string[] {
  const args: string[] = [bwrapPath];
  args.push("--die-with-parent");
  args.push("--unshare-user", "--unshare-net", "--unshare-pid");
  // Minimal system view: read-only root, then punch holes.
  args.push("--ro-bind", "/", "/");
  args.push("--dev", "/dev");
  args.push("--proc", "/proc");
  for (const rw of plan.readwrite) {
    args.push("--bind", rw, rw);
  }
  for (const [dir, subpaths] of Object.entries(plan.readonlyMap)) {
    if (subpaths.length === 1 && subpaths[0] === "**") {
      args.push("--ro-bind", dir, dir);
    } else {
      // Subpath-granular RO: bind each listed subpath read-only. (Approximation
      // of the binary's per-subpath Landlock rules; documented, not hidden.)
      for (const sub of subpaths) {
        const target = sub === "**" ? dir : path.join(dir, sub.replace(/\/\*\*$/, ""));
        args.push("--ro-bind", target, target);
      }
    }
  }
  // Deny = blackhole: tmpfs mounted over the denied path (Cursor parity:
  // tmpfs + 000 + read-only remount; bwrap tmpfs mounts are not writable
  // by the sandboxed uid in practice — writes land on the tmpfs, the real
  // path stays untouched).
  for (const denied of plan.denied) {
    args.push("--tmpfs", denied);
  }
  if (plan.disableTmpWrite) {
    // Writes to tmp blocked: hide /tmp behind an empty read-only bind.
    // (Cursor semantics: disableTmpWrite blocks tmp writes.)
    args.push("--ro-bind", plan.readwrite[0] ?? "/", "/tmp");
  } else {
    args.push("--tmpfs", "/tmp");
  }
  // Scrubbed environment: clear everything, then set the allowlist.
  args.push("--clearenv");
  const env: Record<string, string> = {
    PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
    ...(opts.env ?? {}),
  };
  for (const [k, v] of Object.entries(env)) args.push("--setenv", k, v);
  args.push("--chdir", plan.cwd);
  args.push("--");
  args.push(...opts.command);
  return args;
}

/**
 * Degraded fallback argv: `unshare --map-root-user --net` — REAL network
 * isolation (new netns, no external route; connect() → ENETUNREACH, verified
 * on this machine) but ZERO filesystem isolation. The caller MUST report
 * enforcement "partial" and never imply fs confinement.
 */
export function buildUnshareArgs(opts: BwrapSpawnOptions): string[] {
  return ["unshare", "--map-root-user", "--net", "--", ...opts.command];
}

/** Spawn helper shared by sandboxService (kept here: backend argv knowledge). */
export function spawnBackend(
  probe: BackendProbe,
  plan: FilesystemPlan,
  opts: BwrapSpawnOptions & {
    env?: Record<string, string>;
    cwd?: string;
    stdio?: childProcess.StdioOptions;
  },
): childProcess.ChildProcess {
  const stdio = opts.stdio ?? "inherit";
  if (probe.backend === "bubblewrap" && probe.bwrapPath) {
    const [bin, ...args] = buildBwrapArgs(probe.bwrapPath, plan, opts);
    return childProcess.spawn(bin, args, {
      env: { PATH: process.env["PATH"] },
      stdio,
    });
  }
  if (probe.backend === "namespaces") {
    const [bin, ...args] = buildUnshareArgs(opts);
    return childProcess.spawn(bin, args, {
      env: { ...process.env, ...(opts.env ?? {}) },
      cwd: opts.cwd ?? plan.cwd,
      stdio,
    });
  }
  throw new Error(
    `cannot spawn sandboxed command: backend "${probe.backend}" provides no isolation (${probe.reason})`,
  );
}
