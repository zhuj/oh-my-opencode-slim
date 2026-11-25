import {
  TASK_TREE_LIMITS,
  type TaskTreeTruncationReason,
} from './background-task-limits';
import type { BackgroundTaskRecord } from './background-task-state';

export type DependencyTreeNode = {
  readonly record: BackgroundTaskRecord;
  readonly depth: number;
  readonly dependencies: readonly BackgroundTaskRecord[];
};

export type DependencyTreeExpansion = {
  readonly nodes: readonly DependencyTreeNode[];
  readonly truncatedDependencyIDs: readonly string[];
  readonly missingDependencyIDs: readonly string[];
  readonly truncationReasons: readonly TaskTreeTruncationReason[];
  readonly examinedEdges: number;
  readonly cycles: readonly (readonly string[])[];
};

/** Multi-source BFS: root order cannot change admission, depth or omissions. */
export function expandTaskDependencyTree(
  records: readonly BackgroundTaskRecord[],
  roots: readonly BackgroundTaskRecord[],
  maxDepth: number,
): DependencyTreeExpansion {
  if (
    !Number.isInteger(maxDepth) ||
    maxDepth < 0 ||
    maxDepth > TASK_TREE_LIMITS.depth
  )
    throw new RangeError(
      `max_depth must be an integer from 0 to ${TASK_TREE_LIMITS.depth}`,
    );
  if (!roots.length || roots.length > TASK_TREE_LIMITS.roots)
    throw new RangeError(`Expected 1-${TASK_TREE_LIMITS.roots} roots`);
  const byID = new Map(records.map((task) => [task.id, task]));
  const nodes = new Map<string, DependencyTreeNode>();
  const queue: DependencyTreeNode[] = [];
  const missing = new Set<string>();
  const omitted = new Map<
    string,
    { readonly id: string; readonly reason: 'depth' | 'nodes' }
  >();
  const reasons = new Set<TaskTreeTruncationReason>();
  let examinedEdges = 0;
  for (const record of [...roots].sort((a, b) => a.id.localeCompare(b.id))) {
    if (nodes.has(record.id)) continue;
    const node = { record, depth: 0, dependencies: [] };
    nodes.set(record.id, node);
    queue.push(node);
  }
  for (const node of queue) {
    const dependencies: BackgroundTaskRecord[] = [];
    // Slice before sorting: even corrupt legacy adjacency cannot expand work.
    const budget = TASK_TREE_LIMITS.edges - examinedEdges;
    if (node.record.dependsOn.length > budget) reasons.add('edges');
    const ids = node.record.dependsOn.slice(0, budget).sort();
    for (const id of ids) {
      examinedEdges++;
      const dependency = byID.get(id);
      if (!dependency) {
        missing.add(id);
        continue;
      }
      dependencies.push(dependency);
      if (nodes.has(id)) continue;
      if (node.depth >= maxDepth || nodes.size >= TASK_TREE_LIMITS.nodes) {
        omitted.set(id, {
          id: dependency.logicalID,
          reason: node.depth >= maxDepth ? 'depth' : 'nodes',
        });
        continue;
      }
      const child = {
        record: dependency,
        depth: node.depth + 1,
        dependencies: [],
      };
      nodes.set(id, child);
      queue.push(child);
    }
    nodes.set(node.record.id, { ...node, dependencies });
  }
  const truncated = new Set(missing);
  for (const [id, omission] of omitted) {
    if (nodes.has(id)) continue;
    reasons.add(omission.reason);
    truncated.add(omission.id);
  }
  if (missing.size) reasons.add('missing');
  const ordered = [...nodes.values()].sort(
    (a, b) => a.depth - b.depth || a.record.id.localeCompare(b.record.id),
  );
  return {
    nodes: ordered,
    truncatedDependencyIDs: [...truncated].sort(),
    missingDependencyIDs: [...missing].sort(),
    truncationReasons: [...reasons].sort(),
    examinedEdges,
    cycles: findCycles(nodes),
  };
}

/** DFS only over the admitted, edge-budgeted graph; one witness per back edge. */
function findCycles(
  nodes: ReadonlyMap<string, DependencyTreeNode>,
): string[][] {
  const complete = new Set<string>();
  const active = new Map<string, number>();
  const cycles: string[][] = [];
  for (const start of nodes.keys()) {
    if (complete.has(start)) continue;
    const stack = [{ id: start, index: 0 }];
    active.set(start, 0);
    while (stack.length) {
      const frame = stack[stack.length - 1];
      if (!frame) break;
      const next = nodes.get(frame.id)?.dependencies[frame.index++];
      const from = next ? active.get(next.id) : undefined;
      if (!next) {
        complete.add(frame.id);
        active.delete(frame.id);
        stack.pop();
      } else if (from !== undefined) {
        cycles.push([...stack.slice(from).map((entry) => entry.id), next.id]);
      } else if (nodes.has(next.id) && !complete.has(next.id)) {
        active.set(next.id, stack.length);
        stack.push({ id: next.id, index: 0 });
      }
    }
  }
  return cycles;
}
