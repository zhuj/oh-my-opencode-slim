import { afterEach, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createTmpDir, removeTmpDir } from '../test-utils';
import { discoverV1NativeProjectSkills } from './v1-native-project-skills';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) removeTmpDir(root);
});

test('enumerates pinned project roots and returns names without content', () => {
  const project = createTmpDir();
  roots.push(project);
  for (const [root, name] of [
    ['.opencode/skills', 'native'],
    ['.opencode/skill', 'legacy'],
    ['.claude/skills', 'claude'],
    ['.agents/skills', 'agent'],
  ]) {
    const skill = path.join(project, root, name);
    fs.mkdirSync(skill, { recursive: true });
    fs.writeFileSync(
      path.join(skill, 'SKILL.md'),
      `---\nname: ${name}\n---\nsecret body`,
    );
  }
  const result = discoverV1NativeProjectSkills(project);
  expect(result.hostOwnedSkillRoots).toEqual(
    [
      '.opencode/skills',
      '.opencode/skill',
      '.claude/skills',
      '.agents/skills',
    ].map((root) => path.join(project, root)),
  );
  expect(result.hostSkillNames).toEqual([
    'agent',
    'claude',
    'legacy',
    'native',
  ]);
  expect(result).not.toHaveProperty('content');
});
