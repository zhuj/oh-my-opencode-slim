/// <reference types="bun-types" />

import { expect, test } from 'bun:test';
import { BackgroundTaskConcurrency } from './background-task-concurrency';

class InspectableScheduler extends BackgroundTaskConcurrency {
  operationalSize() {
    return this.entriesByID.size;
  }
}

test('releases terminal operational entries while preserving dependency history', async () => {
  // Given an injected clock and an admitted prerequisite.
  const scheduler = new InspectableScheduler(
    { defaultConcurrency: 1, providerConcurrency: {}, modelConcurrency: {} },
    { now: () => 123 },
  );
  const first = scheduler.acquire({ parentSessionID: 'parent', id: 'first' });
  await first.ready;
  first.bind('session');
  const next = scheduler.acquire({
    parentSessionID: 'parent',
    dependsOn: ['first'],
  });
  // When the prerequisite completes.
  scheduler.releaseTask('session', 'completed');
  await next.ready;
  // Then only live machinery remains; history and dependency resolution survive.
  expect(scheduler.operationalSize()).toBe(1);
  expect(first.snapshot().completedAt).toBe(123);
  expect(next.snapshot().state).toBe('starting');
  next.release();
  expect(scheduler.operationalSize()).toBe(0);
});

test('releases failed dependency entries and disposed admissions', async () => {
  // Given a queued dependent.
  const scheduler = new InspectableScheduler({
    defaultConcurrency: 1,
    providerConcurrency: {},
    modelConcurrency: {},
  });
  const first = scheduler.acquire({ parentSessionID: 'parent', id: 'first' });
  await first.ready;
  const next = scheduler.acquire({
    parentSessionID: 'parent',
    dependsOn: ['first'],
  });
  const rejected = next.ready.catch((error: unknown) => error);
  // When the prerequisite is cancelled and the runtime is disposed.
  first.release();
  expect(await rejected).toBeInstanceOf(Error);
  scheduler.dispose();
  const late = scheduler.acquire({ parentSessionID: 'parent' });
  await expect(late.ready).rejects.toThrow();
  // Then no dead operational entries remain and IDs do not reuse.
  expect(scheduler.operationalSize()).toBe(0);
  expect(late.id).not.toBe(first.id);
  expect(next.snapshot().state).toBe('error');
});
