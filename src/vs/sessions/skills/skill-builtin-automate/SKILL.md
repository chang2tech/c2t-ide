---
name: skill-builtin-automate
description: Creates Automations — scheduled or event-triggered agent tasks. Use when the user types /automate or wants an agent to run on a schedule (cron) or in response to events such as Slack messages, GitHub PR activity, Linear issues, Sentry/PagerDuty alerts, or custom webhooks.
---
<!-- Customize this skill and select save to override its behavior. Delete that copy to restore the built-in behavior. -->

# Automate

Create an Automation: an agent task that runs on a schedule (cron) or is triggered by events (Slack, GitHub, GitLab, Bitbucket, Linear, Sentry, PagerDuty, custom webhooks).

## When to Use

- The user types `/automate` or asks to automate a recurring or event-driven task ("run this every morning", "notify me when a PR opens", "triage new Sentry alerts").
- The work should run in the background on a trigger, not once right now.

## Workflow

### 1. Define the trigger

Pick exactly one trigger type with the user:

- **Schedule (cron):** the cadence (e.g. daily 09:00, every 15 minutes) and timezone.
- **Event:** the source and the event — supported sources include GitHub (PR opened/updated/merged, checks), GitLab, Bitbucket, Slack (message in a channel), Linear (issue created/updated), Sentry (new issue), PagerDuty (incident), or a custom webhook.
- For PR-triggered automations: note that PR triggers do not run on fork PRs.

### 2. Define the task

Write the agent instruction the automation will run when triggered: what it should read, what action it takes, and what output or side effect it must produce (comment, message, issue update, etc.).

### 3. Create the automation

Register the automation with its trigger, task instruction, and permissions scope. Confirm:

- The trigger configuration (schedule/cron expression or event source + matcher).
- The environment it runs in (isolated background/cloud agent).
- What credentials/integrations it needs (Slack, GitHub, etc.) and that they are connected.

### 4. Verify

- Re-state the trigger in plain language ("runs every weekday at 09:00" / "runs when a PR is opened in this repo") and get the user's confirmation.
- Confirm the automation is enabled and visible in the automations list.

## Guidelines

- An automation is a standing task, not a one-off agent run — if the user just wants something done now, don't create an automation.
- Keep the task instruction self-contained: the automation runs in its own session with no prior conversation context.
- Scope permissions to the minimum the task needs; a triggered agent that can touch everything is a liability.
