/// <reference types="bun-types" />

import { describe, expect, test } from 'bun:test';
import { BackgroundJobBoard, BackgroundTaskConcurrency } from '../../utils';
import { createBackgroundJobTerminalGate } from '../../utils/background-job-terminal-gate';
import { createPendingCallTracker } from './pending-call-tracker';
import {
  handleToolExecuteAfter,
  handleToolExecuteBefore,
} from './tool-execute-hooks';

const concurrencyConfig = {
  defaultConcurrency: 1,
  providerConcurrency: {},
  modelConcurrency: {},
};

describe('task execution admission records', () => {
  test.each(['ses_<<new>>', 'ses_new', 'ses:new', 'ses', 'ses?', 'ses??'])(
    'treats the v2 new-session placeholder %j as omitted',
    async (placeholder) => {
      const args: Record<string, unknown> = {
        subagent_type: 'explorer',
        task_id: placeholder,
        background: true,
      };

      await handleToolExecuteBefore(
        {
          tool: 'task',
          sessionID: 'parent-placeholder',
          callID: 'placeholder',
        },
        { args },
        {
          hostFlavor: 'v2',
          shouldManageSession: () => true,
          backgroundJobBoard: new BackgroundJobBoard(),
          pendingCallTracker: createPendingCallTracker(),
          taskContextTracker: { pendingManagedTaskIds: new Set<string>() },
        },
      );

      expect(args.task_id).toBeUndefined();
    },
  );

  test.each(['v1', 'v2'])(
    'an explicit blank task_id is refused on %s',
    async (hostFlavor) => {
      const args: Record<string, unknown> = {
        subagent_type: 'explorer',
        task_id: '   ',
        background: true,
      };

      await expect(
        handleToolExecuteBefore(
          {
            tool: 'task',
            sessionID: 'parent-whitespace',
            callID: 'whitespace',
          },
          { args },
          {
            hostFlavor,
            shouldManageSession: () => true,
            backgroundJobBoard: new BackgroundJobBoard(),
            pendingCallTracker: createPendingCallTracker(),
            taskContextTracker: { pendingManagedTaskIds: new Set<string>() },
          },
        ),
      ).rejects.toThrow(/empty/);
      expect(args.task_id).toBe('   ');
    },
  );

  // Regression: the v2 placeholder strip lived behind a `tool === 'task'`
  // gate, so on a real v2 host (tool `subagent`, resume param `sessionID`) it
  // never ran and the placeholder reached host validation as `Expected
  // string` instead of being treated as omitted.
  test.each([
    'ses_<<new>>',
    'ses_new',
    'ses:new',
    'ses',
    'ses?',
    null,
    undefined,
  ])(
    'strips the v2 subagent placeholder resume param %j',
    async (placeholder) => {
      const args: Record<string, unknown> = {
        agent: 'explorer',
        description: 'probe',
        prompt: 'probe',
        background: true,
        sessionID: placeholder,
      };

      await handleToolExecuteBefore(
        {
          tool: 'subagent',
          sessionID: 'parent-subagent-placeholder',
          callID: 'subagent-placeholder',
        },
        { args },
        {
          hostFlavor: 'v2',
          shouldManageSession: () => true,
          backgroundJobBoard: new BackgroundJobBoard(),
          pendingCallTracker: createPendingCallTracker(),
          taskContextTracker: { pendingManagedTaskIds: new Set<string>() },
        },
      );

      expect('sessionID' in args).toBe(false);
    },
  );

  test.each(['', ' ', '\t\n'])(
    'refuses explicit blank native v2 sessionID %j',
    async (sessionID) => {
      const args = { agent: 'explorer', prompt: 'work', sessionID };
      await expect(
        handleToolExecuteBefore(
          { tool: 'subagent', sessionID: 'parent', callID: 'blank' },
          { args },
          {
            hostFlavor: 'v2',
            shouldManageSession: () => true,
            backgroundJobBoard: new BackgroundJobBoard(),
            pendingCallTracker: createPendingCallTracker(),
            taskContextTracker: { pendingManagedTaskIds: new Set<string>() },
          },
        ),
      ).rejects.toThrow(/empty sessionID/);
      expect(args.sessionID).toBe(sessionID);
    },
  );

  test('leaves a real sessionID on the v2 subagent tool untouched', async () => {
    const args: Record<string, unknown> = {
      agent: 'explorer',
      description: 'probe',
      prompt: 'probe',
      background: true,
      sessionID: 'ses_aaaaaaaaaaaaaaaaaaaaaaaaaa',
    };

    await handleToolExecuteBefore(
      {
        tool: 'subagent',
        sessionID: 'parent-subagent-real',
        callID: 'subagent-real',
      },
      { args },
      {
        hostFlavor: 'v2',
        shouldManageSession: () => true,
        backgroundJobBoard: new BackgroundJobBoard(),
        pendingCallTracker: createPendingCallTracker(),
        taskContextTracker: { pendingManagedTaskIds: new Set<string>() },
      },
    );

    expect(args.sessionID).toBe('ses_aaaaaaaaaaaaaaaaaaaaaaaaaa');
  });

  test('does not strip a placeholder sessionID on v1, which has no fallback', async () => {
    const args: Record<string, unknown> = {
      subagent_type: 'explorer',
      task_id: '   ',
      background: true,
      sessionID: '   ',
    };

    await expect(
      handleToolExecuteBefore(
        { tool: 'subagent', sessionID: 'parent-v1', callID: 'v1' },
        { args },
        {
          hostFlavor: 'v1',
          shouldManageSession: () => true,
          backgroundJobBoard: new BackgroundJobBoard(),
          pendingCallTracker: createPendingCallTracker(),
          taskContextTracker: { pendingManagedTaskIds: new Set<string>() },
        },
      ),
    ).resolves.toBeUndefined();
    expect(args.sessionID).toBe('   ');
  });

  test.each([
    { model: 'gateway$vendor/model#high' },
    { provider: 'gateway', model: 'vendor$model' },
    { provider: 'gateway$vendor', model: 'model' },
  ])('rejects dollar references before admission: %p', async (override) => {
    const backgroundTaskConcurrency = new BackgroundTaskConcurrency(
      concurrencyConfig,
    );

    await expect(
      handleToolExecuteBefore(
        { tool: 'task', sessionID: 'parent-rejected', callID: 'rejected' },
        { args: { subagent_type: 'fixer', background: true, ...override } },
        {
          shouldManageSession: () => true,
          backgroundJobBoard: new BackgroundJobBoard(),
          backgroundTaskConcurrency,
          pendingCallTracker: createPendingCallTracker(),
          taskContextTracker: { pendingManagedTaskIds: new Set<string>() },
        },
      ),
    ).rejects.toThrow('Invalid model reference');

    expect(backgroundTaskConcurrency.list('parent-rejected')).toEqual([]);
  });

  test('retains parent, model, child session, and terminal outcome', async () => {
    // Given: a native background task entering through the task hook.
    const backgroundJobBoard = new BackgroundJobBoard();
    const backgroundTaskConcurrency = new BackgroundTaskConcurrency(
      concurrencyConfig,
    );
    backgroundJobBoard.addTerminalOutcomeListener((record) => {
      if (
        record.state === 'completed' ||
        record.state === 'error' ||
        record.state === 'stopped'
      ) {
        backgroundTaskConcurrency.releaseTask(
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
        data: [{ info: { role: 'assistant', error: 'failed' }, parts: [] }],
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

    await handleToolExecuteBefore(
      { tool: 'task', sessionID: 'parent-1', callID: 'call-1' },
      {
        args: {
          background: true,
          subagent_type: 'fixer',
          description: 'run failing task',
        },
      },
      {
        shouldManageSession: () => true,
        backgroundJobBoard,
        backgroundTaskConcurrency,
        pendingCallTracker,
        taskContextTracker,
        getModelForAgent: () => 'openai/gpt-5.6-luna',
      },
    );

    // When: the native child reports an error terminal outcome.
    try {
      await handleToolExecuteAfter(
        { tool: 'task', sessionID: 'parent-1', callID: 'call-1' },
        {
          output: [
            'task_id: child-1',
            'state: error',
            '',
            '<task_result>',
            'failed',
            '</task_result>',
          ].join('\n'),
        },
        {
          directory: '/workspace',
          backgroundJobBoard,
          pendingCallTracker,
          taskContextTracker,
          terminalGate,
          bindConcurrencyTicket: (taskID, pending) =>
            pending.concurrencyTicket?.bind(taskID),
          releaseConcurrencyTask: (taskID, state) =>
            backgroundTaskConcurrency.releaseTask(
              taskID,
              state === 'stopped' ? 'cancelled' : state,
            ),
        },
      );
    } finally {
      terminalGate.dispose();
    }

    // Then: one stable admission record preserves the complete association.
    expect(backgroundTaskConcurrency.list('parent-1')).toEqual([
      expect.objectContaining({
        state: 'error',
        model: 'openai/gpt-5.6-luna',
        provider: 'openai',
        parentSessionID: 'parent-1',
        assignedSessionID: 'child-1',
      }),
    ]);
    expect(backgroundTaskConcurrency.snapshot()).toEqual({
      active: 0,
      queued: 0,
    });
  });

  test('preserves omitted background delegation without an armed v2 flip', async () => {
    const args: Record<string, unknown> = {
      subagent_type: 'explorer',
      description: 'inspect the task flow',
    };

    await handleToolExecuteBefore(
      { tool: 'task', sessionID: 'parent-2', callID: 'call-2' },
      { args },
      {
        shouldManageSession: () => true,
        backgroundJobBoard: new BackgroundJobBoard(),
        pendingCallTracker: createPendingCallTracker(),
        taskContextTracker: { pendingManagedTaskIds: new Set<string>() },
      },
    );

    expect(args.background).toBeUndefined();
  });

  test('preserves omitted background in managed subsessions without an armed v2 flip', async () => {
    const backgroundJobBoard = new BackgroundJobBoard();
    backgroundJobBoard.registerLaunch({
      taskID: 'subsession-1',
      parentSessionID: 'parent-1',
      agent: 'orchestrator',
      description: 'nested orchestrator',
      background: true,
    });
    const args: Record<string, unknown> = {
      subagent_type: 'explorer',
      description: 'inspect the nested task flow',
    };

    await handleToolExecuteBefore(
      { tool: 'task', sessionID: 'subsession-1', callID: 'call-4' },
      { args },
      {
        shouldManageSession: () => true,
        backgroundJobBoard,
        pendingCallTracker: createPendingCallTracker(),
        taskContextTracker: { pendingManagedTaskIds: new Set<string>() },
      },
    );

    expect(args.background).toBeUndefined();
  });

  test('preserves explicit background execution in managed subsessions', async () => {
    const backgroundJobBoard = new BackgroundJobBoard();
    backgroundJobBoard.registerLaunch({
      taskID: 'subsession-2',
      parentSessionID: 'parent-1',
      agent: 'orchestrator',
      description: 'nested orchestrator',
      background: true,
    });
    const args: Record<string, unknown> = {
      background: true,
      subagent_type: 'explorer',
      description: 'inspect the nested task flow',
    };

    await handleToolExecuteBefore(
      { tool: 'task', sessionID: 'subsession-2', callID: 'call-5' },
      { args },
      {
        shouldManageSession: () => true,
        backgroundJobBoard,
        pendingCallTracker: createPendingCallTracker(),
        taskContextTracker: { pendingManagedTaskIds: new Set<string>() },
      },
    );

    expect(args.background).toBe(true);
  });

  test('preserves explicit foreground delegation', async () => {
    const args: Record<string, unknown> = {
      background: false,
      subagent_type: 'explorer',
      description: 'inspect the task flow',
    };

    await handleToolExecuteBefore(
      { tool: 'task', sessionID: 'parent-3', callID: 'call-3' },
      { args },
      {
        shouldManageSession: () => true,
        backgroundJobBoard: new BackgroundJobBoard(),
        pendingCallTracker: createPendingCallTracker(),
        taskContextTracker: { pendingManagedTaskIds: new Set<string>() },
      },
    );

    expect(args.background).toBe(false);
  });

  test('uses separate provider, model, and variant fields for admission', async () => {
    const backgroundJobBoard = new BackgroundJobBoard();
    const backgroundTaskConcurrency = new BackgroundTaskConcurrency(
      concurrencyConfig,
    );
    const args: Record<string, unknown> = {
      background: true,
      subagent_type: 'fixer',
      description: 'use a custom task model',
      provider: 'custom-gateway',
      model: 'inkling-small:free',
      variant: 'high',
    };

    await handleToolExecuteBefore(
      { tool: 'task', sessionID: 'parent-4', callID: 'call-6' },
      { args },
      {
        shouldManageSession: () => true,
        backgroundJobBoard,
        backgroundTaskConcurrency,
        pendingCallTracker: createPendingCallTracker(),
        taskContextTracker: { pendingManagedTaskIds: new Set<string>() },
      },
    );

    expect(args).toMatchObject({
      provider: 'custom-gateway',
      model: 'inkling-small:free',
      variant: 'high',
    });
    expect(backgroundTaskConcurrency.list('parent-4')).toEqual([
      expect.objectContaining({
        model: 'custom-gateway/inkling-small:free',
        provider: 'custom-gateway',
      }),
    ]);
  });
});
