import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { CouncilConfigSchema } from '../config';
import { RuntimeConfig } from '../config/runtime';
import type { MarketplaceActivationStore } from '../marketplace/activation';
import * as marketplaceImplementation from '../marketplace/registry-runtime';
import { MarketplacePackageManifestSchema } from '../marketplace/schemas';
import { createAgents } from './index';
import { buildResolvedAgentRegistry } from './registry';

// Re-pin recipe:
// Run this suite on the base commit (908f9a1f) with v2 options and print serialize(run()) per scenario.
// Re-pin only for intentional byte changes.
const DIR = 'runtime-key-order-registry';

function runtimeFor(config: Parameters<typeof RuntimeConfig.init>[1]) {
  RuntimeConfig.reset(DIR);
  return RuntimeConfig.init(DIR, config, 'v2');
}

function build(
  runtime: RuntimeConfig,
  hostSnapshot: Record<string, unknown>,
  options: Record<string, unknown> = {},
) {
  const definitions = createAgents(runtime, {
    hostFlavor: 'v2',
    ...options,
  } as Parameters<typeof createAgents>[1]);
  return buildResolvedAgentRegistry(runtime, {
    hostSnapshot,
    definitions,
    hostFlavor: 'v2',
    ...options,
  } as Parameters<typeof buildResolvedAgentRegistry>[1]);
}

function marketplacePackage(id: string, overrides: Record<string, unknown>) {
  const manifest = MarketplacePackageManifestSchema.parse({
    schemaVersion: 2,
    id,
    version: '1.0.0',
    displayName: 'Marketplace agent',
    description: 'Marketplace specialist',
    prompt: 'Package prompt',
    skills: ['skill-a'],
    mcps: ['host-mcp'],
    tools: ['read'],
    author: { name: 'Author' },
    tags: [],
    license: 'MIT',
    compatibility: { plugin: '>=1.0.0' },
    model: { source: 'explicit', candidates: ['provider/package'] },
    routing: {
      description: 'Specialist lane',
      when: 'Use for package work',
      keywords: ['package'],
    },
    ...overrides,
  });
  return {
    manifest,
    digest: 'a'.repeat(64),
    source: { type: 'registry', registry: 'https://example.test' },
    path: `/marketplace/${id}`,
  };
}

function marketplaceStore(
  packages: Record<string, ReturnType<typeof marketplacePackage>>,
): MarketplaceActivationStore {
  return {
    loadSelected(ids) {
      return {
        packages: new Map(
          ids.flatMap((id) => (packages[id] ? [[id, packages[id]]] : [])),
        ),
        errors: new Map(),
      };
    },
  };
}

function marketplaceOptions(
  selectedPackageIds: readonly string[],
  store: MarketplaceActivationStore,
) {
  return {
    marketplace: {
      implementation: marketplaceImplementation,
      selectedPackageIds,
      store,
      pluginVersion: '3.2.0',
      availableSkillNames: ['skill-a'],
    },
  };
}

const NATIVE_POLICY_PROBES = [
  ['read', '*'],
  ['bash', '*'],
  ['shell', '*'],
  ['task', '*'],
  ['skill', 'skill-a'],
  ['host-mcp_tool', '*'],
  ['external_directory', '*'],
] as const;

function serialize(registry: ReturnType<typeof build>) {
  const childPermissions = Object.fromEntries(
    registry.agentNames.map((name) => {
      try {
        return [name, registry.compileChildPermissions(name, [])];
      } catch (error) {
        return [name, error instanceof Error ? error.message : String(error)];
      }
    }),
  );
  const nativePolicies = Object.fromEntries(
    Object.entries(registry.nativePolicies).map(([name, policy]) => [
      name,
      NATIVE_POLICY_PROBES.map(([action, resource]) => [
        action,
        resource,
        policy.decide(action, resource),
      ]),
    ]),
  );
  const capture = {
    finalAgentConfig: Object.entries(registry.finalAgentConfig),
    effectiveStartupModels: registry.effectiveStartupModels,
    tuiAgentModels: registry.tuiAgentModels,
    tuiAgentVariants: registry.tuiAgentVariants,
    identities: registry.identities,
    modelCandidates: registry.modelCandidates,
    managedAgentConfig: registry.managedAgentConfig,
    childPermissions,
    nativePolicies,
  };
  const bytes = JSON.stringify(capture);
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  return {
    keys: Object.keys(registry.finalAgentConfig),
    sha256,
  };
}

const EXPECTED: Record<string, { keys: string[]; sha256: string }> = {
  default: {
    keys: ['orchestrator', 'explorer', 'oracle', 'designer', 'fixer'],
    sha256: 'd953ada472821c7091966d320fe2940ed535e90763e7014c40380350f8aa8db9',
  },
  'host override': {
    keys: ['explorer', 'orchestrator', 'oracle', 'designer', 'fixer'],
    sha256: '83efe5ce121a826d9775b8ce7b21d87dea64191a6b28f37f72ad67f97735f1a1',
  },
  preset: {
    keys: ['explorer', 'orchestrator', 'oracle', 'designer', 'fixer'],
    sha256: '832c911aec2f645766bba4cc226fc275efb2c68db136362990bcfd21440c4995',
  },
  'marketplace orchestrator': {
    keys: [
      'orchestrator',
      'explorer',
      'oracle',
      'designer',
      'fixer',
      'orchestrator-agent',
    ],
    sha256: '2921fabf6542e45acaa26cf634c13930a581e56803318fa951312c80e90c0b83',
  },
  'marketplace builtin': {
    keys: [
      'FixerVisible',
      'orchestrator',
      'explorer',
      'oracle',
      'designer',
      'fixer',
      'writer-agent',
    ],
    sha256: 'b237576fb1beab9ab5ec2b73efeba632edd9cb3813806d1b581536ca7d330cf2',
  },
  'orchestrator display alias': {
    keys: [
      'orchestrator',
      'explorer',
      'oracle',
      'designer',
      'fixer',
      'orchestrator-agent',
      'Lead',
    ],
    sha256: 'fa94f9f35092d2fcd22e84b12170ad9bb7f1c49648cd365d163debe3f76f24f9',
  },
  'session follow': {
    keys: [
      'orchestrator',
      'explorer',
      'oracle',
      'designer',
      'fixer',
      'follows-session',
    ],
    sha256: '658efb2aa5067327b43efb86d70e58d617a2b08d4feec482e73ed8545c3b7783',
  },
  'aliased council': {
    keys: [
      'council',
      'orchestrator',
      'explorer',
      'oracle',
      'designer',
      'fixer',
      'councillor',
      'councillor-alpha',
      'panel',
    ],
    sha256: '71911e176c9bee391ad15a2d13e7670707e9baed5386f22c0ee9231e0f49bbe6',
  },
  'empty host model': {
    keys: ['explorer', 'orchestrator', 'oracle', 'designer', 'fixer'],
    sha256: '6f054c8c10097a288a19f600c14e554f940cc567cadd2bdd4f5f5c6cf13bd19b',
  },
};

const SCENARIOS: Record<string, () => ReturnType<typeof build>> = {
  default: () => build(runtimeFor({}), {}),
  'empty host model': () =>
    build(runtimeFor({}), { agent: { explorer: { model: '' } } }),
  'host override': () =>
    build(runtimeFor({}), {
      agent: {
        explorer: { model: 'host/model' },
        orchestrator: { model: 'host/orchestrator', variant: 'host-v' },
      },
    }),
  preset: () => {
    const runtime = runtimeFor({
      presets: {
        child: { agents: { explorer: { model: 'preset/child' } } },
      },
    });
    runtime.setRuntimePreset('child');
    return build(runtime, {
      agent: { explorer: { prompt: 'host prompt' } },
    });
  },
  'marketplace orchestrator': () => {
    const packages = {
      'team/orchestrator': marketplacePackage('team/orchestrator', {
        agentName: 'orchestrator-agent',
        model: { source: 'orchestrator' },
      }),
    };
    return build(
      runtimeFor({}),
      {
        agent: { orchestrator: { model: 'host/orchestrator' } },
        mcp: { 'host-mcp': { type: 'local' } },
      },
      marketplaceOptions(Object.keys(packages), marketplaceStore(packages)),
    );
  },
  'marketplace builtin': () => {
    const packages = {
      'team/bash': marketplacePackage('team/bash', {
        agentName: 'writer-agent',
        extends: { builtin: 'fixer', promptMode: 'append' },
        tools: ['bash'],
        model: { source: 'builtin' },
      }),
    };
    return build(
      runtimeFor({
        agents: {
          fixer: { model: 'provider/fixer', displayName: 'FixerVisible' },
        },
      }),
      {
        agent: { FixerVisible: { model: 'host/fixer', variant: 'host-v' } },
        mcp: { 'host-mcp': { type: 'local' } },
      },
      marketplaceOptions(Object.keys(packages), marketplaceStore(packages)),
    );
  },
  'orchestrator display alias': () => {
    const packages = {
      'team/orchestrator-alias': marketplacePackage('team/orchestrator-alias', {
        agentName: 'orchestrator-agent',
        model: { source: 'orchestrator' },
      }),
    };
    return build(
      runtimeFor({
        agents: {
          orchestrator: {
            displayName: 'Lead',
            model: 'provider/orchestrator',
          },
        },
      }),
      { mcp: { 'host-mcp': { type: 'local' } } },
      marketplaceOptions(Object.keys(packages), marketplaceStore(packages)),
    );
  },
  'session follow': () => {
    const packages = {
      'team/follows-session': marketplacePackage('team/follows-session', {
        agentName: 'follows-session',
        model: { source: 'session' },
      }),
    };
    return build(
      runtimeFor({}),
      { mcp: { 'host-mcp': { type: 'local' } } },
      marketplaceOptions(Object.keys(packages), marketplaceStore(packages)),
    );
  },
  'aliased council': () =>
    build(
      runtimeFor({
        council: CouncilConfigSchema.parse({
          presets: { default: { alpha: { model: 'provider/council' } } },
        }),
        agents: { council: { displayName: 'panel' } },
      }),
      { agent: { council: { prompt: 'host council prompt' } } },
    ),
};

describe('finalAgentConfig key order and bytes (#1883 characterization)', () => {
  for (const [name, run] of Object.entries(SCENARIOS)) {
    test(name, () => {
      const actual = serialize(run());
      expect(actual).toEqual(EXPECTED[name]);
    });
  }
});
