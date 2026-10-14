import type { BackgroundTaskConcurrencyController } from '../utils/background-task-concurrency';
import { resolveTaskDependencies } from '../utils/background-task-dependencies';
import { MAX_TASK_DEPENDENCIES } from '../utils/background-task-limits';
import { TaskQueueToolInputError } from './task-queue-auth';

export type TaskDependencyAction =
  | 'set_dependencies'
  | 'add_dependency'
  | 'remove_dependency'
  | 'clear_dependencies';

export function executeDependencyAction(
  scheduler: BackgroundTaskConcurrencyController,
  parentSessionID: string,
  args: {
    readonly action: TaskDependencyAction;
    readonly admission_id?: string;
    readonly depends_on?: readonly string[];
    readonly dependency_id?: string;
  },
): string {
  if ((args.depends_on?.length ?? 0) > MAX_TASK_DEPENDENCIES)
    throw new TaskQueueToolInputError(
      `At most ${MAX_TASK_DEPENDENCIES} dependencies are allowed`,
    );
  const record = args.admission_id
    ? scheduler.get(args.admission_id)
    : undefined;
  if (!record || record.parentSessionID !== parentSessionID) {
    throw new TaskQueueToolInputError('Unknown or unowned admission_id');
  }
  let ids: readonly string[];
  switch (args.action) {
    case 'set_dependencies':
      if (!args.depends_on)
        throw new TaskQueueToolInputError(
          'set_dependencies requires depends_on',
        );
      ids = args.depends_on;
      break;
    case 'clear_dependencies':
      ids = [];
      break;
    case 'add_dependency':
    case 'remove_dependency': {
      if (!args.dependency_id)
        throw new TaskQueueToolInputError(
          `${args.action} requires dependency_id`,
        );
      const [dependency] = resolveTaskDependencies(scheduler.list(), {
        parentSessionID,
        ids: [args.dependency_id],
      });
      if (!dependency) throw new TaskQueueToolInputError('Missing dependency');
      ids =
        args.action === 'add_dependency'
          ? [...record.dependsOn, dependency.id]
          : record.dependsOn.filter((id) => id !== dependency.id);
      break;
    }
    default: {
      const exhaustive: never = args.action;
      return exhaustive;
    }
  }
  const updated = scheduler.setDependencies(record.id, parentSessionID, ids);
  return JSON.stringify({
    action: args.action,
    effect_scope: 'parent',
    parent_session_id: parentSessionID,
    id: updated.logicalID,
    admission_id: updated.id,
    depends_on: updated.dependsOn,
    lifecycle_state: updated.state,
  });
}
