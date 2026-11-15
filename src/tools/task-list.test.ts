import { describe, expect, test } from 'bun:test';
import type { ToolContext, ToolResult } from '@opencode-ai/plugin';
import { z } from 'zod';
import {
  BackgroundJobBoard,
  type BackgroundJobState,
} from '../utils/background-job-board';
import { createTaskListTool } from './task-list';

const context: ToolContext = {
  sessionID: 'parent',
  messageID: 'message',
  agent: 'orchestrator',
  directory: '/fixture',
  worktree: '/fixture',
  abort: new AbortController().signal,
  metadata() {},
  async ask() {},
};
const states = [
  'running',
  'completed',
  'error',
  'cancelled',
  'stopped',
  'reconciled',
] as const satisfies readonly BackgroundJobState[];

function fixture(count = states.length) {
  const board = new BackgroundJobBoard();
  for (let index = 0; index < count; index++) {
    const job = board.registerLaunch({
      taskID: `task-${index}`,
      parentSessionID: 'parent',
      agent: 'fixer',
      description: 'fixture',
      now: index * 1_000,
      background: true,
    });
    job.state = states[index % states.length] ?? 'running';
  }
  board.registerLaunch({
    taskID: 'foreign',
    parentSessionID: 'other-parent',
    agent: 'oracle',
    description: 'private',
    now: 0,
  });
  return {
    board,
    task: createTaskListTool({ backgroundJobBoard: board }).task_list,
  };
}

function decode(result: ToolResult) {
  if (typeof result !== 'string') throw new TypeError('Expected JSON string');
  return z
    .object({
      parent_session_id: z.string(),
      pagination: z.object({
        offset: z.number(),
        limit: z.number(),
        total: z.number(),
        returned: z.number(),
        truncated: z.boolean(),
      }),
      tasks: z.array(
        z
          .object({
            task_id: z.string(),
            alias: z.string(),
            agent: z.string(),
            description: z.string(),
            description_truncated: z.boolean(),
            state: z.enum(states),
            background: z.boolean(),
            status_uncertain: z.boolean(),
            timestamps: z.object({
              launched_at: z.string(),
              updated_at: z.string(),
              completed_at: z.string().nullable(),
            }),
          })
          .strict(),
      ),
    })
    .parse(JSON.parse(result));
}

describe('task_list', () => {
  test('lists every retained state for only the calling parent', async () => {
    // Given
    const { task, board } = fixture();
    const before = JSON.stringify(board.list());
    // When
    const output = decode(await task.execute({}, context));
    // Then
    expect(output.parent_session_id).toBe('parent');
    expect(output.tasks.map((job) => job.state)).toEqual(states);
    expect(output.tasks.map((job) => job.task_id)).toEqual(
      states.map((_, index) => `task-${index}`),
    );
    expect(output.tasks[0]).toEqual({
      task_id: 'task-0',
      alias: 'fix-1',
      agent: 'fixer',
      description: 'fixture',
      description_truncated: false,
      state: 'running',
      background: true,
      status_uncertain: false,
      timestamps: {
        launched_at: '1970-01-01T00:00:00.000Z',
        updated_at: '1970-01-01T00:00:00.000Z',
        completed_at: null,
      },
    });
    expect(JSON.stringify(board.list())).toBe(before);
  });

  test('filters by a status set independently of its order and duplicates', async () => {
    // Given
    const { task } = fixture();
    // When
    const first = await task.execute(
      { statuses: ['reconciled', 'running', 'running'] },
      context,
    );
    const second = await task.execute(
      { statuses: ['running', 'reconciled'] },
      context,
    );
    // Then
    expect(first).toBe(second);
    expect(decode(first).tasks.map((job) => job.task_id)).toEqual([
      'task-0',
      'task-5',
    ]);
  });

  test.each(states)('filters the canonical %s state', async (state) => {
    // Given
    const { task } = fixture();
    // When
    const output = decode(await task.execute({ statuses: [state] }, context));
    // Then
    expect(output.tasks).toHaveLength(1);
    expect(output.tasks[0].state).toBe(state);
  });

  test('returns no tasks for an empty status set', async () => {
    // Given
    const { task } = fixture();
    // When
    const output = decode(await task.execute({ statuses: [] }, context));
    // Then
    expect(output.tasks).toEqual([]);
    expect(output.pagination.total).toBe(0);
  });

  test('returns an empty page for a parent without records', async () => {
    // Given
    const { task } = fixture();
    // When
    const output = decode(
      await task.execute({}, { ...context, sessionID: 'empty' }),
    );
    // Then
    expect(output.tasks).toEqual([]);
    expect(output.pagination).toEqual({
      offset: 0,
      limit: 50,
      total: 0,
      returned: 0,
      truncated: false,
    });
  });

  test('rejects an absent parent instead of performing a global listing', async () => {
    // Given
    const { task } = fixture();
    // When / Then
    await expect(
      task.execute({}, { ...context, sessionID: '' }),
    ).rejects.toThrow('sessionID');
  });

  test.each([
    { statuses: ['queued'] },
    { statuses: 'running' },
    { limit: 101 },
    { limit: 0 },
    { offset: -1 },
    { offset: 0.5 },
  ])('rejects invalid arguments %j', async (args) => {
    // Given
    const { task } = fixture();
    // When / Then
    await expect(task.execute(args, context)).rejects.toThrow();
  });

  test('bounds pages and applies filtering before pagination', async () => {
    // Given
    const { task } = fixture(105);
    // When
    const output = decode(await task.execute({}, context));
    const filtered = decode(
      await task.execute(
        { statuses: ['running'], offset: 1, limit: 2 },
        context,
      ),
    );
    // Then
    expect(output.tasks).toHaveLength(50);
    expect(output.pagination).toEqual({
      offset: 0,
      limit: 50,
      total: 105,
      returned: 50,
      truncated: true,
    });
    expect(filtered.tasks.map((job) => job.task_id)).toEqual([
      'task-6',
      'task-12',
    ]);
    expect(filtered.pagination.total).toBe(18);
  });

  test('bounds descriptions and omits retained result payloads', async () => {
    // Given
    const { task, board } = fixture();
    const job = board.get('task-0');
    if (!job) throw new TypeError('Missing fixture');
    job.description = 'x'.repeat(2_000);
    job.resultSummary = 'private result';
    job.completedAt = 1_000;
    // When
    const output = decode(await task.execute({ limit: 1 }, context));
    // Then
    expect(output.tasks[0].description).toHaveLength(500);
    expect(output.tasks[0].description_truncated).toBe(true);
    expect(output.tasks[0]).not.toHaveProperty('resultSummary');
    expect(output.tasks[0].timestamps.completed_at).toBe(
      '1970-01-01T00:00:01.000Z',
    );
  });
});
