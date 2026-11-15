/** Input limits are authoritative; graph budgets apply only to inspection. */
export const MAX_TASK_DEPENDENCIES = 256;
export const MAX_TASK_WAIT_IDS = 128;
export const TASK_TREE_LIMITS = {
  roots: 32,
  depth: 64,
  nodes: 128,
  edges: 512,
  bytes: 65_536,
} as const;

export type TaskTreeTruncationReason =
  | 'depth'
  | 'nodes'
  | 'edges'
  | 'bytes'
  | 'missing';
