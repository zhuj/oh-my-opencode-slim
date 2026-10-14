/**
 * Cached agent-membership sets for the v2 permission rules bridge
 * (`createAgentNameSetsReader` in setup.ts).
 *
 * The bridge's awaited prompt barrier classifies every admitted prompt
 * against these two sets, so the cache must hold two lines at once:
 * each set is built once per input change instead of once per admission,
 * and every build returns exactly the membership the per-call build
 * produced. A stale or widened set here is a security regression, so the
 * invalidation points (registry finalization, native agent snapshot,
 * plugin-agent roster refill) are asserted against real admissions.
 *
 * Two layers, deliberately:
 * - the harness cases drive the reader with a hand-written input record,
 *   which pins the BUILDER's membership and its cache-hit behavior;
 * - the `production plugin-agent writer` case runs a real `createV2Setup`
 *   against a mock host and exercises `setPluginAgents` itself, so the
 *     writer→cache invalidation WIRING is covered by production code rather
 *     than by a test replica of the writer.
 */
import { beforeEach, describe, expect, test } from 'bun:test';
import * as path from 'node:path';
import { OhMyOpenCodeLite } from '../index';
import { withTmpDir } from '../test-utils';
import {
  createAgentNameSetsReader,
  createPermissionRulesBridge,
  createV2Setup,
  deriveExactPermissionRules,
  resetV2GenerationWarnings,
  type V2AgentNameSetInputs,
  type V2AgentNameSets,
  type V2FinalizedRegistry,
} from './setup';
import type { V2Context, V2Session } from './types';

/** Native host agents as captured at agent-transform time. */
const NATIVE_AGENTS: Record<string, Record<string, unknown>> = {
  build: { displayName: 'Build' },
  orchestrator: {},
  'foreign-host-agent': { displayName: 'Foreign' },
};

const PLUGIN_ROSTER = new Set(['probe', 'orchestrator']);

const CHILD_POLICY = { bash: { 'git push': 'ask' } };

function makeRegistry(overrides?: {
  marketplaceAgentNames?: readonly string[];
  identities?: Record<string, string>;
}): V2FinalizedRegistry {
  return {
    marketplaceAgentNames: overrides?.marketplaceAgentNames ?? [],
    identities: overrides?.identities ?? {},
  } as unknown as V2FinalizedRegistry;
}

/** The pre-fix per-call build, kept as the equivalence oracle. */
function referenceSets(inputs: V2AgentNameSetInputs): V2AgentNameSets {
  const registry = inputs.registry;
  const marketplace = registry
    ? new Set(
        registry.marketplaceAgentNames.flatMap((name) => [
          name,
          registry.identities[name] ?? name,
        ]),
      )
    : new Set<string>();
  const known = new Set<string>(inputs.pluginAgents);
  for (const [name, config] of Object.entries(inputs.nativeAgents ?? {})) {
    known.add(name);
    if (typeof config.displayName === 'string') known.add(config.displayName);
  }
  if (registry) {
    for (const [name, identity] of Object.entries(registry.identities)) {
      known.add(name);
      known.add(identity);
    }
  }
  return { marketplace, known };
}

function sorted(names: ReadonlySet<string>): string[] {
  return [...names].sort();
}

/** Mirrors the setup.ts wiring: one mutable input record, one reader. The
 * counting builder delegates to the reference oracle so the reader path
 * and the default build path are held to the same membership. */
function createHarness(initial?: Partial<V2AgentNameSetInputs>) {
  const state = {
    registry: initial?.registry,
    pluginAgents: initial?.pluginAgents ?? new Set<string>(),
    pluginAgentsGeneration: initial?.pluginAgentsGeneration ?? 0,
    nativeAgents: initial?.nativeAgents,
    ...initial,
  };
  let marketplacePolicy = false;
  let builds = 0;
  const read = createAgentNameSetsReader(
    () => ({
      registry: state.registry,
      pluginAgents: state.pluginAgents,
      pluginAgentsGeneration: state.pluginAgentsGeneration,
      nativeAgents: state.nativeAgents,
    }),
    (inputs) => {
      builds += 1;
      return referenceSets(inputs);
    },
  );
  return {
    state,
    read,
    builds: () => builds,
    requireMarketplacePolicy(value: boolean) {
      marketplacePolicy = value;
    },
    /** The roster writer setup.ts uses: in-place refill plus a generation
     * bump, because the bridges hold the Set itself by reference. */
    setPluginAgents(names: Iterable<string>) {
      state.pluginAgents.clear();
      for (const name of names) state.pluginAgents.add(name);
      state.pluginAgentsGeneration += 1;
    },
    isMarketplacePolicyRequired: () => marketplacePolicy,
  };
}

/** The bridge wired exactly as setup.ts wires it. */
function createBridge(
  harness: ReturnType<typeof createHarness>,
  updates: unknown[],
) {
  return createPermissionRulesBridge(
    {
      update: async (input: unknown) => {
        updates.push(input);
        return {};
      },
    } as unknown as V2Session,
    {
      permissionForAgent: (agent) =>
        agent === 'probe' ? CHILD_POLICY : undefined,
      pluginAgents: harness.state.pluginAgents,
      requireKnownIdentity: () => harness.isMarketplacePolicyRequired(),
      marketplaceAgentNames: () => harness.read().marketplace,
      knownAgentNames: () => harness.read().known,
    },
  );
}

function childCreated(
  sessionID: string,
  agent: string,
): Record<string, unknown> {
  return {
    type: 'session.created',
    data: { sessionID, parentID: 'ses_parent', agent },
  };
}

describe('createAgentNameSetsReader', () => {
  beforeEach(() => {
    resetV2GenerationWarnings();
  });

  test('returns the per-call membership for representative agent sets', () => {
    const cases: Array<[string, V2AgentNameSetInputs]> = [
      [
        'unfinalized (no registry)',
        {
          registry: undefined,
          pluginAgents: new Set<string>(),
          pluginAgentsGeneration: 0,
          nativeAgents: undefined,
        },
      ],
      [
        'native agents only, before finalization',
        {
          registry: undefined,
          pluginAgents: new Set(['probe']),
          pluginAgentsGeneration: 1,
          nativeAgents: NATIVE_AGENTS,
        },
      ],
      [
        'marketplace identities plus foreign identities',
        {
          registry: makeRegistry({
            marketplaceAgentNames: ['team/package-agent'],
            identities: {
              'team/package-agent': 'package-agent',
              'host-foreign-agent': 'foreign-host-agent',
            },
          }),
          pluginAgents: PLUGIN_ROSTER,
          pluginAgentsGeneration: 1,
          nativeAgents: NATIVE_AGENTS,
        },
      ],
      [
        'marketplace names without identities',
        {
          registry: makeRegistry({ marketplaceAgentNames: ['plain-agent'] }),
          pluginAgents: PLUGIN_ROSTER,
          pluginAgentsGeneration: 1,
          nativeAgents: NATIVE_AGENTS,
        },
      ],
      [
        'finalized registry, empty native snapshot',
        {
          registry: makeRegistry({
            marketplaceAgentNames: ['team/package-agent'],
            identities: { 'team/package-agent': 'package-agent' },
          }),
          pluginAgents: PLUGIN_ROSTER,
          pluginAgentsGeneration: 2,
          nativeAgents: {},
        },
      ],
    ];

    for (const [label, inputs] of cases) {
      const read = createAgentNameSetsReader(() => inputs);
      const expected = referenceSets(inputs);
      expect(`${label}:${sorted(read().marketplace).join(',')}`).toBe(
        `${label}:${sorted(expected.marketplace).join(',')}`,
      );
      expect(`${label}:${sorted(read().known).join(',')}`).toBe(
        `${label}:${sorted(expected.known).join(',')}`,
      );
    }
  });

  test('builds once across repeated admissions of the same and new sessions', async () => {
    const harness = createHarness({
      registry: makeRegistry({
        marketplaceAgentNames: ['team/package-agent'],
        identities: {
          'team/package-agent': 'package-agent',
          'host-foreign-agent': 'foreign-host-agent',
        },
      }),
      pluginAgents: PLUGIN_ROSTER,
      pluginAgentsGeneration: 1,
      nativeAgents: NATIVE_AGENTS,
    });
    harness.requireMarketplacePolicy(true);
    const updates: unknown[] = [];
    const bridge = createBridge(harness, updates);
    const expectedRules = deriveExactPermissionRules(CHILD_POLICY);

    for (let index = 0; index < 25; index += 1) {
      const sessionID = `ses_managed_${index}`;
      await bridge.observeSessionCreated(childCreated(sessionID, 'probe'));
      await bridge.ensurePromptPermission(sessionID);
      // Replay the same admission: idempotent, and still one build.
      await bridge.ensurePromptPermission(sessionID);

      const foreignID = `ses_foreign_${index}`;
      await bridge.observeSessionCreated(
        childCreated(foreignID, 'foreign-host-agent'),
      );
      await expect(
        bridge.ensurePromptPermission(foreignID),
      ).resolves.toBeUndefined();

      const unclassifiedID = `ses_unclassified_${index}`;
      await bridge.observeSessionCreated(
        childCreated(unclassifiedID, 'stranger'),
      );
      await expect(
        bridge.ensurePromptPermission(unclassifiedID),
      ).rejects.toThrow('child session identity is unknown');
    }

    expect(harness.builds()).toBe(1);
    // Membership decisions are unchanged by the caching: managed children
    // still receive their compiled rules, foreign children still keep the
    // parent's session rules.
    expect(updates).toEqual(
      Array.from({ length: 25 }, () => ({
        sessionID: expect.any(String),
        permissions: expectedRules,
      })),
    );
    await bridge.dispose();
  });

  test('rebuilds when the registry changes, so a dropped marketplace agent stops being marketplace', async () => {
    const withPackage = createHarness({
      registry: makeRegistry({
        marketplaceAgentNames: ['team/package-agent'],
        identities: { 'team/package-agent': 'package-agent' },
      }),
      pluginAgents: PLUGIN_ROSTER,
      pluginAgentsGeneration: 1,
      nativeAgents: NATIVE_AGENTS,
    });
    withPackage.requireMarketplacePolicy(true);
    const bridge = createBridge(withPackage, []);
    const bridgeOf = withPackage;

    await bridge.observeSessionCreated({
      type: 'session.created',
      data: { sessionID: 'ses_root_package', agent: 'package-agent' },
    });
    await expect(
      bridge.ensurePromptPermission('ses_root_package'),
    ).rejects.toThrow('direct root marketplace agent');
    expect(bridgeOf.builds()).toBe(1);

    // A later finalization replaces the registry: the next admission of a
    // package agent must no longer hit the marketplace ceiling.
    bridgeOf.state.registry = makeRegistry({ identities: {} });
    await bridge.observeSessionCreated({
      type: 'session.created',
      data: { sessionID: 'ses_root_package_2', agent: 'package-agent' },
    });
    await expect(
      bridge.ensurePromptPermission('ses_root_package_2'),
    ).resolves.toBeUndefined();
    expect(bridgeOf.builds()).toBe(2);
    expect(sorted(bridgeOf.read().marketplace)).toEqual([]);

    // Losing the registry entirely (retired generation) stays fail-open on
    // the marketplace set and still recognizes the native identities.
    bridgeOf.state.registry = undefined;
    expect(sorted(bridgeOf.read().marketplace)).toEqual([]);
    expect(bridgeOf.read().known.has('foreign-host-agent')).toBe(true);
    expect(bridgeOf.builds()).toBe(3);
    await bridge.dispose();
  });

  test('rebuilds on an in-place roster refill of the same size', () => {
    const harness = createHarness({
      registry: makeRegistry({ identities: {} }),
      pluginAgents: new Set(['probe', 'retired-agent']),
      pluginAgentsGeneration: 1,
      nativeAgents: NATIVE_AGENTS,
    });
    expect(harness.read().known.has('retired-agent')).toBe(true);
    expect(harness.builds()).toBe(1);

    harness.setPluginAgents(['probe', 'fresh-agent']);
    expect(harness.read().known.has('retired-agent')).toBe(false);
    expect(harness.read().known.has('fresh-agent')).toBe(true);
    expect(harness.builds()).toBe(2);
    expect(sorted(harness.read().known)).toEqual(
      sorted(
        referenceSets({
          registry: harness.state.registry,
          pluginAgents: harness.state.pluginAgents,
          pluginAgentsGeneration: harness.state.pluginAgentsGeneration,
          nativeAgents: harness.state.nativeAgents,
        }).known,
      ),
    );
  });

  test('rebuilds when the native agent snapshot is replaced', async () => {
    const harness = createHarness({
      // 'foreign-host-agent' is known ONLY through the native snapshot, so
      // replacing the snapshot must drop it from the known set.
      registry: makeRegistry({ identities: {} }),
      pluginAgents: PLUGIN_ROSTER,
      pluginAgentsGeneration: 1,
      nativeAgents: NATIVE_AGENTS,
    });
    harness.requireMarketplacePolicy(true);
    const bridge = createBridge(harness, []);

    await bridge.observeSessionCreated(
      childCreated('ses_foreign', 'foreign-host-agent'),
    );
    await expect(
      bridge.ensurePromptPermission('ses_foreign'),
    ).resolves.toBeUndefined();
    expect(harness.builds()).toBe(1);

    harness.state.nativeAgents = { build: { displayName: 'Build' } };
    // The identity that classified the child is no longer known, so the
    // very next admission fails closed instead of riding a stale set.
    await expect(bridge.ensurePromptPermission('ses_foreign')).rejects.toThrow(
      'child session identity is unknown',
    );
    expect(harness.builds()).toBe(2);
    await bridge.dispose();
  });
});

describe('production plugin-agent writer invalidates the cached sets', () => {
  beforeEach(() => {
    resetV2GenerationWarnings();
  });

  test('a roster refill performed by setup finalization invalidates the cached membership', async () => {
    await withV2Fixture(async (projectDir) => {
      // Given: a real setup whose agent draft arrives DEFERRED, so the
      // production writer has not run yet and the roster is empty.
      const host = makeRosterWriterHost(projectDir);
      const probe = await host.startSetup();
      try {
        expect(probe.pluginAgents.size).toBe(0);
        const beforeFinalization = probe.read();
        expect(beforeFinalization.known.has('explorer')).toBe(false);
        expect(sorted(beforeFinalization.marketplace)).toEqual([]);

        // When: PRODUCTION finalization runs the real setPluginAgents writer.
        host.finalizeAgentDraft();

        // Then: the roster was refilled in place (same Set identity — the
        // bridges hold it by reference, so only the generation can announce
        // the change) and the cached membership was rebuilt from it.
        expect(probe.pluginAgents.has('explorer')).toBe(true);
        const afterFinalization = probe.read();
        expect(afterFinalization).not.toBe(beforeFinalization);
        expect(afterFinalization.known.has('explorer')).toBe(true);
        expect(sorted(afterFinalization.marketplace)).toEqual([]);
        // The native identities the host exposed are carried too.
        expect(sorted(afterFinalization.known)).toContain('build');
        expect(sorted(afterFinalization.known)).toContain('foreign-host-agent');

        // A second PRODUCTION finalization (a replayed agent draft) refills
        // the roster in place again, same size. Every other reader input is
        // unchanged, so the generation bump is the ONLY thing that can
        // invalidate the cache — this assertion fails if the writer stops
        // bumping it.
        expect(probe.read()).toBe(afterFinalization);
        host.finalizeAgentDraft();
        const afterReplay = probe.read();
        expect(afterReplay).not.toBe(afterFinalization);
        // Same inputs, same membership: only the build identity changed.
        expect(sorted(afterReplay.known)).toEqual(
          sorted(afterFinalization.known),
        );
        expect(sorted(afterReplay.marketplace)).toEqual(
          sorted(afterFinalization.marketplace),
        );
      } finally {
        await host.dispose();
      }
    });
  }, 20_000);
});

/** Minimal hermetic project fixture: empty plugin config, companion off. */
async function withV2Fixture<T>(
  callback: (projectDir: string) => Promise<T>,
): Promise<T> {
  const originalEnv = { ...process.env };
  return await withTmpDir(async (tmp) => {
    const projectDir = path.join(tmp, 'project');
    await Bun.write(
      path.join(projectDir, '.opencode', 'oh-my-opencode-slim.json'),
      JSON.stringify({ companion: { enabled: false } }),
    );
    process.env = {
      ...originalEnv,
      OPENCODE_CONFIG_DIR: path.join(tmp, 'config'),
      XDG_CONFIG_HOME: path.join(tmp, 'xdg-config'),
      XDG_DATA_HOME: path.join(tmp, 'xdg-data'),
      XDG_CACHE_HOME: path.join(tmp, 'xdg-cache'),
      OPENCODE_LOG_DIR: path.join(tmp, 'logs'),
    };
    delete process.env.OH_MY_OPENCODE_SLIM_DISABLE;
    try {
      return await callback(projectDir);
    } finally {
      process.env = originalEnv;
    }
  });
}

/**
 * Host context whose agent draft is deferred to the test, mirroring the mock
 * of setup.e2e.test.ts: the production `finalizeAgentDraft` closure is
 * captured verbatim, so the roster writer under test is the real one.
 */
function makeRosterWriterHost(projectDir: string): {
  startSetup(): Promise<{
    read: () => V2AgentNameSets;
    pluginAgents: ReadonlySet<string>;
  }>;
  /** Deliver the agent draft, running PRODUCTION finalization (and its
   * `setPluginAgents` writer) exactly as a real host would. */
  finalizeAgentDraft(): void;
  dispose(): Promise<void>;
} {
  let finalizeAgentDraft: (() => void) | undefined;
  let capturedProbe:
    | { read: () => V2AgentNameSets; pluginAgents: ReadonlySet<string> }
    | undefined;
  const nativeAgents = {
    build: { id: 'build', mode: 'primary', permissions: [] },
    'foreign-host-agent': {
      id: 'foreign-host-agent',
      mode: 'subagent',
      permissions: [],
    },
  };
  const ctx = {
    app: { name: 'opencode', version: 'v2-roster-writer' },
    options: {},
    location: {
      directory: projectDir,
      project: {
        id: 'proj_roster',
        directory: projectDir,
        canonical: projectDir,
      },
    },
    agent: {
      transform: async (callback: (draft: unknown) => void) => {
        finalizeAgentDraft = () =>
          callback({
            list: () => Object.values(nativeAgents),
            get: (id: string) => nativeAgents[id as keyof typeof nativeAgents],
            default: () => {},
            update: (
              id: string,
              project: (agent: Record<string, unknown>) => void,
            ) => {
              project({ ...nativeAgents[id as keyof typeof nativeAgents] });
            },
            remove: () => {},
          });
        return { dispose: () => {} };
      },
      reload: async () => ({}),
      list: async () => Object.values(nativeAgents),
    },
    mcp: {
      transform: async (callback: (draft: unknown) => void) => {
        callback({
          list: () => [],
          get: () => undefined,
          set: () => {},
          update: () => {},
          remove: () => {},
        });
        return { dispose: () => {} };
      },
      reload: async () => {},
    },
    tool: {
      transform: async (callback: (draft: unknown) => void) => {
        callback({ add: () => {}, update: () => {} });
        return { dispose: () => {} };
      },
      hook: async () => ({ dispose: () => {} }),
    },
    command: {
      transform: async (callback: (draft: unknown) => void) => {
        callback({ add: () => {} });
        return { dispose: () => {} };
      },
      list: async () => ({ location: {}, data: [] }),
    },
    session: {
      hook: async () => ({ dispose: () => {} }),
      update: async () => ({}),
      get: async ({ sessionID }: { sessionID: string }) => ({ sessionID }),
    },
    event: {
      subscribe: () => ({
        [Symbol.asyncIterator]: () => ({
          next: () => new Promise<IteratorResult<never>>(() => {}),
        }),
      }),
    },
  } as unknown as V2Context;

  let cleanup: (() => Promise<void>) | undefined;
  return {
    async startSetup() {
      cleanup = await createV2Setup(OhMyOpenCodeLite, {
        agentNameSets: (state) => {
          capturedProbe = state;
        },
      })(ctx);
      if (!capturedProbe) {
        throw new Error('setup did not publish the agent-name-sets probe');
      }
      if (!finalizeAgentDraft) {
        throw new Error('setup never registered an agent transform');
      }
      return capturedProbe;
    },
    finalizeAgentDraft() {
      if (!finalizeAgentDraft) throw new Error('no agent draft captured');
      finalizeAgentDraft();
    },
    async dispose() {
      await cleanup?.();
    },
  };
}
