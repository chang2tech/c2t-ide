---
name: create-hook
description: Creates hooks and updates hooks.json. Use when the user wants the agent to run a command automatically at a lifecycle event (before/after shell execution, file edits, tool use) — generates the hook entry and writes it into hooks.json.
---
<!-- Customize this skill and select save to override its behavior. Delete that copy to restore the built-in behavior. -->

# Create Hook

Help the user create a hook: a command that runs automatically at an agent lifecycle event, with the entry registered in `hooks.json`.

## When to Use

- The user asks to create, add, or author a hook (e.g. "run lint after every file edit", "block rm -rf").
- The user wants guardrails or automation around shell execution, file edits, tool use, or session/subagent events.

## Workflow

### 1. Clarify the event and the action

Ask two things:

1. **Which event** fires the hook. Supported events include:
   - Agent: `sessionStart`, `sessionEnd`, `preToolUse`, `postToolUse`, `postToolUseFailure`, `subagentStart`, `subagentStop`, `beforeShellExecution`, `afterShellExecution`, `beforeMCPExecution`, `afterMCPExecution`, `beforeReadFile`, `afterFileEdit`, `beforeSubmitPrompt`, `preCompact`, `stop`, `afterAgentResponse`, `afterAgentThought`
   - Tab: `beforeTabFileRead`, `afterTabFileEdit`
   - App lifecycle: `workspaceOpen`
2. **What the command does** — the script or command to run.

### 2. Design the hook entry

A command-based hook entry has this shape:

```json
{
  "command": ".cursor/hooks/guard.sh",
  "type": "command",
  "timeout": 30,
  "loop_limit": 5,
  "failClosed": true,
  "matcher": "curl|wget|rm -rf"
}
```

Mechanics to use correctly:

- **Exit code 2** = block the action (deny); other non-zero exit codes are fail-open (the action proceeds).
- **failClosed:** `true` means hook failures block the action instead of allowing it. Default is fail-open; set `failClosed: true` for guardrails.
- **loop_limit:** caps follow-up loops for `stop` / `subagentStop` hooks (default 5); `null` = unlimited.
- **matcher:** regex that narrows the event — for `beforeShellExecution` it matches the command text; for `preToolUse` the tool type (including `MCP:<tool>`); for `subagentStart` the subagent type; for `beforeSubmitPrompt` use `UserPromptSubmit`; for `stop` use `Stop`.

### 3. Update hooks.json

Register the entry under the event key in `hooks.json`:

```json
{
  "version": 1,
  "hooks": {
    "beforeShellExecution": [
      {
        "command": ".cursor/hooks/guard.sh",
        "type": "command",
        "timeout": 30,
        "matcher": "curl|wget|rm -rf"
      }
    ]
  }
}
```

- **Project level:** `hooks.json` in the project applies to the project.
- **User level:** a user-level `hooks.json` applies to every project.

When several levels define hooks for the same event, merge priority is Enterprise → Team → Project → User, and verdicts merge **deny > ask > allow**.

### 4. Verify

- `hooks.json` stays valid JSON after the edit and keeps `"version": 1`.
- The command path exists and is executable.
- The matcher is a valid regex and only matches what the user intends — an over-broad matcher blocks or slows normal work.
- State which level the hook was registered at (project or user).

## Guidelines

- Prefer narrow matchers over broad ones; a hook on every event is a performance tax on the whole session.
- For a block-style guardrail, remember: deny comes from exit code 2, and consider `failClosed: true` so a crashed guard can't be bypassed.
- Cloud agents run command-based project hooks only — user-level hooks under `~/.cursor/` are not available there.
