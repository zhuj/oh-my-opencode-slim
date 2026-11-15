import { describe, expect, spyOn, test } from 'bun:test';

import {
  commonEdges,
  type EdgePairing,
  normalizeUnicode,
  pairEdgeHits,
  rescueByLcs,
  rescueByPrefixSuffix,
  sameRescueLine,
  seek,
  seekMatch,
} from './matching';
import type { RescueResult } from './types';

describe('apply-patch/matching', () => {
  test.each([
    ['unicode + trim-end', 'console.log(“hola”);  ', 'console.log("hola");'],
    ['indentation', '  console.log("hola");', 'console.log("hola");'],
    [
      'curly + straight quotes',
      'const title = "it\'s ready";',
      'const title = “it’s ready”;',
    ],
  ])('seek matches %s', (_, fileLine, patchLine) => {
    expect(seek([fileLine], [patchLine], 0)).toBe(0);
  });

  test('prefix and suffix detect common edges', () => {
    const oldLines = [
      'const title = "Hola";',
      'old-value',
      'const footer = "Fin";',
    ];
    const newLines = [
      'const title = “Hola”;',
      'new-value',
      'const footer = “Fin”;',
    ];

    expect(commonEdges(oldLines, newLines, sameRescueLine)).toEqual({
      prefixLength: 1,
      suffixLength: 1,
    });
  });

  test('rescueByPrefixSuffix rescues a stale block with multiline edges', () => {
    const result = rescueByPrefixSuffix(
      ['L1', 'x', 'L1', 'L2 “q”', 'stale', 'R1', 'R2', 'R1', 'y'],
      ['L1', 'L2 "q"', 'old', 'R1', 'R2'],
      ['L1', 'L2 “q”', 'new-value', 'R1', 'R2'],
      0,
    );

    expect(result).toEqual({
      kind: 'match',
      hit: {
        start: 4,
        del: 1,
        add: ['new-value'],
      },
    });
  });

  test('rescueByPrefixSuffix does not anchor on indentation-only edges', () => {
    const result = rescueByPrefixSuffix(
      ['  left', 'stale-value', 'right'],
      ['left', 'old-value', 'right'],
      ['left', 'new-value', 'right'],
      0,
    );

    expect(result).toEqual({ kind: 'miss' });
  });

  test('rescueByPrefixSuffix marks ambiguity when multiple locations exist', () => {
    expect(
      rescueByPrefixSuffix(
        ['left', 'stale-one', 'right', 'gap', 'left', 'stale-two', 'right'],
        ['left', 'old', 'right'],
        ['left', 'new', 'right'],
        0,
      ),
    ).toEqual({ kind: 'ambiguous', phase: 'prefix_suffix' });
  });

  test('rescueByPrefixSuffix preserves one-line unicode plus trim-end pairing', () => {
    expect(
      rescueByPrefixSuffix(
        ['left “x”', 'stale', 'right  '],
        ['left "x"', 'old', 'right'],
        ['left "x"', 'new', 'right'],
        0,
      ),
    ).toEqual({
      kind: 'match',
      hit: {
        start: 1,
        del: 1,
        add: ['new'],
      },
    });
  });

  test('rescueByPrefixSuffix keeps tolerant one-line ambiguity detection', () => {
    expect(
      rescueByPrefixSuffix(
        ['left', 'stale-one', 'right', 'left  ', 'stale-two', 'right'],
        ['left', 'old', 'right'],
        ['left', 'new', 'right'],
        0,
      ),
    ).toEqual({ kind: 'ambiguous', phase: 'prefix_suffix' });
  });

  test('rescueByPrefixSuffix ignores one-line right hits before the left edge', () => {
    expect(
      rescueByPrefixSuffix(
        ['right', 'left', 'stale'],
        ['left', 'old', 'right'],
        ['left', 'new', 'right'],
        0,
      ),
    ).toEqual({ kind: 'miss' });
  });

  test('rescueByLcs respects the start and finds a single candidate', () => {
    const result = rescueByLcs(
      [
        'head',
        'left',
        'stable-old',
        'keep',
        'right',
        'gap',
        'anchor',
        'left',
        'stale-old',
        'keep',
        'right',
        'tail',
      ],
      ['left', 'old', 'keep', 'right'],
      ['left', 'new', 'keep', 'right'],
      5,
    );

    expect(result).toEqual({
      kind: 'match',
      hit: {
        start: 7,
        del: 4,
        add: ['left', 'new', 'keep', 'right'],
      },
    });
  });

  test('rescueByLcs marks ambiguity when two windows tie without common edges', () => {
    expect(
      rescueByLcs(
        ['head', 'alpha', 'beta', 'mid', 'alpha', 'beta', 'tail'],
        ['alpha', 'beta'],
        ['ALPHA', 'BETA'],
        0,
      ),
    ).toEqual({ kind: 'ambiguous', phase: 'lcs' });
  });

  test('rescueByLcs rejects windows with only one matching edge even when the score is high', () => {
    expect(
      rescueByLcs(
        ['a', 'a', 'a', 'a', 'b', 'c'],
        ['a', 'b', 'c', 'd'],
        ['A', 'B', 'C', 'D'],
        0,
      ),
    ).toEqual({ kind: 'miss' });
  });

  test('rescueByLcs prunes a disproportionate chunk even when it has compatible edges', () => {
    const oldLines = Array.from({ length: 49 }, (_, index) => `line-${index}`);
    const lines = [...oldLines];
    lines[24] = 'line-24-stale';

    expect(
      rescueByLcs(
        lines,
        oldLines,
        oldLines.map((line, index) => (index === 24 ? 'line-24-new' : line)),
        0,
      ),
    ).toEqual({ kind: 'miss' });
  });

  test('rescueByLcs discards an implausible window before expensive scoring', () => {
    expect(
      rescueByLcs(
        ['left', 'noise-a', 'keep', 'noise-b', 'right'],
        ['left', 'old-a', 'old-b', 'old-c', 'right'],
        ['left', 'new-a', 'new-b', 'new-c', 'right'],
        0,
      ),
    ).toEqual({ kind: 'miss' });
  });

  test('seekMatch reports when the match was only tolerant and safe', () => {
    expect(
      seekMatch(['console.log(“hola”);  '], ['console.log("hola");'], 0),
    ).toEqual({
      index: 0,
      exact: false,
    });
  });
});

// ---------------------------------------------------------------------------
// Cost guards for the prefix/suffix rescue path.
//
// The oracles below are the pre-optimization algorithms, kept verbatim so the
// linear implementations can be proven to agree without introducing size caps.
// ---------------------------------------------------------------------------

function lowerBound(values: number[], target: number): number {
  let low = 0;
  let high = values.length;

  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (values[middle] < target) {
      low = middle + 1;
      continue;
    }

    high = middle;
  }

  return low;
}

/** Uncapped, nested O(left x right) prefix/suffix rescue. */
function rescueByPrefixSuffixUncapped(
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

  const norm = (line: string) => normalizeUnicode(line.trimEnd());
  const left = old_lines.slice(0, prefixLength).map(norm);
  const right = old_lines.slice(old_lines.length - suffixLength).map(norm);
  const middle = new_lines.slice(prefixLength, new_lines.length - suffixLength);
  const maxDeletion = 2 * (old_lines.length - prefixLength - suffixLength) + 4;
  const normalized = lines.map(norm);
  const leftHits: number[] = [];
  const rightHits: number[] = [];

  for (let index = start; index < normalized.length; index += 1) {
    if (
      normalized[index] === left[0] &&
      left.every((line, offset) => normalized[index + offset] === line)
    ) {
      leftHits.push(index);
    }
    if (
      index > start &&
      normalized[index] === right[0] &&
      right.every((line, offset) => normalized[index + offset] === line)
    ) {
      rightHits.push(index);
    }
  }

  if (leftHits.length === 0 || rightHits.length === 0) {
    return { kind: 'miss' };
  }

  let hit: { start: number; del: number } | undefined;

  for (const leftIndex of leftHits) {
    const from = leftIndex + left.length;

    for (
      let index = lowerBound(rightHits, from);
      index < rightHits.length;
      index += 1
    ) {
      const rightIndex = rightHits[index];
      if (rightIndex - from > maxDeletion) continue;
      if (hit) {
        return { kind: 'ambiguous', phase: 'prefix_suffix' };
      }
      hit = { start: from, del: rightIndex - from };
    }
  }

  if (!hit) {
    return { kind: 'miss' };
  }

  return { kind: 'match', hit: { ...hit, add: [...middle] } };
}

/** Uncapped, nested O(left x right) edge pairing. */
function pairEdgeHitsUncapped(
  leftHits: number[],
  rightHits: number[],
  leftLength: number,
  maxDeletion: number,
): EdgePairing {
  let hit: { start: number; del: number } | undefined;

  for (const leftIndex of leftHits) {
    const from = leftIndex + leftLength;

    for (
      let index = lowerBound(rightHits, from);
      index < rightHits.length;
      index += 1
    ) {
      const rightIndex = rightHits[index];
      if (rightIndex - from > maxDeletion) continue;
      if (hit) return { kind: 'ambiguous' };
      hit = { start: from, del: rightIndex - from };
    }
  }

  if (!hit) return { kind: 'miss' };
  return { kind: 'match', start: hit.start, del: hit.del };
}

function seededRandom(seed: number): () => number {
  let state = seed % 2147483647;
  if (state <= 0) state += 2147483646;

  return () => {
    state = (state * 48271) % 2147483647;
    return state / 2147483647;
  };
}

/** Ascending, unique hit indices, clustered enough to make windows overlap. */
function ascendingHits(random: () => number, limit: number): number[] {
  const hits: number[] = [];
  let index = 0;

  while (index < limit) {
    hits.push(index);
    index += 1 + Math.floor(random() * 4);
  }

  return hits;
}

/**
 * What the rescue scan produces for a file of repeated closing braces: every
 * brace line is an edge hit, and the two halves are too far apart for any gap
 * to fit `maxDeletion`, so nothing pairs.
 */
function repeatedEdgeHits(count: number) {
  return {
    leftHits: Array.from({ length: count }, (_, index) => index * 2),
    rightHits: Array.from(
      { length: count },
      (_, index) => count * 4 + index * 2,
    ),
  };
}

/** Counts source reads, including cache validation but not cached comparisons. */
function countedLines(lines: string[]): {
  lines: string[];
  reads: () => number;
} {
  let reads = 0;

  const proxy = new Proxy(lines, {
    get(target, key, receiver) {
      if (typeof key === 'string' && (key === 'length' || /^\d+$/.test(key))) {
        reads += 1;
      }
      return Reflect.get(target, key, receiver);
    },
  });

  return { lines: proxy, reads: () => reads };
}

function countedSourceIndices(lines: string[]): {
  lines: string[];
  reads: () => number;
} {
  let reads = 0;
  return {
    lines: new Proxy(lines, {
      get(target, key, receiver) {
        if (typeof key === 'string' && /^\d+$/.test(key)) reads += 1;
        return Reflect.get(target, key, receiver);
      },
    }),
    reads: () => reads,
  };
}

function measuredPairing(
  leftHits: number[],
  rightHits: number[],
  leftLength: number,
  maxDeletion: number,
): { value: EdgePairing; probes: number } {
  let probes = 0;

  const count = (values: number[]): number[] =>
    new Proxy(values, {
      get(target, key, receiver) {
        if (typeof key === 'string' && /^\d+$/.test(key)) probes += 1;
        return Reflect.get(target, key, receiver);
      },
    });

  const value = pairEdgeHits(
    count(leftHits),
    count(rightHits),
    leftLength,
    maxDeletion,
  );

  return { value, probes };
}

describe('apply-patch/matching rescue cost guards', () => {
  test('seekMatch rejects starts beyond EOF without reading source indices', () => {
    const counted = countedSourceIndices(Array<string>(10000).fill('filler'));
    expect(seekMatch(counted.lines, ['missing'], 10001)).toBeUndefined();
    expect(counted.reads()).toBe(0);
  });

  test.each([false, true])(
    'seekMatch only reads the examined suffix for a last-line fuzzy match (EOF %s)',
    (eof) => {
      const lines = Array<string>(10000).fill('filler');
      lines[9999] = ' target ';
      const counted = countedSourceIndices(lines);
      expect(seekMatch(counted.lines, ['target'], 9999, eof)).toEqual({
        index: 9999,
        exact: false,
      });
      expect(counted.reads()).toBeLessThanOrEqual(eof ? 5 : 3);
    },
  );

  test('suffix normalization validates mutations and newly examined prefixes', () => {
    const lines = ['prefix ', 'filler', 'tail '];
    expect(seekMatch(lines, ['tail'], 2)).toEqual({ index: 2, exact: false });
    expect(seekMatch(lines, ['prefix'], 0)).toEqual({
      index: 0,
      exact: false,
    });
    lines[2] = 'changed ';
    expect(seekMatch(lines, ['tail'], 2)).toBeUndefined();
    lines.splice(1, 1, 'inserted ', 'tail ');
    expect(seekMatch(lines, ['tail'], 2)).toEqual({ index: 2, exact: false });
    lines.length = 2;
    expect(seekMatch(lines, ['tail'], 2)).toBeUndefined();
    lines.push('updated ');
    expect(seekMatch(lines, ['updated'], 2)).toEqual({
      index: 2,
      exact: false,
    });
  });

  test('negative starts retain native exact, EOF and tolerant error behavior', () => {
    expect(seekMatch(['target'], ['target'], -1)).toEqual({
      index: 0,
      exact: true,
    });
    expect(seekMatch(['target '], ['target'], -1, true)).toEqual({
      index: 0,
      exact: false,
    });
    expect(() => seekMatch(['target '], ['target'], -1)).toThrow(TypeError);
    expect(seekMatch([], [], -1)).toBeUndefined();
    expect(() => seekMatch([], ['target'], -1)).toThrow(TypeError);
  });

  test.each([
    [[], [1], 1, 4, { kind: 'miss' }],
    [[0], [], 1, 4, { kind: 'miss' }],
    [[0], [1], 1, 0, { kind: 'match', start: 1, del: 0 }],
    [[0], [5, 6], 1, 4, { kind: 'match', start: 1, del: 4 }],
    [[0], [1, 5], 1, 4, { kind: 'ambiguous' }],
    [[0, 1], [2], 1, 4, { kind: 'ambiguous' }],
    [[0, 10], [5], 1, 4, { kind: 'match', start: 1, del: 4 }],
  ] satisfies [number[], number[], number, number, EdgePairing][])(
    'pairEdgeHits preserves inclusive bounds for %j / %j',
    (left, right, length, deletion, expected) => {
      expect(pairEdgeHits(left, right, length, deletion)).toEqual(expected);
    },
  );

  test('pairEdgeHits probes linearly on thousands of repeated edge hits', () => {
    const small = repeatedEdgeHits(1000);
    const large = repeatedEdgeHits(4000);

    const smallRun = measuredPairing(small.leftHits, small.rightHits, 1, 4);
    const largeRun = measuredPairing(large.leftHits, large.rightHits, 1, 4);

    expect(smallRun.value).toEqual({ kind: 'miss' });
    expect(largeRun.value).toEqual({ kind: 'miss' });
    expect(largeRun.probes).toBeLessThanOrEqual(8 * 8000);
    // Quadratic pairing would scale 16x with the hit lists; linear stays ~4x.
    expect(largeRun.probes / smallRun.probes).toBeLessThan(6);
  });

  test('pairEdgeHits agrees with the nested scan it replaced', () => {
    const random = seededRandom(0xc0ffee);
    const mismatches: string[] = [];

    for (let round = 0; round < 500; round += 1) {
      const leftHits = ascendingHits(random, 40);
      const rightHits = ascendingHits(random, 40);
      const leftLength = 1 + Math.floor(random() * 3);
      const maxDeletion = Math.floor(random() * 8);
      const actual = JSON.stringify(
        pairEdgeHits(leftHits, rightHits, leftLength, maxDeletion),
      );
      const expected = JSON.stringify(
        pairEdgeHitsUncapped(leftHits, rightHits, leftLength, maxDeletion),
      );

      if (actual !== expected) {
        mismatches.push(
          JSON.stringify({
            leftHits,
            rightHits,
            leftLength,
            maxDeletion,
            actual,
            expected,
          }),
        );
      }
    }

    expect(mismatches).toEqual([]);
  });

  test('rescueByPrefixSuffix agrees with the uncapped rescue inside the bounds', () => {
    const random = seededRandom(0x5eed);
    const vocabulary = [
      'alpha',
      'beta',
      'gamma',
      '}',
      'import {',
      'delta ',
      '“quoted”',
      '',
    ];
    const mismatches: string[] = [];

    const pick = () =>
      vocabulary[Math.floor(random() * vocabulary.length)] as string;
    const respell = (line: string) =>
      random() < 0.5
        ? `${line} `
        : line.replace(/“|”/g, () => (random() < 0.5 ? '“' : '”'));

    for (let round = 0; round < 400; round += 1) {
      const lines = Array.from({ length: Math.floor(random() * 14) }, () =>
        pick(),
      );
      const left = Array.from({ length: 1 + Math.floor(random() * 3) }, () =>
        pick(),
      );
      const right = Array.from({ length: 1 + Math.floor(random() * 3) }, () =>
        pick(),
      );
      const middle = Array.from({ length: Math.floor(random() * 3) }, () =>
        pick(),
      );
      const old_lines = [...left, ...middle, ...right];
      const new_lines = [...left.map(respell), 'replacement', ...right];
      const start = Math.floor(random() * (lines.length + 1));
      const actual = JSON.stringify(
        rescueByPrefixSuffix(lines, old_lines, new_lines, start),
      );
      const expected = JSON.stringify(
        rescueByPrefixSuffixUncapped(lines, old_lines, new_lines, start),
      );

      if (actual !== expected) {
        mismatches.push(
          JSON.stringify({
            lines,
            old_lines,
            new_lines,
            start,
            actual,
            expected,
          }),
        );
      }
    }

    expect(mismatches).toEqual([]);
  });

  test('rescueByPrefixSuffix preserves long edges without a size cap', () => {
    const chunkWith = (edge: number) => {
      const left = Array.from({ length: edge }, (_, index) => `edge-${index}`);
      return {
        old_lines: [...left, 'stale', 'tail'],
        new_lines: [...left, 'fresh', 'tail'],
      };
    };

    const atCap = chunkWith(48);
    const rescued = rescueByPrefixSuffix(
      [...atCap.old_lines],
      atCap.old_lines,
      atCap.new_lines,
      0,
    );

    expect(rescued).toEqual({
      kind: 'match',
      hit: { start: 48, del: 1, add: ['fresh'] },
    });
    expect(rescued).toEqual(
      rescueByPrefixSuffixUncapped(
        [...atCap.old_lines],
        atCap.old_lines,
        atCap.new_lines,
        0,
      ),
    );

    const pastCap = chunkWith(49);
    expect(
      rescueByPrefixSuffixUncapped(
        [...pastCap.old_lines],
        pastCap.old_lines,
        pastCap.new_lines,
        0,
      ),
    ).toEqual({ kind: 'match', hit: { start: 49, del: 1, add: ['fresh'] } });
    expect(
      rescueByPrefixSuffix(
        [...pastCap.old_lines],
        pastCap.old_lines,
        pastCap.new_lines,
        0,
      ),
    ).toEqual({ kind: 'match', hit: { start: 49, del: 1, add: ['fresh'] } });
  });

  test('rescueByPrefixSuffix preserves ambiguity with thousands of hits', () => {
    const old_lines = ['}', 'stale', '}'];
    const new_lines = ['}', 'fresh', '}'];
    const fileOf = (count: number) => Array.from({ length: count }, () => '}');

    const atCap = fileOf(1024);
    expect(rescueByPrefixSuffix(atCap, old_lines, new_lines, 0)).toEqual({
      kind: 'ambiguous',
      phase: 'prefix_suffix',
    });
    expect(rescueByPrefixSuffix(atCap, old_lines, new_lines, 0)).toEqual(
      rescueByPrefixSuffixUncapped(atCap, old_lines, new_lines, 0),
    );

    const pastCap = fileOf(1025);
    expect(
      rescueByPrefixSuffixUncapped(pastCap, old_lines, new_lines, 0),
    ).toEqual({ kind: 'ambiguous', phase: 'prefix_suffix' });
    expect(rescueByPrefixSuffix(pastCap, old_lines, new_lines, 0)).toEqual({
      kind: 'ambiguous',
      phase: 'prefix_suffix',
    });
  });

  test('seekMatch normalizes each file line once per level, not once per offset', () => {
    const lines = Array.from({ length: 2000 }, () => '}');
    const pattern = ['}', '}', '}', '}', '}', '}', '}', 'absent'];
    const counted = countedLines(lines);

    expect(seekMatch(counted.lines, pattern, 0)).toBeUndefined();
    // Exact scanning plus validation/normalization of three tolerant levels.
    expect(counted.reads()).toBeLessThanOrEqual(5 * 2002);

    const afterFirst = counted.reads();
    expect(seekMatch(counted.lines, pattern, 0)).toBeUndefined();
    expect(counted.reads() - afterFirst).toBeLessThanOrEqual(5 * 2002);
  });

  test('seekMatch reuses tolerant normalization after validating mutable contents', () => {
    const lines = Array.from({ length: 100 }, () => '  repeated  ');
    const trimEnd = spyOn(String.prototype, 'trimEnd');
    try {
      expect(seekMatch(lines, ['absent'], 0)).toBeUndefined();
      const first = trimEnd.mock.calls.length;
      expect(first).toBe(lines.length + 1);
      expect(seekMatch(lines, ['absent'], 0)).toBeUndefined();
      expect(trimEnd.mock.calls.length - first).toBe(1);
      lines[50] = 'absent  ';
      const beforeEdit = trimEnd.mock.calls.length;
      expect(seekMatch(lines, ['absent'], 0)).toEqual({
        index: 50,
        exact: false,
      });
      expect(trimEnd.mock.calls.length - beforeEdit).toBe(2);
    } finally {
      trimEnd.mockRestore();
    }
  });

  test('seekMatch agrees with native-style nested scanning for every level and EOF', () => {
    const norms = [
      (line: string) => line,
      (line: string) => line.trimEnd(),
      (line: string) => line.trim(),
      (line: string) => normalizeUnicode(line.trim()),
    ];
    const random = seededRandom(0xbeef);
    const vocabulary = ['a', 'a ', ' a', '“b”', '"b"', '', 'missing'];
    const pick = () => vocabulary[Math.floor(random() * vocabulary.length)];
    for (let round = 0; round < 500; round += 1) {
      const lines = Array.from({ length: Math.floor(random() * 25) }, pick);
      const pattern = Array.from(
        { length: 1 + Math.floor(random() * 7) },
        pick,
      );
      const start = Math.floor(random() * (lines.length + 2));
      const eof = random() < 0.5;
      let expected: ReturnType<typeof seekMatch>;
      for (let level = 0; level < norms.length; level += 1) {
        const norm = norms[level];
        const normalizedPattern = pattern.map(norm);
        const at = (index: number) =>
          normalizedPattern.every(
            (line, offset) => norm(lines[index + offset]) === line,
          );
        const last = lines.length - pattern.length;
        if (eof && last >= start && at(last)) {
          expected = { index: last, exact: level === 0 };
          break;
        }
        for (let index = start; index <= last; index += 1) {
          if (at(index)) {
            expected = { index, exact: level === 0 };
            break;
          }
        }
        if (expected) break;
      }
      expect(seekMatch(lines, pattern, start, eof)).toEqual(expected);
    }
  });

  test('rescueByPrefixSuffix validates contents but reuses normalization across chunks', () => {
    const chunks = Array.from({ length: 4 }, (_, chunkIndex) => ({
      old_lines: [
        `left-${chunkIndex}`,
        `stale-${chunkIndex}`,
        `right-${chunkIndex}`,
      ],
      new_lines: [
        `left-${chunkIndex}`,
        `fresh-${chunkIndex}`,
        `right-${chunkIndex}`,
      ],
    }));
    const lines: string[] = [];
    for (const chunk of chunks) {
      for (let filler = 0; filler < 200; filler += 1) {
        lines.push(`filler-${filler}`);
      }
      lines.push(...chunk.old_lines);
    }

    const counted = countedLines(lines);
    const trimEnd = spyOn(String.prototype, 'trimEnd');
    try {
      const results = chunks.map((chunk) =>
        rescueByPrefixSuffix(
          counted.lines,
          chunk.old_lines,
          chunk.new_lines,
          0,
        ),
      );
      expect(results.every((result) => result.kind === 'match')).toBe(true);
      expect(trimEnd).toHaveBeenCalledTimes(lines.length + 2 * chunks.length);
      expect(counted.reads()).toBeLessThanOrEqual(
        chunks.length * (lines.length + 2),
      );
    } finally {
      trimEnd.mockRestore();
    }
  });

  test('normalization caches invalidate edits, splices and array length changes', () => {
    const lines = ['left  ', 'stale', 'right  '];
    const oldLines = ['left', 'old', 'right'];
    const newLines = ['left', 'new', 'right'];
    expect(rescueByPrefixSuffix(lines, oldLines, newLines, 0).kind).toBe(
      'match',
    );
    expect(seekMatch(lines, ['left'], 0)).toEqual({ index: 0, exact: false });
    lines[0] = 'missing';
    expect(rescueByPrefixSuffix(lines, oldLines, newLines, 0)).toEqual({
      kind: 'miss',
    });
    expect(seekMatch(lines, ['left'], 0)).toBeUndefined();
    lines.splice(0, 1, 'left  ', 'extra');
    expect(rescueByPrefixSuffix(lines, oldLines, newLines, 0)).toEqual({
      kind: 'match',
      hit: { start: 1, del: 2, add: ['new'] },
    });
    lines.length = 1;
    expect(rescueByPrefixSuffix(lines, oldLines, newLines, 0)).toEqual({
      kind: 'miss',
    });
    lines.push('stale', 'right  ');
    expect(rescueByPrefixSuffix(lines, oldLines, newLines, 0).kind).toBe(
      'match',
    );
  });
});
