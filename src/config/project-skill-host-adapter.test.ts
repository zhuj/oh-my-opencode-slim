import { describe, expect, test } from 'bun:test';
import {
  type ProjectSkillHostSource,
  toV2ProjectSkillInfos,
} from './project-skill-host-adapter';
import type { ProjectSkillCandidate } from './project-skills';

const first: ProjectSkillCandidate = {
  name: 'first-skill',
  directory: '/workspace/.local/skills/first',
  skillFilePath: '/workspace/.local/skills/first/SKILL.md',
};

describe('toV2ProjectSkillInfos', () => {
  test('maps fields and preserves false optional metadata', () => {
    const source: ProjectSkillHostSource = {
      ...first,
      description: 'A project skill',
      autoinvoke: false,
      content: '---\nname: first-skill\n---\n\n# Skill body\n',
    };

    expect(toV2ProjectSkillInfos([], [source])).toEqual([
      {
        id: first.name,
        name: first.name,
        description: 'A project skill',
        autoinvoke: false,
        path: first.skillFilePath,
        content: source.content,
      },
    ]);
  });

  test('omits optional fields and filters host and later duplicate IDs', () => {
    const hostConflict: ProjectSkillHostSource = {
      ...first,
      name: 'native-skill',
      content: '# host conflict\n',
    };
    const source: ProjectSkillHostSource = {
      ...first,
      content: '# first body\n',
    };
    const laterDuplicate: ProjectSkillHostSource = {
      ...source,
      directory: '/workspace/.local/skills/later',
      skillFilePath: '/workspace/.local/skills/later/SKILL.md',
      content: '# later duplicate\n',
    };
    const hostIds = ['native-skill'];
    const candidates = [hostConflict, source, laterDuplicate];

    expect(toV2ProjectSkillInfos(hostIds, candidates)).toEqual([
      {
        id: first.name,
        name: first.name,
        path: first.skillFilePath,
        content: source.content,
      },
    ]);
    expect(hostIds).toEqual(['native-skill']);
    expect(candidates).toEqual([hostConflict, source, laterDuplicate]);
  });
});
