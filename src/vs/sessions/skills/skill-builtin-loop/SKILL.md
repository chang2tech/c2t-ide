---
name: skill-builtin-loop
description: Recurring skill execution. Use when the user types /loop or wants a skill run repeatedly until a goal is reached or they stop it — run the skill, inspect each iteration's result, and stop on success or on user request.
---
<!-- Customize this skill and select save to override its behavior. Delete that copy to restore the built-in behavior. -->

# Loop

Run a skill repeatedly as a recurring execution: each iteration runs the skill, the result is inspected, and the loop continues until a completion condition is met or the user stops it.

## When to Use

- The user types `/loop` or asks to "keep doing this until..." — e.g. keep running a check until it passes, keep polling until a condition holds, keep retrying a flaky step.
- The task is naturally iterative: each run's output decides whether another run is needed.
- One-off execution is not enough; the work only ends when a goal state is reached.

## Workflow

### 1. Pick the skill and the goal

Identify the skill to execute each iteration and define the completion condition in concrete terms: what result counts as "done". If the user didn't set one, agree on it before looping.

### 2. Set stop conditions

Agree on when the loop must stop even without success: a maximum number of iterations, a time budget, and that the user can stop it at any time. Never loop unbounded without an explicit user decision.

### 3. Execute and inspect each iteration

Run the skill. After each iteration, check the result against the completion condition:

- **Goal reached** — stop and report the final result.
- **Not reached, progress made** — continue with the next iteration, carrying forward what was learned.
- **Not reached, stuck or regressing** — stop and report why, instead of looping blindly.

### 4. Report

Summarize what was done across iterations: how many runs, what changed between them, and the final state.

## Guidelines

- The completion condition is mandatory — a loop without one is just repetition.
- Inspect every iteration's output before the next run; never fire-and-forget a loop.
- Stop early on repeated failure: surface the blocker to the user instead of burning iterations.
- The user can stop the loop at any time; ending the loop must end all scheduled iterations.
