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

// Reuse the release's managed-parent admission: custom primary and Build
// sessions keep their task controls under the host's tool permissions.
export { assertManagedSession as requireManagedQueueSession } from './cancel-task';
