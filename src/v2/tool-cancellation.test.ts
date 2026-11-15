import { expect, spyOn, test } from 'bun:test';
import { createTaskWaitTool } from '../tools/task-wait';
import { BackgroundTaskConcurrency } from '../utils/background-task-concurrency';
import { withTimeout } from '../utils/session';
import { adaptTool } from './adapters';

test.each(['before', 'after'])(
  'forwards v1 abort through the adapter when cancelled %s registration',
  async (when) => {
    // Given: the installed v1 plugin ToolContext contract uses `abort`.
    const scheduler = new BackgroundTaskConcurrency({
      defaultConcurrency: 1,
      providerConcurrency: {},
      modelConcurrency: {},
    });
    const ticket = scheduler.acquire({ id: 'work', parentSessionID: 'parent' });
    ticket.bind('ses_native');
    const { task_wait } = createTaskWaitTool({
      scheduler,
      shouldManageSession: () => true,
    });
    const adapted = adaptTool('task_wait', task_wait, '/project', {});
    if (typeof adapted.execute !== 'function')
      throw new Error('Missing execute');
    const controller = new AbortController();
    const remove = spyOn(controller.signal, 'removeEventListener');
    if (when === 'before') controller.abort();
    // When
    const waiting = adapted.execute(
      { ids: ['work'] },
      {
        sessionID: 'parent',
        agent: 'orchestrator',
        abort: controller.signal,
      },
    );
    controller.abort();
    // Then: aborting a waiter never cancels the requested task.
    await expect(
      withTimeout(waiting, 100, 'Cancellation not forwarded'),
    ).rejects.toThrow(/aborted/);
    expect(ticket.snapshot().state).toBe('running');
    expect(remove).toHaveBeenCalled();
    remove.mockRestore();
    scheduler.dispose();
  },
);

test('isolates simultaneous waits when an explicit invocation signal is aborted', async () => {
  // Given: an explicit invocation signal overrides both context signals.
  const scheduler = new BackgroundTaskConcurrency({
    defaultConcurrency: 1,
    providerConcurrency: {},
    modelConcurrency: {},
  });
  const ticket = scheduler.acquire({ id: 'work', parentSessionID: 'parent' });
  ticket.bind('ses_native');
  const { task_wait } = createTaskWaitTool({
    scheduler,
    shouldManageSession: () => true,
  });
  const adapted = adaptTool('task_wait', task_wait, '/project', {});
  if (typeof adapted.execute !== 'function') throw new Error('Missing execute');
  const controller = new AbortController();
  const nativeController = new AbortController();
  const legacyController = new AbortController();
  const context = {
    sessionID: 'parent',
    agent: 'orchestrator',
    signal: nativeController.signal,
    abort: legacyController.signal,
  };
  const cancelled = adapted.execute(
    { ids: ['work'] },
    context,
    controller.signal,
  );
  const surviving = adapted.execute({ ids: ['work'] }, context);
  // When
  controller.abort();
  // Then
  await expect(
    withTimeout(cancelled, 100, 'Cancellation not forwarded'),
  ).rejects.toThrow(/aborted/);
  expect(ticket.snapshot().state).toBe('running');
  expect(nativeController.signal.aborted).toBe(false);
  expect(legacyController.signal.aborted).toBe(false);
  scheduler.releaseTask('ses_native', 'completed');
  await expect(surviving).resolves.toHaveProperty('content');
  scheduler.dispose();
});

test.each(['before', 'after'])(
  'forwards native ToolContext.signal through the adapter when cancelled %s',
  async (when) => {
    // Given: two task_wait calls use independent native-shaped contexts.
    const scheduler = new BackgroundTaskConcurrency({
      defaultConcurrency: 1,
      providerConcurrency: {},
      modelConcurrency: {},
    });
    const ticket = scheduler.acquire({ id: 'work', parentSessionID: 'parent' });
    ticket.bind('ses_native');
    const { task_wait } = createTaskWaitTool({
      scheduler,
      shouldManageSession: () => true,
    });
    const adapted = adaptTool('task_wait', task_wait, '/project', {});
    if (typeof adapted.execute !== 'function')
      throw new Error('Missing execute');
    const nativeController = new AbortController();
    const legacyController = new AbortController();
    const survivingController = new AbortController();
    const remove = spyOn(nativeController.signal, 'removeEventListener');
    if (when === 'before') nativeController.abort();

    // When: only the native two-argument context signal is cancelled.
    const cancelled = adapted.execute(
      { ids: ['work'] },
      {
        sessionID: 'parent',
        agent: 'orchestrator',
        signal: nativeController.signal,
        abort: legacyController.signal,
      },
    );
    const surviving = adapted.execute(
      { ids: ['work'] },
      {
        sessionID: 'parent',
        agent: 'orchestrator',
        signal: survivingController.signal,
      },
    );
    if (when === 'after') nativeController.abort();

    let taskReleased = false;
    try {
      // Then: cancellation removes only this waiter, not the task or its peer.
      await expect(
        withTimeout(cancelled, 100, 'Cancellation not forwarded'),
      ).rejects.toThrow(/aborted/);
      expect(ticket.snapshot().state).toBe('running');
      expect(legacyController.signal.aborted).toBe(false);
      expect(survivingController.signal.aborted).toBe(false);
      expect(remove).toHaveBeenCalled();
      scheduler.releaseTask('ses_native', 'completed');
      taskReleased = true;
      await expect(surviving).resolves.toHaveProperty('content');
    } finally {
      if (!taskReleased) scheduler.releaseTask('ses_native', 'completed');
      scheduler.dispose();
      remove.mockRestore();
    }
  },
);

test.each([
  { sessionID: 'unadmitted', agent: 'fixer' },
  { sessionID: 'other', agent: 'orchestrator' },
])(
  'preserves task_wait parent admission and ownership for %j',
  async (context) => {
    const scheduler = new BackgroundTaskConcurrency({
      defaultConcurrency: 1,
      providerConcurrency: {},
      modelConcurrency: {},
    });
    scheduler
      .acquire({ id: 'work', parentSessionID: 'parent' })
      .bind('ses_native');
    const { task_wait } = createTaskWaitTool({
      scheduler,
      shouldManageSession: (sessionID) =>
        sessionID === 'parent' || sessionID === 'other',
    });
    const adapted = adaptTool('task_wait', task_wait, '/project', {});
    try {
      if (typeof adapted.execute !== 'function')
        throw new Error('Missing execute');
      // A different admitted parent still cannot address another parent's ID.
      await expect(
        adapted.execute({ ids: ['work'] }, context),
      ).rejects.toThrow();
    } finally {
      scheduler.dispose();
    }
  },
);

test.each(['build', 'custom-primary'])(
  'an admitted %s parent can wait through the adapter',
  async (agent) => {
    const scheduler = new BackgroundTaskConcurrency({
      defaultConcurrency: 1,
      providerConcurrency: {},
      modelConcurrency: {},
    });
    scheduler
      .acquire({ id: 'work', parentSessionID: 'parent' })
      .bind('ses_native');
    const { task_wait } = createTaskWaitTool({
      scheduler,
      shouldManageSession: (sessionID) => sessionID === 'parent',
    });
    const adapted = adaptTool('task_wait', task_wait, '/project', {});
    try {
      if (typeof adapted.execute !== 'function')
        throw new Error('Missing execute');
      const waiting = adapted.execute(
        { ids: ['work'] },
        { sessionID: 'parent', agent },
      );
      scheduler.releaseTask('ses_native', 'completed');
      await expect(waiting).resolves.toHaveProperty('content');
    } finally {
      scheduler.dispose();
    }
  },
);
