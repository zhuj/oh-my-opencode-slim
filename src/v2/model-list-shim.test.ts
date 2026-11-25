import { describe, expect, test } from 'bun:test';
import { createResolveModelTool } from '../tools/resolve-model';
import { isRecord } from '../utils/guards';
import { buildPluginInput } from './client-shim';
import {
  createLiveModelListShim,
  createModelListSnapshot,
  rowsFromModelInfoList,
} from './model-list-shim';
import type { V2Context } from './types';

type TestV2Context = V2Context;

type ModelListMethod = (input?: unknown) => Promise<unknown>;

async function* emptyEvents(): AsyncGenerator<Record<string, unknown>> {}

function makeContext(): TestV2Context {
  const registration = { dispose() {} };
  return {
    app: { name: 'opencode2', version: 'test' },
    options: {},
    location: {
      directory: '/workspace',
      workspaceID: 'workspace-1',
      project: {
        id: 'project-1',
        directory: '/workspace',
        canonical: '/workspace',
      },
    },
    agent: {
      transform: async () => registration,
      reload: async () => {},
      list: async () => [],
    },
    tool: {
      transform: async () => registration,
      hook: async () => registration,
    },
    command: {
      transform: async () => registration,
      list: async () => [],
    },
    session: {
      hook: async () => registration,
    },
    event: {
      subscribe: emptyEvents,
    },
  };
}

function draftFor(records: unknown[]): { provider: { list: () => unknown[] } } {
  return { provider: { list: () => records } };
}

function getModelList(
  input: Record<string, unknown>,
): ModelListMethod | undefined {
  const client = input.client;
  if (!isRecord(client) || !isRecord(client.model)) return undefined;
  const list = client.model.list;
  return typeof list === 'function' ? list : undefined;
}

describe('v2 catalog model-list shim', () => {
  test('omits model.list when no catalog snapshot is passed', () => {
    // Given a v2 context without a captured native model-domain snapshot
    const input = buildPluginInput(makeContext());

    // When inspecting the v1 client model surface
    const list = getModelList(input);

    // Then absence is observable instead of a callable fake list
    expect(list).toBeUndefined();
  });

  test('prefers the filtered v2.4 model draft over provider templates', () => {
    const snapshot = createModelListSnapshot();
    snapshot.capture({
      provider: {
        list: () => [
          {
            provider: { id: 'inactive-template' },
            models: new Map([['template-model', { enabled: true }]]),
          },
        ],
      },
      list: () => [
        {
          providerID: 'connected',
          modelID: 'nested/model:free',
          enabled: true,
        },
        { providerID: 'connected', modelID: 'disabled', enabled: false },
      ],
    });
    expect(snapshot.rows()).toEqual([
      { provider: 'connected', id: 'nested/model:free' },
    ]);
    snapshot.capture({
      provider: {
        list: () => {
          throw new Error('Provider template lookup');
        },
      },
      list: () => [],
    });
    expect(snapshot.rows()).toEqual([]);
  });

  test('maps native ModelEditor draft rows to provider and executable model id', async () => {
    // Given captured ModelEditor draft rows (ctx.model.transform) with
    // 2.0.10+-realistic provider/model fields
    const snapshot = createModelListSnapshot();
    snapshot.capture(
      draftFor([
        {
          provider: {
            id: 'openrouter',
            name: 'OpenRouter',
            activation: 'auto',
          },
          models: new Map([
            [
              'openai/gpt-5.6-sol:free',
              {
                id: 'gpt-5.6-sol',
                modelID: 'gpt-5.6-sol',
                providerID: 'openrouter',
                enabled: true,
              },
            ],
            [
              'claude-sonnet',
              {
                id: 'claude-3-7-sonnet',
                modelID: 'claude-3-7-sonnet',
                providerID: 'anthropic',
                enabled: true,
              },
            ],
          ]),
        },
      ]),
    );
    const input = buildPluginInput(makeContext(), undefined, snapshot);

    // When the v1-compatible model list is called
    const list = getModelList(input);
    expect(typeof list).toBe('function');
    if (typeof list !== 'function') return;
    const result = await list();

    // Then it exposes only the provider and executable id fields
    expect(result).toEqual({
      data: [
        { provider: 'openrouter', id: 'openai/gpt-5.6-sol:free' },
        { provider: 'openrouter', id: 'claude-sonnet' },
      ],
    });
  });

  test('keeps literal per-model suffix ids verbatim via map key', async () => {
    // Given a map key carrying a literal per-model suffix
    const snapshot = createModelListSnapshot();
    snapshot.capture(
      draftFor([
        {
          provider: { id: 'custom-router', name: 'Custom Router' },
          models: new Map([['vendor/inkling-small:free', { enabled: true }]]),
        },
      ]),
    );
    const input = buildPluginInput(makeContext(), undefined, snapshot);

    // When the v1-compatible model list is called
    const list = getModelList(input);
    expect(typeof list).toBe('function');
    if (typeof list !== 'function') return;
    const result = await list();

    // Then the map key is returned verbatim, never stripped or normalized
    expect(result).toEqual({
      data: [{ provider: 'custom-router', id: 'vendor/inkling-small:free' }],
    });
  });

  test('accepts the flat ProviderEditor draft shape via draft.list', async () => {
    // Given a captured ctx.provider.transform draft whose records come from
    // the flat `list()` method (ProviderEditor shape — no nested provider)
    const snapshot = createModelListSnapshot();
    snapshot.capture({
      list: () => [
        {
          provider: {
            id: 'openrouter',
            name: 'OpenRouter',
            activation: 'auto',
          },
          models: new Map([['openai/gpt-5.6-sol:free', { enabled: true }]]),
        },
      ],
    });
    const input = buildPluginInput(makeContext(), undefined, snapshot);

    // When the v1-compatible model list is called
    const list = getModelList(input);
    expect(typeof list).toBe('function');
    if (typeof list !== 'function') return;
    const result = await list();

    // Then the same provider/model rows are served
    expect(result).toEqual({
      data: [{ provider: 'openrouter', id: 'openai/gpt-5.6-sol:free' }],
    });
  });

  test('excludes disabled models and disabled providers', async () => {
    // Given enabled, implicitly enabled, and disabled models plus disabled
    // providers — both the 2.0.10+ `activation: 'disabled'` signal and the
    // older boolean `disabled` flag
    const snapshot = createModelListSnapshot();
    snapshot.capture(
      draftFor([
        {
          provider: { id: 'p', name: 'P', activation: 'auto' },
          models: new Map([
            ['enabled', { enabled: true, id: 'enabled', providerID: 'p' }],
            ['implicit-enabled', {}],
            ['disabled', { enabled: false, id: 'disabled', providerID: 'p' }],
          ]),
        },
        {
          provider: { id: 'off-legacy', name: 'Off', disabled: true },
          models: new Map([['model', { enabled: true }]]),
        },
        {
          provider: { id: 'off', name: 'Off 2', activation: 'disabled' },
          models: new Map([['model', { enabled: true }]]),
        },
      ]),
    );
    const input = buildPluginInput(makeContext(), undefined, snapshot);

    // When the v1-compatible model list is called
    const list = getModelList(input);
    expect(typeof list).toBe('function');
    if (typeof list !== 'function') return;
    const result = await list();

    // Then disabled rows are absent while enabled rows remain
    expect(result).toEqual({
      data: [
        { provider: 'p', id: 'enabled' },
        { provider: 'p', id: 'implicit-enabled' },
      ],
    });
  });

  test('treats a malformed draft as unavailable', async () => {
    // Given a draft without any provider list capability
    const snapshot = createModelListSnapshot();
    snapshot.capture({ providerID: 'p', id: 'model' });
    const input = buildPluginInput(makeContext(), undefined, snapshot);

    // When the v1-compatible model list is called
    const list = getModelList(input);
    expect(typeof list).toBe('function');
    if (typeof list !== 'function') return;
    const result = await list();

    // Then callers receive an unavailable response, not a fake empty catalog
    expect(result).toBeUndefined();
  });

  test('draft whose record lacks provider id is unavailable', async () => {
    // Given a record whose provider carries no id
    const snapshot = createModelListSnapshot();
    snapshot.capture(
      draftFor([{ provider: {}, models: new Map([['m', {}]]) }]),
    );
    const input = buildPluginInput(makeContext(), undefined, snapshot);

    // When the v1-compatible model list is called
    const list = getModelList(input);
    expect(typeof list).toBe('function');
    if (typeof list !== 'function') return;
    const result = await list();

    // Then callers receive an unavailable response, not a partial row
    expect(result).toBeUndefined();
  });

  test('keeps a valid empty catalog authoritative', async () => {
    // Given a captured native model-domain draft with zero providers
    const snapshot = createModelListSnapshot();
    snapshot.capture(draftFor([]));
    const input = buildPluginInput(makeContext(), undefined, snapshot);

    // When the v1-compatible model list is called
    const list = getModelList(input);
    expect(typeof list).toBe('function');
    if (typeof list !== 'function') return;
    const result = await list();

    // Then empty is a successful authoritative result
    expect(result).toEqual({ data: [] });
  });

  test('feeds the shared resolver through the v2 plugin-input bridge', async () => {
    // Given a v2 model domain containing the runtime-only literal model
    const snapshot = createModelListSnapshot();
    snapshot.capture(
      draftFor([
        {
          provider: { id: 'custom-router', name: 'Custom Router' },
          models: new Map([
            [
              'vendor/inkling-small:free',
              {
                enabled: true,
                id: 'inkling-small',
                modelID: 'inkling-small',
                providerID: 'custom-router',
              },
            ],
          ]),
        },
      ]),
    );
    const input = buildPluginInput(makeContext(), undefined, snapshot);
    const { resolve_model } = createResolveModelTool(input as never);

    // When the v1-compatible resolver is called through the v2 input
    const output = await resolve_model.execute(
      { query: 'inkling-small:free' },
      {} as never,
    );

    // Then the shared tool resolves the v2 runtime candidate verbatim
    if (typeof output !== 'string') {
      throw new TypeError('Expected resolve_model to return JSON text');
    }
    expect(JSON.parse(output).matches[0]?.ref).toBe(
      'custom-router/vendor/inkling-small:free',
    );
  });

  test('rowsFromModelInfoList maps ModelInfo rows via providerID/modelID', () => {
    // Given a live ModelInfo-like array (host-filters applied)
    const rows = rowsFromModelInfoList([
      {
        id: 'openrouter/thinkingmachines/inkling-small:free',
        modelID: 'thinkingmachines/inkling-small:free',
        providerID: 'openrouter',
        enabled: true,
      },
      {
        id: 'kilo/thinkingmachines/inkling-small:free',
        modelID: 'thinkingmachines/inkling-small:free',
        providerID: 'kilo',
        enabled: true,
      },
    ]);

    // Then refs are `${providerID}/${modelID}` with literal `:free` kept
    expect(rows).toEqual([
      {
        provider: 'openrouter',
        id: 'thinkingmachines/inkling-small:free',
      },
      { provider: 'kilo', id: 'thinkingmachines/inkling-small:free' },
    ]);
  });

  test('preserves full context limits from draft and live model rows', () => {
    const snapshot = createModelListSnapshot();
    snapshot.capture(
      draftFor([
        {
          provider: { id: 'p' },
          models: new Map([['m', { limit: { context: 32768, output: 4096 } }]]),
        },
      ]),
    );
    expect(snapshot.rows()).toEqual([
      { provider: 'p', id: 'm', limit: { context: 32768 } },
    ]);
    expect(
      rowsFromModelInfoList([
        { providerID: 'p', modelID: 'm', limit: { context: 65536 } },
      ]),
    ).toEqual([{ provider: 'p', id: 'm', limit: { context: 65536 } }]);
  });

  test('rowsFromModelInfoList skips bad rows and rejects non-arrays', () => {
    // Given elements missing providerID/modelID plus a non-array payload
    const rows = rowsFromModelInfoList([
      { id: 'only-id', modelID: 'm', enabled: true },
      { providerID: 'p', id: 'only-id', enabled: true },
      { providerID: 'p', modelID: 'ok', enabled: true },
      42,
      null,
    ]);

    // Then only fully-shaped rows survive, and a non-array is unavailable
    expect(rows).toEqual([{ provider: 'p', id: 'ok' }]);
    expect(
      rowsFromModelInfoList([{ providerID: 'p', id: 'missing' }]),
    ).toBeUndefined();
    expect(rowsFromModelInfoList('not-an-array')).toBeUndefined();
    expect(rowsFromModelInfoList(undefined)).toBeUndefined();
  });

  test('createLiveModelListShim serves the live snapshot when present', async () => {
    // Given a working live ctx.model.list() plus a captured draft snapshot
    const snapshot = createModelListSnapshot();
    snapshot.capture(
      draftFor([
        {
          provider: { id: 'p' },
          models: new Map([['snapshot-model', { enabled: true }]]),
        },
      ]),
    );
    const shim = createLiveModelListShim(
      async () => ({
        location: { directory: '/workspace' },
        data: [
          {
            id: 'p/live-model',
            modelID: 'live-model',
            providerID: 'p',
            enabled: true,
          },
        ],
      }),
      snapshot,
    );

    // When called, the fresh live rows win over the snapshot
    const result = await shim();
    expect(result).toEqual({ data: [{ provider: 'p', id: 'live-model' }] });
  });

  test('createLiveModelListShim falls back to the snapshot when live rejects', async () => {
    // Given a live ctx.model.list() that rejects + a captured snapshot
    const snapshot = createModelListSnapshot();
    snapshot.capture(
      draftFor([
        {
          provider: { id: 'p' },
          models: new Map([['snapshot-model', { enabled: true }]]),
        },
      ]),
    );
    const shim = createLiveModelListShim(async () => {
      throw new Error('model list unavailable');
    }, snapshot);

    // When called, the rejection degrades to the snapshot rows
    const result = await shim();
    expect(result).toEqual({
      data: [{ provider: 'p', id: 'snapshot-model' }],
    });
  });

  test('createLiveModelListShim falls back on malformed live data, but honors empty', async () => {
    // Given a live payload that is not an array (malformed → fallback)
    const snapshot = createModelListSnapshot();
    snapshot.capture(
      draftFor([
        {
          provider: { id: 'p' },
          models: new Map([['snapshot-model', { enabled: true }]]),
        },
      ]),
    );
    const malformedShim = createLiveModelListShim(
      async () => ({ location: {}, data: 'not-an-array' }),
      snapshot,
    );
    expect(await malformedShim()).toEqual({
      data: [{ provider: 'p', id: 'snapshot-model' }],
    });

    // Given a live payload with an EMPTY catalog — authoritative answer
    const emptyShim = createLiveModelListShim(
      async () => ({ location: {}, data: [] }),
      snapshot,
    );
    expect(await emptyShim()).toEqual({ data: [] });
  });
});
