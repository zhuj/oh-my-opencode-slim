import type {
  LineComparator,
  MatchComparatorName,
  MatchHit,
  RescueResult,
  SeekHit,
} from './types';

const UNICODE_MAP: Record<string, string> = {
  '\u00A0': ' ',
  '\u2010': '-',
  '\u2011': '-',
  '\u2012': '-',
  '\u2013': '-',
  '\u2014': '-',
  '\u2015': '-',
  '\u2018': "'",
  '\u2019': "'",
  '\u201A': "'",
  '\u201B': "'",
  '\u201C': '"',
  '\u201D': '"',
  '\u201E': '"',
  '\u201F': '"',
  '\u2026': '...',
};

export function normalizeUnicode(text: string): string {
  return text.replace(
    /[\u00A0\u2002-\u200A\u2010-\u2015\u2018-\u201F\u2026\u202F\u205F\u2212\u3000]/g,
    (char) => UNICODE_MAP[char] ?? (char === '\u2212' ? '-' : ' '),
  );
}

type NamedComparator = {
  name: MatchComparatorName;
  exact: boolean;
  norm: (line: string) => string;
};

export type PreparedAutoRescueTarget = Record<MatchComparatorName, string>;

const LEVELS: NamedComparator[] = [
  { name: 'exact', exact: true, norm: (line) => line },
  { name: 'trim-end', exact: false, norm: (line) => line.trimEnd() },
  { name: 'trim', exact: false, norm: (line) => line.trim() },
  {
    name: 'unicode-trim',
    exact: false,
    norm: (line) => normalizeUnicode(line.trim()),
  },
];

const MAX_LCS_CHUNK_LINES = 48;
const MAX_LCS_CANDIDATES = 64;

type NormalizedLines = { source: string[]; values: string[] };
const NORMALIZED_LINES = new WeakMap<
  string[],
  Map<NamedComparator['norm'], NormalizedLines>
>();
const normalizeEdgeLine = (line: string) => normalizeUnicode(line.trimEnd());

function normalizedLines(
  lines: string[],
  norm: NamedComparator['norm'],
  start = 0,
): string[] {
  let levels = NORMALIZED_LINES.get(lines);
  if (!levels) {
    levels = new Map();
    NORMALIZED_LINES.set(lines, levels);
  }
  let cached = levels.get(norm);
  if (!cached) {
    cached = { source: [], values: [] };
    levels.set(norm, cached);
  }
  // Callers splice and replace lines between chunks. Identity alone is unsafe;
  // validate the examined suffix, only re-normalizing changed contents.
  const length = lines.length;
  for (let index = start; index < length; index += 1) {
    const line = lines[index];
    if (cached.source[index] !== line) {
      cached.values[index] = norm(line);
      cached.source[index] = line;
    }
  }
  cached.source.length = length;
  cached.values.length = length;
  return cached.values;
}

// KMP preserves overlapping occurrences without re-scanning repeated prefixes.
function* patternHits(
  lines: string[],
  pattern: string[],
  start: number,
): Generator<number> {
  const fallback = Array<number>(pattern.length).fill(0);
  for (let index = 1, matched = 0; index < pattern.length; index += 1) {
    while (matched > 0 && pattern[index] !== pattern[matched]) {
      matched = fallback[matched - 1];
    }
    if (pattern[index] === pattern[matched]) matched += 1;
    fallback[index] = matched;
  }
  const length = lines.length;
  for (let index = start, matched = 0; index < length; index += 1) {
    const line = lines[index];
    while (matched > 0 && line !== pattern[matched]) {
      matched = fallback[matched - 1];
    }
    if (line === pattern[matched]) matched += 1;
    if (matched === pattern.length) {
      yield index - pattern.length + 1;
      matched = fallback[matched - 1];
    }
  }
}

export function prepareAutoRescueTarget(
  target: string,
): PreparedAutoRescueTarget {
  return Object.fromEntries(
    LEVELS.map(({ name, norm }) => [name, norm(target)]),
  ) as PreparedAutoRescueTarget;
}

export function matchesAt(
  candidate: string,
  target: PreparedAutoRescueTarget,
): MatchComparatorName | undefined {
  for (const { name, norm } of LEVELS) {
    if (norm(candidate) === target[name]) return name;
  }
  return undefined;
}

// Native prefers exact, trim-end, trim, then unicode-trim matches across the
// entire file (not the first position that matches any level).
function tryMatch(
  lines: string[],
  pattern: string[],
  start: number,
  eof: boolean,
  norm?: NamedComparator['norm'],
): number | undefined {
  const at = (index: number) => {
    for (let offset = 0; offset < pattern.length; offset += 1) {
      const line = lines[index + offset];
      if ((norm ? norm(line) : line) !== pattern[offset]) return false;
    }
    return true;
  };
  const last = lines.length - pattern.length;
  if (eof && last >= start && at(last)) return last;
  if (last < start) return undefined;
  // Preserve native access/throw behavior for negative starts, including the
  // EOF preference before examining out-of-bounds indices.
  if (start < 0) {
    for (let index = start; index <= last; index += 1) {
      if (at(index)) return index;
    }
    return undefined;
  }
  for (const index of patternHits(lines, pattern, start)) return index;
  return undefined;
}

export function seekMatch(
  lines: string[],
  pattern: string[],
  start: number,
  eof = false,
): SeekHit | undefined {
  if (pattern.length === 0 || start > lines.length - pattern.length) {
    return undefined;
  }

  for (const { norm, exact } of LEVELS) {
    const at = tryMatch(
      exact || start < 0 ? lines : normalizedLines(lines, norm, start),
      pattern.map(norm),
      start,
      eof,
      start < 0 ? norm : undefined,
    );
    if (at !== undefined) {
      return { index: at, exact };
    }
  }

  return undefined;
}

export function seek(
  lines: string[],
  pattern: string[],
  start: number,
  eof = false,
): number {
  return seekMatch(lines, pattern, start, eof)?.index ?? -1;
}

export type EdgePairing =
  | { kind: 'miss' }
  | { kind: 'ambiguous' }
  | { kind: 'match'; start: number; del: number };

// Both hit lists are ascending. The right cursor never moves backwards, and
// only two in-range pairs need inspecting to establish ambiguity.
export function pairEdgeHits(
  leftHits: number[],
  rightHits: number[],
  leftLength: number,
  maxDeletion: number,
): EdgePairing {
  let hit: EdgePairing = { kind: 'miss' };
  let right = 0;
  const rightCount = rightHits.length;
  for (const left of leftHits) {
    const from = left + leftLength;
    while (right < rightCount && rightHits[right] < from) right += 1;
    if (right === rightCount) break;
    const deletion = rightHits[right] - from;
    if (deletion > maxDeletion) continue;
    if (
      hit.kind === 'match' ||
      (right + 1 < rightCount && rightHits[right + 1] - from <= maxDeletion)
    )
      return { kind: 'ambiguous' };
    hit = { kind: 'match', start: from, del: deletion };
  }
  return hit;
}

export function sameRescueLine(a: string, b: string): boolean {
  return a === b || normalizeUnicode(a) === normalizeUnicode(b);
}

export function commonEdges(
  old_lines: string[],
  new_lines: string[],
  same: LineComparator = (a, b) => a === b,
): { prefixLength: number; suffixLength: number } {
  let prefixLength = 0;

  while (
    prefixLength < old_lines.length &&
    prefixLength < new_lines.length &&
    same(old_lines[prefixLength], new_lines[prefixLength])
  ) {
    prefixLength += 1;
  }

  let suffixLength = 0;

  while (
    old_lines.length - suffixLength - 1 >= prefixLength &&
    new_lines.length - suffixLength - 1 >= prefixLength &&
    same(
      old_lines[old_lines.length - suffixLength - 1],
      new_lines[new_lines.length - suffixLength - 1],
    )
  ) {
    suffixLength += 1;
  }

  return { prefixLength, suffixLength };
}

export function rescueByPrefixSuffix(
  lines: string[],
  old_lines: string[],
  new_lines: string[],
  start: number,
): RescueResult {
  const { prefixLength, suffixLength } = commonEdges(
    old_lines,
    new_lines,
    sameRescueLine,
  );

  if (prefixLength === 0 || suffixLength === 0) {
    return { kind: 'miss' };
  }

  // Only the unicode + trim-end level is safe for fuzzy edges. Full-trim
  // would bind stale patches across indentation depths.
  const norm = normalizeEdgeLine;
  const left = old_lines.slice(0, prefixLength).map(norm);
  const right = old_lines.slice(old_lines.length - suffixLength).map(norm);
  const middle = new_lines.slice(prefixLength, new_lines.length - suffixLength);
  const maxDeletion = 2 * (old_lines.length - prefixLength - suffixLength) + 4;
  const normalized = normalizedLines(lines, norm);
  const leftHits = [...patternHits(normalized, left, start)];
  const rightHits = [...patternHits(normalized, right, start + 1)];
  const pairing = pairEdgeHits(leftHits, rightHits, left.length, maxDeletion);
  switch (pairing.kind) {
    case 'miss':
      return { kind: 'miss' };
    case 'ambiguous':
      return { kind: 'ambiguous', phase: 'prefix_suffix' };
    case 'match':
      return {
        kind: 'match',
        hit: { start: pairing.start, del: pairing.del, add: [...middle] },
      };
  }
}

function score(a: string[], b: string[]): number {
  let previous = Array<number>(b.length + 1).fill(0);

  for (let i = 1; i <= a.length; i += 1) {
    const current = Array<number>(b.length + 1).fill(0);

    for (let j = 1; j <= b.length; j += 1) {
      current[j] =
        a[i - 1] === b[j - 1]
          ? previous[j - 1] + 1
          : Math.max(previous[j], current[j - 1]);
    }

    previous = current;
  }

  return previous[b.length];
}

function normalizeLcsLine(line: string): string {
  return normalizeUnicode(line).trim();
}

function countLcsUpperBound(a: string[], b: string[]): number {
  const counts = new Map<string, number>();

  for (const line of a) {
    counts.set(line, (counts.get(line) ?? 0) + 1);
  }

  let shared = 0;
  for (const line of b) {
    const available = counts.get(line) ?? 0;
    if (available === 0) {
      continue;
    }

    shared += 1;
    if (available === 1) {
      counts.delete(line);
      continue;
    }

    counts.set(line, available - 1);
  }

  return shared;
}

function collectBorderAnchoredStarts(
  lines: string[],
  oldLines: string[],
  start: number,
): number[] {
  if (oldLines.length === 0) {
    return [];
  }

  const candidates: number[] = [];
  const firstLine = prepareAutoRescueTarget(oldLines[0]);
  const lastLine = prepareAutoRescueTarget(oldLines[oldLines.length - 1]);

  // LCS keeps the full native-compatible chain at its borders, including
  // full-trim. Only prefix/suffix rescue excludes full-trim edge matches.
  const lastOffset = oldLines.length - 1;
  const maxStart = lines.length - oldLines.length;

  for (let index = start; index <= maxStart; index += 1) {
    const end = index + lastOffset;

    if (matchesAt(lines[index], firstLine) === undefined) {
      continue;
    }

    if (
      oldLines.length === 1 ||
      matchesAt(lines[end], lastLine) !== undefined
    ) {
      candidates.push(index);
    }
  }

  return candidates;
}

export function rescueByLcs(
  lines: string[],
  old_lines: string[],
  new_lines: string[],
  start: number,
): RescueResult {
  if (old_lines.length === 0 || lines.length === 0) {
    return { kind: 'miss' };
  }

  if (old_lines.length > MAX_LCS_CHUNK_LINES) {
    return { kind: 'miss' };
  }

  const needed =
    old_lines.length <= 2
      ? old_lines.length
      : Math.max(2, Math.ceil(old_lines.length * 0.7));
  const candidates = collectBorderAnchoredStarts(lines, old_lines, start);

  if (candidates.length === 0 || candidates.length > MAX_LCS_CANDIDATES) {
    return { kind: 'miss' };
  }

  let best: MatchHit | undefined;
  let bestScore = 0;
  let ties = 0;
  const normalizedOld = old_lines.map(normalizeLcsLine);

  for (const index of candidates) {
    const window = lines
      .slice(index, index + old_lines.length)
      .map(normalizeLcsLine);
    if (countLcsUpperBound(normalizedOld, window) < needed) {
      continue;
    }

    const current = score(normalizedOld, window);

    if (current > bestScore) {
      bestScore = current;
      ties = 1;
      best = {
        start: index,
        del: old_lines.length,
        add: [...new_lines],
      };
      continue;
    }

    if (current === bestScore && current > 0) {
      ties += 1;
    }
  }

  if (!best || bestScore < needed) {
    return { kind: 'miss' };
  }

  if (ties > 1) {
    return { kind: 'ambiguous', phase: 'lcs' };
  }

  return { kind: 'match', hit: best };
}
