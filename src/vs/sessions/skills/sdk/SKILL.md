---
name: sdk
description: Helps build with the Cursor SDK. Use when the user wants to integrate or program against the Cursor SDK — initializing agents programmatically, managing sessions, calling tools, and handling events.
---
<!-- Customize this skill and select save to override its behavior. Delete that copy to restore the built-in behavior. -->

# Cursor SDK

Help the user build software on top of the Cursor SDK: programmatic agents, session management, tool calls, and event handling.

## When to Use

- The user asks about the Cursor SDK or wants to "build with the SDK".
- The user wants to drive agents from code: start sessions, send prompts, stream responses, react to tool calls and lifecycle events.
- The user needs help with SDK setup, authentication, configuration, or debugging SDK usage.

## Workflow

### 1. Clarify the goal

Identify what the user is building (e.g. a bot that runs agents, an integration that streams agent output into another app, automation around sessions) and which SDK surface it needs (sessions, prompts, tools, events, configuration).

### 2. Ground in the official SDK reference

Base all API usage on the current official Cursor SDK documentation and the installed SDK version in the user's project. Do not invent method names, options, or event names from memory — check the installed package or docs first. If the SDK surface you need is undocumented, say so instead of guessing.

### 3. Scaffold

Write minimal, runnable code that:

- Initializes the SDK client with the user's credentials/configuration.
- Creates a session and sends a prompt.
- Streams or awaits the agent response and surfaces tool calls.
- Handles errors (auth failures, rate limits, session expiry) with retries where appropriate.

### 4. Verify

- Run or typecheck the scaffold in the user's project when possible.
- Point out required configuration (API keys, CLI config) and where it lives.
- Summarize what the code does and what the user must provide (credentials, workspace path, model choice).

## Guidelines

- Prefer the smallest working example over a full framework.
- Keep credentials out of code samples — read them from the environment or the user's CLI config.
- If the SDK behavior differs from the docs, trust the installed version and note the discrepancy.
