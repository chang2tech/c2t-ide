---
name: skill-builtin-split-to-prs
description: Splits large changes into smaller PRs. Use when the user types /split-to-prs or wants a large branch or worktree diff broken into a stack of smaller, independently reviewable pull requests, each focused on one logical concern.
---
<!-- Customize this skill and select save to override its behavior. Delete that copy to restore the built-in behavior. -->

# Split to PRs

Take a large set of changes and split it into a stack of smaller pull requests, so each PR is independently reviewable and focused on one logical concern.

## When to Use

- The user types `/split-to-prs` or says a branch/worktree is "too big to review".
- The current diff mixes several concerns (refactor + feature + fixes) that reviewers would evaluate separately.
- The change is large enough that splitting improves review quality and merge safety.

## Workflow

### 1. Survey the changes

Review the full scope of changes against the base: which files changed, what each change does, and which changes depend on each other. Do not split without this map — order and dependencies drive the stack.

### 2. Group into logical units

Partition the changes into units where each unit is one concern: a refactor, a feature, a fix, a test addition. Each unit must be:

- **Self-contained** — reviewable and (ideally) shippable on its own.
- **Ordered** — later units build on earlier ones; dependencies point downward in the stack.

If a change can't stand alone or has no clean boundary, say so rather than forcing a split.

### 3. Create the stack

Create one branch per unit, each based on the previous unit's branch (stacked), and open a PR per branch:

- Each PR's description explains its unit and notes the stack position (what it builds on, what builds on it).
- Keep the bottom of the stack mergeable first; reviewers work bottom-up.

### 4. Verify

Confirm each PR's diff contains only its unit's changes and that the full stack, taken together, reproduces the original change set. Flag any unit that only makes sense combined with another — merge those back together.

## Guidelines

- Splitting is for reviewability, not vanity: don't split a coherent change into noise.
- One concern per PR; a PR that needs two reviewers' context is probably two PRs.
- Keep the stack small enough to manage — a huge stack is as unreviewable as one huge PR.
- Never lose changes in the split: every change in the original set lands in exactly one PR.
