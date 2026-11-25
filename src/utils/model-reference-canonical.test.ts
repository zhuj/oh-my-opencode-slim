import { describe, expect, test } from 'bun:test';
import { CouncillorConfigSchema } from '../config/council-schema';
import {
  AcpAgentsConfigSchema,
  AgentOverrideConfigSchema,
  ProviderModelIdSchema,
} from '../config/schema';
import { findModelMatches } from '../tools/resolve-model';
import { parseModelQuery } from '../tools/resolve-model-query';
import { parseModelRef } from '../v2/adapters';
import { parseModelReference } from './session';

describe('canonical model references', () => {
  test.each(['vendor/model:free', 'vendor/model:high', 'a:b/c:d:', 'model'])(
    'round-trips catalog identity %s through discovery and consumers',
    (modelID) => {
      const ref = `gateway/${modelID}`;

      const [match] = findModelMatches([ref], '');

      expect(match).toEqual({ provider: 'gateway', model: modelID, ref });
      expect(parseModelReference(ref)).toEqual({
        providerID: 'gateway',
        modelID,
      });
      expect(parseModelRef(ref)).toEqual({
        providerID: 'gateway',
        id: modelID,
      });
    },
  );

  test('separates provider and variant without changing nested model text', () => {
    const ref = 'gateway/vendor/model:free#high';

    const parsed = parseModelReference(ref);

    expect(parsed).toEqual({
      providerID: 'gateway',
      modelID: 'vendor/model:free',
      variant: 'high',
    });
    expect(ProviderModelIdSchema.safeParse(ref).success).toBe(true);
    expect(CouncillorConfigSchema.safeParse({ model: ref }).success).toBe(true);
  });

  test.each([
    'gateway$model',
    'gateway$vendor/model:free#high',
    'gateway/model$other',
    'model$other',
  ])('rejects removed dollar reference %s at each boundary', (ref) => {
    expect(parseModelReference(ref)).toBeNull();
    expect(parseModelQuery(ref)).toBeNull();
    expect(parseModelRef(ref)).toBeUndefined();
    expect(ProviderModelIdSchema.safeParse(ref).success).toBe(false);
    expect(CouncillorConfigSchema.safeParse({ model: ref }).success).toBe(
      false,
    );
    expect(findModelMatches(['gateway/model'], ref)).toEqual([]);
    expect(findModelMatches([ref], '')).toEqual([]);
  });

  test('keeps qualified colon suffixes literal even without a catalog match', () => {
    const query = 'gateway/model:high';

    const matches = findModelMatches(['gateway/model'], query);

    expect(matches).toEqual([]);
  });

  test.each([
    { model: 'gateway$model' },
    { model: ['gateway$model'] },
    { model: [{ id: 'gateway$model' }] },
  ])(
    'rejects removed references in agent and ACP configuration: %p',
    ({ model }) => {
      expect(AgentOverrideConfigSchema.safeParse({ model }).success).toBe(
        false,
      );
      if (typeof model === 'string') {
        expect(
          AcpAgentsConfigSchema.safeParse({
            worker: { command: 'fixture', wrapperModel: model },
          }).success,
        ).toBe(false);
      }
    },
  );

  test.each([
    'gateway/model#',
    'gateway/model##high',
    'gateway//model',
    'gateway/model/#high',
  ])(
    'rejects malformed canonical reference %s without adapter fallback',
    (ref) => {
      expect(parseModelReference(ref)).toBeNull();
      expect(parseModelRef(ref)).toBeUndefined();
    },
  );
});
