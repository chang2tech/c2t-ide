---
name: skill-locations
description: "Skill discovery locations: .agents/skills/, .cursor/skills/, ~/.agents/skills/, ~/.cursor/skills/ plus Claude/Codex compat (.claude/skills/, .codex/skills/, ~/.claude/skills/, ~/.codex/skills/). Use when the user asks where skills are loaded from or how to add a skill so the agent discovers it."
---
<!-- Customize this skill and select save to override its behavior. Delete that copy to restore the built-in behavior. -->

# Skill Discovery Locations

Where skills live on disk and in which order the agent discovers them. Put a skill folder in one of these locations and it is picked up automatically.

## When to Use

- The user asks where skills are loaded from or how to add a skill so the agent discovers it.
- Choosing between a workspace-local skill, a personal (home directory) skill, or a Claude/Codex-compatible location.

## Workflow

### 1. Pick the location

| Location | Scope | When to use |
|---|---|---|
| `.agents/skills/` | Workspace | Default choice — travels with the repo, applies to everyone on the project |
| `.cursor/skills/` | Workspace | Same as `.agents/skills/`; legacy Cursor location |
| `.claude/skills/` | Workspace | Claude-compatible skills read from the workspace |
| `.codex/skills/` | Workspace | Codex-compatible skills read from the workspace |
| `~/.agents/skills/` | User (all workspaces) | Personal skills available everywhere |
| `~/.cursor/skills/` | User (all workspaces) | Legacy personal location; can be synced to cloud agents via Settings → Agents → Context and Tools |
| `~/.claude/skills/` | User (all workspaces) | Personal Claude-compatible skills |
| `~/.codex/skills/` | User (all workspaces) | Personal Codex-compatible skills |

### 2. Create the skill folder

Inside the chosen location, create a folder named after the skill (for example `.agents/skills/my-skill/`) and add a `SKILL.md` with `name` matching the folder name and a `description` — both are required for discovery.

### 3. Verify discovery

Re-run skill discovery and confirm the new skill appears exactly once. If a workspace skill and a user skill (or a built-in) share the same folder name, the workspace/user copy wins — built-in skills have the lowest priority.

## Guidelines

- Prefer `.agents/skills/` for new project skills; keep `.cursor/skills/` for legacy compatibility.
- Personal skills in `~/.agents/skills/` or `~/.cursor/skills/` apply to every workspace — do not put project secrets there.
- Nested locations work too: a `.cursor/skills/` (or `.agents/skills/`) folder anywhere in the repo is auto-scoped to that directory (see `skill-nested-scoping`).
