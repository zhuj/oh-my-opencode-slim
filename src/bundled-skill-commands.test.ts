import { describe, expect, test } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  createBundledSkillCommands,
  extractSkillBody,
  registerBundledSkillCommands,
} from './bundled-skill-commands';
import type { CustomSkill } from './cli/custom-skills-registry';
import { formatMissingCommandMessage } from './skill-command-template';
import { withTmpDirSync } from './test-utils';

const TEST_SKILL: CustomSkill = {
  name: 'test-skill',
  description: 'Registry description',
  allowedAgents: ['orchestrator'],
  sourcePath: 'src/skills/test-skill',
};

function withTempDir<T>(run: (root: string) => T): T {
  return withTmpDirSync(run);
}

function writeSkill(root: string, skill: CustomSkill, content: string): void {
  const skillDirectory = join(root, skill.sourcePath);
  mkdirSync(skillDirectory, { recursive: true });
  writeFileSync(join(skillDirectory, 'SKILL.md'), content);
}

describe('bundled skill commands', () => {
  for (const globalMode of [undefined, 'none', 'full', 'reference'] as const) {
    test.each([undefined, 'none', 'full', 'reference'] as const)(
      `resolves override %j over global ${globalMode}`,
      (override) => {
        withTempDir((root) => {
          const metadata = override ? `slim:\n  command: ${override}\n` : '';
          writeSkill(
            root,
            TEST_SKILL,
            `---\nname: display-name\n${metadata}---\nBODY_SENTINEL`,
          );

          const commands = createBundledSkillCommands(
            [TEST_SKILL],
            root,
            globalMode,
          );

          const mode = override ?? globalMode ?? 'full';
          const command = commands[TEST_SKILL.name];
          if (mode === 'none') {
            expect(command).toBeUndefined();
            return;
          }
          expect(command).toBeDefined();
          expect(command?.template).toContain(
            '<user-request>\n$ARGUMENTS\n</user-request>',
          );
          if (mode === 'reference') {
            expect(command?.template).toContain(
              JSON.stringify(TEST_SKILL.name),
            );
            expect(command?.template).not.toContain('display-name');
            expect(command?.template).not.toContain('BODY_SENTINEL');
          } else {
            expect(command?.template).toContain('BODY_SENTINEL');
          }
        });
      },
    );
  }

  test('extracts only the Markdown body when YAML frontmatter is present', () => {
    // Given
    const markdown =
      '---\r\nname: test-skill\r\ndescription: Frontmatter description\r\n---\r\n\r\n# Body\r\n';

    // When
    const body = extractSkillBody(markdown);

    // Then
    expect(body).toBe('\r\n# Body\r\n');
  });

  test('creates a config command wrapping the body with the base directory', () => {
    withTempDir((root) => {
      // Given
      writeSkill(
        root,
        TEST_SKILL,
        '---\nname: ignored\ndescription: Ignored\n---\n\nUse $ARGUMENTS.\n',
      );

      // When
      const commands = createBundledSkillCommands([TEST_SKILL], root);

      // Then
      expect(commands).toEqual({
        'test-skill': {
          description: 'Registry description',
          template: [
            '<skill-instruction>',
            `Base directory for this skill: ${join(root, TEST_SKILL.sourcePath)}/`,
            'File references (@path) in this skill are relative to this directory.',
            '',
            'Use $ARGUMENTS.',
            '</skill-instruction>',
            '',
            '<user-request>',
            '$ARGUMENTS',
            '</user-request>',
          ].join('\n'),
        },
      });
    });
  });

  test('preserves an existing user command with the same name', () => {
    withTempDir((root) => {
      // Given
      writeSkill(root, TEST_SKILL, '---\nname: test-skill\n---\nBundled');
      const config: Record<string, unknown> = {
        command: {
          'test-skill': {
            description: 'User description',
            template: 'User template',
          },
        },
      };
      const commands = createBundledSkillCommands([TEST_SKILL], root);

      // When
      registerBundledSkillCommands(config, commands);

      // Then
      expect(config.command).toEqual({
        'test-skill': {
          description: 'User description',
          template: 'User template',
        },
      });
    });
  });

  test('skips a missing skill file without failing command assembly', () => {
    withTempDir((root) => {
      // Given
      const missingSkill: CustomSkill = {
        ...TEST_SKILL,
        sourcePath: 'src/skills/missing',
      };

      // When
      const commands = createBundledSkillCommands([missingSkill], root);

      // Then
      expect(commands).toEqual({});
    });
  });

  test('inherits reference mode when the bundled source cannot be read', () => {
    withTempDir((root) => {
      const commands = createBundledSkillCommands(
        [TEST_SKILL],
        root,
        'reference',
      );

      expect(commands[TEST_SKILL.name]?.template).toContain(
        JSON.stringify(TEST_SKILL.name),
      );
      expect(commands[TEST_SKILL.name]?.template).toEndWith(
        '<user-request>\n$ARGUMENTS\n</user-request>',
      );
    });
  });

  test('wraps an argument block around the host-substituted arguments', () => {
    withTempDir((root) => {
      // Given
      writeSkill(root, TEST_SKILL, '---\nname: test-skill\n---\nBundled');

      // When
      const commands = createBundledSkillCommands([TEST_SKILL], root);

      // Then
      const template = commands['test-skill']?.template ?? '';
      expect(
        template.endsWith('<user-request>\n$ARGUMENTS\n</user-request>'),
      ).toBe(true);
      expect(template).toContain('\n</skill-instruction>\n\n<user-request>\n');
    });
  });

  test('reports an unknown command with the shared missing-command text', () => {
    // Given / When / Then
    expect(formatMissingCommandMessage('show-me')).toBe(
      'Command "/show-me" not found. Use the skill tool to list available skills and commands.',
    );
  });
});
