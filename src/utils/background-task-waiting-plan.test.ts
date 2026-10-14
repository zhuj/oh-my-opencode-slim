import { describe, expect, test } from 'bun:test';
import type { QueueEntry } from './background-task-concurrency';
import {
  classifyWaiting,
  type FailBlockedContext,
  failBlockedEntry,
  type WaitingPlanClassifierContext,
} from './background-task-concurrency';
import { TaskDependencyError } from './background-task-dependencies';
import { BackgroundTaskStateStore } from './background-task-state';
import type { BackgroundTaskRecord } from './background-task-state-types';

function fixtureRecord(
  overrides: Partial<BackgroundTaskRecord> = {},
): BackgroundTaskRecord {
  return {
    id: 'r-1',
    logicalID: 'r-1',
    dependsOn: [],
    state: 'queued',
    previousSessionIDs: [],
    createdAt: 0,
    queuedAt: 0,
    updatedAt: 0,
    ...overrides,
  } satisfies BackgroundTaskRecord;
}

function fixtureEntry(overrides: Partial<QueueEntry> = {}): QueueEntry {
  return {
    id: 'e1',
    bypassCapacity: true,
    released: false,
    taskID: undefined,
    resolve: () => {},
    reject: () => {},
    tier: 'default',
    key: undefined,
    limit: 0,
    ...overrides,
  } satisfies QueueEntry;
}

describe('waiting-plan classification', () => {
  test('returns empty admissible with no entries', () => {
    const plan = classifyWaiting({
      scanEpoch: 1,
      waiting: [],
      requireSnapshot: () => fixtureRecord(),
      dependenciesOf: () => [],
      isRecordPaused: () => false,
      capacityCanStart: () => true,
    });
    expect(plan.epoch).toBe(1);
    expect(plan.blocked).toBeUndefined();
    expect(plan.admissible.size).toBe(0);
  });

  test('includes queued entry with ready dependencies', () => {
    const entry = fixtureEntry();
    const plan = classifyWaiting({
      scanEpoch: 1,
      waiting: [entry],
      requireSnapshot: () =>
        fixtureRecord({ id: entry.id, state: 'queued', dependsOn: [] }),
      dependenciesOf: () => [],
      isRecordPaused: () => false,
      capacityCanStart: () => true,
    });
    expect(plan.admissible.has(entry)).toBe(true);
    expect(plan.blocked).toBeUndefined();
  });

  test('blocks on failed prerequisite and stops admission', () => {
    const entry = fixtureEntry();
    const badRecord = fixtureRecord({
      id: 'bad',
      state: 'error',
      dependsOn: [],
    });
    const plan = classifyWaiting({
      scanEpoch: 1,
      waiting: [entry],
      requireSnapshot: (id: string) =>
        id === 'bad'
          ? badRecord
          : fixtureRecord({ id, state: 'queued', dependsOn: ['bad'] }),
      dependenciesOf: (record: BackgroundTaskRecord) =>
        record.dependsOn.map((dep: string) =>
          dep === 'bad' ? badRecord : fixtureRecord({ id: dep }),
        ),
      isRecordPaused: () => false,
      capacityCanStart: () => true,
    });
    expect(plan.blocked).toBeDefined();
    if (plan.blocked) {
      expect(plan.blocked.entry).toBe(entry);
      expect(plan.blocked.dependencies.length).toBeGreaterThan(0);
    }
    expect(plan.admissible.size).toBe(0);
  });
});

describe('failBlockedEntry', () => {
  test('removes blocked entry, clears readiness, publishes, and records error state', async () => {
    const store = new BackgroundTaskStateStore();
    const record = store.create({ logicalID: 'e1', dependsOn: [] });
    let captured: Error | undefined;
    let promiseReject: (err: Error) => void = () => {};
    const readinessPromise = new Promise<void>((_, reject) => {
      promiseReject = reject;
    });
    const entry = fixtureEntry({
      id: record.id,
      resolve: () => {},
      reject: (err: Error) => {
        captured = err;
        promiseReject(err);
      },
    });
    let publishedState:
      | {
          released: boolean;
          queuedLength: number;
          inIndex: boolean;
          resolveCleared: boolean;
          rejectCleared: boolean;
          storeErrorState: string | undefined;
          capturedError: Error | undefined;
        }
      | undefined;
    const ctx: FailBlockedContext = {
      waiting: [entry],
      entriesByID: new Map([[record.id, entry]]),
      tasks: store,
      publish: () => {
        const failedRecord = store.get(record.id);
        publishedState = {
          released: entry.released,
          queuedLength: ctx.waiting.length,
          inIndex: ctx.entriesByID.has(record.id),
          resolveCleared: entry.resolve === undefined,
          rejectCleared: entry.reject === undefined,
          storeErrorState: failedRecord?.state,
          capturedError: captured,
        };
      },
    };
    failBlockedEntry({ entry, dependencies: [record] }, ctx);
    expect(publishedState).toBeDefined();
    if (publishedState) {
      expect(publishedState.released).toBe(true);
      expect(publishedState.queuedLength).toBe(0);
      expect(publishedState.inIndex).toBe(false);
      expect(publishedState.resolveCleared).toBe(true);
      expect(publishedState.rejectCleared).toBe(true);
      expect(publishedState.storeErrorState).toBe('error');
      expect(publishedState.capturedError).toBeInstanceOf(TaskDependencyError);
    }
    expect(captured).toBeInstanceOf(TaskDependencyError);
    const failedRecord = store.get(record.id);
    expect(failedRecord).toBeDefined();
    if (failedRecord) {
      expect(failedRecord.state).toBe('error');
      expect(failedRecord.dependencyError).toBeDefined();
    }
    await expect(readinessPromise).rejects.toBeInstanceOf(TaskDependencyError);
  });
});
