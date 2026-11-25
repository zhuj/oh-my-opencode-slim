/**
 * Cold-gate coverage for the v2 setup master switches:
 *
 * - `interview.enabled: false` → no bridge instance (no `/interview` command
 *   marker registered, no per-event bridge work, no context-hook dispatch).
 * - Default native delegation uses the admission queue. Explicit native mode
 *   can use preset routing alone, and off preserves the native executor.
 * - `liveConfigRefresh: false` → no config-file watcher, while the one-shot
 *   startup profile seed and explicit `refreshProfiles` still function.
 * - `sidebar: false` → no server-side sidebar state write on finalization.
 *
 * Every switch defaults to true; the baseline behavior assertions live in
 * setup.e2e.test.ts / hot-refresh.test.ts. The harness here deliberately
 * reuses the real `loadPluginConfig` path (a written config file) so the
 * gates are proven end-to-end against the loader, not a stub.
 */
import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import fs from 'node:fs';
import { mkdir } from 'node:fs/promises';
import * as path from 'node:path';
import { Schema } from 'effect';
import * as agentFactory from '../agents';
import { createTmpDir, removeTmpDir } from '../test-utils';
import * as configWatch from './config-watch';
import { sessionPresetRpc } from './preset-rpc';
import { createV2Setup } from './setup';
import type { V2Context, V2SessionContextEvent } from './types';

const nativeModelWording =
  'NEVER set this unless the user explicitly asks for a particular model or variant.';
const nativeSubagentInput = Schema.Struct({
  agent: Schema.String,
  description: Schema.String,
  prompt: Schema.String,
  model: Schema.optionalKey(Schema.String).annotate({
    description: nativeModelWording,
  }),
  sessionID: Schema.optionalKey(
    Schema.String.check(Schema.isStartingWith('ses')).pipe(
      Schema.brand('SessionID'),
      Schema.annotate({ identifier: 'Session.ID' }),
    ),
  ),
});
const nativeSubagentExecute = async () => ({});
const detachedNativeEvents = [
  'session.created',
  'session.deleted',
  'session.agent.selected',
  'session.moved',
  'skill.updated',
  'plugin.updated',
];
const admissionEventTypes = [
  'session.execution.started',
  'session.execution.succeeded',
  'session.execution.failed',
  'session.execution.interrupted',
  'session.inbox.enqueued',
  'session.inbox.delivered',
  'session.inbox.cancelled',
  'session.model.selected',
];

/** Mock v2 context capturing the registrations the gates must suppress. */
function makeCtx(
  projectDir: string,
  storage: V2Context['storage'] = {
    get: async () => undefined,
    set: async () => {},
    remove: async () => {},
    scan: async () => ({ entries: [] }),
  },
) {
  const commandAdds: Array<{ name: string }> = [];
  const removedAgents: string[] = [];
  const beforeHooks: Array<(event: never) => Promise<void>> = [];
  // The host replays registered transforms over the same draft. Keep one
  // native tool here so later transforms observe and wrap earlier edits.
  const subagentTool: Record<string, unknown> = {
    description: `Native delegation. ${nativeModelWording}`,
    input: nativeSubagentInput,
    execute: nativeSubagentExecute,
  };
  const hooks: string[] = [];
  const skillCallbacks = new Set<(draft: unknown) => void>();
  const contextHooks: Array<(event: never) => Promise<void>> = [];
  const promptHooks: Array<(event: never) => Promise<void>> = [];
  const toolAdds: string[] = [];
  const eventTypes: string[][] = [];
  const storageCalls = { get: 0, set: 0, remove: 0, scan: 0 };
  const rpcHandlers: Array<Record<string, unknown>> = [];
  const rpcDefinitions: unknown[] = [];
  const countedStorage = storage
    ? {
        get: async (key: string) => {
          storageCalls.get += 1;
          return storage.get(key);
        },
        set: async (key: string, value: unknown) => {
          storageCalls.set += 1;
          await storage.set(key, value);
        },
        remove: async (key: string) => {
          storageCalls.remove += 1;
          await storage.remove(key);
        },
        scan: async (options: {
          prefix: string;
          after?: string;
          limit?: number;
        }) => {
          storageCalls.scan += 1;
          return storage.scan(options);
        },
      }
    : undefined;
  const reg = (label: string) => ({
    dispose: () => hooks.push(`dispose:${label}`),
  });
  const ctx = {
    app: { name: 'opencode', version: 'v2-feature-gates' },
    options: {},
    storage: countedStorage,
    location: {
      directory: projectDir,
      project: {
        id: 'proj_gates',
        directory: projectDir,
        canonical: projectDir,
      },
    },
    agent: {
      transform: async (cb: (draft: unknown) => void) => {
        cb({
          list: () => [],
          get: () => undefined,
          default: () => {},
          update: (_id: string, fn: (agent: unknown) => void) => {
            commandAdds.length;
            fn({});
          },
          remove: (id: string) => {
            removedAgents.push(id);
          },
        });
        return reg('agent.transform');
      },
      reload: async () => ({}),
      list: async () => [],
    },
    tool: {
      transform: async (cb: (draft: unknown) => void) => {
        cb({
          update: (id: string, update: (tool: unknown) => void) => {
            update(id === 'subagent' ? subagentTool : {});
          },
          get: (id: string) => (id === 'subagent' ? subagentTool : undefined),
          add: (definition: { name: string }) => toolAdds.push(definition.name),
        });
        return reg('tool.transform');
      },
      hook: async (name: string, cb?: (event: never) => Promise<void>) => {
        hooks.push(`tool:${name}`);
        if (name === 'execute.before' && typeof cb === 'function') {
          beforeHooks.push(cb);
        }
        return reg(`tool.hook:${name}`);
      },
    },
    command: {
      transform: async (cb: (draft: unknown) => void) => {
        cb({
          add: (definition: Record<string, unknown>) => {
            commandAdds.push({ name: definition.name as string });
          },
        });
        return reg('command.transform');
      },
      list: async () => [],
    },
    skill: {
      transform: async (cb: (draft: unknown) => void) => {
        skillCallbacks.add(cb);
        return {
          dispose: () => {
            skillCallbacks.delete(cb);
          },
        };
      },
      list: async () => [],
      reload: async () => {},
    },
    session: {
      get: async ({ sessionID }: { sessionID: string }) => ({
        id: sessionID,
        directory: projectDir,
        agent: 'orchestrator',
      }),
      hook: async (name: string, cb: (event: never) => Promise<void>) => {
        hooks.push(`session:${name}`);
        if (name === 'context') contextHooks.push(cb);
        if (name === 'prompt') promptHooks.push(cb);
        return reg(`session.hook:${name}`);
      },
    },
    mcp: {
      transform: async (cb: (draft: unknown) => void) => {
        cb({
          list: () => [],
          get: () => undefined,
          set: () => {},
          update: () => {},
          remove: () => {},
        });
        return reg('mcp.transform');
      },
      reload: async () => {},
    },
    event: {
      // Synchronously-exhausted stream: the pump registers but no events
      // are ever delivered, so per-event bridge work is observable only
      // through the registrations above.
      subscribe: (options: { types: string[] }) => {
        eventTypes.push(options.types);
        return {
          [Symbol.asyncIterator]: () => ({
            next: () => Promise.resolve({ value: undefined, done: true }),
            return: () => Promise.resolve({ value: undefined, done: true }),
          }),
        };
      },
    },
    generate: {
      text: async (input: { prompt: string }) => ({
        text: `generated:${input.prompt}`,
      }),
    },
    rpc: {
      register: async (
        definition: unknown,
        handlers: Record<string, unknown>,
      ) => {
        rpcDefinitions.push(definition);
        rpcHandlers.push(handlers);
        return reg('rpc.register');
      },
    },
  } as unknown as V2Context;

  return {
    ctx,
    commandAdds,
    removedAgents,
    beforeHooks,
    subagentTool,
    hooks,
    contextHooks,
    promptHooks,
    toolAdds,
    eventTypes,
    storageCalls,
    rpcHandlers,
    rpcDefinitions,
  };
}

const INTERVIEW_MARKER =
  '<omos-interview-command>do it</omos-interview-command>';

function subagentSchema(tool: Record<string, unknown>) {
  expect(Schema.isSchema(tool.input)).toBe(true);
  return tool.input as typeof nativeSubagentInput;
}

function expectQueueSchema(tool: Record<string, unknown>, enabled: boolean) {
  const nativeFields = Object.keys(nativeSubagentInput.fields);
  if (!enabled) {
    expect(Object.keys(subagentSchema(tool).fields)).toEqual(nativeFields);
    return;
  }

  // The admission projection crosses the host's Standard Schema boundary,
  // whereas the pure native path keeps the original Effect schema.
  const standard = (
    tool.input as {
      '~standard': {
        jsonSchema: {
          input(): { properties: Record<string, unknown>; required: string[] };
        };
        validate(value: unknown): { value: unknown } | { issues: unknown[] };
      };
    }
  )['~standard'];
  const input = standard.jsonSchema.input();
  expect(Object.keys(input.properties)).toEqual([
    ...nativeFields,
    'id',
    'depends_on',
  ]);
  expect(input.required).toEqual(['agent', 'description', 'prompt']);
  expect(input.properties.sessionID).toMatchObject({ pattern: '^ses' });

  const args = {
    agent: 'explorer',
    description: 'Review',
    prompt: 'Review this',
    id: 'review',
    depends_on: ['prepare'],
  };
  expect(standard.validate(args)).toEqual({ value: args });
  expect(standard.validate({ ...args, sessionID: 'bad-id' })).toHaveProperty(
    'issues',
  );
  expect(standard.validate({ ...args, model: 42 })).toHaveProperty('issues');
  expect(standard.validate({ ...args, depends_on: [null] })).toHaveProperty(
    'issues',
  );
}

/** A v2 delegation the `execute.before` bridge must admit (or reject). */
function delegationEvent() {
  return {
    tool: 'subagent',
    sessionID: 'ses_gate_parent',
    agent: 'orchestrator',
    messageID: 'msg_gate',
    id: 'call_gate_delegate',
    input: { agent: 'explorer', description: 'probe', prompt: 'Work' },
  };
}

describe('v2 setup feature gates', () => {
  let originalEnv: typeof process.env;
  let fixtureRoot: string;
  let projectDir: string;

  const writeProjectConfig = async (content: Record<string, unknown>) => {
    await mkdir(path.join(projectDir, '.opencode'), { recursive: true });
    await Bun.write(
      path.join(projectDir, '.opencode', 'oh-my-opencode-slim.json'),
      JSON.stringify(content),
    );
  };

  beforeEach(async () => {
    originalEnv = { ...process.env };
    fixtureRoot = createTmpDir('omo-v2-gates-');
    projectDir = path.join(fixtureRoot, 'project');
    await writeProjectConfig({ companion: { enabled: false } });
    process.env.OPENCODE_CONFIG_DIR = path.join(fixtureRoot, 'config');
    process.env.XDG_CONFIG_HOME = path.join(fixtureRoot, 'xdg-config');
    process.env.XDG_DATA_HOME = path.join(fixtureRoot, 'xdg-data');
    process.env.XDG_CACHE_HOME = path.join(fixtureRoot, 'xdg-cache');
    process.env.OPENCODE_LOG_DIR = path.join(fixtureRoot, 'logs');
    delete process.env.OH_MY_OPENCODE_SLIM_DISABLE;
  });

  afterEach(async () => {
    for (const key of Object.keys(process.env)) {
      if (!(key in originalEnv)) delete process.env[key];
    }
    Object.assign(process.env, originalEnv);
    removeTmpDir(fixtureRoot);
  });

  test('accepts major-zero preview hosts but rejects unsupported releases', async () => {
    const { ctx } = makeCtx(projectDir);
    ctx.app.version = '0.0.0-beta-19507';
    const cleanup = await createV2Setup()(ctx);
    await cleanup();
    const { ctx: minimumHost } = makeCtx(projectDir);
    minimumHost.app.version = '2.4.0';
    const minimumCleanup = await createV2Setup()(minimumHost);
    await minimumCleanup();
    const { ctx: oldHost } = makeCtx(projectDir);
    oldHost.app.version = '2.3.9';
    await expect(createV2Setup()(oldHost)).rejects.toThrow(/unsupported/i);
  });

  test('interview disabled: no command marker, no context dispatch', async () => {
    await writeProjectConfig({
      companion: { enabled: false },
      interview: { enabled: false },
    });
    const { ctx, commandAdds, contextHooks } = makeCtx(projectDir);
    const cleanup = await createV2Setup()(ctx);
    try {
      expect(commandAdds.map((c) => c.name)).not.toContain('interview');
      expect(commandAdds.map((c) => c.name)).toContain('deepwork');

      // The context hook stays registered (system/messages transforms and
      // generic command markers are unrelated to the interview), but the
      // interview seam must be a no-op: a trailing marker passes through
      // untouched instead of being rewritten into interview state.
      expect(contextHooks).toHaveLength(1);
      const trailing = {
        id: 'ses_gate',
        role: 'user',
        content: [{ type: 'text', text: INTERVIEW_MARKER }],
      };
      await contextHooks[0]?.({
        sessionID: 'ses_gate',
        agent: 'oracle',
        model: {},
        system: [],
        tools: {},
        messages: [trailing],
      } as unknown as V2SessionContextEvent);
      expect(trailing.content).toEqual([
        { type: 'text', text: INTERVIEW_MARKER },
      ]);
    } finally {
      await cleanup();
    }
  }, 20_000);

  test('disabled preset removes the command and RPC without breaking delegation', async () => {
    await writeProjectConfig({
      companion: { enabled: false },
      backgroundJobs: { mode: 'native' },
      disabled_commands: ['preset'],
    });
    const { ctx, commandAdds, rpcDefinitions, beforeHooks } =
      makeCtx(projectDir);
    const cleanup = await createV2Setup()(ctx);
    try {
      expect(commandAdds.map((command) => command.name)).not.toContain(
        'preset',
      );
      expect(rpcDefinitions).not.toContain(sessionPresetRpc);
      const before = beforeHooks[0];
      if (!before) throw new Error('tool:execute.before not captured');
      await expect(before(delegationEvent() as never)).resolves.toBeUndefined();
    } finally {
      await cleanup();
    }
  }, 20_000);

  test('enabled preset keeps the command and RPC registration', async () => {
    await writeProjectConfig({
      companion: { enabled: false },
      backgroundJobs: { mode: 'native' },
    });
    const { ctx, commandAdds, rpcDefinitions } = makeCtx(projectDir);
    const cleanup = await createV2Setup()(ctx);
    try {
      expect(commandAdds.map((command) => command.name)).toContain('preset');
      expect(rpcDefinitions).toContain(sessionPresetRpc);
    } finally {
      await cleanup();
    }
  }, 20_000);

  test('native routing and rule processing retain before and after hooks with the loop guard off', async () => {
    await writeProjectConfig({
      companion: { enabled: false },
      backgroundJobs: { mode: 'native' },
      disabled_hooks: ['tool-loop-guard'],
    });
    const { ctx, hooks } = makeCtx(projectDir);
    const cleanup = await createV2Setup()(ctx);
    try {
      expect(hooks).toContain('tool:execute.before');
      expect(hooks).toContain('tool:execute.after');
    } finally {
      await cleanup();
    }
  }, 20_000);

  test('replaceBuiltinSubagents: false keeps the host roster', async () => {
    await writeProjectConfig({
      companion: { enabled: false },
      replaceBuiltinSubagents: false,
    });
    const { ctx, removedAgents } = makeCtx(projectDir);
    const cleanup = await createV2Setup()(ctx);
    try {
      expect(removedAgents).toEqual([]);
    } finally {
      await cleanup();
    }
  }, 20_000);

  test('retained native agents bypass preset work on launch and continuation', async () => {
    await writeProjectConfig({
      companion: { enabled: false },
      backgroundJobs: { mode: 'off' },
      sessionPresetRouting: true,
      replaceBuiltinSubagents: false,
      liveConfigRefresh: false,
      agents: {
        explorer: {
          model: ['test/slim', 'backup/slim'],
          temperature: 0.3,
          options: { reasoning: 'slim' },
        },
      },
    });
    const { ctx, beforeHooks, subagentTool, storageCalls } =
      makeCtx(projectDir);
    const get = spyOn(ctx.session, 'get');
    const cleanup = await createV2Setup()(ctx);
    try {
      const before = beforeHooks[0];
      const execute = subagentTool.execute as
        | ((input: unknown, context: unknown) => Promise<unknown>)
        | undefined;
      if (!before || !execute) throw new Error('native hooks not captured');
      get.mockClear();
      const initialStorage = { ...storageCalls };
      for (const agent of ['explore', 'general']) {
        for (const sessionID of [undefined, 'native-child']) {
          const input = {
            agent,
            description: 'native probe',
            prompt: 'Work',
            ...(sessionID ? { sessionID, model: 'manual/native#high' } : {}),
          };
          const event = {
            ...delegationEvent(),
            id: `${agent}-${sessionID ?? 'new'}`,
            input: { ...input },
          };
          await before(event as never);
          expect(event.input).toEqual(input);
          await execute(event.input, {
            sessionID: event.sessionID,
            id: event.id,
            signal: new AbortController().signal,
            progress: async () => {},
          });
        }
      }
      expect(get).not.toHaveBeenCalled();
      expect(storageCalls).toEqual(initialStorage);
      const slim = delegationEvent();
      await before(slim as never);
      expect(slim.input).toMatchObject({ model: 'test/slim' });
      expect(get).toHaveBeenCalled();
    } finally {
      await cleanup();
      get.mockRestore();
    }
  }, 20_000);

  test('replaceBuiltinSubagents defaults to hiding general and explore', async () => {
    await writeProjectConfig({ companion: { enabled: false } });
    const { ctx, removedAgents } = makeCtx(projectDir);
    const cleanup = await createV2Setup()(ctx);
    try {
      expect(removedAgents).toEqual(['general', 'explore']);
    } finally {
      await cleanup();
    }
  }, 20_000);

  test('sessionPresetRouting true re-enables routing while task controls stay off', async () => {
    await writeProjectConfig({
      companion: { enabled: false },
      backgroundJobs: { mode: 'off' },
      sessionPresetRouting: true,
    });
    const { ctx, commandAdds, rpcDefinitions, toolAdds } = makeCtx(projectDir);
    const cleanup = await createV2Setup()(ctx);
    try {
      expect(commandAdds.map((command) => command.name)).toContain('preset');
      expect(rpcDefinitions).toContain(sessionPresetRpc);
      expect(toolAdds.filter((name) => name.startsWith('task_'))).toEqual([]);
    } finally {
      await cleanup();
    }
  }, 20_000);

  test('sessionPresetRouting false leaves native delegation unwrapped and unbound', async () => {
    await writeProjectConfig({
      companion: { enabled: false },
      backgroundJobs: { mode: 'native' },
      sessionPresetRouting: false,
    });
    const { ctx, commandAdds, rpcDefinitions, subagentTool } =
      makeCtx(projectDir);
    const cleanup = await createV2Setup()(ctx);
    try {
      expect(commandAdds.map((command) => command.name)).not.toContain(
        'preset',
      );
      expect(rpcDefinitions).not.toContain(sessionPresetRpc);
      expect(subagentTool.execute).toBe(nativeSubagentExecute);
      expectQueueSchema(subagentTool, false);
    } finally {
      await cleanup();
    }
  }, 20_000);

  test('off with no preset, sidebar or retry consumer skips the profile seed', async () => {
    await writeProjectConfig({
      companion: { enabled: false },
      backgroundJobs: { mode: 'off' },
      tui: false,
      disabled_hooks: ['foreground-fallback'],
    });
    const inferenceViews = spyOn(agentFactory, 'createAgentInferenceViews');
    const { ctx, promptHooks } = makeCtx(projectDir);
    const cleanup = await createV2Setup()(ctx);
    try {
      const prompt = promptHooks[0];
      if (!prompt) throw new Error('session:prompt hook not captured');
      await prompt({
        sessionID: 'ses_no_profile_consumer',
        messageID: 'msg_no_profile_consumer',
        prompt: { text: 'hello' },
      } as never);
      expect(inferenceViews).not.toHaveBeenCalled();
    } finally {
      await cleanup();
      inferenceViews.mockRestore();
    }
  }, 20_000);

  test('a sidebar consumer keeps the profile seed', async () => {
    await writeProjectConfig({
      companion: { enabled: false },
      backgroundJobs: { mode: 'off' },
      disabled_hooks: ['foreground-fallback'],
    });
    const inferenceViews = spyOn(agentFactory, 'createAgentInferenceViews');
    const { ctx, promptHooks } = makeCtx(projectDir);
    const cleanup = await createV2Setup()(ctx);
    try {
      const prompt = promptHooks[0];
      if (!prompt) throw new Error('session:prompt hook not captured');
      await prompt({
        sessionID: 'ses_sidebar_profile_consumer',
        messageID: 'msg_sidebar_profile_consumer',
        prompt: { text: 'hello' },
      } as never);
      expect(inferenceViews).toHaveBeenCalled();
    } finally {
      await cleanup();
      inferenceViews.mockRestore();
    }
  }, 20_000);

  test('consumer-specific event filters exclude unused event families', async () => {
    await writeProjectConfig({
      companion: { enabled: false },
      backgroundJobs: { mode: 'off' },
      tui: false,
      disabled_hooks: [
        'foreground-fallback',
        'cache-monitor',
        'tool-loop-guard',
      ],
      interview: { enabled: false },
    });
    const { ctx, eventTypes } = makeCtx(projectDir);
    const cleanup = await createV2Setup()(ctx);
    try {
      expect(eventTypes[0]).toEqual(detachedNativeEvents);
    } finally {
      await cleanup();
    }
  }, 20_000);

  for (const [label, backgroundJobs, queueEnabled] of [
    ['default', {}, true],
    ['explicit native', { mode: 'native' }, false],
    ['native with queue', { mode: 'native', queue: { enabled: true } }, true],
    [
      'off with queue requested',
      { mode: 'off', queue: { enabled: true } },
      false,
    ],
  ] as const) {
    test(`${label}: queue state is independent of preset routing and other event consumers`, async () => {
      await writeProjectConfig({
        companion: { enabled: false },
        backgroundJobs,
        sessionPresetRouting: false,
        tui: false,
        disabled_hooks: [
          'foreground-fallback',
          'cache-monitor',
          'tool-loop-guard',
        ],
        interview: { enabled: false },
      });
      const {
        ctx,
        commandAdds,
        eventTypes,
        hooks,
        rpcDefinitions,
        subagentTool,
      } = makeCtx(projectDir);
      const cleanup = await createV2Setup()(ctx);
      try {
        expect(commandAdds.map((command) => command.name)).not.toContain(
          'preset',
        );
        expect(rpcDefinitions).not.toContain(sessionPresetRpc);
        expect(hooks).toContain('tool:execute.after');
        expectQueueSchema(subagentTool, queueEnabled);
        if (queueEnabled)
          expect(subagentTool.execute).not.toBe(nativeSubagentExecute);
        else expect(subagentTool.execute).toBe(nativeSubagentExecute);
        expect(eventTypes[0]).toEqual(
          queueEnabled
            ? [
                ...detachedNativeEvents.slice(0, 4),
                ...admissionEventTypes,
                ...detachedNativeEvents.slice(4),
              ]
            : detachedNativeEvents,
        );
      } finally {
        await cleanup();
      }
    }, 20_000);
  }

  test('lifecycle disabled: no persistence and no structured-launch wrapper', async () => {
    await writeProjectConfig({
      companion: { enabled: false },
      backgroundJobs: { mode: 'off' },
    });
    const { ctx, subagentTool } = makeCtx(projectDir);
    const cleanup = await createV2Setup()(ctx);
    try {
      expect(subagentTool.execute).toBe(nativeSubagentExecute);
      expectQueueSchema(subagentTool, false);
      // No persisted board state was seeded for this project directory.
      const stateDir = path.join(
        fixtureRoot,
        'xdg-data',
        'opencode',
        'plugins',
        'oh-my-opencode-slim',
        'storage',
      );
      expect(fs.existsSync(stateDir)).toBe(false);
    } finally {
      await cleanup();
    }
  }, 20_000);

  for (const mode of ['native', 'off'] as const) {
    test(`backgroundJobs.mode "${mode}": no persistence and no structured-launch wrapper`, async () => {
      await writeProjectConfig({
        companion: { enabled: false },
        backgroundJobs: { mode },
      });
      const { ctx, subagentTool, storageCalls } = makeCtx(projectDir);
      const cleanup = await createV2Setup()(ctx);
      try {
        expect(storageCalls).toEqual({ get: 0, set: 0, remove: 0, scan: 0 });
        expectQueueSchema(subagentTool, false);
        if (mode === 'native')
          expect(subagentTool.execute).not.toBe(nativeSubagentExecute);
        else expect(subagentTool.execute).toBe(nativeSubagentExecute);
        const stateDir = path.join(
          fixtureRoot,
          'xdg-data',
          'opencode',
          'plugins',
          'oh-my-opencode-slim',
          'storage',
        );
        expect(fs.existsSync(stateDir)).toBe(false);
      } finally {
        await cleanup();
      }
    }, 20_000);
  }

  for (const mode of [undefined, 'native', 'managed'] as const) {
    test(`startup does not inspect retained managed histories (${mode ?? 'default'})`, async () => {
      await writeProjectConfig({
        companion: { enabled: false },
        ...(mode ? { backgroundJobs: { mode } } : {}),
      });
      const configFile = path.join(
        projectDir,
        '.opencode',
        'oh-my-opencode-slim.json',
      );
      const before = fs.readFileSync(configFile, 'utf8');
      const retained = new Map(
        Array.from({ length: 500 }, (_, index) => {
          const taskID = `ses_retained_${String(index).padStart(3, '0')}`;
          return [
            `omo/bgj/child/${taskID}`,
            {
              taskID,
              parentSessionID: 'ses_retained_parent',
              agent: 'explorer',
              background: true,
              launchedAt: 1,
              deliveredAt: 2,
            },
          ] as const;
        }),
      );
      const { ctx, storageCalls } = makeCtx(projectDir, {
        get: async (key) => retained.get(key),
        set: async () => {
          throw new Error('Startup must not rewrite managed records');
        },
        remove: async () => {
          throw new Error('Startup must not remove managed records');
        },
        scan: async ({ prefix, after, limit = 100 }) => {
          const matches = [...retained.entries()].filter(
            ([key]) => key.startsWith(prefix) && (!after || key > after),
          );
          const page = matches.slice(0, limit);
          return {
            entries: page.map(([key, value]) => ({ key, value })),
            ...(matches.length > limit ? { next: page.at(-1)?.[0] } : {}),
          };
        },
      });
      const reads = { get: 0, list: 0, context: 0 };
      Object.assign(ctx.session, {
        get: async () => {
          reads.get += 1;
          throw new Error('Startup must not inspect retained sessions');
        },
        list: async () => {
          reads.list += 1;
          throw new Error('Startup must not list retained sessions');
        },
        context: async () => {
          reads.context += 1;
          throw new Error('Startup must not read retained histories');
        },
      });
      const cleanup = await createV2Setup()(ctx);
      try {
        expect(reads).toEqual({ get: 0, list: 0, context: 0 });
        expect(storageCalls).toEqual({ get: 0, set: 0, remove: 0, scan: 0 });
        expect(retained.size).toBe(500);
        expect(fs.readFileSync(configFile, 'utf8')).toBe(before);
      } finally {
        await cleanup();
      }
    }, 20_000);
  }

  // Regression: the bridge's fail-closed guard requires the session-preset
  // wrapper that consumes its admission. Gating that wrapper with the managed
  // lifecycle left the guard armed in `native`/`off`, so every `subagent` call
  // was rejected with 'Native subagent session preset wrapper unavailable'.
  for (const [label, backgroundJobs] of [
    ['mode "native"', { mode: 'native' }],
    ['mode "off"', { mode: 'off' }],
  ] as const) {
    test(`lifecycle off (${label}): delegation is not rejected by the preset guard`, async () => {
      await writeProjectConfig({
        companion: { enabled: false },
        backgroundJobs: backgroundJobs as Record<string, unknown>,
      });
      const { ctx, beforeHooks } = makeCtx(projectDir);
      const cleanup = await createV2Setup()(ctx);
      try {
        const hook = beforeHooks[0];
        if (!hook) throw new Error('tool:execute.before not captured');
        await expect(hook(delegationEvent() as never)).resolves.toBeUndefined();
      } finally {
        await cleanup();
      }
    }, 20_000);
  }

  // Regression: a continuation (`sessionID` without `agent`) must reach the
  // host. The preset wrapper consumes an admission for EVERY call, so the
  // bridge must capture one for resumes too, not only for `agent` launches.
  for (const [label, backgroundJobs] of [
    ['mode "native"', { mode: 'native' }],
    ['mode "off"', { mode: 'off' }],
  ] as const) {
    test(`${label}: a resume without agent runs the wrapped executor`, async () => {
      await writeProjectConfig({
        companion: { enabled: false },
        backgroundJobs: backgroundJobs as Record<string, unknown>,
      });
      const { ctx, beforeHooks, subagentTool } = makeCtx(projectDir);
      const cleanup = await createV2Setup()(ctx);
      try {
        const hook = beforeHooks[0];
        if (!hook) throw new Error('subagent wiring not captured');
        const event = {
          ...delegationEvent(),
          id: 'call_gate_resume',
          input: { sessionID: 'ses_gate_child', prompt: 'Continue' },
        };
        await hook(event as never);
        const execute = subagentTool.execute as (
          input: unknown,
          context: unknown,
        ) => Promise<unknown>;
        await expect(
          execute(event.input, {
            sessionID: event.sessionID,
            id: event.id,
            signal: new AbortController().signal,
            progress: async () => {},
          }),
        ).resolves.toEqual({});
      } finally {
        await cleanup();
      }
    }, 20_000);
  }

  test('off constructs no preset RPC, server command, or storage access', async () => {
    await writeProjectConfig({
      companion: { enabled: false },
      backgroundJobs: { mode: 'off' },
    });
    const { ctx, rpcHandlers, commandAdds, storageCalls } = makeCtx(projectDir);
    const cleanup = await createV2Setup()(ctx);
    try {
      expect(rpcHandlers).toEqual([]);
      expect(commandAdds.map((entry) => entry.name)).not.toContain('preset');
      expect(storageCalls).toEqual({ get: 0, set: 0, remove: 0, scan: 0 });
    } finally {
      await cleanup();
    }
  }, 20_000);

  test('managed project layer migrates inert keys and overrides user off mode', async () => {
    const configDir = process.env.OPENCODE_CONFIG_DIR as string;
    await mkdir(configDir, { recursive: true });
    await Bun.write(
      path.join(configDir, 'oh-my-opencode-slim.json'),
      JSON.stringify({ backgroundJobs: { mode: 'off' } }),
    );
    await writeProjectConfig({
      companion: { enabled: false },
      backgroundJobs: {
        mode: 'managed',
        maxSessionsPerAgent: 2,
        stopConfirmationMs: 5000,
        wallClockTimeoutMs: 0,
        concurrency: {
          defaultConcurrency: 0,
          providerConcurrency: { openai: 0 },
        },
        sameProviderPolicy: { openai: 'foreground' },
        waitForUserGuard: true,
        childInputWake: true,
        childInputWakeKinds: { question: true },
        pruneEvictedSessions: false,
      },
    });
    const { ctx, commandAdds, subagentTool } = makeCtx(projectDir);
    const cleanup = await createV2Setup()(ctx);
    try {
      expect(commandAdds.map((entry) => entry.name)).toContain('preset');
      expectQueueSchema(subagentTool, true);
      expect(subagentTool.execute).not.toBe(nativeSubagentExecute);
    } finally {
      await cleanup();
    }
  });

  test('native delegation wording retains the host schema validators and executor in off mode', async () => {
    await writeProjectConfig({ backgroundJobs: { mode: 'off' } });
    const { ctx, subagentTool } = makeCtx(projectDir);
    const cleanup = await createV2Setup()(ctx);
    try {
      const schema = subagentSchema(subagentTool);
      const description = schema.fields.model.ast.annotations?.description;
      const guidance =
        'Set this when the user or delegation instructions select a model or variant;';
      expect(description).toBe(guidance);
      expect(subagentTool.description).toBe(`Native delegation. ${guidance}`);
      expect(subagentTool.execute).toBe(nativeSubagentExecute);
      const decode = Schema.decodeUnknownSync(schema);
      const args = {
        agent: 'explorer',
        description: 'Review',
        prompt: 'Review this',
      };
      expect(decode(args)).toEqual(args);
      expect(decode({ ...args, sessionID: 'ses_host_child' })).toEqual({
        ...args,
        sessionID: 'ses_host_child',
      });
      expect(() => decode({ ...args, sessionID: 'bad-id' })).toThrow();
      expect(() => decode({ ...args, model: 42 })).toThrow();
      expectQueueSchema(subagentTool, false);
    } finally {
      await cleanup();
    }
  }, 20_000);

  test('liveConfigRefresh disabled: no watcher, but seed and explicit preset refresh work', async () => {
    await writeProjectConfig({
      companion: { enabled: false },
      liveConfigRefresh: false,
      preset: 'cheap',
      presets: {
        cheap: { explorer: { model: 'openai/gpt-5-mini' } },
        strong: { explorer: { model: 'anthropic/claude-sonnet-4-5' } },
      },
    });
    const factory = configWatch.watchPluginConfigFiles;
    const watcherFactory = spyOn(
      configWatch,
      'watchPluginConfigFiles',
    ).mockImplementation(((options: configWatch.WatchPluginConfigOptions) => {
      return factory(options);
    }) as never);
    const { ctx, rpcHandlers } = makeCtx(projectDir);
    const cleanup = await createV2Setup()(ctx);
    try {
      expect(watcherFactory).not.toHaveBeenCalled();

      // The unconditional one-shot refresh seeds the selected profile even
      // with filesystem watching disabled.
      const { readTuiSnapshot } = await import('../tui-state');
      expect(readTuiSnapshot(projectDir).agentModels.explorer).toBe(
        'openai/gpt-5-mini',
      );

      // The explicit /preset application uses the RPC's named refresh path,
      // which must still resolve against the current config without a watcher.
      const handlers = rpcHandlers[0];
      expect(handlers).toBeDefined();
      const apply = handlers?.apply as (
        input: { sessionID: string; presetName: string },
        context: { signal: AbortSignal },
      ) => Promise<{ presetName: string }>;
      const applied = await apply(
        { sessionID: 'ses_preset_off', presetName: 'strong' },
        { signal: new AbortController().signal },
      );
      expect(applied.presetName).toBe('strong');
      await expect(
        apply(
          { sessionID: 'ses_preset_missing', presetName: 'missing' },
          { signal: new AbortController().signal },
        ),
      ).rejects.toThrow('Unknown preset: missing');
      expect(watcherFactory).not.toHaveBeenCalled();
    } finally {
      await cleanup();
      watcherFactory.mockRestore();
    }
  }, 20_000);

  test('sidebar disabled: finalization writes no display names', async () => {
    await writeProjectConfig({
      companion: { enabled: false },
      sidebar: false,
      agents: { explorer: { model: 'openai/gpt-5-mini' } },
    });
    const { ctx } = makeCtx(projectDir);
    const cleanup = await createV2Setup()(ctx);
    try {
      // Supply a live agent draft so finalization runs at all: with the
      // sidebar switch on (baseline) this writes display names for every
      // registered agent; off, no tui-state write happens.
      const { readTuiSnapshot } = await import('../tui-state');
      expect(readTuiSnapshot(projectDir).agentModels).toEqual({});
    } finally {
      await cleanup();
    }
  }, 20_000);
});
