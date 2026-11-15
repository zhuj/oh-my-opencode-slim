/**
 * Repeated-scan guards for board-injection.
 *
 * 1. Weak-provenance (host messageID) completion lookup. Replayed requests
 *    re-derive every historical completion part, so the candidate scan over the
 *    occurrence ledger is memoized per (taskID, generation). The suite pins the
 *    scan count, that a growing ledger forces a re-scan, and that matching
 *    outcomes (exact match, ambiguous, stale generation) are unchanged.
 * The suite drives the exported seams directly instead of a full hook so the
 * scan counters and board outcomes are the only moving parts.
 */
import { beforeEach, describe, expect, test } from 'bun:test';
import { BackgroundJobBoard } from '../../utils/background-job-fixture';
import {
  BACKGROUND_JOB_BOARD_METADATA_KEY,
  type InjectionState,
  observeSyntheticTerminalPart,
  occurrenceLedgerScanCountForTests,
  resetOccurrenceLedgerScanCountForTests,
  type SyntheticTerminalOccurrenceOrigin,
  updateFromInjectedCompletion,
} from './board-injection';

const PARENT_SESSION = 'ses_scan_parent';

function createState(board: BackgroundJobBoard): InjectionState {
  return {
    backgroundJobBoard: board,
    terminalGate: {
      // Echo the run back so the matched path completes like the real gate.
      reconcile: async (run: unknown) => ({ kind: 'committed', record: run }),
    },
    lifecycleLedger: {},
    processedInjectedCompletions: new Set(),
    processedInjectedCompletionOrder: [],
    injectedCompletionFences: new Map(),
    syntheticTerminalOccurrences: new Map(),
    syntheticTerminalOccurrenceOrder: [],
    getLifecycleEpoch: () => 1,
    getDeletionEpoch: () => undefined,
    terminalJobsInjectedByParent: new Map(),
    pendingInjectedTerminalJobsByParent: new Map(),
    metadataKey: BACKGROUND_JOB_BOARD_METADATA_KEY,
    shouldManageSession: () => true,
    taskContextTracker: {
      pendingManagedTaskIds: new Set(),
      contextFilesForPrompt: () => [],
      prune: () => {},
    },
  } as unknown as InjectionState;
}

function launchTask(board: BackgroundJobBoard, taskID: string): void {
  board.registerLaunch({
    taskID,
    parentSessionID: PARENT_SESSION,
    agent: 'explorer',
    description: taskID,
  });
}

function completionText(taskID: string, result: string): string {
  return [
    `<task id="${taskID}" state="completed">`,
    '<summary>Background task completed: ledger scan</summary>',
    `<task_result>${result}</task_result>`,
    '</task>',
  ].join('\n');
}

function completionPart(taskID: string, result: string, messageID?: string) {
  return {
    type: 'text',
    synthetic: true,
    messageID,
    text: completionText(taskID, result),
  };
}

function hostMessage(messageID: string, part: Record<string, unknown>) {
  return {
    info: {
      id: messageID,
      role: 'user',
      agent: 'orchestrator',
      sessionID: PARENT_SESSION,
    },
    parts: [part],
  };
}

/** The transform payload drops the host messageID; the message supplies it. */
function replayPart(part: Record<string, unknown>) {
  return { ...part, messageID: undefined };
}

function occurrenceOriginsFor(
  state: InjectionState,
  taskID: string,
): SyntheticTerminalOccurrenceOrigin[] {
  return [...(state.syntheticTerminalOccurrences?.values() ?? [])].filter(
    (origin) => origin.taskID === taskID,
  );
}

/** Observe a host-message completion exactly as the runtime event stream does. */
function observeCompletion(
  state: InjectionState,
  taskID: string,
  result: string,
  messageID: string,
): void {
  observeSyntheticTerminalPart(state, {
    ...completionPart(taskID, result, messageID),
  });
}

async function replayCompletion(
  state: InjectionState,
  taskID: string,
  result: string,
  messageID: string,
) {
  return updateFromInjectedCompletion(
    state,
    replayPart(completionPart(taskID, result, messageID)) as never,
    hostMessage(messageID, completionPart(taskID, result)) as never,
    0,
    0,
  );
}

describe('weak-provenance occurrence ledger scans', () => {
  beforeEach(() => {
    resetOccurrenceLedgerScanCountForTests();
  });

  test('replayed requests do not rescan the ledger for known parts', async () => {
    const board = new BackgroundJobBoard();
    const state = createState(board);

    const tasks = Array.from({ length: 12 }, (_, index) => ({
      taskID: `child-scan-${index}`,
      messageID: `msg-scan-${index}`,
      result: `result ${index}`,
    }));
    for (const task of tasks) {
      launchTask(board, task.taskID);
      observeCompletion(state, task.taskID, task.result, task.messageID);
    }
    // Ledger history unrelated to the parts being replayed: the scan walks all
    // of it, so the per-part cost is proportional to this too.
    for (let index = 0; index < 400; index += 1) {
      observeCompletion(
        state,
        `noise-task-${index}`,
        `noise ${index}`,
        `msg-noise-${index}`,
      );
    }
    const ledgerSize = state.syntheticTerminalOccurrences?.size;
    expect(ledgerSize).toBe(412);

    // First request: every part is seen for the first time.
    for (const task of tasks) {
      expect(
        await replayCompletion(state, task.taskID, task.result, task.messageID),
      ).toBe(board.get(task.taskID));
    }
    expect(occurrenceLedgerScanCountForTests()).toBe(tasks.length);

    // Replayed requests: identical parts over an unchanged ledger.
    resetOccurrenceLedgerScanCountForTests();
    for (const task of tasks) {
      expect(
        await replayCompletion(state, task.taskID, task.result, task.messageID),
      ).toBeUndefined();
    }
    expect(occurrenceLedgerScanCountForTests()).toBe(0);
    for (const task of tasks) {
      expect(board.get(task.taskID)?.statusUncertain).toBe(false);
      expect(board.get(task.taskID)?.lastStatusError).toBeUndefined();
    }
  });

  test('rescans when the ledger grows', async () => {
    const board = new BackgroundJobBoard();
    const state = createState(board);
    const taskID = 'child-scan-growth';
    launchTask(board, taskID);
    observeCompletion(state, taskID, 'first result', 'msg-scan-growth');

    expect(
      await replayCompletion(state, taskID, 'first result', 'msg-scan-growth'),
    ).toBe(board.get(taskID));
    expect(occurrenceLedgerScanCountForTests()).toBe(1);

    resetOccurrenceLedgerScanCountForTests();
    // A new observation for the same task: the memo must not answer for it.
    observeCompletion(state, taskID, 'second result', 'msg-scan-growth');
    expect(
      await replayCompletion(state, taskID, 'first result', 'msg-scan-growth'),
    ).toBeUndefined();

    expect(occurrenceLedgerScanCountForTests()).toBe(1);
    // Two current-generation origins for one task stay fail-closed, which is
    // exactly the outcome the pre-memo scan produced.
    expect(board.get(taskID)).toMatchObject({
      statusUncertain: true,
      lastStatusError:
        'Synthetic terminal task output origin is ambiguous: multiple current-generation host message.part.updated origins (2) could not be uniquely matched',
    });
  });

  test('keeps the exact-match provenance path intact', async () => {
    const board = new BackgroundJobBoard();
    const state = createState(board);
    const taskID = 'child-scan-exact';
    launchTask(board, taskID);
    observeCompletion(state, taskID, 'exact match', 'msg-scan-exact');

    expect(
      await replayCompletion(state, taskID, 'exact match', 'msg-scan-exact'),
    ).toBe(board.get(taskID));
    expect(occurrenceLedgerScanCountForTests()).toBe(1);
    expect(board.get(taskID)?.statusUncertain).toBe(false);
    expect(board.get(taskID)?.lastStatusError).toBeUndefined();
    expect(state.processedInjectedCompletions.size).toBe(1);
    expect(occurrenceOriginsFor(state, taskID)[0]?.phase).toBe('processed');
  });

  test('keeps two current-generation origins fail-closed', async () => {
    const board = new BackgroundJobBoard();
    const state = createState(board);
    const taskID = 'child-scan-ambiguous';
    launchTask(board, taskID);
    observeCompletion(state, taskID, 'first result', 'msg-scan-ambiguous');
    observeCompletion(state, taskID, 'second result', 'msg-scan-ambiguous');

    expect(
      await replayCompletion(
        state,
        taskID,
        'first result',
        'msg-scan-ambiguous',
      ),
    ).toBeUndefined();

    expect(board.get(taskID)).toMatchObject({
      statusUncertain: true,
      lastStatusError:
        'Synthetic terminal task output origin is ambiguous: multiple current-generation host message.part.updated origins (2) could not be uniquely matched',
    });
    expect(state.processedInjectedCompletions.size).toBe(0);
  });

  test('keeps the generation check in the candidate scan', async () => {
    const board = new BackgroundJobBoard();
    const state = createState(board);
    const taskID = 'child-scan-stale-generation';
    launchTask(board, taskID);
    observeCompletion(state, taskID, 'first result', 'msg-scan-stale');
    observeCompletion(state, taskID, 'second result', 'msg-scan-stale');

    // A rehydrated ledger can carry an origin recorded in an older generation;
    // it must not count as a current-generation candidate.
    const origins = occurrenceOriginsFor(state, taskID);
    expect(origins).toHaveLength(2);
    const staleOrigin = origins[1];
    if (!staleOrigin) throw new Error('expected two recorded origins');
    staleOrigin.generationAtObservation = 0;

    expect(
      await replayCompletion(state, taskID, 'first result', 'msg-scan-stale'),
    ).toBe(board.get(taskID));

    expect(board.get(taskID)?.statusUncertain).toBe(false);
    expect(board.get(taskID)?.lastStatusError).toBeUndefined();
  });
});
