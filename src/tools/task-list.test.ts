import { expect, mock, test } from 'bun:test';
import type { ToolContext } from '@opencode-ai/plugin';
import { createTaskListTool } from './task-list';

const context: ToolContext = {
  sessionID: 'ses_parent',
  messageID: 'msg_caller',
  agent: 'orchestrator',
  directory: '/project',
  worktree: '/project',
  abort: new AbortController().signal,
  metadata() {},
  async ask() {},
};

function task(id: string, fields: Record<string, unknown> = {}) {
  return {
    id: `ses_${id}`,
    parentID: context.sessionID,
    title: 'Native task',
    agent: 'explorer',
    time: { created: 100, updated: 105, busy: 103, idle: 104 },
    outcome: 'succeeded',
    ...fields,
  };
}

test('task_list reads only parent-filtered native pages and projects retained state', async () => {
  const list = mock(async () => ({
    data: [
      task('done', { title: 'A'.repeat(600) }),
      task('active', {
        outcome: 'failed',
        time: { created: 100, updated: 106, idle: 104, busy: 105 },
      }),
      task('error', { outcome: 'failed' }),
      task('cancelled', { outcome: 'interrupted' }),
      task('old', { outcome: undefined, time: { created: 95, updated: 100 } }),
      task('foreign', { parentID: 'ses_foreign', title: 'Private' }),
    ],
    cursor: { next: 'anchor6' },
  }));
  const { task_list } = createTaskListTool({ session: { list } });
  const result = JSON.parse(String(await task_list.execute({}, context)));
  expect(list).toHaveBeenCalledWith({
    parentID: 'ses_parent',
    order: 'asc',
    limit: 50,
  });
  expect(result.pagination).toMatchObject({
    returned: 5,
    total: 5,
    truncated: false,
    next_cursor: null,
  });
  expect(result.tasks).toMatchObject([
    {
      task_id: 'ses_done',
      state: 'completed',
      description: 'A'.repeat(500),
      description_truncated: true,
      timestamps: {
        launched_at: '1970-01-01T00:00:00.100Z',
        completed_at: '1970-01-01T00:00:00.104Z',
      },
    },
    {
      task_id: 'ses_active',
      state: 'running',
      timestamps: { completed_at: null },
    },
    { task_id: 'ses_error', state: 'error' },
    { task_id: 'ses_cancelled', state: 'cancelled' },
    { task_id: 'ses_old', state: 'unknown', status_uncertain: true },
  ]);
});

test('task_list returns parent-scoped resume cursors after bounded filtering', async () => {
  let page = 0;
  const list = mock(async () => {
    page += 1;
    return {
      data: [
        task(String(page), { outcome: page === 11 ? 'failed' : 'succeeded' }),
      ],
      cursor: { next: `anchor${page}` },
    };
  });
  const { task_list } = createTaskListTool({ session: { list } });
  const base = { limit: 1, statuses: ['error'] as const };
  const first = JSON.parse(
    String(
      await task_list.execute(
        { ...base, statuses: [...base.statuses] },
        context,
      ),
    ),
  );
  expect(list).toHaveBeenCalledTimes(10);
  const cursor = first.pagination.next_cursor;
  expect(typeof cursor).toBe('string');
  expect(first.pagination).toMatchObject({
    returned: 0,
    total: null,
    truncated: true,
    next_offset: 0,
  });
  await expect(
    task_list.execute(
      { ...base, statuses: [...base.statuses], cursor },
      { ...context, sessionID: 'ses_other' },
    ),
  ).rejects.toThrow('Invalid task_list cursor');
  await expect(
    task_list.execute(
      {
        ...base,
        statuses: [...base.statuses],
        cursor: 'arbitrary_host_cursor',
      },
      context,
    ),
  ).rejects.toThrow('Invalid task_list cursor');
  expect(list).toHaveBeenCalledTimes(10);
  const next = JSON.parse(
    String(
      await task_list.execute(
        { ...base, statuses: [...base.statuses], cursor },
        context,
      ),
    ),
  );
  expect(list).toHaveBeenLastCalledWith({
    parentID: 'ses_parent',
    order: 'asc',
    limit: 1,
    cursor: 'anchor10',
  });
  expect(next.tasks).toMatchObject([{ task_id: 'ses_11', state: 'error' }]);
});
