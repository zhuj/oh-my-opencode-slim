import { TaskDependencyError } from './background-task-dependencies';

/** Stop waiting, not the task. The admission owner releases its unbound ticket. */
export function waitForAdmission(
  ready: Promise<void>,
  signal?: AbortSignal,
): Promise<void> {
  if (!signal) return ready;
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (settle: () => void) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', abort);
      settle();
    };
    const abort = () =>
      finish(() =>
        reject(new TaskDependencyError('Task admission wait aborted')),
      );
    signal.addEventListener('abort', abort, { once: true });
    void ready.then(
      () => finish(resolve),
      (error: unknown) => finish(() => reject(error)),
    );
    if (signal.aborted) abort();
  });
}
