import { type ToolDefinition, tool } from '@opencode-ai/plugin';
import type { BackgroundTaskConcurrencyController } from '../utils/background-task-concurrency';
import {
  expandTaskDependencyTree,
  resolveTaskDependencies,
} from '../utils/background-task-dependencies';
import {
  TASK_TREE_LIMITS,
  type TaskTreeTruncationReason,
} from '../utils/background-task-limits';
import {
  requireQueueOrchestrator,
  type TaskQueueAuthorizationOptions,
  type TaskQueueToolContext,
} from './task-queue-auth';

const z = tool.schema;
const treeArgsSchema = z.object({
  ids: z.array(z.string()).min(1).max(TASK_TREE_LIMITS.roots),
  max_depth: z.number().int().min(0).max(TASK_TREE_LIMITS.depth),
});

export interface TaskDependencyTreeOptions
  extends TaskQueueAuthorizationOptions {
  readonly scheduler: BackgroundTaskConcurrencyController;
}

export interface TaskDependencyTreeArgs {
  readonly ids: readonly string[];
  readonly max_depth: number;
}

export async function executeTaskDependencyTree(
  options: TaskDependencyTreeOptions,
  args: TaskDependencyTreeArgs,
  context: TaskQueueToolContext | undefined,
): Promise<string> {
  treeArgsSchema.parse(args);
  const parentSessionID = requireQueueOrchestrator(
    options,
    context,
    'task_dependency_tree',
  );
  const records = options.scheduler.list(parentSessionID);
  const roots = resolveTaskDependencies(records, {
    parentSessionID,
    ids: args.ids,
  }).sort((a, b) => a.id.localeCompare(b.id));
  const expansion = expandTaskDependencyTree(records, roots, args.max_depth);
  const tasks = expansion.nodes.map(({ record, depth, dependencies }) => ({
    id: record.logicalID,
    admission_id: record.id,
    task_id: record.assignedSessionID ?? null,
    state: record.state,
    depth,
    dependency_error: record.dependencyError ?? null,
    dependency_count: record.dependsOn.length,
    dependencies_truncated: dependencies.length < record.dependsOn.length,
    depends_on: dependencies.map((dependency) => ({
      id: dependency.logicalID,
      admission_id: dependency.id,
      task_id: dependency.assignedSessionID ?? null,
      state: dependency.state,
      dependency_error: dependency.dependencyError ?? null,
    })),
    blocked_by: dependencies
      .filter((dependency) => dependency.state !== 'completed')
      .map((dependency) => dependency.logicalID),
  }));
  const reasons: TaskTreeTruncationReason[] = [...expansion.truncationReasons];
  const result = {
    effect_scope: 'parent',
    parent_session_id: parentSessionID,
    roots: roots.map((root) => root.logicalID),
    max_depth: args.max_depth,
    truncated: reasons.length > 0,
    truncation_reasons: reasons,
    limits: TASK_TREE_LIMITS,
    examined_edges: expansion.examinedEdges,
    expanded_nodes: expansion.nodes.length,
    omitted_tasks: 0,
    diagnostics_truncated: false,
    missing_dependency_ids: [...expansion.missingDependencyIDs],
    truncated_dependency_ids: [...expansion.truncatedDependencyIDs],
    cycles: [...expansion.cycles],
    tasks,
  };
  let output = JSON.stringify(result);
  if (Buffer.byteLength(output, 'utf8') > TASK_TREE_LIMITS.bytes) {
    if (!reasons.includes('bytes')) reasons.push('bytes');
    result.truncated = true;
    // The untrimmed arrays are the only sources of truth once result stops
    // pointing at them, so the search reads them instead of mutating them.
    const cycles = result.cycles;
    const truncatedIDs = result.truncated_dependency_ids;
    const missingIDs = result.missing_dependency_ids;
    // Removal order is fixed: tasks tail first, then the three diagnostic
    // tails. Encoding the state after `count` removals is therefore a pure
    // function of `count`, which keeps the encoded size monotonically
    // non-increasing: `diagnostics_truncated` is always an emitted key, so
    // flipping it replaces "false" (5 bytes) with "true" (4), and the widened
    // `omitted_tasks`/`parent_session_id` counters are dwarfed by the removed
    // element. That is what licenses the binary search below.
    const serializeAfterRemoving = (count: number): string => {
      result.omitted_tasks = Math.min(count, tasks.length);
      result.tasks = tasks.slice(0, tasks.length - result.omitted_tasks);
      let remaining = Math.max(0, count - tasks.length);
      result.diagnostics_truncated = remaining > 0;
      result.cycles = cycles.slice(0, Math.max(0, cycles.length - remaining));
      remaining = Math.max(0, remaining - cycles.length);
      result.truncated_dependency_ids = truncatedIDs.slice(
        0,
        Math.max(0, truncatedIDs.length - remaining),
      );
      remaining = Math.max(0, remaining - truncatedIDs.length);
      result.missing_dependency_ids = missingIDs.slice(
        0,
        Math.max(0, missingIDs.length - remaining),
      );
      return JSON.stringify(result);
    };
    let low = 1;
    let high =
      tasks.length + cycles.length + truncatedIDs.length + missingIDs.length;
    while (low < high) {
      const middle = Math.floor((low + high) / 2);
      if (
        Buffer.byteLength(serializeAfterRemoving(middle), 'utf8') >
        TASK_TREE_LIMITS.bytes
      ) {
        low = middle + 1;
      } else {
        high = middle;
      }
    }
    output = serializeAfterRemoving(high);
    if (Buffer.byteLength(output, 'utf8') > TASK_TREE_LIMITS.bytes) {
      // Host session IDs are not governed by the logical-ID input schema.
      result.parent_session_id = '';
      result.roots = [];
      result.diagnostics_truncated = true;
      output = JSON.stringify(result);
    }
  }
  return output;
}

export function createTaskDependencyTreeTool(
  options: TaskDependencyTreeOptions,
): Record<'task_dependency_tree', ToolDefinition> {
  const task_dependency_tree = tool({
    description:
      'Inspect parent-owned task prerequisites up to a bounded depth, including statuses, dependency edges, blockers, and cycle/truncation diagnostics.',
    args: {
      ids: treeArgsSchema.shape.ids,
      max_depth: treeArgsSchema.shape.max_depth,
    },
    execute: (args, context) =>
      executeTaskDependencyTree(options, args, context),
  });
  return { task_dependency_tree };
}
