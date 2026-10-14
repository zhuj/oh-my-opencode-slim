import { describe, expect, test } from 'bun:test';
import { createRuleSessionState } from './session-state';
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

describe('RuleSessionState', () => {
  test('deduplicates path/hash and emits changed content', () => {
    const state = createRuleSessionState({ maxTrackedRulesPerSession: 2 });
    const original = rule('/repo/rules/a.md', 'hash-1', 'first');

    expect(state.filterNew('s1', [original])).toEqual([original]);
    expect(state.filterNew('s1', [original])).toEqual([]);
    expect(
      state.filterNew('s1', [rule('/repo/rules/a.md', 'hash-2', 'updated')]),
    ).toHaveLength(1);
  });

  test('isolates sessions, evicts oldest paths, and clears session state', () => {
    const state = createRuleSessionState({ maxTrackedRulesPerSession: 2 });
    const a = rule('/repo/rules/a.md', 'a', 'a');
    const b = rule('/repo/rules/b.md', 'b', 'b');
    const c = rule('/repo/rules/c.md', 'c', 'c');

    state.filterNew('s1', [a, b]);
    state.filterNew('s1', [c]);
    expect(state.filterNew('s1', [a])).toEqual([a]);
    expect(state.filterNew('s2', [a])).toEqual([a]);
    state.clearSession('s1');
    expect(state.filterNew('s1', [b])).toEqual([b]);
  });

  test('clearAll resets tracked hashes', () => {
    const state = createRuleSessionState();
    const item = rule('/repo/rules/a.md', 'a', 'a');
    state.filterNew('s1', [item]);
    state.clearAll();
    expect(state.filterNew('s1', [item])).toEqual([item]);
  });

  test('unseen lookup is read-only until marked injected', () => {
    const state = createRuleSessionState();
    const item = rule('/repo/rules/a.md', 'a', 'a');

    expect(state.getUnseen('s1', [item])).toEqual([item]);
    expect(state.getUnseen('s1', [item])).toEqual([item]);
    state.markInjected('s1', [item]);
    expect(state.getUnseen('s1', [item])).toEqual([]);
  });
});
