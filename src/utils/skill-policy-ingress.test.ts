/// <reference types="bun-types" />
import { expect, test } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildBundledSkillInfos, CUSTOM_SKILLS } from '../cli/custom-skills';
import { getSkillPermissionsForAgent } from '../cli/skills';
import {
  appendV1ProjectSkillPaths,
  toV2ProjectSkillInfos,
} from '../config/project-skill-host-adapter';
import {
  discoverProjectLocalSkillNames,
  discoverProjectSkills,
} from '../config/project-skills';
import { discoverV1NativeProjectSkills } from '../config/v1-native-project-skills';
import { MarketplacePackageManifestSchema } from '../marketplace/schemas';
import { skillIdsFromResponse } from '../marketplace/skills';
import { withTmpDir, withTmpDirSync } from '../test-utils';
import {
  loadV2ProjectSkillSources,
  scanV2NativeProjectSkillNames,
} from '../v2/project-skill-loader';
import { InvalidSkillPolicyError } from './skill-policy-validation';

const ERROR = /integer-index skill/;

function skillFile(root: string, relative: string, name?: string): string {
  const directory = join(root, relative);
  mkdirSync(directory, { recursive: true });
  writeFileSync(
    join(directory, 'SKILL.md'),
    `---\n${name === undefined ? '' : `name: ${name}\n`}description: fixture\n---\ncontent`,
  );
  return directory;
}

test.each(['123', '?123', '*123', 'wild?card', 'wild*card'])(
  'R1: project/local/V1/native intake cannot silently discard actual ID %s',
  (id) => {
    withTmpDirSync((root) => {
      skillFile(
        root,
        '.opencode/skills/probe',
        id === '123' ? id : JSON.stringify(id),
      );
      expect(() => discoverProjectLocalSkillNames(root)).toThrow(
        InvalidSkillPolicyError,
      );
      expect(() => discoverV1NativeProjectSkills(root)).toThrow(
        InvalidSkillPolicyError,
      );
      expect(() => skillIdsFromResponse({ data: [{ id }] }, 'id')).toThrow(
        InvalidSkillPolicyError,
      );
    });
  },
);

test.each(['123', '?123', '*123', 'wild?card', 'wild*card'])(
  'R1: plugin-owned discovery rejects actual ID %s before returning a partial candidate list',
  (id) => {
    withTmpDirSync((root) => {
      const skills = join(root, '.local/skills');
      skillFile(skills, 'a-valid', 'valid');
      skillFile(skills, 'z-invalid', id);
      expect(() =>
        discoverProjectSkills({
          projectDirectory: root,
          resourcePrefixes: ['.local'],
          hostOwnedSkillRoots: [],
          hostSkillNames: [],
          resourceRoots: [
            {
              path: skills,
              relativePath: '.local/skills',
              ancestor: root,
              depth: 1,
              prefix: '.local',
              prefixIndex: 0,
              category: 'skills',
            },
          ],
        }),
      ).toThrow(InvalidSkillPolicyError);
    });
  },
);

test.each([undefined, 'valid', '123'])(
  'R1: V2 checks path ID and explicit permission identity (%s)',
  async (name) => {
    await withTmpDir(async (root) => {
      skillFile(root, '.opencode/skills/123', name);
      await expect(
        scanV2NativeProjectSkillNames({ boundaryDirectory: root }),
      ).rejects.toThrow(ERROR);
    });
  },
);

test('R1: V1/V2 registration adapters reject invalid candidates even at collisions', async () => {
  await withTmpDir(async (root) => {
    const directory = skillFile(root, '123', '123');
    const candidate = {
      name: '123',
      directory,
      skillFilePath: join(directory, 'SKILL.md'),
    };
    expect(() => appendV1ProjectSkillPaths([directory], [candidate])).toThrow(
      ERROR,
    );
    expect(() =>
      toV2ProjectSkillInfos(['123'], [{ ...candidate, content: 'fixture' }]),
    ).toThrow(ERROR);
    await expect(
      loadV2ProjectSkillSources({
        projectBoundary: root,
        candidates: [candidate],
      }),
    ).rejects.toThrow(ERROR);
  });
});

test('R1: marketplace inventory rejects invalid native IDs', () => {
  for (const key of ['id', 'name'] as const)
    expect(() => skillIdsFromResponse([{ [key]: '123' }], key)).toThrow(ERROR);
});

test.each(['123', '?123', '*123', 'wild?card', 'wild*card'])(
  'R1: marketplace skill dependencies reject actual ID %s without tightening MCP IDs',
  (id) => {
    const manifest = {
      schemaVersion: 2,
      id: 'team/test',
      version: '1.0.0',
      displayName: 'test',
      description: 'test',
      agentName: 'probe',
      prompt: 'test',
      skills: [id],
      mcps: [id],
      tools: [],
      author: { name: 'test' },
      tags: [],
      license: 'MIT',
      compatibility: { plugin: '*' },
      model: { source: 'session' },
      routing: { description: 'test', when: 'test', keywords: [] },
    };
    expect(MarketplacePackageManifestSchema.safeParse(manifest).success).toBe(
      false,
    );
    expect(
      MarketplacePackageManifestSchema.safeParse({
        ...manifest,
        skills: ['01'],
      }).success,
    ).toBe(true);
  },
);

test.each(['123', '?123', '*123', 'wild?card', 'wild*card'])(
  'R1: bundled registry ID %s is validated before optional source loading',
  (id) => {
    const skill = CUSTOM_SKILLS[0];
    const original = skill.name;
    try {
      Reflect.set(skill, 'name', id);
      expect(() => buildBundledSkillInfos('virtual-r1-package', [])).toThrow(
        InvalidSkillPolicyError,
      );
      expect(() => getSkillPermissionsForAgent('oracle')).toThrow(
        InvalidSkillPolicyError,
      );
    } finally {
      Reflect.set(skill, 'name', original);
    }
  },
);

test('R1: bundled explicit frontmatter names cannot bypass registry validation', () => {
  withTmpDirSync((root) => {
    skillFile(root, CUSTOM_SKILLS[0].sourcePath, '123');
    expect(() => buildBundledSkillInfos(root, [])).toThrow(
      InvalidSkillPolicyError,
    );
  });
});

test.each(['?123', '*123', 'wild?card', 'wild*card'])(
  'R1 actual ID: rejects native inventory and registration wildcard %s',
  async (id) => {
    expect(() => skillIdsFromResponse([{ id }], 'id')).toThrow(
      InvalidSkillPolicyError,
    );
    await withTmpDir(async (root) => {
      const directory = skillFile(root, `.opencode/skills/${id}`, id);
      const candidate = {
        name: id,
        directory,
        skillFilePath: join(directory, 'SKILL.md'),
      };
      expect(() => discoverProjectLocalSkillNames(root)).toThrow(
        InvalidSkillPolicyError,
      );
      expect(() => discoverV1NativeProjectSkills(root)).toThrow(
        InvalidSkillPolicyError,
      );
      expect(() => appendV1ProjectSkillPaths([], [candidate])).toThrow(
        InvalidSkillPolicyError,
      );
      expect(() =>
        toV2ProjectSkillInfos([], [{ ...candidate, content: 'fixture' }]),
      ).toThrow(InvalidSkillPolicyError);
      await expect(
        scanV2NativeProjectSkillNames({ boundaryDirectory: root }),
      ).rejects.toThrow(InvalidSkillPolicyError);
      await expect(
        loadV2ProjectSkillSources({
          projectBoundary: root,
          candidates: [candidate],
        }),
      ).rejects.toThrow(InvalidSkillPolicyError);
      const explicitDirectory = skillFile(root, 'plain-path', id);
      await expect(
        loadV2ProjectSkillSources({
          projectBoundary: root,
          candidates: [
            {
              name: 'plain-path',
              directory: explicitDirectory,
              skillFilePath: join(explicitDirectory, 'SKILL.md'),
            },
          ],
        }),
      ).rejects.toThrow(InvalidSkillPolicyError);
      skillFile(root, CUSTOM_SKILLS[0].sourcePath, id);
      expect(() => buildBundledSkillInfos(root, [])).toThrow(
        InvalidSkillPolicyError,
      );
    });
  },
);
