import type { TaskDependencyFailure } from './background-task-dependencies';

export type BackgroundTaskLifecycleState =
  | 'queued'
  | 'postponed'
  | 'starting'
  | 'running'
  | 'completed'
  | 'error'
  | 'cancelled';

export type BackgroundTaskTerminalState = Extract<
  BackgroundTaskLifecycleState,
  'completed' | 'error' | 'cancelled'
>;

export const TERMINAL_STATES: ReadonlySet<BackgroundTaskLifecycleState> =
  new Set(['completed', 'error', 'cancelled']);

export const TRANSITIONS: Readonly<
  Record<BackgroundTaskLifecycleState, readonly BackgroundTaskLifecycleState[]>
> = {
  queued: ['postponed', 'starting', 'error', 'cancelled'],
  postponed: ['queued', 'error', 'cancelled'],
  starting: ['running', 'error', 'cancelled'],
  running: ['completed', 'error', 'cancelled'],
  completed: [],
  error: [],
  cancelled: [],
};

export class BackgroundTaskTransitionError extends Error {
  readonly name = 'BackgroundTaskTransitionError';

  constructor(
    readonly taskID: string,
    readonly from: BackgroundTaskLifecycleState,
    readonly to: BackgroundTaskLifecycleState,
  ) {
    super(`Cannot transition background task ${taskID} from ${from} to ${to}`);
  }
}

export class BackgroundTaskNotFoundError extends Error {
  readonly name = 'BackgroundTaskNotFoundError';

  constructor(readonly taskID: string) {
    super(`Background task admission not found: ${taskID}`);
  }
}

export type BackgroundTaskRecord = {
  readonly id: string;
  readonly logicalID: string;
  readonly dependsOn: readonly string[];
  readonly dependencyError?: string;
  readonly dependencyFailure?: TaskDependencyFailure;
  readonly state: BackgroundTaskLifecycleState;
  readonly model?: string;
  readonly provider?: string;
  readonly parentSessionID?: string;
  readonly assignedSessionID?: string;
  readonly previousSessionIDs: readonly string[];
  readonly createdAt: number;
  readonly queuedAt: number;
  readonly postponedAt?: number;
  readonly startedAt?: number;
  readonly assignedAt?: number;
  readonly updatedAt: number;
  readonly completedAt?: number;
};

export type BackgroundTaskRecordInput = {
  readonly logicalID?: string;
  readonly dependsOn?: readonly string[];
  readonly model?: string;
  readonly provider?: string;
  readonly parentSessionID?: string;
  readonly previousSessionID?: string;
};
