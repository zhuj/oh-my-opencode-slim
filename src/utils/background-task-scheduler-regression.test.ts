/// <reference types="bun-types" />

import { expect, spyOn, test } from 'bun:test';
import { BackgroundTaskConcurrency } from './background-task-concurrency';
import { validateDependencyCycle } from './background-task-dependencies';
import { BackgroundTaskStateStore } from './background-task-state';

test('validates deep shared graphs iteratively with one lookup per reachable node', () => {
  // Given
  const store = new BackgroundTaskStateStore();
  let previous: string[] = [];
  const rootID = store.create({}).id;
  previous = [rootID];
  for (let i = 1; i < 1000; i++) {
    const record = store.create({ dependsOn: previous.slice(-2) });
    previous = [...previous.slice(-1), record.id];
  }
  const records = new Map(store.list().map((record) => [record.id, record]));
  const get = spyOn(records, 'get');
  // When
  validateDependencyCycle(records, 'new-target', previous);
  // Then
  expect(get).toHaveBeenCalledTimes(1000);
  expect(() => validateDependencyCycle(records, rootID, previous)).toThrow(
    /cycle/,
  );
});

test('oversized edits and creations leave IDs and dependencies untouched', () => {
  // Given
  const store = new BackgroundTaskStateStore();
  const root = store.create({ logicalID: 'root' });
  const child = store.create({ dependsOn: ['root'] });
  const before = store.list();
  const oversized = Array.from({ length: 257 }, () => root.id);
  // When / Then
  expect(() => store.create({ dependsOn: oversized })).toThrow(/256/);
  expect(() => store.setDependencies(child.id, oversized)).toThrow(/256/);
  expect(store.list()).toEqual(before);
  expect(store.create({}).id).toBe(
    `admission-${Number(child.id.slice('admission-'.length)) + 1}`,
  );
});

test('dependency release preserves FIFO and resumed-tail ordering', async () => {
  // Given
  const scheduler = new BackgroundTaskConcurrency({
    defaultConcurrency: 1,
    providerConcurrency: {},
    modelConcurrency: {},
  });
  const root = scheduler.acquire({ id: 'root', parentSessionID: 'parent' });
  root.bind('native-root');
  const first = scheduler.acquire({
    dependsOn: ['root'],
    parentSessionID: 'parent',
  });
  const second = scheduler.acquire({
    dependsOn: [root.id],
    parentSessionID: 'parent',
  });
  const independent = scheduler.acquire({ parentSessionID: 'parent' });
  first.postpone();
  first.resume();
  // When
  scheduler.releaseTask('native-root', 'completed');
  await second.ready;
  // Then
  expect(first.snapshot().state).toBe('queued');
  expect(independent.snapshot().state).toBe('queued');
  second.release();
  await independent.ready;
  expect(first.snapshot().state).toBe('queued');
  independent.release();
  await first.ready;
  scheduler.dispose();
});

test('native session IDs never resolve as dependency aliases', () => {
  // Given
  const store = new BackgroundTaskStateStore();
  const root = store.create({ logicalID: 'root' });
  store.transition(root.id, 'starting');
  store.bind(root.id, 'native-root');
  // When / Then
  expect(() => store.create({ dependsOn: ['native-root'] })).toThrow(/Unknown/);
  expect(store.create({ dependsOn: ['root'] }).dependsOn).toEqual([root.id]);
});
