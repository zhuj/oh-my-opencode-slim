/// <reference types="bun-types" />

import { expect, test } from 'bun:test';
import { BackgroundTaskConcurrency } from './background-task-concurrency';

const config = {
  defaultConcurrency: 0,
  providerConcurrency: {},
  modelConcurrency: {},
};

function fixture() {
  let now = 0;
  const scheduler = new BackgroundTaskConcurrency(config, {
    now: () => now,
    retention: { maxAgeMs: 100, maxPerParent: 2, maxTotal: 3 },
  });
  const complete = (id: string, parentSessionID = 'parent') => {
    const ticket = scheduler.acquire({ id, parentSessionID });
    ticket.bind(id);
    scheduler.releaseTask(id, 'completed');
    return ticket;
  };
  return {
    scheduler,
    complete,
    advance: (value: number) => {
      now = value;
    },
  };
}

test('evicts at the injected age boundary only on cleanup and never reuses admission IDs', () => {
  // Given
  const { scheduler, complete, advance } = fixture();
  const old = complete('logical');
  advance(99);
  scheduler.cleanup();
  expect(old.snapshot().state).toBe('completed');
  advance(100);
  expect(old.snapshot().state).toBe('completed');
  // When
  scheduler.cleanup();
  // Then
  expect(() => old.snapshot()).toThrow(/not found/);
  expect(() =>
    scheduler.acquire({ parentSessionID: 'parent', dependsOn: [old.id] }),
  ).toThrow(/Unknown/);
  expect(complete('logical').id).not.toBe(old.id);
});

test('evicts oldest terminal records by parent and runtime soft counts', () => {
  // Given
  const { scheduler, complete } = fixture();
  const first = complete('first');
  const second = complete('second');
  // When
  complete('third');
  complete('other', 'other');
  complete('last', 'last');
  // Then
  expect(scheduler.get(first.id)).toBeUndefined();
  expect(scheduler.get(second.id)).toBeUndefined();
  expect(scheduler.list()).toHaveLength(3);
});

test('live dependency chains pin terminal ancestors until cascade eligibility', () => {
  // Given
  const { scheduler, complete, advance } = fixture();
  const root = complete('root');
  const middle = scheduler.acquire({
    id: 'middle',
    parentSessionID: 'parent',
    dependsOn: ['root'],
  });
  middle.bind('middle');
  scheduler.releaseTask('middle', 'completed');
  scheduler.pauseAdmissions('parent');
  const leaf = scheduler.acquire({
    parentSessionID: 'parent',
    dependsOn: ['middle'],
  });
  void leaf.ready.catch(() => undefined);
  leaf.postpone();
  advance(100);
  scheduler.cleanup();
  expect(root.snapshot().state).toBe('completed');
  expect(middle.snapshot().state).toBe('completed');
  // When
  leaf.cancel();
  // Then
  expect(scheduler.get(root.id)).toBeUndefined();
  expect(scheduler.get(middle.id)).toBeUndefined();
});

test.each(['success', 'failure', 'abort', 'dispose'] as const)(
  'waiter pins are released on %s',
  async (outcome) => {
    // Given
    const { scheduler, complete, advance } = fixture();
    const root = complete('root');
    const pending = scheduler.acquire({
      id: 'pending',
      parentSessionID: 'parent',
    });
    pending.bind('pending');
    const controller = new AbortController();
    const waiting = scheduler.waitForTasks(
      'parent',
      ['root', 'pending'],
      controller.signal,
    );
    const settled = waiting.catch((error: unknown) => error);
    advance(100);
    scheduler.cleanup();
    expect(root.snapshot().state).toBe('completed');
    // When
    switch (outcome) {
      case 'success':
        scheduler.releaseTask('pending', 'completed');
        break;
      case 'failure':
        pending.release();
        break;
      case 'abort':
        controller.abort();
        break;
      case 'dispose':
        scheduler.dispose();
        break;
    }
    const result = await settled;
    // Then
    if (outcome === 'success') expect(Array.isArray(result)).toBe(true);
    else expect(result).toBeInstanceOf(Error);
    expect(scheduler.get(root.id)).toBeUndefined();
    scheduler.dispose();
  },
);

test('pending lifecycle references pin terminal records until idempotent cleanup', () => {
  // Given
  const { scheduler, advance } = fixture();
  const ticket = scheduler.acquire({
    id: 'pending',
    parentSessionID: 'parent',
    retainRecord: true,
  });
  ticket.bind('native');
  scheduler.releaseTask('native', 'completed');
  advance(100);
  scheduler.cleanup();
  expect(ticket.snapshot().state).toBe('completed');
  // When
  ticket.releaseIfUnbound();
  ticket.releaseIfUnbound();
  // Then
  expect(scheduler.get(ticket.id)).toBeUndefined();
});

test('a replacement scheduler cannot resolve old admission IDs', () => {
  // Given
  const { scheduler, complete, advance } = fixture();
  const old = complete('old');
  advance(100);
  // When
  scheduler.dispose();
  const replacement = new BackgroundTaskConcurrency(config);
  const next = replacement.acquire({ parentSessionID: 'parent' });
  // Then
  expect(scheduler.get(old.id)).toBeUndefined();
  expect(next.id).not.toBe(old.id);
  expect(() =>
    replacement.acquire({ parentSessionID: 'parent', dependsOn: [old.id] }),
  ).toThrow(/Unknown/);
  replacement.dispose();
});
