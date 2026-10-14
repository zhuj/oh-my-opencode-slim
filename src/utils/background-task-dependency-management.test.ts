/// <reference types="bun-types" />
import { expect, test } from 'bun:test';
import { BackgroundTaskConcurrency } from './background-task-concurrency';

function fixture() {
  const scheduler = new BackgroundTaskConcurrency({
    defaultConcurrency: 1,
    providerConcurrency: {},
    modelConcurrency: {},
  });
  scheduler.pauseAdmissions('parent');
  const first = scheduler.acquire({ id: 'first', parentSessionID: 'parent' });
  const second = scheduler.acquire({
    id: 'second',
    parentSessionID: 'parent',
    dependsOn: ['first'],
  });
  void first.ready.catch((error: unknown) => error);
  void second.ready.catch((error: unknown) => error);
  return { scheduler, first, second };
}

test('rejects cycles atomically when mutating queued dependencies', () => {
  // Given
  const { scheduler, first, second } = fixture();
  // When / Then
  expect(() =>
    scheduler.setDependencies(first.id, 'parent', ['second']),
  ).toThrow(/cycle/);
  expect(first.snapshot().dependsOn).toEqual([]);
  expect(() => scheduler.setDependencies(second.id, 'other', [])).toThrow();
  expect(() =>
    scheduler.setDependencies(second.id, 'parent', ['first', first.id]),
  ).toThrow(/Duplicate/);
  expect(second.snapshot().dependsOn).toEqual([first.id]);
  scheduler.dispose();
});

test('repumps after clearing dependencies and rejects mutation after starting', async () => {
  // Given
  const { scheduler, first, second } = fixture();
  first.postpone();
  scheduler.resumeAdmissions('parent');
  // When
  scheduler.setDependencies(second.id, 'parent', []);
  await second.ready;
  // Then
  expect(second.snapshot().state).toBe('starting');
  expect(() =>
    scheduler.setDependencies(second.id, 'parent', ['first']),
  ).toThrow(/queued/);
  scheduler.dispose();
});

test('wait resolves only after every requested task completes', async () => {
  // Given
  const { scheduler, first, second } = fixture();
  let completed = false;
  const waiting = scheduler
    .waitForTasks('parent', ['first', 'second'])
    .then((result) => {
      completed = true;
      return result;
    });
  scheduler.resumeAdmissions('parent');
  await first.ready;
  first.bind('ses_first');
  scheduler.releaseTask('ses_first', 'completed');
  await second.ready;
  expect(completed).toBe(false);
  second.bind('ses_second');
  // When
  scheduler.releaseTask('ses_second', 'completed');
  // Then
  expect((await waiting).map((task) => task.state)).toEqual([
    'completed',
    'completed',
  ]);
  scheduler.dispose();
});

test('wait fails on cancellation without waiting for other tasks', async () => {
  // Given
  const { scheduler, first } = fixture();
  const waiting = scheduler
    .waitForTasks('parent', ['first', 'second'])
    .catch((error: unknown) => error);
  // When
  first.cancel();
  // Then
  expect(await waiting).toBeInstanceOf(Error);
  await expect(scheduler.waitForTasks('parent', ['missing'])).rejects.toThrow(
    /missing/,
  );
  scheduler.dispose();
});

test('wait abort cleans up its subscription without cancelling the task', async () => {
  // Given
  const { scheduler, first } = fixture();
  const controller = new AbortController();
  const waiting = scheduler
    .waitForTasks('parent', ['first'], controller.signal)
    .catch((error: unknown) => error);
  // When
  controller.abort();
  // Then
  expect(await waiting).toBeInstanceOf(Error);
  expect(first.snapshot().state).toBe('queued');
  scheduler.dispose();
});

test('clears a dependency chain without trying to cancel already failed descendants', () => {
  // Given
  const { scheduler, first, second } = fixture();
  // When
  const cleared = scheduler.clearQueued('parent');
  // Then
  expect(cleared).toEqual([first.id, second.id]);
  expect(scheduler.snapshot().queued).toBe(0);
  scheduler.dispose();
});
