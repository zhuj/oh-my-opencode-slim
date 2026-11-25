/// <reference types="bun-types" />

import { expect, spyOn, test } from 'bun:test';
import { BackgroundTaskConcurrency } from './background-task-concurrency';
import { resolveTaskDependencies } from './background-task-dependencies';
import { BackgroundTaskStateStore } from './background-task-state';

test.each([500, 1000])(
  'resolves aliases across %i records with linear visits',
  (size) => {
    // Given
    const store = new BackgroundTaskStateStore();
    const records = Array.from({ length: size }, (_, i) =>
      store.create({ logicalID: `task-${i}` }),
    );
    let visits = 0;
    const counted = records.map((record) => ({
      ...record,
      get parentSessionID() {
        visits++;
        return record.parentSessionID;
      },
    }));
    // When
    const resolved = resolveTaskDependencies(counted, {
      ids: records.slice(-256).map((record) => record.logicalID),
    });
    // Then
    expect(resolved.map((record) => record.id)).toEqual(
      records.slice(-256).map((r) => r.id),
    );
    expect(visits).toBeLessThanOrEqual(size * 2);
  },
);

test('acquire resolves each reference once without listing history', () => {
  // Given
  const scheduler = new BackgroundTaskConcurrency({
    defaultConcurrency: 0,
    providerConcurrency: {},
    modelConcurrency: {},
  });
  const roots = Array.from({ length: 1000 }, (_, i) => {
    const ticket = scheduler.acquire({ id: `root-${i}` });
    ticket.bind(`native-${i}`);
    scheduler.releaseTask(`native-${i}`, 'completed');
    return ticket.id;
  });
  const list = spyOn(BackgroundTaskStateStore.prototype, 'list');
  let visits = 0;
  const ids = roots
    .slice(0, 256)
    .map((id, index) => (index % 2 ? id : `root-${index}`));
  const counted = new Proxy(ids, {
    get(target, key, receiver) {
      if (typeof key === 'string' && /^\d+$/.test(key)) visits++;
      return Reflect.get(target, key, receiver);
    },
  });
  try {
    // When
    const ticket = scheduler.acquire({ dependsOn: counted });
    // Then
    expect(ticket.snapshot().dependsOn).toEqual(roots.slice(0, 256));
    expect(visits).toBe(256);
    expect(list).not.toHaveBeenCalled();
  } finally {
    list.mockRestore();
    scheduler.dispose();
  }
});

test('isolates parentless and scoped aliases and rejects foreign/native IDs', () => {
  // Given
  const store = new BackgroundTaskStateStore();
  const roots = [undefined, 'parent', 'other'].map((parentSessionID) =>
    store.create({ logicalID: 'shared', parentSessionID }),
  );
  // When / Then
  for (const root of roots) {
    expect(
      store.create({
        parentSessionID: root.parentSessionID,
        dependsOn: ['shared'],
      }).dependsOn,
    ).toEqual([root.id]);
    const foreign = roots.find(
      (r) => r.parentSessionID !== root.parentSessionID,
    );
    if (!foreign) throw new Error('missing foreign fixture');
    expect(() =>
      store.create({
        parentSessionID: root.parentSessionID,
        dependsOn: [foreign.id],
      }),
    ).toThrow(/cross-parent/);
    expect(() =>
      store.create({
        parentSessionID: root.parentSessionID,
        dependsOn: ['shared', root.id],
      }),
    ).toThrow(/Duplicate/);
  }
});

test('rejects diamond cycles atomically and follows edited authoritative edges', () => {
  // Given
  const store = new BackgroundTaskStateStore();
  const root = store.create({ logicalID: 'root' });
  const left = store.create({ logicalID: 'left', dependsOn: ['root'] });
  const right = store.create({ logicalID: 'right', dependsOn: ['root'] });
  const leaf = store.create({ dependsOn: ['left', 'right'] });
  const before = store.list();
  // When / Then
  expect(() => store.setDependencies(root.id, [leaf.id])).toThrow(/cycle/);
  expect(store.list()).toEqual(before);
  store.setDependencies(left.id, []);
  expect(() => store.setDependencies(root.id, [leaf.id])).toThrow(/cycle/);
  store.setDependencies(right.id, []);
  store.setDependencies(root.id, [leaf.id]);
  expect(store.get(root.id)?.dependsOn).toEqual([leaf.id]);
});

test('pump reads waiting prerequisites once per mutation-free pass', () => {
  // Given
  const config = {
    defaultConcurrency: 1,
    providerConcurrency: {},
    modelConcurrency: {},
  };
  const scheduler = new BackgroundTaskConcurrency(config);
  const root = scheduler.acquire({ id: 'root' });
  const child = scheduler.acquire({ dependsOn: ['root'] });
  void child.ready.catch(() => undefined);
  const get = spyOn(BackgroundTaskStateStore.prototype, 'get');
  try {
    // When
    scheduler.updateConfig(config);
    // Then
    expect(get.mock.calls.filter(([id]) => id === root.id)).toHaveLength(2);
    expect(child.snapshot().state).toBe('queued');
  } finally {
    get.mockRestore();
    scheduler.dispose();
  }
});
