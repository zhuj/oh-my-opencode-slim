import type { MatchedRule } from './types';

const MAX_TOKENS = 50_000;

export type RuleContextUsageReader = (
  sessionID: string,
) => Promise<number | null>;

export type TruncateRuleContentOptions = {
  readonly body: string;
  readonly relativePath: string;
  readonly readRemainingContextTokens: RuleContextUsageReader;
  readonly sessionID: string;
  readonly tokenBudget?: number;
};

export type TruncatedRuleContent = {
  readonly result: string;
  readonly truncated: boolean;
};

export type TruncatedMatchedRule = {
  readonly realPath: string;
  readonly relativePath: string;
  readonly result: string;
  readonly truncated: boolean;
};

async function getTokenBudget(
  sessionID: string,
  reader: RuleContextUsageReader,
): Promise<number> {
  try {
    const remaining = await reader(sessionID);
    return remaining === null || !Number.isFinite(remaining)
      ? MAX_TOKENS
      : Math.max(0, Math.min(MAX_TOKENS, Math.floor(remaining / 2)));
  } catch {
    return MAX_TOKENS;
  }
}

function truncate(
  body: string,
  relativePath: string,
  tokenBudget: number,
): TruncatedRuleContent {
  const maxCharacters = Math.max(0, Math.floor(tokenBudget * 4));
  if (body.length <= maxCharacters) return { result: body, truncated: false };

  const notice =
    tokenBudget === 0
      ? `\n[Rule ${relativePath} omitted: context window exhausted.]`
      : `\n\n[Rule ${relativePath} truncated. Read the full file for remaining content.]`;
  const compactNotice = `\n[Rule ${relativePath} truncated.]`;
  const lines = body.split('\n');
  const header = lines.slice(0, 3).join('\n');
  const fittedNotice =
    header.length + notice.length <= maxCharacters ? notice : compactNotice;
  if (fittedNotice.length > maxCharacters) {
    return compactNotice.length <= maxCharacters
      ? { result: compactNotice, truncated: true }
      : { result: '', truncated: true };
  }

  if (header.length + fittedNotice.length > maxCharacters) {
    return { result: fittedNotice, truncated: true };
  }

  const contentStart = Math.min(body.length, header.length);
  const remainingCharacters =
    maxCharacters - header.length - fittedNotice.length;
  const remainder = body.slice(
    contentStart,
    contentStart + remainingCharacters,
  );
  const result = `${header}${remainder}${fittedNotice}`;
  return { result, truncated: true };
}

export async function truncateRuleContent(
  options: TruncateRuleContentOptions,
): Promise<TruncatedRuleContent> {
  const explicitBudget = options.tokenBudget;
  const budget =
    explicitBudget === undefined
      ? await getTokenBudget(
          options.sessionID,
          options.readRemainingContextTokens,
        )
      : Number.isFinite(explicitBudget)
        ? Math.max(0, explicitBudget)
        : 0;
  return truncate(
    options.body,
    options.relativePath,
    Math.max(0, Math.min(MAX_TOKENS, budget)),
  );
}

export type TruncateRuleContentsOptions = {
  readonly rules: readonly MatchedRule[];
  readonly sessionID: string;
  readonly readRemainingContextTokens: RuleContextUsageReader;
};

export async function truncateRuleContents(
  options: TruncateRuleContentsOptions,
): Promise<readonly TruncatedMatchedRule[]> {
  const budget = await getTokenBudget(
    options.sessionID,
    options.readRemainingContextTokens,
  );
  let remainingCharacters = budget * 4;
  const results: TruncatedMatchedRule[] = [];

  for (const rule of options.rules) {
    if (remainingCharacters <= 0) break;
    const result = truncate(
      rule.body,
      rule.relativePath,
      Math.floor(remainingCharacters / 4),
    );
    if (result.result.length > remainingCharacters) continue;
    results.push({
      realPath: rule.realPath,
      relativePath: rule.relativePath,
      ...result,
    });
    remainingCharacters -= result.result.length;
  }
  return results;
}
