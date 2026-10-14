/// <reference types="bun-types" />

import { describe, expect, test } from 'bun:test';
import { createResolveModelTool, findModelMatches } from './resolve-model';

const CANDIDATES = [
  'openai/gpt-5.6-sol',
  'openai/gpt-5.6-terra',
  'openai/gpt-5.6-luna',
  'github-copilot/claude-opus-4.6',
  'anthropic/claude/sonnet-4.6',
  'opencode-go/qwen3.7-max',
] as const;

function matchRefs(candidates: readonly string[], query: string): string[] {
  return findModelMatches(candidates, query).map(({ ref }) => ref);
}

describe('resolve_model', () => {
  test('matches a model when the query has mixed case and surrounding whitespace', async () => {
    // Given
    const { resolve_model } = createResolveModelTool({} as never);

    // When
    const output = await resolve_model.execute(
      { query: '  GPT-6-SOL  ' },
      {} as never,
    );

    // Then
    if (typeof output !== 'string') {
      throw new TypeError('Expected resolve_model to return JSON text');
    }
    expect(JSON.parse(output).matches[0]).toEqual({
      provider: 'openai',
      model: 'gpt-6-sol',
      ref: 'openai/gpt-6-sol',
    });
  });

  test('normalizes Unicode compatibility characters', () => {
    // Given
    const query = 'ＧＰＴ－５．６－ＳＯＬ';

    // When
    const matches = matchRefs(CANDIDATES, query);

    // Then
    expect(matches).toEqual(['openai/gpt-5.6-sol']);
  });

  test('ranks exact provider and model matches ahead of token matches', () => {
    // Given
    const candidates = [
      'other/openai-sol',
      'openai/gpt-sol',
      'vendor/sol',
      'openai/sol',
    ];

    // When
    const modelMatches = matchRefs(candidates, 'sol');
    const providerMatches = matchRefs(candidates, 'openai');

    // Then
    expect(modelMatches).toEqual([
      'openai/sol',
      'vendor/sol',
      'openai/gpt-sol',
      'other/openai-sol',
    ]);
    expect(providerMatches).toEqual([
      'openai/gpt-sol',
      'openai/sol',
      'other/openai-sol',
    ]);
  });

  test('constrains an explicit provider and splits a nested model on the first slash', () => {
    // Given
    const candidates = [
      ...CANDIDATES,
      'other/claude/sonnet-4.6',
      'openai/claude/sonnet-4.6',
    ];

    // When
    const matches = findModelMatches(
      candidates,
      '  ANTHROPIC / CLAUDE/SONNET-4.6  ',
    );

    // Then
    expect(matches).toEqual([
      {
        provider: 'anthropic',
        model: 'claude/sonnet-4.6',
        ref: 'anthropic/claude/sonnet-4.6',
      },
    ]);
  });

  test('preserves colon-bearing catalogue model identities', () => {
    // Given
    const candidate = 'openrouter/vendor/model:free';

    // When
    const [match] = findModelMatches(
      [candidate],
      'openrouter/vendor/model:free',
    );

    // Then
    expect(match).toEqual({
      provider: 'openrouter',
      model: 'vendor/model:free',
      ref: candidate,
    });
  });

  test('matches canonical executable references with optional variants', () => {
    // Given
    const qualifiedQuery = 'openai/gpt-5.6-sol';
    const explicitQuery = '  OPENAI/GPT-5.6-SOL#HIGH  ';
    const providerlessExplicitQuery = 'gpt-5.6-sol#HIGH';

    // When
    const qualifiedMatches = matchRefs(CANDIDATES, qualifiedQuery);
    const explicitMatches = matchRefs(CANDIDATES, explicitQuery);
    const providerlessMatches = matchRefs(
      CANDIDATES,
      providerlessExplicitQuery,
    );

    // Then
    expect(qualifiedMatches).toEqual(['openai/gpt-5.6-sol']);
    expect(explicitMatches).toEqual(qualifiedMatches);
    expect(providerlessMatches).toEqual(qualifiedMatches);
  });

  test('ignores recognized inline variants without hiding catalog model IDs', () => {
    // Given a catalog model with a literal colon suffix and a base model
    const candidates = ['openai/gpt-5.6-sol', 'openrouter/vendor/model:free'];

    // When executable variant forms are used in the query
    const baseMatches = matchRefs(candidates, 'openai/gpt-5.6-sol#max');
    const literalMatches = matchRefs(
      candidates,
      'openrouter/vendor/model:free',
    );

    // Then recognized variants resolve to the base model, while catalog IDs
    // with an unknown colon suffix remain searchable as-is
    expect(baseMatches).toEqual(['openai/gpt-5.6-sol']);
    expect(literalMatches).toEqual(['openrouter/vendor/model:free']);
  });

  test('recognizes space and parenthesized variant forms', () => {
    // Given a catalog model without an inline variant
    const candidates = ['openai/gpt-5.6-sol'];

    // When equivalent variant syntaxes are used
    const matches = [
      matchRefs(candidates, 'gpt-5.6-sol high'),
      matchRefs(candidates, 'gpt-5.6-sol(high)'),
    ];

    // Then both forms resolve to the same base model
    expect(matches).toEqual([['openai/gpt-5.6-sol'], ['openai/gpt-5.6-sol']]);
  });

  test('ranks separator-equivalent model family names as exact matches', () => {
    // Given equivalent model family spellings and a nearby token match
    const candidates = ['vendor/gpt-5-4', 'other/gpt-5.4-preview'];

    // When the dotted spelling is queried
    const matches = matchRefs(candidates, 'gpt-5.4');

    // Then the separator-equivalent model wins the exact semantic tier
    expect(matches).toEqual(['vendor/gpt-5-4', 'other/gpt-5.4-preview']);
  });

  test('normalizes Claude, Kimi, and GLM version separators', () => {
    // Given model families that use a hyphen instead of a dotted minor version
    const cases = [
      ['anthropic/claude-opus-4-6', 'claude-opus-4.6'],
      ['moonshot/kimi-k2-6', 'kimi-k2.6'],
      ['zhipu/glm-5-1', 'glm-5.1'],
    ] as const;

    // When each dotted spelling is queried
    const matches = cases.map(([candidate, query]) =>
      matchRefs([candidate], query),
    );

    // Then each spelling resolves to its catalog model
    expect(matches).toEqual(cases.map(([candidate]) => [candidate]));
  });

  test('rejects malformed reserved-delimiter queries instead of fuzzy matching', () => {
    // Given
    const queries = [
      '$gpt-5.6-sol',
      'openai$',
      'openai$gpt-5.6-sol#',
      'openai$$gpt-5.6-sol',
    ];

    // When
    const matches = queries.map((query) => matchRefs(CANDIDATES, query));

    // Then
    expect(matches).toEqual([[], [], [], []]);
  });

  test('matches exact tokens regardless of query token order', () => {
    // Given
    const query = 'opus claude 4 6';

    // When
    const matches = matchRefs(CANDIDATES, query);

    // Then
    expect(matches).toEqual(['github-copilot/claude-opus-4.6']);
  });

  test('matches token prefixes and substrings', () => {
    // Given
    const candidates = [...CANDIDATES, 'vendor/alpha-claude-opus-extra'];

    // When
    const prefixMatches = matchRefs(candidates, 'clau opu');
    const substringMatches = matchRefs(candidates, 'net-4');

    // Then
    expect(prefixMatches).toEqual([
      'github-copilot/claude-opus-4.6',
      'vendor/alpha-claude-opus-extra',
    ]);
    expect(substringMatches).toEqual(['anthropic/claude/sonnet-4.6']);
  });

  test('matches separator-insensitive compact forms', () => {
    // Given
    const query = 'gpt56sol';

    // When
    const matches = matchRefs(CANDIDATES, query);

    // Then
    expect(matches).toEqual(['openai/gpt-5.6-sol']);
  });

  test('recovers typos only within the length-based edit budget', () => {
    // Given
    const candidates = ['vendor/abc', 'vendor/abcdefgh', 'vendor/abcdefghij'];
    const queries = ['abx', 'abcxefgh', 'abcxyfgh', 'abcxefgyij', 'abcxefyyij'];

    // When
    const matches = queries.map((query) => matchRefs(candidates, query));

    // Then
    expect(matches).toEqual([
      [],
      ['vendor/abcdefgh'],
      [],
      ['vendor/abcdefghij'],
      [],
    ]);
  });

  test('does not fuzzy-match different numeric or version tokens', () => {
    // Given
    const query = 'gpt-5.7-sol';

    // When
    const matches = matchRefs(CANDIDATES, query);

    // Then
    expect(matches).toEqual([]);
  });

  test('returns no matches for punctuation-only or nonsense queries', () => {
    // Given
    const queries = ['!!!', 'zzzzzzzzzz'];

    // When
    const matches = queries.map((query) => matchRefs(CANDIDATES, query));

    // Then
    expect(matches).toEqual([[], []]);
  });

  test('returns deterministic deduplicated results for empty queries', () => {
    // Given
    const candidates = [
      'vendor/zeta',
      'invalid',
      'vendor/alpha',
      'vendor/zeta',
    ];

    // When
    const emptyMatches = matchRefs(candidates, '');
    const whitespaceMatches = matchRefs([...candidates].reverse(), '   ');

    // Then
    expect(emptyMatches).toEqual(['vendor/alpha', 'vendor/zeta']);
    expect(whitespaceMatches).toEqual(emptyMatches);
  });

  test('uses canonical lexical tie-breaks independent of candidate order', () => {
    // Given
    const candidates = [
      'zeta/claude-opus',
      'alpha/claude-opus',
      'middle/claude-opus',
    ];

    // When
    const forward = matchRefs(candidates, 'claude opus');
    const shuffled = matchRefs(
      [candidates[1], candidates[2], candidates[0]],
      'claude opus',
    );

    // Then
    expect(forward).toEqual([
      'alpha/claude-opus',
      'middle/claude-opus',
      'zeta/claude-opus',
    ]);
    expect(shuffled).toEqual(forward);
  });

  test('sorts all matches before applying the 20-result cap', () => {
    // Given
    const candidates = Array.from(
      { length: 25 },
      (_, index) => `provider/model-${String(24 - index).padStart(2, '0')}`,
    );

    // When
    const matches = matchRefs(candidates, 'provider');

    // Then
    expect(matches).toHaveLength(20);
    expect(matches[0]).toBe('provider/model-00');
    expect(matches[19]).toBe('provider/model-19');
  });
});
