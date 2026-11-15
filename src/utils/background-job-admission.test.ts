import { expect, test } from 'bun:test';
import { BackgroundJobBoard } from './background-job-board';
import { boardFixture } from './background-job-fixture';

function pendingLaunch(board = new BackgroundJobBoard()) {
  const record = board.registerLaunch({
    taskID: 'ses_admission',
    parentSessionID: 'ses_parent',
    agent: 'explorer',
    pendingPromptAdmissionID: 'msg_expected',
    now: 100,
  });
  return { board, record };
}

test('pending input identity initializes uncertainty before the first observer notification', () => {
  const board = new BackgroundJobBoard();
  const observed: boolean[] = [];
  board.addMutationListener(({ record }) => {
    if (record) observed.push(record.statusUncertain);
  });
  const h = pendingLaunch(board);
  expect(h.record.statusUncertain).toBe(true);
  expect(observed).toEqual([true]);
});

test('ordinary launch and relaunch defaults remain certain without pending input identity', () => {
  const board = new BackgroundJobBoard();
  const launch = () =>
    board.registerLaunch({
      taskID: 'ses_normal',
      parentSessionID: 'ses_parent',
      agent: 'explorer',
    });
  expect(launch().statusUncertain).toBe(false);
  expect(launch().statusUncertain).toBe(false);
  expect(board.get('ses_normal')).not.toHaveProperty(
    'pendingPromptAdmissionID',
    'msg_expected',
  );
});

test('pending input stays uncertain across generic running, stop, and reconciliation observations', () => {
  const { board, record } = pendingLaunch();
  board.markRunningFromLiveSession(record.taskID, 200, record.generation);
  expect(board.get(record.taskID)?.statusUncertain).toBe(true);
  board.updateStatus({ taskID: record.taskID, state: 'running' });
  expect(board.get(record.taskID)?.statusUncertain).toBe(true);
  boardFixture.markStopped(
    board,
    record.taskID,
    'stopped',
    210,
    record.generation,
    210,
  );
  expect(board.get(record.taskID)?.statusUncertain).toBe(true);
  board.markReconciled(record.taskID);
  expect(board.get(record.taskID)?.statusUncertain).toBe(true);
});

test('only the exact generation and input identity can confirm pending admission', () => {
  const { board, record } = pendingLaunch();
  expect(
    board.confirmPromptAdmission(
      record.taskID,
      record.generation + 1,
      'msg_expected',
    ),
  ).toBe(false);
  expect(
    board.confirmPromptAdmission(record.taskID, record.generation, 'msg_other'),
  ).toBe(false);
  expect(board.get(record.taskID)?.statusUncertain).toBe(true);
  expect(
    board.confirmPromptAdmission(
      record.taskID,
      record.generation,
      'msg_expected',
    ),
  ).toBe(true);
  expect(board.get(record.taskID)?.statusUncertain).toBe(false);
});

test('a stale admission confirmation cannot clear a successor', () => {
  const { board, record } = pendingLaunch();
  board.drop(record.taskID);
  const successor = board.registerLaunch({
    taskID: record.taskID,
    parentSessionID: 'ses_parent',
    agent: 'explorer',
    pendingPromptAdmissionID: 'msg_successor',
  });
  expect(
    board.confirmPromptAdmission(
      record.taskID,
      record.generation,
      'msg_expected',
    ),
  ).toBe(false);
  expect(board.get(record.taskID)).toBe(successor);
  expect(successor.statusUncertain).toBe(true);
});
