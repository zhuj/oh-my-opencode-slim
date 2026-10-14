import { expect, spyOn, test } from 'bun:test';
import {
  type DependencyTreeNode,
  expandTaskDependencyTree,
} from './background-task-dependency-tree';
import { TASK_TREE_LIMITS } from './background-task-limits';
import type { BackgroundTaskRecord } from './background-task-state';

function record(
  id: string,
  dependsOn: readonly string[] = [],
): BackgroundTaskRecord {
  return {
    id,
    logicalID: id,
    dependsOn,
    state: 'queued',
    previousSessionIDs: [],
    createdAt: 0,
    queuedAt: 0,
    updatedAt: 0,
  };
}

// Independent recursive oracle preserves the original linear path lookup.
// Fixtures using this oracle admit all nodes as roots in sorted ID order.
function referenceCycles(nodes: readonly DependencyTreeNode[]): string[][] {
  const byID = new Map(nodes.map((node) => [node.record.id, node]));
  const complete = new Set<string>();
  const path: string[] = [];
  const cycles: string[][] = [];
  function visit(id: string): void {
    path.push(id);
    for (const next of byID.get(id)?.dependencies ?? []) {
      const from = path.indexOf(next.id);
      if (from >= 0) cycles.push([...path.slice(from), next.id]);
      else if (byID.has(next.id) && !complete.has(next.id)) visit(next.id);
    }
    path.pop();
    complete.add(id);
  }
  for (const id of byID.keys()) {
    if (!complete.has(id)) visit(id);
  }
  return cycles;
}

test('dense multi-cycle lookup avoids linear stack searches', () => {
  const ids = Array.from(
    { length: 16 },
    (_, i) => `node-${i.toString().padStart(2, '0')}`,
  );
  const records = ids.map((id) => record(id, ids));
  const linearSearch = spyOn(Array.prototype, 'findIndex');
  try {
    const expansion = expandTaskDependencyTree(records, records, 64);
    expect(expansion.cycles).toEqual(referenceCycles(expansion.nodes));
    expect(expansion.cycles).toHaveLength(136);
    expect(expansion.examinedEdges).toBe(256);
    expect(linearSearch).not.toHaveBeenCalled();
  } finally {
    linearSearch.mockRestore();
  }
});

test('witnesses match the legacy traversal for every directed three-node graph', () => {
  const ids = ['a', 'b', 'c'];
  for (let mask = 0; mask < 2 ** (ids.length ** 2); mask++) {
    const records = ids.map((id, row) =>
      record(
        id,
        ids.filter((_, column) => mask & (1 << (row * ids.length + column))),
      ),
    );
    const expansion = expandTaskDependencyTree(records, records, 64);
    expect(expansion.cycles).toEqual(referenceCycles(expansion.nodes));
    expect(
      expandTaskDependencyTree(
        [...records].reverse(),
        [...records].reverse(),
        64,
      ),
    ).toEqual(expansion);
  }
});

test('cycle witnesses retain back-edge order and clear active entries on unwind', () => {
  const a = record('a', ['c', 'b']);
  const b = record('b', ['c', 'a', 'b']);
  const c = record('c', ['b', 'a']);
  const d = record('d', ['a']);
  const expansion = expandTaskDependencyTree([d, c, b, a], [d, a], 64);
  expect(expansion.cycles).toEqual([
    ['a', 'b', 'a'],
    ['b', 'b'],
    ['a', 'b', 'c', 'a'],
    ['b', 'c', 'b'],
  ]);
});

test('acyclic and isolated graphs have no witnesses', () => {
  const a = record('a', ['b', 'c']);
  const b = record('b', ['c']);
  const c = record('c');
  const isolated = record('isolated');
  expect(
    expandTaskDependencyTree([a, b, c, isolated], [a, isolated], 64).cycles,
  ).toEqual([]);
});

test('empty roots remain invalid', () => {
  expect(() => expandTaskDependencyTree([], [], 64)).toThrow(RangeError);
});

test('depth-omitted and missing nodes do not become cycle witnesses', () => {
  const a = record('a', ['missing', 'b']);
  const b = record('b', ['a']);
  const expansion = expandTaskDependencyTree([a, b], [a], 0);
  expect(expansion.cycles).toEqual([]);
  expect(expansion.truncatedDependencyIDs).toEqual(['b', 'missing']);
  expect(expansion.truncationReasons).toEqual(['depth', 'missing']);
});

test('cycle lookup respects the node admission bound', () => {
  const leaves = Array.from({ length: TASK_TREE_LIMITS.nodes }, (_, i) =>
    record(`leaf-${i.toString().padStart(3, '0')}`, ['root']),
  );
  const root = record(
    'root',
    leaves.map((leaf) => leaf.id),
  );
  const expansion = expandTaskDependencyTree([root, ...leaves], [root], 64);
  expect(expansion.nodes).toHaveLength(TASK_TREE_LIMITS.nodes);
  expect(expansion.cycles).toEqual(
    leaves.slice(0, -1).map((leaf) => ['root', leaf.id, 'root']),
  );
  expect(expansion.truncatedDependencyIDs).toEqual(['leaf-127']);
  expect(expansion.truncationReasons).toEqual(['nodes']);
});

test('dense cycle witnesses only use edge-budgeted adjacency', () => {
  const ids = Array.from(
    { length: 23 },
    (_, i) => `node-${i.toString().padStart(2, '0')}`,
  );
  const records = ids.map((id) => record(id, ids));
  const expansion = expandTaskDependencyTree(records, records, 64);
  expect(expansion.examinedEdges).toBe(TASK_TREE_LIMITS.edges);
  expect(expansion.truncationReasons).toEqual(['edges']);
  expect(expansion.cycles).toEqual(referenceCycles(expansion.nodes));
});
