/// <reference types="bun-types" />

import { expect, test } from 'bun:test';
import {
  BackgroundTaskConcurrency,
  BackgroundTaskConcurrencyQueueCancelledError,
} from './background-task-concurrency';

const config = {
  defaultConcurrency: 1,
  providerConcurrency: {},
  modelConcurrency: {},
};

test.each([false, true])(
  'rejects readiness when an observer disposes during starting (bypass %s)',
  async (bypassCapacity) => {
    // Given
    const scheduler = new BackgroundTaskConcurrency(config, {
      onQueueChange: () => {
        if (scheduler.list().some((record) => record.state === 'starting')) {
          scheduler.dispose();
        }
      },
    });
    // When
    const ticket = scheduler.acquire({ bypassCapacity });
    const outcome = ticket.ready.then(
      () => 'resolved',
      (error: unknown) => error,
    );
    ticket.release();
    scheduler.dispose();
    // Then
    expect(await outcome).toBeInstanceOf(
      BackgroundTaskConcurrencyQueueCancelledError,
    );
    expect(ticket.snapshot().state).toBe('cancelled');
    expect(scheduler.snapshot()).toEqual({ active: 0, queued: 0 });
  },
);

test('reentrant release rejects starting readiness without releasing the next slot twice', async () => {
  // Given
  let observe = () => {};
  const scheduler = new BackgroundTaskConcurrency(config, {
    onQueueChange: () => observe(),
  });
  const active = scheduler.acquire({});
  const cancelled = scheduler.acquire({});
  const next = scheduler.acquire({});
  const last = scheduler.acquire({});
  const outcome = cancelled.ready.catch((error: unknown) => error);
  observe = () => {
    if (cancelled.snapshot().state === 'starting') {
      cancelled.release();
      cancelled.release();
    }
  };
  // When
  active.release();
  // Then
  expect(await outcome).toBeInstanceOf(
    BackgroundTaskConcurrencyQueueCancelledError,
  );
  await next.ready;
  expect(last.snapshot().state).toBe('queued');
  expect(scheduler.snapshot()).toEqual({ active: 1, queued: 1 });
  next.release();
  await last.ready;
  expect(scheduler.snapshot()).toEqual({ active: 1, queued: 0 });
  scheduler.dispose();
});

test('cancellation during starting rejects once and disposal drains remaining waiters', async () => {
  // Given
  let observe = () => {};
  const scheduler = new BackgroundTaskConcurrency(config, {
    onQueueChange: () => observe(),
  });
  scheduler.pauseAdmissions('parent');
  const tickets = Array.from({ length: 3 }, () =>
    scheduler.acquire({ parentSessionID: 'parent' }),
  );
  const outcomes = tickets.map((ticket) =>
    ticket.ready.then(
      () => 'resolved',
      (error: unknown) => error,
    ),
  );
  observe = () => {
    const starting = scheduler
      .list()
      .find((record) => record.state === 'starting');
    if (!starting) return;
    observe = () => scheduler.dispose();
    scheduler.cancel(starting.id);
    scheduler.dispose();
  };
  // When
  scheduler.resumeAdmissions('parent');
  // Then
  for (const outcome of await Promise.all(outcomes)) {
    expect(outcome).toBeInstanceOf(
      BackgroundTaskConcurrencyQueueCancelledError,
    );
  }
  expect(scheduler.list().map((record) => record.state)).toEqual([
    'cancelled',
    'cancelled',
    'cancelled',
  ]);
  expect(scheduler.snapshot()).toEqual({ active: 0, queued: 0 });
});
