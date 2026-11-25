import { expect, test } from 'bun:test';
import type { ToolContext } from '@opencode-ai/plugin';
import type { BackgroundTaskConcurrencyController } from '../utils/background-task-concurrency';
import { BackgroundTaskConcurrency } from '../utils/background-task-concurrency';
import { TASK_TREE_LIMITS } from '../utils/background-task-limits';
import type { BackgroundTaskRecord } from '../utils/background-task-state';
import {
  createTaskDependencyTreeTool,
  executeTaskDependencyTree,
  type TaskDependencyTreeOptions,
} from './task-dependency-tree';

function fixture() {
  const scheduler = new BackgroundTaskConcurrency({
    defaultConcurrency: 2,
    providerConcurrency: {},
    modelConcurrency: {},
  });
  const context: ToolContext = {
    sessionID: 'parent',
    messageID: 'message',
    agent: 'custom-primary',
    directory: '/project',
    worktree: '/project',
    abort: new AbortController().signal,
    metadata: () => {},
    ask: async () => {},
  };
  const { task_dependency_tree } = createTaskDependencyTreeTool({
    scheduler,
    shouldManageSession: (id) => id === 'parent',
  });
  return { scheduler, context, task_dependency_tree };
}

test('task_dependency_tree returns bounded statuses and dependency edges', async () => {
  // Given
  const { scheduler, context, task_dependency_tree } = fixture();
  scheduler.pauseAdmissions('parent');
  const root = scheduler.acquire({ id: 'root', parentSessionID: 'parent' });
  const middle = scheduler.acquire({
    id: 'middle',
    dependsOn: ['root'],
    parentSessionID: 'parent',
  });
  const leaf = scheduler.acquire({
    id: 'leaf',
    dependsOn: ['middle'],
    parentSessionID: 'parent',
  });
  for (const ticket of [root, middle, leaf]) {
    void ticket.ready.catch(() => undefined);
  }

  // When
  const output = await task_dependency_tree.execute(
    { ids: ['leaf'], max_depth: 1 },
    context,
  );

  // Then
  expect(
    JSON.parse(typeof output === 'string' ? output : output.output),
  ).toEqual(
    expect.objectContaining({
      roots: ['leaf'],
      max_depth: 1,
      truncated: true,
      tasks: expect.arrayContaining([
        expect.objectContaining({
          id: 'leaf',
          depth: 0,
          state: 'queued',
          depends_on: [
            expect.objectContaining({ id: 'middle', state: 'queued' }),
          ],
          blocked_by: ['middle'],
        }),
        expect.objectContaining({
          id: 'middle',
          depth: 1,
          state: 'queued',
          depends_on: [
            expect.objectContaining({ id: 'root', state: 'queued' }),
          ],
          blocked_by: ['root'],
        }),
      ]),
    }),
  );
  scheduler.dispose();
});

test('task_dependency_tree rejects unadmitted sessions', async () => {
  // Given
  const { scheduler, context, task_dependency_tree } = fixture();

  // When / Then
  await expect(
    task_dependency_tree.execute(
      { ids: ['missing'], max_depth: 1 },
      { ...context, sessionID: 'other', agent: 'explorer' },
    ),
  ).rejects.toThrow(/managed sessions/);
  scheduler.dispose();
});

test('task_dependency_tree rejects unknown roots before expansion', async () => {
  // Given
  const { scheduler, context, task_dependency_tree } = fixture();

  // When / Then
  await expect(
    task_dependency_tree.execute({ ids: ['missing'], max_depth: 1 }, context),
  ).rejects.toThrow(/missing/);
  scheduler.dispose();
});

// Byte-cap trimming below uses a stub controller on purpose: the real
// scheduler refuses dangling and cyclic adjacency, which is exactly the graph
// shape needed to walk the whole removal order (tasks, cycles, truncated
// dependency ids, missing dependency ids).

const PARENT_SESSION = 'parent';
const ESCAPED_SESSION_UNIT = '"\\/\b\f\n\r\t界\u{1F680}\u0000\u001f';
const ROOT_COUNT = 32;
const GHOST_PER_ROOT = 17;
const GHOST_WIDTH = 128;
const TASK_SESSION_WIDTH = 1000;
const ESCAPED_REPEATS = 300;

function pad(value: number): string {
  return value.toString().padStart(2, '0');
}

function treeRecord(
  logicalID: string,
  id: string,
  input: {
    readonly dependsOn?: readonly string[];
    readonly sessionID?: string;
    readonly parentSessionID?: string;
  },
): BackgroundTaskRecord {
  return {
    id,
    logicalID,
    dependsOn: input.dependsOn ?? [],
    state: 'queued',
    ...(input.sessionID === undefined
      ? {}
      : { assignedSessionID: input.sessionID }),
    parentSessionID: input.parentSessionID ?? PARENT_SESSION,
    previousSessionIDs: [],
    createdAt: 0,
    queuedAt: 0,
    updatedAt: 0,
  };
}

/** Only `list` is exercised, so every other controller method stays absent. */
function stubOptions(
  records: readonly BackgroundTaskRecord[],
): TaskDependencyTreeOptions {
  return {
    scheduler: {
      list: () => records.map((entry) => ({ ...entry })),
    } as unknown as BackgroundTaskConcurrencyController,
    shouldManageSession: () => true,
  };
}

function queueContext(sessionID: string): { sessionID: string; agent: string } {
  return { sessionID, agent: 'orchestrator' };
}

/**
 * 32 roots spend exactly the 512-edge budget: two edges close a single cycle
 * and the remaining 510 dangle, so `missing_dependency_ids` alone is still
 * wider than the byte cap once every task and truncated id is gone.
 */
function oversizedRecords(): {
  readonly records: BackgroundTaskRecord[];
  readonly rootIDs: readonly string[];
} {
  const records = Array.from({ length: ROOT_COUNT }, (_, root) =>
    treeRecord(`root-${pad(root)}`, `admission-${root + 1}`, {
      dependsOn:
        root === 0
          ? ['admission-2']
          : root === 1
            ? ['admission-1']
            : Array.from({ length: GHOST_PER_ROOT }, (_, index) =>
                `ghost-${pad(root)}-${pad(index)}`.padEnd(GHOST_WIDTH, 'x'),
              ),
      sessionID: 's'.repeat(TASK_SESSION_WIDTH),
    }),
  );
  return { records, rootIDs: records.map((entry) => entry.logicalID) };
}

interface SequentialTrimResult {
  parent_session_id: string;
  roots: string[];
  truncated: boolean;
  truncation_reasons: string[];
  omitted_tasks: number;
  diagnostics_truncated: boolean;
  missing_dependency_ids: string[];
  truncated_dependency_ids: string[];
  cycles: string[][];
  tasks: { readonly task_id: string | null }[];
}

/**
 * The trimmer this optimization replaced, kept verbatim as an oracle. The
 * binary search is only legitimate if it lands on the same bytes.
 */
function sequentialTrim(initial: string): {
  readonly output: string;
  readonly iterations: number;
} {
  const result = JSON.parse(initial) as SequentialTrimResult;
  let output = JSON.stringify(result);
  let iterations = 0;
  while (Buffer.byteLength(output, 'utf8') > TASK_TREE_LIMITS.bytes) {
    iterations++;
    if (!result.truncation_reasons.includes('bytes'))
      result.truncation_reasons.push('bytes');
    result.truncated = true;
    if (result.tasks.length) {
      result.tasks.pop();
      result.omitted_tasks++;
    } else if (result.cycles.length) {
      result.cycles.pop();
      result.diagnostics_truncated = true;
    } else if (result.truncated_dependency_ids.length) {
      result.truncated_dependency_ids.pop();
      result.diagnostics_truncated = true;
    } else if (result.missing_dependency_ids.length) {
      result.missing_dependency_ids.pop();
      result.diagnostics_truncated = true;
    } else {
      result.parent_session_id = '';
      result.roots = [];
      result.diagnostics_truncated = true;
    }
    output = JSON.stringify(result);
  }
  return { output, iterations };
}

interface StringifyObservation {
  readonly output: string;
  readonly payloads: readonly string[];
}

/**
 * Counts and captures the tool's own payload encodings. `finally` restores the
 * original even when the tool rejects.
 */
async function observeStringify(
  run: () => Promise<string>,
): Promise<StringifyObservation> {
  const original = JSON.stringify;
  const encoded: string[] = [];
  JSON.stringify = ((...args: readonly unknown[]) => {
    const text = (original as (...values: readonly unknown[]) => string)(
      ...args,
    );
    encoded.push(text);
    return text;
  }) as unknown as typeof JSON.stringify;
  try {
    const output = await run();
    return {
      output,
      payloads: encoded.filter((entry) => entry.includes('"effect_scope"')),
    };
  } finally {
    JSON.stringify = original;
  }
}

function initialPayload(payloads: readonly string[]): string {
  const initial = payloads[0];
  if (!initial) throw new Error('expected an untrimmed tree payload');
  return initial;
}

test('byte-cap trimming matches the sequential trimmer byte for byte', async () => {
  // Given
  const { records, rootIDs } = oversizedRecords();
  const options = stubOptions(records);

  // When
  const observed = await observeStringify(() =>
    executeTaskDependencyTree(
      options,
      { ids: rootIDs, max_depth: TASK_TREE_LIMITS.depth },
      queueContext(PARENT_SESSION),
    ),
  );

  // Then
  const sequential = sequentialTrim(initialPayload(observed.payloads));
  expect(observed.output).toBe(sequential.output);
  expect(Buffer.byteLength(observed.output)).toBeLessThanOrEqual(
    TASK_TREE_LIMITS.bytes,
  );
  // The removed set covers all four stages, ending mid `missing_dependency_ids`.
  expect(sequential.iterations).toBeGreaterThan(100);
  const parsed = JSON.parse(observed.output);
  expect(parsed.truncation_reasons).toContain('bytes');
  expect(parsed.omitted_tasks).toBe(ROOT_COUNT);
  expect(parsed.diagnostics_truncated).toBe(true);
  expect(parsed.tasks).toEqual([]);
  expect(parsed.cycles).toEqual([]);
  expect(parsed.truncated_dependency_ids).toEqual([]);
  expect(parsed.missing_dependency_ids.length).toBeGreaterThan(0);
  expect(parsed.missing_dependency_ids.length).toBeLessThan(
    ROOT_COUNT * GHOST_PER_ROOT,
  );
});

test('byte-cap trimming re-serializes logarithmically, not per removal', async () => {
  // Given
  const { records, rootIDs } = oversizedRecords();
  const options = stubOptions(records);

  // When
  const observed = await observeStringify(() =>
    executeTaskDependencyTree(
      options,
      { ids: rootIDs, max_depth: TASK_TREE_LIMITS.depth },
      queueContext(PARENT_SESSION),
    ),
  );

  // Then
  const removals = ROOT_COUNT * GHOST_PER_ROOT * 2 + ROOT_COUNT + 1;
  expect(observed.payloads.length).toBeLessThanOrEqual(14);
  expect(observed.payloads.length).toBeLessThanOrEqual(
    Math.ceil(Math.log2(removals)) + 2,
  );
  expect(observed.payloads.length).toBeGreaterThan(2);
});

test('escaped and multibyte payloads stay under the byte cap', async () => {
  // Given
  const sessions = Array.from({ length: 8 }, () =>
    ESCAPED_SESSION_UNIT.repeat(ESCAPED_REPEATS),
  );
  const records = sessions.map((sessionID, index) =>
    treeRecord(`task-${pad(index)}`, `admission-${index + 1}`, { sessionID }),
  );
  const options = stubOptions(records);

  // When
  const observed = await observeStringify(() =>
    executeTaskDependencyTree(
      options,
      { ids: records.map((entry) => entry.logicalID), max_depth: 0 },
      queueContext(PARENT_SESSION),
    ),
  );

  // Then
  const initial = initialPayload(observed.payloads);
  expect(initial).toContain('\\u0000');
  expect(Buffer.byteLength(initial)).toBeGreaterThan(TASK_TREE_LIMITS.bytes);
  expect(Buffer.byteLength(observed.output)).toBeLessThanOrEqual(
    TASK_TREE_LIMITS.bytes,
  );
  const parsed = JSON.parse(observed.output);
  expect(parsed.truncation_reasons).toEqual(['bytes']);
  expect(parsed.omitted_tasks).toBeGreaterThan(0);
  expect(parsed.omitted_tasks).toBeLessThan(sessions.length);
  // Surviving rows must be an unescaped-prefix of the fixture, in order.
  expect(parsed.tasks.map((task: { task_id: string }) => task.task_id)).toEqual(
    sessions.slice(0, parsed.tasks.length),
  );
});

test('the terminal fallback still blanks unbounded host session text', async () => {
  // Given
  const parentSessionID = 'p'.repeat(TASK_TREE_LIMITS.bytes + 4_096);
  const record = treeRecord('root-00', 'admission-1', {
    parentSessionID,
    sessionID: 's'.repeat(TASK_SESSION_WIDTH),
  });
  const options = stubOptions([record]);

  // When
  const observed = await observeStringify(() =>
    executeTaskDependencyTree(
      options,
      { ids: ['root-00'], max_depth: 0 },
      queueContext(parentSessionID),
    ),
  );

  // Then
  expect(observed.output).toBe(
    sequentialTrim(initialPayload(observed.payloads)).output,
  );
  expect(Buffer.byteLength(observed.output)).toBeLessThanOrEqual(
    TASK_TREE_LIMITS.bytes,
  );
  expect(JSON.parse(observed.output)).toMatchObject({
    parent_session_id: '',
    roots: [],
    truncated: true,
    diagnostics_truncated: true,
    truncation_reasons: ['bytes'],
    omitted_tasks: 1,
  });
  expect(JSON.parse(observed.output).tasks).toEqual([]);
});
