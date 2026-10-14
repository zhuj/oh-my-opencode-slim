import { describe, expect, test } from 'bun:test';
import { findModelMatches } from '../tools/resolve-model';
import { parseModelReference } from './session';

describe('model reference consumer compatibility', () => {
  test.each([
    [
      'p/a/b:c:d#high',
      { providerID: 'p', modelID: 'a/b:c:d', variant: 'high' },
    ],
    [
      'p/a/b:free#max',
      { providerID: 'p', modelID: 'a/b:free', variant: 'max' },
    ],
    [
      'p/model:low#high',
      { providerID: 'p', modelID: 'model:low', variant: 'high' },
    ],
    ['p/model(high)', { providerID: 'p', modelID: 'model(high)' }],
  ] as const)(
    'preserves canonical structured parsing for %s',
    (input, expected) => {
      // Given a canonical executable reference
      // When parsing at the shared routing boundary
      const result = parseModelReference(input);
      // Then nested model text and variant identity remain separate
      expect(result).toEqual(expected);
    },
  );

  test('preserves arbitrary hash variants for routing consumers', () => {
    // Given an executable reference, not a discovery query
    // When using the shared parser rather than the catalog-aware search parser
    const result = parseModelReference('p/model#custom');
    // Then existing consumers keep their unrestricted variant contract
    expect(result).toEqual({
      providerID: 'p',
      modelID: 'model',
      variant: 'custom',
    });
  });
});
