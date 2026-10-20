---
name: skill-builtin-autopilot
description: "Autopilot — hand a pull request to a cloud agent: Monitors PR, addresses review feedback, resolves merge conflicts, and fixes failing checks. Use when the user types /autopilot or wants a PR watched and kept green."
---
<!-- Customize this skill and select save to override its behavior. Delete that copy to restore the built-in behavior. -->

# Autopilot

Hand a pull request to a cloud agent that takes it over: the agent monitors the PR and addresses review feedback, merge conflicts, and failing checks.

## When to Use

- The user types `/autopilot` or asks for a PR to be "kept green" automatically.
- The user wants a cloud agent to take over a PR end-to-end — responding to review comments, rebasing/resolving conflicts, and re-running or fixing failing checks — without manual intervention.

## Workflow

### 1. Resolve the PR

Identify the pull request (number or URL). If the user gives no PR, use the PR for the current branch. Confirm the branch is pushed and the PR exists before engaging autopilot.

### 2. Engage the cloud agent

Hand the PR to the cloud agent with the instruction to monitor it continuously. The agent then:

- **Addresses review feedback** — responds to review comments, applies requested changes, and re-requests review where appropriate.
- **Resolves merge conflicts** — rebases or merges the base branch and fixes conflicts.
- **Fixes failing checks** — investigates CI failures, makes the necessary code or config changes, and pushes updates.

### 3. Monitor and report

Keep the user informed of what the agent did:

- Which feedback it addressed and how.
- How conflicts were resolved.
- Which checks failed, what was fixed, and the current CI status.

Stop and ask the user when the agent hits a decision it cannot make (e.g. a review requests a design change, or a conflict requires a judgment call).

## Guidelines

- Autopilot is a cloud agent taking over — it acts with the agent's normal permissions; scope them before handing off.
- Never silently force-push or rewrite history on a shared PR branch without the user's explicit approval.
- If the PR author or reviewers raise a substantive objection, pause and surface it instead of letting the agent argue in circles.
