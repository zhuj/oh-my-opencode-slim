/// <reference types="bun-types" />
import { expect, test } from 'bun:test';
import {
  expandTaskDependencyTree,
  resolveTaskDependencies,
  taskDependencyFieldsSchema,
} from './background-task-dependencies';
import type { BackgroundTaskRecord } from './background-task-state';

function record(
  id: string,
  dependsOn: readonly string[] = [],
): BackgroundTaskRecord {
  return {
    id,
    logicalID: id,
    dependsOn: [...dependsOn],
    state: 'queued',
    previousSessionIDs: [],
    createdAt: 0,
    queuedAt: 0,
    updatedAt: 0,
  };
}

test('bounds nodes when a depth-one graph is wide', () => {
  // Given
  const leaves = Array.from({ length: 256 }, (_, i) => record(`leaf-${i}`));
  const root = record(
    'root',
    leaves.map((leaf) => leaf.id),
  );
  // When
  const tree = expandTaskDependencyTree([root, ...leaves], [root], 1);
  // Then
  expect(tree.nodes).toHaveLength(128);
});

test('keeps minimum depths and truncation invariant when roots overlap', () => {
  // Given
  const c = record('c');
  const b = record('b', ['c']);
  const a = record('a', ['b']);
  // When
  const forward = expandTaskDependencyTree([a, b, c], [a, b], 1);
  const reverse = expandTaskDependencyTree([a, b, c], [b, a], 1);
  // Then
  expect(forward).toEqual(reverse);
  expect(forward.truncatedDependencyIDs).toEqual([]);
  expect(forward.nodes.map(({ record, depth }) => [record.id, depth])).toEqual([
    ['a', 0],
    ['b', 0],
    ['c', 1],
  ]);
});

test.each([-1, 65, 0.5, Number.NaN, Infinity])(
  'rejects invalid depth %s directly',
  (depth) => {
    // Given
    const root = record('root');
    // When / Then
    expect(() => expandTaskDependencyTree([root], [root], depth)).toThrow();
  },
);

test('rejects oversized dependency input before resolving IDs', () => {
  // Given
  const ids = Array.from({ length: 257 }, (_, i) => `task-${i}`);
  // When / Then
  expect(
    taskDependencyFieldsSchema.safeParse({ depends_on: ids }).success,
  ).toBe(false);
  expect(() => resolveTaskDependencies([], { ids })).toThrow(/256/);
});

test('bounds examined edges even for corrupt wide adjacency', () => {
  // Given
  const root = record(
    'root',
    Array.from({ length: 2000 }, (_, i) => `missing-${i}`),
  );
  // When
  const tree = expandTaskDependencyTree([root], [root], 0);
  // Then
  expect(tree.truncatedDependencyIDs.length).toBeLessThanOrEqual(512);
  expect(tree.examinedEdges).toBe(512);
  expect(tree.truncationReasons).toEqual(['edges', 'missing']);
  expect(tree.missingDependencyIDs).toHaveLength(512);
});

test.each([0, 64])('honors inclusive depth %s', (depth) => {
  // Given
  const chain = Array.from({ length: 66 }, (_, i) =>
    record(`node-${i}`, i < 65 ? [`node-${i + 1}`] : []),
  );
  const root = chain[0];
  if (!root) throw new Error('missing fixture');
  // When
  const tree = expandTaskDependencyTree(chain, [root], depth);
  // Then
  expect(tree.nodes).toHaveLength(depth + 1);
  expect(tree.truncationReasons).toEqual(['depth']);
});

test('rejects oversized roots directly', () => {
  // Given
  const roots = Array.from({ length: 33 }, (_, i) => record(`root-${i}`));
  // When / Then
  expect(() => expandTaskDependencyTree(roots, roots, 0)).toThrow(/32/);
});

test('distinguishes missing records from depth omissions', () => {
  // Given
  const leaf = record('leaf');
  const root = record('root', ['leaf', 'missing']);
  // When
  const tree = expandTaskDependencyTree([root, leaf], [root], 0);
  // Then
  expect(tree.missingDependencyIDs).toEqual(['missing']);
  expect(tree.truncationReasons).toEqual(['depth', 'missing']);
});
