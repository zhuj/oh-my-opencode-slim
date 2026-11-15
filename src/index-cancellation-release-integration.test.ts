/// <reference types="bun-types" />
import { afterEach, expect, spyOn, test } from 'bun:test';
import { assembly, cleanups } from '../test-support/r01-terminal-assembly';

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

test('gate cancellation releases the actual scheduler admission', async () => {
  let runtimeReads = 0;
  const h = await assembly({
    readRuntime: async (_run, readStartedAt) => {
      runtimeReads += 1;
      return {
        kind: 'quiescent',
        stable: true,
        origin: 'test',
        readStartedAt,
      };
    },
  });
  const releaseSpy = spyOn(h.scheduler, 'releaseTask');
  cleanups.push(async () => releaseSpy.mockRestore());

  await h.begin();

  const aAdmission = h.scheduler
    .list('parent')
    .find((record) => record.assignedSessionID === 'child');
  if (!aAdmission) throw new Error('A admission missing');
  expect(aAdmission.state).toBe('running');
  const aLogicalID = aAdmission.logicalID;

  const bTicket = h.scheduler.acquire({ id: 'B', parentSessionID: 'parent' });
  expect(bTicket.snapshot().state).toBe('queued');

  const cTicket = h.scheduler.acquire({
    id: 'C',
    parentSessionID: 'parent',
    dependsOn: [aLogicalID],
  });
  expect(cTicket.snapshot().state).toBe('queued');
  expect(cTicket.snapshot().dependsOn).toContain(aLogicalID);
  const cReadiness = cTicket.ready.then(
    () => 'resolved' as const,
    () => 'rejected' as const,
  );
  const taskWait = h.scheduler.waitForTasks('parent', [aLogicalID]).then(
    () => 'resolved' as const,
    () => 'rejected' as const,
  );

  const board = h.board;
  const child = board.get('child');
  if (!child) throw new Error('child board record missing');
  expect(child.state).toBe('running');
  const lease = board.acquireLease('child', child.generation, 'cancellation');
  if (!lease) throw new Error('valid cancellation lease missing');

  const gate = h.gate;
  const result = await gate.reconcile(
    { taskID: 'child', generation: child.generation },
    { kind: 'cancel', lease, reason: 'test' },
  );
  if (result.kind !== 'committed')
    throw new Error(
      `Expected cancellation commit, received ${result.kind}; runtime reads: ${runtimeReads}`,
    );
  expect(runtimeReads).toBe(1);
  expect(result.record.state).toBe('cancelled');

  expect(board.get('child')?.state).toBe('cancelled');
  expect(releaseSpy).toHaveBeenCalledTimes(1);
  expect(releaseSpy).toHaveBeenCalledWith('child', 'cancelled');
  expect(h.scheduler.get(aAdmission.id)?.state).toBe('cancelled');

  await bTicket.ready;
  expect(bTicket.snapshot().state).toBe('starting');
  bTicket.bind('child-b');
  expect(bTicket.snapshot()).toMatchObject({
    state: 'running',
    assignedSessionID: 'child-b',
  });

  const [cReadinessOutcome, taskWaitOutcome] = await Promise.all([
    cReadiness,
    taskWait,
  ]);
  expect(cReadinessOutcome).toBe('rejected');
  expect(taskWaitOutcome).toBe('rejected');
  expect(cTicket.snapshot().state).toBe('error');
  expect(board.get('child')?.state).toBe('cancelled');
});
