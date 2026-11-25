import { describe, expect, test } from 'bun:test';
import { compilePermissionPolicy } from '../v2/permissions';
import {
  compileEffectiveAgentProjection,
  resolveEffectiveAgentOverrides,
} from './effective-agent-overrides';
import type { AgentOverrideConfig } from './schema';

test.each(['constructor', 'toString', 'hasOwnProperty', '__proto__'])(
  'R3: removal-only protected name %s is denied by C and P',
  (name) => {
    const projection = compileEffectiveAgentProjection(
      { oracle: { permission: { skill: 'allow' }, skills_remove: [name] } },
      () => [],
    );
    expect(projection.skillPermissions.oracle['*']).toBe('allow');
    expect(Object.hasOwn(projection.skillPermissions.oracle, name)).toBe(true);
    expect(
      Object.entries(projection.skillPermissions.oracle).find(
        ([key]) => key === name,
      )?.[1],
    ).toBe('deny');
    const policy = compilePermissionPolicy({
      baselineRules: [],
      hostRules: Object.entries(projection.skillPermissions.oracle).map(
        ([resource, effect]) => ({ action: 'skill', resource, effect }),
      ),
    });
    expect(policy.decide('skill', name)).toBe('deny');
  },
);

test('R3: wildcard exclusions retain own __proto__ denies in selection, C, and P', () => {
  for (const disabled of [[], ['__proto__']]) {
    const projection = compileEffectiveAgentProjection(
      { oracle: { skills: ['*', '!__proto__'] } },
      () => [],
      { disabledSkills: disabled },
    );
    expect(projection.skillSelections.oracle).toContainEqual({
      kind: 'directive',
      token: '!__proto__',
      name: '__proto__',
      effect: 'deny',
    });
    expect(Object.hasOwn(projection.skillPermissions.oracle, '__proto__')).toBe(
      true,
    );
    expect(
      Object.entries(projection.skillPermissions.oracle).find(
        ([key]) => key === '__proto__',
      )?.[1],
    ).toBe('deny');
    expect(Object.hasOwn(projection.skillAdmission.oracle, '__proto__')).toBe(
      true,
    );
    expect(
      Object.entries(projection.skillAdmission.oracle).find(
        ([key]) => key === '__proto__',
      )?.[1],
    ).toBe('deny');
    const policy = compilePermissionPolicy({
      baselineRules: [],
      hostRules: Object.entries(projection.skillPermissions.oracle).map(
        ([resource, effect]) => ({ action: 'skill', resource, effect }),
      ),
    });
    expect(policy.decide('skill', '__proto__')).toBe('deny');
    expect(policy.decide('skill', 'ordinary-skill')).toBe('allow');
  }
});

test('R3: disabled __proto__ is an own deny behind an open wildcard', () => {
  const projection = compileEffectiveAgentProjection(
    { oracle: { skills: ['*'] } },
    () => [],
    { disabledSkills: ['__proto__'] },
  );
  expect(Object.hasOwn(projection.skillPermissions.oracle, '__proto__')).toBe(
    true,
  );
  expect(
    Object.entries(projection.skillPermissions.oracle).find(
      ([key]) => key === '__proto__',
    )?.[1],
  ).toBe('deny');
  expect(Object.hasOwn(projection.skillAdmission.oracle, '__proto__')).toBe(
    true,
  );
  expect(
    Object.entries(projection.skillAdmission.oracle).find(
      ([key]) => key === '__proto__',
    )?.[1],
  ).toBe('deny');
  const policy = compilePermissionPolicy({
    baselineRules: [],
    hostRules: Object.entries(projection.skillPermissions.oracle).map(
      ([resource, effect]) => ({ action: 'skill', resource, effect }),
    ),
  });
  expect(policy.decide('skill', '__proto__')).toBe('deny');
  expect(policy.decide('skill', 'ordinary-skill')).toBe('allow');
});

test.each(['!123'])(
  'R1 literal: default and local selection preserve %s',
  (id) => {
    for (const override of [
      {},
      { skills_add: ['extra'] },
      { skills_include_local: true },
    ]) {
      const projection = compileEffectiveAgentProjection(
        { oracle: override },
        () => [id],
        { defaultSkills: { oracle: [id] } },
      );
      expect(projection.skillAdmission.oracle[id]).toBe('allow');
      expect(projection.skillPermissions.oracle[id]).toBe('allow');
      expect(projection.skillPermissions.oracle).not.toHaveProperty('123');
      const policy = compilePermissionPolicy({
        baselineRules: [],
        hostRules: Object.entries(projection.skillPermissions.oracle).map(
          ([resource, effect]) => ({ action: 'skill', resource, effect }),
        ),
      });
      expect(policy.decide('skill', id)).toBe('allow');
      expect(policy.decide('skill', '123')).toBe('deny');
    }
    const local = compileEffectiveAgentProjection(
      { oracle: { skills: [], skills_include_local: true } },
      () => [id],
    );
    expect(local.agents.oracle.skills).toEqual([id]);
    expect(local.skillAdmission.oracle[id]).toBe('allow');
    expect(local.skillPermissions.oracle[id]).toBe('allow');
  },
);

describe('effective agent permission narrowing', () => {
  test.each(['ask', 'deny'] as const)(
    'S2 admission: selected names remain admitted under %s',
    (effect) => {
      const projection = compileEffectiveAgentProjection(
        {
          oracle: { permission: { skill: effect }, skills_include_local: true },
        },
        () => ['local'],
        { defaultSkills: { oracle: ['default'] } },
      );
      expect(projection.skillAdmission.oracle).toEqual({
        '*': 'deny',
        default: 'allow',
        local: 'allow',
      });
      expect(projection.skillPermissions.oracle.local).toBe(effect);
      expect(projection.agents.oracle.skills ?? []).not.toContain('local');
    },
  );

  test.each(['ask', 'deny'] as const)(
    'S2: scalar skill %s suppresses automatic additions but keeps deliberate grants',
    (effect) => {
      const result = resolveEffectiveAgentOverrides(
        {
          oracle: {
            permission: { skill: effect },
            skills: ['explicit'],
            skills_add: ['added'],
            skills_include_local: true,
          },
        },
        () => ['discovered'],
      );
      expect(result.oracle).toEqual({
        permission: { skill: effect },
        skills: ['explicit', 'added'],
      });
    },
  );

  test.each(['allow', 'ask', 'deny'] as const)(
    'preserves scalar %s permission when including local skills',
    (permission) => {
      // Given
      const override = { permission, skills: [], skills_include_local: true };

      // When
      const result = resolveEffectiveAgentOverrides(
        { explorer: override },
        () => ['project-skill'],
      );

      // Then
      expect(result.explorer).toEqual({
        permission,
        skills: ['project-skill'],
      });
    },
  );

  test('preserves explicit skill rules instead of granting those local skills', () => {
    // Given
    const permission = { skill: { private: 'deny', review: 'ask' } } as const;

    // When
    const result = resolveEffectiveAgentOverrides(
      { explorer: { permission, skills: [], skills_include_local: true } },
      () => ['private', 'review', 'project-skill'],
    );

    // Then
    expect(result.explorer).toEqual({
      permission,
      skills: ['project-skill'],
    });
  });
});

const POLICY_CASES: Array<{
  name: string;
  override: AgentOverrideConfig;
  expected: Record<string, 'allow' | 'ask' | 'deny'>;
}> = [
  {
    name: 'scalar ask bounds automatic local and default grants',
    override: { permission: { skill: 'ask' }, skills_include_local: true },
    expected: { local: 'ask', default: 'ask', restricted: 'ask' },
  },
  {
    name: 'scalar deny bounds automatic local and default grants',
    override: { permission: { skill: 'deny' }, skills_include_local: true },
    expected: { local: 'deny', default: 'deny', restricted: 'deny' },
  },
  {
    name: 'add-only promotes only deliberately repeated defaults',
    override: { permission: { skill: 'ask' }, skills_add: ['default'] },
    expected: { default: 'allow', restricted: 'ask' },
  },
  {
    name: 'explicit empty base remains deny-all',
    override: { permission: { skill: 'ask' }, skills: [] },
    expected: { default: 'deny', local: 'deny', other: 'deny' },
  },
  {
    name: 'explicit base and add grants keep their documented authority',
    override: {
      permission: { skill: 'deny' },
      skills: ['default', '?review', '!blocked'],
      skills_add: ['added'],
      skills_include_local: true,
    },
    expected: {
      default: 'allow',
      review: 'ask',
      blocked: 'deny',
      added: 'allow',
      local: 'deny',
    },
  },
  {
    name: 'wildcard deny keeps its later exact allow exception',
    override: {
      permission: { skill: { '*': 'deny', exact: 'allow' } },
      skills_include_local: true,
    },
    expected: { default: 'deny', exact: 'allow', local: 'deny' },
  },
  {
    name: 'later wildcard deny shadows an earlier exact allow',
    override: {
      permission: { skill: { exact: 'allow', '*': 'deny' } },
      skills_include_local: true,
    },
    expected: { default: 'deny', exact: 'deny', local: 'deny' },
  },
  {
    name: 'wildcard ask keeps exact deny and allow exceptions',
    override: {
      permission: { skill: { '*': 'ask', restricted: 'deny', exact: 'allow' } },
      skills_include_local: true,
    },
    expected: {
      default: 'ask',
      restricted: 'deny',
      exact: 'allow',
      local: 'ask',
    },
  },
  {
    name: 'pattern restrictions bound discovered exact names',
    override: {
      permission: { skill: { 'private*': 'deny', 'review?': 'ask' } },
      skills_include_local: true,
    },
    expected: { 'private-local': 'deny', review1: 'ask', local: 'allow' },
  },
  {
    name: 'removals win over deliberate additions and permission allows',
    override: {
      permission: { skill: { '*': 'allow' } },
      skills_add: ['default'],
      skills_remove: ['default'],
    },
    expected: { default: 'deny' },
  },
  {
    name: 'ask and exclusion tokens bound automatic inclusion',
    override: {
      skills: ['?local', '!blocked'],
      skills_add: ['blocked'],
      skills_include_local: true,
    },
    expected: { local: 'ask', blocked: 'deny' },
  },
  {
    name: 'lifting an inherited exclusion permits a deliberate grant',
    override: {
      permission: { skill: 'deny' },
      skills_add: ['blocked'],
      skills_remove: ['!blocked'],
    },
    expected: { blocked: 'allow', default: 'deny' },
  },
  {
    name: 'explicit wildcard keeps exact ask and deny exceptions',
    override: {
      permission: { skill: 'deny' },
      skills: ['*', '?review', '!blocked'],
    },
    expected: { unknown: 'allow', review: 'ask', blocked: 'deny' },
  },
  {
    name: 'disabled names remain denied despite explicit grants',
    override: { permission: { skill: 'allow' }, skills: ['*', 'disabled'] },
    expected: { disabled: 'deny', default: 'allow' },
  },
];

test.each(POLICY_CASES)('S2 policy: $name', ({ override, expected }) => {
  const projection = compileEffectiveAgentProjection(
    { oracle: override },
    () => ['local', 'private-local', 'review1', 'blocked'],
    {
      defaultSkills: { oracle: ['default', 'restricted', 'exact', '!blocked'] },
      disabledSkills: ['disabled'],
    },
  );
  const rules = projection.skillPermissions.oracle;
  const policy = compilePermissionPolicy({
    baselineRules: [],
    hostRules: Object.entries(rules).map(([resource, effect]) => ({
      action: 'skill',
      resource,
      effect,
    })),
  });
  for (const [name, effect] of Object.entries(expected)) {
    expect(`${name}: ${policy.decide('skill', name)}`).toBe(
      `${name}: ${effect}`,
    );
  }
});

const ADMISSION_CASES: Array<{
  name: string;
  override: AgentOverrideConfig;
  expected: Record<string, 'allow' | 'deny'>;
}> = [
  {
    name: 'inherited defaults remain selected',
    override: { permission: { skill: 'ask' } },
    expected: { default: 'allow', other: 'deny' },
  },
  {
    name: 'explicit empty replaces defaults',
    override: { skills: [] },
    expected: { default: 'deny', local: 'deny' },
  },
  {
    name: 'add-only retains defaults',
    override: { skills_add: ['added'] },
    expected: { default: 'allow', added: 'allow' },
  },
  {
    name: 'ask tokens select names',
    override: { skills: ['?review'] },
    expected: { default: 'deny', review: 'allow' },
  },
  {
    name: 'wildcard selection is not enumerated',
    override: { skills: ['?*', '!blocked'] },
    expected: { future: 'allow', blocked: 'deny' },
  },
  {
    name: 'removals deny even selected local names',
    override: {
      skills_include_local: true,
      skills_remove: ['local', 'default'],
    },
    expected: { local: 'deny', default: 'deny' },
  },
  {
    name: 'disabled names cannot be admitted by a wildcard',
    override: { skills: ['*', 'disabled'] },
    expected: { future: 'allow', disabled: 'deny' },
  },
  {
    name: 'local selection does not depend on exact authorization',
    override: {
      permission: { skill: { local: 'deny' } },
      skills_include_local: true,
    },
    expected: { local: 'allow', other: 'deny' },
  },
];

test.each(ADMISSION_CASES)('S2 admission: $name', ({ override, expected }) => {
  const projection = compileEffectiveAgentProjection(
    { oracle: override },
    () => ['local'],
    { defaultSkills: { oracle: ['default'] }, disabledSkills: ['disabled'] },
  );
  const policy = compilePermissionPolicy({
    baselineRules: [],
    hostRules: Object.entries(projection.skillAdmission.oracle).map(
      ([resource, effect]) => ({ action: 'skill', resource, effect }),
    ),
  });
  for (const [resource, effect] of Object.entries(expected)) {
    expect(`${resource}: ${policy.decide('skill', resource)}`).toBe(
      `${resource}: ${effect}`,
    );
  }
});
