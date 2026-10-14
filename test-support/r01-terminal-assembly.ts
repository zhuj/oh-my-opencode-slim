/// <reference types="bun-types" />
import { mock, spyOn } from 'bun:test';
import * as hookFactories from '../src/hooks';
import { OhMyOpenCodeLite as plugin } from '../src/index';
import { createTmpDir, removeTmpDir } from '../src/test-utils';
import { BackgroundJobCoordinator } from '../src/utils/background-job-coordinator';
import type {
  BackgroundJobTerminalGate,
  RuntimeObservation,
} from '../src/utils/background-job-terminal-gate';
import * as gateFactories from '../src/utils/background-job-terminal-gate';
import type { BackgroundTaskConcurrency } from '../src/utils/background-task-concurrency';

export const cleanups: Array<() => Promise<void>> = [];

export type Assembly = Awaited<ReturnType<typeof assembly>>;

export async function assembly(
  setup: {
    maxEvidenceRetries?: number;
    readRuntime?: (
      run: { taskID: string; generation: number },
      startedAt: number,
    ) => Promise<RuntimeObservation>;
  } = {},
) {
  const env = { ...process.env };
  const directory = createTmpDir('r01-terminal-assembly-');
  let hookSpy: ReturnType<typeof spyOn> | undefined;
  let gateSpy: ReturnType<typeof spyOn> | undefined;
  let hooks: Awaited<ReturnType<typeof plugin>> | undefined;
  cleanups.push(async () => {
    await hooks?.dispose?.();
    hookSpy?.mockRestore?.();
    gateSpy?.mockRestore?.();
    process.env = env;
    removeTmpDir(directory);
  });
  process.env.OPENCODE_CONFIG_DIR = directory;
  process.env.XDG_CONFIG_HOME = directory;
  process.env.XDG_DATA_HOME = directory;
  process.env.XDG_CACHE_HOME = directory;
  delete process.env.OH_MY_OPENCODE_SLIM_DISABLE;
  await Bun.write(
    `${directory}/oh-my-opencode-slim.json`,
    JSON.stringify({
      backgroundJobs: {
        concurrency: { defaultConcurrency: 1 },
        readContextMinLines: 1,
      },
    }),
  );
  let board: BackgroundJobCoordinator | undefined;
  let gate: BackgroundJobTerminalGate | undefined;
  let scheduler: BackgroundTaskConcurrency | undefined;
  const originalHook = hookFactories.createTaskSessionManagerHook;
  hookSpy = spyOn(
    hookFactories,
    'createTaskSessionManagerHook',
  ).mockImplementation((...args: unknown[]) => {
    const taskHook = originalHook(...args);
    scheduler = (args[1] as Record<string, unknown> | undefined)
      ?.backgroundTaskConcurrency as BackgroundTaskConcurrency | undefined;
    return taskHook;
  });
  const originalGate = gateFactories.createBackgroundJobTerminalGate;
  gateSpy = spyOn(
    gateFactories,
    'createBackgroundJobTerminalGate',
  ).mockImplementation((options) => {
    const createdGate = originalGate({
      ...options,
      ...(setup.readRuntime ? { readRuntime: setup.readRuntime } : {}),
      ...(setup.maxEvidenceRetries === undefined
        ? {}
        : { maxEvidenceRetries: setup.maxEvidenceRetries }),
    });
    const candidate = options.backgroundJobBoard;
    if (!(candidate instanceof BackgroundJobCoordinator))
      throw new Error('terminal gate did not receive the actual coordinator');
    gate = createdGate;
    board = candidate;
    return createdGate;
  });
  const session = new Proxy(
    {
      status: mock(async () => ({
        data: { child: { type: 'idle' as const } },
      })),
      messages: mock(async () => ({
        data: [
          {
            info: {
              id: 'a',
              role: 'assistant',
              time: { completed: Date.now() },
              finish: 'stop',
            },
            parts: [{ type: 'text', text: 'ok' }],
          },
        ],
      })),
      get: mock(async () => ({
        data: {
          parentID: 'parent',
          outcome: 'succeeded',
          time: { idle: Date.now() },
        },
      })),
    },
    {
      get: (target, key) => Reflect.get(target, key) ?? (() => ({ data: [] })),
    },
  );
  const builtClient = new Proxy(
    { session, app: { log: () => {} } },
    {
      get: (target, key) =>
        Reflect.get(target, key) ??
        new Proxy({}, { get: () => () => ({ data: [] }) }),
    },
  );
  hooks = (await plugin({
    client: builtClient,
    directory,
    worktree: directory,
    serverUrl: new URL('http://127.0.0.1:4096'),
  } as never)) as Awaited<ReturnType<typeof plugin>>;
  if (scheduler === undefined)
    throw new Error(
      'scheduler missing: assembly did not capture backgroundTaskConcurrency',
    );
  if (board === undefined)
    throw new Error('board missing: terminal gate factory was not captured');
  if (gate === undefined)
    throw new Error('gate missing: terminal gate factory was not captured');
  const event = (type: string, props?: Record<string, unknown>) =>
    (hooks as { event?: (arg: unknown) => void }).event?.({
      event: { type, properties: props },
    } as never);
  const call = { tool: 'task', sessionID: 'parent', callID: 'native' };
  const requestTask = (callID: string, desc: string) =>
    (hooks as Record<string, unknown>)['tool.execute.before']?.(
      { ...call, callID },
      {
        args: {
          subagent_type: 'explorer',
          background: true,
          description: desc,
        },
      } as never,
    );
  const begin = async () => {
    await requestTask('native', 'running A');
    await event('session.created', {
      info: { id: 'child', parentID: 'parent', agent: 'explorer' },
    });
  };
  return {
    board,
    gate,
    scheduler,
    begin,
  };
}
