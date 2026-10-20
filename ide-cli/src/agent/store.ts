/**
 * store.ts — shared local state directory for the agent CLI.
 *
 * Everything the CLI persists locally (persistent sessions, plugin
 * registry, hooks) lives under ~/.ide-code. The IDE_CODE_HOME env var
 * overrides the home directory (used by tests to stay hermetic).
 */

import * as fs from "fs";
import * as os from "os";
import * as path from "path";

/** ~/.ide-code (or $IDE_CODE_HOME/.ide-code when set). */
export function configDir(): string {
  const home = process.env.IDE_CODE_HOME ?? os.homedir();
  return path.join(home, ".ide-code");
}

/** configDir(), created if missing. */
export function ensureConfigDir(): string {
  const dir = configDir();
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function readJsonFile<T>(file: string, fallback: T): T {
  try {
    const raw = fs.readFileSync(file, "utf8");
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

/** Atomic-ish write: temp file + rename, so a crash never leaves half a JSON file. */
export function writeJsonFile(file: string, value: unknown): void {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  fs.renameSync(tmp, file);
}
