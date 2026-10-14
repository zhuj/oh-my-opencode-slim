import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { BackgroundJobBoard as FixtureBoard } from './background-job-fixture';
import {
  aliasHighWaterMark,
  type BackgroundJobStorageBackend,
  bumpAliasHighWaterMark,
  clearSuppression,
  configureBackgroundJobPersistence,
  getSuppressionTombstone,
  loadInitialBackgroundJobPersistence,
  MAX_PERSISTED_CHILDREN,
  MAX_PERSISTED_TOMBSTONES,
  markPersistedBackgroundChildDelivered,
  persistedBackgroundChildren,
  recordPersistedBackgroundChild,
  recordSuppression,
} from './background-job-persistence';
import {
  BackgroundJobBoard,
  clearBackgroundJobSuppression,
  getBackgroundJobLifecycleLedger,
  recordBackgroundJobSuppression,
} from './index';

/** In-memory v2-storage backend double with cursor pagination. */
function createMemoryBackend() {
  const map = new Map<string, unknown>();
  const backend: BackgroundJobStorageBackend = {
    get: async (key) => map.get(key),
    set: async (key, value) => {
      map.set(key, value);
    },
    remove: async (key) => {
      map.delete(key);
    },
    scan: async (options) => {
      const keys = [...map.keys()]
        .filter(
          (key) =>
            key.startsWith(options.prefix) &&
            (options.after === undefined || key > options.after),
        )
        .sort();
      const limit = options.limit ?? 1000;
      const page = keys.slice(0, limit);
      const next = keys.length > limit ? page[page.length - 1] : undefined;
      return {
        entries: page.map((key) => ({ key, value: map.get(key) })),
        next,
      };
    },
  };
  return { backend, map };
}

/** Flush serialized fire-and-forget persistence writes. */
function flushWrites() {
  return new Promise((resolve) => setTimeout(resolve, 10));
}

/** Manually-resolved promise for holding queued writes in flight. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

describe('background-job persistence', () => {
  beforeEach(() => {
    configureBackgroundJobPersistence(undefined);
  });

  afterEach(() => {
    configureBackgroundJobPersistence(undefined);
  });

  test('tombstone round-trips across a simulated restart and seeds a fresh ledger', async () => {
    const { backend, map } = createMemoryBackend();
    configureBackgroundJobPersistence(backend);
    await loadInitialBackgroundJobPersistence();

    recordSuppression('ses_roundtrip', 1);
    await flushWrites();
    expect([...map.keys()].some((key) => key.includes('ses_roundtrip'))).toBe(
      true,
    );

    // Simulated restart: same backend, fresh module + fresh board/ledger.
    configureBackgroundJobPersistence(backend);
    await loadInitialBackgroundJobPersistence();

    const freshBoard = new BackgroundJobBoard();
    const ledger = getBackgroundJobLifecycleLedger(freshBoard);
    expect(ledger.tombstones.has('ses_roundtrip')).toBe(true);
    expect(ledger.deletionEpochs.get('ses_roundtrip')).toBe(1);
    // Next recorded epoch stays monotonic past the restored one.
    recordBackgroundJobSuppression(freshBoard, 'ses_next');
    expect(ledger.deletionEpochs.get('ses_next')).toBe(2);
  });

  test('tombstone terminal result survives a simulated restart', async () => {
    const { backend } = createMemoryBackend();
    configureBackgroundJobPersistence(backend);
    await loadInitialBackgroundJobPersistence();

    recordSuppression('ses_terminal', 1, {
      state: 'completed',
      resultSummary: 'the answer is 42',
    });
    await flushWrites();
    expect(getSuppressionTombstone('ses_terminal')?.terminalState).toBe(
      'completed',
    );
    // Full-field fixture: any field the load path drops breaks the
    // equality below, regardless of which fields the assertions name.
    const before = getSuppressionTombstone('ses_terminal');

    // Simulated restart: same backend, fresh module state. The load path
    // must carry the persisted terminal result through, or a post-restart
    // task_revive cannot recognize the completed work.
    configureBackgroundJobPersistence(backend);
    await loadInitialBackgroundJobPersistence();

    expect(getSuppressionTombstone('ses_terminal')).toEqual(before);
  });

  test('a malformed persisted terminal payload is dropped wholesale on load', async () => {
    const { backend, map } = createMemoryBackend();
    configureBackgroundJobPersistence(backend);
    await loadInitialBackgroundJobPersistence();

    recordSuppression('ses_half', 3, {
      state: 'completed',
      resultSummary: 'will be corrupted',
    });
    await flushWrites();
    // Corrupt the persisted tombstone entry: a terminal state without a
    // result summary. The load sanitizer must drop the pair wholesale —
    // the consumer contract is all-or-nothing.
    for (const [entryKey, entryValue] of map) {
      if (entryKey.includes('ses_half') && typeof entryValue === 'object') {
        map.set(entryKey, {
          taskID: 'ses_half',
          epoch: 3,
          recordedAt: 1,
          terminalState: 'completed',
        });
      }
    }

    configureBackgroundJobPersistence(backend);
    await loadInitialBackgroundJobPersistence();

    const tombstone = getSuppressionTombstone('ses_half');
    expect(tombstone?.epoch).toBe(3);
    expect(tombstone?.terminalState).toBeUndefined();
    expect(tombstone?.resultSummary).toBeUndefined();
  });

  test('clear-on-relaunch write-through removes the persisted tombstone but keeps the epoch', async () => {
    const { backend } = createMemoryBackend();
    configureBackgroundJobPersistence(backend);
    await loadInitialBackgroundJobPersistence();

    const board = new BackgroundJobBoard();
    recordBackgroundJobSuppression(board, 'ses_relaunch');
    expect(
      getBackgroundJobLifecycleLedger(board).tombstones.has('ses_relaunch'),
    ).toBe(true);
    await flushWrites();

    clearBackgroundJobSuppression(board, 'ses_relaunch');
    await flushWrites();

    // Simulated restart: the relaunch must NOT be ghost-skipped, but its
    // deletion epoch survives for generation fencing.
    configureBackgroundJobPersistence(backend);
    await loadInitialBackgroundJobPersistence();
    const freshLedger = getBackgroundJobLifecycleLedger(
      new BackgroundJobBoard(),
    );
    expect(freshLedger.tombstones.has('ses_relaunch')).toBe(false);
    expect(freshLedger.deletionEpochs.get('ses_relaunch')).toBe(1);
  });

  test('alias counters round-trip across a simulated restart', async () => {
    const { backend } = createMemoryBackend();
    configureBackgroundJobPersistence(backend);
    await loadInitialBackgroundJobPersistence();

    const firstBoard = new BackgroundJobBoard();
    for (let counter = 1; counter <= 2; counter += 1) {
      expect(
        firstBoard.registerLaunch({
          taskID: `ses_alias_${counter}`,
          parentSessionID: 'parent-alias',
          agent: 'fixer',
          description: 'before restart',
        }).alias,
      ).toBe(`fix-${counter}`);
    }
    await flushWrites();

    configureBackgroundJobPersistence(backend);
    await loadInitialBackgroundJobPersistence();
    expect(aliasHighWaterMark('parent-alias', 'fix')).toBe(2);

    const restarted = new BackgroundJobBoard();
    expect(
      restarted.registerLaunch({
        taskID: 'ses_alias_3',
        parentSessionID: 'parent-alias',
        agent: 'fixer',
        description: 'after restart',
      }).alias,
    ).toBe('fix-3');
  });

  test('two live boards share the live alias high-water mark', async () => {
    const { backend } = createMemoryBackend();
    configureBackgroundJobPersistence(backend);
    await loadInitialBackgroundJobPersistence();

    const boardA = new BackgroundJobBoard();
    for (let counter = 1; counter <= 2; counter += 1) {
      expect(
        boardA.registerLaunch({
          taskID: `ses_live_a${counter}`,
          parentSessionID: 'parent-live',
          agent: 'fixer',
          description: 'first board',
        }).alias,
      ).toBe(`fix-${counter}`);
    }

    // The second board reads the live floor even before writes flush.
    const boardB = new BackgroundJobBoard();
    expect(
      boardB.registerLaunch({
        taskID: 'ses_live_b1',
        parentSessionID: 'parent-live',
        agent: 'fixer',
        description: 'second board',
      }).alias,
    ).toBe('fix-3');
    await flushWrites();
  });

  test('alias high-water marks never regress on concurrent bumps', async () => {
    const { backend } = createMemoryBackend();
    configureBackgroundJobPersistence(backend);
    await loadInitialBackgroundJobPersistence();

    bumpAliasHighWaterMark('parent-race', 'fix', 5);
    bumpAliasHighWaterMark('parent-race', 'fix', 3);
    await flushWrites();

    configureBackgroundJobPersistence(backend);
    await loadInitialBackgroundJobPersistence();
    expect(aliasHighWaterMark('parent-race', 'fix')).toBe(5);
  });

  test('loaded alias floor 9 survives a lower bump and trusted recovery of 3 across restart', async () => {
    const { backend, map } = createMemoryBackend();
    map.set('omo/bgj/alias/parent-floor:fix', 9);
    configureBackgroundJobPersistence(backend);
    const snapshot = await loadInitialBackgroundJobPersistence();
    expect(snapshot.aliasHighWaterMarks.get('parent-floor:fix')).toBe(9);

    bumpAliasHighWaterMark('parent-floor', 'fix', 3);
    const board = new BackgroundJobBoard();
    expect(
      board.restoreRetainedSession({
        taskID: 'ses_recovered_floor',
        parentSessionID: 'parent-floor',
        agent: 'fixer',
        description: 'verified historical alias',
        state: 'completed',
        alias: 'fix-3',
      })?.alias,
    ).toBe('fix-3');
    await flushWrites();

    configureBackgroundJobPersistence(backend);
    await loadInitialBackgroundJobPersistence();
    expect(aliasHighWaterMark('parent-floor', 'fix')).toBe(9);
    expect(map.get('omo/bgj/alias/parent-floor:fix')).toBe(9);
  });

  test('alias loading rejects nonnumeric and nonfinite persisted counters', async () => {
    const { backend, map } = createMemoryBackend();
    map.set('omo/bgj/alias/parent-valid:fix', 4);
    map.set('omo/bgj/alias/parent-string:fix', '9');
    map.set('omo/bgj/alias/parent-nan:fix', Number.NaN);
    map.set('omo/bgj/alias/parent-infinite:fix', Number.POSITIVE_INFINITY);
    configureBackgroundJobPersistence(backend);

    const snapshot = await loadInitialBackgroundJobPersistence();

    expect([...snapshot.aliasHighWaterMarks]).toEqual([
      ['parent-valid:fix', 4],
    ]);
    expect(aliasHighWaterMark('parent-valid', 'fix')).toBe(4);
    expect(aliasHighWaterMark('parent-valid', 'ora')).toBe(0);
    expect(aliasHighWaterMark('parent-string', 'fix')).toBe(0);
    expect(aliasHighWaterMark('parent-nan', 'fix')).toBe(0);
    expect(aliasHighWaterMark('parent-infinite', 'fix')).toBe(0);
  });

  test('persisted counters do not authorize numbered aliases for an old parent', async () => {
    const { backend, map } = createMemoryBackend();
    map.set('omo/bgj/alias/parent-old:fix', 9);
    configureBackgroundJobPersistence(backend);
    await loadInitialBackgroundJobPersistence();

    const board = new BackgroundJobBoard({ deferNumberedAliases: true });
    expect(
      board.registerLaunch({
        taskID: 'ses_old_parent_child',
        parentSessionID: 'parent-old',
        agent: 'fixer',
        description: 'old parent remains deferred',
      }).alias,
    ).toBe('ses_old_parent_child');
    expect(board.isNumberedAliasReady('parent-old')).toBe(false);
    expect(aliasHighWaterMark('parent-old', 'fix')).toBe(9);
  });

  test('writes queued before a reconfiguration never land on the new backend', async () => {
    const gate = deferred<void>();
    const { backend: backendA, map: mapA } = createMemoryBackend();
    const gatedA: BackgroundJobStorageBackend = {
      ...backendA,
      set: (key, value) => gate.promise.then(() => backendA.set(key, value)),
      remove: (key) => gate.promise.then(() => backendA.remove(key)),
    };
    configureBackgroundJobPersistence(gatedA);
    await loadInitialBackgroundJobPersistence();

    // Tombstone + epoch writes queue behind the gate (old epoch).
    recordSuppression('ses_stale_cross', 1);
    bumpAliasHighWaterMark('parent-stale-cross', 'fix', 9);

    const { backend: backendB, map: mapB } = createMemoryBackend();
    configureBackgroundJobPersistence(backendB);
    await loadInitialBackgroundJobPersistence();

    gate.resolve();
    await flushWrites();

    // The stale queued op is discarded, not executed: it touches neither
    // the old backend (refuse-to-run) nor — critically — the new one.
    expect(
      [...mapA.keys()].some((key) => key.includes('ses_stale_cross')),
    ).toBe(false);
    expect(
      [...mapB.keys()].some((key) => key.includes('ses_stale_cross')),
    ).toBe(false);
    expect(mapA.has('omo/bgj/alias/parent-stale-cross:fix')).toBe(false);
    expect(mapB.has('omo/bgj/alias/parent-stale-cross:fix')).toBe(false);
    expect(aliasHighWaterMark('parent-stale-cross', 'fix')).toBe(0);

    // New-epoch writes on the new backend work normally.
    recordSuppression('ses_fresh_cross', 2);
    bumpAliasHighWaterMark('parent-stale-cross', 'fix', 2);
    await flushWrites();
    expect(
      [...mapB.keys()].some((key) => key.includes('ses_fresh_cross')),
    ).toBe(true);
    expect(mapB.get('omo/bgj/alias/parent-stale-cross:fix')).toBe(2);
  });

  test('storage-absent fallback: pure memory, zero behavior change', async () => {
    configureBackgroundJobPersistence(undefined);

    expect(() => {
      recordSuppression('ses_fallback', 1);
      clearSuppression('ses_fallback');
      bumpAliasHighWaterMark('parent-fallback', 'fix', 7);
    }).not.toThrow();
    await flushWrites();

    // No backend → nothing is seeded into fresh boards or ledgers.
    expect(aliasHighWaterMark('parent-fallback', 'fix')).toBe(0);
    const board = new BackgroundJobBoard();
    const record = board.registerLaunch({
      taskID: 'ses_fresh',
      parentSessionID: 'parent-fallback',
      agent: 'fixer',
      description: 'fresh',
    });
    expect(record.alias).toBe('fix-1');
    expect(getBackgroundJobLifecycleLedger(board).tombstones.size).toBe(0);
  });

  test('tombstone entries self-cap at the recorded-time bound', async () => {
    const { backend, map } = createMemoryBackend();
    configureBackgroundJobPersistence(backend);
    await loadInitialBackgroundJobPersistence();

    for (let i = 0; i <= MAX_PERSISTED_TOMBSTONES + 2; i += 1) {
      recordSuppression(`ses_cap_${String(i).padStart(4, '0')}`, i + 1);
    }
    await flushWrites();

    const tombstoneKeys = [...map.keys()].filter((key) =>
      key.includes('tombstone'),
    );
    expect(tombstoneKeys.length).toBeLessThanOrEqual(MAX_PERSISTED_TOMBSTONES);
    // The oldest entries were evicted; the newest survives.
    expect(tombstoneKeys.some((key) => key.includes('ses_cap_0000'))).toBe(
      false,
    );
    expect(
      tombstoneKeys.some((key) =>
        key.includes(
          `ses_cap_${String(MAX_PERSISTED_TOMBSTONES + 2).padStart(4, '0')}`,
        ),
      ),
    ).toBe(true);
  });

  test('loadInitial follows the paginated scan cursor', async () => {
    const { backend, map } = createMemoryBackend();
    // Page size 3 forces cursor pagination across the seeded entries.
    const paged: BackgroundJobStorageBackend = {
      get: backend.get,
      set: backend.set,
      remove: backend.remove,
      scan: async (options) => {
        const keys = [...map.keys()]
          .filter(
            (key) =>
              key.startsWith(options.prefix) &&
              (options.after === undefined || key > options.after),
          )
          .sort();
        const limit = 3;
        const page = keys.slice(0, limit);
        const next = keys.length > limit ? page[page.length - 1] : undefined;
        return {
          entries: page.map((key) => ({ key, value: map.get(key) })),
          next,
        };
      },
    };
    configureBackgroundJobPersistence(paged);
    await loadInitialBackgroundJobPersistence();

    for (let i = 0; i < 7; i += 1) {
      recordSuppression(`ses_page_${i}`, i + 1);
    }
    await flushWrites();

    configureBackgroundJobPersistence(paged);
    const snapshot = await loadInitialBackgroundJobPersistence();
    expect(snapshot.tombstones.size).toBe(7);
    expect(snapshot.nextEpoch).toBe(7);
  });

  test('an oldest incoming child is evicted in memory and backend, not resurrected', async () => {
    const { backend, map } = createMemoryBackend();
    configureBackgroundJobPersistence(backend);
    await loadInitialBackgroundJobPersistence();

    const child = (taskID: string, launchedAt: number) => ({
      taskID,
      parentSessionID: 'parent-cap',
      agent: 'explorer',
      description: taskID,
      launchedAt,
      background: true as const,
    });

    for (let i = 0; i < MAX_PERSISTED_CHILDREN; i += 1) {
      recordPersistedBackgroundChild(
        child(`ses_child_${String(i).padStart(4, '0')}`, 1_000 + i),
      );
    }
    await flushWrites();
    expect(persistedBackgroundChildren().size).toBe(MAX_PERSISTED_CHILDREN);

    // The incoming identity is older than every retained child, so the cap
    // evicts it immediately. Its queued delete must win over its own set.
    recordPersistedBackgroundChild(child('ses_child_ancient', 1));
    await flushWrites();

    expect(persistedBackgroundChildren().has('ses_child_ancient')).toBe(false);
    const backendChildKeys = [...map.keys()].filter((key) =>
      key.includes('child/'),
    );
    expect(backendChildKeys.length).toBe(MAX_PERSISTED_CHILDREN);
    expect(
      backendChildKeys.some((key) => key.includes('ses_child_ancient')),
    ).toBe(false);

    // A reload sees the same capped set — the evicted identity cannot
    // reappear from the backend after the restart.
    configureBackgroundJobPersistence(backend);
    const snapshot = await loadInitialBackgroundJobPersistence();
    expect(snapshot.children.size).toBe(MAX_PERSISTED_CHILDREN);
    expect(snapshot.children.has('ses_child_ancient')).toBe(false);
  });

  test('a delayed old-run delivery acknowledgement cannot fence a relaunched run', async () => {
    const { backend } = createMemoryBackend();
    configureBackgroundJobPersistence(backend);
    await loadInitialBackgroundJobPersistence();

    const board = new BackgroundJobBoard();
    const first = board.registerLaunch({
      taskID: 'ses_relaunch_fence',
      parentSessionID: 'parent-fence',
      agent: 'fixer',
      description: 'first run',
      background: true,
      now: 100,
    });
    await flushWrites();
    expect(
      persistedBackgroundChildren().get('ses_relaunch_fence'),
    ).toMatchObject({ launchedAt: 100 });

    const relaunched = board.registerLaunch({
      taskID: 'ses_relaunch_fence',
      parentSessionID: 'parent-fence',
      agent: 'fixer',
      description: 'second run',
      background: true,
      now: 300,
    });
    await flushWrites();

    // The board keeps the historical first launch; the persisted identity
    // carries the current run's fence.
    expect(relaunched).toMatchObject({
      launchedAt: 100,
      lastLaunchedAt: 300,
      runStartedAt: 300,
    });
    expect(
      persistedBackgroundChildren().get('ses_relaunch_fence'),
    ).toMatchObject({ launchedAt: 300 });

    // The old run's acknowledgement arrives late: it must not mark the
    // relaunched run delivered.
    expect(
      markPersistedBackgroundChildDelivered(
        'ses_relaunch_fence',
        400,
        first.runStartedAt,
      ),
    ).toBe(false);
    expect(
      persistedBackgroundChildren().get('ses_relaunch_fence')?.deliveredAt,
    ).toBeUndefined();

    // The current run's acknowledgement succeeds and survives a restart.
    expect(
      markPersistedBackgroundChildDelivered(
        'ses_relaunch_fence',
        500,
        relaunched.runStartedAt,
      ),
    ).toBe(true);
    await flushWrites();

    configureBackgroundJobPersistence(backend);
    const snapshot = await loadInitialBackgroundJobPersistence();
    expect(snapshot.children.get('ses_relaunch_fence')).toMatchObject({
      launchedAt: 300,
      deliveredAt: 500,
    });
  });

  test('a refused relaunch restores the replaced persisted fence and delivery marker', async () => {
    const { backend } = createMemoryBackend();
    configureBackgroundJobPersistence(backend);
    await loadInitialBackgroundJobPersistence();

    const board = new BackgroundJobBoard();
    board.registerLaunch({
      taskID: 'ses_refused_relaunch',
      parentSessionID: 'parent-refused',
      agent: 'fixer',
      description: 'settled run',
      background: true,
      now: 100,
    });
    const replaced = board.get('ses_refused_relaunch');
    if (!replaced) throw new Error('missing replaced record');
    expect(
      markPersistedBackgroundChildDelivered(
        'ses_refused_relaunch',
        150,
        replaced.runStartedAt,
      ),
    ).toBe(true);
    await flushWrites();

    const relaunchLease = board.acquireRelaunchLease(
      'ses_refused_relaunch',
      replaced.generation,
    );
    if (!relaunchLease) throw new Error('missing relaunch lease');
    const relaunched = board.registerLaunch({
      taskID: 'ses_refused_relaunch',
      parentSessionID: 'parent-refused',
      agent: 'fixer',
      description: 'refused run',
      background: true,
      relaunchLease,
      now: 300,
    });
    await flushWrites();
    expect(
      persistedBackgroundChildren().get('ses_refused_relaunch'),
    ).toMatchObject({ launchedAt: 300 });
    expect(
      persistedBackgroundChildren().get('ses_refused_relaunch')?.deliveredAt,
    ).toBeUndefined();

    // The host refused the queued admission: memory and persistence both
    // return to the replaced run, including the marker that acknowledged it.
    expect(board.abandonLaunch(relaunched, relaunchLease)).toBe(true);
    await flushWrites();
    expect(board.get('ses_refused_relaunch')).toEqual(replaced);
    expect(
      persistedBackgroundChildren().get('ses_refused_relaunch'),
    ).toMatchObject({ launchedAt: 100, deliveredAt: 150 });

    // A later accepted relaunch advances the fence. The old run's marker is
    // rejected; the current run's marker succeeds.
    const current = board.registerLaunch({
      taskID: 'ses_refused_relaunch',
      parentSessionID: 'parent-refused',
      agent: 'fixer',
      description: 'accepted run',
      background: true,
      now: 500,
    });
    await flushWrites();
    expect(
      markPersistedBackgroundChildDelivered(
        'ses_refused_relaunch',
        600,
        replaced.runStartedAt,
      ),
    ).toBe(false);
    expect(
      markPersistedBackgroundChildDelivered(
        'ses_refused_relaunch',
        700,
        current.runStartedAt,
      ),
    ).toBe(true);
    expect(
      persistedBackgroundChildren().get('ses_refused_relaunch'),
    ).toMatchObject({ launchedAt: 500, deliveredAt: 700 });
  });

  test('a reopened live run advances the persisted fence and rejects the old delivery', async () => {
    const { backend } = createMemoryBackend();
    configureBackgroundJobPersistence(backend);
    await loadInitialBackgroundJobPersistence();

    const board = new FixtureBoard();
    const first = board.registerLaunch({
      taskID: 'ses_reopened_fence',
      parentSessionID: 'parent-reopened',
      agent: 'fixer',
      description: 'first run',
      background: true,
      now: 100,
    });
    expect(
      markPersistedBackgroundChildDelivered(
        'ses_reopened_fence',
        150,
        first.runStartedAt,
      ),
    ).toBe(true);
    await flushWrites();

    board.updateStatus({
      taskID: 'ses_reopened_fence',
      state: 'completed',
      resultSummary: 'first result',
      now: 200,
    });
    board.markReconciled('ses_reopened_fence', 250);

    // A live busy observation reopens the terminal/reconciled row as a new
    // execution. The persisted fence must move with the run.
    const reopened = board.markRunningFromLiveSession(
      'ses_reopened_fence',
      300,
    );
    expect(reopened).toMatchObject({
      state: 'running',
      launchedAt: 300,
      runStartedAt: 300,
    });
    await flushWrites();
    expect(
      persistedBackgroundChildren().get('ses_reopened_fence'),
    ).toMatchObject({ launchedAt: 300 });
    expect(
      persistedBackgroundChildren().get('ses_reopened_fence')?.deliveredAt,
    ).toBeUndefined();

    // Repeated in-flight busy observations do not move the fence again.
    const stillBusy = board.markRunningFromLiveSession(
      'ses_reopened_fence',
      350,
    );
    expect(stillBusy?.runStartedAt).toBe(300);

    expect(
      markPersistedBackgroundChildDelivered(
        'ses_reopened_fence',
        400,
        first.runStartedAt,
      ),
    ).toBe(false);
    expect(
      markPersistedBackgroundChildDelivered(
        'ses_reopened_fence',
        500,
        reopened.runStartedAt,
      ),
    ).toBe(true);
    expect(
      persistedBackgroundChildren().get('ses_reopened_fence'),
    ).toMatchObject({ launchedAt: 300, deliveredAt: 500 });
  });
});
