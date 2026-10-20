/**
 * skills.ts — skill discovery for the agent CLI.
 *
 * Scans the skill directories Cursor, Claude Code, and friends use, in the
 * project dir and in the home dir:
 *   .cursor/skills, .claude/skills, .agents/skills, .codex/skills
 *
 * A skill is a directory containing a SKILL.md file. The description comes
 * from the SKILL.md frontmatter (`description:`) when present, otherwise
 * from the first non-empty body line.
 */

import * as fs from "fs";
import * as path from "path";

export interface DiscoveredSkill {
  name: string;
  /** Absolute path of the skill directory. */
  dir: string;
  description: string;
  /** Which parent directory the skill was found under. */
  source: ".cursor" | ".claude" | ".agents" | ".codex";
  /** "project" when found under projectDir, "home" when under homeDir. */
  scope: "project" | "home";
}

export const SKILL_PARENT_DIRS = [".cursor", ".claude", ".agents", ".codex"] as const;

function readDescription(skillMdPath: string): string {
  let raw: string;
  try {
    raw = fs.readFileSync(skillMdPath, "utf8");
  } catch {
    return "";
  }
  // YAML frontmatter: ---\ndescription: ...\n---
  const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(raw);
  if (fm) {
    const m = /^description\s*:\s*(.+)$/m.exec(fm[1]);
    if (m) {
      return m[1].trim().replace(/^["']|["']$/g, "");
    }
  }
  const body = fm ? raw.slice(fm[0].length) : raw;
  for (const line of body.split("\n")) {
    const t = line.trim().replace(/^#+\s*/, "");
    if (t.length > 0) {
      return t.slice(0, 200);
    }
  }
  return "";
}

/**
 * Discover skills under <base>/.{cursor,claude,agents,codex}/skills.
 * Project skills shadow home skills of the same name.
 */
export function discoverSkills(projectDir: string, homeDir: string): DiscoveredSkill[] {
  const found = new Map<string, DiscoveredSkill>();
  const bases: Array<{ dir: string; scope: "project" | "home" }> = [];
  if (homeDir && homeDir !== projectDir) {
    bases.push({ dir: homeDir, scope: "home" });
  }
  if (projectDir) {
    bases.push({ dir: projectDir, scope: "project" });
  }
  for (const { dir: base, scope } of bases) {
    for (const parent of SKILL_PARENT_DIRS) {
      const skillsDir = path.join(base, parent, "skills");
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(skillsDir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (!entry.isDirectory()) {
          continue;
        }
        const skillDir = path.join(skillsDir, entry.name);
        const mdPath = path.join(skillDir, "SKILL.md");
        try {
          if (!fs.statSync(mdPath).isFile()) {
            continue;
          }
        } catch {
          continue;
        }
        // Project skills shadow home skills of the same name.
        if (scope === "home" && found.has(entry.name)) {
          continue;
        }
        found.set(entry.name, {
          name: entry.name,
          dir: skillDir,
          description: readDescription(mdPath),
          source: parent,
          scope,
        });
      }
    }
  }
  return [...found.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** Read the SKILL.md body of a discovered skill. */
export function readSkillContent(skill: DiscoveredSkill): string | undefined {
  try {
    return fs.readFileSync(path.join(skill.dir, "SKILL.md"), "utf8");
  } catch {
    return undefined;
  }
}
