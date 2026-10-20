---
name: cursor-blame
description: Investigates AI-authored changes and the prompts that produced them. Use when the user asks who wrote a piece of code, whether code was AI-generated, what prompt or conversation produced a change, or wants to trace the origin of code (human vs Tab vs agent, by model).
---
<!-- Customize this skill and select save to override its behavior. Delete that copy to restore the built-in behavior. -->

# Cursor Blame

Investigate which parts of the code were authored by AI and trace the prompts or conversations that produced them.

## When to Use

- The user asks "who wrote this code" / "was this AI-generated".
- The user wants to know which prompt or agent session produced a change.
- The user wants an authorship breakdown of a file, diff, or selection (human vs Tab autocomplete vs agent, by model).

## Workflow

### 1. Determine scope

Use the narrowest scope the user gave you: the current selection, the open file, or the session's diff. If the scope is unclear, ask before scanning a whole repository.

### 2. Attribute each line or hunk

Combine, in this order:

1. **Local history / git blame** — map lines to commits and authors (human authors vs bot/agent commits).
2. **Session records** — match AI-produced hunks to the conversation, prompt, or agent run that created them (chat transcripts, checkpoints, Tab accept events).
3. **Model metadata** — when available, distinguish Tab completions from agent edits and note which model produced them.

Every AI-authored hunk should be traced to the prompt that produced it. If a hunk cannot be traced to a prompt, say so explicitly and mark confidence as low.

### 3. Report

Present a compact table:

| Location | Authored by | Prompt / source |
|---|---|---|
| `file.ts:12-30` | Agent (model X) | "Add retry logic to fetch" — session chat, 14:02 |
| `file.ts:31-40` | Human (author) | commit `abc123` |
| `file.ts:41-44` | Tab autocomplete | accepted suggestion, 14:05 |

Then summarize: what the AI changed, why (the intent behind the originating prompt), and anything that looks inconsistent with the prompt — e.g. AI edits that drifted beyond what was asked.

## Guidelines

- Never present a guess as a traced fact: label each attribution with its evidence (commit id, transcript reference, or "untraceable").
- Do not reveal prompts from other users' sessions.
- Keep the investigation read-only: do not modify code while blaming.
