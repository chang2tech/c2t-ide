import * as vscode from "vscode";
import * as fs from "node:fs";
import * as path from "node:path";

/**
 * `.cursor/permissions.json` loader (P2, rex-004, DEV-GAPS-10).
 *
 * Mirrors Cursor's `extensions/cursor-always-local/schemas/permissions.schema.json`:
 * properties `mcpAllowlist` / `terminalAllowlist` / `approvalMode` /
 * `autoRun` / `autoReview`, with `approvalMode` enum `[allowlist,
 * unrestricted, manual]` (manual = Ask Every Time), contributed via
 * `contributes.jsonValidation` (fileMatch `.cursor/permissions.json` — see
 * package.json and `schemas/permissions.schema.json`).
 *
 * Behavior:
 * - Reads `<workspace>/.cursor/permissions.json` at startup and re-reads on
 *   every change (FileSystemWatcher). Deletion clears the policy.
 * - Invalid JSON or schema violations → warning logged, CURRENT policy kept
 *   (never crashes, never silently degrades to unrestricted).
 * - The validated policy is applied to HumanReviewService — the single
 *   approval choke point — via ChatTabService.setFilePermissions (all tabs,
 *   present and future).
 *
 * HONEST-DIVERGENCE: `autoRun` / `autoReview` are parsed + validated (they
 * are in Cursor's schema) but their exact Cursor semantics are UNKNOWN, so
 * they are stored and NOT applied to behavior. Only mcpAllowlist,
 * terminalAllowlist, and approvalMode change approval decisions.
 */

/** Binary-verbatim approvalMode enum. */
export const PERMISSIONS_APPROVAL_MODES = ["allowlist", "unrestricted", "manual"] as const;
export type PermissionsApprovalMode = (typeof PERMISSIONS_APPROVAL_MODES)[number];

/** File name (relative to the workspace root) — verbatim from Cursor. */
export const PERMISSIONS_FILE_REL = path.join(".cursor", "permissions.json");

export interface CursorPermissionsPolicy {
  mcpAllowlist: string[];
  terminalAllowlist: string[];
  approvalMode: PermissionsApprovalMode;
  /** Parsed; semantics UNKNOWN — not applied (see header). */
  autoRun: boolean;
  /** Parsed; semantics UNKNOWN — not applied (see header). */
  autoReview: boolean;
}

export const DEFAULT_PERMISSIONS_POLICY: CursorPermissionsPolicy = {
  mcpAllowlist: [],
  terminalAllowlist: [],
  approvalMode: "allowlist",
  autoRun: false,
  autoReview: false,
};

export type PermissionsValidation =
  | { ok: true; policy: CursorPermissionsPolicy }
  | { ok: false; errors: string[] };

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((e) => typeof e === "string");
}

/**
 * Validate a parsed `.cursor/permissions.json` value. Pure — unit-tested.
 * Unknown properties are ignored (forward compatibility).
 */
export function validateCursorPermissions(raw: unknown): PermissionsValidation {
  const errors: string[] = [];
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { ok: false, errors: ["permissions.json must be a JSON object"] };
  }
  const v = raw as Record<string, unknown>;
  const policy: CursorPermissionsPolicy = { ...DEFAULT_PERMISSIONS_POLICY };

  if (v.mcpAllowlist !== undefined) {
    if (!isStringArray(v.mcpAllowlist)) {
      errors.push('mcpAllowlist must be an array of strings ("server:tool" / "server:*")');
    } else {
      const bad = v.mcpAllowlist.filter((p) => !/^[^:]+:[^:]+$/.test(p));
      if (bad.length > 0) {
        errors.push(`mcpAllowlist entries must look like "server:tool" or "server:*": ${bad.join(", ")}`);
      } else {
        policy.mcpAllowlist = [...v.mcpAllowlist];
      }
    }
  }
  if (v.terminalAllowlist !== undefined) {
    if (!isStringArray(v.terminalAllowlist)) {
      errors.push("terminalAllowlist must be an array of strings (command glob patterns)");
    } else {
      policy.terminalAllowlist = [...v.terminalAllowlist];
    }
  }
  if (v.approvalMode !== undefined) {
    if (
      typeof v.approvalMode !== "string" ||
      !(PERMISSIONS_APPROVAL_MODES as readonly string[]).includes(v.approvalMode)
    ) {
      errors.push(
        `approvalMode must be one of ${PERMISSIONS_APPROVAL_MODES.join(" | ")} (got ${JSON.stringify(v.approvalMode)})`,
      );
    } else {
      policy.approvalMode = v.approvalMode as PermissionsApprovalMode;
    }
  }
  if (v.autoRun !== undefined) {
    if (typeof v.autoRun !== "boolean") {
      errors.push("autoRun must be a boolean");
    } else {
      policy.autoRun = v.autoRun;
    }
  }
  if (v.autoReview !== undefined) {
    if (typeof v.autoReview !== "boolean") {
      errors.push("autoReview must be a boolean");
    } else {
      policy.autoReview = v.autoReview;
    }
  }
  return errors.length > 0 ? { ok: false, errors } : { ok: true, policy };
}

/** `*` matches any (possibly empty) run of characters; everything else literal. */
function globToRegExp(glob: string): RegExp {
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");
  return new RegExp(`^${escaped}$`);
}

/**
 * Match an MCP tool against `server:tool` / `server:*` patterns.
 * `*` is allowed in either segment (`*:*` matches everything).
 */
export function matchMcpAllowlist(patterns: string[], server: string, tool: string): boolean {
  return patterns.some((p) => {
    const idx = p.indexOf(":");
    if (idx < 0) {
      return false;
    }
    const serverPat = p.slice(0, idx);
    const toolPat = p.slice(idx + 1);
    return globToRegExp(serverPat).test(server) && globToRegExp(toolPat).test(tool);
  });
}

/** Match shell command text against terminalAllowlist glob patterns. */
export function matchTerminalAllowlist(patterns: string[], commandText: string): boolean {
  const cmd = commandText.trim();
  return patterns.some((p) => globToRegExp(p).test(cmd));
}

/** Split an allowlist identity `action::res1\0res2` (see ideCodeEngineAdapter). */
export function splitAllowlistIdentity(identity: string): { action: string; resources: string[] } {
  const idx = identity.indexOf("::");
  if (idx < 0) {
    return { action: identity, resources: [] };
  }
  return {
    action: identity.slice(0, idx),
    resources: identity.slice(idx + 2).split("\x00"),
  };
}

/** Parse `mcp__<server>__<tool>` engine actions. */
export function parseMcpAction(action: string): { server: string; tool: string } | undefined {
  if (!action.startsWith("mcp__")) {
    return undefined;
  }
  const parts = action.split("__");
  if (parts.length < 3 || !parts[1]) {
    return undefined;
  }
  return { server: parts[1], tool: parts.slice(2).join("__") };
}

/**
 * Engine actions that represent terminal/shell execution.
 * HONEST-DIVERGENCE: the exact action strings are engine-defined (the
 * sidecar sends `bash`); this set covers the known variants.
 * Exported for the shell-approval label wiring (GAPS-22B).
 */
export const TERMINAL_ACTIONS = new Set(["bash", "shell", "shell_tool_call"]);

/**
 * Decide whether a `.cursor/permissions.json` policy auto-approves a tool
 * call. Returns true = auto-approve (approve-once), false = normal flow.
 * `approvalMode: "manual"` (Ask Every Time) and `"unrestricted"` are handled
 * by the caller (HumanReviewService) — this only evaluates the allowlists.
 */
export function matchesFileAllowlist(
  policy: CursorPermissionsPolicy,
  identity: string,
): boolean {
  const { action, resources } = splitAllowlistIdentity(identity);
  const mcp = parseMcpAction(action);
  if (mcp) {
    return matchMcpAllowlist(policy.mcpAllowlist, mcp.server, mcp.tool);
  }
  if (TERMINAL_ACTIONS.has(action)) {
    const commandText = resources[0] ?? "";
    return matchTerminalAllowlist(policy.terminalAllowlist, commandText);
  }
  return false;
}

export interface PermissionsFileServiceDeps {
  workspaceFolders: () => readonly { uri: { fsPath: string } }[] | undefined;
  applyPolicy: (policy: CursorPermissionsPolicy | undefined) => void;
  logWarning: (message: string) => void;
  logInfo: (message: string) => void;
  /** Injectable for tests (defaults to node:fs). */
  readFile?: (absPath: string) => string;
  /** Injectable for tests (defaults to vscode.workspace.createFileSystemWatcher). */
  createWatcher?: (pattern: string) => vscode.FileSystemWatcher;
}

export class CursorPermissionsFileService {
  private watcher: vscode.FileSystemWatcher | undefined;
  private started = false;

  constructor(private readonly deps: PermissionsFileServiceDeps) {}

  private permissionsPath(): string | undefined {
    const folders = this.deps.workspaceFolders();
    const root = folders?.[0]?.uri.fsPath;
    return root ? path.join(root, PERMISSIONS_FILE_REL) : undefined;
  }

  /** Load (or reload) the file. Invalid JSON/schema → warn, keep current policy. */
  reload(): void {
    const absPath = this.permissionsPath();
    if (!absPath) {
      return;
    }
    let raw: string;
    try {
      raw = this.deps.readFile ? this.deps.readFile(absPath) : fs.readFileSync(absPath, "utf8");
    } catch (err) {
      // Missing file on reload (deleted between watcher events, etc.) —
      // clear the policy; a missing file at startup simply means no policy.
      if ((err as NodeJS.ErrnoException)?.code === "ENOENT") {
        this.deps.applyPolicy(undefined);
        return;
      }
      this.deps.logWarning(`IDE Agent: could not read .cursor/permissions.json — ${err instanceof Error ? err.message : String(err)}. Keeping current approval policy.`);
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      this.deps.logWarning(
        `IDE Agent: .cursor/permissions.json is not valid JSON (${err instanceof Error ? err.message : String(err)}). Keeping current approval policy.`,
      );
      return;
    }
    const result = validateCursorPermissions(parsed);
    if (!result.ok) {
      this.deps.logWarning(
        `IDE Agent: .cursor/permissions.json is invalid — ${result.errors.join("; ")}. Keeping current approval policy.`,
      );
      return;
    }
    this.deps.applyPolicy(result.policy);
    this.deps.logInfo(
      `IDE Agent: applied .cursor/permissions.json (approvalMode=${result.policy.approvalMode}, ` +
        `mcpAllowlist=${result.policy.mcpAllowlist.length}, terminalAllowlist=${result.policy.terminalAllowlist.length})`,
    );
  }

  /** Start watching. Idempotent. */
  start(): vscode.Disposable {
    if (this.started) {
      return { dispose: () => undefined };
    }
    this.started = true;
    this.reload();
    const createWatcher =
      this.deps.createWatcher ?? ((pattern: string) => vscode.workspace.createFileSystemWatcher(pattern));
    // Watch every workspace's .cursor/permissions.json.
    this.watcher = createWatcher("**/.cursor/permissions.json");
    this.watcher.onDidChange(() => this.reload());
    this.watcher.onDidCreate(() => this.reload());
    this.watcher.onDidDelete(() => {
      this.deps.applyPolicy(undefined);
      this.deps.logInfo("IDE Agent: .cursor/permissions.json deleted — cleared file approval policy.");
    });
    return {
      dispose: () => {
        this.watcher?.dispose();
        this.watcher = undefined;
      },
    };
  }
}
