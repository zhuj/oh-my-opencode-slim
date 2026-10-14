import { type ToolDefinition, tool } from '@opencode-ai/plugin';
import type { BackgroundTaskConcurrencyController } from '../utils/background-task-concurrency';
import { MAX_TASK_WAIT_IDS } from '../utils/background-task-limits';
import {
  requireQueueOrchestrator,
  type TaskQueueAuthorizationOptions,
} from './task-queue-auth';

export function createTaskWaitTool(
  options: TaskQueueAuthorizationOptions & {
    readonly scheduler: BackgroundTaskConcurrencyController;
  },
): Record<'task_wait', ToolDefinition> {
  return {
    task_wait: tool({
      description:
        'Orchestrator only: block this session until every parent-owned logical task ID or admission ID completes. Fail immediately on unknown IDs, errors or cancellation. Native task/session IDs are not logical IDs.',
      args: {
        ids: tool.schema
          .array(tool.schema.string())
          .min(1)
          .max(MAX_TASK_WAIT_IDS),
      },
      execute: async (args, context) => {
        const parent = requireQueueOrchestrator(options, context, 'task_wait');
        const records = await options.scheduler.waitForTasks(
          parent,
          args.ids,
          context.abort,
        );
        return JSON.stringify({
          state: 'completed',
          tasks: records.map((record) => ({
            id: record.logicalID,
            admission_id: record.id,
            task_id: record.assignedSessionID ?? null,
            state: record.state,
          })),
        });
      },
    }),
  };
}
