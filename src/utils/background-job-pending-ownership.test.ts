import { expect, test } from 'bun:test';
import {
  BackgroundJobBoard,
  type BackgroundJobState,
} from './background-job-board';

const states: BackgroundJobState[] = [
  'running',
  'stopped',
  'completed',
  'error',
  'cancelled',
  'reconciled',
];

function restoredPending(state: BackgroundJobState) {
  const original = new BackgroundJobBoard();
  const run = original.registerLaunch({
    taskID: 'ses_pending',
    parentSessionID: 'ses_parent',
    agent: 'explorer',
    background: true,
    pendingPromptAdmissionID: 'msg_pending',
    now: 100,
  });
  const board = new BackgroundJobBoard();
  board.restore([
    {
      ...run,
      state,
      terminalState: state === 'reconciled' ? 'completed' : undefined,
    },
  ]);
  if (state === 'running') board.markRunningFromLiveSession(run.taskID, 200);
  return { board, run };
}

for (const operation of [
  'cancellation',
  'relaunch',
  'message',
  'notification',
] as const) {
  test.each(states)(
    `persisted pending %s excludes ${operation} ownership without a tracker`,
    (state) => {
      const { board, run } = restoredPending(state);
      const authority = {
        cancellation: () =>
          board.acquireLease(run.taskID, run.generation, 'cancellation'),
        relaunch: () =>
          board.acquireLease(run.taskID, run.generation, 'relaunch'),
        message: () =>
          board.acquireLease(run.taskID, run.generation, 'message'),
        notification: () =>
          board.acquireLease(
            run.taskID,
            run.generation,
            'terminal-notification',
          ),
      }[operation]();
      expect(authority).toBeUndefined();
      expect(board.get(run.taskID)?.pendingPromptAdmissionID).toBe(
        'msg_pending',
      );
      expect(board.get(run.taskID)?.statusUncertain).toBe(true);
    },
  );
}

test.each(states)(
  'pending %s cannot be reset by an ordinary launch',
  (state) => {
    const { board, run } = restoredPending(state);
    const before = board.get(run.taskID);
    expect(() =>
      board.registerLaunch({
        taskID: run.taskID,
        parentSessionID: run.parentSessionID,
        agent: run.agent,
      }),
    ).toThrow();
    expect(board.get(run.taskID)).toBe(before);
  },
);

test('publishing pending input does not invalidate its existing admission owner', () => {
  const board = new BackgroundJobBoard();
  const previous = board.registerLaunch({
    taskID: 'ses_owned',
    parentSessionID: 'ses_parent',
    agent: 'explorer',
  });
  const lease = board.acquireLease(
    previous.taskID,
    previous.generation,
    'relaunch',
  );
  if (!lease) throw new Error('Expected admission owner');
  const pending = board.registerLaunch({
    taskID: previous.taskID,
    parentSessionID: previous.parentSessionID,
    agent: previous.agent,
    relaunchLease: lease,
    pendingPromptAdmissionID: 'msg_owned',
  });
  expect(board.validateLease(lease)).toBe(true);
  expect(
    board.confirmPromptAdmission(
      pending.taskID,
      pending.generation,
      'msg_owned',
    ),
  ).toBe(true);
  expect(board.releaseLease(lease)).toBe(true);
  expect(
    board.acquireLease(pending.taskID, pending.generation, 'relaunch'),
  ).toBeDefined();
});
