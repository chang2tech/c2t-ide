---
name: skill-builtin-update-cli-config
description: "Updates ~/.cursor/cli-config.json. Finds and updates Cursor CLI configuration values at the user's request. Use when the user types /update-cli-config or wants to change a CLI config value."
---
<!-- Customize this skill and select save to override its behavior. Delete that copy to restore the built-in behavior. -->

# Update CLI Config

Find and update a Cursor CLI configuration value in `~/.cursor/cli-config.json`, then confirm the change took effect.

## When to Use

- The user types `/update-cli-config` or asks to change a CLI configuration value.
- The user wants to see what the CLI is currently configured with before deciding what to change.

## Workflow

### 1. Read the current config

Open `~/.cursor/cli-config.json` and show the user the current values, so they can see the starting point. If the file does not exist, say so and stop — do not invent config content.

### 2. Identify the change

Ask which key the user wants to change and what the new value should be, unless they already said so. Confirm the value's expected type before writing.

### 3. Apply the change

Update only the requested key in `~/.cursor/cli-config.json`, leaving every other value untouched. Write valid JSON back to the file.

### 4. Verify

Re-read the file and show the updated value to the user. Note that some keys only take effect after the CLI is restarted — say so when relevant.

## Guidelines

- Change exactly what the user asked for; never rewrite or "clean up" unrelated config keys.
- Validate the JSON after writing so a typo does not corrupt the config.
- If the requested key does not exist, ask before adding it rather than assuming it is valid.
