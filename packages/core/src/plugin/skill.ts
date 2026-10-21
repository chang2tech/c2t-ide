/// <reference path="../markdown.d.ts" />

export * as SkillPlugin from "./skill.js"

import { define, type Context } from "@opencode/plugin/effect/plugin"
import { Document } from "@opencode/schema/config"
import { Effect } from "effect"
import { AbsolutePath } from "../schema.js"
import { Skill } from "../skill.js"
import { Config } from "../config.js"
import os from "os"
import opencodeContent from "./skill/opencode.md" with { type: "text" }
import reportContent from "./skill/report.md" with { type: "text" }
import reviewContent from "./skill/review.md" with { type: "text" }
import reviewBugbotContent from "./skill/review-bugbot.md" with { type: "text" }
import reviewSecurityContent from "./skill/review-security.md" with { type: "text" }
import cursorBlameContent from "./skill/cursor-blame.md" with { type: "text" }

export const OpencodeContent = opencodeContent
export const ReportContent = reportContent
export const ReviewContent = reviewContent
export const ReviewBugbotContent = reviewBugbotContent
export const ReviewSecurityContent = reviewSecurityContent
export const CursorBlameContent = cursorBlameContent

export const OpencodeDescription =
  "Use this skill for any question about OpenCode itself, including how OpenCode works, using or configuring it, migrating from V1 to V2, troubleshooting it, developing plugins or integrations, using the OpenCode SDK, clients, server, or API, and contributing to the OpenCode codebase. Also use it for OpenCode agents, commands, skills, tools, permissions, MCP servers, providers, models, themes, keybinds, formatters, the CLI, TUI, desktop app, and web app."
const REPORT_DESCRIPTION =
  "Use when the user wants to report an opencode issue or bug. Collect standard diagnostics, add user-specific reproduction context, and publish the issue with GitHub CLI."
// Built-in review skills. Mirrors Cursor's built-in skills
// (https://cursor.com/docs/skills): /review selects and runs the appropriate
// code-review agent; /review-bugbot reviews code for likely bugs and
// regressions; /review-security reviews code for security vulnerabilities;
// /cursor-blame investigates AI-authored changes and the prompts that
// produced them.
// HONEST DIVERGENCE: Cursor backs these with server-side Bugbot and
// Security Review backends. This IDE has no such backends; the skill
// contents instruct the local agent to perform the equivalent review
// directly with the repository and tools at hand (see the "Note on
// backends" section in each skill file).
export const ReviewDescription =
  "Select and run the appropriate code-review agent. Use when the user asks for a code review without naming a specific reviewer; prompts to choose between a bug-focused review, a security review, or a general code review, then runs it."
export const ReviewBugbotDescription =
  "Review code for likely bugs and regressions, Bugbot-style. Use when the user asks for a bug hunt, a regression check, or a pre-push review; focuses on logic errors, edge cases, and broken error handling, highest severity first."
export const ReviewSecurityDescription =
  "Review code for security vulnerabilities. Use when the user asks for a security review; checks injection, authentication and authorization, secrets, cryptography, SSRF, and other exploitable issues."
export const CursorBlameDescription =
  "Investigate AI-authored changes and the prompts that produced them. Use when the user asks which prompt or session produced a change, or whether a human or the AI wrote some code; traces diff hunks back to the originating conversation."

export const Plugin = define({
  id: "opencode.skill",
  effect: Effect.fn(function* (ctx) {
    const reportContent = yield* reportContentWithDiagnostics(ctx.app)
    yield* ctx.skill.transform((editor) => {
      editor.add(
        Skill.Info.make({
          id: Skill.ID.make("opencode"),
          name: Skill.Name.make("OpenCode"),
          description: OpencodeDescription,
          path: AbsolutePath.make("/builtin/opencode.md"),
          content: OpencodeContent,
        }),
      )
      editor.add(
        Skill.Info.make({
          id: Skill.ID.make("report"),
          name: Skill.Name.make("Report"),
          description: REPORT_DESCRIPTION,
          path: AbsolutePath.make("/builtin/report.md"),
          content: reportContent,
        }),
      )
      editor.add(
        Skill.Info.make({
          id: Skill.ID.make("review"),
          name: Skill.Name.make("Review"),
          description: ReviewDescription,
          path: AbsolutePath.make("/builtin/review.md"),
          content: ReviewContent,
        }),
      )
      editor.add(
        Skill.Info.make({
          id: Skill.ID.make("review-bugbot"),
          name: Skill.Name.make("Review Bugbot"),
          description: ReviewBugbotDescription,
          path: AbsolutePath.make("/builtin/review-bugbot.md"),
          content: ReviewBugbotContent,
        }),
      )
      editor.add(
        Skill.Info.make({
          id: Skill.ID.make("review-security"),
          name: Skill.Name.make("Review Security"),
          description: ReviewSecurityDescription,
          path: AbsolutePath.make("/builtin/review-security.md"),
          content: ReviewSecurityContent,
        }),
      )
      editor.add(
        Skill.Info.make({
          id: Skill.ID.make("cursor-blame"),
          name: Skill.Name.make("Cursor Blame"),
          description: CursorBlameDescription,
          path: AbsolutePath.make("/builtin/cursor-blame.md"),
          content: CursorBlameContent,
        }),
      )
    })
  }),
})

const reportContentWithDiagnostics = Effect.fn("SkillPlugin.reportContentWithDiagnostics")(function* (
  app: Context["app"],
) {
  const plugins = yield* configuredPlugins()
  // Under emulation on Windows ARM64, os.arch() reads x64 but PROCESSOR_IDENTIFIER still names the ARM host.
  const emulated =
    process.platform === "win32" && os.arch() === "x64" && process.env.PROCESSOR_IDENTIFIER?.startsWith("ARM")
  return [
    ReportContent,
    "",
    "## Runtime Diagnostics Snapshot",
    "",
    "These values were captured when the built-in report skill was registered. Verify them before publishing.",
    "",
    `- opencode version: ${app.version}`,
    `- install/channel: ${app.channel}`,
    `- OS: ${os.type()} ${os.release()} (${os.platform()} ${os.arch()}${emulated ? ", emulated on ARM64" : ""})`,
    `- Terminal: ${terminal()}`,
    `- Shell: ${shell()}`,
    `- Active plugins: ${plugins.length === 0 ? "None found in config" : plugins.join(", ")}`,
  ].join("\n")
})

const configuredPlugins = Effect.fn("SkillPlugin.configuredPlugins")(function* () {
  const config = yield* Config.Service
  return (yield* config.entries())
    .filter((entry): entry is Document => entry.type === "document")
    .flatMap((entry) => entry.info.plugins ?? [])
    .map((entry) => (typeof entry === "string" ? entry : entry.package))
    .toSorted()
})

function terminal() {
  return (
    [
      process.env.TERM_PROGRAM ? `TERM_PROGRAM=${process.env.TERM_PROGRAM}` : undefined,
      process.env.TERM ? `TERM=${process.env.TERM}` : undefined,
      process.env.COLORTERM ? `COLORTERM=${process.env.COLORTERM}` : undefined,
    ]
      .filter((item): item is string => item !== undefined)
      .join(", ") || "Unavailable: terminal environment variables are not set"
  )
}

function shell() {
  return (
    process.env.SHELL ??
    process.env.ComSpec ??
    process.env.COMSPEC ??
    "Unavailable: shell environment variable is not set"
  )
}
