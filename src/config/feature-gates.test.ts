import { describe, expect, test } from 'bun:test';
import {
  type FeatureGateConfig,
  resolveFeatureGates,
  UnsupportedHostConfigError,
  validateExplicitHostConfig,
} from './feature-gates';
import type { PluginConfig } from './schema';

test('valid legacy primary scopes are accepted across config layers', () => {
  const scope = { orchestrator: { subagents: ['fixer', '@Researcher'] } };
  for (const config of [
    { routingBlock: true },
    { routingBlock: false },
    { agents: scope },
    { presets: { old: scope } },
    { presets: { old: { extends: 'base', agents: scope } } },
  ]) {
    expect(() => validateExplicitHostConfig(config, 'v2')).not.toThrow();
  }
});

test('invalid delegation scopes still fail before a later layer can mask them', () => {
  const scope = { orchestrator: { subagents: ['@*'] } };
  for (const [config, key] of [
    [{ agents: scope }, 'agents.orchestrator.subagents'],
    [{ presets: { old: scope } }, 'presets.old.orchestrator.subagents'],
    [
      { presets: { old: { extends: 'base', agents: scope } } },
      'presets.old.agents.orchestrator.subagents',
    ],
  ] as const) {
    const validate = () =>
      validateExplicitHostConfig(config, 'v2', '/config/slim.json');
    expect(validate).toThrow(UnsupportedHostConfigError);
    expect(validate).toThrow(
      `/config/slim.json: ${key} must list valid specialist names`,
    );
  }
});

test('agent names and provider options are not retired keys', () => {
  const config = {
    agents: { subagents: { model: 'test/model' } },
    presets: {
      flat: {
        agents: { model: 'test/model', options: { subagents: [] } },
        orchestrator: { permission: { task: { '*': 'deny', fixer: 'allow' } } },
      },
      wrapped: { agents: { subagents: { model: 'test/model' } } },
    },
  };
  expect(() => validateExplicitHostConfig(config, 'v2')).not.toThrow();
});

test('removed fallback keys refuse startup even without task controls', () => {
  for (const fallback of [
    { continuationPolicy: 'retry-primary' },
    { initialRetryDelayMs: 0 },
    { continuationPolicy: undefined, initialRetryDelayMs: 100 },
  ]) {
    for (const backgroundJobs of [undefined, { mode: 'off' }]) {
      const validate = () =>
        validateExplicitHostConfig(
          { fallback, backgroundJobs, disabled_hooks: ['foreground-fallback'] },
          'v2',
          '/config/slim.json',
        );
      expect(validate).toThrow(UnsupportedHostConfigError);
      expect(validate).toThrow('/config/slim.json');
      expect(validate).toThrow('then run /reload');
      for (const key of Object.keys(fallback)) {
        expect(validate).toThrow(`fallback.${key}`);
      }
    }
  }
  expect(() =>
    validateExplicitHostConfig(
      { fallback: { enabled: false, maxRetries: 7, retryDelayMs: 125 } },
      'v2',
    ),
  ).not.toThrow();
});

test('refuses the retired positive wall-clock limit with its full path', () => {
  const validate = () =>
    validateExplicitHostConfig(
      {
        backgroundJobs: {
          wallClockTimeoutMs: 900000,
          concurrency: { defaultConcurrency: 4 },
        },
      },
      'v2',
      '/config/slim.json',
    );
  expect(validate).toThrow(UnsupportedHostConfigError);
  expect(validate).toThrow('/config/slim.json');
  expect(validate).toThrow('backgroundJobs.wallClockTimeoutMs = 900000');
  expect(validate).toThrow('then run /reload');
});

describe('resolveFeatureGates', () => {
  test('defaults background jobs to native on v2', () => {
    const gates = resolveFeatureGates({});

    expect(gates).toEqual({
      backgroundJobsMode: 'native',
      admissionQueue: true,
      presetRouting: true,
      replaceBuiltinSubagents: true,
      tui: true,
      sidebar: true,
      interview: true,
      marketplace: true,
      webfetch: true,
      liveConfigRefresh: true,
      updateChecker: true,
    });
    expect(Object.isFrozen(gates)).toBe(true);
  });

  test('legacy managed mode enables admission with the native lifecycle', () => {
    expect(
      resolveFeatureGates({ backgroundJobs: { mode: 'managed' } }),
    ).toMatchObject({
      backgroundJobsMode: 'native',
      admissionQueue: true,
      presetRouting: true,
    });
  });

  test('queue and preset routing are independently configurable', () => {
    expect(
      resolveFeatureGates({
        backgroundJobs: { mode: 'native', queue: { enabled: true } },
        sessionPresetRouting: false,
      }),
    ).toMatchObject({ admissionQueue: true, presetRouting: false });
    expect(
      resolveFeatureGates({
        backgroundJobs: {
          mode: 'native',
          concurrency: { defaultConcurrency: 2 },
        },
      }).admissionQueue,
    ).toBe(true);
    expect(
      resolveFeatureGates({
        backgroundJobs: {
          mode: 'managed',
          queue: { enabled: false },
          concurrency: { defaultConcurrency: 2 },
        },
      }).admissionQueue,
    ).toBe(false);
    expect(
      resolveFeatureGates({
        backgroundJobs: {
          mode: 'off',
          queue: { enabled: true },
          concurrency: { defaultConcurrency: 2 },
        },
        sessionPresetRouting: true,
      }),
    ).toMatchObject({ admissionQueue: false, presetRouting: true });
  });

  test('accepts explicit native and off modes on v2', () => {
    const native = resolveFeatureGates({ backgroundJobs: { mode: 'native' } });
    expect(native.backgroundJobsMode).toBe('native');
    expect(native.admissionQueue).toBe(false);
    expect(native.presetRouting).toBe(true);

    const off = resolveFeatureGates({ backgroundJobs: { mode: 'off' } });
    expect(off.backgroundJobsMode).toBe('off');
    expect(off.presetRouting).toBe(false);
  });

  test('session preset routing is independent of native task controls', () => {
    expect(
      resolveFeatureGates({
        backgroundJobs: { mode: 'off' },
        sessionPresetRouting: true,
      }),
    ).toMatchObject({ backgroundJobsMode: 'off', presetRouting: true });
    expect(
      resolveFeatureGates({
        backgroundJobs: { mode: 'native' },
        sessionPresetRouting: false,
      }),
    ).toMatchObject({ backgroundJobsMode: 'native', presetRouting: false });
    expect(
      resolveFeatureGates({ replaceBuiltinSubagents: false })
        .replaceBuiltinSubagents,
    ).toBe(false);
  });

  test('rejects invalid explicit modes before sanitization or runtime seeding', () => {
    for (const mode of ['of', null, false, 42, {}]) {
      const config = { backgroundJobs: { mode } };
      expect(() =>
        validateExplicitHostConfig(config, 'v2', '/config/slim.json'),
      ).toThrow('Invalid backgroundJobs.mode');
      expect(() => resolveFeatureGates(config as FeatureGateConfig)).toThrow(
        'Invalid backgroundJobs.mode',
      );
    }
  });

  test('keeps the sidebar off whenever the TUI master switch is off', () => {
    expect(resolveFeatureGates({ tui: false }).tui).toBe(false);
    expect(resolveFeatureGates({ tui: false }).sidebar).toBe(false);
    // An explicit sidebar: true cannot re-enable the sidebar while the
    // surrounding TUI surface is off.
    expect(resolveFeatureGates({ tui: false, sidebar: true }).sidebar).toBe(
      false,
    );

    // The sidebar switch leaves the other TUI surfaces on.
    const sidebarOff = resolveFeatureGates({ sidebar: false });
    expect(sidebarOff.tui).toBe(true);
    expect(sidebarOff.sidebar).toBe(false);
  });

  test('reads the nested interview and marketplace enabled switches', () => {
    expect(resolveFeatureGates({ interview: {} }).interview).toBe(true);
    expect(
      resolveFeatureGates({ interview: { enabled: false } }).interview,
    ).toBe(false);
    expect(resolveFeatureGates({ marketplace: {} }).marketplace).toBe(true);
    expect(
      resolveFeatureGates({ marketplace: { enabled: false } }).marketplace,
    ).toBe(false);
  });

  test('disables live config refresh only on an explicit false', () => {
    expect(
      resolveFeatureGates({ liveConfigRefresh: true }).liveConfigRefresh,
    ).toBe(true);
    expect(
      resolveFeatureGates({ liveConfigRefresh: false }).liveConfigRefresh,
    ).toBe(false);
  });

  test('disables the update checker only on autoUpdate: false', () => {
    expect(resolveFeatureGates({ autoUpdate: false }).updateChecker).toBe(
      false,
    );
    expect(resolveFeatureGates({ autoUpdate: true }).updateChecker).toBe(true);
    // The retired disabled_hooks alias has no effect on the gate.
    expect(
      resolveFeatureGates({
        autoUpdate: true,
        disabled_hooks: ['auto-update-checker'],
      } as FeatureGateConfig).updateChecker,
    ).toBe(true);

    // Unrelated hooks and an explicit autoUpdate: true keep checking on.
    expect(
      resolveFeatureGates({
        autoUpdate: true,
        disabled_hooks: ['cache-monitor'],
      } as FeatureGateConfig).updateChecker,
    ).toBe(true);
  });

  test('keeps webfetch enabled by default', () => {
    expect(resolveFeatureGates().webfetch).toBe(true);
    expect(resolveFeatureGates({ disabled_tools: [] }).webfetch).toBe(true);
    expect(
      resolveFeatureGates({ disabled_tools: ['ast_grep_search'] }).webfetch,
    ).toBe(true);
  });

  test('disables webfetch only when disabled_tools lists it', () => {
    expect(resolveFeatureGates({ disabled_tools: ['webfetch'] }).webfetch).toBe(
      false,
    );
    // The retired root webfetch block is not a gate input.
    expect(
      resolveFeatureGates({
        webfetch: { enabled: false },
      } as unknown as FeatureGateConfig).webfetch,
    ).toBe(true);
  });

  test('keeps webfetch enabled for unrelated disabled tools', () => {
    expect(
      resolveFeatureGates({
        disabled_tools: ['ast_grep_search', 'task_cancel'],
      }).webfetch,
    ).toBe(true);
  });

  test('ignores malformed disabled lists like the runtime getters', () => {
    for (const value of [{}, null, 42, 'webfetch']) {
      const gates = resolveFeatureGates({
        disabled_tools: value as unknown as readonly string[],
        disabled_hooks: value as unknown as readonly string[],
      } as FeatureGateConfig);
      expect(gates.webfetch).toBe(true);
      expect(gates.updateChecker).toBe(true);
    }
  });

  test('accepts a resolved plugin config and freezes the projection', () => {
    const config: PluginConfig = {
      tui: false,
      sidebar: true,
      interview: { enabled: false },
      marketplace: { enabled: false },
      disabled_tools: ['webfetch'],
      liveConfigRefresh: false,
      autoUpdate: false,
      backgroundJobs: { mode: 'native' },
      disabled_hooks: ['cache-monitor'],
    };

    const gates = resolveFeatureGates(config);
    expect(gates).toEqual({
      backgroundJobsMode: 'native',
      admissionQueue: false,
      presetRouting: true,
      replaceBuiltinSubagents: true,
      tui: false,
      sidebar: false,
      interview: false,
      marketplace: false,
      webfetch: false,
      liveConfigRefresh: false,
      updateChecker: false,
    });
    expect(Object.isFrozen(gates)).toBe(true);
    expect(Reflect.set(gates as object, 'tui', true)).toBe(false);
    expect(gates.tui).toBe(false);
  });
});
