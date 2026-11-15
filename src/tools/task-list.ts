import { type ToolDefinition, tool } from '@opencode-ai/plugin';
import type {
  BackgroundJobBoard,
  BackgroundJobState,
} from '../utils/background-job-board';

const z = tool.schema;
const MAX_DESCRIPTION_LENGTH = 500;
const STATUSES = [
  'running',
  'completed',
  'error',
  'cancelled',
  'stopped',
  'reconciled',
] as const satisfies readonly BackgroundJobState[];
const argsSchema = z.object({
  statuses: z
    .array(z.enum(STATUSES))
    .optional()
    .describe(
      'Retained states to include; omitted means all, empty means none',
    ),
  offset: z.number().int().min(0).optional(),
  limit: z.number().int().min(1).max(100).optional(),
});

class TaskListInputError extends Error {
  readonly name = 'TaskListInputError';
}

export function createTaskListTool(options: {
  readonly backgroundJobBoard: BackgroundJobBoard;
}): Record<'task_list', ToolDefinition> {
  return {
    task_list: tool({
      description:
        'List retained tasks owned by the calling session without changing them. Uses stored states, not live status or queue admissions. Returns bounded pages ordered by launch time, with ISO timestamps.',
      args: argsSchema.shape,
      async execute(rawArgs, context) {
        const parentSessionID = context?.sessionID;
        if (!parentSessionID) {
          throw new TaskListInputError('task_list requires sessionID');
        }
        const args = argsSchema.parse(rawArgs);
        const statuses = args.statuses
          ? new Set<BackgroundJobState>(args.statuses)
          : undefined;
        const filtered = options.backgroundJobBoard
          .list(parentSessionID)
          .filter((job) => !statuses || statuses.has(job.state));
        const offset = args.offset ?? 0;
        const limit = args.limit ?? 50;
        const tasks = filtered.slice(offset, offset + limit).map((job) => ({
          task_id: job.taskID,
          alias: job.alias,
          agent: job.agent,
          description: job.description.slice(0, MAX_DESCRIPTION_LENGTH),
          description_truncated:
            job.description.length > MAX_DESCRIPTION_LENGTH,
          state: job.state,
          background: job.background,
          status_uncertain: job.statusUncertain,
          timestamps: {
            launched_at: new Date(job.launchedAt).toISOString(),
            updated_at: new Date(
              Math.max(
                job.launchedAt,
                job.lastLaunchedAt,
                job.lastLiveBusyAt ?? 0,
                job.completedAt ?? 0,
                job.lastUsedAt,
              ),
            ).toISOString(),
            completed_at:
              job.completedAt === undefined
                ? null
                : new Date(job.completedAt).toISOString(),
          },
        }));
        return JSON.stringify({
          effect_scope: 'parent',
          parent_session_id: parentSessionID,
          pagination: {
            offset,
            limit,
            total: filtered.length,
            returned: tasks.length,
            truncated: offset + tasks.length < filtered.length,
          },
          tasks,
        });
      },
    }),
  };
}
