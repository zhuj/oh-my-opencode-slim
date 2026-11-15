import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Config } from '@opencode-ai/plugin';
import { CUSTOM_SKILLS, type CustomSkill } from './cli/custom-skills-registry';
import {
  parseSkillCommandMode,
  type SkillCommandMode,
} from './skill-command-mode';
import {
  buildSkillCommandTemplate,
  buildSkillReferencePrompt,
  SKILL_COMMAND_ARGUMENTS_PLACEHOLDER,
} from './skill-command-template';

type OpenCodeCommandEntry = NonNullable<Config['command']>[string];

const PACKAGE_ROOT = fileURLToPath(new URL('..', import.meta.url));
const FRONTMATTER_PATTERN = /^(?:\uFEFF)?---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/;

export function extractSkillBody(markdown: string): string {
  return markdown.replace(FRONTMATTER_PATTERN, '');
}

export function createBundledSkillCommands(
  skills: readonly CustomSkill[] = CUSTOM_SKILLS,
  packageRoot: string = PACKAGE_ROOT,
  globalMode: SkillCommandMode = 'full',
): Record<string, OpenCodeCommandEntry> {
  const commands: Record<string, OpenCodeCommandEntry> = {};

  for (const skill of skills) {
    // skill.sourcePath is the directory containing SKILL.md, so it is
    // already the base directory the hint must point at.
    const skillDirectory = join(packageRoot, skill.sourcePath);
    let markdown: string | undefined;
    try {
      markdown = readFileSync(join(skillDirectory, 'SKILL.md'), 'utf8');
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      // Metadata is optional; reference mode needs the ID, not a readable body.
    }
    const mode = parseSkillCommandMode(markdown ?? '') ?? globalMode;
    let template: string;
    switch (mode) {
      case 'none':
        continue;
      case 'reference':
        template = buildSkillReferencePrompt(
          skill.name,
          SKILL_COMMAND_ARGUMENTS_PLACEHOLDER,
        );
        break;
      case 'full':
        if (markdown === undefined) continue;
        template = buildSkillCommandTemplate(
          extractSkillBody(markdown),
          skillDirectory,
        );
        break;
    }
    commands[skill.name] = { description: skill.description, template };
  }

  return commands;
}

export function registerBundledSkillCommands(
  opencodeConfig: Record<string, unknown>,
  commands: Readonly<
    Record<string, OpenCodeCommandEntry>
  > = createBundledSkillCommands(),
): void {
  const registry = opencodeConfig.command;
  if (registry === undefined) {
    opencodeConfig.command = { ...commands };
    return;
  }
  if (registry === null || typeof registry !== 'object') return;

  for (const [name, command] of Object.entries(commands)) {
    if (Object.hasOwn(registry, name)) continue;
    Object.assign(registry, { [name]: command });
  }
}
