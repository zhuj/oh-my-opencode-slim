import { expect, test } from 'bun:test';
import { getBackgroundJobLifecycleLedger } from '../utils/background-job-board';
import { childID, retainedV2 } from './task-revive-retained-v2.fixture';

test('refusal restores the actual predecessor context captured after idle verification', async () => {
  const h = retainedV2();
  h.prompt.mockResolvedValue({ error: 'queue refused' });
  const outcome = h.revive().catch((error: unknown) => error);
  await h.entered;
  h.board.addContext(childID, [
    { path: 'during-verification.ts', lastReadAt: 123 },
  ]);
  h.idle.resolve();
  expect(await outcome).toBeInstanceOf(Error);
  expect(h.board.get(childID)?.contextFiles).toEqual([
    { path: 'during-verification.ts', lastReadAt: 123 },
  ]);
  expect(h.record().statusUncertain).toBe(true);
  expect(h.interrupt).not.toHaveBeenCalled();
});

test.each([
  'activity',
  'parent',
  'agent',
  'cancellation',
  'timeout',
  'context',
  'lease',
  'deletion epoch',
])(
  'refusal cannot overwrite same-generation %s after publication or discard its owner',
  async (change) => {
    const h = retainedV2();
    const entered = Promise.withResolvers<void>();
    const refusal = Promise.withResolvers<unknown>();
    h.prompt.mockImplementation(() => {
      entered.resolve();
      return refusal.promise;
    });
    h.idle.resolve();
    const outcome = h.revive().catch((error: unknown) => error);
    await entered.promise;
    const record = h.record();
    const promptID = record.pendingPromptAdmissionID;
    if (change === 'activity')
      h.board.markRunningFromLiveSession(childID, Date.now() + 1);
    if (change === 'parent') record.parentSessionID = 'another-parent';
    if (change === 'agent') record.agent = 'fixer';
    if (change === 'cancellation') record.cancellationRequested = true;
    if (change === 'timeout') record.timedOut = true;
    if (change === 'context')
      record.contextFiles.push({
        path: 'after-publication.ts',
        lastReadAt: 456,
      });
    if (change === 'lease') {
      const lease = h.register.mock.calls[0]?.[0].admissionLease;
      if (!lease) throw new Error('Expected admission owner');
      h.board.releaseLease(lease);
    }
    if (change === 'deletion epoch')
      getBackgroundJobLifecycleLedger(h.board).deletionEpochs.set(childID, 999);
    const changed = h.record();
    refusal.resolve({ error: 'queue refused' });
    await outcome;
    expect(h.board.get(childID)).toBe(changed);
    expect(h.record().pendingPromptAdmissionID).toBe(promptID);
    expect(h.tracker.promptMessageIDFor(childID, record.generation)).toBe(
      promptID,
    );
    expect(
      h.board.acquireLease(childID, record.generation, 'cancellation'),
    ).toBeUndefined();
    expect(h.prompt).toHaveBeenCalledTimes(1);
    expect(h.interrupt).not.toHaveBeenCalled();
  },
);

test('tracker onSettled callback mutation is applied after atomic rollback and is not erased', async () => {
  let settled = () => {};
  const h = retainedV2({}, () => settled());
  settled = () =>
    h.board.addContext(childID, [{ path: 'callback.ts', lastReadAt: 789 }]);
  h.prompt.mockResolvedValue({ error: 'queue refused' });
  h.idle.resolve();
  await expect(h.revive()).rejects.toThrow('queue refused');
  expect(h.board.get(childID)?.contextFiles).toEqual([
    { path: 'callback.ts', lastReadAt: 789 },
  ]);
  expect(h.record().statusUncertain).toBe(true);
});

test('store rollback publishes restored state only after retiring its own lease, before observer reentry', async () => {
  const h = retainedV2();
  const previous = h.record();
  let armed = false;
  let ownsSuccessor = () => false;
  h.board.addMutationListener(({ record }) => {
    if (!armed || record?.generation !== previous.generation) return;
    armed = false;
    const lease = h.board.acquireLease(
      childID,
      previous.generation,
      'relaunch',
    );
    if (!lease) return;
    h.board.registerLaunch({
      taskID: childID,
      parentSessionID: previous.parentSessionID,
      agent: previous.agent,
      relaunchLease: lease,
      pendingPromptAdmissionID: 'msg_observer',
    });
    ownsSuccessor = () => h.board.validateLease(lease);
  });
  h.prompt.mockImplementation(async () => {
    armed = true;
    return { error: 'queue refused' };
  });
  h.idle.resolve();
  await expect(h.revive()).rejects.toThrow('queue refused');
  expect(h.record().pendingPromptAdmissionID).toBe('msg_observer');
  expect(ownsSuccessor()).toBe(true);
});

test('rollback callbacks cannot lose a successor tracker or release its lease', async () => {
  let settled = () => {};
  const h = retainedV2({}, () => settled());
  let ownsSuccessor = () => false;
  settled = () => {
    const previous = h.record();
    const lease = h.board.acquireLease(
      childID,
      previous.generation,
      'relaunch',
    );
    if (!lease) return;
    const successor = h.board.registerLaunch({
      taskID: childID,
      parentSessionID: previous.parentSessionID,
      agent: previous.agent,
      relaunchLease: lease,
      pendingPromptAdmissionID: 'msg_successor',
    });
    h.tracker.register({
      taskID: childID,
      generation: successor.generation,
      parentSessionID: successor.parentSessionID,
      description: successor.description,
      promptMessageID: 'msg_successor',
      admissionLease: lease,
    });
    ownsSuccessor = () => h.board.validateLease(lease);
  };
  h.prompt.mockResolvedValue({ error: 'queue refused' });
  h.idle.resolve();
  await expect(h.revive()).rejects.toThrow('queue refused');
  expect(h.record().pendingPromptAdmissionID).toBe('msg_successor');
  expect(h.tracker.promptMessageIDFor(childID, h.record().generation)).toBe(
    'msg_successor',
  );
  expect(ownsSuccessor()).toBe(true);
  expect(h.prompt).toHaveBeenCalledTimes(1);
});
