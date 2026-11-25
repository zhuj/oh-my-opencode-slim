import leven from 'leven';
import { parseModelReference } from '../utils/session';
import { normalizeModelName } from './find-model-normalization';
import { parseModelQuery, resolveBareModelAlias } from './resolve-model-query';

export interface FindModelMatch {
  readonly provider: string;
  readonly model: string;
  readonly ref: string;
}

const MAX_MATCHES = 20;
const TOKEN_PATTERN = /[\p{L}\p{N}]+/gu;
const DIGIT_PATTERN = /\p{N}/gu;

interface SearchText {
  readonly normalized: string;
  readonly canonical: string;
  readonly tokens: readonly string[];
  /** Built only when this candidate reaches the exact-token tier. */
  tokenSet?: ReadonlySet<string>;
  readonly compact: string;
  readonly digits: string;
}

interface SearchQuery {
  readonly full: SearchText;
  readonly provider: SearchText | null;
  readonly model: SearchText;
  readonly baseModel: SearchText;
}

interface Candidate {
  readonly match: FindModelMatch;
  readonly full: SearchText;
  readonly provider: SearchText;
  readonly model: SearchText;
}

interface RankedMatch {
  readonly match: FindModelMatch;
  readonly tier: number;
  readonly detail: number;
}

function toSearchText(value: string): SearchText {
  const normalized = value.normalize('NFKC').trim().toLowerCase();
  const tokens = normalized.match(TOKEN_PATTERN) ?? [];
  return {
    normalized,
    canonical: normalizeModelName(normalized),
    tokens,
    compact: tokens.join(''),
    digits: normalized.match(DIGIT_PATTERN)?.join('') ?? '',
  };
}

function toCandidate(ref: string): Candidate | null {
  const slashIndex = ref.indexOf('/');
  if (slashIndex <= 0 || slashIndex === ref.length - 1) return null;

  const provider = ref.slice(0, slashIndex);
  const model = ref.slice(slashIndex + 1);
  const parsed = parseModelReference(ref);
  if (!parsed || parsed.modelID !== model || parsed.variant !== undefined) {
    return null;
  }
  return {
    match: {
      provider,
      model,
      ref,
    },
    full: toSearchText(ref),
    provider: toSearchText(provider),
    model: toSearchText(model),
  };
}

function compareText(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function editBudget(length: number): number {
  if (length < 4) return 0;
  if (length <= 8) return 1;
  return 2;
}

function boundedDistance(
  query: SearchText,
  candidate: SearchText,
): number | null {
  const budget = editBudget(query.compact.length);
  if (budget === 0 || query.digits !== candidate.digits) return null;

  const targets = [candidate.compact, ...candidate.tokens];
  let closest = budget + 1;
  for (const target of targets) {
    const distance = leven(query.compact, target, {
      maxDistance: budget + 1,
    });
    if (distance < closest) closest = distance;
  }
  return closest <= budget ? closest : null;
}

function includesAllTokens(
  candidate: SearchText,
  queryTokens: readonly string[],
  prefix: boolean,
): boolean {
  // A Set cannot express prefix matching, so that tier keeps the scan.
  if (prefix) {
    return queryTokens.every((queryToken) =>
      candidate.tokens.some((candidateToken) =>
        candidateToken.startsWith(queryToken),
      ),
    );
  }
  candidate.tokenSet ??= new Set(candidate.tokens);
  const tokenSet = candidate.tokenSet;
  return queryTokens.every((queryToken) => tokenSet.has(queryToken));
}

// Lower tiers implement exact → canonical exact → provider → model → token →
// prefix → substring → separator-insensitive → bounded typo precedence.
function rankCandidate(
  candidate: Candidate,
  query: SearchQuery,
): RankedMatch | null {
  const scoped = query.provider !== null;
  if (scoped && query.provider.normalized !== candidate.provider.normalized) {
    return null;
  }

  const normalizedRef = `${candidate.provider.normalized}/${candidate.model.normalized}`;
  const normalizedQuery = scoped
    ? `${query.provider.normalized}/${query.model.normalized}`
    : query.model.normalized;
  if (normalizedQuery === normalizedRef) {
    return { match: candidate.match, tier: 0, detail: 0 };
  }

  const canonicalRef = `${candidate.provider.canonical}/${candidate.model.canonical}`;
  const canonicalQuery = scoped
    ? `${query.provider.canonical}/${query.baseModel.canonical}`
    : query.baseModel.canonical;
  if (canonicalQuery === canonicalRef) {
    return { match: candidate.match, tier: 1, detail: 0 };
  }
  if (!scoped && query.baseModel.normalized === candidate.provider.normalized) {
    return { match: candidate.match, tier: 2, detail: 0 };
  }
  if (
    query.model.normalized === candidate.model.normalized ||
    candidate.model.normalized.endsWith(`/${query.model.normalized}`)
  ) {
    return { match: candidate.match, tier: 3, detail: 0 };
  }
  if (
    query.baseModel.canonical === candidate.model.canonical ||
    candidate.model.canonical.endsWith(`/${query.baseModel.canonical}`)
  ) {
    return { match: candidate.match, tier: 4, detail: 0 };
  }

  const searchable = scoped ? candidate.model : candidate.full;
  // Exact-token tier.
  if (includesAllTokens(searchable, query.baseModel.tokens, false)) {
    return { match: candidate.match, tier: 5, detail: 0 };
  }
  // Prefix-token tier.
  if (includesAllTokens(searchable, query.baseModel.tokens, true)) {
    return { match: candidate.match, tier: 6, detail: 0 };
  }

  const substringIndex = searchable.normalized.indexOf(
    query.baseModel.normalized,
  );
  if (substringIndex >= 0) {
    return { match: candidate.match, tier: 7, detail: substringIndex };
  }
  const compactIndex = searchable.compact.indexOf(query.baseModel.compact);
  if (compactIndex >= 0) {
    return { match: candidate.match, tier: 8, detail: compactIndex };
  }

  const distance = boundedDistance(query.baseModel, candidate.model);
  return distance === null
    ? null
    : { match: candidate.match, tier: 9, detail: distance };
}

export function findModelMatches(
  refs: readonly string[],
  rawQuery: string,
): FindModelMatch[] {
  const candidates = new Map<string, Candidate>();
  for (const ref of [...refs].sort(compareText)) {
    const candidate = toCandidate(ref);
    if (candidate && !candidates.has(candidate.full.normalized)) {
      candidates.set(candidate.full.normalized, candidate);
    }
  }

  const fullQuery = toSearchText(rawQuery);
  if (fullQuery.normalized === '') {
    return [...candidates.values()]
      .map(({ match }) => match)
      .slice(0, MAX_MATCHES);
  }

  const parsed = parseModelQuery(fullQuery.normalized);
  if (!parsed) return [];
  const provider = parsed.providerID ? toSearchText(parsed.providerID) : null;
  const model = toSearchText(parsed.modelID);
  const hasLiteralMatch = [...candidates.values()].some(
    (candidate) =>
      (!provider || provider.normalized === candidate.provider.normalized) &&
      (model.canonical === candidate.model.canonical ||
        candidate.model.canonical.endsWith(`/${model.canonical}`)),
  );
  const baseModelID = hasLiteralMatch ? parsed.modelID : parsed.baseModelID;
  const baseModel = toSearchText(
    provider || hasLiteralMatch
      ? baseModelID
      : resolveBareModelAlias(baseModelID),
  );
  if ((provider && provider.compact === '') || model.tokens.length === 0) {
    return [];
  }

  const query = { full: fullQuery, provider, model, baseModel };
  return [...candidates.values()]
    .map((candidate) => rankCandidate(candidate, query))
    .filter((ranked): ranked is RankedMatch => ranked !== null)
    .sort(
      (left, right) =>
        left.tier - right.tier ||
        left.detail - right.detail ||
        compareText(left.match.ref, right.match.ref),
    )
    .slice(0, MAX_MATCHES)
    .map(({ match }) => match);
}
