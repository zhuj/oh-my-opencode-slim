import { expect, mock, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { withTmpDir } from '../../test-utils';
import { BackgroundJobBoard } from '../../utils/background-job-board';
import type {
  BackgroundJobSnapshot,
  BackgroundJobSnapshotMutation,
  BackgroundJobSnapshotStore,
} from '../../utils/background-job-snapshot-store';
import { createBackgroundJobSnapshotStore } from '../../utils/background-job-snapshot-store';
import { createTaskSessionManagerHook } from './index';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function runningRecord() {
  return new BackgroundJobBoard().registerLaunch({
    taskID: 'child',
    parentSessionID: 'root',
    agent: 'explorer',
    now: 1,
  });
}

function snapshotStore(
  readAll: () => Promise<BackgroundJobSnapshot[]> = async () => [],
  applyMutation: BackgroundJobSnapshotStore['applyMutation'] = async () => {},
): BackgroundJobSnapshotStore {
  return {
    readAll,
    applyMutation,
    readRoot: async () => undefined,
    removeRoot: async () => {},
  };
}

function createHook(
  projectDir: string,
  board: BackgroundJobBoard,
  store: BackgroundJobSnapshotStore,
  session?: Record<string, unknown>,
  hostFlavor?: 'v1' | 'v2',
) {
  return createTaskSessionManagerHook(
    {
      client: {
        session: {
          status: async () => ({ data: {} }),
          messages: async () => ({ data: [] }),
          ...session,
        },
      },
      directory: projectDir,
      worktree: projectDir,
      hostFlavor,
    } as never,
    {
      maxSessionsPerAgent: 2,
      maxRetainedSnapshots: 4,
      backgroundJobBoard: board,
      backgroundJobSnapshotStore: store,
      shouldManageSession: () => true,
      runtimeStatusReconcileDelayMs: 60_000,
    },
  );
}

function emptyTransform(hook: ReturnType<typeof createTaskSessionManagerHook>) {
  return hook['experimental.chat.messages.transform']({}, { messages: [] });
}

test('manager waits for snapshot load before exposing restored board state', async () => {
  await withTmpDir(async (directory) => {
    const pendingRead = deferred<BackgroundJobSnapshot[]>();
    const board = new BackgroundJobBoard();
    const hook = createHook(
      directory,
      board,
      snapshotStore(() => pendingRead.promise),
    );
    const transform = emptyTransform(hook);

    expect(board.get('child')).toBeUndefined();
    pendingRead.resolve([
      {
        version: 1,
        rootSessionID: 'root',
        updatedAt: 1,
        records: { child: runningRecord() },
      },
    ]);
    await transform;

    expect(board.get('child')).toMatchObject({
      rootSessionID: 'root',
      state: 'stopped',
      statusUncertain: true,
    });
  });
});

test.each(['canonical', 'legacy'] as const)(
  'populated %s context survives persist dispose and reload',
  async (format) => {
    await withTmpDir(async (directory) => {
      const store = createBackgroundJobSnapshotStore(directory);
      const persisted = deferred<void>();
      const board = new BackgroundJobBoard();
      const hook = createHook(directory, board, {
        ...store,
        async applyMutation(root, mutation, updatedAt) {
          await store.applyMutation(root, mutation, updatedAt);
          persisted.resolve();
        },
      });
      let reloadedHook: ReturnType<typeof createHook> | undefined;
      try {
        await emptyTransform(hook);
        const run = board.registerLaunch({
          taskID: 'child',
          parentSessionID: 'root',
          agent: 'explorer',
          background: true,
          pluginLaunched: true,
          now: 1,
        });
        board.addContext('child', [{ path: 'src/file.ts', lastReadAt: 2 }]);
        await persisted.promise;
        await hook.event({ event: { type: 'server.instance.disposed' } });
        const records = board.recordsForRoot('root');
        const context =
          format === 'legacy'
            ? {
                path: 'src/file.ts',
                lastReadAt: 2,
                lineCount: 20,
                lineNumbers: [3, 7],
              }
            : { path: 'src/file.ts', lastReadAt: 2 };
        if (format === 'legacy') {
          await store.applyMutation(
            'root',
            {
              upsert: [{ ...records[0], contextFiles: [context] }],
              removeTaskIDs: [],
            },
            3,
          );
        }
        const saved = await store.readRoot('root');
        expect(saved?.records.child).toMatchObject({
          contextFiles: [context],
          state: 'running',
        });
        const reloaded = new BackgroundJobBoard();
        const get = mock(async () => ({ data: { id: 'child' } }));
        reloadedHook = createHook(
          directory,
          reloaded,
          createBackgroundJobSnapshotStore(directory),
          { get },
          'v2',
        );
        await emptyTransform(reloadedHook);
        expect(reloaded.get('child')).toMatchObject({
          taskID: run.taskID,
          parentSessionID: run.parentSessionID,
          rootSessionID: run.rootSessionID,
          alias: run.alias,
          generation: run.generation,
          taskGeneration: run.taskGeneration,
          background: true,
          state: 'stopped',
          statusUncertain: true,
          externalOrigin: true,
          contextFiles: [context],
        });
        expect(reloaded.get('child')?.pluginLaunched).toBeUndefined();
        expect(get).toHaveBeenCalledTimes(1);
        expect(await store.readRoot('root')).toEqual(saved);
      } finally {
        await reloadedHook?.event({
          event: { type: 'server.instance.disposed' },
        });
        await hook.event({ event: { type: 'server.instance.disposed' } });
      }
    });
  },
);

test.each([
  { name: 'missing path', context: { lastReadAt: 2 } },
  { name: 'non-string path', context: { path: 42, lastReadAt: 2 } },
  { name: 'missing timestamp', context: { path: 'src/file.ts' } },
  {
    name: 'non-numeric timestamp',
    context: { path: 'src/file.ts', lastReadAt: '2' },
  },
  {
    name: 'non-finite timestamp',
    context: { path: 'src/file.ts', lastReadAt: Infinity },
  },
])(
  'malformed context $name quarantines without clobbering its root',
  async ({ context }) => {
    await withTmpDir(async (directory) => {
      const store = createBackgroundJobSnapshotStore(directory);
      await store.applyMutation(
        'root',
        {
          upsert: [
            runningRecord(),
            {
              ...runningRecord(),
              taskID: 'malformed',
              contextFiles: [context],
            },
          ],
          removeTaskIDs: [],
        },
        1,
      );
      const path = join(
        directory,
        '.local',
        '.slim',
        'background-jobs',
        `${createHash('sha256').update('root').digest('hex')}.json`,
      );
      const original = await readFile(path, 'utf8');
      const written = deferred<void>();
      const applyMutation = mock(
        async (
          ...args: Parameters<BackgroundJobSnapshotStore['applyMutation']>
        ) => {
          await store.applyMutation(...args);
          written.resolve();
        },
      );
      const board = new BackgroundJobBoard();
      const hook = createHook(directory, board, { ...store, applyMutation });
      try {
        await emptyTransform(hook);
        expect(board.get('child')).toBeUndefined();
        expect(board.get('malformed')).toBeUndefined();
        board.registerLaunch({
          taskID: 'local',
          parentSessionID: 'root',
          agent: 'oracle',
        });
        board.drop('local');
        await hook.event({
          event: { type: 'session.deleted', properties: { sessionID: 'root' } },
        });
        board.registerLaunch({
          taskID: 'other',
          parentSessionID: 'other-root',
          agent: 'oracle',
        });
        await written.promise;
        expect(applyMutation).toHaveBeenCalledTimes(1);
        expect(applyMutation.mock.calls[0]?.[0]).toBe('other-root');
        expect(await readFile(path, 'utf8')).toBe(original);
      } finally {
        await hook.event({ event: { type: 'server.instance.disposed' } });
      }
    });
  },
);

test('board changes persist upserts and removals to their owning root', async () => {
  await withTmpDir(async (directory) => {
    const mutations: Array<{
      root: string;
      mutation: BackgroundJobSnapshotMutation;
    }> = [];
    const board = new BackgroundJobBoard();
    const hook = createHook(
      directory,
      board,
      snapshotStore(
        async () => [],
        async (root, mutation) => {
          mutations.push({ root, mutation });
        },
      ),
    );
    await emptyTransform(hook);

    board.registerLaunch({
      taskID: 'child',
      parentSessionID: 'root',
      agent: 'oracle',
      now: 1,
    });
    // A later turn: same-turn changes coalesce into one write (see
    // persistence-batching.test.ts), and this case is about root attribution
    // for an upsert and for a removal, not about write count.
    await new Promise((resolve) => setTimeout(resolve, 0));
    board.drop('child');
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(
      mutations.map(({ root, mutation }) => ({
        root,
        upsert: mutation.upsert.map((record) => record.taskID),
        remove: mutation.removeTaskIDs,
      })),
    ).toEqual([
      { root: 'root', upsert: ['child'], remove: [] },
      { root: 'root', upsert: [], remove: ['child'] },
    ]);
  });
});

test('same-root snapshot mutations persist in board event order', async () => {
  await withTmpDir(async (directory) => {
    const firstWrite = deferred<void>();
    const writes: BackgroundJobSnapshotMutation[] = [];
    const board = new BackgroundJobBoard();
    const hook = createHook(
      directory,
      board,
      snapshotStore(
        async () => [],
        async (_root, mutation) => {
          writes.push(mutation);
          if (writes.length === 1) await firstWrite.promise;
        },
      ),
    );
    await emptyTransform(hook);
    board.registerLaunch({
      taskID: 'child',
      parentSessionID: 'root',
      agent: 'oracle',
      now: 1,
    });
    // A later turn so the removal is its own queued write: this case is about
    // per-root serialization, which a same-turn coalesced burst cannot show.
    await new Promise((resolve) => setTimeout(resolve, 0));
    board.drop('child');
    await Promise.resolve();
    await Promise.resolve();
    expect(writes).toHaveLength(1);
    firstWrite.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(writes.map((mutation) => mutation.removeTaskIDs)).toEqual([
      [],
      ['child'],
    ]);
  });
});

test('failed snapshot load suppresses persistence but successful empty load allows it', async () => {
  await withTmpDir(async (directory) => {
    let failedReadWrites = 0;
    const failedBoard = new BackgroundJobBoard();
    const failedHook = createHook(
      directory,
      failedBoard,
      snapshotStore(
        async () => {
          throw new Error('read failed');
        },
        async () => {
          failedReadWrites++;
        },
      ),
    );
    await emptyTransform(failedHook);
    failedBoard.registerLaunch({
      taskID: 'failed',
      parentSessionID: 'root',
      agent: 'oracle',
    });
    await Promise.resolve();
    expect(failedReadWrites).toBe(0);

    let successfulReadWrites = 0;
    const successfulBoard = new BackgroundJobBoard();
    const successfulHook = createHook(
      directory,
      successfulBoard,
      snapshotStore(
        async () => [],
        async () => {
          successfulReadWrites++;
        },
      ),
    );
    await emptyTransform(successfulHook);
    successfulBoard.registerLaunch({
      taskID: 'ok',
      parentSessionID: 'root',
      agent: 'oracle',
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(successfulReadWrites).toBe(1);
  });
});

test('positive session metadata retains a restored mapping', async () => {
  await withTmpDir(async (directory) => {
    const board = new BackgroundJobBoard();
    const hook = createHook(
      directory,
      board,
      snapshotStore(async () => [
        {
          version: 1,
          rootSessionID: 'root',
          updatedAt: 1,
          records: { child: runningRecord() },
        },
      ]),
      {
        get: mock(async () => ({ data: { id: 'child' } })),
      },
    );
    await emptyTransform(hook);
    await Promise.resolve();
    await Promise.resolve();

    expect(board.get('child')).toMatchObject({
      state: 'stopped',
      statusUncertain: true,
    });
  });
});

test('malformed snapshot roots are quarantined while other roots restore', async () => {
  await withTmpDir(async (directory) => {
    const valid = runningRecord();
    const board = new BackgroundJobBoard();
    const hook = createHook(
      directory,
      board,
      snapshotStore(async () => [
        {
          version: 1,
          rootSessionID: 'root',
          updatedAt: 1,
          records: {
            child: valid,
            malformed: { taskID: 'malformed', rootSessionID: 'root' },
          },
        },
      ]),
    );

    await emptyTransform(hook);

    expect(board.get('child')).toBeUndefined();
    expect(board.get('malformed')).toBeUndefined();
  });
});

test('malformed snapshot bytes survive board mutations and root cleanup', async () => {
  await withTmpDir(async (directory) => {
    const snapshotDirectory = join(
      directory,
      '.local',
      '.slim',
      'background-jobs',
    );
    const rootPath = join(
      snapshotDirectory,
      `${createHash('sha256').update('root').digest('hex')}.json`,
    );
    const original =
      '{"version":1,"rootSessionID":"root","updatedAt":1,"records":{"broken":{"taskID":"broken"}}}\n';
    await mkdir(snapshotDirectory, { recursive: true });
    await writeFile(rootPath, original);
    const board = new BackgroundJobBoard();
    const hook = createHook(
      directory,
      board,
      createBackgroundJobSnapshotStore(directory),
    );
    await emptyTransform(hook);

    board.registerLaunch({
      taskID: 'local',
      parentSessionID: 'root',
      agent: 'oracle',
    });
    board.drop('local');
    await hook.event({
      event: { type: 'session.deleted', properties: { sessionID: 'root' } },
    });
    board.registerLaunch({
      taskID: 'other',
      parentSessionID: 'other-root',
      agent: 'oracle',
    });
    await new Promise((resolve) => setTimeout(resolve, 25));

    expect(await readFile(rootPath, 'utf8')).toBe(original);
    await expect(
      createBackgroundJobSnapshotStore(directory).readRoot('other-root'),
    ).resolves.toMatchObject({ records: { other: { taskID: 'other' } } });
  });
});

test('snapshot validation quarantines roots with malformed record fields', async () => {
  await withTmpDir(async (directory) => {
    const valid = runningRecord();
    const malformed = [
      { ...valid, launchedAt: Number.NaN },
      { ...valid, updatedAt: Number.POSITIVE_INFINITY },
      { ...valid, objective: 42 },
      { ...valid, provisional: 'yes' },
      { ...valid, totalErrors: Number.NaN },
      { ...valid, terminalState: 'stopped' },
      {
        ...valid,
        contextFiles: [{ path: 'a', lastReadAt: Infinity }],
      },
    ];
    const records = Object.fromEntries(
      malformed.map((record, i) => [
        `bad${i}`,
        { ...record, taskID: `bad${i}` },
      ]),
    );
    const board = new BackgroundJobBoard();
    const hook = createHook(
      directory,
      board,
      snapshotStore(async () => [
        {
          version: 1,
          rootSessionID: 'root',
          updatedAt: 1,
          records: { child: valid, ...records },
        },
      ]),
    );
    await emptyTransform(hook);
    expect(board.get('child')).toBeUndefined();
    for (let i = 0; i < malformed.length; i++)
      expect(board.get(`bad${i}`)).toBeUndefined();
  });
});

test('ambiguous lookup rejection preserves a restored mapping', async () => {
  await withTmpDir(async (directory) => {
    const board = new BackgroundJobBoard();
    const hook = createHook(
      directory,
      board,
      snapshotStore(async () => [
        {
          version: 1,
          rootSessionID: 'root',
          updatedAt: 1,
          records: { child: runningRecord() },
        },
      ]),
      {
        get: mock(async () => {
          throw new Error('temporary host failure');
        }),
      },
    );
    await emptyTransform(hook);
    await Promise.resolve();
    await Promise.resolve();

    expect(board.get('child')).toMatchObject({
      state: 'stopped',
      statusUncertain: true,
    });
  });
});

test('only V2 typed not-found removes a restored record', async () => {
  await withTmpDir(async (directory) => {
    const makeSnapshots = async () => [
      {
        version: 1 as const,
        rootSessionID: 'root',
        updatedAt: 1,
        records: { child: runningRecord() },
      },
    ];
    const board = new BackgroundJobBoard();
    const session = {
      get: mock(async () => {
        throw Object.assign(new Error('gone'), {
          _tag: 'Session.NotFoundError',
        });
      }),
    };
    const hook = createHook(
      directory,
      board,
      snapshotStore(makeSnapshots),
      session,
      'v2',
    );
    await emptyTransform(hook);
    await Promise.resolve();
    await Promise.resolve();
    expect(board.get('child')).toBeUndefined();

    const v1Board = new BackgroundJobBoard();
    const v1Hook = createHook(
      directory,
      v1Board,
      snapshotStore(makeSnapshots),
      session,
      'v1',
    );
    await emptyTransform(v1Hook);
    await Promise.resolve();
    await Promise.resolve();
    expect(v1Board.get('child')).toMatchObject({
      state: 'stopped',
      statusUncertain: true,
    });

    const missingBoard = new BackgroundJobBoard();
    const missingHook = createHook(
      directory,
      missingBoard,
      snapshotStore(makeSnapshots),
    );
    await emptyTransform(missingHook);
    expect(missingBoard.get('child')).toMatchObject({
      state: 'stopped',
      statusUncertain: true,
    });
  });
});

test('a delayed not-found cannot delete a same-ID relaunch', async () => {
  await withTmpDir(async (directory) => {
    const probe = deferred<unknown>();
    const board = new BackgroundJobBoard();
    const persisted: BackgroundJobSnapshotMutation[] = [];
    const hook = createHook(
      directory,
      board,
      snapshotStore(
        async () => [
          {
            version: 1,
            rootSessionID: 'root',
            updatedAt: 1,
            records: { child: runningRecord() },
          },
        ],
        async (_root, mutation) => {
          persisted.push(mutation);
        },
      ),
      { get: () => probe.promise },
      'v2',
    );
    await emptyTransform(hook);
    expect(board.get('child')).toMatchObject({ state: 'stopped' });
    const relaunched = board.registerLaunch({
      taskID: 'child',
      parentSessionID: 'root',
      agent: 'explorer',
      now: 10,
    });
    probe.reject(
      Object.assign(new Error('gone'), { _tag: 'Session.NotFoundError' }),
    );
    await Promise.resolve();
    await Promise.resolve();

    expect(board.get('child')).toMatchObject({
      generation: relaunched.generation,
      state: 'running',
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(persisted.flatMap((mutation) => mutation.removeTaskIDs)).toEqual([]);
  });
});

test('snapshot write failure does not reject callbacks or board operations', async () => {
  await withTmpDir(async (directory) => {
    const board = new BackgroundJobBoard();
    const hook = createHook(
      directory,
      board,
      snapshotStore(
        async () => [],
        async () => {
          throw new Error('read-only project');
        },
      ),
    );
    await expect(emptyTransform(hook)).resolves.toBeUndefined();
    const record = board.registerLaunch({
      taskID: 'child',
      parentSessionID: 'root',
      agent: 'explorer',
      now: 1,
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(board.get('child')).toBe(record);
  });
});
