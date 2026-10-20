/**
 * WORKER-GAPS-11G — the built-in `loop` skill (recurring skill execution).
 *
 * Binary evidence (Cursor 3.25.9):
 * 1. Client slash menu (workbench.desktop.main.js, "slashMenuData.js",
 *    offset 18202214): `loop:{searchKeywords:["Repeat","Recurring","Interval","Periodic"]}`
 *    — /loop IS a client slash-menu entry in 3.25.9 (entries are keyed
 *    WITHOUT the "/" prefix, which is why a `"/loop"` literal grep finds
 *    nothing; the entry exists all the same).
 * 2. Agent-host daemon
 *    (extensions/cursor-agent-host/dist/agent-host-daemon/dist/bin/daemon.cjs):
 *    `LOOP_PROTECTED_SKILL_NAMES=new Set(["loop"])` — the skill-catalog
 *    budget trimmer (`applySkillCatalogBudget`) skips trimming the `loop`
 *    skill's description when the `protectLoopSkill` feature flag is on:
 *    `protectLoopSkill===true
 *       ? skill=>isProtectedSkill(skill)||LOOP_PROTECTED_SKILL_NAMES.has(skillNameFromPath(skill.fullPath))
 *       : isProtectedSkill`
 * 3. Daemon prompt guidance covers the loop domain: "standing watch",
 *    "recurring job", "every N minutes/hours/days", "routine, schedule,
 *    reaction/emoji trigger" (daemon.cjs offset ~16146411).
 * Docs (cursor.com/docs via docs/rea/deep-docs-all.md): `| /loop | Recurring
 * skill execution |`.
 *
 * HONEST-DIVERGENCE (skill content): Cursor's loop skill body is server-synced
 * (no `skills-cursor/loop/` ships in the app) — its exact text is UNKNOWN.
 * LOOP_SKILL_CONTENT below is a LOCAL reconstruction of the loop domain from
 * the daemon's own guidance language. The protection MECHANISM
 * (LOOP_PROTECTED_SKILL_NAMES + flag) is ported verbatim.
 *
 * Kept vscode-free so it unit-tests under plain node
 * (see src/services/test/run-loop-skill-tests.ts).
 */

/** The skill's canonical name (matches Cursor's daemon set entry). */
export const LOOP_SKILL_NAME = "loop";

/**
 * Ported verbatim from Cursor's agent-host daemon:
 * `LOOP_PROTECTED_SKILL_NAMES=new Set(["loop"])`.
 * Skills in this set keep their FULL description when the skill catalog is
 * budget-trimmed for the request context.
 */
export const LOOP_PROTECTED_SKILL_NAMES: ReadonlySet<string> = new Set(["loop"]);

/**
 * Cursor's `protectLoopSkill` feature flag. We default it ON: the loop
 * skill's description must never be trimmed from the catalog — that is the
 * whole point of the mechanism.
 */
export let protectLoopSkillDescription = true;

/** Test seam for the flag above. */
export function setProtectLoopSkillDescription(on: boolean): void {
  protectLoopSkillDescription = on;
}

/** True when the named skill's description is protected from catalog trimming. */
export function isLoopSkillProtected(skillName: string): boolean {
  return protectLoopSkillDescription && LOOP_PROTECTED_SKILL_NAMES.has(skillName);
}

/**
 * Binary-exact search keywords from Cursor 3.25.9's slashMenuData.js:
 * `loop:{searchKeywords:["Repeat","Recurring","Interval","Periodic"]}`.
 */
export const LOOP_SKILL_KEYWORDS: readonly string[] = ["Repeat", "Recurring", "Interval", "Periodic"];

/**
 * The binary's slashMenuData entry carries NO description; the description
 * comes from Cursor's official docs: "Recurring skill execution".
 */
export const LOOP_SKILL_DESCRIPTION = "Recurring skill execution";

/**
 * Built-in loop skill body. HONEST-DIVERGENCE: reconstructed locally from
 * the daemon's loop-domain guidance ("standing watch", "recurring job",
 * "every N minutes/hours/days", "routine, schedule, reaction/emoji trigger");
 * Cursor's server-synced original is not shipped and its exact text is UNKNOWN.
 */
export const LOOP_SKILL_CONTENT = `---
name: loop
description: ${LOOP_SKILL_DESCRIPTION}
---

# loop — recurring skill execution

Use when the user asks for standing, recurring, or scheduled behavior:
"watch this", "every N minutes/hours/days", "keep an eye on",
"let me know when", routine checks, recurring jobs, reaction/emoji
triggers — any "standing order" that outlives a single turn.

## Standing-order semantics
- An earlier clear user request still authorizes the recurring work; the
  ask does not need to be repeated in the latest turn.
- A later trusted message that stops, pauses, or redirects the standing
  ask revokes it. When revoked, stop cleanly and confirm.
- Never invent a standing or recurring task on your own: only set one up
  when the user asked for a routine, schedule, standing watch, recurring
  job, or "every N minutes/hours/days" behavior.

## Execution
- For time-based recurrence, register the work with the local scheduled
  tasks runner (cron) when one is available; otherwise state the cadence
  and perform the first check now.
- For event-based recurrence (reaction/emoji trigger, "tell me when X
  changes"), describe the trigger condition precisely and confirm what
  will fire it.
- Each firing is a fresh, scoped pass: observe, compare against the last
  known state, and report only what changed. Stay quiet when nothing
  changed unless the user asked for a heartbeat.
- Persist the last-known state (what was seen, when) so consecutive runs
  can diff instead of re-reporting.

## Arguments
Extra text after /loop is the standing instruction, e.g.
\`/loop every morning check CI on main and report failures\`.
`;

export interface CatalogSkillLike {
  name: string;
  description: string;
}

/**
 * The fork's `applySkillCatalogBudget` analog. Cursor's daemon skips trimming
 * the loop skill's description when the protect flag is on; we have no
 * trimmer today, so this enforces the invariant at the catalog-assembly
 * boundary: protected skills always keep their full description.
 *
 * Returns a new array; entries are shared by reference except protected
 * ones whose description was (hypothetically) shortened, which are restored
 * from the provided full descriptions.
 */
export function applyLoopSkillProtection<T extends CatalogSkillLike>(
  skills: readonly T[],
  fullDescriptions: ReadonlyMap<string, string> = new Map(),
): T[] {
  return skills.map((s) => {
    if (!isLoopSkillProtected(s.name)) return s;
    const full = fullDescriptions.get(s.name);
    if (full !== undefined && s.description !== full) {
      return { ...s, description: full };
    }
    return s;
  });
}
