import { describe, expect, test } from 'bun:test';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import {
  getQueueMirrorPath,
  projectQueueMirror,
  readQueueMirrorSnapshot,
  writeQueueMirrorSnapshot,
} from './queue-mirror';
import { withTmpDir } from './test-utils';
import type { BackgroundTaskQueueSnapshot } from './utils/background-task-concurrency';

type QueueFixture = {
  readonly id: string;
  readonly state: 'queued' | 'postponed';
  readonly parentSessionID: string;
  readonly queuePosition?: number;
};

async function withTempDir<T>(
  operation: (directory: string) => Promise<T>,
): Promise<T> {
  return withTmpDir(operation);
}

function queueFixture(input: QueueFixture): BackgroundTaskQueueSnapshot {
  return {
    record: {
      id: input.id,
      state: input.state,
      parentSessionID: input.parentSessionID,
      model: 'openai/gpt-5.6-luna',
      provider: 'openai',
      previousSessionIDs: [],
      createdAt: 100,
      queuedAt: 100,
      updatedAt: 100,
    },
    ...(input.queuePosition === undefined
      ? {}
      : { queuePosition: input.queuePosition }),
  };
}

describe('queue mirror', () => {
  test('projects only ordered queue fields and parent totals', () => {
    // Given
    const queue = [
      queueFixture({
        id: 'queued-1',
        state: 'queued',
        parentSessionID: 'parent-a',
        queuePosition: 1,
      }),
      queueFixture({
        id: 'queued-2',
        state: 'queued',
        parentSessionID: 'parent-a',
        queuePosition: 2,
      }),
      queueFixture({
        id: 'postponed-1',
        state: 'postponed',
        parentSessionID: 'parent-a',
      }),
    ];

    // When
    const snapshot = projectQueueMirror({
      publisherID: 'publisher-a',
      runtimeID: 'runtime-a',
      revision: 4,
      updatedAt: 1_000,
      parents: [
        {
          parentSessionID: 'parent-a',
          paused: true,
          queue,
        },
      ],
    });

    // Then
    expect(snapshot).toEqual({
      schema: 'oh-my-opencode-slim.queue-mirror',
      version: 1,
      publisherID: 'publisher-a',
      runtimeID: 'runtime-a',
      revision: 4,
      updatedAt: 1_000,
      parents: [
        {
          parentSessionID: 'parent-a',
          paused: true,
          totalQueued: 2,
          postponedCount: 1,
          admissions: [
            {
              id: 'queued-1',
              state: 'queued',
              queuePosition: 1,
              model: 'openai/gpt-5.6-luna',
              provider: 'openai',
            },
            {
              id: 'queued-2',
              state: 'queued',
              queuePosition: 2,
              model: 'openai/gpt-5.6-luna',
              provider: 'openai',
            },
            {
              id: 'postponed-1',
              state: 'postponed',
              model: 'openai/gpt-5.6-luna',
              provider: 'openai',
            },
          ],
        },
      ],
    });
  });

  test('caps each parent projection at five admissions', () => {
    // Given
    const queue = Array.from({ length: 7 }, (_, index) =>
      queueFixture({
        id: `queued-${index + 1}`,
        state: 'queued',
        parentSessionID: 'parent-a',
        queuePosition: index + 1,
      }),
    );

    // When
    const snapshot = projectQueueMirror({
      publisherID: 'publisher-a',
      runtimeID: 'runtime-a',
      revision: 1,
      updatedAt: 1_000,
      parents: [
        {
          parentSessionID: 'parent-a',
          paused: false,
          queue,
        },
      ],
    });

    // Then
    expect(snapshot.parents[0]?.admissions.map((entry) => entry.id)).toEqual([
      'queued-1',
      'queued-2',
      'queued-3',
      'queued-4',
      'queued-5',
    ]);
    expect(snapshot.parents[0]?.totalQueued).toBe(7);
  });

  test('round-trips an available project-scoped snapshot atomically', async () => {
    await withTempDir(async (projectDirectory) => {
      // Given
      const snapshot = projectQueueMirror({
        publisherID: 'publisher-a',
        runtimeID: 'runtime-a',
        revision: 2,
        updatedAt: 1_000,
        parents: [],
      });

      // When
      const writeResult = await writeQueueMirrorSnapshot(
        snapshot,
        projectDirectory,
      );
      const readResult = await readQueueMirrorSnapshot(projectDirectory, {
        now: () => 1_500,
        staleAfterMs: 1_000,
      });

      // Then
      expect(writeResult).toEqual({ kind: 'written' });
      expect(readResult).toEqual({ kind: 'available', snapshot });
      const mirrorDirectory = path.dirname(
        getQueueMirrorPath(projectDirectory),
      );
      expect(
        (await fs.readdir(mirrorDirectory)).filter((name) =>
          name.endsWith('.tmp'),
        ),
      ).toEqual([]);
    });
  });

  test('does not replace a current mirror after its commit guard expires', async () => {
    await withTempDir(async (projectDirectory) => {
      // Given
      const current = projectQueueMirror({
        publisherID: 'publisher-current',
        runtimeID: 'runtime-current',
        revision: 1,
        updatedAt: 1_000,
        parents: [],
      });
      const expired = projectQueueMirror({
        publisherID: 'publisher-expired',
        runtimeID: 'runtime-expired',
        revision: 2,
        updatedAt: 1_100,
        parents: [],
      });
      await writeQueueMirrorSnapshot(current, projectDirectory);

      // When
      const writeResult = await writeQueueMirrorSnapshot(
        expired,
        projectDirectory,
        { shouldCommit: () => false },
      );
      const readResult = await readQueueMirrorSnapshot(projectDirectory, {
        now: () => 1_200,
      });

      // Then
      expect(writeResult).toEqual({ kind: 'skipped' });
      expect(readResult).toEqual({ kind: 'available', snapshot: current });
    });
  });

  test('reports malformed persisted data without throwing', async () => {
    await withTempDir(async (projectDirectory) => {
      // Given
      const mirrorPath = getQueueMirrorPath(projectDirectory);
      await fs.mkdir(path.dirname(mirrorPath), { recursive: true });
      await fs.writeFile(mirrorPath, '{invalid-json');

      // When
      const result = await readQueueMirrorSnapshot(projectDirectory);

      // Then
      expect(result).toEqual({ kind: 'unavailable', reason: 'malformed' });
    });
  });

  test('reports snapshots older than the configured freshness window', async () => {
    await withTempDir(async (projectDirectory) => {
      // Given
      const snapshot = projectQueueMirror({
        publisherID: 'publisher-a',
        runtimeID: 'runtime-a',
        revision: 2,
        updatedAt: 1_000,
        parents: [],
      });
      await writeQueueMirrorSnapshot(snapshot, projectDirectory);

      // When
      const result = await readQueueMirrorSnapshot(projectDirectory, {
        now: () => 2_001,
        staleAfterMs: 1_000,
      });

      // Then
      expect(result).toEqual({ kind: 'unavailable', reason: 'stale' });
    });
  });
});
