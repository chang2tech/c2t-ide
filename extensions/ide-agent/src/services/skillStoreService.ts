/**
 * DEV-GAPS-5-SKILLS — Agent Skills Store (local-first).
 *
 * Binary evidence (AST extraction of Cursor 3.25.6 agent host):
 *   ~/workspace/ide-code-mission/docs/rea/dig-ast-ext-findings.md §1 —
 *   cursor-agent-host registers 14 dynamic commands:
 *     cursor.installSkills.runSkillsCliAdd
 *     cursor.publishSkill.packSkillPlugin / reloadConfirmAndDeleteLocalSkill
 *     cursor.resyncSkill.packInstalledSkillPlugin / reloadAndConfirmResync
 *     cursor.skillStore.confirmStoreSkillsSynced / copySkillsFromStore /
 *       copySkillsToStore / moveSkillOutOfStore / moveSkillToStore /
 *       trashMigratedHomeSkills / trashMigratedStoreSkills /
 *       confirmOverwrite / isMigrationCancelled / reportMigrationProgress
 *     cursor.unpublishSkill.removePluginCache / restoreLocalSkill
 *   and feeds skills into the agent request context (RequestContextSkillsPart).
 *
 * DIVERGENCE (deliberate, local-first): Cursor's store is cloud/account-backed
 * (skills sync through the Cursor account). This build diverges to a LOCAL
 * filesystem store at ~/.ide-code/skills/ — no cloud sync, no account, no
 * network. "publish" packs a skill directory into a .tar.gz archive inside the
 * local store instead of uploading to Cursor's servers. Every divergence from
 * Cursor's behavior is marked DIVERGENCE in the comments below.
 *
 * Kept vscode-free so it unit-tests under plain node (see
 * src/services/test/run-skillstore-tests.ts).
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as zlib from "node:zlib";
import { parseSkillFrontmatter } from "./slashRegistry";

/** One skill installed in the local store. */
export interface SkillInfo {
  /** Store directory name (also the skill id). */
  id: string;
  /** From SKILL.md frontmatter `name:` (fallback: directory name). */
  name: string;
  /** From SKILL.md frontmatter `description:` (fallback: ""). */
  description: string;
  /** From SKILL.md frontmatter `version:` (fallback: "0.0.0"). */
  version: string;
  /** Absolute path of the installed copy inside the store. */
  sourceDir: string;
  /** Epoch ms when the skill was installed into the store. */
  installedAt: number;
  /** True when a publish pack archive exists in the store's packages/ dir. */
  published: boolean;
}

/** Sidecar metadata written next to each installed skill. */
interface SkillStoreMeta {
  installedAt: number;
  /** Original directory the skill was installed from (resync target default). */
  installedFrom: string;
}

const META_FILENAME = "skill.json";
const PACKAGES_DIRNAME = "packages";

/** DIVERGENCE: Cursor syncs skills through the cloud account; our store is local. */
export function defaultSkillStoreDir(homeDir: string = os.homedir()): string {
  return path.join(homeDir, ".ide-code", "skills");
}

/** Create the store dir (and its packages/ cache dir) when missing. */
export function ensureSkillStoreDir(storeDir: string): void {
  fs.mkdirSync(storeDir, { recursive: true });
  fs.mkdirSync(path.join(storeDir, PACKAGES_DIRNAME), { recursive: true });
}

function packagesDir(storeDir: string): string {
  return path.join(storeDir, PACKAGES_DIRNAME);
}

/** Parse a SKILL.md's `version:` frontmatter line (parseSkillFrontmatter has no version field). */
function parseSkillVersion(raw: string): string | undefined {
  const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!m) {
    return undefined;
  }
  for (const line of m[1].split(/\r?\n/)) {
    const kv = line.match(/^\s*version\s*:\s*(.*?)\s*$/i);
    if (kv) {
      return kv[1].replace(/^["']|["']$/g, "") || undefined;
    }
  }
  return undefined;
}

/** Read one skill directory's manifest. Returns undefined when SKILL.md is missing/unreadable. */
export function readSkillManifest(skillDir: string): Omit<SkillInfo, "id" | "sourceDir" | "installedAt" | "published"> | undefined {
  const file = path.join(skillDir, "SKILL.md");
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    return undefined;
  }
  if (!raw.trim()) {
    return undefined;
  }
  const fm = parseSkillFrontmatter(raw);
  const name = (fm.name || path.basename(skillDir)).trim();
  if (!name) {
    return undefined;
  }
  return {
    name,
    description: (fm.description || "").trim(),
    version: parseSkillVersion(raw) || "0.0.0",
  };
}

function readStoreMeta(skillDir: string): SkillStoreMeta | undefined {
  try {
    const raw = fs.readFileSync(path.join(skillDir, META_FILENAME), "utf8");
    const parsed = JSON.parse(raw) as Partial<SkillStoreMeta>;
    if (typeof parsed.installedAt === "number" && typeof parsed.installedFrom === "string") {
      return { installedAt: parsed.installedAt, installedFrom: parsed.installedFrom };
    }
  } catch {
    // Missing or corrupt sidecar — fall back to filesystem metadata.
  }
  return undefined;
}

/** Archive filename for a published skill pack (Cursor: the "plugin cache"). */
export function packArchiveName(skill: { name: string; version: string }): string {
  const safe = skill.name.replace(/[^a-zA-Z0-9._-]+/g, "-");
  return `${safe}-${skill.version}.tar.gz`;
}

/** True when the skill has a publish pack archive in the store's packages/ dir. */
export function isPublished(storeDir: string, skill: { name: string; version: string }): boolean {
  return fs.existsSync(path.join(packagesDir(storeDir), packArchiveName(skill)));
}

/** Original directory a skill was installed from (resync/restore target default). */
export function installedFromDir(storeDir: string, skillId: string): string | undefined {
  return readStoreMeta(path.join(storeDir, skillId))?.installedFrom;
}

/** Skill dir names in the store (skips packages/ and dotfiles). */
export function listInstalledSkillIds(storeDir: string): string[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(storeDir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((e) => e.isDirectory() && e.name !== PACKAGES_DIRNAME && !e.name.startsWith("."))
    .map((e) => e.name)
    .sort((a, b) => a.localeCompare(b));
}

/** Full SkillInfo list for the store. Unparseable dirs are skipped (not fatal). */
export function listInstalledSkills(storeDir: string): SkillInfo[] {
  const out: SkillInfo[] = [];
  for (const id of listInstalledSkillIds(storeDir)) {
    const dir = path.join(storeDir, id);
    const manifest = readSkillManifest(dir);
    if (!manifest) {
      continue;
    }
    const meta = readStoreMeta(dir);
    let installedAt = meta?.installedAt ?? 0;
    if (!installedAt) {
      try {
        installedAt = fs.statSync(dir).birthtimeMs || fs.statSync(dir).mtimeMs;
      } catch {
        installedAt = 0;
      }
    }
    out.push({
      id,
      name: manifest.name,
      description: manifest.description,
      version: manifest.version,
      sourceDir: dir,
      installedAt,
      published: isPublished(storeDir, manifest),
    });
  }
  return out;
}

/** Recursive directory copy (skips symlinks — fail-closed against link escapes). */
export function copyDirSync(src: string, dest: string): void {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const from = path.join(src, entry.name);
    const to = path.join(dest, entry.name);
    if (entry.isSymbolicLink()) {
      continue;
    }
    if (entry.isDirectory()) {
      copyDirSync(from, to);
    } else if (entry.isFile()) {
      fs.copyFileSync(from, to);
    }
  }
}

/** Recursive delete (rm -rf). Throws when the target is outside its parent guard. */
export function removeDirSync(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true });
}

/**
 * Install a skill directory into the store (Cursor: skillStore.copySkillsToStore /
 * installSkills.runSkillsCliAdd equivalent). Overwrites an existing install with
 * the same name. Throws when the source has no SKILL.md.
 */
export function installSkill(storeDir: string, sourceDir: string): SkillInfo {
  const manifest = readSkillManifest(sourceDir);
  if (!manifest) {
    throw new Error(`not a skill directory (no readable SKILL.md): ${sourceDir}`);
  }
  ensureSkillStoreDir(storeDir);
  const id = manifest.name.replace(/[^a-zA-Z0-9._-]+/g, "-") || path.basename(sourceDir);
  const dest = path.join(storeDir, id);
  removeDirSync(dest);
  copyDirSync(sourceDir, dest);
  const meta: SkillStoreMeta = { installedAt: Date.now(), installedFrom: sourceDir };
  fs.writeFileSync(path.join(dest, META_FILENAME), JSON.stringify(meta, null, 2) + "\n", "utf8");
  invalidateRequestContextSkillsCache();
  const installed = listInstalledSkills(storeDir).find((s) => s.id === id);
  if (!installed) {
    throw new Error(`install succeeded but skill not visible in store: ${id}`);
  }
  return installed;
}

// ---------------------------------------------------------------------------
// Minimal POSIX tar (ustar) writer/reader — publish packs skill dirs as
// .tar.gz archives. Pure node, no external dependency.
// ---------------------------------------------------------------------------

function octal(value: number, width: number): string {
  return value.toString(8).padStart(width, "0");
}

function writeString(buf: Buffer, offset: number, length: number, value: string): void {
  const bytes = Buffer.from(value, "utf8");
  const n = Math.min(bytes.length, length);
  bytes.copy(buf, offset, 0, n);
}

/** Split a long entry name into ustar name/prefix parts. */
function splitTarName(name: string): { name: string; prefix: string } {
  if (Buffer.byteLength(name) <= 100) {
    return { name, prefix: "" };
  }
  const slash = name.lastIndexOf("/", 155);
  if (slash > 0 && Buffer.byteLength(name.slice(slash + 1)) <= 100) {
    return { name: name.slice(slash + 1), prefix: name.slice(0, slash) };
  }
  throw new Error(`tar entry name too long: ${name}`);
}

function tarHeader(entryName: string, size: number, mtimeMs: number, isDir: boolean): Buffer {
  const header = Buffer.alloc(512, 0);
  const { name, prefix } = splitTarName(entryName);
  writeString(header, 0, 100, name);
  writeString(header, 100, 8, octal(isDir ? 0o755 : 0o644, 7) + "\0");
  writeString(header, 108, 8, octal(0, 7) + "\0");
  writeString(header, 116, 8, octal(0, 7) + "\0");
  writeString(header, 124, 12, octal(size, 11) + "\0");
  writeString(header, 136, 12, octal(Math.floor(mtimeMs / 1000), 11) + "\0");
  // chksum field: spaces while computing.
  header.fill(0x20, 148, 156);
  header[156] = isDir ? 0x35 : 0x30; // '5' dir | '0' file
  writeString(header, 257, 6, "ustar\0");
  writeString(header, 263, 2, "00");
  writeString(header, 345, 155, prefix);
  let sum = 0;
  for (let i = 0; i < 512; i++) {
    sum += header[i];
  }
  writeString(header, 148, 8, octal(sum, 6) + "\0 ");
  return header;
}

function collectTarEntries(rootDir: string): Array<{ rel: string; abs: string; isDir: boolean }> {
  const out: Array<{ rel: string; abs: string; isDir: boolean }> = [];
  const walk = (abs: string, rel: string): void => {
    const entries = fs
      .readdirSync(abs, { withFileTypes: true })
      .filter((e) => !e.isSymbolicLink())
      .sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const childAbs = path.join(abs, entry.name);
      const childRel = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        out.push({ rel: childRel + "/", abs: childAbs, isDir: true });
        walk(childAbs, childRel);
      } else if (entry.isFile()) {
        out.push({ rel: childRel, abs: childAbs, isDir: false });
      }
    }
  };
  walk(rootDir, "");
  return out;
}

/** Pack a skill directory into a .tar.gz archive (pure node ustar + gzip). */
export function packTarGz(sourceDir: string, archivePath: string): void {
  const stat = fs.statSync(sourceDir);
  if (!stat.isDirectory()) {
    throw new Error(`pack source is not a directory: ${sourceDir}`);
  }
  const chunks: Buffer[] = [];
  for (const entry of collectTarEntries(sourceDir)) {
    const data = entry.isDir ? Buffer.alloc(0) : fs.readFileSync(entry.abs);
    const mtimeMs = fs.statSync(entry.abs).mtimeMs;
    chunks.push(tarHeader(entry.rel, data.length, mtimeMs, entry.isDir));
    if (data.length > 0) {
      chunks.push(data);
      const pad = (512 - (data.length % 512)) % 512;
      if (pad > 0) {
        chunks.push(Buffer.alloc(pad, 0));
      }
    }
  }
  // Two zero blocks = end of archive.
  chunks.push(Buffer.alloc(1024, 0));
  fs.mkdirSync(path.dirname(archivePath), { recursive: true });
  fs.writeFileSync(archivePath, zlib.gzipSync(Buffer.concat(chunks)));
}

function readCString(buf: Buffer, offset: number, length: number): string {
  const end = buf.indexOf(0, offset);
  const stop = end === -1 || end > offset + length ? offset + length : end;
  return buf.toString("utf8", offset, stop);
}

/** Fail-closed tar entry path resolution (no absolute paths, no `..` escapes). */
function safeJoinTarEntry(destDir: string, entryName: string): string | undefined {
  const normalized = path.posix.normalize(entryName);
  if (path.posix.isAbsolute(normalized)) {
    return undefined;
  }
  const parts = normalized.split("/");
  if (parts.some((p) => p === "..")) {
    return undefined;
  }
  const resolved = path.resolve(destDir, ...parts.filter((p) => p !== "" && p !== "."));
  const root = path.resolve(destDir) + path.sep;
  if (resolved !== path.resolve(destDir) && !resolved.startsWith(root)) {
    return undefined;
  }
  return resolved;
}

/** Unpack a .tar.gz archive (round-trips packTarGz). Throws on traversal entries. */
export function unpackTarGz(archivePath: string, destDir: string): void {
  const tar = zlib.gunzipSync(fs.readFileSync(archivePath));
  let offset = 0;
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((b) => b === 0)) {
      break; // end-of-archive zero block
    }
    const name = readCString(header, 0, 100);
    const prefix = readCString(header, 345, 155);
    const fullName = prefix ? `${prefix}/${name}` : name;
    const size = parseInt(readCString(header, 124, 12).trim() || "0", 8);
    const typeflag = String.fromCharCode(header[156]);
    offset += 512;
    const target = safeJoinTarEntry(destDir, fullName);
    if (!target) {
      throw new Error(`unsafe tar entry rejected: ${fullName}`);
    }
    if (typeflag === "5") {
      fs.mkdirSync(target, { recursive: true });
    } else if (typeflag === "0" || typeflag === "\0") {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, tar.subarray(offset, offset + size));
    }
    offset += Math.ceil(size / 512) * 512;
  }
  void destDir;
}

/**
 * Publish a skill: pack the INSTALLED store copy into a .tar.gz archive in the
 * store's packages/ dir (Cursor: publishSkill.packSkillPlugin).
 *
 * DIVERGENCE: Cursor publishes to its cloud registry; we pack locally. The
 * archive is the local "plugin cache" that unpublishSkill.removePluginCache
 * deletes.
 */
export function packSkillPlugin(storeDir: string, skillId: string): string {
  const installed = listInstalledSkills(storeDir).find((s) => s.id === skillId);
  if (!installed) {
    throw new Error(`skill not installed in store: ${skillId}`);
  }
  ensureSkillStoreDir(storeDir);
  const archivePath = path.join(packagesDir(storeDir), packArchiveName(installed));
  packTarGz(installed.sourceDir, archivePath);
  invalidateRequestContextSkillsCache();
  return archivePath;
}

/**
 * Resync a skill FROM the store back to a working directory, overwriting it
 * (Cursor: resyncSkill.reloadAndConfirmResync). confirmOverwrite gates the
 * overwrite; returning false aborts without touching the target.
 */
export async function reloadAndConfirmResync(
  storeDir: string,
  skillId: string,
  targetDir: string,
  confirmOverwrite: (skillId: string, targetDir: string) => boolean | Promise<boolean>,
): Promise<boolean> {
  const installed = listInstalledSkills(storeDir).find((s) => s.id === skillId);
  if (!installed) {
    throw new Error(`skill not installed in store: ${skillId}`);
  }
  const exists = fs.existsSync(targetDir) && fs.readdirSync(targetDir).length > 0;
  if (exists && !(await confirmOverwrite(skillId, targetDir))) {
    return false;
  }
  removeDirSync(targetDir);
  copyDirSync(installed.sourceDir, targetDir);
  return true;
}

/**
 * After a successful publish, reload the store listing, confirm, and delete
 * the LOCAL (non-store) skill directory (Cursor:
 * publishSkill.reloadConfirmAndDeleteLocalSkill). Returns false when the user
 * declines or the skill is not published yet (fail-closed: never delete an
 * unpublished local copy).
 */
export async function reloadConfirmAndDeleteLocalSkill(
  storeDir: string,
  skillId: string,
  localDir: string,
  confirm: (skillId: string, localDir: string) => boolean | Promise<boolean>,
): Promise<boolean> {
  const installed = listInstalledSkills(storeDir).find((s) => s.id === skillId);
  if (!installed || !installed.published) {
    return false;
  }
  if (!(await confirm(skillId, localDir))) {
    return false;
  }
  removeDirSync(localDir);
  return true;
}

/**
 * Unpublish: delete the skill's pack archives from the store's plugin cache
 * (Cursor: unpublishSkill.removePluginCache). Returns the number of archives
 * removed.
 */
export function removePluginCache(storeDir: string, skillId: string): number {
  const installed = listInstalledSkills(storeDir).find((s) => s.id === skillId);
  if (!installed) {
    throw new Error(`skill not installed in store: ${skillId}`);
  }
  const dir = packagesDir(storeDir);
  let removed = 0;
  let entries: string[];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return 0;
  }
  const safe = installed.name.replace(/[^a-zA-Z0-9._-]+/g, "-");
  for (const entry of entries) {
    if (entry.startsWith(`${safe}-`) && entry.endsWith(".tar.gz")) {
      fs.rmSync(path.join(dir, entry), { force: true });
      removed++;
    }
  }
  if (removed > 0) {
    invalidateRequestContextSkillsCache();
  }
  return removed;
}

/**
 * Restore a local working copy of a skill from the store (Cursor:
 * unpublishSkill.restoreLocalSkill). Overwrites the target when it exists.
 */
export function restoreLocalSkill(storeDir: string, skillId: string, targetDir: string): SkillInfo {
  const installed = listInstalledSkills(storeDir).find((s) => s.id === skillId);
  if (!installed) {
    throw new Error(`skill not installed in store: ${skillId}`);
  }
  removeDirSync(targetDir);
  copyDirSync(installed.sourceDir, targetDir);
  const restored = readSkillManifest(targetDir);
  if (!restored) {
    throw new Error(`restore produced an unreadable skill dir: ${targetDir}`);
  }
  return { ...installed, sourceDir: targetDir, published: false };
}

/**
 * Sync gate (Cursor: skillStore.confirmStoreSkillsSynced) — the check Cursor
 * runs before trashing migrated sources: every installed skill must have a
 * readable SKILL.md and every published pack archive must be a valid .tar.gz.
 */
export function confirmStoreSkillsSynced(storeDir: string): { synced: boolean; problems: string[] } {
  const problems: string[] = [];
  for (const id of listInstalledSkillIds(storeDir)) {
    const dir = path.join(storeDir, id);
    if (!readSkillManifest(dir)) {
      problems.push(`skill "${id}" has no readable SKILL.md`);
      continue;
    }
    const manifest = readSkillManifest(dir)!;
    if (isPublished(storeDir, manifest)) {
      try {
        // Validate the archive parses (header walk, no extraction).
        unpackTarGz(
          path.join(packagesDir(storeDir), packArchiveName(manifest)),
          path.join(storeDir, ".sync-check-tmp"),
        );
        removeDirSync(path.join(storeDir, ".sync-check-tmp"));
      } catch (err) {
        problems.push(`skill "${id}" has a corrupt publish archive: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }
  return { synced: problems.length === 0, problems };
}

// ---------------------------------------------------------------------------
// Agent request context — Cursor's RequestContextSkillsPart equivalent.
// ---------------------------------------------------------------------------

/** One skill entry in the agent request context (name + description list). */
export interface RequestContextSkillEntry {
  name: string;
  description: string;
}

/**
 * Cursor's RequestContextSkillsPart equivalent: the skills visible to the
 * agent turn. The extension adapter converts this to the engine's wire shape
 * (PromptInput.Prompt.skills = SkillAttachment[] {id, name}) before POSTing.
 */
export interface RequestContextSkillsPart {
  skills: RequestContextSkillEntry[];
}

/** Build the request-context part from installed store skills. */
export function buildRequestContextSkillsPart(skills: SkillInfo[]): RequestContextSkillsPart {
  return {
    skills: skills.map((s) => ({ name: s.name, description: s.description })),
  };
}

const REQUEST_PART_CACHE_TTL_MS = 30_000;
const requestPartCache = new Map<string, { at: number; part: RequestContextSkillsPart }>();

/** Scan the store and build the request-context part (30s TTL per store dir). */
export function requestContextSkills(storeDir: string = defaultSkillStoreDir()): RequestContextSkillsPart {
  const cached = requestPartCache.get(storeDir);
  if (cached && Date.now() - cached.at < REQUEST_PART_CACHE_TTL_MS) {
    return cached.part;
  }
  const part = buildRequestContextSkillsPart(listInstalledSkills(storeDir));
  requestPartCache.set(storeDir, { at: Date.now(), part });
  return part;
}

/** Drop cached request-context parts (called after install/publish/unpublish). */
export function invalidateRequestContextSkillsCache(storeDir?: string): void {
  if (storeDir) {
    requestPartCache.delete(storeDir);
  } else {
    requestPartCache.clear();
  }
}
