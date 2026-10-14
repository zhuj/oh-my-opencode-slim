import { expect, spyOn, test } from 'bun:test';
import { withTmpDir } from '../../test-utils';
import { BackgroundJobBoard } from '../../utils/background-job-board';
import type {
  BackgroundJobSnapshot,
  BackgroundJobSnapshotMutation,
  BackgroundJobSnapshotStore,
} from '../../utils/background-job-snapshot-store';
import { createBackgroundJobSnapshotStore } from '../../utils/background-job-snapshot-store';
import * as loggerModule from '../../utils/logger';
import { createTaskSessionManagerHook } from './index';

const PERSIST_FAILURE_LOG =
  '[task-session-manager] failed persisting background-job mutation';

/** One board change inside a single turn, as the batching replay drives it. */
type BurstOp =
  | { readonly kind: 'launch'; readonly taskID: string }
  | { readonly kind: 'drop'; readonly taskID: string };

type WriteTap = {
  readonly mutation: BackgroundJobSnapshotMutation;
  readonly settled: Promise<void>;
};

/** Drains the microtask queue plus one macrotask turn. */
function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function createHook(
  projectDir: string,
  board: BackgroundJobBoard,
  store: BackgroundJobSnapshotStore,
) {
  return createTaskSessionManagerHook(
    {
      client: {
        session: {
          status: async () => ({ data: {} }),
          messages: async () => ({ data: [] }),
        },
      },
      directory: projectDir,
      worktree: projectDir,
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

/**
 * Real store plus a write tap, so batching is measured against the actual
 * on-disk artifact instead of a stub that could hide a lost mutation.
 */
function tappedStore(projectDir: string, failFirstWrite = false) {
  const inner = createBackgroundJobSnapshotStore(projectDir);
  const writes: WriteTap[] = [];
  let failNext = failFirstWrite;
  const store: BackgroundJobSnapshotStore = {
    readAll: () => inner.readAll(),
    readRoot: (root) => inner.readRoot(root),
    removeRoot: (root) => inner.removeRoot(root),
    async applyMutation(rootSessionID, mutation, updatedAt) {
      if (failNext) {
        failNext = false;
        // Nothing reached disk, so there is nothing to await; the rejection
        // is the hook's own catch's problem to observe.
        writes.push({ mutation, settled: Promise.resolve() });
        throw new Error('read-only project');
      }
      const settled = inner.applyMutation(rootSessionID, mutation, updatedAt);
      writes.push({ mutation, settled });
      await settled;
    },
  };
  return { store, writes, inner };
}

async function settleWrites(
  writes: Array<{ settled: Promise<void> }>,
): Promise<void> {
  const pending = writes.map((write) => write.settled);
  await Promise.all(pending);
  // One more macrotask turn lets any write chained after these settle run,
  // so the recorded count is final rather than mid-queue.
  await tick();
}

function recordTaskIDs(snapshot: BackgroundJobSnapshot | undefined): string[] {
  return Object.keys(snapshot?.records ?? {}).sort();
}

/** Record keys in persisted (file) order — that order is part of the contract. */
function persistedRecordKeys(
  snapshot: BackgroundJobSnapshot | undefined,
): string[] {
  return Object.keys(snapshot?.records ?? {});
}

/**
 * Replays a burst onto `board` and reports, per step, the single mutation a
 * sequential persistence listener would have written for it. The oracle and
 * the batched run drive this same replay, so both sides compare records the
 * board itself produced.
 */
function replayBurst(
  board: BackgroundJobBoard,
  ops: readonly BurstOp[],
): BackgroundJobSnapshotMutation[] {
  return ops.map((op, index) => {
    if (op.kind === 'drop') {
      board.drop(op.taskID);
      return { upsert: [], removeTaskIDs: [op.taskID] };
    }
    const record = board.registerLaunch({
      taskID: op.taskID,
      parentSessionID: 'root',
      agent: 'oracle',
      now: index + 1,
    });
    return { upsert: [record], removeTaskIDs: [] };
  });
}

/**
 * Reference result: the pre-batching behaviour — one `applyMutation` per board
 * change, in arrival order. `seed` is the state already on disk when `burst`
 * lands, so a burst can be replayed against records it never launches itself.
 */
async function sequentialSnapshot(
  seed: readonly BurstOp[],
  burst: readonly BurstOp[],
): Promise<BackgroundJobSnapshot | undefined> {
  return withTmpDir(async (directory) => {
    const store = createBackgroundJobSnapshotStore(directory);
    const board = new BackgroundJobBoard();
    const mutations = [
      ...replayBurst(board, seed),
      ...replayBurst(board, burst),
    ];
    for (const [index, mutation] of mutations.entries()) {
      await store.applyMutation('root', mutation, index + 1);
    }
    return store.readRoot('root');
  });
}

/** The same two bursts through the hook, which coalesces them. */
async function batchedBurst(
  seed: readonly BurstOp[],
  burst: readonly BurstOp[],
): Promise<{
  snapshot: BackgroundJobSnapshot | undefined;
  writes: WriteTap[];
}> {
  return withTmpDir(async (directory) => {
    const { store, writes } = tappedStore(directory);
    const board = new BackgroundJobBoard();
    const hook = createHook(directory, board, store);
    await hook['experimental.chat.messages.transform']({}, { messages: [] });
    replayBurst(board, seed);
    await tick();
    await settleWrites(writes);
    replayBurst(board, burst);
    await tick();
    await settleWrites(writes);
    return { snapshot: await store.readRoot('root'), writes };
  });
}

test('a same-turn burst of mutations for one root collapses into one write', async () => {
  await withTmpDir(async (directory) => {
    const { store, writes, inner } = tappedStore(directory);
    const board = new BackgroundJobBoard();
    const hook = createHook(directory, board, store);
    await hook['experimental.chat.messages.transform']({}, { messages: [] });

    board.registerLaunch({
      taskID: 'child-a',
      parentSessionID: 'root',
      agent: 'oracle',
    });
    board.registerLaunch({
      taskID: 'child-b',
      parentSessionID: 'root',
      agent: 'oracle',
    });
    board.registerLaunch({
      taskID: 'child-c',
      parentSessionID: 'root',
      agent: 'oracle',
    });
    await tick();
    await settleWrites(writes);

    expect(writes).toHaveLength(1);
    expect(
      writes[0]?.mutation.upsert.map((record) => record.taskID).sort(),
    ).toEqual(['child-a', 'child-b', 'child-c']);
    expect(writes[0]?.mutation.removeTaskIDs).toEqual([]);
    expect(recordTaskIDs(await inner.readRoot('root'))).toEqual([
      'child-a',
      'child-b',
      'child-c',
    ]);
  });
});

test('an upsert then a removal of one taskID resolves as sequential writes do', async () => {
  // Reference: the pre-change semantics — one applyMutation per board change,
  // in arrival order — applied by hand against the real store. A separate
  // directory keeps these snapshots out of the hook's readAll.
  const expected = await withTmpDir(async (referenceDir) => {
    const reference = createBackgroundJobSnapshotStore(referenceDir);
    const seeded = new BackgroundJobBoard();
    const keep = seeded.registerLaunch({
      taskID: 'keep',
      parentSessionID: 'root',
      agent: 'oracle',
      now: 1,
    });
    const child = seeded.registerLaunch({
      taskID: 'child',
      parentSessionID: 'root',
      agent: 'oracle',
      now: 1,
    });
    await reference.applyMutation(
      'root',
      { upsert: [keep], removeTaskIDs: [] },
      1,
    );
    await reference.applyMutation(
      'root',
      { upsert: [child], removeTaskIDs: [] },
      2,
    );
    await reference.applyMutation(
      'root',
      { upsert: [], removeTaskIDs: ['child'] },
      3,
    );
    return reference.readRoot('root');
  });

  await withTmpDir(async (directory) => {
    // Actual: the same launch-then-drop burst inside a single turn.
    const { store, writes, inner } = tappedStore(directory);
    const board = new BackgroundJobBoard();
    const hook = createHook(directory, board, store);
    await hook['experimental.chat.messages.transform']({}, { messages: [] });
    board.registerLaunch({
      taskID: 'keep',
      parentSessionID: 'root',
      agent: 'oracle',
      now: 1,
    });
    board.registerLaunch({
      taskID: 'child',
      parentSessionID: 'root',
      agent: 'oracle',
      now: 1,
    });
    board.drop('child');
    await tick();
    await settleWrites(writes);

    expect(writes).toHaveLength(1);
    // Last mutation wins for the taskID: the removal is the surviving intent,
    // so it must not be re-applied as an upsert.
    expect(writes[0]?.mutation.upsert.map((record) => record.taskID)).toEqual([
      'keep',
    ]);
    expect(writes[0]?.mutation.removeTaskIDs).toEqual(['child']);
    const actual = await inner.readRoot('root');
    expect(actual?.records).toEqual(expected?.records);
  });
});

test('a failed batched write is logged and later mutations still persist', async () => {
  await withTmpDir(async (directory) => {
    const logSpy = spyOn(loggerModule, 'log').mockImplementation(() => {});
    try {
      const { store, writes, inner } = tappedStore(directory, true);
      const board = new BackgroundJobBoard();
      const hook = createHook(directory, board, store);
      await hook['experimental.chat.messages.transform']({}, { messages: [] });

      board.registerLaunch({
        taskID: 'lost-if-dropped',
        parentSessionID: 'root',
        agent: 'oracle',
      });
      board.registerLaunch({
        taskID: 'also-in-failed-batch',
        parentSessionID: 'root',
        agent: 'oracle',
      });
      await tick();
      await settleWrites(writes);

      // The failed write carried the whole burst: nothing was silently
      // discarded before the store rejected it.
      expect(writes).toHaveLength(1);
      expect(
        writes[0]?.mutation.upsert.map((record) => record.taskID).sort(),
      ).toEqual(['also-in-failed-batch', 'lost-if-dropped']);
      const failures = logSpy.mock.calls.filter(
        ([message]) => message === PERSIST_FAILURE_LOG,
      );
      expect(failures).toHaveLength(1);
      expect(JSON.stringify(failures[0])).toContain('read-only project');
      expect(await inner.readRoot('root')).toBeUndefined();

      // A later mutation must still be applied and persisted.
      board.registerLaunch({
        taskID: 'after-failure',
        parentSessionID: 'root',
        agent: 'oracle',
      });
      await tick();
      await settleWrites(writes);

      expect(writes).toHaveLength(2);
      expect(recordTaskIDs(await inner.readRoot('root'))).toEqual([
        'after-failure',
      ]);
    } finally {
      logSpy.mockRestore();
    }
  });
});

// The tests below pin ORDER, not just contents: snapshot init iterates
// records in property order and `recordsForRoot` sorts on `launchedAt` only,
// so a reordered file silently reorders restoration for equal timestamps.

test('a same-turn drop and re-launch persists the record last, as sequential writes do', async () => {
  const burst: BurstOp[] = [
    { kind: 'launch', taskID: 'child-a' },
    { kind: 'launch', taskID: 'child-b' },
    { kind: 'drop', taskID: 'child-a' },
    { kind: 'launch', taskID: 'child-a' },
  ];
  const expected = await sequentialSnapshot([], burst);
  // The removal has to clear the slot the first launch took, otherwise the
  // re-add would keep landing back at index 0.
  expect(persistedRecordKeys(expected)).toEqual(['child-b', 'child-a']);

  const { snapshot, writes } = await batchedBurst([], burst);
  expect(writes).toHaveLength(1);
  expect(persistedRecordKeys(snapshot)).toEqual(['child-b', 'child-a']);
  expect(snapshot?.records).toEqual(expected?.records);
});

test('a task upserted twice in one burst keeps the position it first took', async () => {
  const burst: BurstOp[] = [
    { kind: 'launch', taskID: 'child-a' },
    { kind: 'launch', taskID: 'child-b' },
    { kind: 'launch', taskID: 'child-a' },
  ];
  const expected = await sequentialSnapshot([], burst);
  expect(persistedRecordKeys(expected)).toEqual(['child-a', 'child-b']);

  const { snapshot, writes } = await batchedBurst([], burst);
  expect(writes).toHaveLength(1);
  // The re-upsert is a coalesced overwrite, not a re-insert.
  expect(writes[0]?.mutation.upsert.map((record) => record.taskID)).toEqual([
    'child-a',
    'child-b',
  ]);
  expect(writes[0]?.mutation.removeTaskIDs).toEqual([]);
  expect(persistedRecordKeys(snapshot)).toEqual(['child-a', 'child-b']);
  expect(snapshot?.records).toEqual(expected?.records);
});

test('an upsert followed by a removal persists the removal', async () => {
  const burst: BurstOp[] = [
    { kind: 'launch', taskID: 'child-a' },
    { kind: 'launch', taskID: 'child-b' },
    { kind: 'drop', taskID: 'child-a' },
  ];
  const expected = await sequentialSnapshot([], burst);
  expect(persistedRecordKeys(expected)).toEqual(['child-b']);

  const { snapshot, writes } = await batchedBurst([], burst);
  expect(writes).toHaveLength(1);
  expect(writes[0]?.mutation.removeTaskIDs).toEqual(['child-a']);
  expect(writes[0]?.mutation.upsert.map((record) => record.taskID)).toEqual([
    'child-b',
  ]);
  expect(persistedRecordKeys(snapshot)).toEqual(['child-b']);
  expect(snapshot?.records).toEqual(expected?.records);
});

test('a same-turn drop and re-launch of an already-persisted task moves it to the end', async () => {
  const seed: BurstOp[] = [
    { kind: 'launch', taskID: 'child-a' },
    { kind: 'launch', taskID: 'child-b' },
  ];
  const burst: BurstOp[] = [
    { kind: 'drop', taskID: 'child-a' },
    { kind: 'launch', taskID: 'child-a' },
  ];
  const expected = await sequentialSnapshot(seed, burst);
  expect(persistedRecordKeys(expected)).toEqual(['child-b', 'child-a']);

  const { snapshot, writes } = await batchedBurst(seed, burst);
  expect(writes).toHaveLength(2);
  // Re-inserting over a surviving entry would keep its pre-burst slot, so the
  // store has to delete the stale entry before the upsert re-adds it.
  expect(writes[1]?.mutation.removeTaskIDs).toEqual(['child-a']);
  expect(writes[1]?.mutation.upsert.map((record) => record.taskID)).toEqual([
    'child-a',
  ]);
  expect(persistedRecordKeys(snapshot)).toEqual(['child-b', 'child-a']);
  expect(snapshot?.records).toEqual(expected?.records);
});

test('tasks only upserted in a burst keep their persisted positions', async () => {
  const seed: BurstOp[] = [
    { kind: 'launch', taskID: 'child-a' },
    { kind: 'launch', taskID: 'child-b' },
  ];
  const burst: BurstOp[] = [
    { kind: 'launch', taskID: 'child-a' },
    { kind: 'launch', taskID: 'child-b' },
    { kind: 'launch', taskID: 'child-a' },
  ];
  const expected = await sequentialSnapshot(seed, burst);
  expect(persistedRecordKeys(expected)).toEqual(['child-a', 'child-b']);

  const { snapshot, writes } = await batchedBurst(seed, burst);
  expect(writes).toHaveLength(2);
  // No removal reached these tasks, so re-appending them would be the
  // wrong fix: their slots must survive the coalesced overwrite.
  expect(writes[1]?.mutation.removeTaskIDs).toEqual([]);
  expect(persistedRecordKeys(snapshot)).toEqual(['child-a', 'child-b']);
  expect(snapshot?.records).toEqual(expected?.records);
});

test('interleaved removals and re-adds persist the order sequential writes do', async () => {
  const seed: BurstOp[] = [
    { kind: 'launch', taskID: 'child-a' },
    { kind: 'launch', taskID: 'child-b' },
    { kind: 'launch', taskID: 'child-c' },
  ];
  const burst: BurstOp[] = [
    { kind: 'drop', taskID: 'child-b' },
    { kind: 'launch', taskID: 'child-b' },
    { kind: 'drop', taskID: 'child-a' },
    { kind: 'launch', taskID: 'child-a' },
    { kind: 'drop', taskID: 'child-b' },
    { kind: 'launch', taskID: 'child-b' },
  ];
  const expected = await sequentialSnapshot(seed, burst);
  expect(persistedRecordKeys(expected)).toEqual([
    'child-c',
    'child-a',
    'child-b',
  ]);

  const { snapshot, writes } = await batchedBurst(seed, burst);
  expect(writes).toHaveLength(2);
  expect(persistedRecordKeys(snapshot)).toEqual([
    'child-c',
    'child-a',
    'child-b',
  ]);
  expect(snapshot?.records).toEqual(expected?.records);
});
