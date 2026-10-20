---
name: skill-builtin-update-cursor-settings
description: "Finds/updates Cursor/VS Code setting. Locates a Cursor or VS Code setting by name and updates its value. Use when the user types /update-cursor-settings or wants to change an IDE setting."
---
<!-- Customize this skill and select save to override its behavior. Delete that copy to restore the built-in behavior. -->

# Update Cursor Settings

Find a Cursor or VS Code setting by name, show its current value, and update it at the right scope.

## When to Use

- The user types `/update-cursor-settings` or asks to find or change an IDE setting.
- The user knows roughly what they want ("the font size thing") but not the exact setting id.

## Workflow

### 1. Find the setting

Search the settings by name or keyword and identify the exact setting id. Show the user the current value and where it is defined (user settings vs workspace settings) before changing anything.

### 2. Confirm the change

When the request is ambiguous — several settings match, or the new value is unclear — ask the user which setting and which value they want. Do not guess on settings that change behavior.

### 3. Apply at the right scope

Update the setting at the narrowest scope that satisfies the request: workspace settings when the change is project-specific, user settings when the user wants it everywhere.

### 4. Verify

Re-read the setting and show the new value to the user, along with the scope it was written to.

## Guidelines

- Never change settings the user did not ask about.
- Prefer the narrowest scope; escalate to user scope only when the user asks for a global change.
- If a setting does not exist, say so instead of creating a lookalike key.
