import { expect, spyOn, test } from 'bun:test';
import { getBackgroundJobLifecycleLedger } from '../utils/background-job-board';
import { tick } from '../utils/test-timers';
import { childID, retainedV2 } from './task-revive-retained-v2.fixture';

test.each([
  'host parent',
  'host agent',
  'board parent',
  'board agent',
  'consistent agent replacement',
  'generation',
  'deletion',
  'deletion epoch',
  'lease',
  'busy',
  'busy then stopped',
  'fallback',
  'observation',
  'queued identity',
  'disposal',
  'cancellation',
  'timeout',
])(
  'retained recovery fences %s changes during native idle verification',
  async (kind) => {
    let disposed = false;
    const h = retainedV2({ isDisposed: () => disposed });
    const old = h.record();
    const outcome = h.revive().catch((error: unknown) => error);
    await h.entered;
    if (kind === 'host parent') h.hostIdentity.parentID = 'foreign';
    if (kind === 'host agent') h.hostIdentity.agent = 'fixer';
    if (kind === 'board parent') old.parentSessionID = 'foreign';
    if (kind === 'board agent') old.agent = 'fixer';
    if (kind === 'consistent agent replacement') {
      h.hostIdentity.agent = 'fixer';
      old.agent = 'fixer';
    }
    if (kind === 'generation')
      h.board.restore([{ ...old, generation: old.generation + 1 }]);
    if (kind === 'deletion') h.board.drop(childID);
    if (kind === 'deletion epoch')
      getBackgroundJobLifecycleLedger(h.board).deletionEpochs.set(childID, 1);
    if (kind === 'lease')
      spyOn(h.board, 'validateLease').mockReturnValue(false);
    if (kind === 'busy') h.board.markRunningFromLiveSession(childID, 200);
    if (kind === 'busy then stopped') {
      h.board.markRunningFromLiveSession(childID, old.lastLiveBusyAt);
      h.board.restore([{ ...old, activityRevision: old.activityRevision + 1 }]);
    }
    if (kind === 'fallback') h.options.isFallbackPending = () => true;
    if (kind === 'observation')
      spyOn(h.tracker, 'isObservationPending').mockReturnValue(true);
    if (kind === 'queued identity')
      spyOn(h.tracker, 'promptMessageIDFor').mockReturnValue('msg_prior');
    if (kind === 'disposal') disposed = true;
    if (kind === 'cancellation') old.cancellationRequested = true;
    if (kind === 'timeout') old.timedOut = true;
    h.idle.resolve();
    expect(await outcome).toBeInstanceOf(Error);
    expect(h.prompt).not.toHaveBeenCalled();
    expect(h.interrupt).not.toHaveBeenCalled();
    expect(h.register).not.toHaveBeenCalled();
    expect(old.statusUncertain).toBe(true);
  },
);

test('concurrent retained revivals cannot both own native idle admission', async () => {
  const h = retainedV2();
  const first = h.revive();
  await h.entered;
  await expect(h.revive()).rejects.toThrow('lease unavailable');
  expect(h.wait).toHaveBeenCalledTimes(1);
  h.idle.resolve();
  await first;
  expect(h.prompt).toHaveBeenCalledTimes(1);
  expect(h.register).toHaveBeenCalledTimes(1);
  await expect(h.revive()).rejects.toThrow('already has a queued continuation');
  expect(h.interrupt).not.toHaveBeenCalled();
});

test('unknown queued admission keeps its identity and excludes duplicate recovery', async () => {
  const h = retainedV2();
  h.prompt.mockRejectedValue(new Error('transport failed after write'));
  h.idle.resolve();
  expect(await h.revive()).toContain('admission_unknown');
  const generation = h.record().generation;
  expect(h.tracker.promptMessageIDFor(childID, generation)).toStartWith(
    'msg_omos_revive_',
  );
  await expect(h.revive()).rejects.toThrow('already has a queued continuation');
  expect(h.prompt).toHaveBeenCalledTimes(1);
  expect(h.interrupt).not.toHaveBeenCalled();
});

test('explicit queue rejection restores the uncertain old round without inventing a result', async () => {
  const h = retainedV2();
  const old = h.record();
  h.prompt.mockResolvedValue({ error: { message: 'queue refused' } });
  h.idle.resolve();
  await expect(h.revive()).rejects.toThrow('queue refused');
  expect(h.record()).toBe(old);
  expect(old.statusUncertain).toBe(true);
  expect(old.terminalState).toBeUndefined();
  expect(h.tracker.promptMessageIDFor(childID, old.generation)).toBeUndefined();
  expect(h.interrupt).not.toHaveBeenCalled();
});

test('a generation retired during post-idle identity reads cannot publish a continuation', async () => {
  const h = retainedV2();
  const old = h.record();
  const readEntered = Promise.withResolvers<void>();
  const releaseRead = Promise.withResolvers<void>();
  let reads = 0;
  h.get.mockImplementation(async () => {
    if (++reads === 4) {
      readEntered.resolve();
      await releaseRead.promise;
    }
    return { id: childID, ...h.hostIdentity };
  });
  h.idle.resolve();
  const outcome = h.revive().catch((error: unknown) => error);
  await readEntered.promise;
  h.board.restore([{ ...old, generation: old.generation + 1 }]);
  releaseRead.resolve();
  expect(await outcome).toBeInstanceOf(Error);
  expect(h.prompt).not.toHaveBeenCalled();
  expect(h.interrupt).not.toHaveBeenCalled();
  expect(h.record().generation).toBe(old.generation + 1);
  await tick();
});

test('late idle settlement cannot retire a successor lease after timeout', async () => {
  const h = retainedV2();
  const outcome = h.revive().catch((error: unknown) => error);
  await h.entered;
  await h.timers.advance(50);
  expect(await outcome).toBeInstanceOf(Error);
  const lease = h.board.acquireLease(
    childID,
    h.record().generation,
    'relaunch',
  );
  if (!lease) throw new Error('Expected successor lease');
  const successor = h.board.registerLaunch({
    taskID: childID,
    parentSessionID: h.record().parentSessionID,
    agent: 'explorer',
    relaunchLease: lease,
  });
  h.idle.resolve();
  await tick();
  expect(h.board.validateLease(lease)).toBe(true);
  expect(h.record()).toBe(successor);
  expect(h.prompt).not.toHaveBeenCalled();
  expect(h.interrupt).not.toHaveBeenCalled();
  h.board.releaseLease(lease);
});

test('pending transport admission excludes a second revival before acknowledgement', async () => {
  const h = retainedV2();
  const entered = Promise.withResolvers<void>();
  const admit = Promise.withResolvers<unknown>();
  h.prompt.mockImplementation(() => {
    entered.resolve();
    return admit.promise;
  });
  h.idle.resolve();
  const first = h.revive();
  await entered.promise;
  await expect(h.revive()).rejects.toThrow('already has a queued continuation');
  admit.resolve({ state: 'pending' });
  await first;
  expect(h.prompt).toHaveBeenCalledTimes(1);
  expect(h.interrupt).not.toHaveBeenCalled();
});

test('an agent changed for prelaunch verification cannot survive a later identity restoration', async () => {
  const h = retainedV2();
  const old = h.record();
  let reads = 0;
  h.get.mockImplementation(async () => {
    if (++reads === 3) {
      h.hostIdentity.agent = 'fixer';
      old.agent = 'fixer';
    }
    return { id: childID, ...h.hostIdentity };
  });
  const outcome = h.revive().catch((error: unknown) => error);
  await h.entered;
  h.hostIdentity.agent = 'explorer';
  old.agent = 'explorer';
  h.idle.resolve();
  expect(await outcome).toBeInstanceOf(Error);
  expect(h.prompt).not.toHaveBeenCalled();
  expect(h.interrupt).not.toHaveBeenCalled();
});
