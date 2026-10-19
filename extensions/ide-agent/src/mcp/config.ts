/**
 * MCP config discovery + variable expansion — parity §B1.
 *
 * Discovery paths (watched live by the service):
 *   <workspace>/.cursor/mcp.json      (project)
 *   ~/.cursor/mcp.json                 (user)
 *   <workspace>/.vscode/mcp.json       (VS Code compat)
 * Precedence: project > user > vscode. A server name defined in a higher-
 * precedence file wins; the loser is dropped (with a warning).
 *
 * Variable expansion (per Cursor DOCS — an improvement over the observed
 * 3.25.6 client, which expands nothing): ${env:NAME}, ${userHome},
 * ${workspaceFolder}, ${workspaceFolderBasename}, ${pathSeparator}, ${/}
 * resolved in command, args, env, url, headers. Plus `envFile` support.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  ConfiguredServer,
  McpConfigFile,
  McpLogger,
  McpServerConfig,
  McpServerScope,
} from "./types";
import { serverId } from "./names";

export interface McpDiscoveryContext {
  /** Absolute workspace folder paths (roots). */
  workspaceFolders: string[];
  logger: McpLogger;
}

interface RawEntry {
  scope: McpServerScope;
  name: string;
  sourcePath: string;
  config: McpServerConfig;
}

/** Candidate config files in precedence order (highest first). */
export function candidateConfigFiles(workspaceFolders: string[]): Array<{
  scope: McpServerScope;
  path: string;
}> {
  const home = os.homedir();
  const out: Array<{ scope: McpServerScope; path: string }> = [];
  for (const root of workspaceFolders) {
    out.push({ scope: "project", path: path.join(root, ".cursor", "mcp.json") });
  }
  out.push({ scope: "user", path: path.join(home, ".cursor", "mcp.json") });
  for (const root of workspaceFolders) {
    out.push({ scope: "vscode", path: path.join(root, ".vscode", "mcp.json") });
  }
  return out;
}

function readConfigFile(filePath: string, logger: McpLogger): McpConfigFile | undefined {
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, "utf8");
  } catch {
    return undefined; // absent — not an error
  }
  try {
    const parsed = JSON.parse(raw) as McpConfigFile;
    if (!parsed || typeof parsed !== "object" || !parsed.mcpServers) {
      logger.appendLine(`[mcp] ${filePath}: no "mcpServers" object — ignoring file`);
      return undefined;
    }
    return parsed;
  } catch (err) {
    logger.appendLine(
      `[mcp] ${filePath}: invalid JSON (${err instanceof Error ? err.message : String(err)}) — ignoring file`,
    );
    return undefined;
  }
}

/** Minimal dotenv parser for `envFile` (KEY=VALUE, # comments, quotes). */
export function parseEnvFile(content: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    out[trimmed.slice(0, eq).trim()] = value;
  }
  return out;
}

export interface ExpansionContext {
  workspaceFolder: string;
  env: NodeJS.ProcessEnv;
}

/**
 * Expand ${...} variables in a single string.
 * Unknown variables are left literal and reported via onUnknown.
 */
export function expandVariables(
  value: string,
  ctx: ExpansionContext,
  onUnknown?: (name: string) => void,
): string {
  return value.replace(/\$\{([^}]+)\}/g, (match, name: string) => {
    if (name.startsWith("env:")) {
      const v = ctx.env[name.slice(4)];
      if (v === undefined) {
        onUnknown?.(name);
        return match;
      }
      return v;
    }
    switch (name) {
      case "userHome":
        return os.homedir();
      case "workspaceFolder":
        return ctx.workspaceFolder;
      case "workspaceFolderBasename":
        return path.basename(ctx.workspaceFolder);
      case "pathSeparator":
        return path.sep;
      case "/":
        return path.sep;
      default:
        onUnknown?.(name);
        return match;
    }
  });
}

function expandRecord(
  record: Record<string, string> | undefined,
  ctx: ExpansionContext,
  onUnknown?: (name: string) => void,
): Record<string, string> | undefined {
  if (!record) return undefined;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(record)) {
    out[k] = expandVariables(v, ctx, onUnknown);
  }
  return out;
}

function expandStringArray(
  arr: string[] | undefined,
  ctx: ExpansionContext,
  onUnknown?: (name: string) => void,
): string[] | undefined {
  return arr?.map((s) => expandVariables(s, ctx, onUnknown));
}

/**
 * Expand one server config: variables in command/args/env/url/headers,
 * envFile merged in (file values lose to explicit `env`), then stdio env
 * injection per §B2 (WORKSPACE_FOLDER_PATHS, npm_config_yes).
 */
export function expandServerConfig(
  raw: McpServerConfig,
  opts: { workspaceFolders: string[]; configDir: string; logger: McpLogger },
): McpServerConfig {
  const workspaceFolder = opts.workspaceFolders[0] ?? opts.configDir;
  const expCtx: ExpansionContext = { workspaceFolder, env: process.env };
  const unknown = new Set<string>();
  const onUnknown = (name: string) => {
    unknown.add(name);
  };

  // envFile first (lowest precedence within this server's env)
  let fileEnv: Record<string, string> = {};
  const envFiles = raw.envFile === undefined ? [] : Array.isArray(raw.envFile) ? raw.envFile : [raw.envFile];
  for (const ef of envFiles) {
    const resolved = path.isAbsolute(ef) ? ef : path.join(opts.configDir, ef);
    try {
      fileEnv = { ...fileEnv, ...parseEnvFile(fs.readFileSync(resolved, "utf8")) };
    } catch {
      opts.logger.appendLine(`[mcp] envFile not readable: ${resolved} — skipping`);
    }
  }

  const mergedEnv = { ...fileEnv, ...(raw.env ?? {}) };
  const expandedEnv = expandRecord(mergedEnv, expCtx, onUnknown);
  // §B2 stdio env injection (always)
  if (expandedEnv) {
    expandedEnv["WORKSPACE_FOLDER_PATHS"] = opts.workspaceFolders.join(",");
    expandedEnv["npm_config_yes"] = "true";
    expandedEnv["NPM_CONFIG_YES"] = "true";
  }

  if (unknown.size > 0) {
    // P3-1: log a count, not the names — an unknown ${env:NAME} reveals which
    // secrets the config expects (minor info disclosure).
    opts.logger.appendLine(
      `[mcp] ${unknown.size} unknown variable(s) left unexpanded (names redacted)`,
    );
  }

  return {
    ...raw,
    command: raw.command === undefined ? undefined : expandVariables(raw.command, expCtx, onUnknown),
    args: expandStringArray(raw.args, expCtx, onUnknown),
    env: expandedEnv,
    url: raw.url === undefined ? undefined : expandVariables(raw.url, expCtx, onUnknown),
    headers: expandRecord(raw.headers, expCtx, onUnknown),
    cwd:
      raw.cwd === undefined
        ? undefined
        : path.isAbsolute(expandVariables(raw.cwd, expCtx, onUnknown))
          ? expandVariables(raw.cwd, expCtx, onUnknown)
          : path.join(opts.configDir, expandVariables(raw.cwd, expCtx, onUnknown)),
  };
}

/**
 * Discover + merge all MCP server configs. Returns expanded servers, highest
 * precedence first-wins on name collisions.
 */
export function discoverServers(ctx: McpDiscoveryContext): ConfiguredServer[] {
  const seen = new Set<string>();
  const out: ConfiguredServer[] = [];

  for (const candidate of candidateConfigFiles(ctx.workspaceFolders)) {
    const file = readConfigFile(candidate.path, ctx.logger);
    if (!file?.mcpServers) continue;
    for (const [name, raw] of Object.entries(file.mcpServers)) {
      if (!raw || typeof raw !== "object") {
        ctx.logger.appendLine(`[mcp] ${candidate.path}: server "${name}" is not an object — skipping`);
        continue;
      }
      if (name.includes("__")) {
        // P3-2: `__` is the namespace separator in mcp__<server>__<tool>, so a
        // server literally named "a__b" could never be addressed. Reject with
        // a clear message instead of silently misrouting its tools.
        ctx.logger.appendLine(
          `[mcp] ${candidate.path}: server "${name}" contains "__", which conflicts with mcp__<server>__<tool> namespacing — skipping (rename the server)`,
        );
        continue;
      }
      if (seen.has(name)) {
        ctx.logger.appendLine(
          `[mcp] ${candidate.path}: server "${name}" shadowed by higher-precedence config — skipping`,
        );
        continue;
      }
      seen.add(name);
      const expanded = expandServerConfig(raw, {
        workspaceFolders: ctx.workspaceFolders,
        configDir: path.dirname(candidate.path),
        logger: ctx.logger,
      });
      const transport = detectTransport(expanded);
      if (transport === "unknown") {
        ctx.logger.appendLine(
          `[mcp] server "${name}": no transport detected (needs "command" for stdio or "url" for HTTP) — server will stay disabled`,
        );
      }
      out.push({
        id: serverId(candidate.scope, name),
        displayName: name,
        scope: candidate.scope,
        sourcePath: candidate.path,
        config: { args: [], ...expanded },
        transport: transport === "unknown" ? "stdio" : transport,
      });
    }
  }
  return out;
}

/**
 * Type detection (parity §B2): `command` present → stdio; `url` present →
 * streamable_http (unsupported); else unknown.
 */
export function detectTransport(cfg: McpServerConfig): "stdio" | "streamable_http" | "sse" | "unknown" {
  if (cfg.command) return "stdio";
  if (cfg.url) {
    return cfg.transportType === "sse" ? "sse" : "streamable_http";
  }
  return "unknown";
}
