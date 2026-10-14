/// <reference types="bun-types" />
import { expect, test } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildResolvedAgentRegistry } from '../agents/registry';
import {
  getSkillPermissionsForAgent,
  resolveEffectiveSkills,
} from '../cli/skills';
import { compileEffectiveAgentProjection } from '../config/effective-agent-overrides';
import {
  loadPluginConfig,
  loadRawPluginConfigFromPath,
} from '../config/loader';
import { RuntimeConfig } from '../config/runtime';
import { withTmpDirSync } from '../test-utils';
import {
  adaptPermissions,
  snapshotNativeAgentForRegistry,
} from '../v2/adapters';
import { compilePermissionPolicy } from '../v2/permissions';
import {
  assertSkillIdentifier,
  InvalidSkillPolicyError,
  isIntegerIndexSkill,
} from './skill-policy-validation';

const INVALID = ['0', '1', '123', '2147483648', '4294967294'];
const VALID = [
  '01',
  '00',
  '-0',
  '+1',
  '1.0',
  '1e2',
  '4294967295',
  '4294967296',
  '*',
  '123*',
  '*123',
  '123?',
];
const ERROR = /integer-index skill/;

test.each(['?123', '*123', 'wild?card', 'wild*card'])(
  'R1 actual ID: rejects wildcard identity %s without banning policy patterns',
  (id) => {
    expect(() => assertSkillIdentifier(id)).toThrow(InvalidSkillPolicyError);
    expect(() =>
      compileEffectiveAgentProjection({ oracle: {} }, () => [], {
        defaultSkills: { oracle: [id] },
      }),
    ).toThrow(InvalidSkillPolicyError);
    expect(() =>
      compileEffectiveAgentProjection(
        { oracle: { skills_include_local: true } },
        () => [id],
      ),
    ).toThrow(InvalidSkillPolicyError);
    expect(() => getSkillPermissionsForAgent('oracle', [], [id])).toThrow(
      InvalidSkillPolicyError,
    );
    expect(() => adaptPermissions({ skill: { [id]: 'deny' } })).not.toThrow();
  },
);

test.each([...INVALID, ...VALID])(
  'R1: predicate follows actual ECMAScript key ordering for %s',
  (value) => {
    expect(isIntegerIndexSkill(value)).toBe(
      Object.keys({ sentinel: true, [value]: false })[0] === value,
    );
  },
);

test.each(['?123', '*123', 'wild?card', 'wild*card'])(
  'R1 actual ID: raw disabled ID %s rejects before schema fallback',
  (id) => {
    withTmpDirSync((root) => {
      const file = join(root, 'config.json');
      writeFileSync(
        file,
        JSON.stringify({
          autoUpdate: 'unrelated-invalid-type',
          disabled_skills: [id],
        }),
      );
      expect(() => loadRawPluginConfigFromPath(file, { silent: true })).toThrow(
        InvalidSkillPolicyError,
      );
    });
  },
);

test('R1 literal: disabling !123 denies that identity, not numeric 123', () => {
  const projection = compileEffectiveAgentProjection({ oracle: {} }, () => [], {
    defaultSkills: { oracle: ['!123'] },
    disabledSkills: ['!123'],
  });
  expect(projection.skillPermissions.oracle).toEqual({
    '*': 'deny',
    '!123': 'deny',
  });
  expect(projection.skillAdmission.oracle['!123']).toBe('deny');
});

test('R1: policy rejection is typed, not a schema/drop warning', () => {
  expect(() =>
    snapshotNativeAgentForRegistry({
      permissions: [{ action: 'skill', resource: '123', effect: 'malformed' }],
    }),
  ).toThrow(InvalidSkillPolicyError);
  expect(() => getSkillPermissionsForAgent('oracle', ['!123'])).toThrow(
    InvalidSkillPolicyError,
  );
  expect(() =>
    compilePermissionPolicy({
      baselineRules: [{ action: 's*', resource: '123', effect: 'deny' }],
      hostRules: [],
    }),
  ).toThrow(InvalidSkillPolicyError);
});

test.each(INVALID)('R1: directive and map construction rejects %s', (id) => {
  for (const token of [id, `?${id}`, `!${id}`]) {
    expect(() => getSkillPermissionsForAgent('oracle', [token])).toThrow(ERROR);
    expect(() => resolveEffectiveSkills('oracle', [], [token], [])).toThrow(
      ERROR,
    );
    expect(() => resolveEffectiveSkills('oracle', ['*'], [], [token])).toThrow(
      ERROR,
    );
  }
  expect(() => getSkillPermissionsForAgent('oracle', [], [id])).toThrow(ERROR);
  expect(() =>
    compileEffectiveAgentProjection(
      { oracle: { permission: { skill: { '*': 'allow', [id]: 'deny' } } } },
      () => [],
    ),
  ).toThrow(ERROR);
});

test.each(VALID)(
  'R1: non-index spelling/pattern %s remains supported',
  (id) => {
    expect(() =>
      getSkillPermissionsForAgent('oracle', [id, `?${id}`, `!${id}`]),
    ).not.toThrow();
    expect(() => adaptPermissions({ skill: { [id]: 'deny' } })).not.toThrow();
  },
);

test.each(['skill', '*', 's*', '?kill', 'sk???'])(
  'R1: ordered native policy rejects numeric resources for action %s',
  (action) => {
    expect(() =>
      adaptPermissions({ [action]: { '*': 'allow', '123': 'deny' } }),
    ).toThrow(ERROR);
    expect(() =>
      compilePermissionPolicy({
        baselineRules: [],
        hostRules: [{ action, resource: '123', effect: 'deny' }],
      }),
    ).toThrow(ERROR);
    expect(() =>
      compilePermissionPolicy({
        baselineRules: [],
        hostRules: [],
        ceilings: {
          actions: { skill: 'allow' },
          namespaces: [],
          resources: { [action]: { '123': 'deny' } },
        },
      }),
    ).toThrow(ERROR);
  },
);

test('R1: numeric non-skill resources and unstripped rule patterns remain valid', () => {
  expect(
    compilePermissionPolicy({
      baselineRules: [],
      hostRules: [{ action: 'read', resource: '123', effect: 'deny' }],
    }).decide('read', '123'),
  ).toBe('deny');
  expect(() =>
    adaptPermissions({
      read: { '123': 'deny' },
      skill: { '?123': 'ask', '!123': 'deny' },
    }),
  ).not.toThrow();
});

test('R1: exact resources generated by intersection are also rejected', () => {
  expect(() =>
    compilePermissionPolicy({
      baselineRules: [],
      hostRules: [{ action: 'skill', resource: '?23', effect: 'allow' }],
      ceilings: {
        actions: { skill: 'allow' },
        namespaces: [],
        resources: { skill: { '1*': 'allow' } },
      },
    }),
  ).toThrow(ERROR);
});

test.each([
  { agents: { oracle: { skills: ['!123'] } } },
  { presets: { locked: { oracle: { skills_remove: ['123'] } } } },
  {
    presets: {
      locked: {
        agents: { oracle: { permission: { skill: { '123': 'deny' } } } },
      },
    },
  },
  { disabled_skills: '123' },
  { permission: { '*': { '123': 'deny' } } },
])('R1: raw config rejects before unrelated schema fallback %#', (policy) => {
  withTmpDirSync((root) => {
    const file = join(root, 'config.json');
    writeFileSync(
      file,
      JSON.stringify({ autoUpdate: 'invalid-unrelated-type', ...policy }),
    );
    expect(() => loadRawPluginConfigFromPath(file, { silent: true })).toThrow(
      ERROR,
    );
  });
});

test('R1: rejected programmatic seed leaves the prior generation untouched', () => {
  const directory = 'virtual-r1-validation';
  const runtime = RuntimeConfig.init(directory, {
    agents: { oracle: { skills: ['*'] } },
  });
  const before = runtime.agentProjection();
  try {
    expect(() =>
      RuntimeConfig.init(
        directory,
        { agents: { oracle: { skills: ['!123'] } } },
        'v2',
      ),
    ).toThrow(ERROR);
    expect(runtime.backgroundJobs.boardInjection).toBe(true);
    expect(runtime.agentProjection()).toBe(before);
    expect(() => runtime.setProjectSkillPermissionNames(['123'])).toThrow(
      ERROR,
    );
    expect(() => runtime.agentProjection({ oracle: ['123'] })).toThrow(ERROR);
    expect(() =>
      buildResolvedAgentRegistry(runtime, {
        hostSnapshot: {
          agent: { oracle: { permission: { skill: { '123': 'deny' } } } },
        },
      }),
    ).toThrow(ERROR);
  } finally {
    RuntimeConfig.reset(directory);
  }
});

test('R1: invalid project deny cannot fall back to a lower wildcard grant', () => {
  withTmpDirSync((root) => {
    const user = join(root, 'user');
    const project = join(root, 'project');
    mkdirSync(join(user, 'opencode'), { recursive: true });
    mkdirSync(join(project, '.git'), { recursive: true });
    mkdirSync(join(project, '.opencode'), { recursive: true });
    writeFileSync(
      join(user, 'opencode', 'oh-my-opencode-slim.json'),
      JSON.stringify({ agents: { oracle: { skills: ['*'] } } }),
    );
    writeFileSync(
      join(project, '.opencode', 'oh-my-opencode-slim.json'),
      JSON.stringify({
        autoUpdate: 'invalid',
        agents: { oracle: { permission: { skill: { '123': 'deny' } } } },
      }),
    );
    const original = {
      XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
      OPENCODE_CONFIG_DIR: process.env.OPENCODE_CONFIG_DIR,
    };
    process.env.XDG_CONFIG_HOME = user;
    delete process.env.OPENCODE_CONFIG_DIR;
    try {
      expect(() => loadPluginConfig(project, { silent: true })).toThrow(
        InvalidSkillPolicyError,
      );
    } finally {
      for (const [key, value] of Object.entries(original)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });
});
