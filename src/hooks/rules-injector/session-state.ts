import type { MatchedRule } from './types';

export interface RuleSessionState {
  filterNew(
    sessionID: string,
    rules: readonly MatchedRule[],
  ): readonly MatchedRule[];
  /** Return candidates without mutating tracked path/hash state. */
  getUnseen(
    sessionID: string,
    rules: readonly MatchedRule[],
  ): readonly MatchedRule[];
  /** Record only rules whose body or path-bearing truncation notice was appended. */
  markInjected(sessionID: string, rules: readonly MatchedRule[]): void;
  clearSession(sessionID: string): void;
  clearAll(): void;
}

export type RuleSessionStateOptions = {
  readonly maxTrackedRulesPerSession?: number;
};

/** Keep latest path/hash pairs only, with deterministic FIFO eviction. */
export function createRuleSessionState(
  options: RuleSessionStateOptions = {},
): RuleSessionState {
  const maxTracked = options.maxTrackedRulesPerSession ?? 512;
  const sessions = new Map<string, Map<string, string>>();

  function getUnseen(sessionID: string, rules: readonly MatchedRule[]) {
    const tracked = sessions.get(sessionID);
    return rules.filter(
      (rule) => tracked?.get(rule.realPath) !== rule.contentHash,
    );
  }

  function markInjected(
    sessionID: string,
    rules: readonly MatchedRule[],
  ): void {
    if (maxTracked <= 0) return;
    let tracked = sessions.get(sessionID);
    if (!tracked) {
      tracked = new Map();
      sessions.set(sessionID, tracked);
    }
    for (const rule of rules) {
      tracked.delete(rule.realPath);
      tracked.set(rule.realPath, rule.contentHash);
      while (tracked.size > maxTracked) {
        const oldestPath = tracked.keys().next().value;
        if (oldestPath === undefined) break;
        tracked.delete(oldestPath);
      }
    }
  }

  return {
    getUnseen,
    markInjected,
    filterNew(sessionID, rules) {
      const unseen = getUnseen(sessionID, rules);
      markInjected(sessionID, unseen);
      return unseen;
    },
    clearSession(sessionID) {
      sessions.delete(sessionID);
    },
    clearAll() {
      sessions.clear();
    },
  };
}
