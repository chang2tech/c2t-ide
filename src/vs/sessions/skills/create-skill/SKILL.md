---
name: create-skill
description: Creates SKILL.md structure for a new skill. Use when the user wants to create a new skill — scaffolds a SKILL.md file with the required frontmatter and the supported skill locations.
---
<!-- Customize this skill and select save to override its behavior. Delete that copy to restore the built-in behavior. -->

# Create Skill

Help the user create a new skill by generating the SKILL.md structure Cursor expects.

## When to Use

- The user asks to create, add, or author a new skill.
- The user wants a reusable capability the agent can trigger with a slash command or that the model can invoke on its own.

## Workflow

### 1. Clarify the skill's purpose

Ask what the skill should do and when it should trigger. A good skill has one clear job and a description that lets the model decide when to invoke it.

### 2. Choose the location

Skills live in any of these directories (all supported, user-level or project-level):

- `.agents/skills/`, `.cursor/skills/` (project level)
- `~/.agents/skills/`, `~/.cursor/skills/` (user level, available in every project)
- Claude/Codex compat: `.claude/skills/`, `.codex/skills/`, `~/...`

Nested `.cursor/skills/` directories anywhere in a repo are auto-scoped to that directory (monorepo support).

### 3. Scaffold the SKILL.md

Create a folder named for the skill and write `SKILL.md` inside it with this frontmatter:

```markdown
---
name: <folder-name>
description: <what it does, and when to use it — drives model invocation>
---
```

`name` is required and must match the folder name. `description` is required and should say what the skill does *and* when to use it, so the model can pick it up on its own.

Optional frontmatter (only when needed):

- `paths`: glob scoping — the skill only applies to matching paths
- `disable-model-invocation`: `true` to keep it user-invokable only (slash command), off for the model
- `icon` / `color`: badge icon and color (default, green, cyan, blue, purple, magenta, orange, yellow, red, brand)
- `metadata`: arbitrary key-value pairs

Then the body: a workflow in the same shape as this file — "When to Use", numbered steps the agent follows, and a short "Guidelines" section with hard constraints.

### 4. Verify

- Frontmatter parses; `name` equals the folder name; `description` is present and ≤ 1024 characters after sanitization.
- The body contains the actual workflow, not just a stub — a skill that only says "do X" teaches the agent nothing.
- Confirm the trigger works: `/` + skill name in chat invokes it when user-invocable.

## Guidelines

- Don't invent frontmatter fields — only the keys above are supported.
- Keep the description behavior-first ("what + when"), not a title.
- Prefer project-level `.cursor/skills/` when the skill is tied to this codebase; user-level `~/.cursor/skills/` when it's personal and reusable everywhere.
