import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { getSkillPermissionsForAgent } from '../cli/skills';
import { createTmpDir, removeTmpDir } from '../test-utils';
import type { ProjectResourceRoot } from './project-resource-paths';
import { resolveProjectResourceRoots } from './project-resource-paths';
import { discoverProjectSkills } from './project-skills';
import { normalizeAgentSkillDirectives } from './utils';

const tempDirs: string[] = [];

function makeProject(): string {
  const directory = createTmpDir();
  tempDirs.push(directory);
  return directory;
}

function writeSkill(
  root: string,
  relativeDirectory: string,
  name?: string,
): string {
  const directory = path.join(root, relativeDirectory);
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(
    path.join(directory, 'SKILL.md'),
    name === undefined
      ? '# invalid frontmatter\n'
      : `---\nname: ${name}\ndescription: ${name}\n---\n`,
  );
  return directory;
}

function resourceRoot(
  projectDirectory: string,
  rootPath: string,
): ProjectResourceRoot {
  return {
    path: rootPath,
    relativePath: path.relative(projectDirectory, rootPath),
    ancestor: projectDirectory,
    depth: 1,
    prefix: '.local',
    prefixIndex: 0,
    category: 'skills',
  };
}

afterEach(() => {
  for (const directory of tempDirs.splice(0)) {
    removeTmpDir(directory);
  }
});

describe('discoverProjectSkills', () => {
  test('consumes canonical project-confined resolver roots as its boundary contract', () => {
    const project = makeProject();
    const root = path.join(project, '.local', 'skills');
    writeSkill(root, 'plugin', 'resolver-skill');
    const roots = resolveProjectResourceRoots({
      activeDirectory: project,
      boundaryDirectory: project,
      prefixes: ['.local'],
      category: 'skills',
    });
    expect(roots.map(({ path: rootPath }) => rootPath)).toEqual([
      fs.realpathSync(root),
    ]);
    const result = discoverProjectSkills({
      projectDirectory: project,
      resourcePrefixes: ['.local'],
      resourceRoots: roots,
      hostOwnedSkillRoots: [],
      hostSkillNames: [],
    });
    expect(result.permissionNames).toEqual(['resolver-skill']);
  });

  test('discovers valid skills and deterministically resolves duplicates and host conflicts', () => {
    const project = makeProject();
    const firstRoot = path.join(project, '.local', 'skills');
    const secondRoot = path.join(project, '.local', '.slim', 'skills');
    const accepted = writeSkill(
      firstRoot,
      'folder-does-not-name-skill',
      'shared',
    );
    writeSkill(secondRoot, 'duplicate', 'shared');
    writeSkill(secondRoot, 'host-conflict', 'native');
    writeSkill(secondRoot, 'invalid', undefined);

    const result = discoverProjectSkills({
      projectDirectory: project,
      resourcePrefixes: ['.local', '.local/.slim'],
      resourceRoots: [
        resourceRoot(project, firstRoot),
        resourceRoot(project, secondRoot),
      ],
      hostOwnedSkillRoots: [],
      hostSkillNames: ['native'],
    });

    expect(result.skills).toEqual([
      {
        name: 'shared',
        directory: accepted,
        skillFilePath: path.join(accepted, 'SKILL.md'),
      },
    ]);
    expect(result.permissionNames).toEqual(['shared']);
    expect(
      result.diagnostics.map(({ code, name }) => ({ code, name })),
    ).toEqual([
      { code: 'duplicate-name', name: 'shared' },
      { code: 'host-name-conflict', name: 'native' },
    ]);
  });

  test('does not traverse symlink directory entries', () => {
    const project = makeProject();
    const external = makeProject();
    const root = path.join(project, '.local', 'skills');
    const externalSkill = writeSkill(external, 'linked', 'linked-skill');
    fs.mkdirSync(root, { recursive: true });
    fs.symlinkSync(
      externalSkill,
      path.join(root, 'linked-entry'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );

    const result = discoverProjectSkills({
      projectDirectory: project,
      resourcePrefixes: ['.local'],
      resourceRoots: [resourceRoot(project, root)],
      hostOwnedSkillRoots: [],
      hostSkillNames: [],
    });
    expect(result.skills).toEqual([]);
    expect(result.permissionNames).toEqual([]);
  });

  test('ignores missing roots and diagnoses roots that cannot be enumerated', () => {
    const project = makeProject();
    const missing = path.join(project, 'missing');
    const notDirectory = path.join(project, 'not-directory');
    fs.writeFileSync(notDirectory, 'not a directory');
    const result = discoverProjectSkills({
      projectDirectory: project,
      resourcePrefixes: ['.local'],
      resourceRoots: [
        resourceRoot(project, missing),
        resourceRoot(project, notDirectory),
      ],
      hostOwnedSkillRoots: [],
      hostSkillNames: [],
    });
    expect(result.skills).toEqual([]);
    expect(result.diagnostics).toEqual([
      { code: 'unreadable-root', path: notDirectory },
    ]);
  });

  test('excludes only the exact native root and preserves local names', () => {
    const project = makeProject();
    const nativeRoot = path.join(project, '.opencode', 'skills');
    writeSkill(nativeRoot, 'native', 'local-native');
    const nearbyRoot = path.join(project, '.opencode', 'skills-plugin');
    const candidate = writeSkill(nearbyRoot, 'plugin', 'plugin-skill');
    const result = discoverProjectSkills({
      projectDirectory: project,
      resourcePrefixes: ['.opencode'],
      resourceRoots: [
        resourceRoot(project, nativeRoot),
        resourceRoot(project, nearbyRoot),
      ],
      hostOwnedSkillRoots: [nativeRoot],
      hostSkillNames: [],
    });
    expect(result.skills).toEqual([
      {
        name: 'plugin-skill',
        directory: candidate,
        skillFilePath: path.join(candidate, 'SKILL.md'),
      },
    ]);
    expect(result.permissionNames).toEqual(['local-native', 'plugin-skill']);
  });

  test('empty prefixes still return local names without scanning extra roots', () => {
    const project = makeProject();
    writeSkill(project, '.opencode/skills/local', 'local');
    const extraRoot = path.join(project, '.local', 'skills');
    writeSkill(extraRoot, 'extra', 'extra');

    const result = discoverProjectSkills({
      projectDirectory: project,
      resourcePrefixes: [],
      resourceRoots: [resourceRoot(project, extraRoot)],
      hostOwnedSkillRoots: [path.join(project, '.opencode', 'skills')],
      hostSkillNames: [],
    });

    expect(result.skills).toEqual([]);
    expect(result.permissionNames).toEqual(['local']);
  });
});

test('discovery names require opt-in and retain add/remove/disabled/ask/deny policy', () => {
  const project = makeProject();
  writeSkill(project, '.opencode/skills/local', 'local');
  const root = path.join(project, '.local', 'skills');
  writeSkill(root, 'a', 'ask');
  writeSkill(root, 'b', 'deny');
  writeSkill(root, 'c', 'added-ask');
  writeSkill(root, 'd', 'added-deny');
  writeSkill(root, 'e', 'allowed');
  writeSkill(root, 'f', 'disabled');
  const discovered = discoverProjectSkills({
    projectDirectory: project,
    resourcePrefixes: ['.local'],
    resourceRoots: [resourceRoot(project, root)],
    hostOwnedSkillRoots: [path.join(project, '.opencode', 'skills')],
    hostSkillNames: [],
  });
  expect(discovered.permissionNames).toEqual([
    'local',
    'ask',
    'deny',
    'added-ask',
    'added-deny',
    'allowed',
    'disabled',
  ]);
  expect(
    getSkillPermissionsForAgent('oracle', ['base']).allowed,
  ).toBeUndefined();
  expect(
    normalizeAgentSkillDirectives(
      { oracle: { skills: ['base'], skills_include_local: false } },
      discovered.permissionNames,
    ).oracle?.skills,
  ).toEqual(['base']);

  const normalized = normalizeAgentSkillDirectives(
    {
      oracle: {
        skills: ['?ask', '!deny', 'disabled'],
        skills_add: ['?added-ask', '!added-deny'],
        skills_remove: ['removed'],
        disabled_skills: ['disabled'],
        skills_include_local: true,
      },
    },
    discovered.permissionNames,
  );
  const skills = normalized.oracle?.skills;

  expect(skills).toEqual([
    '?ask',
    '!deny',
    'disabled',
    '?added-ask',
    '!added-deny',
    'local',
    'allowed',
  ]);
  expect(skills).not.toContain('removed');
  const permissions = getSkillPermissionsForAgent('oracle', skills, [
    'disabled',
  ]);
  expect(permissions.ask).toBe('ask');
  expect(permissions.deny).toBe('deny');
  expect(permissions['added-ask']).toBe('ask');
  expect(permissions['added-deny']).toBe('deny');
  expect(permissions.allowed).toBe('allow');
  expect(permissions.disabled).toBe('deny');
  expect(getSkillPermissionsForAgent('oracle', ['base']).extra).toBeUndefined();
});
