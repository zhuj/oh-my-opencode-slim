import { z } from 'zod';
import { MAX_TASK_DEPENDENCIES } from './background-task-limits';
import type { BackgroundTaskRecord } from './background-task-state';

export type {
  DependencyTreeExpansion,
  DependencyTreeNode,
} from './background-task-dependency-tree';
export { expandTaskDependencyTree } from './background-task-dependency-tree';

export const taskDependencyIDSchema = z
  .string()
  .regex(
    /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/,
    'Task identifiers must be 1-128 letters, digits, dots, underscores, colons or hyphens',
  );
export const taskLogicalIDSchema = taskDependencyIDSchema.refine(
  (id) => !/^admission-\d+$/.test(id),
  'Reserved admission identifier',
);
export const taskDependencyFieldsSchema = z.object({
  id: taskLogicalIDSchema
    .optional()
    .describe('Parent-local logical task ID for dependency references.'),
  depends_on: z
    .array(taskDependencyIDSchema)
    .max(MAX_TASK_DEPENDENCIES)
    .optional()
    .describe(
      'Already submitted logical or admission IDs that must succeed first.',
    ),
});

export class TaskDependencyError extends Error {
  readonly name = 'TaskDependencyError';
  readonly diagnostics: TaskDependencyFailure;
  readonly reason: string;
  readonly dependencies: readonly TaskDependencyCause[];
  constructor(
    reason: string,
    dependencies: readonly BackgroundTaskRecord[] = [],
  ) {
    const samples = dependencies.slice(0, 8).map(dependencyCause);
    const directFailed: TaskDependencyCause[] = [];
    const roots = new Map<string, TaskDependencyCause>();
    let truncated = dependencies.length > samples.length;
    for (const task of dependencies) {
      if (task.state !== 'error' && task.state !== 'cancelled') continue;
      if (directFailed.length < 8) directFailed.push(dependencyCause(task));
      else truncated = true;
      const prior = task.dependencyFailure;
      truncated ||= prior?.truncated ?? false;
      for (const cause of prior?.rootCauses ?? [dependencyCause(task)]) {
        if (roots.has(cause.id)) continue;
        if (roots.size < 8) roots.set(cause.id, cause);
        else truncated = true;
      }
    }
    const boundedReason = boundDependencyMessage(reason);
    const detail = samples
      .map((task) => `${task.logicalID} (${task.id})=${task.state}`)
      .join('; ');
    const rendered = `${boundedReason}${detail ? `: ${detail}` : ''}`;
    const message = boundDependencyMessage(rendered);
    super(message);
    this.reason = boundedReason;
    this.dependencies = Object.freeze(samples);
    this.diagnostics = Object.freeze({
      code: 'TASK_DEPENDENCY_ERROR',
      directFailed: Object.freeze(directFailed),
      rootCauses: Object.freeze([...roots.values()]),
      truncated: truncated || boundedReason !== reason || message !== rendered,
    });
  }
}

export type TaskDependencyCause = Pick<
  BackgroundTaskRecord,
  'id' | 'logicalID' | 'state'
>;

export type TaskDependencyFailure = {
  readonly code: 'TASK_DEPENDENCY_ERROR';
  readonly directFailed: readonly TaskDependencyCause[];
  readonly rootCauses: readonly TaskDependencyCause[];
  readonly truncated: boolean;
};

function dependencyCause(task: TaskDependencyCause): TaskDependencyCause {
  return Object.freeze({
    id: task.id,
    logicalID: task.logicalID,
    state: task.state,
  });
}

/** Stop before allocating/encoding an unbounded diagnostic or splitting UTF-8. */
function boundDependencyMessage(value: string): string {
  let bytes = 0;
  let end = 0;
  for (const character of value) {
    bytes += Buffer.byteLength(character);
    if (bytes > 4096) break;
    end += character.length;
  }
  return value.slice(0, end);
}

export type DependencyEvaluation = {
  readonly state: 'ready' | 'waiting' | 'blocked';
  readonly dependencies: readonly BackgroundTaskRecord[];
};

/** The single readiness policy used by admission, foreground calls and waits. */
export function evaluateTaskDependencies(
  dependencies: readonly BackgroundTaskRecord[],
): DependencyEvaluation {
  if (
    dependencies.some(
      (task) => task.state === 'error' || task.state === 'cancelled',
    )
  ) {
    return { state: 'blocked', dependencies };
  }
  return {
    state: dependencies.every((task) => task.state === 'completed')
      ? 'ready'
      : 'waiting',
    dependencies,
  };
}

export function resolveTaskDependencies(
  records:
    | readonly BackgroundTaskRecord[]
    | ((id: string) => BackgroundTaskRecord | undefined),
  request: {
    readonly parentSessionID?: string;
    readonly ids: readonly string[];
    readonly self?: string;
  },
): BackgroundTaskRecord[] {
  if (request.ids.length > MAX_TASK_DEPENDENCIES)
    throw new TaskDependencyError(
      `At most ${MAX_TASK_DEPENDENCIES} dependency identifiers are allowed`,
    );
  const resolved = new Set<string>();
  const index = new Map<string, BackgroundTaskRecord>();
  if (typeof records !== 'function') {
    for (const record of records) {
      if (record.parentSessionID !== request.parentSessionID) continue;
      // Preserve the ordered scan's first-match alias precedence.
      if (!index.has(record.logicalID)) index.set(record.logicalID, record);
      if (!index.has(record.id)) index.set(record.id, record);
    }
  }
  const lookup =
    typeof records === 'function' ? records : (id: string) => index.get(id);
  return request.ids.map((id) => {
    taskDependencyIDSchema.parse(id);
    if (id === request.self)
      throw new TaskDependencyError(`Self dependency: ${id}`);
    const record = lookup(id);
    if (!record)
      throw new TaskDependencyError(
        `Unknown or cross-parent dependency: ${id}`,
      );
    if (record.id === request.self)
      throw new TaskDependencyError(`Self dependency: ${id}`);
    if (resolved.has(record.id))
      throw new TaskDependencyError(`Duplicate dependency: ${id}`);
    resolved.add(record.id);
    return record;
  });
}

export function validateDependencyCycle(
  records:
    | readonly BackgroundTaskRecord[]
    | ReadonlyMap<string, BackgroundTaskRecord>,
  target: string,
  dependencies: readonly string[],
): void {
  const byID =
    'get' in records
      ? records
      : new Map(records.map((task) => [task.id, task]));
  const pending = [...dependencies];
  const visited = new Set<string>();
  while (pending.length) {
    const id = pending.pop();
    if (id === undefined || visited.has(id)) continue;
    if (id === target)
      throw new TaskDependencyError(`Dependency cycle reaches ${target}`);
    visited.add(id);
    for (const dependency of byID.get(id)?.dependsOn ?? []) {
      if (!visited.has(dependency)) pending.push(dependency);
    }
  }
}
