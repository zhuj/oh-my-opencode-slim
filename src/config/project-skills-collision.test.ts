import { describe, expect, test } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { withTmpDirSync } from '../test-utils';
import { discoverProjectSkills } from './project-skills';

describe('discoverProjectSkills preserves non-conflicting', () => {
  test('keeps unique skills and reports duplicates/unreadable separately', () => {
    withTmpDirSync((root) => {
      const skillsDir = join(root, 'skills');
      mkdirSync(skillsDir, { recursive: true });
      mkdirSync(join(skillsDir, 'good'), { recursive: true });
      writeFileSync(
        join(skillsDir, 'good', 'SKILL.md'),
        '---\nname: good\n---\nbody',
      );
      mkdirSync(join(skillsDir, 'dup'), { recursive: true });
      writeFileSync(
        join(skillsDir, 'dup', 'SKILL.md'),
        '---\nname: good\n---\ndup',
      );
      const result = discoverProjectSkills({
        projectDirectory: root,
        resourcePrefixes: ['.opencode'],
        resourceRoots: [
          {
            path: skillsDir,
            relativePath: 'skills',
            ancestor: root,
            depth: 1,
            prefix: '.opencode',
            prefixIndex: 0,
            category: 'skills',
          },
        ],
        hostOwnedSkillRoots: [],
        hostSkillNames: [],
      });
      expect(result.skills.length).toBe(1);
      expect(result.skills[0].name).toBe('good');
      expect(
        result.diagnostics.find((d) => d.code === 'duplicate-name'),
      ).toBeDefined();
    });
  });
});
