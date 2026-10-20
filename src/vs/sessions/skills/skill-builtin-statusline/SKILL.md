---
name: skill-builtin-statusline
description: Configures the CLI status line. Use when the user types /statusline or wants to change what information the CLI shows in its status line while a session runs.
---
<!-- Customize this skill and select save to override its behavior. Delete that copy to restore the built-in behavior. -->

# Statusline

Configure the status line shown by the CLI: the persistent line of session information displayed while the CLI runs.

## When to Use

- The user types `/statusline` or asks to change, add, or remove what the CLI displays in its status line.
- The user wants different session information visible at a glance (or less noise) while working in the CLI.

## Workflow

### 1. See the current status line

Show the user what the status line currently displays, so they know the starting point.

### 2. Choose what to show

Ask what information they want on the status line and in what order. Typical candidates: current model, session or workspace identifier, and run state. Keep it to what they actually glance at — a status line crowded with fields stops being read.

### 3. Apply the configuration

Update the status line configuration with the chosen fields. Show the user the new layout and confirm it reads the way they expect.

### 4. Verify

Have the user run the CLI and confirm the status line shows the configured information. If something is missing or wrong, adjust the configuration and re-verify.

## Guidelines

- A status line is glanceable by design: prefer few, high-signal fields over exhaustive detail.
- Changing the status line only affects display, never the CLI's behavior.
- If the user can't name what they want shown, start from the current line and ask what to add or remove.
