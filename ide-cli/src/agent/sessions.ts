/**
 * sessions.ts — the persistent-session registry behind `agent persist`,
 * `agent ls`, and `agent --resume`.
 *
 * Stored at ~/.ide-code/agent-sessions.json:
 *   { "sessions": [ { id, title, createdAt, lastUsedAt, cwd, mode, model? } ] }
 *
 * The registry only tracks metadata; the engine owns the actual session
 * history. `attach` therefore verifies the id against the engine
 * (session.get) before continuing it.
 */

import * as path from "path";
import { configDir, readJsonFile, writeJsonFile } from "./store";

export interface PersistentSession {
  id: string;
  title: string;
  createdAt: number;
  lastUsedAt: number;
  cwd: string;
  mode: string;
  model?: string;
}

interface RegistryFile {
  sessions: PersistentSession[];
}

const FILE_NAME = "agent-sessions.json";

function registryPath(): string {
  return path.join(configDir(), FILE_NAME);
}

export function loadRegistry(): RegistryFile {
  const file = readJsonFile<Partial<RegistryFile>>(registryPath(), {});
  const sessions = Array.isArray(file.sessions) ? file.sessions : [];
  return {
    sessions: sessions.filter(
      (s): s is PersistentSession =>
        !!s && typeof s.id === "string" && s.id.length > 0,
    ),
  };
}

function saveRegistry(reg: RegistryFile): void {
  writeJsonFile(registryPath(), reg);
}

/** Insert or replace (matched by id). */
export function recordSession(session: PersistentSession): void {
  const reg = loadRegistry();
  const idx = reg.sessions.findIndex((s) => s.id === session.id);
  if (idx >= 0) {
    reg.sessions[idx] = session;
  } else {
    reg.sessions.push(session);
  }
  saveRegistry(reg);
}

export function touchSession(id: string, patch?: Partial<PersistentSession>): boolean {
  const reg = loadRegistry();
  const s = reg.sessions.find((x) => x.id === id);
  if (!s) {
    return false;
  }
  s.lastUsedAt = Date.now();
  if (patch) {
    Object.assign(s, patch);
  }
  saveRegistry(reg);
  return true;
}

/** Exact match first, then unique id-prefix match. */
export function findSession(idOrPrefix: string): PersistentSession | undefined {
  const reg = loadRegistry();
  const exact = reg.sessions.find((s) => s.id === idOrPrefix);
  if (exact) {
    return exact;
  }
  const prefixed = reg.sessions.filter((s) => s.id.startsWith(idOrPrefix));
  return prefixed.length === 1 ? prefixed[0] : undefined;
}

export function mostRecentSession(): PersistentSession | undefined {
  const reg = loadRegistry();
  let best: PersistentSession | undefined;
  for (const s of reg.sessions) {
    if (!best || s.lastUsedAt > best.lastUsedAt) {
      best = s;
    }
  }
  return best;
}

export function removeSession(id: string): boolean {
  const reg = loadRegistry();
  const before = reg.sessions.length;
  reg.sessions = reg.sessions.filter((s) => s.id !== id);
  if (reg.sessions.length === before) {
    return false;
  }
  saveRegistry(reg);
  return true;
}
