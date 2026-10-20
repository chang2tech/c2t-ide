/**
 * Sandbox policy schema + validation + layering.
 *
 * Ports Cursor's unified policy file format (docs/rea/dig-sandbox-2026-10-19.md §3)
 * as recovered from live parsing probes of `cursorsandbox` 3.25.9:
 *
 *   { sandbox: {...9 fields readwrite / 7 fields readonly...},
 *     networkPolicy: {version, default, allow, deny, logging?},
 *     networkPolicyStrict?: boolean, logging?: {...} }
 *
 * Important translation (verified LIVE against the binary): the user-facing
 * `sandbox.json` documents `additionalReadonlyPaths` as `string[]`, but the
 * policy file expects `MAP<path, subpath[]>`. `expandAdditionalReadonlyPaths()`
 * ports the `kt()` expansion from agent-exec: directories → {dir: ["**"]},
 * files → {parentDir: [base, "base/**"]}.
 *
 * HONESTY NOTE: this module builds and validates policy only. Enforcement
 * needs the native helper (`idesandbox`, spec Phase 2) or `bwrap` — see
 * landlock.ts / sandboxService.ts. Nothing here pretends to sandbox anything.
 */

import * as fs from "node:fs";
import * as path from "node:path";

export type SandboxType = "insecure_none" | "workspace_readwrite" | "workspace_readonly";
export type ReadBoundary = "system" | "workspace";
export type NetworkDefault = "allow" | "deny";

export interface SandboxFilesystemPolicy {
  readonly type: SandboxType;
  readonly cwd: string;
  /** "system" (default): executable may resolve anywhere. "workspace": the
   *  command executable itself must live inside the workspace boundary. */
  readonly readBoundary: ReadBoundary;
  readonly hardcodedReadPaths: string[];
  readonly additionalReadwritePaths: string[];
  /** Binary-JSON shape: MAP<path, subpath[]> — use expandAdditionalReadonlyPaths. */
  readonly additionalReadonlyPaths: Record<string, string[]>;
  readonly networkAccess: boolean;
  readonly disableTmpWrite: boolean;
  /** readwrite variant only */
  readonly blockGitWrite: boolean;
  /** readwrite variant only — compiled .ideignore denies */
  readonly ignoreMapping: Record<string, string[]>;
}

export interface NetworkPolicyLogging {
  readonly decisionLogPath: string;
  readonly logFormat: "jsonl";
}

export interface NetworkPolicy {
  readonly version: 1;
  readonly default: NetworkDefault;
  /** exact domains, "*.wildcards", CIDR */
  readonly allow: string[];
  readonly deny: string[];
  readonly logging?: NetworkPolicyLogging;
}

export interface UnifiedPolicy {
  readonly sandbox: SandboxFilesystemPolicy;
  readonly networkPolicy?: NetworkPolicy;
  /** forces network default to deny */
  readonly networkPolicyStrict?: boolean;
  readonly logging?: Record<string, unknown>;
}

/** User/repo-facing sandbox.json (cursor.com/docs/reference/sandbox). All optional. */
export interface SandboxJsonConfig {
  readonly type?: SandboxType;
  readonly additionalReadwritePaths?: string[];
  readonly additionalReadonlyPaths?: string[];
  readonly readBoundary?: ReadBoundary;
  /** Read Allowlist — only meaningful with readBoundary "workspace" */
  readonly additionalReadPaths?: string[];
  readonly disableTmpWrite?: boolean;
  readonly enableSharedBuildCache?: boolean;
  readonly networkPolicy?: {
    readonly default?: NetworkDefault;
    readonly allow?: string[];
    readonly deny?: string[];
  };
}

export const DEFAULT_SANDBOX_JSON: Required<
  Pick<
    SandboxJsonConfig,
    "type" | "readBoundary" | "disableTmpWrite" | "enableSharedBuildCache"
  >
> = {
  type: "workspace_readwrite",
  readBoundary: "system",
  disableTmpWrite: false,
  enableSharedBuildCache: false,
};

/**
 * Always write-protected regardless of config (DOCS: cursor.com/docs/reference/sandbox).
 * Hardcoded security rules — cannot be weakened by any layer.
 */
export const HARDCODED_WRITE_PROTECTED: string[] = [
  "**/.cursor/*.json",
  "**/.cursor/**/*.json",
  "**/.claude/**",
  "**/.vscode/**",
  "**/.code-workspace",
  "**/.git/hooks/**",
  "**/.git/config",
  "**/.git/info/attributes",
  "**/.cursorignore",
  "**/.ideignore",
  "**/.ide/*.json",
];

/** Writable exceptions inside the protected tree (OBSERVED binary strings). */
export const HARDCODED_WRITE_EXCEPTIONS: string[] = [
  "**/.cursor/rules/**",
  "**/.cursor/commands/**",
  "**/.cursor/worktrees/**",
  "**/.cursor/skills/**",
  "**/.cursor/agents/**",
  "**/.ide/rules/**",
  "**/.ide/commands/**",
  "**/.ide/worktrees/**",
  "**/.ide/skills/**",
  "**/.ide/agents/**",
];

/**
 * SSRF guard defaults (DOCS): RFC1918 + link-local metadata + IPv6 private are
 * blocked by default. Merged into the deny list at policy build time.
 */
export const SSRF_DENY_DEFAULTS: string[] = [
  "10.0.0.0/8",
  "172.16.0.0/12",
  "192.168.0.0/16",
  "169.254.169.254/32",
  "fc00::/7",
  "fe80::/10",
];

/**
 * Port of agent-exec `kt()`: expand the user-facing `string[]` form of
 * additionalReadonlyPaths into the binary's MAP<path, subpath[]> shape.
 */
export function expandAdditionalReadonlyPaths(
  paths: string[],
  isDirectory: (p: string) => boolean = defaultIsDirectory,
): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const p of paths) {
    if (isDirectory(p)) {
      out[p] = ["**"];
      continue;
    }
    const parent = parentDir(p);
    const base = baseName(p);
    const existing = out[parent] ?? [];
    if (!existing.includes(base)) existing.push(base);
    const glob = `${base}/**`;
    if (!existing.includes(glob)) existing.push(glob);
    out[parent] = existing;
  }
  return out;
}

function defaultIsDirectory(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    // Non-existent path: treat as a directory prefix (fail-closed would block
    // legitimate future dirs; Cursor expands missing paths as dirs too).
    return true;
  }
}

function parentDir(p: string): string {
  const d = path.dirname(p);
  return d === "" ? "." : d;
}

function baseName(p: string): string {
  return path.basename(p);
}

/** Config file locations, lowest → highest priority (.ide/ wins over .cursor/ at same scope). */
function configCandidates(homeDir: string, workspaceDir: string): string[] {
  // .ide/ is ours; .cursor/ is read-compat (Cursor parity: repo wins over user).
  return [
    path.join(homeDir, ".cursor", "sandbox.json"),
    path.join(homeDir, ".ide", "sandbox.json"),
    path.join(workspaceDir, ".cursor", "sandbox.json"),
    path.join(workspaceDir, ".ide", "sandbox.json"),
  ];
}

function readJsonFile(file: string): SandboxJsonConfig | undefined {
  try {
    const raw = fs.readFileSync(file, "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return undefined;
    return parsed as SandboxJsonConfig;
  } catch {
    return undefined;
  }
}

/**
 * Merge sandbox.json layers: user → repo (repo wins). `.ide/` wins over
 * `.cursor/` at the same scope. All present layers must agree on `type`
 * (OBSERVED agent-exec: "All policies must be of the same type").
 */
export function loadSandboxJsonLayers(
  homeDir: string,
  workspaceDir: string,
): SandboxJsonConfig {
  const merged: Record<string, unknown> = {};
  const seenTypes = new Set<string>();
  for (const file of configCandidates(homeDir, workspaceDir)) {
    const cfg = readJsonFile(file);
    if (!cfg) continue;
    if (cfg.type !== undefined) seenTypes.add(cfg.type);
    for (const [k, v] of Object.entries(cfg)) {
      if (v !== undefined) merged[k] = v;
    }
  }
  if (seenTypes.size > 1) {
    throw new Error(
      `All sandbox policies must be of the same type (found: ${[...seenTypes].join(", ")})`,
    );
  }
  return merged as SandboxJsonConfig;
}

/** Derived enforcement view: what the backend actually binds/denies. */
export interface FilesystemPlan {
  readonly cwd: string;
  readonly readwrite: string[];
  /** expanded MAP<path, subpath[]> — directories the sandbox may read */
  readonly readonlyMap: Record<string, string[]>;
  /** absolute-ish glob patterns that must be denied (blackholed) */
  readonly denied: string[];
  readonly disableTmpWrite: boolean;
  readonly networkAccess: boolean;
  readonly blockGitWrite: boolean;
}

/**
 * Build the filesystem plan from a unified policy: workspace + additional
 * readwrite paths are RW; expanded readonly map + hardcodedReadPaths are RO;
 * hardcoded write-protected globs (+ .git/hooks when blockGitWrite) are denied.
 * Denied always wins over allowed.
 */
export function planFilesystemAccess(
  policy: UnifiedPolicy,
  opts: { workspaceDir: string },
): FilesystemPlan {
  const sb = policy.sandbox;
  const workspaceDir = path.resolve(opts.workspaceDir);
  const readwrite = [
    workspaceDir,
    ...sb.additionalReadwritePaths.map((p) => path.resolve(workspaceDir, p)),
  ];
  const readonlyMap: Record<string, string[]> = { ...sb.additionalReadonlyPaths };
  for (const p of sb.hardcodedReadPaths) readonlyMap[p] = ["**"];
  const denied = [...HARDCODED_WRITE_PROTECTED];
  if (sb.blockGitWrite) denied.push("**/.git/**");
  return {
    cwd: sb.cwd,
    readwrite,
    readonlyMap,
    denied,
    disableTmpWrite: sb.disableTmpWrite,
    networkAccess: sb.networkAccess,
    blockGitWrite: sb.blockGitWrite,
  };
}

/**
 * Build the unified (binary-facing) policy from the merged sandbox.json +
 * hardcoded rules. Applies networkPolicyStrict (forces default deny) and the
 * SSRF deny defaults.
 */
export function buildUnifiedPolicy(
  config: SandboxJsonConfig,
  opts: { workspaceDir: string; cwd?: string; decisionLogPath?: string },
): UnifiedPolicy {
  const type = config.type ?? DEFAULT_SANDBOX_JSON.type;
  const readBoundary = config.readBoundary ?? DEFAULT_SANDBOX_JSON.readBoundary;
  const netCfg = config.networkPolicy;
  const netDefault: NetworkDefault = netCfg?.default ?? "deny";
  const networkPolicy: NetworkPolicy = {
    version: 1,
    default: netDefault,
    allow: [...(netCfg?.allow ?? [])],
    deny: [...SSRF_DENY_DEFAULTS, ...(netCfg?.deny ?? [])],
    ...(opts.decisionLogPath
      ? { logging: { decisionLogPath: opts.decisionLogPath, logFormat: "jsonl" as const } }
      : {}),
  };
  const isReadonly = type === "workspace_readonly";
  const sandbox: SandboxFilesystemPolicy = {
    type,
    cwd: opts.cwd ?? opts.workspaceDir,
    readBoundary,
    hardcodedReadPaths: [],
    additionalReadwritePaths: isReadonly ? [] : [...(config.additionalReadwritePaths ?? [])],
    additionalReadonlyPaths: expandAdditionalReadonlyPaths([
      ...(config.additionalReadonlyPaths ?? []),
      ...(config.additionalReadPaths ?? []),
    ]),
    networkAccess: true,
    disableTmpWrite: config.disableTmpWrite ?? DEFAULT_SANDBOX_JSON.disableTmpWrite,
    blockGitWrite: isReadonly ? false : true,
    ignoreMapping: isReadonly ? {} : {},
  };
  return { sandbox, networkPolicy };
}

export interface PolicyValidation {
  readonly ok: boolean;
  readonly errors: string[];
}

/**
 * Structural validation of the unified policy (mirrors the binary's parse
 * checks as recovered by live fuzzing): required sandbox block, literal
 * fields, array shapes, and the readwrite(9)/readonly(7) field-count rule —
 * the readonly variant must NOT carry additionalReadwritePaths/blockGitWrite.
 */
export function validateUnifiedPolicy(value: unknown): PolicyValidation {
  const errors: string[] = [];
  if (typeof value !== "object" || value === null) {
    return { ok: false, errors: ["policy must be an object"] };
  }
  const p = value as Record<string, unknown>;
  const sb = p["sandbox"];
  if (typeof sb !== "object" || sb === null) {
    return { ok: false, errors: ["policy.sandbox is required"] };
  }
  const s = sb as Record<string, unknown>;
  const isType = (v: unknown): v is SandboxType =>
    v === "insecure_none" || v === "workspace_readwrite" || v === "workspace_readonly";
  if (!isType(s["type"])) errors.push(`sandbox.type must be one of insecure_none|workspace_readwrite|workspace_readonly`);
  if (typeof s["cwd"] !== "string" || s["cwd"] === "")
    errors.push("sandbox.cwd must be a non-empty string");
  if (s["readBoundary"] !== "system" && s["readBoundary"] !== "workspace")
    errors.push('sandbox.readBoundary must be "system" or "workspace"');
  for (const f of ["hardcodedReadPaths", "additionalReadwritePaths"] as const) {
    if (!Array.isArray(s[f]) || !s[f].every((x) => typeof x === "string"))
      errors.push(`sandbox.${f} must be string[]`);
  }
  const ro = s["additionalReadonlyPaths"];
  if (typeof ro !== "object" || ro === null || Array.isArray(ro)) {
    errors.push("sandbox.additionalReadonlyPaths must be a map (use expandAdditionalReadonlyPaths)");
  } else {
    for (const [k, v] of Object.entries(ro)) {
      if (typeof k !== "string" || !Array.isArray(v) || !v.every((x) => typeof x === "string"))
        errors.push(`sandbox.additionalReadonlyPaths[${k}] must be string[]`);
    }
  }
  if (typeof s["networkAccess"] !== "boolean") errors.push("sandbox.networkAccess must be boolean");
  if (typeof s["disableTmpWrite"] !== "boolean") errors.push("sandbox.disableTmpWrite must be boolean");
  const isReadonly = s["type"] === "workspace_readonly";
  const rwPaths = s["additionalReadwritePaths"];
  if (isReadonly && Array.isArray(rwPaths) && rwPaths.length > 0)
    errors.push("workspace_readonly must not carry additionalReadwritePaths");
  if (isReadonly && s["blockGitWrite"] === true)
    errors.push("workspace_readonly must not carry blockGitWrite");
  if (!isReadonly && typeof s["blockGitWrite"] !== "boolean")
    errors.push("sandbox.blockGitWrite must be boolean (readwrite variant)");
  const im = s["ignoreMapping"];
  if (typeof im !== "object" || im === null || Array.isArray(im))
    errors.push("sandbox.ignoreMapping must be a map");
  const np = p["networkPolicy"];
  if (np !== undefined) {
    if (typeof np !== "object" || np === null) errors.push("networkPolicy must be an object");
    else {
      const n = np as Record<string, unknown>;
      if (n["version"] !== 1) errors.push("networkPolicy.version must be 1");
      if (n["default"] !== "allow" && n["default"] !== "deny")
        errors.push('networkPolicy.default must be "allow" or "deny"');
      for (const f of ["allow", "deny"] as const) {
        if (!Array.isArray(n[f]) || !n[f].every((x) => typeof x === "string"))
          errors.push(`networkPolicy.${f} must be string[]`);
      }
    }
  }
  if (p["networkPolicyStrict"] !== undefined && typeof p["networkPolicyStrict"] !== "boolean")
    errors.push("networkPolicyStrict must be boolean");
  return { ok: errors.length === 0, errors };
}

/** networkPolicyStrict forces the network default to deny (OBSERVED). */
export function applyNetworkPolicyStrict(policy: UnifiedPolicy): UnifiedPolicy {
  if (!policy.networkPolicyStrict || !policy.networkPolicy) return policy;
  return {
    ...policy,
    networkPolicy: { ...policy.networkPolicy, default: "deny" },
  };
}
