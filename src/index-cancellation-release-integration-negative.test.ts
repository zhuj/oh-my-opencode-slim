/// <reference types="bun-types" />
import { afterEach, expect, spyOn, test } from 'bun:test';
import { assembly, cleanups } from '../test-support/r01-terminal-assembly';

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

test('unknown runtime keeps the actual scheduler admission active', async () => {
  let runtimeReads = 0;
  const h = await assembly({
    readRuntime: async (_run, readStartedAt) => {
      runtimeReads += 1;
      return { kind: 'unknown', origin: 'test', readStartedAt };
    },
    maxEvidenceRetries: 0,
  });
  const releaseSpy = spyOn(h.scheduler, 'releaseTask');
  cleanups.push(async () => releaseSpy.mockRestore());

  await h.begin();

  const aAdmission = h.scheduler
    .list('parent')
    .find((record) => record.assignedSessionID === 'child');
  if (!aAdmission) throw new Error('A admission missing');
  expect(aAdmission.state).toBe('running');

  const bTicket = h.scheduler.acquire({ id: 'B', parentSessionID: 'parent' });
  expect(bTicket.snapshot().state).toBe('queued');

  const coordinator = h.board;
  const child = coordinator.get('child');
  if (!child) throw new Error('child board record missing');
  expect(child.state).toBe('running');
  const lease = coordinator.acquireCancellationLease('child', child.generation);
  if (!lease) throw new Error('valid cancellation lease missing');
  expect(coordinator.validateLease(lease)).toBe(true);

  const gate = h.gate;
  const result = await gate.reconcile(
    { taskID: 'child', generation: child.generation },
    { kind: 'cancel', lease, reason: 'test' },
  );
  expect(result.kind).toBe('deferred');
  expect(runtimeReads).toBe(1);
  expect(coordinator.get('child')?.state).toBe('running');
  expect(releaseSpy).not.toHaveBeenCalled();
  expect(h.scheduler.get(aAdmission.id)?.state).toBe('running');
  expect(h.scheduler.snapshot().active).toBe(1);
  expect(bTicket.snapshot().state).toBe('queued');
});
