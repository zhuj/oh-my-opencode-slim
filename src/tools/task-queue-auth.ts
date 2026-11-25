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

export function requireManagedQueueSession(
  options: TaskQueueAuthorizationOptions,
  context: TaskQueueToolContext | undefined,
  toolName: string,
): string {
  const parentSessionID = context?.sessionID;
  if (!parentSessionID)
    throw new TaskQueueToolInputError(`${toolName} requires sessionID`);
  if (!options.shouldManageSession(parentSessionID)) {
    throw new TaskQueueToolInputError(
      `${toolName} can only be used in managed sessions`,
    );
  }
  return parentSessionID;
}
