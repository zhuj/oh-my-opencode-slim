/// <reference types="bun-types" />

import { expect, test } from 'bun:test';
import {
  BackgroundTaskRetention,
  type BackgroundTaskRetentionLimits,
} from './background-task-retention';
import type { BackgroundTaskRecord } from './background-task-state';

type Limits = BackgroundTaskRetentionLimits;

const UNLIMITED: Limits = {
  maxAgeMs: Number.MAX_SAFE_INTEGER,
  maxPerParent: Number.MAX_SAFE_INTEGER,
  maxTotal: Number.MAX_SAFE_INTEGER,
};
const TERMS = 4096;

function record(
  id: string,
  overrides: Partial<BackgroundTaskRecord> = {},
): BackgroundTaskRecord {
  return {
    id,
    logicalID: id,
    dependsOn: [],
    state: 'queued',
    previousSessionIDs: [],
    createdAt: 0,
    queuedAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

function terminal(
  id: string,
  completedAt: number,
  parentSessionID?: string,
  dependsOn: readonly string[] = [],
): BackgroundTaskRecord {
  return record(id, {
    state: 'completed',
    completedAt,
    dependsOn: [...dependsOn],
    ...(parentSessionID ? { parentSessionID } : {}),
  });
}

class CountingMap extends Map<string, BackgroundTaskRecord> {
  lookups = 0;
  override get(key: string): BackgroundTaskRecord | undefined {
    this.lookups += 1;
    return super.get(key);
  }
}

/** Counts record lookups and `completedAt` reads, the two costs the
 * pre-check is meant to remove from an idle publication. */
function probe(records: readonly BackgroundTaskRecord[]) {
  const reads = { completedAt: 0 };
  const map = new CountingMap();
  for (const source of records) {
    const completedAt = source.completedAt;
    map.set(source.id, {
      ...source,
      get completedAt() {
        reads.completedAt += 1;
        return completedAt;
      },
    });
  }
  return { map, reads, lookups: () => map.lookups };
}

function corpus(count: number) {
  const records = Array.from({ length: count }, (_, index) =>
    terminal(`term-${index}`, index, 'parent'),
  );
  return [...records, record('live', { state: 'running' })];
}

test('an idle publication spends one linear pass and no edge walk', () => {
  // Given
  const { map, reads, lookups } = probe(corpus(TERMS));
  const retention = new BackgroundTaskRetention(UNLIMITED);
  // When
  const evicted = retention.candidates(map, TERMS, []);
  // Then
  expect(evicted).toEqual([]);
  // The pre-check reads completedAt once per record. Sorting T terminals adds
  // at least T-1 comparator calls over two reads each, on top of the terminal
  // scan, so a single pass can never reach this ceiling.
  expect(reads.completedAt).toBeLessThan(2 * TERMS);
  expect(lookups()).toBe(0);
});

test('an evictable publication still walks edges and sorts terminals', () => {
  // Given
  const { map, reads, lookups } = probe(corpus(TERMS));
  const retention = new BackgroundTaskRetention({
    maxAgeMs: 100,
    maxPerParent: UNLIMITED.maxPerParent,
    maxTotal: UNLIMITED.maxTotal,
  });
  // When
  const evicted = retention.candidates(map, 100, []);
  // Then
  expect(evicted).toEqual(['term-0']);
  expect(reads.completedAt).toBeGreaterThan(2 * TERMS);
  expect(lookups()).toBe(1);
});

test('repeating an idle publication does not accumulate work', () => {
  // Given
  const { map, reads, lookups } = probe(corpus(64));
  const retention = new BackgroundTaskRetention(UNLIMITED);
  // When
  const publications = Array.from({ length: 8 }, () =>
    retention.candidates(map, 64, []),
  );
  // Then
  expect(publications.every((evicted) => evicted.length === 0)).toBe(true);
  expect(reads.completedAt).toBe(8 * 65);
  expect(lookups()).toBe(0);
});

test('evicts at the age boundary and one tick before it', () => {
  // Given
  const limits = {
    maxAgeMs: 100,
    maxPerParent: UNLIMITED.maxPerParent,
    maxTotal: UNLIMITED.maxTotal,
  };
  const retention = new BackgroundTaskRetention(limits);
  const records = new Map(
    [terminal('aged', 0, 'parent'), terminal('fresh', 1, 'parent')].map(
      (entry) => [entry.id, entry],
    ),
  );
  // When
  const kept = retention.candidates(records, 99, []);
  const evicted = retention.candidates(records, 100, []);
  // Then
  expect(kept).toEqual([]);
  expect(evicted).toEqual(['aged']);
});

test('evicts the oldest terminals past the per-parent soft limit', () => {
  // Given
  const retention = new BackgroundTaskRetention({
    maxAgeMs: UNLIMITED.maxAgeMs,
    maxPerParent: 2,
    maxTotal: UNLIMITED.maxTotal,
  });
  const records = new Map(
    [
      terminal('a', 1, 'parent'),
      terminal('b', 2, 'parent'),
      terminal('c', 3, 'parent'),
      terminal('other', 4, 'other'),
    ].map((entry) => [entry.id, entry]),
  );
  // When
  const evicted = retention.candidates(records, 4, []);
  // Then
  expect(evicted).toEqual(['a']);
});

test('evicts oldest first while the total soft limit unwinds', () => {
  // Given
  const retention = new BackgroundTaskRetention({
    maxAgeMs: UNLIMITED.maxAgeMs,
    maxPerParent: UNLIMITED.maxPerParent,
    maxTotal: 3,
  });
  const records = new Map(
    [
      terminal('a-old', 1, 'parent'),
      terminal('b-old', 2, 'other'),
      terminal('a-new', 3, 'parent'),
      terminal('b-new', 4, 'other'),
    ].map((entry) => [entry.id, entry]),
  );
  // When
  const evicted = retention.candidates(records, 4, []);
  // Then
  expect(evicted).toEqual(['a-old']);
});

test('an over-limit ancestor pinned by a live dependent survives', () => {
  // Given: the count-only pre-check says evictable, the graph disagrees.
  const retention = new BackgroundTaskRetention({
    maxAgeMs: UNLIMITED.maxAgeMs,
    maxPerParent: 1,
    maxTotal: UNLIMITED.maxTotal,
  });
  const records = new Map(
    [
      terminal('root', 1, 'parent'),
      terminal('spare', 2, 'parent'),
      record('leaf', { state: 'queued', dependsOn: ['root'] }),
    ].map((entry) => [entry.id, entry]),
  );
  // When
  const evicted = retention.candidates(records, 2, []);
  // Then
  expect(evicted).toEqual(['spare']);
  expect(records.get('root')?.state).toBe('completed');
});

test('pin and operational roots shield an otherwise evictable set', () => {
  // Given
  const retention = new BackgroundTaskRetention({
    maxAgeMs: 0,
    maxPerParent: 0,
    maxTotal: 0,
  });
  const records = new Map(
    [
      terminal('a', 1, 'parent'),
      terminal('b', 2, 'parent'),
      record('watcher', { state: 'queued', dependsOn: ['a', 'b'] }),
    ].map((entry) => [entry.id, entry]),
  );
  // When / Then: the pre-check trips, the full walk finds no eviction.
  expect(retention.candidates(records, 2, [])).toEqual([]);
  const release = retention.retain(['a']);
  expect(retention.candidates(records, 2, ['b'])).toEqual([]);
  // Pin release alone does not defeat the live graph.
  release();
  expect(retention.candidates(records, 2, [])).toEqual([]);
  // When the dependent goes terminal, the whole cascade becomes evictable.
  records.set('watcher', terminal('watcher', 3, 'parent'));
  // Then
  expect(retention.candidates(records, 2, [])).toEqual(['a', 'b', 'watcher']);
});

test('pin release re-arms the pre-check without losing an eviction', () => {
  // Given
  const retention = new BackgroundTaskRetention({
    maxAgeMs: UNLIMITED.maxAgeMs,
    maxPerParent: 1,
    maxTotal: UNLIMITED.maxTotal,
  });
  const records = new Map(
    [terminal('a', 1, 'parent'), terminal('b', 2, 'parent')].map((entry) => [
      entry.id,
      entry,
    ]),
  );
  const release = retention.retain(['a']);
  expect(retention.candidates(records, 2, [])).toEqual(['b']);
  // When
  release();
  // Then: 'a' is evictable again, and its eviction unwinds the per-parent count.
  expect(retention.candidates(records, 2, [])).toEqual(['a']);
});

// Characterization oracle: the pre-change algorithm, verbatim. Every random
// corpus below must produce byte-identical evictions in the same order.
function reference(
  limits: Limits,
  pinnedIDs: readonly string[],
  records: ReadonlyMap<string, BackgroundTaskRecord>,
  now: number,
  operationalIDs: readonly string[],
): string[] {
  const pending = [...pinnedIDs, ...operationalIDs];
  const terminal: BackgroundTaskRecord[] = [];
  const counts = new Map<string | undefined, number>();
  for (const entry of records.values()) {
    if (entry.completedAt === undefined) pending.push(entry.id);
    else {
      terminal.push(entry);
      counts.set(
        entry.parentSessionID,
        (counts.get(entry.parentSessionID) ?? 0) + 1,
      );
    }
  }
  const pinned = new Set<string>();
  while (pending.length) {
    const id = pending.pop();
    if (id === undefined || pinned.has(id)) continue;
    pinned.add(id);
    for (const dependency of records.get(id)?.dependsOn ?? [])
      pending.push(dependency);
  }
  terminal.sort((a, b) => (a.completedAt ?? 0) - (b.completedAt ?? 0));
  let total = terminal.length;
  const evicted: string[] = [];
  for (const entry of terminal) {
    if (pinned.has(entry.id)) continue;
    const count = counts.get(entry.parentSessionID) ?? 0;
    if (
      now - (entry.completedAt ?? now) < limits.maxAgeMs &&
      count <= limits.maxPerParent &&
      total <= limits.maxTotal
    )
      continue;
    evicted.push(entry.id);
    counts.set(entry.parentSessionID, count - 1);
    total--;
  }
  return evicted;
}

function lcg(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

const ROUNDS = 500;
const NON_FINITE = [
  Number.NaN,
  Number.POSITIVE_INFINITY,
  Number.NEGATIVE_INFINITY,
] as const;

/** Runs one randomized corpus through both the retention policy and the
 * reference walk and requires identical evictions in identical order.
 *
 * `nonFinite` poisons timestamps with NaN and the infinities, which the walk
 * reads as "not provably younger than maxAgeMs" and therefore evicts. */
function differentialRound(random: () => number, nonFinite: boolean): void {
  const pickIndex = (length: number) => Math.floor(random() * length);
  const parents = [undefined, 'parent', 'other'] as const;
  const timestamp = (finite: number) =>
    nonFinite && random() < 0.2 ? NON_FINITE[pickIndex(3)] : finite;
  const ids: string[] = [];
  const entries: BackgroundTaskRecord[] = [];
  for (let index = 0; index < Math.floor(random() * 10); index += 1) {
    const id = `task-${index}`;
    const done = random() < 0.7;
    const dependsOn = ids
      .filter(() => random() < 0.3)
      .concat(random() < 0.15 ? ['missing'] : []);
    entries.push(
      done
        ? terminal(
            id,
            timestamp(Math.floor(random() * 6)),
            parents[pickIndex(parents.length)],
            dependsOn,
          )
        : record(id, { state: 'queued', dependsOn }),
    );
    ids.push(id);
  }
  const records = new Map(entries.map((entry) => [entry.id, entry]));
  const limits: Limits = {
    maxAgeMs: Math.floor(random() * 4),
    maxPerParent: Math.floor(random() * 4),
    maxTotal: Math.floor(random() * 6),
  };
  const now = timestamp(Math.floor(random() * 8));
  const retention = new BackgroundTaskRetention(limits);
  const pins = ids.filter(() => random() < 0.3);
  const operational = ids.filter(() => random() < 0.3);
  const release = retention.retain(pins);
  // Then
  expect(retention.candidates(records, now, operational)).toEqual(
    reference(limits, pins, records, now, operational),
  );
  release();
}

test('pre-check never diverges from the reference eviction walk', () => {
  // Given
  const random = lcg(0x5eed_1234);
  let checked = 0;
  // When
  for (let round = 0; round < ROUNDS; round += 1) {
    differentialRound(random, false);
    checked += 1;
  }
  // Then
  expect(checked).toBe(ROUNDS);
});

test('pre-check never diverges from the reference walk for non-finite times', () => {
  // Given: the injected clock is not validated for finiteness, so its output
  // can reach completedAt and now as NaN or an infinity.
  const random = lcg(0x5eed_5678);
  let checked = 0;
  // When
  for (let round = 0; round < ROUNDS; round += 1) {
    differentialRound(random, true);
    checked += 1;
  }
  // Then
  expect(checked).toBe(ROUNDS);
});

/** Runs a fixed corpus through both policies and returns the evictions. */
function agrees(
  limits: Limits,
  entries: readonly BackgroundTaskRecord[],
  now: number,
  pins: readonly string[] = [],
  operational: readonly string[] = [],
): string[] {
  const records = new Map(entries.map((entry) => [entry.id, entry]));
  const retention = new BackgroundTaskRetention(limits);
  const release = retention.retain(pins);
  const evicted = retention.candidates(records, now, operational);
  expect(evicted).toEqual(reference(limits, pins, records, now, operational));
  release();
  return evicted;
}

const BY_AGE: Limits = {
  maxAgeMs: 100,
  maxPerParent: UNLIMITED.maxPerParent,
  maxTotal: UNLIMITED.maxTotal,
};
const BY_PARENT: Limits = {
  maxAgeMs: UNLIMITED.maxAgeMs,
  maxPerParent: 1,
  maxTotal: UNLIMITED.maxTotal,
};
const BY_TOTAL: Limits = {
  maxAgeMs: UNLIMITED.maxAgeMs,
  maxPerParent: UNLIMITED.maxPerParent,
  maxTotal: 1,
};
const LIVE = record('live', { state: 'running' });

test('ordinary finite corpora agree with the reference walk', () => {
  // Recent: the walk would evict nothing, so this doubles as the
  // short-circuit case.
  expect(agrees(BY_AGE, [terminal('young', 5, 'parent'), LIVE], 10)).toEqual(
    [],
  );
  // Expired, over the per-parent soft limit, over the total soft limit.
  expect(agrees(BY_AGE, [terminal('aged', 0, 'parent'), LIVE], 100)).toEqual([
    'aged',
  ]);
  expect(
    agrees(
      BY_PARENT,
      [terminal('a', 1, 'parent'), terminal('b', 2, 'parent'), LIVE],
      2,
    ),
  ).toEqual(['a']);
  expect(
    agrees(
      BY_TOTAL,
      [terminal('a', 1, 'parent'), terminal('b', 2, 'other'), LIVE],
      2,
    ),
  ).toEqual(['a']);
  // Pinned: over-limit, yet the walk skips it. Over-reporting is the only
  // divergence the pre-check is allowed.
  expect(
    agrees(BY_AGE, [terminal('held', 0, 'parent'), LIVE], 100, ['held']),
  ).toEqual([]);
  expect(
    agrees(
      BY_PARENT,
      [terminal('held', 1, 'parent'), terminal('spare', 2, 'parent'), LIVE],
      2,
      ['held'],
    ),
  ).toEqual(['spare']);
});

test('a recent corpus still short-circuits the walk', () => {
  // Given
  const entries = [terminal('young', 5, 'parent'), LIVE];
  const { map, reads, lookups } = probe(entries);
  const retention = new BackgroundTaskRetention(BY_AGE);
  // When
  const evicted = retention.candidates(map, 10, []);
  // Then
  expect(evicted).toEqual([]);
  // One completedAt read per record and zero edge lookups: the walk was
  // skipped outright rather than entered and found empty. The oracle reads the
  // same counter, so it runs on its own uninstrumented map.
  expect(reads.completedAt).toBe(entries.length);
  expect(lookups()).toBe(0);
  expect(agrees(BY_AGE, entries, 10)).toEqual([]);
});

test('a NaN completedAt falls through to the walk instead of skipping it', () => {
  // Given: KEEP is `now - completedAt < maxAgeMs`, which is false for NaN, so
  // the walk evicts. `now - completedAt >= maxAgeMs` is also false for NaN, so
  // spelling the age term that way silently skipped a real eviction.
  const entries = [
    terminal('young', 5, 'parent'),
    terminal('unreadable', Number.NaN, 'parent'),
    LIVE,
  ];
  const { map, reads, lookups } = probe(entries);
  const retention = new BackgroundTaskRetention(BY_AGE);
  // When
  const evicted = retention.candidates(map, 10, []);
  // Then: byte-identical to the pre-change walk.
  expect(evicted).toEqual(agrees(BY_AGE, entries, 10));
  expect(evicted).toEqual(['unreadable']);
  // The walk ran: it reads completedAt well past one pass, and the live
  // record's dependency lookup only happens inside the walk.
  expect(reads.completedAt).toBeGreaterThan(entries.length);
  expect(lookups()).toBeGreaterThan(0);
});

test('a NaN now falls through to the walk instead of skipping it', () => {
  // Given: `NaN - 5` is NaN, so KEEP is false for every terminal.
  const entries = [terminal('young', 5, 'parent'), LIVE];
  const { map, reads, lookups } = probe(entries);
  const retention = new BackgroundTaskRetention(BY_AGE);
  // When
  const evicted = retention.candidates(map, Number.NaN, []);
  // Then
  expect(evicted).toEqual(agrees(BY_AGE, entries, Number.NaN));
  expect(evicted).toEqual(['young']);
  expect(reads.completedAt).toBeGreaterThan(entries.length);
  expect(lookups()).toBeGreaterThan(0);
});
