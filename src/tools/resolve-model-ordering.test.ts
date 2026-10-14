import { describe, expect, test } from 'bun:test';
import { findModelMatches } from './resolve-model';

describe('resolve_model priority ordering', () => {
  test.each([
    ['p/gpt-5.6', ['p/gpt-5-6', 'p/gpt-5.6'], ['p/gpt-5.6', 'p/gpt-5-6']],
    ['gpt-5.6', ['a/gpt-5-6', 'z/gpt-5.6'], ['z/gpt-5.6', 'a/gpt-5-6']],
    ['model', ['a/model', 'model/other'], ['model/other', 'a/model']],
    ['model', ['a/model-extra', 'z/model'], ['z/model', 'a/model-extra']],
    ['model', ['a/modeling', 'z/model-extra'], ['z/model-extra', 'a/modeling']],
    ['model', ['a/premodel', 'z/modeling'], ['z/modeling', 'a/premodel']],
    ['model', ['a/m-o-d-e-l', 'z/premodel'], ['z/premodel', 'a/m-o-d-e-l']],
    ['model', ['a/modex', 'z/m-o-d-e-l'], ['z/m-o-d-e-l', 'a/modex']],
  ])(
    'preserves target priority tiers for %s with %j',
    (query, candidates, expected) => {
      // Given competing candidates in different ranking tiers
      // When resolving against reversed candidate orders
      const result = [candidates, [...candidates].reverse()].map((source) =>
        findModelMatches(source, query).map(({ ref }) => ref),
      );
      // Then priority, not catalog insertion order, decides the result
      expect(result).toEqual([expected, expected]);
    },
  );

  test('uses substring position before lexical tie-breaking', () => {
    // Given substring matches at different positions
    const candidates = ['p/aaaaabc', 'p/zabc'];
    // When using a provider-scoped substring query
    const result = findModelMatches(candidates, 'p/abc');
    // Then the earlier substring wins despite its later lexical order
    expect(result.map(({ ref }) => ref)).toEqual(['p/zabc', 'p/aaaaabc']);
  });

  test('uses edit distance before lexical tie-breaking', () => {
    // Given equally eligible typo candidates with different distances
    const candidates = ['a/abxxefghij', 'z/abcdxfghij'];
    // When resolving a misspelled model
    const result = findModelMatches(candidates, 'abcdefghij');
    // Then the closest candidate wins
    expect(result.map(({ ref }) => ref)).toEqual([
      'z/abcdxfghij',
      'a/abxxefghij',
    ]);
  });

  test('keeps lexical ties rather than copying sibling insertion-order ties', () => {
    // Given equal-tier matches with different lengths
    const candidates = ['z/model-extra', 'a/model-much-longer'];
    // When searching for their shared token
    const result = findModelMatches(candidates, 'model');
    // Then the existing target tie policy remains stable
    expect(result.map(({ ref }) => ref)).toEqual([
      'a/model-much-longer',
      'z/model-extra',
    ]);
  });
});
