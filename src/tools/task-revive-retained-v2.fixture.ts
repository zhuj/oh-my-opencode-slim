import { afterEach, mock, spyOn } from 'bun:test';
import type { PluginInput, ToolContext } from '@opencode-ai/plugin';
import { createRevivedRunTracker } from '../hooks/task-session-manager/revived-run-tracker';
import { createSessionRecovery } from '../hooks/task-session-manager/session-recovery';
import { createTmpDir, removeTmpDir } from '../test-utils';
import { BackgroundJobBoard } from '../utils/background-job-board';
import { createBackgroundJobTerminalGate } from '../utils/background-job-terminal-gate';
import { isRecord } from '../utils/guards';
import * as opencodeClient from '../utils/opencode-client';
import { createTimerHarness } from '../utils/test-timers';
import { buildPluginInput } from '../v2/client-shim';
import type { V2Context } from '../v2/types';
import {
  createTaskReviveTool,
  type TaskReviveToolOptions,
} from './task-revive';

export const childID = 'ses_retained_repair';
export const parentID = 'ses_repair_parent';
const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
  mock.restore();
});

export function retainedV2(
  overrides: Partial<TaskReviveToolOptions> = {},
  onSettled?: () => void,
) {
  const directory = createTmpDir('omos-retained-repair-');
  cleanups.push(() => removeTmpDir(directory));
  const timers = createTimerHarness();
  const entered = Promise.withResolvers<void>();
  const idle = Promise.withResolvers<void>();
  const hostIdentity = { parentID, agent: 'explorer' };
  const transcript: Array<Record<string, unknown>> = [
    { id: 'old-user', type: 'user', time: { created: 1 } },
  ];
  const wait = mock(() => {
    entered.resolve();
    return idle.promise;
  });
  const interrupt = mock(async () => ({}));
  const switchModel = mock(async () => ({}));
  const synthetic = mock(async () => ({}));
  const prompt = mock(
    async (input: Record<string, unknown>): Promise<unknown> => ({
      id: input.id,
      state: 'pending',
    }),
  );
  const get = mock(
    async (): Promise<unknown> => ({ id: childID, ...hostIdentity }),
  );
  const unused = async () => {
    throw new Error('Unexpected host integration');
  };
  // Unused host domains fail loudly rather than reaching a real integration.
  const input = buildPluginInput({
    app: { name: 'mock', version: 'mock' },
    options: {},
    agent: { transform: unused, reload: unused, list: unused },
    tool: { transform: unused, hook: unused },
    command: { transform: unused, list: unused },
    event: {
      subscribe() {
        throw new Error('Unexpected host event stream');
      },
    },
    session: {
      hook: unused,
      get,
      context: async ({ sessionID }: { sessionID: string }) =>
        sessionID === parentID ? [] : transcript,
      wait,
      prompt,
      interrupt,
      switchModel,
      synthetic,
    },
    location: { directory },
  } satisfies V2Context) as PluginInput;
  const capabilities: unknown = Reflect.get(input, 'experimental_v2');
  if (!isRecord(capabilities)) throw new Error('Expected fake V2 capabilities');
  spyOn(opencodeClient, 'getClient').mockImplementation(
    (input) => input.client,
  );
  const original = new BackgroundJobBoard();
  const running = original.registerLaunch({
    taskID: childID,
    parentSessionID: parentID,
    agent: 'explorer',
    background: true,
    now: 100,
  });
  const board = new BackgroundJobBoard();
  board.restore([running]);
  let tracker: ReturnType<typeof createRevivedRunTracker>;
  const gate = createBackgroundJobTerminalGate({
    input,
    backgroundJobBoard: board,
    hostOutcomeClock: 'shared-unix-ms',
    promptMessageIDFor: (id, generation) =>
      tracker?.promptMessageIDFor(id, generation),
    observationRevisionFor: (id, generation) =>
      tracker?.revisionFor(id, generation),
    attemptStartedAtFor: (id, generation) =>
      tracker?.attemptStartedAtFor(id, generation),
    isObservationPending: (id, generation) =>
      tracker?.isObservationPending(id, generation) ?? false,
    graceMs: 0,
  });
  tracker = createRevivedRunTracker({
    input,
    backgroundJobBoard: board,
    terminalGate: gate,
    onSettled,
  });
  const probe = spyOn(tracker, 'probe').mockResolvedValue(false);
  const register = spyOn(tracker, 'register');
  cleanups.push(() => {
    tracker.dispose();
    gate.dispose();
  });
  const options: TaskReviveToolOptions = {
    input,
    backgroundJobBoard: board,
    shouldManageSession: () => true,
    revivedRunTracker: tracker,
    recoverRetainedSession: createSessionRecovery({
      input,
      backgroundJobBoard: board,
      hostFlavor: 'v2',
    }),
    waitForIdleTimeoutMs: 50,
    idleWaitRuntime: {
      now: timers.now,
      setTimeout: timers.setTimeout,
      clearTimeout: (timer) => {
        if (typeof timer !== 'number') throw new Error('Expected manual timer');
        timers.clearTimeout(timer);
      },
    },
    ...overrides,
  };
  const context = { sessionID: parentID, agent: 'orchestrator' } as ToolContext;
  const revive = (args: { model?: string } = {}) =>
    createTaskReviveTool(options).task_revive.execute(
      { sessionID: childID, prompt: 'Continue retained work', ...args },
      context,
    );
  const record = () => {
    const current = board.get(childID);
    if (!current) throw new Error('Expected retained record');
    return current;
  };
  return {
    input,
    options,
    board,
    tracker,
    register,
    timers,
    entered: entered.promise,
    idle,
    wait,
    prompt,
    interrupt,
    switchModel,
    synthetic,
    probe,
    capabilities,
    context,
    hostIdentity,
    get,
    transcript,
    revive,
    record,
  };
}
