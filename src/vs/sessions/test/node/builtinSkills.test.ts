/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { promises as fs } from 'fs';
import { FileAccess } from '../../../base/common/network.js';
import { join } from '../../../base/common/path.js';
import { parseFrontMatter } from '../../../base/common/yaml.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../base/test/common/utils.js';

/**
 * Built-in skills bundled under `vs/sessions/skills/{folder}/SKILL.md`.
 * These mirror the registration invariants enforced by
 * `AgenticPromptsService.discoverBuiltinSkills()`:
 * - folder must contain a parseable SKILL.md
 * - frontmatter `name` is required and must equal the folder name
 * - frontmatter `description` is required (drives model invocation)
 */
interface IBuiltinSkillSpec {
	readonly folder: string;
	/** Verbatim expected behavior from the Cursor skills evidence (deep-docs-all.md). */
	readonly behaviorKeywords: readonly string[];
}

const BUILTIN_SKILLS: readonly IBuiltinSkillSpec[] = [
	{
		folder: 'cursor-blame',
		behaviorKeywords: ['AI-authored', 'prompts'],
	},
	{
		folder: 'sdk',
		behaviorKeywords: ['Cursor SDK'],
	},
	{
		folder: 'shell',
		behaviorKeywords: ['literal shell command'],
	},
	{
		folder: 'create-skill',
		behaviorKeywords: ['SKILL.md'],
	},
	{
		folder: 'create-rule',
		behaviorKeywords: ['rules', 'scope'],
	},
	{
		folder: 'create-hook',
		behaviorKeywords: ['hooks', 'hooks.json'],
	},
	{
		folder: 'create-subagent',
		behaviorKeywords: ['custom subagents'],
	},
	{
		folder: 'skill-builtin-review',
		behaviorKeywords: ['code-review agent'],
	},
	{
		folder: 'skill-builtin-review-bugbot',
		behaviorKeywords: ['Bugbot', 'finds issues'],
	},
	{
		folder: 'skill-builtin-review-security',
		behaviorKeywords: ['Security Review', 'per-PR'],
	},
	{
		folder: 'skill-builtin-automate',
		behaviorKeywords: ['Automations', 'Slack', 'GitHub'],
	},
	{
		folder: 'skill-builtin-autopilot',
		behaviorKeywords: ['Monitors PR', 'failing checks'],
	},
	{
		folder: 'skill-builtin-canvas',
		behaviorKeywords: ['Interactive React artifacts'],
	},
	{
		folder: 'skill-builtin-loop',
		behaviorKeywords: ['Recurring skill execution'],
	},
	{
		folder: 'skill-builtin-split-to-prs',
		behaviorKeywords: ['Splits large changes', 'smaller PRs'],
	},
	{
		folder: 'skill-builtin-statusline',
		behaviorKeywords: ['CLI status line'],
	},
	{
		folder: 'skill-builtin-migrate-to-skills',
		behaviorKeywords: ['Converts rules/commands to skills'],
	},
	{
		folder: 'skill-builtin-update-cli-config',
		behaviorKeywords: ['Updates ~/.cursor/cli-config.json'],
	},
	{
		folder: 'skill-builtin-update-cursor-settings',
		behaviorKeywords: ['Finds/updates Cursor/VS Code setting'],
	},
	{
		folder: 'skill-locations',
		behaviorKeywords: ['.agents/skills/', '.cursor/skills/', '~/.agents/skills/', '~/.cursor/skills/', '.claude/skills/', '.codex/skills/'],
	},
	{
		folder: 'skill-nested-scoping',
		behaviorKeywords: ['auto-scoped', 'monorepo'],
	},
	{
		folder: 'skill-frontmatter',
		behaviorKeywords: ['name', 'description', 'paths', 'disable-model-invocation', 'icon', 'color', 'metadata'],
	},
];

/** Mirrors the sanitization applied by AgenticPromptsService for built-in skills. */
function sanitizeSkillText(text: string, maxLength: number): string {
	const sanitized = text.replace(/<[^>]+>/g, '');
	return sanitized.length > maxLength ? sanitized.substring(0, maxLength) : sanitized;
}

suite('Sessions - Built-in skills', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	function skillsRoot(): string {
		// FileAccess.asFileUri('') resolves to the build output root; the skill
		// sources live in the source tree next to it.
		return join(FileAccess.asFileUri('').fsPath, '..', 'src', 'vs', 'sessions', 'skills');
	}

	for (const spec of BUILTIN_SKILLS) {
		suite(`skill: ${spec.folder}`, () => {
			let raw: string;

			test('SKILL.md exists and has frontmatter', async () => {
				raw = await fs.readFile(join(skillsRoot(), spec.folder, 'SKILL.md'), 'utf8');
				const parsed = parseFrontMatter(raw);
				assert.ok(parsed, 'SKILL.md must parse');
				assert.ok(parsed.header, 'SKILL.md must have frontmatter');
				assert.ok(parsed.body.trim().length > 0, 'SKILL.md must have a body');
			});

			test('registered: name matches folder name (discovery invariant)', async () => {
				const parsed = parseFrontMatter(raw)!;
				const name = parsed.getStringValue('name');
				assert.ok(name, 'frontmatter `name` is required');
				assert.strictEqual(name, spec.folder, 'name must equal the folder name or discoverBuiltinSkills() skips it');
				assert.ok(sanitizeSkillText(name, 64).length <= 64);
			});

			test('registered: description present for model invocation', async () => {
				const parsed = parseFrontMatter(raw)!;
				const description = parsed.getStringValue('description');
				assert.ok(description && description.length > 0, 'frontmatter `description` is required');
				assert.ok(sanitizeSkillText(description, 1024).length <= 1024);
			});

			test('triggerable: user-invocable and model-invocable', async () => {
				const parsed = parseFrontMatter(raw)!;
				assert.notStrictEqual(parsed.getBooleanValue('user-invocable'), false, 'skill must stay user-invocable so `/' + spec.folder + '` works');
				assert.notStrictEqual(parsed.getBooleanValue('disable-model-invocation'), true, 'skill must stay model-invocable');
			});

			test('behavior: description matches the expected Cursor behavior', async () => {
				const parsed = parseFrontMatter(raw)!;
				const description = parsed.getStringValue('description') ?? '';
				for (const keyword of spec.behaviorKeywords) {
					assert.ok(
						description.includes(keyword),
						`description must mention "${keyword}" (expected behavior), got: ${description}`
					);
				}
			});

			test('trigger: slash command is `/' + spec.folder + '`', () => {
				// agentHostSkillCompletionProvider derives the slash trigger as '/' + skill name
				const slashCommandName = spec.folder;
				assert.strictEqual('/' + slashCommandName, `/${spec.folder}`);
			});
		});
	}
});
