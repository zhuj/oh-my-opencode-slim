import {
  evaluateTaskDependencies,
  TaskDependencyError,
} from './background-task-dependencies';
import { MAX_TASK_WAIT_IDS } from './background-task-limits';
import {
  BackgroundTaskNotFoundError,
  type BackgroundTaskRecord,
  type BackgroundTaskStateStore,
} from './background-task-state';

/** Subscribers run synchronously with scheduler state publication: no polling. */
export class BackgroundTaskWaiters {
  private readonly listeners = new Set<() => void>();

  constructor(private readonly onCleanup?: () => void) {}

  async waitForTasks(
    store: BackgroundTaskStateStore,
    request: {
      readonly parentSessionID: string;
      readonly ids: readonly string[];
      readonly signal?: AbortSignal;
    },
  ): Promise<BackgroundTaskRecord[]> {
    if (!request.ids.length || request.ids.length > MAX_TASK_WAIT_IDS)
      throw new TaskDependencyError(
        `task_wait requires at least one identifier and at most ${MAX_TASK_WAIT_IDS}`,
      );
    const tasks = store.resolveDependencies(request);
    const release = store.retain(tasks.map((task) => task.id));
    try {
      return await this.wait(
        () =>
          tasks.map((task) => {
            const record = store.get(task.id);
            if (!record) throw new BackgroundTaskNotFoundError(task.id);
            return record;
          }),
        request.signal,
      );
    } finally {
      release();
      this.onCleanup?.();
    }
  }

  notify(): void {
    for (const listener of [...this.listeners]) listener();
  }

  wait(
    read: () => BackgroundTaskRecord[],
    signal?: AbortSignal,
  ): Promise<BackgroundTaskRecord[]> {
    return new Promise((resolve, reject) => {
      let settled = false;
      const cleanup = () => {
        settled = true;
        this.listeners.delete(check);
        signal?.removeEventListener('abort', abort);
      };
      const abort = () => {
        if (settled) return;
        cleanup();
        reject(new TaskDependencyError('Task wait aborted'));
      };
      const check = () => {
        if (settled) return;
        let evaluation: ReturnType<typeof evaluateTaskDependencies>;
        try {
          evaluation = evaluateTaskDependencies(read());
        } catch (error) {
          cleanup();
          reject(error);
          return;
        }
        switch (evaluation.state) {
          case 'waiting':
            return;
          case 'ready':
            cleanup();
            resolve([...evaluation.dependencies]);
            return;
          case 'blocked':
            cleanup();
            reject(
              new TaskDependencyError(
                'Task wait prerequisite failed',
                evaluation.dependencies,
              ),
            );
            return;
          default: {
            const exhaustive: never = evaluation.state;
            return exhaustive;
          }
        }
      };
      if (signal?.aborted) {
        abort();
        return;
      }
      this.listeners.add(check);
      signal?.addEventListener('abort', abort, { once: true });
      check();
    });
  }
}
