import { describe, expect, test } from 'bun:test';
import {
  normalizeModelName,
  stripKnownVariant,
} from './find-model-normalization';
import { findModelMatches } from './resolve-model';
import { parseModelQuery, resolveBareModelAlias } from './resolve-model-query';

describe('discovery suffix classification', () => {
  test.each([
    'off',
    'low',
    'medium',
    'high',
    'xhigh',
    'max',
    'minimal',
    'none',
    'auto',
    'thinking',
  ])('recognizes %s in colon, space and parenthesized forms', (variant) => {
    // Given all sibling-recognized runtime variant spellings
    const inputs = [
      `model:${variant.toUpperCase()}`,
      `model ${variant}`,
      `model(${variant})`,
    ];
    // When classifying the suffixes
    const result = inputs.map(stripKnownVariant);
    // Then only the trailing variant is removed
    expect(result).toEqual(['model', 'model', 'model']);
  });

  test.each([
    'model:free',
    'model custom',
    'model-fast',
    'model()',
    'model( )',
  ])('preserves literal suffix %s', (input) => {
    // Given a suffix outside the runtime vocabulary
    // When classifying it
    const result = stripKnownVariant(input);
    // Then the model identity is unchanged
    expect(result).toBe(input);
  });

  test.each([
    ['model:free:max', 'model:free'],
    ['model:low(high)', 'model:low'],
    ['model high(custom)', 'model high'],
  ])('removes only the final variant from %s', (input, expected) => {
    // Given stacked suffix text
    // When classifying the outermost variant
    const result = stripKnownVariant(input);
    // Then earlier suffix text remains literal
    expect(result).toBe(expected);
  });

  test.each([
    ['p/model:low#high', 'model:low'],
    ['p/model(high)', 'model(high)'],
    ['p/model:free#max', 'model:free'],
    ['model#custom', 'model'],
  ])('preserves canonical model text in %s', (input, expected) => {
    // Given canonical slash/hash syntax
    // When parsing a discovery query
    const result = parseModelQuery(input);
    // Then legacy variant hints are not stripped inside canonical model text
    expect(result?.baseModelID).toBe(expected);
  });

  test.each([
    '$model',
    'p$',
    '#max',
    'p$#max',
    'p$$model',
    'model##max',
    'model#max$p',
    '/model',
  ])('rejects target-invalid reference %s', (input) => {
    // Given malformed structural delimiters
    // When parsing the query
    const result = parseModelQuery(input);
    // Then no fallback parser accepts it
    expect(result).toBeNull();
  });
  test('preserves provider scope when a hash variant is present', () => {
    // Given a provider-scoped model with a hash variant
    // When resolving against two providers with the same model ID
    const result = findModelMatches(['p/model', 'other/model'], 'p/model#high');
    // Then the slash provider is preserved and the other provider is excluded
    expect(result.map(({ ref }) => ref)).toEqual(['p/model']);
  });
});

describe('model name normalization', () => {
  test.each([
    ['claude-opus-4-7', 'claude-opus-4.7'],
    ['claude-sonnet-4-6', 'claude-sonnet-4.6'],
    ['claude-haiku-4-5', 'claude-haiku-4.5'],
    ['kimi-k2-6', 'kimi-k2.6'],
    ['glm-5-1', 'glm-5.1'],
    ['gpt-5-6-sol', 'gpt-5.6-sol'],
  ])('normalizes %s symmetrically', (dashed, dotted) => {
    // Given both catalog separator forms
    // When canonicalizing them
    const result = [dashed, dotted].map(normalizeModelName);
    // Then they share a canonical spelling
    expect(result).toEqual([dotted, dotted]);
  });

  test.each([
    'constructor',
    'k2pb',
    'claude-opus-4-6-thinking',
    'claude-opus-4-7-think',
    'gemini-3.1-pro-preview',
    'gpt-5.6-sol-fast',
  ])('does not invent a resolver alias for %s', (input) => {
    // Given canonical, discontinued or capability-only aliases
    // When applying the sibling bare-name resolver policy
    const result = resolveBareModelAlias(input);
    // Then unrelated model identities stay unchanged
    expect(result).toBe(input);
  });
});
