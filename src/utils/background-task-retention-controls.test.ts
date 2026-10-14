/// <reference types="bun-types" />

import { expect, test } from 'bun:test';
import { createPendingCallTracker } from '../hooks/task-session-manager/pending-call-tracker';
import { BackgroundTaskConcurrency } from './background-task-concurrency';
import { BackgroundTaskStateStore } from './background-task-state';

const config = {
  defaultConcurrency: 1,
  providerConcurrency: {},
  modelConcurrency: {},
};
const retention = { maxAgeMs: 0, maxPerParent: 0, maxTotal: 0 };

test('running dependents override even zero soft limits', async () => {
  // Given
  const scheduler = new BackgroundTaskConcurrency(config, { retention });
  const root = scheduler.acquire({ id: 'root', parentSessionID: 'parent' });
  root.bind('root');
  const child = scheduler.acquire({
    dependsOn: ['root'],
    parentSessionID: 'parent',
  });
  scheduler.releaseTask('root', 'completed');
  await child.ready;
  child.bind('child');
  scheduler.cleanup();
  expect(root.snapshot().state).toBe('completed');
  expect(child.snapshot().state).toBe('running');
  // When
  child.release();
  // Then
  expect(scheduler.list()).toEqual([]);
});

test.each(['release', 'clearAll'] as const)(
  'pending tracker %s releases the lifecycle pin',
  async (cleanup) => {
    // Given
    const scheduler = new BackgroundTaskConcurrency(config, { retention });
    const tracker = createPendingCallTracker();
    const ticket = scheduler.acquire({
      parentSessionID: 'parent',
      retainRecord: true,
    });
    await ticket.ready;
    ticket.bind('native');
    tracker.add({
      callId: 'call',
      parentSessionId: 'parent',
      agentType: 'explorer',
      label: 'task',
      background: true,
      lifecycleEpoch: 0,
      concurrencyTicket: ticket,
    });
    scheduler.releaseTask('native', 'completed');
    scheduler.dispose();
    expect(ticket.snapshot().state).toBe('completed');
    // When
    switch (cleanup) {
      case 'release': {
        const pending = tracker.take('call');
        if (!pending) throw new Error('Missing pending call');
        scheduler.cleanup();
        expect(ticket.snapshot().state).toBe('completed');
        tracker.release(pending);
        tracker.release(pending);
        break;
      }
      case 'clearAll':
        tracker.clearAll();
        tracker.clearAll();
        break;
    }
    // Then
    expect(scheduler.get(ticket.id)).toBeUndefined();
  },
);

test('queue controls return terminal snapshots even with zero history limits', async () => {
  // Given
  const scheduler = new BackgroundTaskConcurrency(config, { retention });
  scheduler.pauseAdmissions('parent');
  const ticket = scheduler.acquire({ parentSessionID: 'parent' });
  const rejected = ticket.ready.catch((error: unknown) => error);
  // When
  const result = scheduler.manageAdmission(ticket.id, 'parent', 'cancel');
  // Then
  expect(result.state).toBe('cancelled');
  expect(await rejected).toBeInstanceOf(Error);
  expect(scheduler.get(ticket.id)).toBeUndefined();
});

test('clearQueued survives failed cascades evicting records in its batch', async () => {
  // Given
  const scheduler = new BackgroundTaskConcurrency(config, { retention });
  scheduler.pauseAdmissions('parent');
  const first = scheduler.acquire({ id: 'root', parentSessionID: 'parent' });
  const second = scheduler.acquire({
    dependsOn: ['root'],
    parentSessionID: 'parent',
  });
  const settled = Promise.all(
    [first, second].map((ticket) =>
      ticket.ready.catch((error: unknown) => error),
    ),
  );
  // When
  const ids = scheduler.clearQueued('parent');
  // Then
  expect(ids).toEqual([first.id, second.id]);
  expect(await settled).toHaveLength(2);
  expect(scheduler.list()).toEqual([]);
});

test('edited live edges release prerequisites and operational references pin them transitively', () => {
  // Given
  const store = new BackgroundTaskStateStore(() => 0, retention);
  const root = store.create({ logicalID: 'root' });
  store.transition(root.id, 'starting');
  store.bind(root.id, 'native');
  store.terminal(root.id, 'completed');
  const child = store.create({ dependsOn: ['root'] });
  store.compact();
  expect(store.get(root.id)?.state).toBe('completed');
  // When
  store.setDependencies(child.id, []);
  store.compact([root.id]);
  expect(store.get(root.id)?.state).toBe('completed');
  store.compact();
  // Then
  expect(store.get(root.id)).toBeUndefined();
  expect(store.get(child.id)?.state).toBe('queued');
});

test('multiple waiter pins survive one abort and release after the final abort', async () => {
  // Given
  let now = 0;
  const scheduler = new BackgroundTaskConcurrency(
    { ...config, defaultConcurrency: 0 },
    {
      now: () => now,
      retention: { ...retention, maxAgeMs: 10, maxPerParent: 10, maxTotal: 10 },
    },
  );
  const root = scheduler.acquire({ id: 'root', parentSessionID: 'parent' });
  root.bind('native');
  scheduler.releaseTask('native', 'completed');
  scheduler.acquire({ id: 'pending', parentSessionID: 'parent' });
  const controllers = [new AbortController(), new AbortController()];
  const waits = controllers.map((controller) =>
    scheduler
      .waitForTasks('parent', ['root', 'pending'], controller.signal)
      .catch((error: unknown) => error),
  );
  now = 10;
  // When
  controllers[0]?.abort();
  await waits[0];
  scheduler.cleanup();
  expect(root.snapshot().state).toBe('completed');
  controllers[1]?.abort();
  await waits[1];
  // Then
  expect(scheduler.get(root.id)).toBeUndefined();
  scheduler.dispose();
});
