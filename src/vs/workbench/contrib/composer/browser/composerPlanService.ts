/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// IDE-CODE: browser-layer implementation of `IComposerPlanService`
// (see `../common/composerPlanService.js` for the binary evidence and the
// Cursor-parity contract). Platform-agnostic: plan files are read through
// `IFileService`, so the service also registers on web builds (where no plan
// producer exists and the plan registry simply stays empty).

import { Disposable } from '../../../../base/common/lifecycle.js';
import { Emitter } from '../../../../base/common/event.js';
import { URI } from '../../../../base/common/uri.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { ITelemetryService } from '../../../../platform/telemetry/common/telemetry.js';
import {
	AcceptedPlan,
	IComposerPlanService,
	PLAN_ACCEPTED_ANALYTICS_EVENT,
	PlanAcceptOptions,
	PlanExecutionData,
	PlanTodo,
} from '../common/composerPlanService.js';

interface PlanRecord {
	readonly bubbleId: string;
	readonly planUri: URI;
	readonly planText: string;
}

/** The fork plan-file header `savePlanFile` writes (`# Plan — <ISO>` + blank line). */
const FORK_PLAN_HEADER_REGEX = /^# Plan — .*\r?\n\r?\n/;

/** Strip YAML scalar decoration: surrounding quotes Cursor's dump may add. */
function unquoteYamlScalar(value: string): string {
	const v = value.trim();
	if (v.length >= 2 && ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith('\'') && v.endsWith('\'')))) {
		return v.slice(1, -1);
	}
	return v;
}

/**
 * GAPS-186: targeted parser for the Cursor plan frontmatter subset —
 * the shape `f$e` (@18657010) dumps and `g$e` reads: top-level `name:`
 * plus a `todos:` block list of `{ id, content, status, dependencies }`
 * maps (js-yaml dump, indent 2). This is deliberately NOT a general YAML
 * parser (no YAML library exists at this layer); a malformed block yields
 * the same defaults `g$e` falls back to (`name: ""`, `todos: []`).
 * `dependencies` accepts the inline `[a, b]` form and the block-list form.
 */
function parsePlanFrontmatter(block: string): { name: string; todos: PlanTodo[] } {
	let name = '';
	const todos: PlanTodo[] = [];
	let inTodos = false;
	let current: { id?: string; content?: string; status?: string; dependencies?: string[] } | undefined;
	let inDependencies = false;
	const flush = (): void => {
		if (current) {
			todos.push({
				id: current.id || `todo-${todos.length + 1}`,
				content: current.content ?? '',
				status: current.status || 'pending',
				...(current.dependencies && current.dependencies.length > 0 ? { dependencies: current.dependencies } : {}),
			});
			current = undefined;
		}
		inDependencies = false;
	};
	for (const rawLine of block.split(/\r?\n/)) {
		if (!rawLine.trim() || rawLine.trimStart().startsWith('#')) {
			continue;
		}
		const indent = rawLine.length - rawLine.trimStart().length;
		const line = rawLine.trim();
		if (indent === 0) {
			flush();
			inTodos = false;
			if (line.startsWith('name:')) {
				name = unquoteYamlScalar(line.slice('name:'.length));
			} else if (line === 'todos:' || line.startsWith('todos:')) {
				inTodos = true;
			}
			continue;
		}
		if (!inTodos) {
			continue;
		}
		if (line.startsWith('- ')) {
			flush();
			current = {};
			const rest = line.slice(2).trim();
			if (rest.startsWith('id:')) {
				current.id = unquoteYamlScalar(rest.slice('id:'.length));
			} else if (rest.startsWith('content:')) {
				current.content = unquoteYamlScalar(rest.slice('content:'.length));
			} else if (rest.startsWith('status:')) {
				current.status = unquoteYamlScalar(rest.slice('status:'.length));
			}
			continue;
		}
		if (!current) {
			continue;
		}
		if (inDependencies && line.startsWith('- ')) {
			(current.dependencies ??= []).push(unquoteYamlScalar(line.slice(2)));
			continue;
		}
		inDependencies = false;
		if (line.startsWith('content:')) {
			current.content = unquoteYamlScalar(line.slice('content:'.length));
		} else if (line.startsWith('status:')) {
			current.status = unquoteYamlScalar(line.slice('status:'.length));
		} else if (line.startsWith('id:')) {
			current.id = unquoteYamlScalar(line.slice('id:'.length));
		} else if (line.startsWith('dependencies:')) {
			const rest = line.slice('dependencies:'.length).trim();
			if (rest.startsWith('[') && rest.endsWith(']')) {
				current.dependencies = rest.slice(1, -1).split(',').map(d => unquoteYamlScalar(d)).filter(d => d.length > 0);
			} else {
				current.dependencies = [];
				inDependencies = true;
			}
		}
	}
	flush();
	return { name, todos };
}

const CHECKBOX_TODO_REGEX = /^\s*[-*]\s+\[([ xX])\]\s+(.+?)\s*$/;

/**
 * GAPS-186: fork port of Cursor's `_loadPlanExecutionData` (@18692365),
 * run over the plan text `acceptPlan` already resolved (the binary loads
 * through `planStorageService.loadPlanByUri`; the fork's file read +
 * recorded-text fallback in `acceptPlan` is the equivalent load — a text
 * that resolves empty never reaches extraction, mirroring the binary's
 * `if (!h) return` fail-closed path).
 *
 * Extraction sources, in binary order:
 * 1. A Cursor-style YAML frontmatter block at the top of the file
 *    (`metadata.name` -> `planName`, `metadata.todos` -> `planTodos`,
 *    body after the block -> `planContent`). Fork plan files are not
 *    written in this format today (the extension's `savePlanFile` writes
 *    `# Plan — <ISO>` + raw markdown), but a plan file the user edited —
 *    the file is the source of truth — or a future frontmatter-writing
 *    producer parses exactly like the binary.
 * 2. FORK-FORMAT fallback (documented divergence): with no frontmatter,
 *    the only todo-shaped data actually present in a fork plan text is
 *    its markdown checkbox items, so `- [ ]` / `- [x]` lines become
 *    `planTodos` (`[x]` -> `completed`, else `pending`). Ids are
 *    generated deterministically (`todo-<n>`) because the fork text
 *    carries none — the binary reads its ids from the frontmatter.
 *    Numbered steps are NOT extracted (indistinguishable from prose).
 *
 * `planTitle` ports `e7e` @15901077 verbatim: first `planContent` line
 * with a leading `#` stripped, else `planName`, else `"Untitled Plan"`.
 */
export function extractPlanExecutionData(rawText: string): PlanExecutionData {
	const withoutHeader = rawText.replace(FORK_PLAN_HEADER_REGEX, '');
	let planName = '';
	let planTodos: PlanTodo[] = [];
	let planContent = withoutHeader.trim();

	const frontmatterMatch = withoutHeader.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
	if (frontmatterMatch) {
		const parsed = parsePlanFrontmatter(frontmatterMatch[1]);
		planName = parsed.name;
		planTodos = parsed.todos;
		planContent = withoutHeader.slice(frontmatterMatch[0].length).trim();
	} else {
		const checkboxTodos: PlanTodo[] = [];
		for (const line of planContent.split(/\r?\n/)) {
			const m = line.match(CHECKBOX_TODO_REGEX);
			if (m) {
				checkboxTodos.push({
					id: `todo-${checkboxTodos.length + 1}`,
					content: m[2],
					status: m[1].trim() ? 'completed' : 'pending',
				});
			}
		}
		planTodos = checkboxTodos;
	}

	const firstLine = planContent.split('\n')[0]?.trim() ?? '';
	const planTitle = (firstLine.startsWith('#') ? firstLine.slice(1).trim() : firstLine) || planName || 'Untitled Plan';
	return {
		planName,
		planTitle,
		planTodos,
		nonCompletedTodos: planTodos.filter(t => t.status !== 'completed' && t.status !== 'cancelled'),
		planContent,
	};
}

/** Normalize the `bubbleId` command arg: string verbatim, or `{ id | bubbleId }`. */
function normalizeBubbleId(bubbleId: unknown): string | undefined {
	if (typeof bubbleId === 'string') {
		return bubbleId || undefined;
	}
	if (bubbleId && typeof bubbleId === 'object') {
		const id = (bubbleId as { id?: unknown }).id ?? (bubbleId as { bubbleId?: unknown }).bubbleId;
		return typeof id === 'string' && id ? id : undefined;
	}
	return undefined;
}

export class ComposerPlanService extends Disposable implements IComposerPlanService {

	declare readonly _serviceBrand: undefined;

	private readonly _onDidAcceptPlan = this._register(new Emitter<AcceptedPlan>());
	readonly onDidAcceptPlan = this._onDidAcceptPlan.event;

	/** composerId -> the plan currently awaiting review for that composer. */
	private readonly plans = new Map<string, PlanRecord>();

	constructor(
		@IFileService private readonly fileService: IFileService,
		@ILogService private readonly logService: ILogService,
		@ITelemetryService private readonly telemetryService: ITelemetryService,
	) {
		super();
	}

	recordPlan(composerId: string, bubbleId: string, planUri: URI, planText: string): void {
		this.plans.set(composerId, { bubbleId, planUri, planText });
	}

	clearPlan(composerId: string): void {
		this.plans.delete(composerId);
	}

	getPlanUriFromBubble(composerId: string, bubbleId: unknown): URI | undefined {
		const record = this.plans.get(composerId);
		if (!record) {
			return undefined;
		}
		// Same gate as Cursor's CREATE_PLAN-bubble check: only the bubble
		// that produced the plan resolves to a plan URI.
		const id = normalizeBubbleId(bubbleId);
		if (!id || id !== record.bubbleId) {
			return undefined;
		}
		return record.planUri;
	}

	async acceptPlan(composerId: string, planUri: URI, bubbleId?: unknown, source?: string, opts?: PlanAcceptOptions): Promise<void> {
		const record = this.plans.get(composerId);
		const recorded = record && record.planUri.toString() === planUri.toString() ? record : undefined;

		// The plan file is the source of truth (mirrors the fork data
		// service's execute_plan semantics: the user may have edited the plan
		// on disk after it was generated). Fall back to the recorded text
		// when the file cannot be read.
		let planText = recorded?.planText ?? '';
		try {
			const content = await this.fileService.readFile(planUri);
			const diskText = content.value.toString().trim();
			if (diskText) {
				planText = diskText;
			}
		} catch (e) {
			this.logService.warn('[composer] acceptPlan: cannot read plan file, using recorded text', planUri.toString(), e);
		}
		if (!planText) {
			this.logService.warn('[composer] acceptPlan: no plan content for', planUri.toString());
			return;
		}

		// GAPS-186: `_loadPlanExecutionData` port (binary @18692365) — the
		// extraction runs over the resolved plan text (see
		// `extractPlanExecutionData` for sources and divergences). The
		// binary loads BEFORE tracking/submitting and aborts when the
		// load fails; the fork's equivalent failure is the empty-text
		// return above, so extraction here always has real content.
		const executionData = extractPlanExecutionData(planText);

		// GAPS-186: analytics, binary-verbatim event + ordering
		// (`trackEvent("composer.plan_mode.plan_accepted", {...})`
		// @18685640 — after the load, before registerBuild/submit, and
		// before the binary's late `skipSubmission` return, so it fires
		// exactly once per successful accept INCLUDING skipSubmission,
		// and never on the no-content path above). Transport is the
		// fork's core precedent for `trackEvent`: `ITelemetryService.publicLog`
		// (cf. `composer.export_chat`, composerActions.ts). Properties are
		// limited to what this service can source truthfully:
		// `composer_id`, `source` (`?? "manual"`, binary-verbatim),
		// `todos_selected` (extracted planTodos length) and
		// `execution_target: "local"` (the fork has no background/cloud
		// plan execution — every fork accept submits to the local
		// extension engine; the binary derives "cloud" only from
		// `unifiedMode === "background"`, which the fork's boolean
		// `unifiedMode` option cannot express). UNKNOWN / omitted (no
		// source in this service — the composer's model config lives
		// with the extension-owned composer data): `model`,
		// `plan_execution_model`, `plan_execution_max_mode`,
		// `invocationID`. A telemetry failure must never break accept.
		try {
			this.telemetryService.publicLog(PLAN_ACCEPTED_ANALYTICS_EVENT, {
				composer_id: composerId,
				execution_target: 'local',
				todos_selected: executionData.planTodos.length,
				source: source ?? 'manual',
			});
		} catch (e) {
			this.logService.warn('[composer] acceptPlan: tracking plan_accepted failed', e);
		}

		this.clearPlan(composerId);

		if (opts?.skipSubmission) {
			return;
		}
		// Cursor submits the plan to the composer's engine here. The fork's
		// engine is extension-owned (see the interface docs); the accepted
		// plan is handed to the plan owner through this event.
		this._onDidAcceptPlan.fire({
			composerId,
			planUri,
			bubbleId: normalizeBubbleId(bubbleId),
			planText,
			source,
			planName: executionData.planName,
			planTitle: executionData.planTitle,
			planTodos: executionData.planTodos,
		});
	}
}
