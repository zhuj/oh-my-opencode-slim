import { describe, expect, spyOn, test } from 'bun:test';
import { findModelMatches } from './find-model-search';

function countSets(refs: readonly string[], query: string): number {
  const original = globalThis.Set;
  let allocations = 0;
  globalThis.Set = new Proxy(original, {
    construct(target, args) {
      allocations++;
      return Reflect.construct(target, args);
    },
  });
  try {
    findModelMatches(refs, query);
    return allocations;
  } finally {
    globalThis.Set = original;
  }
}

describe('find-model lazy token indexes', () => {
  test.each(['acme/gpt-6.1', 'acme/gpt-6-1', 'acme', 'gpt-6.1'])(
    'early ranking allocates no token Sets: %s',
    (query) => {
      expect(countSets(['acme/gpt-6.1'], query)).toBe(0);
    },
  );

  test('only the searchable candidate field gets an exact-tier index', () => {
    const refs = Array.from({ length: 500 }, (_, i) => `acme/alpha-beta-${i}`);
    expect(countSets(refs, 'beta alpha')).toBe(500);
    expect(countSets(refs, 'acme/beta alpha')).toBe(500);
    expect(countSets(refs, '')).toBe(0);
    expect(countSets(refs, 'other/beta alpha')).toBe(0);
  });
});

// Captured before lazy indexing; pins every ranking tier and the match cap.
const CATALOG = [
  'acme/alpha-beta',
  'acme/beta-alpha-code',
  'acme/modular-characterization',
  'acme/myalphabeta',
  'acme/alpha.beta',
  'other/alpha-beta',
  'acme/alphx',
  'acme/folder/alpha-beta',
  'google/gemini-3-pro-preview',
  'openai/gpt-6.1',
  'bad',
  'acme/alpha-beta#high',
  ...Array.from(
    { length: 24 },
    (_, i) => `bulk/model-${String(i).padStart(2, '0')}`,
  ),
];
const GOLDENS: Record<string, string[]> = {
  'openai/gpt-6-1': ['openai/gpt-6.1'],
  'gpt-6-1': ['openai/gpt-6.1'],
  'acme/alpha-beta': [
    'acme/alpha-beta',
    'acme/folder/alpha-beta',
    'acme/alpha.beta',
    'acme/beta-alpha-code',
    'acme/myalphabeta',
  ],
  'acme/alpha_beta': [
    'acme/alpha-beta',
    'acme/alpha.beta',
    'acme/beta-alpha-code',
    'acme/folder/alpha-beta',
    'acme/myalphabeta',
  ],
  acme: [
    'acme/alpha-beta',
    'acme/alpha.beta',
    'acme/alphx',
    'acme/beta-alpha-code',
    'acme/folder/alpha-beta',
    'acme/modular-characterization',
    'acme/myalphabeta',
  ],
  'alpha-beta': [
    'acme/alpha-beta',
    'acme/folder/alpha-beta',
    'other/alpha-beta',
    'acme/alpha.beta',
    'acme/beta-alpha-code',
    'acme/myalphabeta',
  ],
  alpha_beta: [
    'acme/alpha-beta',
    'acme/alpha.beta',
    'acme/beta-alpha-code',
    'acme/folder/alpha-beta',
    'other/alpha-beta',
    'acme/myalphabeta',
  ],
  'beta alpha': [
    'acme/alpha-beta',
    'acme/alpha.beta',
    'acme/beta-alpha-code',
    'acme/folder/alpha-beta',
    'other/alpha-beta',
  ],
  'acme/chara modular': ['acme/modular-characterization'],
  'pha-b': [
    'acme/alpha-beta',
    'other/alpha-beta',
    'acme/folder/alpha-beta',
    'acme/alpha.beta',
    'acme/myalphabeta',
  ],
  alphabeta: [
    'acme/myalphabeta',
    'acme/alpha-beta',
    'acme/alpha.beta',
    'other/alpha-beta',
    'acme/folder/alpha-beta',
  ],
  alphy: [
    'acme/alpha-beta',
    'acme/alpha.beta',
    'acme/alphx',
    'acme/beta-alpha-code',
    'acme/folder/alpha-beta',
    'other/alpha-beta',
  ],
  'google/gemini-3-pro-high': [],
  'gemini-3-pro-high': ['google/gemini-3-pro-preview'],
  'gpt 6.1': ['openai/gpt-6.1'],
  '': [
    'acme/alpha-beta',
    'acme/alpha.beta',
    'acme/alphx',
    'acme/beta-alpha-code',
    'acme/folder/alpha-beta',
    'acme/modular-characterization',
    'acme/myalphabeta',
    ...CATALOG.filter((ref) => ref.startsWith('bulk/')).slice(0, 13),
  ],
  'acme/': [],
  bad$model: [],
};

test('ranking bytes match the pre-lazy catalog/query matrix', () => {
  for (const refs of [
    CATALOG,
    [...CATALOG].reverse(),
    [...CATALOG, ...CATALOG],
  ]) {
    for (const [query, expectedRefs] of Object.entries(GOLDENS)) {
      const expected = expectedRefs.map((ref) => {
        const slash = ref.indexOf('/');
        return {
          provider: ref.slice(0, slash),
          model: ref.slice(slash + 1),
          ref,
        };
      });
      expect(JSON.stringify(findModelMatches(refs, query))).toBe(
        JSON.stringify(expected),
      );
    }
  }
});

// The exact-token tier answers membership from a Set; the prefix tier cannot,
// because a Set cannot express `startsWith`. Both tiers are pinned here so the
// cheaper lookup cannot quietly swallow the richer prefix semantics.
describe('find-model token tier scanning', () => {
  test('exact-token matching does not rescan per query token', () => {
    // Given candidates whose tokens cover both queries, plus one candidate
    // that short-circuits the prefix tier on its very first query token
    const candidates = [
      'acme/alpha-beta-gamma-delta-code',
      'acme/alpha-beta-gamma-delta-vision',
      'acme/omega-solver',
    ];
    const scan = spyOn(Array.prototype, 'some');
    try {
      const measure = (query: string) => {
        scan.mockClear();
        const ranked = findModelMatches(candidates, query).map(
          ({ ref }) => ref,
        );
        return { ranked, scans: scan.mock.calls.length };
      };
      // When resolving queries that differ only in query-token count
      const short = measure('acme/alpha-beta');
      const long = measure('acme/alpha-beta-gamma-delta');
      // Then both rank identically and scan identically
      expect(short.ranked).toEqual([
        'acme/alpha-beta-gamma-delta-code',
        'acme/alpha-beta-gamma-delta-vision',
      ]);
      expect(long.ranked).toEqual(short.ranked);
      // The prefix tier still scans, so this is not a vacuous zero-vs-zero.
      expect(short.scans).toBeGreaterThan(0);
      expect(long.scans).toBe(short.scans);
    } finally {
      scan.mockRestore();
    }
  });

  test('prefix tier still matches tokens an exact Set would reject', () => {
    // Given a query whose tokens are only prefixes of the candidate's tokens,
    // ordered so neither substring nor compact tiers can rescue the match
    const candidates = ['acme/modular-characterization', 'acme/zzz-yyy'];
    // When resolving the provider-scoped query
    const result = findModelMatches(candidates, 'acme/chara modular');
    // Then the prefix-only match survives and the non-matching one does not
    expect(result.map(({ ref }) => ref)).toEqual([
      'acme/modular-characterization',
    ]);
  });
});
