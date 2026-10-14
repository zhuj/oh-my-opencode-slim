import { describe, expect, test } from 'bun:test';
import type { PluginInput } from '@opencode-ai/plugin';
import { createOpencodeClient } from '@opencode-ai/sdk';
import { MODEL_MAPPINGS } from '../cli/providers';
import { parseModelReference } from '../utils/session';
import {
  createResolveModelTool,
  findModelMatches,
  getAvailableModels,
} from './resolve-model';

type RuntimeList = () => Promise<unknown>;

function createPluginInput(
  providerList: RuntimeList,
  modelList?: RuntimeList,
): PluginInput {
  const client = createOpencodeClient();
  Object.assign(client.provider, { list: providerList });
  if (modelList) {
    Object.assign(client, { model: { list: modelList } });
  }

  return {
    client,
    project: {
      id: 'test-project',
      worktree: '/workspace',
      time: { created: 0 },
    },
    directory: '/workspace',
    worktree: '/workspace',
    experimental_workspace: { register() {} },
    serverUrl: new URL('http://127.0.0.1'),
    $: Bun.$,
  };
}

function runtimeProviderResponse(modelIDs: readonly string[]) {
  return {
    data: {
      all: [
        {
          id: 'custom-router',
          name: 'Custom Router',
          env: [],
          models: Object.fromEntries(
            modelIDs.map((modelID) => [
              modelID,
              {
                id: modelID,
                name: modelID,
                release_date: '2026-01-01',
                attachment: false,
                reasoning: false,
                temperature: false,
                tool_call: false,
                limit: { context: 128_000, output: 4_096 },
                options: {},
              },
            ]),
          ),
        },
      ],
      default: {},
      connected: ['custom-router'],
    },
  };
}

function runtimeModelResponse(
  models: readonly { readonly providerID: string; readonly id: string }[],
) {
  return { data: models };
}

describe('resolve_model candidate discovery', () => {
  test('discovers a runtime-only nested literal model ID', async () => {
    // Given a connected runtime provider with a model absent from all presets
    const context = createPluginInput(() =>
      Promise.resolve(runtimeProviderResponse(['vendor/inkling-small:free'])),
    );

    // When collecting candidates from the runtime
    const candidates = await getAvailableModels(context);

    // Then the literal provider/model identity is available to the matcher
    expect(candidates).toContain('custom-router/vendor/inkling-small:free');
  });

  test('preserves nested literal suffixes in runtime match references', async () => {
    // Given a runtime catalog entry whose nested model ID ends in :free
    const context = createPluginInput(() =>
      Promise.resolve(runtimeProviderResponse(['vendor/inkling-small:free'])),
    );

    // When resolving the runtime candidate by its complete reference
    const candidates = await getAvailableModels(context);
    const [match] = findModelMatches(
      candidates,
      'custom-router/vendor/inkling-small:free',
    );

    // Then the matcher preserves the literal nested model ID in every ref form
    expect(match).toEqual({
      provider: 'custom-router',
      model: 'vendor/inkling-small:free',
      ref: 'custom-router/vendor/inkling-small:free',
    });
  });

  test('returns runtime candidates through the matches output contract', async () => {
    // Given a runtime-only literal model exposed through the tool factory
    const context = createPluginInput(() =>
      Promise.resolve(runtimeProviderResponse(['vendor/inkling-small:free'])),
    );
    const { resolve_model } = createResolveModelTool(context);

    // When resolving the complete runtime reference through the tool
    const output = await resolve_model.execute(
      { query: 'custom-router/vendor/inkling-small:free' },
      {} as never,
    );

    // Then the established JSON envelope contains the runtime match
    if (typeof output !== 'string') {
      throw new TypeError('Expected resolve_model to return JSON text');
    }
    expect(JSON.parse(output)).toEqual({
      matches: [
        {
          provider: 'custom-router',
          model: 'vendor/inkling-small:free',
          ref: 'custom-router/vendor/inkling-small:free',
        },
      ],
    });
  });

  test('prefers successful runtime candidates over preset candidates', async () => {
    // Given a successful runtime catalog that does not include preset models
    const context = createPluginInput(() =>
      Promise.resolve(runtimeProviderResponse(['vendor/inkling-small:free'])),
    );

    // When collecting candidates
    const candidates = await getAvailableModels(context);

    // Then runtime availability is authoritative for the candidate list
    expect(candidates).toEqual(['custom-router/vendor/inkling-small:free']);
  });

  test('does not resurrect presets when runtime discovery succeeds empty', async () => {
    // Given an authoritative runtime catalog with no available models
    const context = createPluginInput(() =>
      Promise.resolve(runtimeProviderResponse([])),
    );

    // When collecting candidates
    const candidates = await getAvailableModels(context);

    // Then an authoritative empty result remains empty
    expect(candidates).toEqual([]);
  });

  test('falls back to all preset models when runtime discovery is unavailable', async () => {
    // Given static presets containing repeated models with different variants
    const expected = new Set(
      Object.values(MODEL_MAPPINGS).flatMap((mapping) =>
        Object.values(mapping).map(({ model }) => model),
      ),
    );
    // When both runtime discovery sources are unavailable
    const unavailableRuntime = () =>
      Promise.reject(new Error('runtime discovery unavailable'));
    const context = createPluginInput(unavailableRuntime, unavailableRuntime);
    const candidates = await getAvailableModels(context);

    // Then the source contains exactly the unique static model identities
    expect(candidates).toHaveLength(expected.size);
    expect(new Set(candidates)).toEqual(expected);
  });

  test('discovers runtime-only candidates from an async model list', async () => {
    // Given an unavailable provider source and a valid asynchronous model list
    const context = createPluginInput(
      () => Promise.reject(new Error('provider source unavailable')),
      () =>
        Promise.resolve(
          runtimeModelResponse([
            {
              providerID: 'custom-router',
              id: 'vendor/inkling-small:free',
            },
          ]),
        ),
    );

    // When collecting candidates from the available runtime source
    const candidates = await getAvailableModels(context);

    // Then the asynchronous source supplies the literal model identity
    expect(candidates).toEqual(['custom-router/vendor/inkling-small:free']);
  });

  test('falls back to preset models for a malformed runtime response', async () => {
    // Given a runtime response that cannot describe a provider model catalog
    const context = createPluginInput(() =>
      Promise.resolve({
        data: { all: [{ id: 'custom-router', models: null }] },
      }),
    );
    const expected = new Set(
      Object.values(MODEL_MAPPINGS).flatMap((mapping) =>
        Object.values(mapping).map(({ model }) => model),
      ),
    );

    // When collecting candidates
    const candidates = await getAvailableModels(context);

    // Then malformed runtime data uses the static fallback
    expect(new Set(candidates)).toEqual(expected);
  });

  test('falls back to preset models for a rejected runtime response', async () => {
    // Given both runtime discovery sources reject their requests
    const unavailableRuntime = () =>
      Promise.reject(new Error('runtime discovery unavailable'));
    const context = createPluginInput(unavailableRuntime, unavailableRuntime);
    const expected = new Set(
      Object.values(MODEL_MAPPINGS).flatMap((mapping) =>
        Object.values(mapping).map(({ model }) => model),
      ),
    );

    // When collecting candidates
    const candidates = await getAvailableModels(context);

    // Then rejected runtime data uses the static fallback
    expect(new Set(candidates)).toEqual(expected);
  });

  test('emits round-trippable references for every static fallback model', async () => {
    // Given the actual static candidate source after runtime discovery is rejected
    const unavailableRuntime = () =>
      Promise.reject(new Error('runtime discovery unavailable'));
    const context = createPluginInput(unavailableRuntime, unavailableRuntime);
    const candidates = await getAvailableModels(context);

    // When resolving all models
    const matches = findModelMatches(candidates, '');
    // Then executable references retain structured provider/model identity
    for (const match of matches) {
      expect(parseModelReference(match.ref)).toEqual({
        providerID: match.provider,
        modelID: match.model,
      });
    }
  });

  test('deduplicates compatibility-normalized identities deterministically', () => {
    // Given mixed-case and Unicode-equivalent duplicates
    const candidates = ['p/model', 'P/MODEL', 'ｐ/model', 'p/model'];
    // When resolving both source orders
    const result = [candidates, [...candidates].reverse()].map((source) =>
      findModelMatches(source, '').map(({ ref }) => ref),
    );
    // Then one stable original catalog spelling survives
    expect(result).toEqual([['P/MODEL'], ['P/MODEL']]);
  });

  test('applies the empty-query cap after lexical sorting and deduplication', () => {
    // Given more than 20 unique entries and duplicates in reverse order
    const unique = Array.from(
      { length: 25 },
      (_, i) => `p/model-${String(i).padStart(2, '0')}`,
    );
    // When enumerating an unordered catalog
    const result = findModelMatches([...unique, ...unique].reverse(), ' ');
    // Then the first 20 unique identities are returned
    expect(result.map(({ ref }) => ref)).toEqual(unique.slice(0, 20));
  });

  test('ranks a late exact match before applying the cap', () => {
    // Given token matches that sort before the exact model
    const candidates = Array.from(
      { length: 25 },
      (_, i) => `a/model-extra-${i}`,
    );
    candidates.push('z/model');
    // When searching a capped catalog
    const result = findModelMatches(candidates, 'model');
    // Then the strongest match is not lost to early truncation
    expect(result).toHaveLength(20);
    expect(result[0]?.ref).toBe('z/model');
  });

  test('does not collapse distinct provider scopes by removing punctuation', () => {
    // Given providers whose compact spellings collide
    const candidates = ['open-ai/model', 'openai/model'];
    // When an explicit provider is supplied
    const result = findModelMatches(candidates, 'open-ai/model');
    // Then only that provider is eligible
    expect(result.map(({ ref }) => ref)).toEqual(['open-ai/model']);
  });
});
