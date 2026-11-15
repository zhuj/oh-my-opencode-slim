import { expect, mock, test } from 'bun:test';
import { BackgroundJobSupervisor } from '../utils/background-job-supervisor';
import { createBackgroundJobTerminalGate } from '../utils/background-job-terminal-gate';
import { createCancelTaskTool } from './cancel-task';
import { pendingRoundtrip, timerSeams } from './task-pending-store.fixture';
import { childID, parentID } from './task-revive-retained-v2.fixture';

test.each(['revive', 'cancel', 'supervisor', 'native resume'])(
  'real snapshot/manager restoration excludes %s after a generic observation',
  async (consumer) => {
    const { h, board, saved, manager, dispose } = await pendingRoundtrip();
    const timers = timerSeams();
    const gate = createBackgroundJobTerminalGate({
      backgroundJobBoard: board,
      input: h.input,
      now: timers.now,
      setTimeout: timers.setTimeout,
      clearTimeout: timers.clearTimeout,
    });
    const abort = mock(async () => ({}));
    const supervisor = new BackgroundJobSupervisor({
      backgroundJobStore: board,
      terminalGate: gate,
      wallClockTimeoutMs: 50,
      abortGraceMs: 10,
      abort,
      now: timers.now,
      setTimeout: timers.setTimeout,
      clearTimeout: timers.clearTimeout,
    });
    try {
      expect(saved?.records[childID]).toMatchObject({
        pendingPromptAdmissionID: 'msg_persisted',
      });
      expect(board.get(childID)).toMatchObject({
        state: 'stopped',
        statusUncertain: true,
      });
      if (consumer === 'native resume') {
        const record = board.get(childID);
        if (!record) throw new Error('Expected restored record');
        board.restore([
          { ...record, state: 'completed', terminalState: 'completed' },
        ]);
        const outcome = await manager['tool.execute.before'](
          {
            tool: 'task',
            sessionID: parentID,
            callID: 'native-resume',
          },
          {
            args: {
              task_id: childID,
              subagent_type: 'explorer',
              prompt: 'Continue',
            },
          },
        ).catch((error: unknown) => error);
        expect(outcome).toBeInstanceOf(Error);
      } else {
        const active = board.markRunningFromLiveSession(childID, 110);
        if (!active) throw new Error('Expected busy record');
        if (consumer === 'supervisor') {
          supervisor.onLaunch(active);
          await timers.advanceTo(150);
          expect(abort).not.toHaveBeenCalled();
          expect(board.get(childID)?.timedOut).toBe(false);
        } else if (consumer === 'revive') {
          await h.revive().catch((error: unknown) => error);
        } else {
          await createCancelTaskTool({
            ...h.options,
            terminalGate: gate,
            stableStoppedMs: 0,
          })
            .task_cancel.execute({ sessionID: childID }, h.context)
            .catch((error: unknown) => error);
        }
      }
      expect(h.interrupt).not.toHaveBeenCalled();
      expect(h.prompt).not.toHaveBeenCalled();
      expect(board.get(childID)?.pendingPromptAdmissionID).toBe(
        'msg_persisted',
      );
      expect(board.get(childID)?.statusUncertain).toBe(true);
    } finally {
      supervisor.dispose();
      gate.dispose();
      await dispose();
    }
  },
);

test.each([42, '', null])(
  'malformed persisted input %j remains excluded, not silently dropped',
  async (pending) => {
    const { board, dispose } = await pendingRoundtrip(pending);
    try {
      const record = board.get(childID);
      expect(record).toBeDefined();
      expect(record?.pendingPromptAdmissionID).toBeDefined();
      expect(
        board.acquireLease(childID, record?.generation ?? -1, 'relaunch'),
      ).toBeUndefined();
    } finally {
      await dispose();
    }
  },
);

test('ordinary V2 completed native resume stays available after exact input confirmation', async () => {
  const { h, board, manager, dispose } = await pendingRoundtrip();
  try {
    const record = board.get(childID);
    if (!record) throw new Error('Expected restored record');
    expect(
      board.confirmPromptAdmission(childID, record.generation, 'msg_persisted'),
    ).toBe(true);
    const confirmed = board.get(childID);
    if (!confirmed) throw new Error('Expected confirmed input');
    board.restore([
      {
        ...confirmed,
        state: 'completed',
        terminalState: 'completed',
        terminalUnreconciled: true,
      },
    ]);
    const output = {
      args: { task_id: childID, subagent_type: 'explorer', prompt: 'Continue' },
    };
    await manager['tool.execute.before'](
      { tool: 'task', sessionID: parentID, callID: 'normal-native-resume' },
      output,
    );
    expect(output.args.task_id).toBe(childID);
    expect(h.interrupt).not.toHaveBeenCalled();
  } finally {
    await dispose();
  }
});
