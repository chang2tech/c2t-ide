---
name: skill-builtin-canvas
description: Interactive React artifacts. Use when the user types /canvas or asks for interactive content — charts, diagrams, documents, or live previews — rendered as a React artifact in a canvas the user can view and iterate on.
---
<!-- Customize this skill and select save to override its behavior. Delete that copy to restore the built-in behavior. -->

# Canvas

Create interactive React artifacts: rich, interactive content (charts, diagrams, documents, live previews) rendered in a canvas the user can view and interact with, rather than plain chat text.

## When to Use

- The user types `/canvas` or asks for interactive output — a visualization, a document to read through, a mockup, or a preview they can play with.
- The content is better presented as an interactive artifact than as markdown or code in the transcript.
- The user wants to iterate visually: view a rendered version, give feedback, and see the artifact update.

## Workflow

### 1. Determine the artifact

Clarify what the user wants to see: the content (data, text, UI mockup), the type of interactivity (charts, toggles, navigation, editing), and whether they want to iterate on it or just view the result.

### 2. Build the React artifact

Create the artifact as a React component with the user's content. Keep it self-contained: all data it needs is bundled in, and interactions work inside the canvas without extra setup.

### 3. Present and iterate

Render the artifact in a canvas and show it to the user. When they give feedback, update the artifact and re-render — the canvas is a working surface, not a one-shot export.

## Guidelines

- Use a canvas when interactivity is the point; plain text answers stay in chat.
- Keep artifacts focused: one artifact per question, not a dashboard of everything.
- Canvases can be shared as setup templates through plugins so teams reuse the same artifact scaffolds.
