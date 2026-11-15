/// <reference types="bun-types" />

import { describe, expect, test } from 'bun:test';
import {
  projectQueueMirror,
  type QueueMirrorProjectionInput,
} from '../queue-mirror';
import {
  BackgroundTaskConcurrency,
  type BackgroundTaskConcurrencyConfig,
  type BackgroundTaskConcurrencyOptions,
  BackgroundTaskConcurrencyQueueCancelledError,
  type BackgroundTaskConcurrencyTicket,
  type BackgroundTaskQueueSnapshot,
  BackgroundTaskTransitionError,
} from './background-task-concurrency';

const CONFIG = {
  defaultConcurrency: 1,
  providerConcurrency: { anthropic: 3 },
  modelConcurrency: { 'openai/special': 2 },
} satisfies BackgroundTaskConcurrencyConfig;

const FIXED_NOW = 1_700_000_000_000;
const MISSING_PARENT = 'parent-missing';

type StoreReadCounts = { readonly list: number; readonly get: number };

interface ListingSource {
  listParentSessionIDs(): string[];
  listQueue(parentSessionID?: string): BackgroundTaskQueueSnapshot[];
  isAdmissionPaused(parentSessionID: string): boolean;
}

/** Mirrors the read pattern of one queue mirror publication. */
function publishProjection(source: ListingSource): QueueMirrorProjectionInput {
  return {
    publisherID: 'publisher',
    runtimeID: 'runtime',
    revision: 1,
    updatedAt: FIXED_NOW,
    parents: [...new Set(source.listParentSessionIDs())].map(
      (parentSessionID) => ({
        parentSessionID,
        paused: source.isAdmissionPaused(parentSessionID),
        queue: source.listQueue(parentSessionID),
      }),
    ),
  };
}

function publishedRecordCount(input: QueueMirrorProjectionInput): number {
  return input.parents.reduce(
    (total, parent) => total + parent.queue.length,
    0,
  );
}

function ignoreRejection(ticket: BackgroundTaskConcurrencyTicket): void {
  ticket.ready.then(
    () => undefined,
    () => undefined,
  );
}

/**
 * Counts production store reads and keeps a verbatim copy of the pre-cache
 * listing algorithm, so both the read volume and the published bytes can be
 * asserted against the same live scheduler.
 */
class ProbedScheduler extends BackgroundTaskConcurrency {
  private counting = false;
  private readonly counts = { list: 0, get: 0 };

  constructor(
    config: BackgroundTaskConcurrencyConfig,
    options: BackgroundTaskConcurrencyOptions = {},
  ) {
    super(config, options);
    const store = this.tasks;
    const list = store.list.bind(store);
    const get = store.get.bind(store);
    store.list = (parentSessionID?: string) => {
      if (this.counting) this.counts.list += 1;
      return list(parentSessionID);
    };
    store.get = (taskID: string) => {
      if (this.counting) this.counts.get += 1;
      return get(taskID);
    };
  }

  get waitingCount(): number {
    return this.waiting.length;
  }

  /** Counts store reads attributable to one publication. */
  measure<T>(publish: () => T): {
    readonly value: T;
    readonly reads: StoreReadCounts;
  } {
    this.counts.list = 0;
    this.counts.get = 0;
    this.counting = true;
    try {
      const value = publish();
      return { value, reads: { ...this.counts } };
    } finally {
      this.counting = false;
    }
  }

  oracleListing(): ListingSource {
    return {
      listParentSessionIDs: () => this.oracleListParentSessionIDs(),
      listQueue: (parentSessionID) => this.oracleListQueue(parentSessionID),
      isAdmissionPaused: (parentSessionID) =>
        this.isAdmissionPaused(parentSessionID),
    };
  }

  /** Verbatim pre-change listQueue. */
  oracleListQueue(parentSessionID?: string): BackgroundTaskQueueSnapshot[] {
    const positions = new Map<string, number>();
    let queuePosition = 0;
    for (const entry of this.waiting) {
      const record = this.tasks.get(entry.id);
      if (record?.state !== 'queued' || this.isRecordPaused(record)) continue;
      positions.set(entry.id, ++queuePosition);
    }
    return this.tasks.list(parentSessionID).map((record) => ({
      record,
      ...(positions.has(record.id)
        ? { queuePosition: positions.get(record.id) }
        : {}),
    }));
  }

  /** Verbatim pre-change listParentSessionIDs. */
  oracleListParentSessionIDs(): string[] {
    const parents = new Set(this.pausedParentSessionIDs);
    for (const record of this.tasks.list()) {
      if (record.parentSessionID !== undefined)
        parents.add(record.parentSessionID);
    }
    return [...parents];
  }
}

/** Labels every byte-level divergence between the cached and pre-cache reads. */
function listingParityFailures(scheduler: ProbedScheduler): string[] {
  const oracle = scheduler.oracleListing();
  const failures: string[] = [];
  const check = (label: string, actual: unknown, expected: unknown): void => {
    const actualJSON = JSON.stringify(actual);
    const expectedJSON = JSON.stringify(expected);
    if (actualJSON !== expectedJSON)
      failures.push(
        `${label}\n  actual:   ${actualJSON}\n  expected: ${expectedJSON}`,
      );
  };
  check(
    'projectQueueMirror',
    projectQueueMirror(publishProjection(scheduler)),
    projectQueueMirror(publishProjection(oracle)),
  );
  check(
    'listParentSessionIDs',
    scheduler.listParentSessionIDs(),
    oracle.listParentSessionIDs(),
  );
  const parents = [
    ...new Set([...scheduler.oracleListParentSessionIDs(), MISSING_PARENT]),
  ];
  for (const parentSessionID of parents) {
    check(
      `listQueue(${parentSessionID})`,
      scheduler.listQueue(parentSessionID),
      scheduler.oracleListQueue(parentSessionID),
    );
  }
  check('listQueue()', scheduler.listQueue(), scheduler.oracleListQueue());
  return failures;
}

/** Fails with the mutation label attached to any parity divergence. */
function assertParity(label: string, scheduler: ProbedScheduler): void {
  expect({ [label]: listingParityFailures(scheduler) }).toEqual({
    [label]: [],
  });
}

describe('BackgroundTaskConcurrency management', () => {
  test('notifies observers for queue lifecycle mutations', async () => {
    // Given
    const events: string[][] = [];
    let scheduler: BackgroundTaskConcurrency;
    scheduler = new BackgroundTaskConcurrency(CONFIG, {
      onQueueChange: () => {
        events.push(
          scheduler
            .listQueue()
            .map(
              ({ record, queuePosition }) =>
                `${record.id}:${record.state}:${queuePosition ?? '-'}`,
            ),
        );
      },
    });

    // When
    const active = scheduler.acquire({ parentSessionID: 'parent-1' });
    await active.ready;
    active.bind('child-active');
    const waiting = scheduler.acquire({ parentSessionID: 'parent-1' });
    waiting.postpone();
    waiting.resume();
    waiting.cancel();
    await expect(waiting.ready).rejects.toBeInstanceOf(
      BackgroundTaskConcurrencyQueueCancelledError,
    );
    scheduler.releaseTask('child-active', 'completed');

    // Then
    expect(
      events.some((event) => event.includes(`${active.id}:queued:1`)),
    ).toBe(true);
    expect(
      events.some((event) => event.includes(`${active.id}:starting:-`)),
    ).toBe(true);
    expect(
      events.some((event) => event.includes(`${waiting.id}:queued:1`)),
    ).toBe(true);
    expect(
      events.some((event) => event.includes(`${waiting.id}:postponed:-`)),
    ).toBe(true);
    expect(
      events.some((event) => event.includes(`${waiting.id}:cancelled:-`)),
    ).toBe(true);
    expect(
      events.some((event) => event.includes(`${active.id}:completed:-`)),
    ).toBe(true);
  });

  test('notifies observers for controls, restore, and migration', () => {
    // Given
    const events: Array<{
      readonly paused: boolean;
      readonly model?: string;
    }> = [];
    let scheduler: BackgroundTaskConcurrency;
    scheduler = new BackgroundTaskConcurrency(CONFIG, {
      onQueueChange: () => {
        events.push({
          paused: scheduler.isAdmissionPaused('parent-1'),
          model: scheduler.list('parent-1')[0]?.model,
        });
      },
    });

    // When
    scheduler.pauseAdmissions('parent-1');
    scheduler.resumeAdmissions('parent-1');
    scheduler.updateLimit({ tier: 'default', limit: 2 });
    scheduler.restoreTask('child-restored', 'openai/gpt-5.6-luna', 'parent-1');
    scheduler.migrateTask('child-restored', 'anthropic/claude-sonnet-4-6');

    // Then
    expect(events.some((event) => event.paused)).toBe(true);
    expect(events.some((event) => event.paused === false)).toBe(true);
    expect(events.length).toBeGreaterThanOrEqual(5);
    expect(events.at(-1)?.model).toBe('anthropic/claude-sonnet-4-6');
  });

  test('isolates admission promises from observer failures', async () => {
    // Given
    const scheduler = new BackgroundTaskConcurrency(CONFIG, {
      onQueueChange: () => {
        throw new Error('observer failed');
      },
    });

    // When
    const ticket = scheduler.acquire({ parentSessionID: 'parent-1' });

    // Then
    await expect(ticket.ready).resolves.toBeUndefined();
    expect(ticket.snapshot().state).toBe('starting');
  });

  test('reports runnable positions and resumes postponed work at the tail', async () => {
    // Given: one active admission followed by two queued admissions.
    const scheduler = new BackgroundTaskConcurrency(CONFIG);
    const active = scheduler.acquire({ parentSessionID: 'parent-1' });
    await active.ready;
    active.bind('child-active');
    const first = scheduler.acquire({ parentSessionID: 'parent-1' });
    const second = scheduler.acquire({ parentSessionID: 'parent-1' });

    // When: the first waiter is postponed and resumed.
    scheduler.manageAdmission(first.id, 'parent-1', 'postpone');
    scheduler.manageAdmission(first.id, 'parent-1', 'resume');

    // Then: only queued admissions have one-based positions in runnable order.
    expect(
      scheduler
        .listQueue('parent-1')
        .map(({ record, queuePosition }) => [record.id, queuePosition]),
    ).toEqual([
      [active.id, undefined],
      [first.id, 2],
      [second.id, 1],
    ]);
  });

  test('isolates paused admission by parent session', async () => {
    // Given: one active task and queued work from two parents.
    const scheduler = new BackgroundTaskConcurrency(CONFIG);
    const active = scheduler.acquire({ parentSessionID: 'parent-active' });
    await active.ready;
    active.bind('child-active');
    const paused = scheduler.acquire({ parentSessionID: 'parent-paused' });
    const runnable = scheduler.acquire({ parentSessionID: 'parent-runnable' });

    // When: one parent is paused and capacity becomes available.
    scheduler.pauseAdmissions('parent-paused');
    scheduler.releaseTask('child-active', 'completed');
    await runnable.ready;

    // Then: another parent's admission starts while paused work stays queued.
    expect(runnable.snapshot().state).toBe('starting');
    expect(paused.snapshot().state).toBe('queued');
    expect(scheduler.isAdmissionPaused('parent-paused')).toBe(true);
    expect(
      scheduler.listQueue('parent-paused')[0]?.queuePosition,
    ).toBeUndefined();

    // When: the parent resumes after capacity is released.
    runnable.bind('child-runnable');
    scheduler.releaseTask('child-runnable', 'completed');
    scheduler.resumeAdmissions('parent-paused');
    await paused.ready;

    // Then: its queued work becomes runnable without affecting other parents.
    expect(paused.snapshot().state).toBe('starting');
    expect(scheduler.isAdmissionPaused('parent-paused')).toBe(false);
  });

  test('rejects unowned and active queue cancellation without releasing capacity', async () => {
    // Given: one admission that has started for parent-1.
    const scheduler = new BackgroundTaskConcurrency(CONFIG);
    const active = scheduler.acquire({ parentSessionID: 'parent-1' });
    await active.ready;

    // When/Then: another parent cannot control it.
    expect(() =>
      scheduler.manageAdmission(active.id, 'parent-2', 'cancel'),
    ).toThrow('Unknown or unowned background task admission');

    // When/Then: its owner cannot queue-cancel starting or running work.
    expect(() =>
      scheduler.manageAdmission(active.id, 'parent-1', 'cancel'),
    ).toThrow(BackgroundTaskTransitionError);
    active.bind('child-active');
    expect(() =>
      scheduler.manageAdmission(active.id, 'parent-1', 'cancel'),
    ).toThrow(BackgroundTaskTransitionError);
    expect(scheduler.snapshot()).toEqual({ active: 1, queued: 0 });
  });

  test('clears only queued and postponed admissions owned by the caller', async () => {
    // Given: an active task and waiting admissions owned by two parents.
    const scheduler = new BackgroundTaskConcurrency(CONFIG);
    const active = scheduler.acquire({ parentSessionID: 'parent-active' });
    await active.ready;
    active.bind('child-active');
    const queued = scheduler.acquire({ parentSessionID: 'parent-1' });
    const postponed = scheduler.acquire({ parentSessionID: 'parent-1' });
    const other = scheduler.acquire({ parentSessionID: 'parent-2' });
    scheduler.manageAdmission(postponed.id, 'parent-1', 'postpone');

    // When: parent-1 clears its queue.
    const cleared = scheduler.clearQueued('parent-1');

    // Then: only parent-1 waiters are cancelled and capacity is unchanged.
    await expect(queued.ready).rejects.toBeInstanceOf(
      BackgroundTaskConcurrencyQueueCancelledError,
    );
    await expect(postponed.ready).rejects.toBeInstanceOf(
      BackgroundTaskConcurrencyQueueCancelledError,
    );
    expect(cleared).toEqual([queued.id, postponed.id]);
    expect(other.snapshot().state).toBe('queued');
    expect(scheduler.snapshot()).toEqual({ active: 1, queued: 1 });
  });

  test('patches one limit without preempting active admissions', async () => {
    // Given: one active and one queued default-tier admission.
    const scheduler = new BackgroundTaskConcurrency(CONFIG);
    const first = scheduler.acquire({ parentSessionID: 'parent-1' });
    await first.ready;
    first.bind('child-first');
    const second = scheduler.acquire({ parentSessionID: 'parent-1' });

    // When: the directory default limit is raised.
    const raised = scheduler.updateLimit({ tier: 'default', limit: 2 });
    await second.ready;
    second.bind('child-second');

    // Then: the waiter starts and unrelated limit maps are preserved.
    expect(raised).toEqual({
      defaultConcurrency: 2,
      providerConcurrency: { anthropic: 3 },
      modelConcurrency: { 'openai/special': 2 },
    });

    // When: the limit is lowered below active usage and another task queues.
    scheduler.updateLimit({ tier: 'default', limit: 1 });
    const third = scheduler.acquire({ parentSessionID: 'parent-1' });
    scheduler.releaseTask('child-first', 'completed');
    await Promise.resolve();

    // Then: active work is not preempted and the waiter remains queued.
    expect(second.snapshot().state).toBe('running');
    expect(third.snapshot().state).toBe('queued');

    // When: the final active slot is released.
    scheduler.releaseTask('child-second', 'completed');
    await third.ready;

    // Then: queued work starts under the lower limit.
    expect(third.snapshot().state).toBe('starting');
  });

  test('scans the global record set once per publication at any parent count', async () => {
    // Given: one publication over a single parent.
    const single = new ProbedScheduler(CONFIG, { now: () => FIXED_NOW });
    const singleActive = single.acquire({ parentSessionID: 'parent-a' });
    await singleActive.ready;
    singleActive.bind('child-a');
    const singleQueued = single.acquire({ parentSessionID: 'parent-a' });
    ignoreRejection(singleQueued);

    // Given: one publication over five parents.
    const many = new ProbedScheduler(CONFIG, { now: () => FIXED_NOW });
    const manyActive = many.acquire({ parentSessionID: 'parent-a' });
    await manyActive.ready;
    manyActive.bind('child-a');
    for (const parentSessionID of ['p1', 'p2', 'p3', 'p4', 'p5']) {
      for (const index of [1, 2]) {
        ignoreRejection(
          many.acquire({ parentSessionID, id: `${parentSessionID}-${index}` }),
        );
      }
    }

    // When: each publisher runs its parent loop once.
    const singlePublish = single.measure(() => publishProjection(single));
    const manyPublish = many.measure(() => publishProjection(many));

    // Then: one global record scan, and body reads linear in records.
    expect(singlePublish.reads.list).toBe(1);
    expect(manyPublish.reads.list).toBe(1);
    expect(singlePublish.reads.get).toBe(
      single.waitingCount + publishedRecordCount(singlePublish.value),
    );
    expect(manyPublish.reads.get).toBe(
      many.waitingCount + publishedRecordCount(manyPublish.value),
    );
    expect(manyPublish.value.parents.length).toBeGreaterThan(
      singlePublish.value.parents.length,
    );

    // And: a warm all-parents read costs no further global scan.
    expect(many.measure(() => many.listQueue()).reads.list).toBe(0);
  });

  test('projects mirror bytes identical to the pre-cache listing algorithm', async () => {
    // Given: several parents, one paused with queued work, one paused empty.
    const scheduler = new ProbedScheduler(CONFIG, { now: () => FIXED_NOW });
    const active = scheduler.acquire({ parentSessionID: 'parent-active' });
    await active.ready;
    active.bind('child-active');
    const activeQueued = scheduler.acquire({
      parentSessionID: 'parent-active',
    });
    const runnable = scheduler.acquire({ parentSessionID: 'parent-runnable' });
    const postponed = scheduler.acquire({ parentSessionID: 'parent-runnable' });
    const pausedQueued = scheduler.acquire({
      parentSessionID: 'parent-paused',
    });
    for (const ticket of [activeQueued, runnable, postponed, pausedQueued])
      ignoreRejection(ticket);
    scheduler.manageAdmission(postponed.id, 'parent-runnable', 'postpone');
    scheduler.restoreTask(
      'child-restored',
      'openai/special',
      'parent-restored',
    );
    scheduler.pauseAdmissions('parent-paused');
    scheduler.pauseAdmissions('parent-empty');

    // Then: every required shape is present in the matrix under comparison.
    expect(scheduler.listQueue(MISSING_PARENT)).toEqual([]);
    expect(scheduler.listQueue('parent-empty')).toEqual([]);
    expect(scheduler.isAdmissionPaused('parent-empty')).toBe(true);
    expect(scheduler.listQueue('parent-paused')).toHaveLength(1);
    expect(
      scheduler.listQueue('parent-paused')[0]?.queuePosition,
    ).toBeUndefined();
    expect(listingParityFailures(scheduler)).toEqual([]);
  });

  test('keeps listing parity across queue and content mutations', async () => {
    // Given: one active admission plus waiters from three more parents.
    const scheduler = new ProbedScheduler(CONFIG, { now: () => FIXED_NOW });
    const active = scheduler.acquire({ parentSessionID: 'parent-active' });
    await active.ready;
    active.bind('child-active');
    const first = scheduler.acquire({ parentSessionID: 'parent-1' });
    const second = scheduler.acquire({ parentSessionID: 'parent-2' });
    const third = scheduler.acquire({ parentSessionID: 'parent-3' });
    for (const ticket of [first, second, third]) ignoreRejection(ticket);
    assertParity('initial', scheduler);

    // When: 15 mutations run, each followed by a parity re-check.
    let orphan: BackgroundTaskConcurrencyTicket | undefined;
    const mutations: Array<readonly [string, () => void]> = [
      [
        'postpone',
        () => scheduler.manageAdmission(second.id, 'parent-2', 'postpone'),
      ],
      [
        'resume reorders the waiting tail',
        () => scheduler.manageAdmission(second.id, 'parent-2', 'resume'),
      ],
      [
        'postpone the next waiter',
        () => scheduler.manageAdmission(third.id, 'parent-3', 'postpone'),
      ],
      [
        'resume reorders it again',
        () => scheduler.manageAdmission(third.id, 'parent-3', 'resume'),
      ],
      [
        'pause a parent with queued work',
        () => scheduler.pauseAdmissions('parent-3'),
      ],
      [
        'pause an empty parent',
        () => scheduler.pauseAdmissions('parent-empty'),
      ],
      ['resume a parent', () => scheduler.resumeAdmissions('parent-3')],
      [
        'resume an empty parent',
        () => scheduler.resumeAdmissions('parent-empty'),
      ],
      [
        'acquire an unbound admission',
        () => {
          orphan = scheduler.acquire({ parentSessionID: 'parent-orphan' });
          ignoreRejection(orphan);
        },
      ],
      ['release an unbound admission', () => void orphan?.release()],
      ['clearQueued', () => void scheduler.clearQueued('parent-1')],
      ['cancel', () => scheduler.cancel(second.id)],
      [
        'restoreTask',
        () =>
          scheduler.restoreTask(
            'child-restored',
            'openai/special',
            'parent-restored',
          ),
      ],
      [
        'migrateTask',
        () =>
          scheduler.migrateTask(
            'child-restored',
            'anthropic/claude-sonnet-4-6',
          ),
      ],
      [
        'setDependencies',
        () => void scheduler.setDependencies(third.id, 'parent-3', []),
      ],
    ];
    expect(mutations.length).toBe(15);
    for (const [label, mutate] of mutations) {
      mutate();
      assertParity(label, scheduler);
    }

    // When: capacity frees up and the remaining waiter starts and binds.
    scheduler.releaseTask('child-active', 'completed');
    assertParity('releaseTask starts a waiter', scheduler);
    await third.ready;
    third.bind('child-third');
    assertParity('bind', scheduler);

    // When: limits change and the started waiter is released.
    scheduler.updateLimit({ tier: 'default', limit: 2 });
    assertParity('updateLimit', scheduler);
    scheduler.releaseTask('child-third', 'completed');
    assertParity('releaseTask', scheduler);
    scheduler.cleanup();
    assertParity('cleanup', scheduler);
  });
});
