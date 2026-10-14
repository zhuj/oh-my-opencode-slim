/// <reference types="bun-types" />

import { expect, test } from 'bun:test';
import type {
  BackgroundTaskConcurrencyConfig,
  BackgroundTaskConcurrencyOptions,
  BackgroundTaskConcurrencyRequest,
  BackgroundTaskConcurrencyTicket,
} from './background-task-concurrency';
import { BackgroundTaskConcurrency } from './background-task-concurrency';
import {
  type DependencyEvaluation,
  evaluateTaskDependencies,
  TaskDependencyError,
} from './background-task-dependencies';
import type { BackgroundTaskRecord } from './background-task-state';

type SchedulerCtor = new (
  config: BackgroundTaskConcurrencyConfig,
  options?: BackgroundTaskConcurrencyOptions,
) => ProbedScheduler;

/**
 * Counts production store reads. Every `store.get` returns a fresh record
 * snapshot, so this is the same cost the old two-pass pump scan paid once per
 * queued entry per dequeue.
 */
class ProbedScheduler extends BackgroundTaskConcurrency {
  private counting = false;
  private storeReads = 0;

  constructor(
    config: BackgroundTaskConcurrencyConfig,
    options: BackgroundTaskConcurrencyOptions = {},
  ) {
    super(config, options);
    const store = this.tasks;
    const get = store.get.bind(store);
    store.get = (taskID: string) => {
      if (this.counting) this.storeReads += 1;
      return get(taskID);
    };
  }

  measure<T>(operation: () => T): {
    readonly value: T;
    readonly storeReads: number;
  } {
    this.storeReads = 0;
    this.counting = true;
    try {
      return { value: operation(), storeReads: this.storeReads };
    } finally {
      this.counting = false;
    }
  }
}

/** The pre-fix pump, verbatim: the oracle for admission-order equivalence. */
class LegacyProbedScheduler extends ProbedScheduler {
  protected override pump(): void {
    if (this.disposed) return;
    while (!this.disposed) {
      const evaluations = new Map<string, DependencyEvaluation>();
      const failed = this.waiting.find((entry) => {
        const evaluation = evaluateTaskDependencies(
          this.legacyDependenciesOf(entry.id),
        );
        evaluations.set(entry.id, evaluation);
        return evaluation.state === 'blocked';
      });
      if (failed) {
        const error = new TaskDependencyError(
          'Task prerequisite failed',
          evaluations.get(failed.id)?.dependencies,
        );
        this.tasks.failDependency(failed.id, error);
        this.waiting.splice(this.waiting.indexOf(failed), 1);
        failed.released = true;
        failed.reject?.(error);
        failed.resolve = undefined;
        failed.reject = undefined;
        this.entriesByID.delete(failed.id);
        this.notifyQueueChange();
        continue;
      }
      const index = this.waiting.findIndex((entry) => {
        const record = this.tasks.get(entry.id);
        return (
          record?.state === 'queued' &&
          (entry.bypassCapacity || !this.isRecordPaused(record)) &&
          evaluations.get(entry.id)?.state === 'ready' &&
          (entry.bypassCapacity || this.capacity.canStart(entry))
        );
      });
      if (index < 0) return;
      const [entry] = this.waiting.splice(index, 1);
      if (!entry || entry.released) continue;
      this.tasks.transition(entry.id, 'starting');
      this.active.add(entry);
      if (!entry.bypassCapacity) this.capacity.track(entry);
      this.notifyQueueChange();
      if (!this.disposed && !entry.released && this.active.has(entry)) {
        entry.resolve?.();
        entry.resolve = undefined;
        entry.reject = undefined;
      }
    }
  }

  private legacyDependenciesOf(id: string): BackgroundTaskRecord[] {
    return this.requireSnapshot(id).dependsOn.map((dependency) =>
      this.requireSnapshot(dependency),
    );
  }
}

const PRIMARY = 'primary';
const SECONDARY = 'secondary';
/** The only model tier with its own limit, so it caps one entry at a time. */
const SPECIAL = 'openai/special';

const MIXED_CONFIG = {
  defaultConcurrency: 2,
  providerConcurrency: { anthropic: 2 },
  modelConcurrency: { [SPECIAL]: 1 },
} satisfies BackgroundTaskConcurrencyConfig;

const LIMITED_CONFIG = {
  defaultConcurrency: 1,
  providerConcurrency: {},
  modelConcurrency: {},
} satisfies BackgroundTaskConcurrencyConfig;

const TWO_SLOT_CONFIG = {
  defaultConcurrency: 2,
  providerConcurrency: {},
  modelConcurrency: {},
} satisfies BackgroundTaskConcurrencyConfig;

function ignoreRejection(ticket: BackgroundTaskConcurrencyTicket): void {
  ticket.ready.then(
    () => undefined,
    () => undefined,
  );
}

type Reentrant = { current: (() => void) | undefined };

/**
 * Records admission order from the publication stream. One record reaches
 * `starting` per publication, so the notification order is the admission order,
 * and the reentrant hook runs afterwards so nested publications sort by the
 * time they actually happened.
 */
function createRecordingScheduler(
  Ctor: SchedulerCtor,
  config: BackgroundTaskConcurrencyConfig,
  reentrant: Reentrant,
  started: string[],
): ProbedScheduler {
  const seen = new Set<string>();
  let scheduler: ProbedScheduler;
  scheduler = new Ctor(config, {
    onQueueChange: () => {
      for (const record of scheduler.list()) {
        if (record.state === 'queued' || record.state === 'postponed') continue;
        if (seen.has(record.logicalID)) continue;
        seen.add(record.logicalID);
        started.push(record.logicalID);
      }
      reentrant.current?.();
    },
  });
  return scheduler;
}

/**
 * One deterministic mixed workload: a paused parent, model and provider tiers,
 * dependency edges, a reentrant admission from inside a publication, postpone
 * and resume, retargeted dependencies, limit changes and a failed prerequisite.
 *
 * Settlement is only observable after a microtask checkpoint, so the workload
 * awaits its own readiness reactions instead of reporting a pre-checkpoint copy.
 * Reaction order is meaningful: it is the order in which the pump resolved or
 * rejected each entry, so it is kept rather than sorted away.
 */
async function runMixedWorkload(
  scheduler: ProbedScheduler,
  reentrant: Reentrant,
): Promise<WorkloadResult> {
  const settled: string[] = [];
  const settlements: Promise<void>[] = [];
  const tickets: BackgroundTaskConcurrencyTicket[] = [];
  const logicalIDs: string[] = [];
  let seed = 0x5eed;

  const pick = (bound: number): number => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed % bound;
  };

  const admit = (request: BackgroundTaskConcurrencyRequest): void => {
    const ticket = scheduler.acquire(request);
    ignoreRejection(ticket);
    tickets.push(ticket);
    if (request.id !== undefined) logicalIDs.push(request.id);
    settlements.push(
      ticket.ready.then(
        () => {
          settled.push(`resolved:${request.id ?? ''}`);
        },
        () => {
          settled.push(`rejected:${request.id ?? ''}`);
        },
      ),
    );
  };

  const stateOf = (
    ticket: BackgroundTaskConcurrencyTicket,
  ): BackgroundTaskRecord['state'] => ticket.snapshot().state;

  // Classified while paused, so the resume drains a queue whose plan predates it.
  scheduler.pauseAdmissions(PRIMARY);
  for (let index = 0; index < 9; index++) {
    admit({
      id: `bulk-${index}`,
      parentSessionID: PRIMARY,
      model: index % 3 === 0 ? 'openai/special' : 'anthropic/claude',
    });
  }

  let admitted = 0;
  reentrant.current = () => {
    if (admitted >= 4) return;
    admitted += 1;
    admit({ id: `reentrant-${admitted}`, parentSessionID: PRIMARY });
  };
  scheduler.resumeAdmissions(PRIMARY);
  reentrant.current = undefined;

  for (let index = 0; index < 6; index++) {
    admit({
      id: `chain-${index}`,
      parentSessionID: PRIMARY,
      dependsOn: [logicalIDs[pick(logicalIDs.length)] ?? 'bulk-0'],
    });
  }

  // Bind and complete a slice: the only way dependents become ready.
  let bound = 0;
  for (const ticket of tickets) {
    if (bound >= 3) break;
    const state = stateOf(ticket);
    if (state !== 'starting' && state !== 'running') continue;
    bound += 1;
    const taskID = `ses-${ticket.snapshot().logicalID}`;
    ticket.bind(taskID);
    scheduler.releaseTask(taskID, 'completed');
  }

  const retargetable = tickets.find((ticket) => {
    const state = stateOf(ticket);
    return state === 'queued' || state === 'postponed';
  });
  if (retargetable) {
    const target =
      logicalIDs.find((id) => id !== retargetable.snapshot().logicalID) ??
      'bulk-0';
    scheduler.setDependencies(retargetable.id, PRIMARY, [target]);
  }

  scheduler.pauseAdmissions(SECONDARY);
  for (let index = 0; index < 4; index++) {
    admit({ id: `other-${index}`, parentSessionID: SECONDARY });
  }
  scheduler.resumeAdmissions(SECONDARY);

  // Capacity accounting moves twice while entries are waiting.
  scheduler.updateLimit({ tier: 'default', limit: 1 });
  scheduler.updateLimit({ tier: 'default', limit: 0 });

  // Reorders the queue behind the pump's back.
  const postponable = tickets.find((ticket) => stateOf(ticket) === 'queued');
  if (postponable) {
    scheduler.postpone(postponable.id);
    scheduler.resume(postponable.id);
  }

  // A failed prerequisite, so the blocked branch propagates to its dependents.
  const victim = tickets.find((ticket) => {
    const state = stateOf(ticket);
    return state === 'running' || state === 'starting';
  });
  if (victim) {
    const taskID = `ses-${victim.snapshot().logicalID}`;
    victim.bind(taskID);
    scheduler.releaseTask(taskID, 'cancelled');
  }

  for (const ticket of tickets) {
    const state = stateOf(ticket);
    if (state === 'queued' || state === 'postponed')
      scheduler.cancel(ticket.id);
    else if (state === 'running' || state === 'starting') ticket.release();
  }

  // Every ticket now holds a terminal record, so every readiness promise is
  // settled. Draining the recorded reactions is the checkpoint that populates
  // `settled`, and it is also the completeness proof: a readiness promise left
  // pending never resolves this await, and a settled one always contributes
  // exactly one observation the cardinality assertion below can count.
  await Promise.all(settlements);

  return {
    finalStates: scheduler.list().map((record) => ({
      logicalID: record.logicalID,
      state: record.state,
      directFailed:
        record.dependencyFailure?.directFailed.map(
          (cause) => `${cause.logicalID}:${cause.state}`,
        ) ?? [],
      rootCauses:
        record.dependencyFailure?.rootCauses.map(
          (cause) => `${cause.logicalID}:${cause.state}`,
        ) ?? [],
    })),
    settled: [...settled],
    admissions: tickets.length,
    active: scheduler.snapshot().active,
    queued: scheduler.snapshot().queued,
  };
}

type WorkloadResult = {
  readonly finalStates: readonly unknown[];
  readonly settled: readonly string[];
  readonly admissions: number;
  readonly active: number;
  readonly queued: number;
};

test('admits a mixed workload in the same order as the pre-fix pump', async () => {
  // Given two schedulers that differ only in the pump implementation.
  const fixedStarted: string[] = [];
  const fixedReentrant: Reentrant = { current: undefined };
  const fixed = createRecordingScheduler(
    ProbedScheduler,
    MIXED_CONFIG,
    fixedReentrant,
    fixedStarted,
  );
  const legacyStarted: string[] = [];
  const legacyReentrant: Reentrant = { current: undefined };
  const legacy = createRecordingScheduler(
    LegacyProbedScheduler,
    MIXED_CONFIG,
    legacyReentrant,
    legacyStarted,
  );
  // When both run the same workload and every readiness promise has settled.
  const expected = await runMixedWorkload(legacy, legacyReentrant);
  const actual = await runMixedWorkload(fixed, fixedReentrant);
  // Then admission order, dependency causes and settlement all match.
  expect(fixedStarted).toEqual(legacyStarted);
  expect(fixedStarted.length).toBeGreaterThan(8);
  expect(actual.finalStates).toEqual(expected.finalStates);
  expect(actual.settled).toEqual(expected.settled);
  // The settlement comparison only carries weight if the checkpoint populated
  // it: one observation per admitted request, resolved or rejected.
  expect(actual.admissions).toBe(expected.admissions);
  expect(actual.admissions).toBe(actual.finalStates.length);
  expect(actual.settled.length).toBe(actual.admissions);
  expect(expected.settled.length).toBe(expected.admissions);
  // And it stays sharp rather than collapsing into an all-of-one-kind list.
  expect(
    actual.settled.filter((observation) => observation.startsWith('rejected:'))
      .length,
  ).toBeGreaterThan(0);
  expect(
    actual.settled.filter((observation) => observation.startsWith('resolved:'))
      .length,
  ).toBeGreaterThan(0);
  expect({ active: actual.active, queued: actual.queued }).toEqual({
    active: expected.active,
    queued: expected.queued,
  });
  fixed.dispose();
  legacy.dispose();
});

test('admits a reentrant burst in the same order as the pre-fix pump', () => {
  // Given publications that admit further entries from inside the pump.
  const build = (
    Ctor: SchedulerCtor,
  ): {
    readonly scheduler: ProbedScheduler;
    readonly started: string[];
  } => {
    const started: string[] = [];
    const reentrant: Reentrant = { current: undefined };
    const scheduler = createRecordingScheduler(
      Ctor,
      MIXED_CONFIG,
      reentrant,
      started,
    );
    scheduler.pauseAdmissions(PRIMARY);
    for (let index = 0; index < 12; index++)
      ignoreRejection(
        scheduler.acquire({ id: `seed-${index}`, parentSessionID: PRIMARY }),
      );
    scheduler.updateLimit({ tier: 'default', limit: 0 });
    let admitted = 0;
    reentrant.current = () => {
      if (admitted >= 10) return;
      admitted += 1;
      ignoreRejection(
        scheduler.acquire({
          id: `late-${admitted}`,
          parentSessionID: PRIMARY,
        }),
      );
    };
    scheduler.resumeAdmissions(PRIMARY);
    reentrant.current = undefined;
    return { scheduler, started };
  };
  // When
  const legacy = build(LegacyProbedScheduler);
  const fixed = build(ProbedScheduler);
  // Then both admit the same entries in the same order.
  expect(fixed.started).toEqual(legacy.started);
  expect(fixed.started.length).toBe(22);
  expect(fixed.scheduler.snapshot()).toEqual(legacy.scheduler.snapshot());
  fixed.scheduler.dispose();
  legacy.scheduler.dispose();
});

test('honors a prerequisite completed from inside a pump publication', async () => {
  // Given a dependent whose prerequisite slot is only freed by a publication
  // that has to complete the prerequisite to make progress. `holder` and
  // `filler` share the single `openai/special` slot, so releasing `filler` is
  // the only thing that can admit `mid`, which shares that same slot.
  const started: string[] = [];
  const seen = new Set<string>();
  const observerFaults: string[] = [];
  let scheduler: ProbedScheduler;
  let acted = false;
  scheduler = new ProbedScheduler(MIXED_CONFIG, {
    onQueueChange: () => {
      try {
        for (const record of scheduler.list()) {
          if (record.state === 'queued' || record.state === 'postponed')
            continue;
          if (seen.has(record.logicalID)) continue;
          seen.add(record.logicalID);
          started.push(record.logicalID);
        }
        // The filler ticket exists before this can run: `acquire` publishes
        // before it returns, so an entry acquired inline would leave the
        // reference below in its temporal dead zone.
        if (acted || !seen.has('filler')) return;
        acted = true;
        scheduler.releaseTask('ses-root', 'completed');
        filler.release();
      } catch (error) {
        // The production boundary drops observer errors, so a fault here would
        // otherwise pass unnoticed behind a green test.
        observerFaults.push(String(error));
      }
    },
  });
  const root = scheduler.acquire({ id: 'root', parentSessionID: PRIMARY });
  await root.ready;
  root.bind('ses-root');
  const mid = scheduler.acquire({
    id: 'mid',
    parentSessionID: PRIMARY,
    dependsOn: ['root'],
    model: SPECIAL,
  });
  const leaf = scheduler.acquire({
    id: 'leaf',
    parentSessionID: PRIMARY,
    dependsOn: ['mid'],
  });
  const holder = scheduler.acquire({
    id: 'holder',
    parentSessionID: PRIMARY,
    model: SPECIAL,
  });
  await holder.ready;
  // Queued rather than admitted: the shared model slot is held by `holder`.
  const filler = scheduler.acquire({
    id: 'filler',
    parentSessionID: PRIMARY,
    model: SPECIAL,
  });
  for (const ticket of [mid, leaf, filler]) ignoreRejection(ticket);
  expect(filler.snapshot().state).toBe('queued');
  // When the publication that starts `filler` completes the prerequisite.
  holder.release();
  // Then `mid` is admitted by that publication, and only because releasing
  // `filler` freed the one model slot `mid` shares with it.
  expect(observerFaults).toEqual([]);
  expect(acted).toBe(true);
  expect(filler.snapshot().state).toBe('cancelled');
  expect(mid.snapshot().state).toBe('starting');
  expect(started).toEqual(['root', 'holder', 'filler', 'mid']);
  // And the chain drains on from there.
  await mid.ready;
  mid.bind('ses-mid');
  scheduler.releaseTask('ses-mid', 'completed');
  await leaf.ready;
  expect(leaf.snapshot().state).toBe('starting');
  expect(mid.snapshot().state).toBe('completed');
  expect(mid.snapshot().startedAt).toBeNumber();
  expect(scheduler.snapshot()).toEqual({ active: 1, queued: 0 });
  scheduler.dispose();
});

test('stops admitting when an observer pauses the parent mid-pump', async () => {
  // Given a parent paused from inside a publication. `pauseAdmissions`
  // notifies without pumping, so nothing but a rebuild stops the drain.
  const started: string[] = [];
  const seen = new Set<string>();
  let scheduler: ProbedScheduler;
  let acted = false;
  scheduler = new ProbedScheduler(TWO_SLOT_CONFIG, {
    onQueueChange: () => {
      for (const record of scheduler.list()) {
        if (record.state === 'queued' || record.state === 'postponed') continue;
        if (seen.has(record.logicalID)) continue;
        seen.add(record.logicalID);
        started.push(record.logicalID);
      }
      if (acted || started.length < 1) return;
      acted = true;
      scheduler.pauseAdmissions(PRIMARY);
    },
  });
  const tickets = ['a', 'b', 'c', 'd'].map((id) =>
    scheduler.acquire({ id, parentSessionID: PRIMARY }),
  );
  for (const ticket of tickets) ignoreRejection(ticket);
  // When the first admission pauses the parent.
  await tickets[0]?.ready;
  // Then the remaining entries stay queued despite free capacity.
  expect(acted).toBe(true);
  expect(started).toEqual(['a']);
  expect(tickets.map((ticket) => ticket.snapshot().state)).toEqual([
    'starting',
    'queued',
    'queued',
    'queued',
  ]);
  expect(scheduler.snapshot()).toEqual({ active: 1, queued: 3 });
  scheduler.dispose();
});

test('drops a stale admission plan when an observer pauses mid-drain', async () => {
  // Given spare capacity, so the pause is the only thing that can hold `fourth`
  // back. `pauseAdmissions` notifies without pumping, so only rebuilding the
  // plan can withdraw an admission the plan already marked admissible.
  const started: string[] = [];
  const seen = new Set<string>();
  let scheduler: ProbedScheduler;
  let pausing = false;
  scheduler = new ProbedScheduler(TWO_SLOT_CONFIG, {
    onQueueChange: () => {
      for (const record of scheduler.list()) {
        if (record.state === 'queued' || record.state === 'postponed') continue;
        if (seen.has(record.logicalID)) continue;
        seen.add(record.logicalID);
        started.push(record.logicalID);
      }
      if (!pausing) return;
      scheduler.pauseAdmissions(PRIMARY);
    },
  });
  const tickets = ['first', 'second', 'third', 'fourth'].map((id) =>
    scheduler.acquire({ id, parentSessionID: PRIMARY }),
  );
  for (const ticket of tickets) ignoreRejection(ticket);
  await tickets[1]?.ready;
  // When lifting the limit drains the queue and the publication pauses the parent.
  pausing = true;
  scheduler.updateLimit({ tier: 'default', limit: 0 });
  // Then the withdrawn admission stays queued.
  await tickets[2]?.ready;
  expect(started).toEqual(['first', 'second', 'third']);
  expect(scheduler.isAdmissionPaused(PRIMARY)).toBe(true);
  expect(tickets[3]?.snapshot().state).toBe('queued');
  expect(scheduler.snapshot()).toEqual({ active: 3, queued: 1 });
  scheduler.dispose();
});

test('leaves a dependent queued when its prerequisite never completes', () => {
  // Given the same queue with no reentrant completion.
  const scheduler = new ProbedScheduler(TWO_SLOT_CONFIG);
  const root = scheduler.acquire({ id: 'root', parentSessionID: PRIMARY });
  const mid = scheduler.acquire({
    id: 'mid',
    parentSessionID: PRIMARY,
    dependsOn: ['root'],
  });
  const filler = scheduler.acquire({ id: 'filler', parentSessionID: PRIMARY });
  ignoreRejection(root);
  ignoreRejection(mid);
  ignoreRejection(filler);
  // When capacity is freed without completing the prerequisite.
  filler.release();
  // Then the dependent still waits, so the test above names the real cause.
  expect(mid.snapshot().state).toBe('queued');
  expect(scheduler.snapshot()).toEqual({ active: 1, queued: 1 });
  scheduler.dispose();
});

test('propagates a failed prerequisite to the dependent waiting entries', async () => {
  // Given the only slot consumed, a dependency chain and a bystander.
  const scheduler = new ProbedScheduler(LIMITED_CONFIG);
  const root = scheduler.acquire({ id: 'root', parentSessionID: PRIMARY });
  await root.ready;
  root.bind('ses-root');
  const lead = scheduler.acquire({ id: 'lead', parentSessionID: PRIMARY });
  const mid = scheduler.acquire({
    id: 'mid',
    parentSessionID: PRIMARY,
    dependsOn: ['root'],
  });
  const leaf = scheduler.acquire({
    id: 'leaf',
    parentSessionID: PRIMARY,
    dependsOn: ['mid'],
  });
  const outcomes = [lead, mid, leaf].map((ticket) =>
    ticket.ready.then(
      () => 'resolved',
      (error: unknown) => error,
    ),
  );
  // When the prerequisite is cancelled.
  scheduler.releaseTask('ses-root', 'cancelled');
  // Then only the dependents fail, each blamed on its own direct cause.
  const settled = await Promise.all(outcomes);
  expect(settled[0]).toBe('resolved');
  expect(settled[1]).toBeInstanceOf(TaskDependencyError);
  expect(settled[2]).toBeInstanceOf(TaskDependencyError);
  expect(mid.snapshot().state).toBe('error');
  expect(mid.snapshot().dependencyFailure?.directFailed).toEqual([
    { id: expect.any(String), logicalID: 'root', state: 'cancelled' },
  ]);
  expect(leaf.snapshot().state).toBe('error');
  expect(leaf.snapshot().dependencyFailure?.directFailed).toEqual([
    { id: expect.any(String), logicalID: 'mid', state: 'error' },
  ]);
  expect(
    leaf
      .snapshot()
      .dependencyFailure?.rootCauses.map((cause) => cause.logicalID),
  ).toEqual(['root']);
  expect(lead.snapshot().state).toBe('starting');
  scheduler.dispose();
});

test('reads the queue once per drained burst instead of once per dequeue', () => {
  // Given a deep queue held back by the default limit. Zero means unlimited.
  const drain = (
    Ctor: SchedulerCtor,
    depth: number,
  ): {
    readonly scheduler: ProbedScheduler;
    readonly storeReads: number;
  } => {
    const scheduler = new Ctor(LIMITED_CONFIG);
    for (let index = 0; index < depth; index++)
      ignoreRejection(scheduler.acquire({ parentSessionID: PRIMARY }));
    const { storeReads } = scheduler.measure(() =>
      scheduler.updateLimit({ tier: 'default', limit: 0 }),
    );
    return { scheduler, storeReads };
  };
  // When one publication drains the whole queue.
  const fixed32 = drain(ProbedScheduler, 32);
  const fixed64 = drain(ProbedScheduler, 64);
  const legacy32 = drain(LegacyProbedScheduler, 32);
  const legacy64 = drain(LegacyProbedScheduler, 64);
  // Then the fixed pump scales linearly while the pre-fix one grew quadratically.
  expect(fixed32.storeReads).toBeLessThanOrEqual(4 * 32);
  expect(fixed64.storeReads).toBeLessThanOrEqual(4 * 64);
  expect(legacy32.storeReads).toBeGreaterThan(8 * 32);
  expect(legacy64.storeReads).toBeGreaterThan(8 * 64);
  // Doubling the depth doubles the fixed cost and quadruples the legacy cost.
  expect(fixed64.storeReads).toBeLessThan(fixed32.storeReads * 3);
  expect(legacy64.storeReads).toBeGreaterThan(legacy32.storeReads * 3);
  for (const drained of [fixed32, fixed64, legacy32, legacy64])
    expect(drained.scheduler.snapshot().queued).toBe(0);
  expect(fixed64.scheduler.snapshot()).toEqual(legacy64.scheduler.snapshot());
  for (const drained of [fixed32, fixed64, legacy32, legacy64])
    drained.scheduler.dispose();
});

test('disposing an ignored readiness promise does not leak an unhandled rejection', async () => {
  const scheduler = new BackgroundTaskConcurrency(LIMITED_CONFIG);
  const unhandled: unknown[] = [];
  const captureUnhandled = (reason: unknown) => unhandled.push(reason);
  process.on('unhandledRejection', captureUnhandled);

  try {
    const active = scheduler.acquire({ parentSessionID: 'parent' });
    await active.ready;
    active.bind('active');
    scheduler.acquire({ parentSessionID: 'parent' });

    scheduler.dispose();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(unhandled).toEqual([]);
  } finally {
    process.off('unhandledRejection', captureUnhandled);
    scheduler.dispose();
  }
});
