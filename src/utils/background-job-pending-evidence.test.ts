import { expect, mock, test } from 'bun:test';
import { createRevivedRunTracker } from '../hooks/task-session-manager/revived-run-tracker';
import { timerSeams } from '../tools/task-pending-store.fixture';
import { retainedV2 } from '../tools/task-revive-retained-v2.fixture';
import { BackgroundJobBoard } from './background-job-board';
import { boardFixture } from './background-job-fixture';
import { createBackgroundJobTerminalGate } from './background-job-terminal-gate';

function assembly() {
  const board = new BackgroundJobBoard();
  const original = board.registerLaunch({
    taskID: 'ses_evidence',
    parentSessionID: 'ses_parent',
    agent: 'explorer',
    background: true,
    now: 100,
  });
  const lease = board.acquireRelaunchLease(
    original.taskID,
    original.generation,
  );
  if (!lease) throw new Error('Expected admission lease');
  const run = board.registerLaunch({
    taskID: original.taskID,
    parentSessionID: original.parentSessionID,
    agent: original.agent,
    pendingPromptAdmissionID: 'msg_expected',
    relaunchLease: lease,
    now: 101,
  });
  return { board, run, lease };
}

test('an exact-input aborted answer settles only its held admission lease', async () => {
  const h = retainedV2();
  h.prompt.mockRejectedValue(new Error('lost ACK'));
  h.idle.resolve();
  await h.revive();
  const record = h.record();
  const lease = h.register.mock.calls[0]?.[0].admissionLease;
  if (!lease) throw new Error('Expected held admission lease');
  expect(h.board.validateLease(lease)).toBe(true);
  h.transcript.push(
    { id: record.pendingPromptAdmissionID, type: 'user' },
    {
      id: 'aborted-answer',
      type: 'assistant',
      error: { name: 'MessageAbortedError' },
    },
  );
  h.probe.mockRestore();
  await h.tracker.probe(record.taskID, record.generation);
  expect(h.board.get(record.taskID)?.state).toBe('error');
  expect(h.board.get(record.taskID)?.pendingPromptAdmissionID).toBeUndefined();
  expect(h.board.get(record.taskID)?.statusUncertain).toBe(false);
  expect(h.board.validateLease(lease)).toBe(false);
  expect(h.interrupt).not.toHaveBeenCalled();
});

test.each(['completed', 'error', 'cancelled'] as const)(
  'generic %s cannot settle unresolved input or invoke settlement callbacks',
  (state) => {
    const { board, run, lease } = assembly();
    const onSettled = mock(() => {});
    const gate = createBackgroundJobTerminalGate({ backgroundJobBoard: board });
    // No host calls are possible; this tracker only receives a generic board publication.
    const tracker = createRevivedRunTracker({
      input: retainedV2().input,
      backgroundJobBoard: board,
      terminalGate: gate,
      onSettled,
    });
    try {
      tracker.register({
        ...run,
        promptMessageID: 'msg_expected',
        admissionLease: lease,
      });
      if (state === 'cancelled') {
        board.restore([
          { ...run, state, terminalState: state, resultSummary: 'generic' },
        ]);
      } else {
        boardFixture.updateStatus(board, {
          taskID: run.taskID,
          state,
          resultSummary: 'generic',
        });
      }
      const terminal = board.get(run.taskID);
      if (!terminal) throw new Error('Expected board publication');
      tracker.onTerminal(terminal);
      expect(board.get(run.taskID)?.pendingPromptAdmissionID).toBe(
        'msg_expected',
      );
      expect(board.get(run.taskID)?.statusUncertain).toBe(true);
      expect(board.validateLease(lease)).toBe(true);
      expect(onSettled).not.toHaveBeenCalled();
    } finally {
      tracker.dispose();
      gate.dispose();
    }
  },
);

test('a historical answer cannot publish terminal state for persisted pending input', async () => {
  const { run } = assembly();
  const board = new BackgroundJobBoard();
  board.restore([run]);
  board.markRunningFromLiveSession(run.taskID, 200);
  const timers = timerSeams();
  const gate = createBackgroundJobTerminalGate({
    backgroundJobBoard: board,
    now: timers.now,
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
    readRuntime: async () => ({
      kind: 'quiescent',
      origin: 'fake',
      readStartedAt: timers.now(),
      stable: true,
    }),
    readTerminalEvidence: async () => ({
      data: [
        {
          info: {
            id: 'historical-answer',
            role: 'assistant',
            time: { completed: 200 },
          },
          parts: [{ type: 'text', text: 'Historical answer' }],
        },
      ],
    }),
    graceMs: 0,
  });
  try {
    await gate.reconcile(run);
    await gate.reconcile(run);
    expect(board.get(run.taskID)?.state).toBe('running');
    expect(board.get(run.taskID)?.resultSummary).toBeUndefined();
    expect(board.get(run.taskID)?.pendingPromptAdmissionID).toBe(
      'msg_expected',
    );
  } finally {
    gate.dispose();
  }
});

test.each(['running', 'completed', 'cancelled', 'reconciled'] as const)(
  'persisted pending %s requires exact-input evidence without a tracker',
  async (state) => {
    const { board: old, run } = assembly();
    const board = new BackgroundJobBoard();
    board.restore([
      { ...(old.get(run.taskID) ?? run), state, terminalState: 'completed' },
    ]);
    if (state === 'running') board.markRunningFromLiveSession(run.taskID, 200);
    const timers = timerSeams();
    let transcript: unknown = {
      data: [
        {
          info: {
            id: 'old-answer',
            role: 'assistant',
            time: { completed: 200 },
          },
          parts: [{ type: 'text', text: 'Historical answer' }],
        },
      ],
    };
    const gate = createBackgroundJobTerminalGate({
      backgroundJobBoard: board,
      now: timers.now,
      setTimeout: timers.setTimeout,
      clearTimeout: timers.clearTimeout,
      readRuntime: async () => ({
        kind: 'quiescent',
        origin: 'fake',
        readStartedAt: timers.now(),
        stable: true,
      }),
      readTerminalEvidence: async () => transcript,
      graceMs: 0,
    });
    try {
      await gate.reconcile(run);
      expect(board.get(run.taskID)?.pendingPromptAdmissionID).toBe(
        'msg_expected',
      );
      expect(
        board.acquireRelaunchLease(run.taskID, run.generation),
      ).toBeUndefined();
      transcript = {
        data: [
          { info: { id: 'msg_expected', role: 'user' }, parts: [] },
          {
            info: {
              id: 'answer',
              role: 'assistant',
              error: { name: 'MessageAbortedError' },
            },
            parts: [],
          },
        ],
      };
      await gate.reconcile(run);
      expect(board.get(run.taskID)?.state).toBe('error');
      expect(board.get(run.taskID)?.pendingPromptAdmissionID).toBeUndefined();
      expect(board.get(run.taskID)?.statusUncertain).toBe(false);
    } finally {
      gate.dispose();
    }
  },
);
