---
name: create-subagent
description: Creates custom subagents. Use when the user wants a specialized background agent — scaffolds a new subagent definition with its own role, scope, and tool access.
---
<!-- Customize this skill and select save to override its behavior. Delete that copy to restore the built-in behavior. -->

# Create Subagent

Help the user create a custom subagent: a specialized background agent with its own role, prompt, and scope, invoked to do focused work while the main conversation continues.

## When to Use

- The user asks to create, add, or author a subagent (e.g. "make a code-review subagent").
- The user wants a repeatable, specialized role — research, review, testing, drafting — that runs as its own agent rather than inline in chat.

## Workflow

### 1. Clarify the subagent's role

Ask:

1. **What it does** — the one job it owns (e.g. "reviews PRs for security issues").
2. **Its scope and boundaries** — what files/areas it may touch, what it must never do, and how it reports back.
3. **When it runs** — invoked on demand by the user/agent, or tied to a hook event like `subagentStart`.

### 2. Define the subagent

A custom subagent definition carries:

- **Name** — a short, unique identifier (slash-trigger style, lowercase with dashes).
- **System prompt / role** — the instructions the subagent runs under: persona, goals, hard constraints, and how to report its result.
- **Model options** — Cursor supports per-subagent model options such as effort, context, and fast presets; pick the preset that fits the job (fast for triage, effort for deep reasoning).
- **Tool access** — only the tools the job needs. A reviewer reads and comments; a fixer also edits and runs tests.

### 3. Scaffold and register

Write the subagent definition to the project's subagents location and confirm it loads. Keep the definition self-contained: name, role prompt, model options, and tool scope, all in one place.

### 4. Verify

- The definition parses and registers under its name without colliding with an existing subagent.
- The role prompt states the goal, the scope, and the expected report format.
- The tool scope is the minimum the job needs — no broader.
- Run one small task through it and check the report comes back in the expected shape before handing it over.

## Guidelines

- One subagent, one job. If the role prompt needs "and also...", that's a second subagent.
- Hard constraints (never push, never delete, ask before sending anything externally) belong in the role prompt itself, not in a side note.
- Matchers for `subagentStart` hooks match the subagent type, so name the type deliberately if hooks will gate it.
