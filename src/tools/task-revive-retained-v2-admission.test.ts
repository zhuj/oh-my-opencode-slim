import { expect, spyOn, test } from 'bun:test';
import type { BackgroundJobLease } from '../utils/background-job-board';
import { tick } from '../utils/test-timers';
import { childID, retainedV2 } from './task-revive-retained-v2.fixture';

test('pending restored admission publishes only uncertain current rows until exact acceptance', async () => {
  const h = retainedV2();
  const entered = Promise.withResolvers<void>();
  const admit = Promise.withResolvers<unknown>();
  const published: boolean[] = [];
  h.board.addMutationListener(({ record }) => {
    if (record?.state === 'running') published.push(record.statusUncertain);
  });
  h.prompt.mockImplementation(() => {
    entered.resolve();
    return admit.promise;
  });
  h.idle.resolve();
  const outcome = h.revive().catch((error: unknown) => error);
  await entered.promise;
  try {
    expect(h.board.get(childID)?.statusUncertain).toBe(true);
    expect(published).toEqual([true]);
    const id = h.tracker.promptMessageIDFor(childID, h.record().generation);
    admit.resolve({ id, state: 'pending' });
    await outcome;
    expect(h.board.get(childID)?.statusUncertain).toBe(false);
    expect(h.board.get(childID)?.generation).toBe(h.record().generation);
  } finally {
    admit.resolve({ id: h.prompt.mock.calls[0][0].id });
    await outcome;
  }
});

test('deterministic admission deadline leaves the current row uncertain and excluded until late exact ACK', async () => {
  const h = retainedV2({ admissionTimeoutMs: 50 });
  Object.assign(h.options, { admissionTimers: h.options.idleWaitRuntime });
  const entered = Promise.withResolvers<void>();
  const admit = Promise.withResolvers<unknown>();
  h.prompt.mockImplementation(() => {
    entered.resolve();
    return admit.promise;
  });
  h.idle.resolve();
  let settled = false;
  const outcome = h.revive().then((result) => {
    settled = true;
    return result;
  });
  await entered.promise;
  try {
    await h.timers.advance(50);
    await tick();
    expect(settled).toBe(true);
    expect(await outcome).toContain('admission_unknown');
    expect(h.board.get(childID)?.statusUncertain).toBe(true);
    const generation = h.record().generation;
    expect(
      h.board.acquireLease(childID, generation, 'relaunch'),
    ).toBeUndefined();
    await expect(h.revive()).rejects.toThrow(
      'already has a queued continuation',
    );
    admit.resolve({ id: h.prompt.mock.calls[0][0].id });
    await tick();
    expect(h.board.get(childID)?.generation).toBe(generation);
    expect(h.board.get(childID)?.statusUncertain).toBe(false);
    expect(h.prompt).toHaveBeenCalledTimes(1);
    expect(h.interrupt).not.toHaveBeenCalled();
  } finally {
    admit.resolve({ id: h.prompt.mock.calls[0][0].id });
    await outcome;
  }
});

test.each([{}, { id: 'unrelated-input' }])(
  'unattributable ACK %j cannot clear current uncertainty or exclusion',
  async (ack) => {
    const h = retainedV2();
    h.prompt.mockResolvedValue(ack);
    h.idle.resolve();
    expect(await h.revive()).toContain('admission_unknown');
    expect(h.board.get(childID)?.statusUncertain).toBe(true);
    expect(
      h.board.acquireLease(childID, h.record().generation, 'relaunch'),
    ).toBeUndefined();
    await expect(h.revive()).rejects.toThrow(
      'already has a queued continuation',
    );
    expect(h.prompt).toHaveBeenCalledTimes(1);
    expect(h.interrupt).not.toHaveBeenCalled();
  },
);

test('generic running observations cannot clear unresolved restored input admission', async () => {
  const h = retainedV2();
  h.prompt.mockRejectedValue(new Error('lost ACK'));
  h.idle.resolve();
  await h.revive();
  const generation = h.record().generation;
  h.board.markRunningFromLiveSession(childID, 200, generation);
  expect(h.board.get(childID)?.statusUncertain).toBe(true);
  h.board.updateStatus({
    taskID: childID,
    state: 'running',
    expectedGeneration: generation,
  });
  expect(h.board.get(childID)?.statusUncertain).toBe(true);
  expect(h.prompt).toHaveBeenCalledTimes(1);
});

test('explicit refusal restores the current uncertain retained row with no certain observer publication', async () => {
  const h = retainedV2();
  const retained = h.record();
  const published: boolean[] = [];
  h.board.addMutationListener(({ record }) => {
    if (record) published.push(record.statusUncertain);
  });
  h.prompt.mockResolvedValue({ error: 'queue refused' });
  h.idle.resolve();
  await expect(h.revive()).rejects.toThrow('queue refused');
  expect(h.board.get(childID)).toBe(retained);
  expect(published.every(Boolean)).toBe(true);
  expect(h.record().statusUncertain).toBe(true);
  expect(h.interrupt).not.toHaveBeenCalled();
});

test('late ACK cannot clear or retire a successor generation or lease', async () => {
  const h = retainedV2({ admissionTimeoutMs: 50 });
  Object.assign(h.options, { admissionTimers: h.options.idleWaitRuntime });
  const acquire = h.board.acquireLease.bind(h.board);
  let oldLease: BackgroundJobLease | undefined;
  spyOn(h.board, 'acquireLease').mockImplementation(
    (taskID, generation, kind, options) => {
      const lease = acquire(taskID, generation, kind, options);
      oldLease ??= lease;
      return lease;
    },
  );
  const entered = Promise.withResolvers<void>();
  const admit = Promise.withResolvers<unknown>();
  h.prompt.mockImplementation(() => {
    entered.resolve();
    return admit.promise;
  });
  h.idle.resolve();
  const pending = h.revive();
  await entered.promise;
  await h.timers.advance(50);
  await pending;
  if (!oldLease) throw new Error('Expected captured admission lease');
  h.board.releaseLease(oldLease);
  const parentSessionID = h.record().parentSessionID;
  // A genuine deletion/new launch, not an unresolved-input reset, creates
  // the synthetic successor whose ownership the late ACK must preserve.
  h.board.drop(childID);
  const predecessor = h.board.registerLaunch({
    taskID: childID,
    parentSessionID,
    agent: 'explorer',
  });
  const successorLease = h.board.acquireLease(
    childID,
    predecessor.generation,
    'relaunch',
  );
  if (!successorLease) throw new Error('Expected successor lease');
  const successor = h.board.registerLaunch({
    taskID: childID,
    parentSessionID,
    agent: 'explorer',
    relaunchLease: successorLease,
    pendingPromptAdmissionID: 'msg_successor',
  });
  admit.resolve({ id: h.prompt.mock.calls[0][0].id });
  await tick();
  expect(h.board.get(childID)).toBe(successor);
  expect(h.record().statusUncertain).toBe(true);
  expect(h.board.validateLease(successorLease)).toBe(true);
  expect(h.prompt).toHaveBeenCalledTimes(1);
  expect(h.interrupt).not.toHaveBeenCalled();
  h.board.releaseLease(successorLease);
});

test('only a result attributed to the exact queued input clears lost-ACK uncertainty', async () => {
  const h = retainedV2();
  h.prompt.mockRejectedValue(new Error('lost ACK'));
  h.idle.resolve();
  await h.revive();
  const generation = h.record().generation;
  const id = h.tracker.promptMessageIDFor(childID, generation);
  if (!id) throw new Error('Expected captured input identity');
  const now = Date.now();
  h.get.mockResolvedValue({
    id: childID,
    ...h.hostIdentity,
    outcome: 'completed',
    time: { idle: now },
  });
  h.transcript.push(
    { id: 'unrelated-user', type: 'user' },
    {
      id: 'unrelated-answer',
      type: 'assistant',
      time: { completed: now },
      content: [{ type: 'text', text: 'Unrelated answer' }],
    },
  );
  h.probe.mockRestore();
  await h.tracker.probe(childID, generation);
  expect(h.board.get(childID)?.statusUncertain).toBe(true);
  h.transcript.push(
    { id, type: 'user' },
    {
      id: 'exact-answer',
      type: 'assistant',
      time: { completed: Date.now() },
      content: [{ type: 'text', text: 'Attributable answer' }],
    },
  );
  await h.tracker.probe(childID, generation);
  expect(h.board.get(childID)?.state).toBe('completed');
  expect(h.board.get(childID)?.statusUncertain).toBe(false);
  expect(h.prompt).toHaveBeenCalledTimes(1);
  expect(h.interrupt).not.toHaveBeenCalled();
});
