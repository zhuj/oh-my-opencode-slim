/// <reference types="bun-types" />

import { expect, test } from 'bun:test';
import { BackgroundTaskConcurrency } from './background-task-concurrency';
import { TaskDependencyError } from './background-task-dependencies';

const config = {
  defaultConcurrency: 1,
  providerConcurrency: {},
  modelConcurrency: {},
};

test.each([1, 2])(
  'bounds diagnostics across a dependency graph of width %i',
  async (width) => {
    // Given: width 1 is a chain; width 2 repeatedly converges and fans out.
    const scheduler = new BackgroundTaskConcurrency(config);
    const root = scheduler.acquire({ id: 'root' });
    root.bind('root-session');
    let previous = [root.id];
    const descendants = [];
    const outcomes = [];
    for (let depth = 0; depth < 14; depth++) {
      const layer = Array.from({ length: width }, () =>
        scheduler.acquire({ dependsOn: previous }),
      );
      descendants.push(...layer);
      outcomes.push(
        ...layer.map((ticket) => ticket.ready.catch((error: unknown) => error)),
      );
      previous = layer.map((ticket) => ticket.id);
    }
    // When
    scheduler.releaseTask('root-session', 'error');
    // Then
    for (const outcome of await Promise.all(outcomes)) {
      expect(outcome).toBeInstanceOf(TaskDependencyError);
    }
    expect(
      Math.max(
        ...descendants.map((ticket) =>
          Buffer.byteLength(ticket.snapshot().dependencyError ?? ''),
        ),
      ),
    ).toBeLessThanOrEqual(4096);
    for (const ticket of descendants) {
      const record = ticket.snapshot();
      expect(record.state).toBe('error');
      expect(
        Buffer.byteLength(record.dependencyError ?? ''),
      ).toBeLessThanOrEqual(4096);
      expect(record.dependencyFailure?.rootCauses).toEqual([
        { id: root.id, logicalID: 'root', state: 'error' },
      ]);
      expect(record.dependencyFailure?.truncated).toBe(false);
    }
    expect(scheduler.snapshot()).toEqual({ active: 0, queued: 0 });
    scheduler.dispose();
  },
);

test('samples at most eight roots deterministically and carries truncation downstream', async () => {
  // Given
  const scheduler = new BackgroundTaskConcurrency(config);
  const roots = Array.from({ length: 10 }, (_, index) => {
    const ticket = scheduler.acquire({ id: `root-${index}` });
    ticket.release();
    return ticket.id;
  });
  // When
  const middle = scheduler.acquire({ dependsOn: roots });
  const last = scheduler.acquire({ dependsOn: [middle.id] });
  await Promise.all([
    middle.ready.catch(() => undefined),
    last.ready.catch(() => undefined),
  ]);
  // Then
  const failure = middle.snapshot().dependencyFailure;
  expect(failure?.code).toBe('TASK_DEPENDENCY_ERROR');
  expect(failure?.directFailed).toHaveLength(8);
  expect(failure?.rootCauses.map((cause) => cause.id)).toEqual(
    roots.slice(0, 8),
  );
  expect(failure?.truncated).toBe(true);
  expect(last.snapshot().dependencyFailure?.rootCauses).toEqual(
    failure?.rootCauses,
  );
  expect(last.snapshot().dependencyFailure?.truncated).toBe(true);
  expect(last.snapshot().state).toBe('error');
  scheduler.dispose();
});

test('caps rendered errors in UTF-8 bytes without splitting a character', () => {
  // Given
  const reason = '界'.repeat(3000);
  // When
  const error = new TaskDependencyError(reason);
  // Then
  expect(Buffer.byteLength(error.message)).toBeLessThanOrEqual(4096);
  expect(error.message).not.toContain('\uFFFD');
  expect(error.diagnostics.truncated).toBe(true);
});
