---
name: skill-builtin-review-bugbot
description: "Bugbot review — runs Bugbot against a pull request. Use when the user types /review-bugbot or wants Bugbot's automated PR review: reviews the PR, finds issues, and suggests fixes."
---
<!-- Customize this skill and select save to override its behavior. Delete that copy to restore the built-in behavior. -->

# Bugbot Review

Run Bugbot's automated review against a pull request: it reviews the PR, finds issues, and suggests fixes.

## When to Use

- The user types `/review-bugbot` or asks for Bugbot's review of a pull request.
- The user wants an automated, no-intervention review pass on PR changes before or during review.

## Workflow

### 1. Resolve the PR

Identify the pull request to review (number or URL). If the user gives no PR, use the PR for the current branch. Without a resolvable PR, stop and ask — Bugbot reviews PRs, not arbitrary local diffs.

### 2. Request the Bugbot review

Trigger Bugbot on the PR and wait for its findings. Bugbot reviews the PR, finds issues, and suggests fixes inline as PR comments/suggestions.

### 3. Report the outcome

Summarize what Bugbot found:

- The issues Bugbot flagged (bugs, risks, correctness problems), with file/line references.
- The fixes Bugbot suggested, and which are safe to apply as-is.
- Any limitations encountered (e.g. a PR too large to fully review — very large PRs may get only a partial or explained review).

## Guidelines

- Bugbot is advisory: applying a suggested fix is a deliberate action, confirmed separately for risky or ambiguous changes.
- Do not re-implement Bugbot's findings by hand-editing silently — present them first, apply on confirmation.
- Keep the report anchored to the PR; do not drift into reviewing unrelated code.
