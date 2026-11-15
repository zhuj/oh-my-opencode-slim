import { afterEach, describe, expect, test } from 'bun:test';
import type { PluginConfig } from '../config';
import { RuntimeConfig } from '../config/runtime';
import { applyOverrides, createAgents } from './index';

const TEST_DIRECTORY = 'runtime-test-dynamic-model-override';

function runtimeFor(config: PluginConfig) {
  RuntimeConfig.reset(TEST_DIRECTORY);
  RuntimeConfig.init(TEST_DIRECTORY, config);
  return RuntimeConfig.get(TEST_DIRECTORY);
}

afterEach(() => RuntimeConfig.reset(TEST_DIRECTORY));

describe('dynamic selected-model overrides', () => {
  test('clears a built-in agent factory model and fallback chain', () => {
    const runtime = runtimeFor({
      preset: 'selected-model-test',
      presets: {
        'selected-model-test': {
          orchestrator: { model: 'provider/session-selected' },
        },
      },
      agents: { explorer: { model: { dynamic: 'selected' } } },
    });
    const explorer = createAgents(runtime).find(
      (agent) => agent.name === 'explorer',
    );

    expect(explorer).toBeDefined();
    expect(explorer?.config.model).toBeUndefined();
    expect(explorer?._modelArray).toBeUndefined();
  });

  test('clears stale model metadata without an explicit variant override', () => {
    const runtime = runtimeFor({
      preset: 'selected-model-test',
      presets: {
        'selected-model-test': {
          orchestrator: { model: 'provider/session-selected' },
        },
      },
    });
    const explorer = createAgents(runtime).find(
      (agent) => agent.name === 'explorer',
    );

    expect(explorer).toBeDefined();
    if (!explorer) throw new Error('Explorer agent factory returned no agent');

    expect(explorer.config.model).toBe('provider/session-selected');
    explorer.config.variant = 'factory-variant';
    explorer._modelArray = [{ id: 'provider/stale-fallback' }];
    applyOverrides(explorer, { model: { dynamic: 'selected' } });

    expect(explorer.config.model).toBeUndefined();
    expect(explorer.config.variant).toBeUndefined();
    expect(explorer._modelArray).toBeUndefined();
  });

  test('preserves an explicit variant when the selected model is dynamic', () => {
    const runtime = runtimeFor({
      preset: 'selected-model-test',
      presets: {
        'selected-model-test': {
          orchestrator: { model: 'provider/session-selected' },
        },
      },
      agents: {
        explorer: { model: { dynamic: 'selected' }, variant: 'high' },
      },
    });
    const explorer = createAgents(runtime).find(
      (agent) => agent.name === 'explorer',
    );

    expect(explorer).toBeDefined();
    expect(explorer?.config.model).toBeUndefined();
    expect(explorer?.config.variant).toBe('high');
  });

  test('clears the factory variant when the explicit variant is empty', () => {
    const runtime = runtimeFor({
      preset: 'selected-model-test',
      presets: {
        'selected-model-test': {
          orchestrator: { model: 'provider/session-selected' },
        },
      },
    });
    const explorer = createAgents(runtime).find(
      (agent) => agent.name === 'explorer',
    );

    expect(explorer).toBeDefined();
    if (!explorer) throw new Error('Explorer agent factory returned no agent');

    expect(explorer.config.model).toBe('provider/session-selected');
    explorer.config.variant = 'factory-variant';
    explorer._modelArray = [{ id: 'provider/factory-fallback' }];
    applyOverrides(explorer, {
      model: { dynamic: 'selected' },
      variant: '',
    });

    expect(explorer.config.model).toBeUndefined();
    expect(explorer._modelArray).toBeUndefined();
    expect(explorer.config.variant).toBeUndefined();
  });
});
