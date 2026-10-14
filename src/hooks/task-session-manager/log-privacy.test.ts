/// <reference types="bun-types" />

import { expect, spyOn, test } from 'bun:test';
import { BackgroundJobBoard } from '../../utils/background-job-board';
import * as logger from '../../utils/logger';
import { createPendingCallTracker } from './pending-call-tracker';
import {
  handleToolExecuteAfter,
  handleToolExecuteBefore,
} from './tool-execute-hooks';

test('task logs retain metadata without task content', async () => {
  // Given arbitrary content in a pending description and native output.
  const sentinel = 'SENTINEL_PRIVATE_TASK_CONTENT';
  const pendingCallTracker = createPendingCallTracker();
  const backgroundJobBoard = new BackgroundJobBoard();
  const taskContextTracker = {
    pendingManagedTaskIds: new Set<string>(),
    addContext: () => {},
    contextFilesForPrompt: () => [],
    prune: () => {},
  };
  const log = spyOn(logger, 'log').mockImplementation(() => {});
  try {
    await handleToolExecuteBefore(
      { tool: 'task', sessionID: 'parent', callID: 'call' },
      {
        args: {
          subagent_type: 'fixer',
          background: true,
          description: sentinel,
          prompt: sentinel,
        },
      },
      {
        shouldManageSession: () => true,
        backgroundJobBoard,
        pendingCallTracker,
        taskContextTracker,
      },
    );
    // When the native launch is registered.
    await handleToolExecuteAfter(
      { tool: 'task', sessionID: 'parent', callID: 'call' },
      { output: `task_id: child\nstate: running\n${sentinel}` },
      {
        directory: '/workspace',
        backgroundJobBoard,
        pendingCallTracker,
        taskContextTracker,
      },
    );
    // Then logger arguments never contain the arbitrary task text.
    expect(log.mock.calls.length).toBeGreaterThan(1);
    expect(JSON.stringify(log.mock.calls)).not.toContain(sentinel);
  } finally {
    log.mockRestore();
  }
});
