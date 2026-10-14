import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createTmpDir, removeTmpDir } from '../test-utils';
import { RuntimeConfig } from './runtime';
import type { PluginConfig } from './schema';

/**
 * `RuntimeConfig.agents()` memoization contract.
 *
 * The override, model-array and chain projections are memoized across reads.
 * Every projection input mutation invalidates them. Model-array records are
 * defensively copied for callers that extend the record; nested values and
 * the shared agents()/runtimeChains projections are frozen.
 *
 * Goldens were captured from the pre-memoization implementation.
 */

const DIRECTORY = '/virtual/agents-cache-test';
const tempDirs: string[] = [];

function countDisabledReads(runtime: RuntimeConfig) {
  const getter = Object.getOwnPropertyDescriptor(
    RuntimeConfig.prototype,
    'disabledAgents',
  )?.get;
  if (!getter) throw new Error('Missing disabledAgents getter');
  const counter = {
    reads: 0,
    restore() {
      Reflect.deleteProperty(runtime, 'disabledAgents');
    },
  };
  Object.defineProperty(runtime, 'disabledAgents', {
    configurable: true,
    get() {
      counter.reads++;
      return getter.call(runtime);
    },
  });
  return counter;
}

function resetRegistry(): void {
  RuntimeConfig.reset(DIRECTORY);
}

function makeProject(): string {
  const projectDir = createTmpDir();
  tempDirs.push(projectDir);
  return projectDir;
}

function writeSkill(
  projectDir: string,
  relativeDir: string,
  name: string,
): void {
  const skillDir = path.join(projectDir, '.opencode', 'skills', relativeDir);
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(
    path.join(skillDir, 'SKILL.md'),
    `---\nname: ${name}\ndescription: ${name} project skill\n---\n\n# ${name}\n`,
  );
}

/**
 * Exercises every projection input at once: a legacy alias key plus its
 * canonical twin, a config-file preset, an `skills_include_local` agent with an
 * exact permission rule, and a wildcard agent.
 */
const PROJECTION_CONFIG: PluginConfig = {
  preset: 'file',
  presets: {
    file: { explorer: { model: 'file/explorer', skills: ['f1'] } },
    runtime: { explorer: { model: 'runtime/explorer', skills_add: ['r1'] } },
  },
  agents: {
    explore: { temperature: 0.2 },
    explorer: { skills: ['root'], skills_include_local: true },
    oracle: {
      skills: ['o1'],
      permission: { skill: { exact: 'deny' } },
      skills_include_local: true,
    },
  },
};

const GOLDEN_FILE_PRESET =
  '{"explorer":{"temperature":0.2,"model":"file/explorer","skills":["root","exact","extra-local"]},"oracle":{"permission":{"skill":{"exact":"deny"}},"skills":["o1","extra-local"]}}';
const GOLDEN_RUNTIME_PRESET =
  '{"explorer":{"model":"runtime/explorer","temperature":0.2,"skills":["root","r1","exact","extra-local"]},"oracle":{"permission":{"skill":{"exact":"deny"}},"skills":["o1","extra-local"]}}';

afterEach(() => {
  resetRegistry();
  for (const dir of tempDirs.splice(0)) {
    RuntimeConfig.reset(dir);
    removeTmpDir(dir);
  }
});

test('R1 literal: discovered IDs preserve cached identity and default isolation', () => {
  const project = makeProject();
  writeSkill(project, 'bang', '!123');
  writeSkill(project, 'another', '!local');
  const runtime = RuntimeConfig.init(project, {
    agents: { oracle: { skills: [], skills_include_local: true } },
  });
  const projection = runtime.agentProjection();
  expect(projection.agents.oracle.skills).toEqual(['!123', '!local']);
  expect(projection.skillPermissions.oracle['!123']).toBe('allow');
  expect(projection.skillPermissions.oracle['!local']).toBe('allow');
  expect(runtime.agentProjection()).toBe(projection);
  expect(Object.isFrozen(projection.skillPermissions.oracle)).toBe(true);
  expect(
    projection.skillSelections.oracle.find((entry) => entry.name === '!123')
      ?.kind,
  ).toBe('literal');
  expect(Object.isFrozen(projection.skillSelections.oracle)).toBe(true);
  expect(Object.isFrozen(projection.skillSelections.oracle[0])).toBe(true);
  const explicit = runtime.agentProjection({ oracle: ['!default'] });
  expect(explicit).not.toBe(projection);
  expect(runtime.agentProjection()).toBe(projection);
});

describe('RuntimeConfig model projection caches', () => {
  const config: PluginConfig = {
    disabled_agents: ['fixer', 'councillor-disabled'],
    agents: {
      explore: {
        model: ['file/explorer', { id: 'file/fallback', variant: 'high' }],
      },
      fixer: { model: ['file/disabled'] },
      custom: { model: ['file/custom'], inheritModelFrom: 'session' },
    },
    presets: {
      runtime: { explorer: { model: ['runtime/explorer'] } },
      broken: { extends: 'missing', explorer: { model: ['broken/explorer'] } },
    },
    council: {
      presets: {
        default: {
          alpha: {
            models: [
              { id: 'council/first' },
              { id: 'council/second', variant: 'low' },
            ],
          },
          disabled: {
            models: [{ id: 'council/disabled' }, { id: 'council/other' }],
          },
        },
      },
    },
  };

  test('one build per getter across reads and all projection mutations', () => {
    const runtime = RuntimeConfig.init(DIRECTORY, config);
    const disabled = countDisabledReads(runtime);
    const originalEntries = Object.entries;
    let chainBuilds = 0;
    const entries = spyOn(Object, 'entries').mockImplementation((value) => {
      if (value.explorer?.[0]?.id) chainBuilds++;
      return originalEntries(value);
    });
    try {
      const mutations = [
        () => {},
        () => runtime.setProjectSkillPermissionNames(['extra']),
        () => runtime.setRuntimePreset('runtime'),
        () => runtime.setRuntimePreset('missing'),
        () => runtime.setRuntimePreset('broken'),
        () => runtime.setRuntimePreset(null),
        () => {
          RuntimeConfig.init(DIRECTORY, config);
        },
      ];
      for (const mutate of mutations) {
        mutate();
        disabled.reads = 0;
        chainBuilds = 0;
        const arrays = runtime.modelArrays;
        const chains = runtime.runtimeChains;
        for (let i = 0; i < 10; i++) {
          expect(runtime.modelArrays).toEqual(arrays);
          expect(runtime.runtimeChains).toEqual(chains);
        }
        expect(disabled.reads).toBe(1);
        expect(chainBuilds).toBe(1);
        expect(runtime.runtimeChains).toBe(chains);
        const fresh = RuntimeConfig.createDetached(DIRECTORY, config);
        fresh.setRuntimePreset(runtime.getRuntimePreset());
        expect(JSON.stringify(arrays)).toBe(JSON.stringify(fresh.modelArrays));
        expect(JSON.stringify(chains)).toBe(
          JSON.stringify(fresh.runtimeChains),
        );
      }
    } finally {
      disabled.restore();
      entries.mockRestore();
    }
  });

  test('host capture and model switching do not rebuild plugin-only chains', () => {
    const runtime = RuntimeConfig.init(DIRECTORY, config);
    const beforeArrays = runtime.modelArrays;
    const beforeChains = runtime.runtimeChains;
    const disabled = countDisabledReads(runtime);
    try {
      for (const host of [
        { model: 'host/default', agent: { custom: { model: 'host/custom' } } },
        { agent: { explorer: { model: ['host/array'] } } },
        {},
      ]) {
        runtime.captureHostConfig(host);
        runtime.everModelSwitched('custom');
        expect(runtime.modelArrays).toEqual(beforeArrays);
        expect(runtime.runtimeChains).toBe(beforeChains);
      }
      expect(disabled.reads).toBe(0);
      expect(runtime.combinedModelInheritanceSource('custom')).toBe('session');
    } finally {
      disabled.restore();
    }
  });

  test('callers cannot corrupt either cached projection', () => {
    const runtime = RuntimeConfig.init(DIRECTORY, config);
    const arrays = runtime.modelArrays;
    const chains = runtime.runtimeChains;
    expect(Object.isFrozen(arrays.explorer)).toBe(true);
    expect(Object.isFrozen(arrays.explorer[0])).toBe(true);
    expect(Object.isFrozen(arrays['councillor-alpha'])).toBe(true);
    expect(Object.isFrozen(chains)).toBe(true);
    expect(Object.isFrozen(chains.explorer)).toBe(true);
    arrays.explorer = [{ id: 'caller/replacement' }];
    arrays.extra = [{ id: 'caller/addition' }];
    expect(runtime.modelArrays.explorer[0].id).toBe('file/explorer');
    expect(runtime.modelArrays.extra).toBeUndefined();
    expect(runtime.runtimeChains).toBe(chains);
  });
});

test('S2: admission and policy invalidate together on preset and reseed', () => {
  const runtime = RuntimeConfig.init(DIRECTORY, {
    agents: { oracle: { skills_include_local: true } },
    presets: { locked: { oracle: { permission: { skill: 'deny' } } } },
  });
  runtime.setProjectSkillPermissionNames(['first']);
  const before = runtime.agentProjection();
  expect(before.skillAdmission.oracle.first).toBe('allow');
  expect(before.skillPermissions.oracle.first).toBe('allow');
  runtime.captureHostConfig({
    agent: { oracle: { permission: { skill: 'ask' } } },
  });
  expect(runtime.agentProjection()).toBe(before);
  runtime.setRuntimePreset('locked');
  const locked = runtime.agentProjection();
  expect(locked).not.toBe(before);
  expect(locked.skillAdmission.oracle.first).toBe('allow');
  expect(locked.skillPermissions.oracle.first).toBe('deny');
  runtime.setProjectSkillPermissionNames(['second']);
  expect(runtime.agentProjection().skillAdmission.oracle.second).toBe('allow');
  expect(runtime.agentProjection().skillAdmission.oracle.first).toBeUndefined();
  expect(runtime.agentProjection().skillPermissions.oracle.second).toBe('deny');
  RuntimeConfig.init(DIRECTORY, {
    agents: { oracle: { permission: { skill: 'ask' }, skills: [] } },
  });
  const reseeded = runtime.agentProjection();
  expect(reseeded.skillAdmission.oracle).toEqual({ '*': 'deny' });
  expect(reseeded.skillPermissions.oracle).toEqual({ '*': 'deny' });
  expect(reseeded.agents).toBe(runtime.agents());
  expect(before.skillAdmission.oracle.first).toBe('allow');
});

test.each([true, false])(
  'S2: defaults-aware authorization is isolated (first: %s)',
  (defaultsFirst) => {
    const runtime = RuntimeConfig.createDetached(DIRECTORY, {
      agents: {
        packaged: { skills_add: ['deliberate'], permission: { skill: 'ask' } },
      },
    });
    const defaults = { packaged: ['manifest'] };
    const first = defaultsFirst
      ? runtime.agentProjection(defaults)
      : runtime.agentProjection();
    const second = defaultsFirst
      ? runtime.agentProjection()
      : runtime.agentProjection(defaults);
    const ordinary = defaultsFirst ? second : first;
    const packaged = defaultsFirst ? first : second;
    expect(packaged.skillPermissions.packaged.manifest).toBe('ask');
    expect(packaged.skillAdmission.packaged.manifest).toBe('allow');
    expect(packaged.skillPermissions.packaged.deliberate).toBe('allow');
    expect(ordinary.skillPermissions.packaged.manifest).toBeUndefined();
    expect(ordinary.skillAdmission.packaged.manifest).toBeUndefined();
    expect(runtime.agentProjection()).toBe(ordinary);
    defaults.packaged = ['replacement'];
    expect(
      runtime.agentProjection(defaults).skillAdmission.packaged.replacement,
    ).toBe('allow');
    expect(
      runtime.agentProjection(defaults).skillAdmission.packaged.manifest,
    ).toBeUndefined();
    expect(
      runtime.agentProjection(defaults).skillPermissions.packaged.replacement,
    ).toBe('ask');
    expect(runtime.agentProjection()).toBe(ordinary);
  },
);

test('S2: token and authorization projections share one frozen generation', () => {
  const runtime = RuntimeConfig.createDetached(DIRECTORY, {
    agents: {
      oracle: { permission: { skill: 'ask' }, skills_include_local: true },
    },
  });
  runtime.setProjectSkillPermissionNames(['local']);
  const projection = runtime.agentProjection();
  expect(projection.agents).toBe(runtime.agents());
  expect(runtime.agentProjection()).toBe(projection);
  expect(Object.isFrozen(projection)).toBe(true);
  expect(Object.isFrozen(projection.skillPermissions.oracle)).toBe(true);
  expect(Object.isFrozen(projection.skillAdmission.oracle)).toBe(true);
  expect(projection.skillAdmission.oracle.local).toBe('allow');
  runtime.setProjectSkillPermissionNames(['other']);
  expect(runtime.agentProjection()).not.toBe(projection);
  expect(runtime.agents()).toBe(runtime.agentProjection().agents);
  expect(runtime.agentProjection().skillAdmission.oracle.other).toBe('allow');
  expect(runtime.agentProjection().skillAdmission.oracle.local).toBeUndefined();
});

describe('RuntimeConfig.agents() memoization', () => {
  test('repeated reads return one frozen projection', () => {
    resetRegistry();
    const runtime = RuntimeConfig.init(DIRECTORY, PROJECTION_CONFIG);
    runtime.setProjectSkillPermissionNames(['exact', 'extra-local']);

    const cold = runtime.agents();
    const warm = runtime.agents();

    // Memoized: the second read is the very same projection object.
    expect(warm).toBe(cold);
    // Frozen: a shared projection must be unmutatable by any consumer.
    expect(Object.isFrozen(cold)).toBe(true);
    expect(Object.isFrozen(cold.explorer)).toBe(true);
    expect(Object.isFrozen(cold.explorer?.skills)).toBe(true);
    // Byte-identical to the uncached projection.
    expect(JSON.stringify(warm)).toBe(GOLDEN_FILE_PRESET);
    expect(JSON.stringify(warm)).toBe(JSON.stringify(cold));
  });

  test('a fresh instance projects identically to a warmed one', () => {
    resetRegistry();
    const warmed = RuntimeConfig.init(DIRECTORY, PROJECTION_CONFIG);
    warmed.setProjectSkillPermissionNames(['exact', 'extra-local']);
    warmed.agents();

    const detached = RuntimeConfig.createDetached(
      DIRECTORY,
      structuredClone(PROJECTION_CONFIG),
    );
    detached.setProjectSkillPermissionNames(['exact', 'extra-local']);

    expect(JSON.stringify(detached.agents())).toBe(
      JSON.stringify(warmed.agents()),
    );
  });

  test('derived getters observe the memoized projection', () => {
    resetRegistry();
    const runtime = RuntimeConfig.init(DIRECTORY, PROJECTION_CONFIG);
    runtime.setProjectSkillPermissionNames(['exact', 'extra-local']);
    const cold = runtime.agents();

    // agent() reads agents() through the alias-aware lookup, so the legacy
    // `explore` key's temperature must survive on the canonical record.
    expect(runtime.agent('explorer')?.temperature).toBe(0.2);
    expect(runtime.agent('explorer')?.skills).toEqual([
      'root',
      'exact',
      'extra-local',
    ]);
    expect(JSON.stringify(runtime.agents())).toBe(JSON.stringify(cold));
    expect(runtime.agents()).toBe(cold);

    // modelArrays is deliberately not driven by PROJECTION_CONFIG: its preset
    // declares a SCALAR model, and modelArrays only projects array-configured
    // models, so the honest result here is empty. The array path is pinned
    // separately below against its own fixture.
    expect(runtime.modelArrays).toEqual({});
    expect(runtime.runtimeChains).toEqual({});
  });

  test('modelArrays and runtimeChains rebuild after a memo invalidation', () => {
    resetRegistry();
    const runtime = RuntimeConfig.init(DIRECTORY, {
      agents: {
        explorer: {
          model: ['array/explorer'],
          skills: ['base'],
          skills_include_local: true,
        },
      },
    });

    expect(runtime.modelArrays).toEqual({
      explorer: [{ id: 'array/explorer' }],
    });
    expect(runtime.runtimeChains).toEqual({ explorer: ['array/explorer'] });

    // An invalidation that changes agents() must reach the derived getters,
    // which is only possible if they read the live projection.
    runtime.setProjectSkillPermissionNames(['exact']);
    expect(runtime.agents().explorer?.skills).toEqual(['base', 'exact']);
    expect(runtime.modelArrays).toEqual({
      explorer: [{ id: 'array/explorer' }],
    });

    RuntimeConfig.init(DIRECTORY, {
      agents: { explorer: { model: ['reseeded/explorer'] } },
    });
    expect(runtime.agents().explorer?.skills).toBeUndefined();
    expect(runtime.modelArrays).toEqual({
      explorer: [{ id: 'reseeded/explorer' }],
    });
  });
});

describe('RuntimeConfig.agents() invalidation points', () => {
  test('setRuntimePreset invalidates on switch, stale name, and clear', () => {
    resetRegistry();
    const runtime = RuntimeConfig.init(DIRECTORY, PROJECTION_CONFIG);
    runtime.setProjectSkillPermissionNames(['exact', 'extra-local']);

    expect(JSON.stringify(runtime.agents())).toBe(GOLDEN_FILE_PRESET);

    runtime.setRuntimePreset('runtime');
    expect(JSON.stringify(runtime.agents())).toBe(GOLDEN_RUNTIME_PRESET);

    // An unknown name clears the selection and must drop the memo too.
    runtime.setRuntimePreset('nonexistent');
    expect(JSON.stringify(runtime.agents())).toBe(GOLDEN_FILE_PRESET);

    // Presets removed by a re-seed must not leak through the memo. A re-seed
    // also drops the supplemental project skill names (seedPlugin resets them),
    // so the projection must be rebuilt against the new inputs.
    RuntimeConfig.init(DIRECTORY, {
      ...PROJECTION_CONFIG,
      presets: undefined,
      preset: undefined,
    });
    expect(runtime.agents().explorer?.model).toBeUndefined();
    expect(runtime.agents().explorer?.skills).toEqual(['root']);

    // And switching back to a still-valid preset still works.
    RuntimeConfig.init(DIRECTORY, PROJECTION_CONFIG);
    runtime.setProjectSkillPermissionNames(['exact', 'extra-local']);
    runtime.setRuntimePreset('runtime');
    expect(JSON.stringify(runtime.agents())).toBe(GOLDEN_RUNTIME_PRESET);
  });

  test('plugin-config re-seed invalidates overrides and project skill names', () => {
    resetRegistry();
    const runtime = RuntimeConfig.init(DIRECTORY, PROJECTION_CONFIG);
    runtime.setProjectSkillPermissionNames(['exact', 'extra-local']);
    expect(JSON.stringify(runtime.agents())).toBe(GOLDEN_FILE_PRESET);

    // Re-seeding replaces the plugin layer, drops the supplemental project
    // skill names, and therefore must invalidate the projection.
    RuntimeConfig.init(DIRECTORY, {
      agents: { oracle: { skills: ['reseeded'] } },
    });
    expect(JSON.stringify(runtime.agents())).toBe(
      '{"oracle":{"skills":["reseeded"]}}',
    );

    // A second re-seed with no project names must not resurrect the old ones.
    RuntimeConfig.init(DIRECTORY, {
      agents: { oracle: { skills: ['again'] } },
    });
    expect(JSON.stringify(runtime.agents())).toBe(
      '{"oracle":{"skills":["again"]}}',
    );
  });

  test('setProjectSkillPermissionNames invalidates the memo', () => {
    resetRegistry();
    const runtime = RuntimeConfig.init(DIRECTORY, PROJECTION_CONFIG);

    runtime.setProjectSkillPermissionNames(['exact', 'extra-local']);
    const first = runtime.agents();
    expect(JSON.stringify(first)).toBe(GOLDEN_FILE_PRESET);

    runtime.setProjectSkillPermissionNames(['exact', 'other-local']);
    expect(runtime.agents().oracle?.skills).toEqual(['o1', 'other-local']);

    runtime.setProjectSkillPermissionNames([]);
    expect(runtime.agents().oracle?.skills).toEqual(['o1']);
    // Clearing the supplemental names drops them from BOTH agents: 'exact' and
    // 'extra-local' only ever entered the projection through this list, so
    // oracle loses its last local addition and explorer keeps just 'root'.
    expect(runtime.agents().explorer?.skills).toEqual(['root']);

    // Returning to a previously seen state reproduces the first projection
    // exactly, so the recomputation is a pure function of the inputs.
    runtime.setProjectSkillPermissionNames(['exact', 'extra-local']);
    expect(JSON.stringify(runtime.agents())).toBe(JSON.stringify(first));
  });

  test('project-local skill names are read once per seed, like before', () => {
    const projectDir = makeProject();
    writeSkill(projectDir, 'arch', 'project-architecture');

    const config: PluginConfig = {
      agents: { explorer: { skills: ['base'], skills_include_local: true } },
    };
    const runtime = RuntimeConfig.init(projectDir, config);
    expect(runtime.agents().explorer?.skills).toEqual([
      'base',
      'project-architecture',
    ]);

    // A new skill file on disk is invisible until the seed is refreshed -
    // this is the pre-existing localSkillNamesCache lifetime, not new staleness
    // introduced by memoizing agents().
    writeSkill(projectDir, 'testing', 'project-testing');
    expect(runtime.agents().explorer?.skills).toEqual([
      'base',
      'project-architecture',
    ]);

    // Re-seeding refreshes both the plugin layer and the discovered names, and
    // the refreshed discovery must reach the projection.
    RuntimeConfig.init(projectDir, config);
    expect(runtime.agents().explorer?.skills).toEqual([
      'base',
      'project-architecture',
      'project-testing',
    ]);
  });

  test('captureHostConfig is not an input to agents()', () => {
    resetRegistry();
    const runtime = RuntimeConfig.init(DIRECTORY, PROJECTION_CONFIG);
    runtime.setProjectSkillPermissionNames(['exact', 'extra-local']);
    const before = runtime.agents();

    // The host layer is merged in agent()/hostAgent(), never in agents(), so a
    // host snapshot must not invalidate the projection...
    runtime.captureHostConfig({
      agent: { explorer: { model: 'host/explorer' } },
      small_model: 'host/small',
    });
    expect(runtime.agents()).toBe(before);
    expect(JSON.stringify(runtime.agents())).toBe(GOLDEN_FILE_PRESET);
    // ...while agent() still sees it.
    expect(runtime.agent('explorer')?.model).toBe('host/explorer');
  });

  test('everModelSwitched and reset do not leak a stale projection', () => {
    resetRegistry();
    const runtime = RuntimeConfig.init(DIRECTORY, PROJECTION_CONFIG);
    runtime.setProjectSkillPermissionNames(['exact', 'extra-local']);
    expect(JSON.stringify(runtime.agents())).toBe(GOLDEN_FILE_PRESET);

    runtime.everModelSwitched('explorer');
    expect(JSON.stringify(runtime.agents())).toBe(GOLDEN_FILE_PRESET);

    RuntimeConfig.reset(DIRECTORY);
    const fresh = RuntimeConfig.get(DIRECTORY);
    expect(JSON.stringify(fresh.agents())).toBe('{}');
  });
});
