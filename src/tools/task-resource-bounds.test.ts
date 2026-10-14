/// <reference types="bun-types" />
import { expect, test } from 'bun:test';
import { tool } from '@opencode-ai/plugin';
import { BackgroundTaskConcurrency } from '../utils/background-task-concurrency';
import { expandTaskDependencyTree } from '../utils/background-task-dependencies';
import {
  createTaskDependencyTreeTool,
  executeTaskDependencyTree,
} from './task-dependency-tree';
import {
  createTaskQueueManageTool,
  executeTaskQueueManage,
} from './task-queue-manage';
import { createTaskWaitTool } from './task-wait';

function fixture() {
  const scheduler = new BackgroundTaskConcurrency({
    defaultConcurrency: 256,
    providerConcurrency: {},
    modelConcurrency: {},
  });
  const options = { scheduler, shouldManageSession: () => true };
  return {
    scheduler,
    options,
    context: { sessionID: 'parent', agent: 'orchestrator' },
  };
}

test('rejects oversized exposed arrays', () => {
  // Given
  const { scheduler, options } = fixture();
  const roots =
    createTaskDependencyTreeTool(options).task_dependency_tree.args.ids;
  const wait = createTaskWaitTool(options).task_wait.args.ids;
  const dependencies =
    createTaskQueueManageTool(options).task_queue_manage.args.depends_on;
  // When / Then
  expect(tool.schema.safeParse(roots, Array(33).fill('a')).success).toBe(false);
  expect(tool.schema.safeParse(wait, Array(129).fill('a')).success).toBe(false);
  expect(
    tool.schema.safeParse(dependencies, Array(257).fill('a')).success,
  ).toBe(false);
  scheduler.dispose();
});

test('rejects oversized direct submissions and updates without mutation', async () => {
  // Given
  const { scheduler, options, context } = fixture();
  scheduler.pauseAdmissions('parent');
  const ticket = scheduler.acquire({ id: 'root', parentSessionID: 'parent' });
  void ticket.ready.catch(() => undefined);
  const before = scheduler.list();
  const ids = Array(257).fill('root');
  // When / Then
  expect(() =>
    scheduler.acquire({ dependsOn: ids, parentSessionID: 'parent' }),
  ).toThrow(/256/);
  await expect(
    executeTaskQueueManage(
      options,
      { action: 'set_dependencies', admission_id: ticket.id, depends_on: ids },
      context,
    ),
  ).rejects.toThrow(/256/);
  await expect(
    scheduler.waitForTasks('parent', Array(129).fill('root')),
  ).rejects.toThrow(/128/);
  await expect(
    executeTaskDependencyTree(
      options,
      { ids: Array(33).fill('root'), max_depth: 0 },
      context,
    ),
  ).rejects.toThrow();
  expect(scheduler.list()).toEqual(before);
  scheduler.dispose();
});

test('returns parseable byte-bounded JSON when native IDs contain multibyte text', async () => {
  // Given
  const { scheduler, options, context } = fixture();
  const first = scheduler.acquire({ id: 'root', parentSessionID: 'parent' });
  first.bind('界'.repeat(30_000));
  // When
  const output = await executeTaskDependencyTree(
    options,
    { ids: ['root'], max_depth: 64 },
    context,
  );
  // Then
  expect(Buffer.byteLength(output)).toBeLessThanOrEqual(65_536);
  expect(JSON.parse(output)).toMatchObject({
    truncated: true,
    truncation_reasons: ['bytes'],
    omitted_tasks: 1,
  });
  scheduler.dispose();
});

test('hidden prerequisite still blocks and fails its dependent', async () => {
  // Given
  const { scheduler } = fixture();
  const prerequisites = Array.from({ length: 256 }, (_, i) =>
    scheduler.acquire({ id: `prerequisite-${i}`, parentSessionID: 'parent' }),
  );
  const dependent = scheduler.acquire({
    id: 'dependent',
    dependsOn: prerequisites.map((ticket) => ticket.id),
    parentSessionID: 'parent',
  });
  const failure = dependent.ready.catch((error: unknown) => error);
  const tree = expandTaskDependencyTree(
    scheduler.list(),
    [dependent.snapshot()],
    1,
  );
  const visible = new Set(tree.nodes.map((node) => node.record.id));
  const hidden = prerequisites.find((ticket) => !visible.has(ticket.id));
  if (!hidden) throw new Error('expected hidden prerequisite');
  hidden.bind('hidden-session');
  expect(dependent.snapshot().state).toBe('queued');
  // When
  scheduler.releaseTask('hidden-session', 'error');
  // Then
  expect(await failure).toBeInstanceOf(Error);
  expect(dependent.snapshot().state).toBe('error');
  scheduler.dispose();
});
