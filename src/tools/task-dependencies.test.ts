import { expect, test } from 'bun:test';
import { BackgroundTaskConcurrency } from '../utils/background-task-concurrency';
import { executeTaskQueueList } from './task-queue-list';
import { executeTaskQueueManage } from './task-queue-manage';

test('queue dependency actions mutate parent-owned queued edges', async () => {
  // Given
  const scheduler = new BackgroundTaskConcurrency({
    defaultConcurrency: 1,
    providerConcurrency: {},
    modelConcurrency: {},
  });
  scheduler.pauseAdmissions('parent');
  const first = scheduler.acquire({ id: 'first', parentSessionID: 'parent' });
  const second = scheduler.acquire({ id: 'second', parentSessionID: 'parent' });
  void first.ready.catch((error: unknown) => error);
  void second.ready.catch((error: unknown) => error);
  const options = { scheduler, shouldManageSession: () => true };
  const context = { sessionID: 'parent', agent: 'orchestrator' };
  // When / Then: each action's observable edge replacement.
  await executeTaskQueueManage(
    options,
    {
      action: 'set_dependencies',
      admission_id: second.id,
      depends_on: ['first'],
    },
    context,
  );
  expect(second.snapshot().dependsOn).toEqual([first.id]);
  await executeTaskQueueManage(
    options,
    {
      action: 'remove_dependency',
      admission_id: second.id,
      dependency_id: 'first',
    },
    context,
  );
  expect(second.snapshot().dependsOn).toEqual([]);
  await executeTaskQueueManage(
    options,
    {
      action: 'add_dependency',
      admission_id: second.id,
      dependency_id: 'first',
    },
    context,
  );
  expect(second.snapshot().dependsOn).toEqual([first.id]);
  const listing = JSON.parse(
    await executeTaskQueueList(
      {
        ...options,
        readRuntimeStatuses: async () => ({
          statuses: new Map<string, 'idle'>(),
          malformedSessionIDs: new Set<string>(),
        }),
      },
      {},
      context,
    ),
  );
  expect(listing.admissions[1]).toMatchObject({
    id: 'second',
    admission_id: second.id,
    depends_on: [first.id],
  });
  await executeTaskQueueManage(
    options,
    { action: 'clear_dependencies', admission_id: second.id },
    context,
  );
  expect(second.snapshot().dependsOn).toEqual([]);
  scheduler.dispose();
});
