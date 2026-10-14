import { describe, expect, test } from 'bun:test';
import { truncateRuleContent, truncateRuleContents } from './truncator';
import type { MatchedRule } from './types';

function rule(
  realPath: string,
  contentHash: string,
  body: string,
): MatchedRule {
  return {
    path: realPath,
    realPath,
    relativePath: `rules/${realPath.split('/').at(-1) ?? 'rule.md'}`,
    body,
    contentHash,
    metadata: { alwaysApply: true },
    depth: 1,
    prefixIndex: 0,
    global: false,
    reason: 'alwaysApply',
  };
}

describe('truncateRuleContent', () => {
  test('uses half of available context and preserves leading lines', async () => {
    const body = `${'header\n'.repeat(3)}${'x'.repeat(40_000)}`;
    const result = await truncateRuleContent({
      body,
      relativePath: 'rules/large.md',
      sessionID: 's1',
      readRemainingContextTokens: async () => 100,
    });

    expect(result.truncated).toBe(true);
    expect(result.result.startsWith('header\nheader\nheader')).toBe(true);
    expect(result.result).toContain('rules/large.md');
    expect(Math.ceil(result.result.length / 4)).toBeLessThanOrEqual(50);
  });

  test('falls back to fixed ceiling when usage is unavailable', async () => {
    const result = await truncateRuleContent({
      body: 'x'.repeat(200_004),
      relativePath: 'rules/large.md',
      sessionID: 's1',
      readRemainingContextTokens: async () => null,
    });

    expect(result.truncated).toBe(true);
    expect(Math.ceil(result.result.length / 4)).toBeLessThanOrEqual(50_000);
    expect(result.result).toContain('rules/large.md');
  });

  test('leaves short content unchanged and handles exhausted context', async () => {
    const body = '---\nalwaysApply: true\n---\nshort';
    expect(
      (
        await truncateRuleContent({
          body,
          relativePath: 'rules/short.md',
          sessionID: 's1',
          readRemainingContextTokens: async () => 100,
        })
      ).result,
    ).toBe(body);

    const exhausted = await truncateRuleContent({
      body: 'x'.repeat(100),
      relativePath: 'rules/empty.md',
      sessionID: 's1',
      readRemainingContextTokens: async () => 0,
    });
    expect(exhausted.truncated).toBe(true);
    expect(exhausted.result).toBe('');
  });

  test('never slices a long protected header to meet a small budget', async () => {
    const result = await truncateRuleContent({
      body: `${'h'.repeat(100)}\nsecond\nthird\n${'x'.repeat(100)}`,
      relativePath: 'rules/long.md',
      tokenBudget: 9,
      sessionID: 's1',
      readRemainingContextTokens: async () => null,
    });

    expect(result.truncated).toBe(true);
    expect(result.result).toBe('\n[Rule rules/long.md truncated.]');
    expect(result.result.length).toBeLessThanOrEqual(36);
  });

  test('keeps the complete header and full notice when both fit', async () => {
    const header = 'one\ntwo\nthree';
    const path = 'rules/a.md';
    const notice = `\n\n[Rule ${path} truncated. Read the full file for remaining content.]`;
    const body = `${header}\n${'x'.repeat(100)}`;
    const result = await truncateRuleContent({
      body,
      relativePath: path,
      tokenBudget: Math.ceil((header.length + notice.length) / 4),
      sessionID: 's1',
      readRemainingContextTokens: async () => null,
    });

    expect(result.result.startsWith(header)).toBe(true);
    expect(result.result.endsWith(notice)).toBe(true);
    expect(result.result.length).toBeLessThanOrEqual(
      Math.floor(Math.ceil((header.length + notice.length) / 4) * 4),
    );
  });

  test('uses compact notice alone when header and notice cannot fit', async () => {
    const result = await truncateRuleContent({
      body: `${'h'.repeat(40)}\ntwo\nthree\n${'x'.repeat(100)}`,
      relativePath: 'rules/a.md',
      tokenBudget: 9,
      sessionID: 's1',
      readRemainingContextTokens: async () => null,
    });

    expect(result.truncated).toBe(true);
    expect(result.result).toBe('\n[Rule rules/a.md truncated.]');
    expect(result.result.length).toBeLessThanOrEqual(36);
  });

  test('returns empty when even the compact notice exceeds the budget', async () => {
    const zero = await truncateRuleContent({
      body: 'long body',
      relativePath: 'rules/a.md',
      tokenBudget: 0,
      sessionID: 's1',
      readRemainingContextTokens: async () => null,
    });
    expect(zero).toEqual({ result: '', truncated: true });
  });

  test('fails closed for non-finite explicit budgets', async () => {
    for (const tokenBudget of [
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
    ]) {
      const result = await truncateRuleContent({
        body: 'x'.repeat(100),
        relativePath: 'rules/a.md',
        tokenBudget,
        sessionID: 's1',
        readRemainingContextTokens: async () => null,
      });
      expect(result).toEqual({ result: '', truncated: true });
      expect(result.result.length).toBeLessThanOrEqual(0);
    }
  });

  test('keeps exact and tiny explicit budgets within the character cap', async () => {
    for (const tokenBudget of [8, 9, 0]) {
      const result = await truncateRuleContent({
        body: `${'header\n'.repeat(3)}${'x'.repeat(100)}`,
        relativePath: 'rules/a.md',
        tokenBudget,
        sessionID: 's1',
        readRemainingContextTokens: async () => null,
      });
      expect(result.result.length).toBeLessThanOrEqual(
        Math.floor(tokenBudget * 4),
      );
    }
  });

  test('treats reader failures as unavailable', async () => {
    const result = await truncateRuleContent({
      body: 'x'.repeat(200_004),
      relativePath: 'rules/large.md',
      sessionID: 's1',
      readRemainingContextTokens: async () => {
        throw new Error('unavailable');
      },
    });
    expect(result.truncated).toBe(true);
    expect(Math.ceil(result.result.length / 4)).toBeLessThanOrEqual(50_000);
  });
});

describe('truncateRuleContents', () => {
  test('applies a shared ordered budget to selected rules', async () => {
    const rules = [
      rule('/repo/rules/a.md', 'a', 'a'.repeat(300)),
      rule('/repo/rules/b.md', 'b', 'b'.repeat(300)),
    ];
    const results = await truncateRuleContents({
      rules,
      sessionID: 's1',
      readRemainingContextTokens: async () => 200,
    });

    expect(results.map(({ realPath }) => realPath)).toEqual([
      '/repo/rules/a.md',
      '/repo/rules/b.md',
    ]);
    expect(
      Math.ceil(
        results.reduce((total, item) => total + item.result.length, 0) / 4,
      ),
    ).toBeLessThanOrEqual(100);
  });

  test('never exceeds small or zero shared/context-derived caps', async () => {
    for (const remainingTokens of [8, 0]) {
      const results = await truncateRuleContents({
        rules: [
          rule('/repo/rules/a.md', 'a', 'a'.repeat(100)),
          rule('/repo/rules/b.md', 'b', 'b'.repeat(100)),
        ],
        sessionID: 's1',
        readRemainingContextTokens: async () => remainingTokens,
      });
      const totalLength = results.reduce(
        (total, item) => total + item.result.length,
        0,
      );
      expect(totalLength).toBeLessThanOrEqual(
        Math.floor(Math.floor(remainingTokens / 2) * 4),
      );
      if (remainingTokens === 0) expect(results).toEqual([]);
    }
  });
});
