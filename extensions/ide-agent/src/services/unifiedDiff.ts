/**
 * GAPS-12 (approval-card-diff) — unified-diff helpers for the file-edit
 * approval card.
 *
 * Cursor parity (docs/rea/deepdig-runtime-approval-2026-10-19.md §3.11, §5,
 * §6, matrix `approval-card-diff`): "File-edit approvals include a unified
 * diff (context 2) of the proposed change", arriving as
 * `approvalDetails: { type: "fileEdit", isNewFile, diffString }`.
 *
 * The engine (ide-code sidecar, packages/core/src/tool/plugin/edit.ts and
 * write.ts) computes the preview with the `diff` npm package's
 * `createTwoFilesPatch(file, file, before, after)` — whose DEFAULT context
 * is 3 — and attaches it to the permission request as
 * `metadata: { files: [{ file, patch, additions, deletions, status }] }`.
 * This module trims that engine patch down to Cursor's context of 2 and
 * exposes the parsed shape the approval card needs. The `-`/`+` lines are
 * never altered: only surrounding context is trimmed and hunks re-emitted.
 */

/**
 * Unified-diff context lines Cursor shows in the file-edit approval card.
 * Evidence-verbatim: deepdig-runtime-approval-2026-10-19.md §3.11 —
 * "approval card shows a unified diff (context: 2)".
 */
export const APPROVAL_DIFF_CONTEXT = 2;

/** Hunk header: `@@ -oldStart[,oldCount] +newStart[,newCount] @@[ section]`. */
const HUNK_HEADER_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/;

interface ParsedHunk {
  header: string;
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  section: string;
  /** Body lines, each prefixed with ' ', '-', '+', or a '\' marker line. */
  lines: string[];
}

/**
 * True when the patch contains at least one hunk. An engine patch with no
 * changes is headers only (`Index:` / `---` / `+++`) — the approval card
 * must not render an empty diff block for it.
 */
export function hasDiffHunks(patch: string): boolean {
  return /^@@ -\d/m.test(patch);
}

/**
 * Trim a unified diff's context down to `context` lines per side
 * (default {@link APPROVAL_DIFF_CONTEXT}).
 *
 * - Leading/trailing context of every hunk is cut to `context` lines.
 * - Hunks whose change clusters are separated by more than 2*context
 *   context lines are split into separate hunks (standard unified-diff
 *   hunk merging at the new context size).
 * - Hunk headers are recomputed (`@@ -a,b +c,d @@`); a count of 1 is
 *   emitted without `,1`, matching the `diff` package's format.
 * - `\ No newline at end of file` markers are preserved exactly when the
 *   emitted hunk still ends at the file's original end.
 * - Lines before the first hunk (`Index:`, `===`, `---`, `+++`) pass
 *   through verbatim. `-`/`+` content lines are never modified.
 */
export function trimUnifiedDiffContext(patch: string, context: number = APPROVAL_DIFF_CONTEXT): string {
  const lines = patch.split("\n");
  // Drop the single trailing "" produced by a final "\n" — it is not content.
  if (lines.length > 0 && lines[lines.length - 1] === "") {
    lines.pop();
  }
  const firstHunk = lines.findIndex((l) => HUNK_HEADER_RE.test(l));
  if (firstHunk === -1) {
    return lines.join("\n") + (lines.length > 0 ? "\n" : "");
  }
  const prelude = lines.slice(0, firstHunk);

  // Parse hunks.
  const hunks: ParsedHunk[] = [];
  let cur: ParsedHunk | null = null;
  for (const line of lines.slice(firstHunk)) {
    const m = HUNK_HEADER_RE.exec(line);
    if (m) {
      cur = {
        header: line,
        oldStart: parseInt(m[1], 10),
        oldCount: m[2] === undefined ? 1 : parseInt(m[2], 10),
        newStart: parseInt(m[3], 10),
        newCount: m[4] === undefined ? 1 : parseInt(m[4], 10),
        section: m[5],
        lines: [],
      };
      hunks.push(cur);
    } else if (cur) {
      cur.lines.push(line);
    }
  }

  // The engine emits `\ No newline at end of file` only at the very end of
  // each side's content. Record which source line numbers carry the marker
  // so re-emitted hunks can reattach it exactly (or drop it when the hunk
  // no longer reaches end-of-file).
  const noNewlineOld = new Set<number>();
  const noNewlineNew = new Set<number>();
  for (const h of hunks) {
    let oldNo = h.oldStart;
    let newNo = h.newStart;
    for (let i = 0; i < h.lines.length; i++) {
      const l = h.lines[i];
      if (l.startsWith("\\")) {
        const prev = h.lines[i - 1];
        if (prev !== undefined && (prev.startsWith(" ") || prev.startsWith("-"))) {
          noNewlineOld.add(oldNo - 1);
        }
        if (prev !== undefined && (prev.startsWith(" ") || prev.startsWith("+"))) {
          noNewlineNew.add(newNo - 1);
        }
        continue;
      }
      const c = l.charAt(0);
      if (c === " ") {
        oldNo++;
        newNo++;
      } else if (c === "-") {
        oldNo++;
      } else if (c === "+") {
        newNo++;
      }
    }
  }

  const out: string[] = [...prelude];
  for (const h of hunks) {
    // Annotate body lines with their source line numbers (markers excluded).
    interface BodyLine {
      text: string;
      kind: "ctx" | "del" | "add";
      oldNo: number;
      newNo: number;
    }
    const body: BodyLine[] = [];
    let oldNo = h.oldStart;
    let newNo = h.newStart;
    for (const l of h.lines) {
      if (l.startsWith("\\")) {
        continue; // reattached on emit
      }
      const c = l.charAt(0);
      if (c === " ") {
        body.push({ text: l, kind: "ctx", oldNo, newNo });
        oldNo++;
        newNo++;
      } else if (c === "-") {
        body.push({ text: l, kind: "del", oldNo, newNo });
        oldNo++;
      } else if (c === "+") {
        body.push({ text: l, kind: "add", oldNo, newNo });
        newNo++;
      } else {
        // Unknown line shape — keep it as context so nothing is lost.
        body.push({ text: l, kind: "ctx", oldNo, newNo });
        oldNo++;
        newNo++;
      }
    }

    // Group change clusters: split where > 2*context context lines separate them.
    const changeIdx = body.map((b, i) => (b.kind === "ctx" ? -1 : i)).filter((i) => i >= 0);
    const groups: Array<[number, number]> = [];
    let gs = -1;
    let prev = -1;
    for (const i of changeIdx) {
      if (gs === -1) {
        gs = i;
      } else if (i - prev - 1 > 2 * context) {
        groups.push([gs, prev]);
        gs = i;
      }
      prev = i;
    }
    if (gs !== -1) {
      groups.push([gs, prev]);
    }

    // A hunk that already satisfies the target context passes through
    // byte-identical (headers, marker placement, everything) — the trimmer
    // only rewrites hunks it actually changes. A hunk with no change lines
    // is malformed input; pass it through rather than dropping lines.
    if (
      groups.length === 0 ||
      (groups.length === 1 &&
        groups[0][0] <= context &&
        body.length - 1 - groups[0][1] <= context)
    ) {
      out.push(h.header);
      for (const l of h.lines) {
        out.push(l);
      }
      continue;
    }

    for (const [gFirst, gLast] of groups) {
      const emitFirst = Math.max(0, gFirst - context);
      const emitLast = Math.min(body.length - 1, gLast + context);
      const slice = body.slice(emitFirst, emitLast + 1);
      const oStart = slice[0].oldNo;
      const nStart = slice[0].newNo;
      const oCount = slice.filter((b) => b.kind !== "add").length;
      const nCount = slice.filter((b) => b.kind !== "del").length;
      out.push(
        `@@ -${oStart}${oCount === 1 ? "" : `,${oCount}`} +${nStart}${nCount === 1 ? "" : `,${nCount}`} @@${h.section}`,
      );
      for (const b of slice) {
        out.push(b.text);
      }
      // Reattach end-of-file markers exactly when this emitted hunk still
      // ends at the file's original end on that side.
      const lastOld = [...slice].reverse().find((b) => b.kind !== "add");
      const lastNew = [...slice].reverse().find((b) => b.kind !== "del");
      if (lastOld && noNewlineOld.has(lastOld.oldNo)) {
        out.push("\\ No newline at end of file");
      }
      if (lastNew && noNewlineNew.has(lastNew.newNo)) {
        out.push("\\ No newline at end of file");
      }
    }
  }
  return out.join("\n") + "\n";
}

export interface EngineFileDiff {
  file?: unknown;
  patch?: unknown;
  status?: unknown;
}

/**
 * Build the approval-card diff payload from an engine `permission.asked`
 * event's `metadata` (`{ files: [{ file, patch, status }] }` — see
 * packages/core/src/tool/plugin/edit.ts and write.ts).
 *
 * Returns undefined when there is no usable file diff (not a file edit, or
 * the patch has no hunks) — the card then renders without a diff block.
 * The patch is trimmed to {@link APPROVAL_DIFF_CONTEXT} lines.
 */
export function buildFileEditApprovalDetails(metadata: unknown): {
  type: "fileEdit";
  isNewFile: boolean;
  diffString: string;
} | undefined {
  if (typeof metadata !== "object" || metadata === null) {
    return undefined;
  }
  const files = (metadata as { files?: unknown }).files;
  if (!Array.isArray(files) || files.length === 0) {
    return undefined;
  }
  const first = files[0] as EngineFileDiff;
  if (typeof first !== "object" || first === null) {
    return undefined;
  }
  if (typeof first.patch !== "string" || !hasDiffHunks(first.patch)) {
    return undefined;
  }
  return {
    type: "fileEdit",
    isNewFile: first.status === "added",
    diffString: trimUnifiedDiffContext(first.patch, APPROVAL_DIFF_CONTEXT),
  };
}
