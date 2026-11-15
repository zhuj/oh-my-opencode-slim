/// <reference types="bun-types" />

import { expect, spyOn, test } from 'bun:test';
import { BackgroundJobBoard, BackgroundTaskConcurrency } from '../../utils';
import { withTimeout } from '../../utils/session';
import { createPendingCallTracker } from './pending-call-tracker';
import { handleToolExecuteBefore } from './tool-execute-hooks';

function fixture() {
  const scheduler = new BackgroundTaskConcurrency({
    defaultConcurrency: 1,
    providerConcurrency: {},
    modelConcurrency: {},
  });
  scheduler
    .acquire({ id: 'prerequisite', parentSessionID: 'parent' })
    .bind('ses_running');
  const tracker = createPendingCallTracker();
  const deps = {
    shouldManageSession: () => true,
    backgroundJobBoard: new BackgroundJobBoard(),
    backgroundTaskConcurrency: scheduler,
    pendingCallTracker: tracker,
    taskContextTracker: { pendingManagedTaskIds: new Set<string>() },
  };
  return { scheduler, tracker, deps };
}

test.each(['before', 'after'])(
  'cancels admission %s registration without cancelling prerequisites',
  async (when) => {
    // Given: signal is an explicit hook dependency, not an invented host field.
    const { scheduler, tracker, deps } = fixture();
    const controller = new AbortController();
    const remove = spyOn(controller.signal, 'removeEventListener');
    if (when === 'before') controller.abort();
    // When
    const waiting = handleToolExecuteBefore(
      { tool: 'task', sessionID: 'parent', callID: 'call' },
      {
        args: {
          subagent_type: 'fixer',
          background: true,
          id: 'queued',
          depends_on: ['prerequisite'],
        },
      },
      { ...deps, signal: controller.signal },
    );
    controller.abort();
    // Then
    await expect(
      withTimeout(waiting, 100, 'Cancellation not forwarded'),
    ).rejects.toThrow(/abort/i);
    expect(scheduler.list('parent')[0]?.state).toBe('running');
    expect(tracker.take('call')).toBeUndefined();
    expect(scheduler.snapshot().queued).toBe(0);
    if (when === 'after') expect(remove).toHaveBeenCalledTimes(1);
    remove.mockRestore();
    scheduler.dispose();
  },
);

test('a rejected old callback cannot consume a replacement pending call', async () => {
  // Given
  const { scheduler, tracker, deps } = fixture();
  const input = { tool: 'task', sessionID: 'parent', callID: 'reused' };
  const old = handleToolExecuteBefore(
    input,
    { args: { subagent_type: 'fixer', id: 'old', background: true } },
    deps,
  );
  // When: tracker replacement releases the old ticket before its catch runs.
  const replacement = handleToolExecuteBefore(
    input,
    { args: { subagent_type: 'fixer', id: 'new', background: true } },
    deps,
  );
  // Then
  await expect(old).rejects.toThrow();
  expect(
    tracker.peekByParent('parent')?.concurrencyTicket?.snapshot().logicalID,
  ).toBe('new');
  scheduler.releaseTask('ses_running', 'completed');
  await replacement;
  tracker.clearAll();
  scheduler.dispose();
});
