/// <reference types="bun-types" />

import { describe, expect, test } from 'bun:test';
import {
  BackgroundTaskConcurrency,
  BackgroundTaskConcurrencyQueueCancelledError,
  BackgroundTaskTransitionError,
} from './background-task-concurrency';

const config = {
  defaultConcurrency: 1,
  providerConcurrency: {},
  modelConcurrency: {},
};

describe('BackgroundTaskConcurrency task records', () => {
  test('exposes stable metadata before and after child-session assignment', async () => {
    // Given: a deterministic admission clock and one background task.
    let now = 100;
    const scheduler = new BackgroundTaskConcurrency(config, {
      now: () => now,
    });

    // When: the task is admitted, assigned, and completed.
    const ticket = scheduler.acquire({
      model: 'openai/gpt-5.6-sol',
      parentSessionID: 'parent-1',
    });
    await ticket.ready;
    const admissionID = ticket.id;
    now = 200;
    ticket.bind('child-1');
    now = 300;
    scheduler.releaseTask('child-1', 'completed');

    // Then: one stable record retains lifecycle, routing, sessions, and time.
    expect(ticket.id).toBe(admissionID);
    expect(scheduler.get(admissionID)).toEqual({
      id: admissionID,
      logicalID: admissionID,
      dependsOn: [],
      state: 'completed',
      model: 'openai/gpt-5.6-sol',
      provider: 'openai',
      parentSessionID: 'parent-1',
      assignedSessionID: 'child-1',
      previousSessionIDs: [],
      createdAt: 100,
      queuedAt: 100,
      startedAt: 100,
      assignedAt: 200,
      updatedAt: 300,
      completedAt: 300,
    });
  });

  test('retains the earlier child session when work is relaunched', async () => {
    // Given: one completed child session followed by a resumed admission.
    const scheduler = new BackgroundTaskConcurrency(config);
    const original = scheduler.acquire({ parentSessionID: 'parent-1' });
    await original.ready;
    original.bind('child-1');
    scheduler.releaseTask('child-1', 'completed');

    // When: the resumed admission is assigned to the same native session.
    const resumed = scheduler.acquire({
      parentSessionID: 'parent-1',
      previousSessionID: 'child-1',
    });
    await resumed.ready;
    resumed.bind('child-1');

    // Then: its stable record retains the earlier child-session association.
    expect(resumed.snapshot()).toMatchObject({
      state: 'running',
      parentSessionID: 'parent-1',
      assignedSessionID: 'child-1',
      previousSessionIDs: ['child-1'],
    });
  });

  test('postpones queued work without consuming capacity or starting it', async () => {
    // Given: one active task and two queued tasks.
    const scheduler = new BackgroundTaskConcurrency(config);
    const active = scheduler.acquire({ parentSessionID: 'parent-1' });
    await active.ready;
    active.bind('child-active');
    const postponed = scheduler.acquire({ parentSessionID: 'parent-1' });
    const runnable = scheduler.acquire({ parentSessionID: 'parent-1' });

    // When: the earlier waiter is postponed and capacity becomes available.
    postponed.postpone();
    scheduler.releaseTask('child-active', 'completed');
    await runnable.ready;

    // Then: runnable work starts while postponed work remains listable last.
    expect(postponed.snapshot().state).toBe('postponed');
    expect(scheduler.snapshot()).toEqual({ active: 1, queued: 0 });
    expect(scheduler.list().at(-1)?.id).toBe(postponed.id);
    let postponedReady = false;
    void postponed.ready.then(() => {
      postponedReady = true;
    });
    await Promise.resolve();
    expect(postponedReady).toBe(false);
  });

  test('resumes postponed work at the runnable queue tail', async () => {
    // Given: one active task followed by two queued tasks.
    const scheduler = new BackgroundTaskConcurrency(config);
    const active = scheduler.acquire({});
    await active.ready;
    active.bind('child-active');
    const second = scheduler.acquire({});
    const third = scheduler.acquire({});
    const order: string[] = [];
    void second.ready.then(() => order.push('second'));
    void third.ready.then(() => order.push('third'));

    // When: the second task is postponed, resumed, and capacity is released.
    second.postpone();
    second.resume();
    scheduler.releaseTask('child-active', 'completed');
    await third.ready;
    third.bind('child-third');
    scheduler.releaseTask('child-third', 'completed');
    await second.ready;

    // Then: the task that stayed runnable starts before the resumed task.
    expect(order).toEqual(['third', 'second']);
  });

  test('cancels queued and postponed tickets without disturbing active work', async () => {
    // Given: an active task, a queued task, and a postponed task.
    const scheduler = new BackgroundTaskConcurrency(config);
    const active = scheduler.acquire({});
    await active.ready;
    active.bind('child-active');
    const queued = scheduler.acquire({});
    const postponed = scheduler.acquire({});
    postponed.postpone();

    // When: both waiting tickets are explicitly cancelled.
    queued.cancel();
    postponed.cancel();

    // Then: both waiters reject and the active slot remains untouched.
    await expect(queued.ready).rejects.toBeInstanceOf(
      BackgroundTaskConcurrencyQueueCancelledError,
    );
    await expect(postponed.ready).rejects.toBeInstanceOf(
      BackgroundTaskConcurrencyQueueCancelledError,
    );
    expect(queued.snapshot().state).toBe('cancelled');
    expect(postponed.snapshot().state).toBe('cancelled');
    expect(scheduler.snapshot()).toEqual({ active: 1, queued: 0 });
  });

  test('disposal releases queued, postponed, and active records safely', async () => {
    // Given: one active task plus queued and postponed waiters.
    const scheduler = new BackgroundTaskConcurrency(config);
    const active = scheduler.acquire({});
    await active.ready;
    active.bind('child-active');
    const queued = scheduler.acquire({});
    const postponed = scheduler.acquire({});
    postponed.postpone();

    // When: the scheduler is disposed.
    scheduler.dispose();

    // Then: every waiter is released and every record is cancelled.
    await expect(queued.ready).rejects.toBeInstanceOf(
      BackgroundTaskConcurrencyQueueCancelledError,
    );
    await expect(postponed.ready).rejects.toBeInstanceOf(
      BackgroundTaskConcurrencyQueueCancelledError,
    );
    expect(scheduler.list().map((record) => record.state)).toEqual([
      'cancelled',
      'cancelled',
      'cancelled',
    ]);
    expect(scheduler.snapshot()).toEqual({ active: 0, queued: 0 });
  });

  test('rejects queue controls after a task begins starting or finishes', async () => {
    // Given: a starting task, a queued task, and a completed task record.
    const scheduler = new BackgroundTaskConcurrency(config);
    const starting = scheduler.acquire({});
    await starting.ready;
    const queued = scheduler.acquire({});

    // When/Then: controls outside their valid source state fail explicitly.
    expect(() => starting.postpone()).toThrow(BackgroundTaskTransitionError);
    expect(() => queued.resume()).toThrow(BackgroundTaskTransitionError);
    starting.bind('child-starting');
    expect(() => starting.postpone()).toThrow(BackgroundTaskTransitionError);

    queued.cancel();
    await expect(queued.ready).rejects.toBeInstanceOf(
      BackgroundTaskConcurrencyQueueCancelledError,
    );

    scheduler.releaseTask('child-starting', 'completed');
    expect(() => scheduler.cancel(starting.id)).toThrow(
      BackgroundTaskTransitionError,
    );
  });
});
