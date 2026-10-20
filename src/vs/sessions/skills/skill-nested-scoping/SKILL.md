---
name: skill-nested-scoping
description: "Nested skill scoping: a .cursor/skills/ (or .agents/skills/) folder anywhere in the repo is auto-scoped to the directory that contains it (monorepo support); explicit paths frontmatter overrides the auto-scope. Use when the user asks about scoping skills to subdirectories or packages."
---
<!-- Customize this skill and select save to override its behavior. Delete that copy to restore the built-in behavior. -->

# Nested Skill Scoping

A skill folder nested deeper in the repo is automatically scoped to the directory that contains its `skills` folder — so a package-local skill applies to that package's files without any extra configuration.

## When to Use

- The user asks how to scope a skill to one subdirectory or package of a monorepo.
- A skill should apply in `packages/app/` but not in `packages/api/`.

## Workflow

### 1. Place the skill folder where the scope should end

Create the skill under a nested skills folder, for example:

```
<workspace>/packages/app/.cursor/skills/lint-rules/SKILL.md
```

The skill is auto-scoped to `packages/app/` — the directory that contains the nested `.cursor/skills/` folder. `.agents/skills/` works the same way.

### 2. Let the auto-scope do the work

Without an explicit `paths` frontmatter field, the nested skill applies only to files under its scope directory. Root-level skill folders (`.cursor/skills/` at the repo root) get no extra scoping.

### 3. Override with `paths` when needed

Explicit `paths` frontmatter always wins over the auto-scope: set glob patterns (for example `src/**/*.ts`) to narrow or redirect the scope regardless of where the skill folder lives.

### 4. Verify

Check that the skill loads for files inside the scope directory and does not trigger for files outside it.

## Guidelines

- Prefer nesting over `paths` globs when the scope matches a real directory — it stays correct as files move.
- Use `paths` only when the scope does not line up with the folder (or to restrict further inside the scope).
- Keep skill names unique across nested folders; a duplicate name is skipped in favor of the first discovered copy.
