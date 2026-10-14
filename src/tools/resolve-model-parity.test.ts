import { describe, expect, test } from 'bun:test';
import { findModelMatches } from './resolve-model';

const refs = (candidates: readonly string[], query: string) =>
  findModelMatches(candidates, query).map(({ ref }) => ref);

describe('resolve_model sibling parity', () => {
  test.each(['something:max', 'something high', 'something(custom)'])(
    'prefers a nested literal catalog identity for %s',
    (query) => {
      // Given a base model and a dedicated nested catalog identity
      const candidates = ['a/something', `z/vendor/${query}`];
      // When resolving a suffix-bearing query
      const result = refs(candidates, query);
      // Then catalog identity wins over runtime-variant interpretation
      expect(result[0]).toBe(`z/vendor/${query}`);
    },
  );

  test('prefers separator-equivalent catalog suffixes before base models', () => {
    // Given a normalized literal suffix and an exact base spelling
    const candidates = ['p/gpt-5.6', 'p/gpt-5-6:max'];
    // When using the dotted catalog spelling
    const result = refs(candidates, 'p/gpt-5.6:max');
    // Then normalization does not downgrade the literal suffix
    expect(result[0]).toBe('p/gpt-5-6:max');
  });

  test.each(['p/something:max', 'p/something:max#low'])(
    'does not reinterpret literal colon text in %s',
    (query) => {
      // Given no literal catalog match
      const candidates = ['p/something'];
      // When qualified syntax preserves the model suffix
      const result = refs(candidates, query);
      // Then it is not treated as a runtime variant
      expect(result).toEqual([]);
    },
  );

  test('recognizes custom parenthesized variants', () => {
    // Given a base model and sibling-supported custom variant syntax
    const candidates = ['p/something'];
    // When resolving the parenthesized form
    const result = refs(candidates, 'something(custom-effort)');
    // Then only the model identity is returned
    expect(result).toEqual(['p/something']);
  });

  test.each([
    'p//something',
    'p/something/',
    'p/something#high/extra',
    'p/something#',
    'p/something#high#low',
    'p@bad/something',
  ])('rejects malformed reference %s without fuzzy fallback', (query) => {
    // Given a nearby valid candidate
    const candidates = ['p/something'];
    // When resolving a malformed reference
    const result = refs(candidates, query);
    // Then invalid syntax cannot select a model
    expect(result).toEqual([]);
  });

  test('validates candidate identities before emitting executable references', () => {
    // Given invalid catalog rows mixed with one lossless nested identity
    const candidates = [
      'p//model',
      'p/model/',
      'p$/model',
      'p/model#high',
      'p/model$other',
      ' p/model',
      'p/ model',
      'p/model ',
      'p/vendor/model:free',
      'p/vendor/model:free',
    ];
    // When enumerating the catalog
    const result = refs(candidates, '');
    // Then malformed identities are excluded and duplicates collapse
    expect(result).toEqual(['p/vendor/model:free']);
  });

  test('ranks a complete nested model suffix ahead of a token-only match', () => {
    // Given an early lexical token match and a nested exact identity
    const candidates = ['a/inkling:free-preview', 'z/vendor/inkling:free'];
    // When searching without the vendor namespace
    const result = refs(candidates, 'inkling:free');
    // Then nested exact matching has priority
    expect(result[0]).toBe('z/vendor/inkling:free');
  });

  test('never lets another provider change a qualified model identity', () => {
    // Given the literal suffix exists only outside the requested provider
    const candidates = ['other/something:max', 'p/something'];
    // When resolving a provider-scoped literal model suffix
    const result = refs(candidates, 'p/something:max');
    // Then no different model or provider is substituted
    expect(result).toEqual([]);
  });

  test.each([
    ['gemini-3-pro-high', 'google/gemini-3-pro-preview'],
    ['gemini-3-pro-low', 'google/gemini-3-pro-preview'],
    ['gemini-3.1-pro-high', 'google/gemini-3.1-pro'],
    ['claude-opus-4-7-thinking', 'anthropic/claude-opus-4-7'],
  ])('resolves the sibling bare-name alias %s', (query, candidate) => {
    // Given only the canonical candidate
    // When resolving an established sibling alias
    const result = refs([candidate], query);
    // Then the real catalog identity is returned, not an invented alias
    expect(result).toEqual([candidate]);
  });

  test('keeps literal catalog aliases ahead of canonical alias targets', () => {
    // Given both an alias spelling and its canonical target in the catalog
    const candidates = ['a/gemini-3-pro-preview', 'z/gemini-3-pro-high'];
    // When resolving the literal spelling
    const result = refs(candidates, 'gemini-3-pro-high');
    // Then the catalog remains authoritative
    expect(result[0]).toBe('z/gemini-3-pro-high');
  });
});
