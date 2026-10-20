---
name: skill-frontmatter
description: "SKILL.md frontmatter reference: name (required, matches folder), description (required), paths (glob scoping), disable-model-invocation, icon, color (default/green/cyan/blue/purple/magenta/orange/yellow/red/brand), metadata. Use when the user asks what fields a SKILL.md supports or how to configure a skill."
---
<!-- Customize this skill and select save to override its behavior. Delete that copy to restore the built-in behavior. -->

# Skill Frontmatter Reference

The fields a `SKILL.md` frontmatter block supports, what each one does, and which are required.

## When to Use

- The user asks what fields a `SKILL.md` supports or how to configure a skill.
- Writing or validating a new skill and checking which frontmatter attributes are available.

## Workflow

### 1. Start from the required fields

```yaml
---
name: my-skill
description: What it does and when the agent should use it
paths: src/**/*.ts
disable-model-invocation: false
icon: rocket
color: blue
metadata:
  version: "1.0"
---
```

- `name` (required) — must equal the skill folder name or the skill is skipped during discovery. Max 64 characters.
- `description` (required) — what the skill does and when the agent should use it. Drives model invocation (max 1024 characters). Quote it in YAML if it contains a colon followed by a space.

### 2. Add optional scoping and behavior fields

- `paths` (optional) — glob patterns that scope the skill to specific files. If omitted, a skill in a nested skill folder is auto-scoped to the directory that contains it (see `skill-nested-scoping`).
- `disable-model-invocation` (optional, boolean) — `true` keeps the skill out of automatic model invocation; the skill then only runs when the user invokes it explicitly (for example via the `/` menu). Defaults to `false`.
- `user-invocable` (optional, boolean) — `false` hides the skill from the `/` menu for background knowledge the user should not trigger directly. Defaults to `true`.

### 3. Add badge display fields

- `icon` (optional) — badge icon shown with the skill.
- `color` (optional) — badge color; must be one of `default`, `green`, `cyan`, `blue`, `purple`, `magenta`, `orange`, `yellow`, `red`, `brand`. Anything else is rejected during validation.
- `metadata` (optional) — arbitrary key/value data attached to the skill.

### 4. Validate

Confirm `name` matches the folder exactly, `description` is present, and `color` (if set) is one of the palette values above.

## Guidelines

- Keep `description` focused on "what it does and when to use it" — that text is what the model matches on.
- Reserve `disable-model-invocation: true` for skills that must only run on explicit user request.
- Do not invent new frontmatter keys; unknown keys are ignored.
