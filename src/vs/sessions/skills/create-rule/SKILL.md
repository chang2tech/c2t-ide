---
name: create-rule
description: Creates rules with scope for the agent to follow. Use when the user wants persistent project rules — generates a rule file in .cursor/rules with the right frontmatter and scope settings.
---
<!-- Customize this skill and select save to override its behavior. Delete that copy to restore the built-in behavior. -->

# Create Rule

Help the user create a new rule: a persistent instruction the agent follows, scoped to the files or situations it applies to.

## When to Use

- The user asks to create, add, or author a rule (e.g. "always use tabs", "never commit secrets").
- The user wants project conventions enforced automatically without repeating them every chat.

## Workflow

### 1. Clarify the rule and its scope

Ask two things:

1. **The rule itself** — the instruction in one or two sentences.
2. **The scope** — where it applies. Rules can be scoped by file path (globs) or applied always. Narrow scope beats global: a rule that only makes sense for tests shouldn't fire in every file.

### 2. Choose the location

Rules live in `.cursor/rules/` in the project (a plain `.md` file there without frontmatter is ignored, so the frontmatter below is required).

### 3. Generate the rule file

Write `<rule-name>.mdc` in `.cursor/rules/` with this frontmatter:

```markdown
---
description: <what the rule is about — drives when it applies>
globs: <comma-separated path globs, e.g. "src/**/*.test.ts">
alwaysApply: false
---
```

Then the rule text as the body.

Scope settings:

- `alwaysApply: true` — the rule is injected into every agent request. Use only for short, genuinely global rules.
- `globs` — the rule applies only to matching files. Use this for path-scoped rules.
- Omit both (or `alwaysApply: false` with no globs) only when the rule is referenced explicitly by the user.

### 4. Verify

- Frontmatter parses and contains at least `description` plus one of `alwaysApply: true` or `globs`.
- The body states the rule plainly, with a short example of correct behavior where ambiguity is likely.
- Keep the rule short: rules count against context on every applicable request, so one focused rule beats a long checklist.

## Guidelines

- Don't write rules that duplicate what the user already says every session — capture them once here.
- One rule, one file. If two conventions have different scopes, they are two rules.
- Never put secrets or credentials in rule files.
