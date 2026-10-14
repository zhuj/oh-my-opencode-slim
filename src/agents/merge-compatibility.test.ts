import { describe, expect, test } from 'bun:test';
import { RuntimeConfig } from '../config/runtime';
import {
  createAgents,
  getAgentConfigsFromDefinitions,
  mergeHostAgentConfigs,
  projectAgentRuntimeState,
} from './index';
import { buildResolvedAgentRegistry } from './registry';

describe('v3 registry compatibility with custom configuration', () => {
  test('dynamic runtime preset clears a stale host model in the frozen registry', () => {
    // Given
    const runtime = RuntimeConfig.create('merge-dynamic-registry', {
      presets: {
        selected: { explorer: { model: { dynamic: 'selected' } } },
      },
    });
    runtime.setRuntimePreset('selected');

    // When
    const registry = buildResolvedAgentRegistry(runtime, {
      hostSnapshot: { agent: { explorer: { model: 'host/stale' } } },
    });

    // Then
    expect(registry.getSdkAgentProjection().explorer?.model).toBeUndefined();
  });

  test('dynamic runtime preset clears a stale model in refreshed profiles', () => {
    // Given
    const runtime = RuntimeConfig.create('merge-dynamic-profile', {});
    const agentDefs = createAgents(runtime);
    const agentConfigs = mergeHostAgentConfigs(
      getAgentConfigsFromDefinitions(runtime, agentDefs),
      { explorer: { model: 'host/stale' } },
    );

    // When
    const { profiles } = projectAgentRuntimeState({
      runtime,
      agentDefs,
      agentConfigs,
      runtimePreset: { explorer: { model: { dynamic: 'selected' } } },
    });

    // Then
    expect(profiles.explorer?.model).toBeUndefined();
  });

  test.each(['v1', 'v2'])(
    'preserves glob skill policies natively on %s',
    (hostFlavor) => {
      // Given
      const runtime = RuntimeConfig.create(`merge-skills-${hostFlavor}`, {
        agents: {
          explorer: {
            skills: ['using_*', '!using_secret', '?design_?', '!private_*'],
          },
        },
      });

      // When
      const registry = buildResolvedAgentRegistry(runtime, {
        hostSnapshot: {},
        hostFlavor,
      });
      const policy = registry.nativePolicies.explorer;

      // Then
      expect(policy.decide('skill', 'using_tools')).toBe('allow');
      expect(policy.decide('skill', 'using_secret')).toBe('deny');
      expect(policy.decide('skill', 'design_x')).toBe('ask');
      expect(policy.decide('skill', 'private_key')).toBe('deny');
      expect(policy.decide('skill', 'other')).toBe('deny');
    },
  );
});
