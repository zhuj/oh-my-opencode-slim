import { describe, expect, test } from 'bun:test';
import picomatch from 'picomatch';
import { OPENCODE_CONFIG_DEPTH } from '../../config/project-resource-paths';
import { matchRulesForFile, matchSelectors } from './matcher';
import type { RuleCandidate } from './types';

// Counting wrapper around the real compiler so the perf invariant can be
// observed without module-level instrumentation, which this CJS dependency
// does not support reliably.
function countedCompiler(
  compiled: string[],
  calls?: Map<string, number>,
): (pattern: string) => (path: string) => boolean {
  return (pattern) => {
    compiled.push(pattern);
    const matcher = picomatch(pattern, { dot: true, bash: true });
    return (path) => {
      if (calls) calls.set(pattern, (calls.get(pattern) ?? 0) + 1);
      return matcher(path);
    };
  };
}

describe('matchSelectors', () => {
  test('compiles each reached pattern once regardless of path count', () => {
    const selectors = ['src/**/*.ts', 'docs/**/*.md', '!src/private/**'];
    const onePath = ['src/deep/file.ts'];
    const manyPaths = Array.from(
      { length: 64 },
      (_, index) => `src/${index}/file.ts`,
    );
    const few: string[] = [];
    const many: string[] = [];

    expect(matchSelectors(selectors, onePath, countedCompiler(few))).toBe(
      'src/**/*.ts',
    );
    expect(matchSelectors(selectors, manyPaths, countedCompiler(many))).toBe(
      'src/**/*.ts',
    );

    // The reached patterns are the winning positive plus the only negative,
    // each compiled once. What matters is that the compile count tracks
    // patterns, not paths: 64x more paths must not cost a single extra
    // compilation, and no unexamined pattern appears at all.
    expect(few).toEqual(['src/**/*.ts', 'src/private/**']);
    expect(many).toEqual(few);
  });

  test('never compiles a pattern the result does not depend on', () => {
    // picomatch rejects an oversized pattern outright, so a selector sitting
    // after the deciding match must stay uncompiled rather than throw.
    const poison = 'x'.repeat(65537);

    expect(matchSelectors(['**/*.ts', poison], ['a.ts'])).toBe('**/*.ts');
    expect(matchSelectors(['**/*.ts', '!a.ts', `!${poison}`], ['a.ts'])).toBe(
      undefined,
    );
  });

  test('does not rescan paths once a positive pattern has matched', () => {
    // The match sits on the middle path, so a re-scan after the hit would run
    // the matcher more times than there are paths.
    const paths = ['README.md', 'src/deep/file.ts', 'file.ts'];
    const calls = new Map<string, number>();

    expect(
      matchSelectors(['src/**/*.ts'], paths, countedCompiler([], calls)),
    ).toBe('src/**/*.ts');

    expect(calls.get('src/**/*.ts')).toBe(2);
    expect(calls.get('src/**/*.ts')).toBeLessThan(paths.length);
  });

  test('returns the first positive that matches, in selector order', () => {
    const paths = ['src/deep/file.ts', 'file.ts'];

    expect(matchSelectors(['docs/**/*.md', 'src/**/*.ts'], paths)).toBe(
      'src/**/*.ts',
    );
    expect(matchSelectors(['src/**/*.ts', '**/file.ts'], paths)).toBe(
      'src/**/*.ts',
    );
  });

  test('returns undefined when no positive pattern matches any path', () => {
    const calls = new Map<string, number>();

    expect(
      matchSelectors(
        ['docs/**/*.md', '!src/private/**'],
        ['src/deep/file.ts'],
        countedCompiler([], calls),
      ),
    ).toBeUndefined();
    // The single positive is compiled once and tested once; negatives are
    // only compiled once a positive has already matched.
    expect(calls.get('docs/**/*.md')).toBe(1);
    expect(calls.has('src/private/**')).toBe(false);
  });

  test('returns undefined for negative-only selectors and negative hits', () => {
    const paths = ['src/private/file.ts', 'file.ts'];

    expect(matchSelectors(['!src/**/*.ts'], paths)).toBeUndefined();
    expect(matchSelectors(['!src/private/**'], paths)).toBeUndefined();
    expect(matchSelectors([], paths)).toBeUndefined();
    expect(
      matchSelectors(['src/private/**', '!src/private/**'], paths),
    ).toBeUndefined();
  });

  test('reuses one compiled matcher across many paths without drift', () => {
    // Guards the reuse assumption: a reused matcher must answer identically on
    // every call, with no state carried between paths (e.g. a /g lastIndex).
    const paths = [
      'src/a.ts',
      'src/deep/b.ts',
      'src/c.test.ts',
      'README.md',
      'src/a.js',
      'docs/x.md',
    ];
    const expected = matchSelectors(['src/**/*.ts'], paths);

    for (let round = 0; round < 50; round += 1) {
      expect(matchSelectors(['src/**/*.ts'], paths)).toBe(expected);
    }
    expect(expected).toBe('src/**/*.ts');
  });
});

describe('matchRulesForFile', () => {
  test('matches selector aliases against project-relative paths and basename', () => {
    const rules = [
      {
        path: '/project/rules/always.md',
        relativePath: 'rules/always.md',
        realPath: '/project/rules/always.md',
        body: 'a',
        contentHash: 'a',
        metadata: { alwaysApply: true },
        prefixIndex: 1,
        depth: 1,
      },
      {
        path: '/project/rules/src.md',
        relativePath: 'rules/src.md',
        realPath: '/project/rules/src.md',
        body: 'b',
        contentHash: 'b',
        metadata: { globs: ['src/**/*.ts'] },
        prefixIndex: 0,
        depth: 1,
      },
      {
        path: '/project/src/rules/name.md',
        relativePath: 'src/rules/name.md',
        realPath: '/project/src/rules/name.md',
        body: 'c',
        contentHash: 'c',
        metadata: { paths: ['special.ts'] },
        prefixIndex: 0,
        depth: 2,
      },
    ] satisfies readonly RuleCandidate[];

    const matches = matchRulesForFile(
      rules,
      '/project/src/special.ts',
      '/project',
    );

    expect(matches.map((rule) => rule.relativePath)).toEqual([
      'rules/src.md',
      'rules/always.md',
      'rules/name.md',
    ]);
    expect(matches.map((rule) => rule.reason)).toEqual([
      'glob: src/**/*.ts',
      'alwaysApply',
      'glob: special.ts',
    ]);
  });

  test('does not match selector-free rules and applies negative patterns', () => {
    const rules = [
      {
        path: '/project/rules/empty.md',
        relativePath: 'rules/empty.md',
        realPath: '/project/rules/empty.md',
        body: '',
        contentHash: '',
        metadata: {},
        prefixIndex: 0,
        depth: 1,
      },
      {
        path: '/project/rules/negative.md',
        relativePath: 'rules/negative.md',
        realPath: '/project/rules/negative.md',
        body: '',
        contentHash: '',
        metadata: { applyTo: ['src/**/*.ts', '!src/**/*.test.ts'] },
        prefixIndex: 0,
        depth: 1,
      },
    ] satisfies readonly RuleCandidate[];

    expect(
      matchRulesForFile(rules, '/project/src/feature.test.ts', '/project'),
    ).toEqual([]);
  });

  test('negative patterns exclude globally despite a later positive', () => {
    const rule = {
      path: '/project/rules/private.md',
      relativePath: 'rules/private.md',
      realPath: '/project/rules/private.md',
      body: '',
      contentHash: '',
      metadata: { globs: ['src/**', '!src/private/**', 'src/private/keep.ts'] },
      prefixIndex: 0,
      depth: 1,
    } satisfies RuleCandidate;
    expect(
      matchRulesForFile([rule], '/project/src/private/keep.ts', '/project'),
    ).toEqual([]);
  });

  test('negative selectors exclude positives from other selector fields', () => {
    const cases = [
      {
        metadata: { globs: ['src/**'], paths: ['!src/private/**'] },
      },
      {
        metadata: { paths: ['src/**'], applyTo: ['!src/private/**'] },
      },
      {
        metadata: { applyTo: ['src/**'], globs: ['!src/private/**'] },
      },
    ] satisfies readonly Pick<RuleCandidate, 'metadata'>[];
    const rules = cases.map(({ metadata }, index) => ({
      path: `/project/rules/${index}.md`,
      relativePath: `rules/${index}.md`,
      realPath: `/project/rules/${index}.md`,
      body: '',
      contentHash: '',
      metadata,
      prefixIndex: 0,
      depth: 1,
    })) satisfies readonly RuleCandidate[];

    expect(
      matchRulesForFile(rules, '/project/src/private/file.ts', '/project'),
    ).toEqual([]);
  });

  test('does not match touched paths outside the project boundary', () => {
    const rule = {
      path: '/project/rules/always.md',
      relativePath: 'rules/always.md',
      realPath: '/project/rules/always.md',
      body: '',
      contentHash: '',
      metadata: { alwaysApply: true },
      prefixIndex: 0,
      depth: 1,
    } satisfies RuleCandidate;
    expect(matchRulesForFile([rule], '/outside/file.ts', '/project')).toEqual(
      [],
    );
  });

  test('matches the applyTo selector when its positive pattern matches', () => {
    const rule = {
      path: '/project/rules/source.md',
      relativePath: 'rules/source.md',
      realPath: '/project/rules/source.md',
      body: '',
      contentHash: '',
      metadata: { applyTo: 'src/**/*.ts' },
      prefixIndex: 0,
      depth: 1,
    } satisfies RuleCandidate;

    expect(
      matchRulesForFile([rule], '/project/src/deep/file.ts', '/project').map(
        (match) => match.reason,
      ),
    ).toEqual(['applyTo: src/**/*.ts']);
  });

  test('sorts by prefix order, then local filename, when depth ties', () => {
    const rules = [
      {
        path: '/project/src/rules/z.md',
        relativePath: 'src/rules/z.md',
        realPath: '/project/src/rules/z.md',
        body: '',
        contentHash: '',
        metadata: { alwaysApply: true },
        prefixIndex: 1,
        depth: 1,
      },
      {
        path: '/project/src/rules/b.md',
        relativePath: 'src/rules/b.md',
        realPath: '/project/src/rules/b.md',
        body: '',
        contentHash: '',
        metadata: { alwaysApply: true },
        prefixIndex: 0,
        depth: 1,
      },
      {
        path: '/project/src/rules/a.md',
        relativePath: 'src/rules/a.md',
        realPath: '/project/src/rules/a.md',
        body: '',
        contentHash: '',
        metadata: { alwaysApply: true },
        prefixIndex: 0,
        depth: 1,
      },
    ] satisfies readonly RuleCandidate[];

    expect(
      matchRulesForFile(rules, '/project/src/file.ts', '/project').map(
        (rule) => rule.relativePath,
      ),
    ).toEqual(['rules/a.md', 'rules/b.md', 'rules/z.md']);
  });

  test('sorts a global rule ahead of project rules because it is least specific', () => {
    // A global root lives in a config directory, so it holds
    // `OPENCODE_CONFIG_DEPTH` -- the smallest depth there is. Ordering
    // least-specific-first puts the global rule ahead of the project rule, so a
    // global rule that shares a filename with a project rule is overridden
    // rather than silently outranking it.
    const rules = [
      {
        path: '/project/rules/p.md',
        relativePath: 'rules/p.md',
        realPath: '/project/rules/p.md',
        body: '',
        contentHash: '',
        metadata: { alwaysApply: true },
        prefixIndex: 0,
        depth: 1,
        global: false,
      },
      {
        path: '/home/u/.config/opencode/rules/g.md',
        relativePath: 'global-rules/g.md',
        realPath: '/home/u/.config/opencode/rules/g.md',
        body: '',
        contentHash: '',
        metadata: { alwaysApply: true },
        prefixIndex: 0,
        depth: OPENCODE_CONFIG_DEPTH,
        global: true,
      },
    ] satisfies readonly RuleCandidate[];

    const matches = matchRulesForFile(
      rules,
      '/project/src/file.ts',
      '/project',
    );

    expect(matches.map((rule) => rule.relativePath)).toEqual([
      'global-rules/g.md',
      'rules/p.md',
    ]);
    // Pins that depth alone orders these least-specific-first.
    expect(matches[1]?.depth).toBeGreaterThan(matches[0]?.depth ?? 0);
  });

  test('lets a project rule override a global rule sharing its filename', () => {
    const rules = [
      {
        path: '/home/u/.config/opencode/rules/team.md',
        relativePath: 'global-rules/team.md',
        realPath: '/home/u/.config/opencode/rules/team.md',
        body: 'GLOBAL',
        contentHash: 'g',
        metadata: { alwaysApply: true },
        prefixIndex: 0,
        depth: 1,
        global: true,
      },
      {
        path: '/project/rules/team.md',
        relativePath: 'rules/team.md',
        realPath: '/project/rules/team.md',
        body: 'PROJECT',
        contentHash: 'p',
        metadata: { alwaysApply: true },
        prefixIndex: 0,
        depth: 1,
        global: false,
      },
    ] satisfies readonly RuleCandidate[];

    const matches = matchRulesForFile(
      rules,
      '/project/src/file.ts',
      '/project',
    );

    // Only the more specific project rule survives: one filename, one rule.
    expect(matches.map((rule) => rule.body)).toEqual(['PROJECT']);
  });

  test('lets an empty project rule shadow a global rule sharing its filename', () => {
    const rules = [
      {
        path: '/home/u/.config/opencode/rules/team.md',
        relativePath: 'global-rules/team.md',
        realPath: '/home/u/.config/opencode/rules/team.md',
        body: 'GLOBAL',
        contentHash: 'g',
        metadata: { alwaysApply: true },
        prefixIndex: 0,
        depth: 1,
        global: true,
      },
      {
        path: '/project/rules/team.md',
        relativePath: 'rules/team.md',
        realPath: '/project/rules/team.md',
        body: '',
        contentHash: '',
        metadata: {},
        prefixIndex: 0,
        depth: 1,
        global: false,
      },
    ] satisfies readonly RuleCandidate[];

    const matches = matchRulesForFile(
      rules,
      '/project/src/file.ts',
      '/project',
    );

    // The shadow carries no selector, so it is dropped after winning the
    // override. The global body goes with it: nothing is injected.
    expect(matches).toEqual([]);
  });

  test('orders the least specific rule first and the closest rule last', () => {
    const rules = [
      {
        path: '/project/src/rules/near.md',
        relativePath: 'rules/near.md',
        realPath: '/project/src/rules/near.md',
        body: '',
        contentHash: '',
        metadata: { alwaysApply: true },
        prefixIndex: 0,
        depth: 1,
        global: false,
      },
      {
        path: '/project/rules/far.md',
        relativePath: 'rules/far.md',
        realPath: '/project/rules/far.md',
        body: '',
        contentHash: '',
        metadata: { alwaysApply: true },
        prefixIndex: 0,
        depth: 1,
        global: false,
      },
    ] satisfies readonly RuleCandidate[];

    expect(
      matchRulesForFile(rules, '/project/src/file.ts', '/project').map(
        (rule) => rule.relativePath,
      ),
    ).toEqual(['rules/far.md', 'rules/near.md']);
  });

  test('breaks a depth and prefix tie by local filename', () => {
    const rules = [
      {
        path: '/project/rules/z.md',
        relativePath: 'rules/z.md',
        realPath: '/project/rules/z.md',
        body: '',
        contentHash: '',
        metadata: { alwaysApply: true },
        prefixIndex: 0,
        depth: 1,
        global: false,
      },
      {
        path: '/project/rules/a.md',
        relativePath: 'rules/a.md',
        realPath: '/project/rules/a.md',
        body: '',
        contentHash: '',
        metadata: { alwaysApply: true },
        prefixIndex: 0,
        depth: 1,
        global: false,
      },
    ] satisfies readonly RuleCandidate[];

    expect(
      matchRulesForFile(rules, '/project/src/file.ts', '/project').map(
        (rule) => rule.relativePath,
      ),
    ).toEqual(['rules/a.md', 'rules/z.md']);
  });

  test('keeps project ordering stable when no rule is global', () => {
    const rules = [
      {
        path: '/project/rules/a.md',
        relativePath: 'rules/a.md',
        realPath: '/project/rules/a.md',
        body: '',
        contentHash: '',
        metadata: { alwaysApply: true },
        prefixIndex: 0,
        depth: 1,
        global: false,
      },
      {
        path: '/project/rules/b.md',
        relativePath: 'rules/b.md',
        realPath: '/project/rules/b.md',
        body: '',
        contentHash: '',
        metadata: { alwaysApply: true },
        prefixIndex: 0,
        depth: 1,
        global: false,
      },
    ] satisfies readonly RuleCandidate[];

    expect(
      matchRulesForFile(rules, '/project/src/file.ts', '/project').map(
        (rule) => rule.relativePath,
      ),
    ).toEqual(['rules/a.md', 'rules/b.md']);
  });
});
