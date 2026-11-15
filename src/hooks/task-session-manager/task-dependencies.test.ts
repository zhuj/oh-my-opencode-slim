import { expect, test } from 'bun:test';
import { BackgroundJobBoard, BackgroundTaskConcurrency } from '../../utils';
import { createBackgroundJobTerminalGate } from '../../utils/background-job-terminal-gate';
import { subagentArgsToV1, v1ArgsToSubagent } from '../../v2/delegation';
import { createPendingCallTracker } from './pending-call-tracker';
import {
  handleToolExecuteAfter,
  handleToolExecuteBefore,
} from './tool-execute-hooks';

test.each(['v1', 'v2'])(
  'consumes plugin fields and preserves native output IDs on %s',
  async (host) => {
    // Given
    const scheduler = new BackgroundTaskConcurrency({
      defaultConcurrency: 1,
      providerConcurrency: {},
      modelConcurrency: {},
    });
    const backgroundJobBoard = new BackgroundJobBoard();
    backgroundJobBoard.addTerminalOutcomeListener((record) => {
      if (
        record.state === 'completed' ||
        record.state === 'error' ||
        record.state === 'stopped'
      ) {
        scheduler.releaseTask(
          record.taskID,
          record.state === 'stopped' ? 'cancelled' : record.state,
        );
      }
    });
    const terminalGate = createBackgroundJobTerminalGate({
      backgroundJobBoard,
      readRuntime: async (_run, readStartedAt) => ({
        kind: 'quiescent',
        origin: 'test',
        readStartedAt,
      }),
      readTerminalEvidence: async () => ({
        data: [
          {
            info: {
              id: 'native-output',
              role: 'assistant',
              time: { completed: Date.now() },
              finish: 'stop',
            },
            parts: [{ type: 'text', text: 'done' }],
          },
        ],
      }),
      graceMs: 0,
    });
    const pendingCallTracker = createPendingCallTracker();
    const taskContextTracker = {
      pendingManagedTaskIds: new Set<string>(),
      addContext: () => {},
      contextFilesForPrompt: () => [],
      prune: () => {},
    };
    const input = { tool: 'task', sessionID: 'parent', callID: 'call' };
    const args =
      host === 'v2'
        ? subagentArgsToV1({
            agent: 'fixer',
            id: 'logical',
            depends_on: [],
            background: false,
          })
        : {
            subagent_type: 'fixer',
            id: 'logical',
            depends_on: [],
            background: false,
          };
    // When
    await handleToolExecuteBefore(
      input,
      { args },
      {
        shouldManageSession: () => true,
        backgroundJobBoard,
        backgroundTaskConcurrency: scheduler,
        pendingCallTracker,
        taskContextTracker,
      },
    );
    const admissionID =
      pendingCallTracker.peekByParent('parent')?.concurrencyTicket?.id;
    if (!admissionID) throw new Error('Missing pending admission');
    const nativeOutput =
      host === 'v2'
        ? '<task id="ses_native" state="completed"><task_result>done</task_result></task>'
        : 'task_id: ses_native\nstate: completed\n\n<task_result>done</task_result>';
    const output = { output: nativeOutput };
    try {
      await handleToolExecuteAfter(input, output, {
        directory: '/workspace',
        backgroundJobBoard,
        terminalGate,
        pendingCallTracker,
        taskContextTracker,
        bindConcurrencyTicket: (id, pending) =>
          pending.concurrencyTicket?.bind(id),
      });
      // Then
      expect(args).not.toHaveProperty('id');
      expect(v1ArgsToSubagent(args)).not.toHaveProperty('depends_on');
      const nativeHeader =
        host === 'v2'
          ? '<task id="ses_native" state="completed">'
          : 'task_id: ses_native\nstate: completed';
      expect(output.output.startsWith(nativeHeader)).toBe(true);
      expect(output.output).toContain('<task_result>done</task_result>');
      expect(output.output).toContain('id: logical');
      expect(output.output).toContain(`admission_id: ${admissionID}`);
      expect(backgroundJobBoard.get('ses_native')).toMatchObject({
        state: 'completed',
        resultSummary: 'done',
      });
      expect(scheduler.list('parent')[0]).toMatchObject({
        logicalID: 'logical',
        assignedSessionID: 'ses_native',
        state: 'completed',
      });
    } finally {
      terminalGate.dispose();
      scheduler.dispose();
    }
  },
);

test('rejects unknown dependencies before tracking or launching native tasks', async () => {
  // Given
  const scheduler = new BackgroundTaskConcurrency({
    defaultConcurrency: 1,
    providerConcurrency: {},
    modelConcurrency: {},
  });
  const pendingCallTracker = createPendingCallTracker();
  // When / Then
  await expect(
    handleToolExecuteBefore(
      { tool: 'task', sessionID: 'parent', callID: 'call' },
      { args: { subagent_type: 'fixer', depends_on: ['missing'] } },
      {
        shouldManageSession: () => true,
        backgroundJobBoard: new BackgroundJobBoard(),
        backgroundTaskConcurrency: scheduler,
        pendingCallTracker,
        taskContextTracker: { pendingManagedTaskIds: new Set<string>() },
      },
    ),
  ).rejects.toThrow(/missing/);
  expect(scheduler.list()).toEqual([]);
  expect(pendingCallTracker.take('call')).toBeUndefined();
});

test('allocates an effective ID for nested tasks without waiting for parent capacity', async () => {
  // Given
  const scheduler = new BackgroundTaskConcurrency({
    defaultConcurrency: 1,
    providerConcurrency: {},
    modelConcurrency: {},
  });
  const parent = scheduler.acquire({ parentSessionID: 'root' });
  parent.bind('nested');
  const backgroundJobBoard = new BackgroundJobBoard();
  backgroundJobBoard.registerLaunch({
    taskID: 'nested',
    parentSessionID: 'root',
    agent: 'orchestrator',
    description: 'nested',
    background: true,
  });
  const args: Record<string, unknown> = {
    subagent_type: 'fixer',
    background: false,
  };
  // When
  await handleToolExecuteBefore(
    { tool: 'task', sessionID: 'nested', callID: 'child-call' },
    { args },
    {
      shouldManageSession: () => true,
      backgroundJobBoard,
      backgroundTaskConcurrency: scheduler,
      pendingCallTracker: createPendingCallTracker(),
      taskContextTracker: { pendingManagedTaskIds: new Set<string>() },
    },
  );
  // Then
  expect(args.background).toBe(false);
  expect(scheduler.list('nested')[0]).toMatchObject({
    logicalID: `admission-${Number(parent.id.slice('admission-'.length)) + 1}`,
    state: 'starting',
  });
  scheduler.dispose();
});

test.each([null, 'first', [1], [''], ['bad id']])(
  'rejects malformed depends_on %j at the native boundary',
  async (depends_on) => {
    // Given
    const scheduler = new BackgroundTaskConcurrency({
      defaultConcurrency: 1,
      providerConcurrency: {},
      modelConcurrency: {},
    });
    // When / Then
    await expect(
      handleToolExecuteBefore(
        { tool: 'task', sessionID: 'parent' },
        { args: { subagent_type: 'fixer', depends_on } },
        {
          shouldManageSession: () => true,
          backgroundJobBoard: new BackgroundJobBoard(),
          backgroundTaskConcurrency: scheduler,
          pendingCallTracker: createPendingCallTracker(),
          taskContextTracker: { pendingManagedTaskIds: new Set<string>() },
        },
      ),
    ).rejects.toThrow();
    expect(scheduler.list()).toEqual([]);
  },
);
