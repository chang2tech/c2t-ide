"use strict";
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
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.SKILL_PARENT_DIRS = void 0;
exports.discoverSkills = discoverSkills;
exports.readSkillContent = readSkillContent;
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
exports.SKILL_PARENT_DIRS = [".cursor", ".claude", ".agents", ".codex"];
function readDescription(skillMdPath) {
    let raw;
    try {
        raw = fs.readFileSync(skillMdPath, "utf8");
    }
    catch {
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
function discoverSkills(projectDir, homeDir) {
    const found = new Map();
    const bases = [];
    if (homeDir && homeDir !== projectDir) {
        bases.push({ dir: homeDir, scope: "home" });
    }
    if (projectDir) {
        bases.push({ dir: projectDir, scope: "project" });
    }
    for (const { dir: base, scope } of bases) {
        for (const parent of exports.SKILL_PARENT_DIRS) {
            const skillsDir = path.join(base, parent, "skills");
            let entries;
            try {
                entries = fs.readdirSync(skillsDir, { withFileTypes: true });
            }
            catch {
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
                }
                catch {
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
function readSkillContent(skill) {
    try {
        return fs.readFileSync(path.join(skill.dir, "SKILL.md"), "utf8");
    }
    catch {
        return undefined;
    }
}
