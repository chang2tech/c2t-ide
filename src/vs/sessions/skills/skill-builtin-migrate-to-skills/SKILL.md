---
name: skill-builtin-migrate-to-skills
description: "Converts rules/commands to skills. Identifies eligible dynamic rules and slash commands and converts them to skills automatically, preserving explicit-invocation behavior. Use when the user types /migrate-to-skills or wants rules/commands converted to skills."
---
<!-- Customize this skill and select save to override its behavior. Delete that copy to restore the built-in behavior. -->

# Migrate to Skills

Convert legacy project rules and slash commands into skills: identify the eligible ones and rewrite them as `SKILL.md` folders so they are discovered by skill locations and invoked by the model through description matching.

## When to Use

- The user types `/migrate-to-skills` or asks to convert rules or commands into skills.
- A workspace has old dynamic rules (for example `alwaysApply: false`, no globs) or user/workspace slash commands that would work better as skills with descriptions the model can match on.

## Workflow

### 1. Identify eligible sources

Scan the workspace and user configuration for migration candidates:

- **Dynamic rules** — rules with `alwaysApply: false` and no globs are eligible. Rules that carry globs map naturally to a skill's `paths` scoping, so note the globs for step 2.
- **Slash commands** — user-level and workspace-level commands are eligible.

Skip rules that are always applied: they have different semantics and do not map cleanly onto a description-invoked skill. Confirm with the user before converting those.

### 2. Convert each candidate to a skill

For every eligible rule or command, create a skill folder (for example `.agents/skills/<name>/`) with a `SKILL.md`:

- `name` must equal the folder name.
- `description` is required — write it from the original rule/command text so the model invokes the skill at the right time.
- `paths` — carry over any globs from the original rule so scoping is preserved.
- Body — the original instructions, cleaned up for the skill format.

### 3. Preserve explicit-invocation behavior

Commands that were only ever invoked explicitly must stay explicit: set `disable-model-invocation: true` on the converted skill so the model does not start loading it automatically. Only skills the user wants auto-matched keep model invocation enabled.

### 4. Verify

- Re-run skill discovery and confirm each converted skill appears exactly once.
- Confirm `name` matches the folder and the description reads correctly.
- Retire or remove the original rule/command source so the same behavior is not defined twice.

## Guidelines

- Migrate to the closest matching location: workspace rules become workspace skills, user rules become user skills.
- Keep the converted content faithful to the original — the skill should behave the way the rule or command did.
- Report which sources were converted, which were skipped, and why.
