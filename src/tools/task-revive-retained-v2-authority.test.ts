import { expect, test } from 'bun:test';
import { BackgroundJobBoard } from '../utils/background-job-board';
import { childID, retainedV2 } from './task-revive-retained-v2.fixture';

test.each(['provider/model', 'provider/model#high'])(
  'restored recovery refuses explicit %s before deferred real-shim selection',
  async (model) => {
    let disposed = false;
    const h = retainedV2({ isDisposed: () => disposed });
    const selection = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    h.get.mockImplementation(async () => {
      if (h.register.mock.calls.length > 0) {
        selection.resolve();
        await release.promise;
      }
      return { id: childID, ...h.hostIdentity };
    });
    h.idle.resolve();
    const outcome = h.revive({ model }).catch((error: unknown) => error);
    // The old candidate reaches selection. A repaired refusal instead wins
    // this race, so neither version waits on a gate it never entered.
    const first = await Promise.race([
      selection.promise.then(() => 'selection'),
      outcome.then(() => 'settled'),
    ]);
    if (first === 'selection') disposed = true;
    release.resolve();
    expect(await outcome).toBeInstanceOf(Error);
    expect(h.switchModel).not.toHaveBeenCalled();
    expect(h.prompt).not.toHaveBeenCalled();
    expect(h.interrupt).not.toHaveBeenCalled();
    expect(h.record().statusUncertain).toBe(true);
    expect(h.get).not.toHaveBeenCalled();
  },
);

test('inherited restored recovery has no selection await before native submit', async () => {
  const h = retainedV2();
  let identityReads = 0;
  h.get.mockImplementation(async () => {
    if (++identityReads > 4) throw new Error('Unexpected selection read');
    return { id: childID, ...h.hostIdentity };
  });
  h.idle.resolve();
  await h.revive();
  expect(identityReads).toBe(4);
  expect(h.switchModel).not.toHaveBeenCalled();
  expect(h.prompt).toHaveBeenCalledTimes(1);
});

for (const phase of ['idle', 'identity'] as const) {
  test.each([
    'queued identity',
    'idle withdrawal',
    'idle replacement',
    'managed parent',
  ])(
    `restored recovery fences %s withdrawn during ${phase}`,
    async (change) => {
      let managed = true;
      const h = retainedV2({ shouldManageSession: () => managed });
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      let reads = 0;
      h.get.mockImplementation(async () => {
        if (++reads === 4 && phase === 'identity') {
          entered.resolve();
          await release.promise;
        }
        return { id: childID, ...h.hostIdentity };
      });
      const retained = h.record();
      const outcome = h.revive().catch((error: unknown) => error);
      await h.entered;
      if (phase === 'identity') {
        h.idle.resolve();
        await entered.promise;
      }
      if (change === 'queued identity')
        h.capabilities.queuedPromptIdentity = false;
      if (change === 'idle withdrawal')
        h.capabilities.waitForSessionIdle = undefined;
      if (change === 'idle replacement')
        h.capabilities.waitForSessionIdle = async () => {};
      if (change === 'managed parent') managed = false;
      h.idle.resolve();
      release.resolve();
      expect(await outcome).toBeInstanceOf(Error);
      expect(h.board.get(childID)).toBe(retained);
      expect(h.record().statusUncertain).toBe(true);
      expect(h.prompt).not.toHaveBeenCalled();
      expect(h.switchModel).not.toHaveBeenCalled();
      expect(h.interrupt).not.toHaveBeenCalled();
    },
  );
}

test('captured parent cannot be replaced in the tool context during native idle', async () => {
  const h = retainedV2();
  const outcome = h.revive().catch((error: unknown) => error);
  await h.entered;
  h.context.sessionID = 'different-parent';
  h.idle.resolve();
  expect(await outcome).toBeInstanceOf(Error);
  expect(h.prompt).not.toHaveBeenCalled();
  expect(h.interrupt).not.toHaveBeenCalled();
});

test.each([
  'queued identity',
  'idle withdrawal',
  'idle replacement',
  'managed parent',
  'context parent',
])(
  'actual submit fence rolls back only its unchanged provisional input after %s changes',
  async (change) => {
    let managed = true;
    const h = retainedV2({ shouldManageSession: () => managed });
    const retained = h.record();
    const observed: boolean[] = [];
    h.board.addMutationListener(({ record }) => {
      if (record) observed.push(record.statusUncertain);
    });
    h.options.registerIntent = () => {
      if (change === 'queued identity')
        h.capabilities.queuedPromptIdentity = false;
      if (change === 'idle withdrawal')
        h.capabilities.waitForSessionIdle = undefined;
      if (change === 'idle replacement')
        h.capabilities.waitForSessionIdle = async () => {};
      if (change === 'managed parent') managed = false;
      if (change === 'context parent') h.context.sessionID = 'different-parent';
    };
    h.idle.resolve();
    await expect(h.revive()).rejects.toThrow('before submission');
    expect(h.board.get(childID)).toBe(retained);
    expect(observed.every(Boolean)).toBe(true);
    expect(h.prompt).not.toHaveBeenCalled();
    expect(h.switchModel).not.toHaveBeenCalled();
    expect(h.interrupt).not.toHaveBeenCalled();
    expect(
      h.tracker.promptMessageIDFor(childID, retained.generation),
    ).toBeUndefined();
    const retryLease = h.board.acquireLease(
      childID,
      retained.generation,
      'relaunch',
    );
    expect(retryLease).toBeDefined();
    if (retryLease) h.board.releaseLease(retryLease);
  },
);

test('activity observed after provisional publication cannot be rolled back or lose exclusion before submit', async () => {
  const h = retainedV2();
  h.options.registerIntent = () => {
    h.board.markRunningFromLiveSession(childID, Date.now());
  };
  h.idle.resolve();
  await expect(h.revive()).rejects.toThrow('before submission');
  expect(h.record().activityRevision).toBe(1);
  expect(h.record().statusUncertain).toBe(true);
  expect(
    h.board.acquireLease(childID, h.record().generation, 'cancellation'),
  ).toBeUndefined();
  expect(h.prompt).not.toHaveBeenCalled();
  expect(h.interrupt).not.toHaveBeenCalled();
});

test('restored unresolved input identity excludes recovery even without the old in-memory tracker', async () => {
  const h = retainedV2();
  h.prompt.mockRejectedValue(new Error('lost ACK'));
  h.idle.resolve();
  await h.revive();
  const retained = h.record();
  const restored = new BackgroundJobBoard();
  restored.restore([retained]);
  h.tracker.discard(childID, retained.generation);
  h.options.backgroundJobBoard = restored;
  await expect(h.revive()).rejects.toThrow(
    'not a verified retained terminal session',
  );
  expect(restored.get(childID)?.statusUncertain).toBe(true);
  expect(h.wait).toHaveBeenCalledTimes(1);
  expect(h.prompt).toHaveBeenCalledTimes(1);
  expect(h.interrupt).not.toHaveBeenCalled();
});
