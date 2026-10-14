export interface TaskQueueToolContext {
  readonly sessionID?: string;
  readonly agent?: string;
}

export interface TaskQueueAuthorizationOptions {
  readonly shouldManageSession: (sessionID: string) => boolean;
}

export class TaskQueueToolInputError extends Error {
  readonly name = 'TaskQueueToolInputError';
}

export function requireQueueOrchestrator(
  options: TaskQueueAuthorizationOptions,
  context: TaskQueueToolContext | undefined,
  toolName:
    | 'task_queue_list'
    | 'task_queue_manage'
    | 'task_wait'
    | 'task_dependency_tree',
): string {
  const parentSessionID = context?.sessionID;
  if (!parentSessionID) {
    throw new TaskQueueToolInputError(`${toolName} requires sessionID`);
  }
  if (context.agent && context.agent !== 'orchestrator') {
    throw new TaskQueueToolInputError(
      `${toolName} can only be used by orchestrator`,
    );
  }
  if (!options.shouldManageSession(parentSessionID)) {
    throw new TaskQueueToolInputError(
      `${toolName} can only be used in orchestrator sessions`,
    );
  }
  return parentSessionID;
}
