import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { withTmpDir } from '../test-utils';
import { createBackgroundJobSnapshotStore } from './background-job-snapshot-store';

function snapshotPath(projectDir: string, root: string): string {
  const key = createHash('sha256').update(root).digest('hex');
  return join(projectDir, '.local', '.slim', 'background-jobs', `${key}.json`);
}

describe('BackgroundJobSnapshotStore', () => {
  test('round-trips snapshots and isolates roots', async () => {
    await withTmpDir(async (projectDir) => {
      const store = createBackgroundJobSnapshotStore(projectDir);
      const record = { taskID: 'task-a', parentSessionID: 'root-a' };
      await store.applyMutation(
        'root-a',
        { upsert: [record], removeTaskIDs: [] },
        10,
      );

      expect(await store.readRoot('root-a')).toEqual({
        version: 1,
        rootSessionID: 'root-a',
        updatedAt: 10,
        records: { 'task-a': record },
      });
      expect(await store.readRoot('root-b')).toBeUndefined();
      expect(await store.readAll()).toHaveLength(1);
    });
  });

  test('stores __proto__ as an own task ID without changing the records prototype', async () => {
    await withTmpDir(async (projectDir) => {
      const store = createBackgroundJobSnapshotStore(projectDir);
      await store.applyMutation(
        'root',
        { upsert: [{ taskID: '__proto__', value: 'kept' }], removeTaskIDs: [] },
        1,
      );
      const records = (await store.readRoot('root'))?.records;
      expect(records && Object.hasOwn(records, '__proto__')).toBe(true);
      expect(Reflect.get(records ?? {}, '__proto__')).toEqual({
        taskID: '__proto__',
        value: 'kept',
      });
      expect(Object.getPrototypeOf(records) === Object.prototype).toBe(true);
    });
  });

  test('cleans up a newly created lock if owner initialization fails', async () => {
    await withTmpDir(async (projectDir) => {
      const root = 'root';
      const lockPath = `${snapshotPath(projectDir, root)}.lock`;
      const store = createBackgroundJobSnapshotStore(projectDir, {
        initializeOwner: async () => {
          const error = new Error(
            'owner write collision',
          ) as NodeJS.ErrnoException;
          error.code = 'EEXIST';
          throw error;
        },
      });
      await expect(
        store.applyMutation(
          root,
          { upsert: [{ taskID: 'task' }], removeTaskIDs: [] },
          1,
        ),
      ).rejects.toThrow('owner write collision');
      await expect(readFile(lockPath)).rejects.toMatchObject({
        code: 'ENOENT',
      });
      await createBackgroundJobSnapshotStore(projectDir).applyMutation(
        root,
        { upsert: [{ taskID: 'task' }], removeTaskIDs: [] },
        2,
      );
      expect(
        await createBackgroundJobSnapshotStore(projectDir).readRoot(root),
      ).toBeDefined();
    });
  });

  test('serializes concurrent updates to one root', async () => {
    await withTmpDir(async (projectDir) => {
      const store = createBackgroundJobSnapshotStore(projectDir);
      await Promise.all(
        ['task-a', 'task-b'].map((taskID) =>
          store.applyMutation(
            'root',
            {
              upsert: [{ taskID }],
              removeTaskIDs: [],
            },
            10,
          ),
        ),
      );
      expect(
        Object.keys((await store.readRoot('root'))?.records ?? {}).sort(),
      ).toEqual(['task-a', 'task-b']);
    });
  });

  test('preserves malformed and unsupported snapshots on read and mutation', async () => {
    await withTmpDir(async (projectDir) => {
      const directory = join(projectDir, '.local', '.slim', 'background-jobs');
      await mkdir(directory, { recursive: true });
      const store = createBackgroundJobSnapshotStore(projectDir);
      for (const [root, bytes] of [
        ['bad-json', '{'],
        ['future', JSON.stringify({ version: 2, rootSessionID: 'future' })],
      ]) {
        const path = snapshotPath(projectDir, root);
        await writeFile(path, bytes);
        expect(await store.readAll()).toEqual([]);
        await expect(
          store.applyMutation(root, { upsert: [], removeTaskIDs: [] }, 1),
        ).rejects.toThrow();
        expect(await readFile(path, 'utf8')).toBe(bytes);
      }
    });
  });

  test('removes empty snapshots only after explicit mutation', async () => {
    await withTmpDir(async (projectDir) => {
      const store = createBackgroundJobSnapshotStore(projectDir);
      await store.applyMutation(
        'root',
        { upsert: [{ taskID: 'task' }], removeTaskIDs: [] },
        1,
      );
      const path = snapshotPath(projectDir, 'root');
      const committedBytes = await readFile(path, 'utf8');
      await store.applyMutation('root', { upsert: [], removeTaskIDs: [] }, 2);
      expect(await readFile(path, 'utf8')).not.toBe(committedBytes);
      await store.applyMutation('root', { upsert: [], removeTaskIDs: [] }, 3);
      expect(await store.readRoot('root')).toBeDefined();
      await store.applyMutation(
        'root',
        { upsert: [], removeTaskIDs: ['task'] },
        4,
      );
      expect(await store.readRoot('root')).toBeUndefined();
    });
  });

  test('does not reclaim a lock owned by a live contender', async () => {
    await withTmpDir(async (projectDir) => {
      const root = 'root';
      const path = snapshotPath(projectDir, root);
      const lockPath = `${path}.lock`;
      await mkdir(lockPath, { recursive: true });
      await writeFile(
        join(lockPath, 'owner'),
        JSON.stringify({ pid: process.pid }),
      );
      const store = createBackgroundJobSnapshotStore(projectDir, {
        lockTimeoutMs: 0,
      });
      await expect(
        store.applyMutation(
          root,
          { upsert: [{ taskID: 'new' }], removeTaskIDs: [] },
          1,
        ),
      ).rejects.toThrow(/Timed out acquiring snapshot lock/);
      expect(await readFile(join(lockPath, 'owner'), 'utf8')).toBe(
        JSON.stringify({ pid: process.pid }),
      );
    });
  });

  test('preserves committed snapshot bytes when atomic replacement fails', async () => {
    await withTmpDir(async (projectDir) => {
      const initial = createBackgroundJobSnapshotStore(projectDir);
      await initial.applyMutation(
        'root',
        { upsert: [{ taskID: 'old' }], removeTaskIDs: [] },
        1,
      );
      const path = snapshotPath(projectDir, 'root');
      const committedBytes = await readFile(path, 'utf8');
      const failing = createBackgroundJobSnapshotStore(projectDir, {
        atomicReplace: async () => {
          throw new Error('injected rename failure');
        },
      });
      await expect(
        failing.applyMutation(
          'root',
          { upsert: [{ taskID: 'new' }], removeTaskIDs: [] },
          2,
        ),
      ).rejects.toThrow('injected rename failure');
      expect(await readFile(path, 'utf8')).toBe(committedBytes);
    });
  });
});
