import { expect, test } from 'bun:test';
import type { ToolContext } from '@opencode-ai/plugin';
import { BackgroundTaskConcurrency } from '../utils/background-task-concurrency';
import { createTaskWaitTool } from './index';

function fixture() {
  const scheduler = new BackgroundTaskConcurrency({
    defaultConcurrency: 1,
    providerConcurrency: {},
    modelConcurrency: {},
  });
  const context: ToolContext = {
    sessionID: 'parent',
    messageID: 'message',
    agent: 'custom-primary',
    directory: '/project',
    worktree: '/project',
    abort: new AbortController().signal,
    metadata: () => {},
    ask: async () => {},
  };
  const { task_wait } = createTaskWaitTool({
    scheduler,
    shouldManageSession: (id) => id === 'parent',
  });
  return { scheduler, context, task_wait };
}

test('task_wait returns separate logical, admission and native identifiers', async () => {
  // Given
  const { scheduler, context, task_wait } = fixture();
  const ticket = scheduler.acquire({
    id: 'logical',
    parentSessionID: 'parent',
  });
  ticket.bind('ses_native');
  const waiting = task_wait.execute({ ids: ['logical'] }, context);
  // When
  scheduler.releaseTask('ses_native', 'completed');
  // Then
  const result = await waiting;
  expect(
    JSON.parse(typeof result === 'string' ? result : result.output),
  ).toEqual({
    state: 'completed',
    tasks: [
      {
        id: 'logical',
        admission_id: ticket.id,
        task_id: 'ses_native',
        state: 'completed',
      },
    ],
  });
  scheduler.dispose();
});

test.each(['fixer', 'explorer'])(
  'task_wait refuses an unadmitted %s session',
  async (agent) => {
    // Given
    const { scheduler, context, task_wait } = fixture();
    // When / Then
    await expect(
      task_wait.execute(
        { ids: ['missing'] },
        { ...context, sessionID: 'other', agent },
      ),
    ).rejects.toThrow(/managed sessions/);
    scheduler.dispose();
  },
);

test('task_wait reports unknown IDs before subscribing', async () => {
  // Given
  const { scheduler, context, task_wait } = fixture();
  // When / Then
  await expect(
    task_wait.execute({ ids: ['missing'] }, context),
  ).rejects.toThrow(/missing/);
  scheduler.dispose();
});
