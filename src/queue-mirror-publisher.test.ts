import { describe, expect, test } from 'bun:test';
import type {
  QueueMirrorSnapshot,
  QueueMirrorWriteOptions,
  QueueMirrorWriteResult,
} from './queue-mirror';
import {
  createQueueMirrorPublisher,
  type QueueMirrorPublisherSource,
} from './queue-mirror-publisher';
import type { BackgroundTaskQueueSnapshot } from './utils/background-task-concurrency';

function queuedAdmission(id: string): BackgroundTaskQueueSnapshot {
  return {
    record: {
      id,
      state: 'queued',
      parentSessionID: 'parent-1',
      previousSessionIDs: [],
      createdAt: 1,
      queuedAt: 1,
      updatedAt: 1,
    },
    queuePosition: 1,
  };
}

function source(
  queue: BackgroundTaskQueueSnapshot[],
): QueueMirrorPublisherSource {
  return {
    listParentSessionIDs: () => ['parent-1'],
    listQueue: () => queue,
    isAdmissionPaused: () => false,
  };
}

describe('queue mirror publisher', () => {
  test('coalesces same-turn notifications into one revision', async () => {
    // Given
    const writes: QueueMirrorSnapshot[] = [];
    const publisher = createQueueMirrorPublisher({
      projectDirectory: 'project',
      publisherID: 'publisher-1',
      runtimeID: 'runtime-1',
      source: source([queuedAdmission('admission-1')]),
      heartbeatMs: 0,
      now: () => 1_000,
      write: async (snapshot) => {
        writes.push(snapshot);
        return { kind: 'written' };
      },
    });

    // When
    publisher.notify();
    publisher.notify();
    publisher.notify();
    await publisher.flush();

    // Then
    expect(writes).toHaveLength(1);
    expect(writes[0]?.revision).toBe(1);
    expect(writes[0]?.parents[0]?.totalQueued).toBe(1);
  });

  test('publishes one latest-state follow-up after an in-flight write', async () => {
    // Given
    const writes: QueueMirrorSnapshot[] = [];
    let releaseFirst: (() => void) | undefined;
    const firstWrite = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const queue = [queuedAdmission('admission-1')];
    const publisher = createQueueMirrorPublisher({
      projectDirectory: 'project',
      publisherID: 'publisher-1',
      runtimeID: 'runtime-1',
      source: source(queue),
      heartbeatMs: 0,
      now: () => 1_000 + writes.length,
      write: async (snapshot) => {
        writes.push(snapshot);
        if (writes.length === 1) await firstWrite;
        return { kind: 'written' };
      },
    });

    // When
    publisher.notify();
    await Promise.resolve();
    queue.push(queuedAdmission('admission-2'));
    publisher.notify();
    publisher.notify();
    if (!releaseFirst) throw new Error('First write did not start');
    releaseFirst();
    await publisher.flush();

    // Then
    expect(writes.map((snapshot) => snapshot.revision)).toEqual([1, 2]);
    expect(writes.at(-1)?.parents[0]?.totalQueued).toBe(2);
  });

  test('contains writer failures and accepts later notifications', async () => {
    // Given
    let attempts = 0;
    const publisher = createQueueMirrorPublisher({
      projectDirectory: 'project',
      publisherID: 'publisher-1',
      runtimeID: 'runtime-1',
      source: source([]),
      heartbeatMs: 0,
      write: async () => {
        attempts += 1;
        throw new Error('disk unavailable');
      },
    });

    // When
    publisher.notify();
    await publisher.flush();
    publisher.notify();

    // Then
    await expect(publisher.flush()).resolves.toBeUndefined();
    expect(attempts).toBe(2);
  });

  test('invalidates in-flight commits and clears heartbeat on disposal', async () => {
    // Given
    let releaseWrite: (() => void) | undefined;
    const writeStarted = new Promise<void>((resolve) => {
      releaseWrite = resolve;
    });
    let result: QueueMirrorWriteResult | undefined;
    let heartbeatCleared = false;
    let removed = false;
    const publisher = createQueueMirrorPublisher({
      projectDirectory: 'project',
      publisherID: 'publisher-1',
      runtimeID: 'runtime-1',
      source: source([]),
      heartbeatMs: 10_000,
      scheduleHeartbeat: () => () => {
        heartbeatCleared = true;
      },
      write: async (
        _snapshot: QueueMirrorSnapshot,
        _projectDirectory: string,
        options: QueueMirrorWriteOptions,
      ) => {
        await writeStarted;
        result = options.shouldCommit?.()
          ? { kind: 'written' }
          : { kind: 'skipped' };
        return result;
      },
      remove: () => {
        removed = true;
      },
      isCurrent: () => true,
    });

    // When
    publisher.notify();
    await Promise.resolve();
    publisher.dispose();
    if (!releaseWrite) throw new Error('Write did not start');
    releaseWrite();
    await publisher.flush();

    // Then
    expect(result).toEqual({ kind: 'skipped' });
    expect(heartbeatCleared).toBe(true);
    expect(removed).toBe(true);
  });
});
