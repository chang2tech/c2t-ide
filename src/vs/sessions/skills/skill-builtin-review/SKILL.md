---
name: skill-builtin-review
description: Selects and runs the code-review agent on the current changes. Use when the user types /review or asks for a code review of a diff, branch, PR, or selection — the skill picks the review agent and produces a review.
---
<!-- Customize this skill and select save to override its behavior. Delete that copy to restore the built-in behavior. -->

# Code Review

Select and run the code-review agent against the current changes or PR, and produce a review report.

## When to Use

- The user types `/review` or asks for a code review of a diff, a branch, a pull request, or a selected change.
- The user wants AI review feedback (bugs, risks, style, tests) before merging or committing.

## Workflow

### 1. Determine the review target

Use the narrowest target the user gave you: the current diff/uncommitted changes, a branch diff, a pull request number, or the selected code. If no target is clear, ask before reviewing a whole repository.

### 2. Select the review agent

Run the code-review agent (a dedicated review agent session) against the target. Do not run the review as an inline edit — the review agent's job is to read and report, not to change code.

### 3. Produce the review

Report findings in priority order:

- **Blockers** — bugs, data loss risks, broken behavior, missing error handling.
- **Should fix** — correctness gaps, edge cases, concurrency issues, API misuse.
- **Nits** — style, naming, typos, suggestions.

Each finding must cite the location (`file.ts:line`) and the evidence (the code it contradicts). If the change is clean, say so explicitly instead of inventing issues.

## Guidelines

- Read-only: reviewing never modifies the code under review. Suggested fixes go in the report, not in the editor.
- Keep the review scoped to the target — do not expand into unrelated files.
- Separate findings from questions: if the intent is unclear, ask rather than guessing the author's goal.
