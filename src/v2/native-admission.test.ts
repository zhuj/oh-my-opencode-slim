import { expect, mock, test } from 'bun:test';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Schema, type StandardSchemaV1 } from 'effect';
import { withTmpDir } from '../test-utils';
import {
  acquireNativeAdmissionRuntime,
  extendNativeSubagentInput,
} from './native-admission';
import {
  type NativeAdmissionRecovery,
  observeTrackedAdmissionFailure,
  registerNativeAdmissionRecovery,
} from './native-admission-recovery';
import type { V2Session } from './types';

const parent = 'ses_parent';

function event(type: string, sessionID: string, seq: number, data = {}) {
  return {
    type,
    durable: { aggregateID: sessionID, seq, version: 1 },
    data: { sessionID, ...data },
  };
}

function execution(
  directory: string,
  defaultConcurrency: number,
  options: {
    recover?: NativeAdmissionRecovery;
    session?: Pick<V2Session, 'list' | 'wait' | 'get'>;
    skipPromptCapture?: boolean;
    onCaptured?: () => void;
  } = {},
) {
  const runtime = acquireNativeAdmissionRuntime(
    directory,
    { defaultConcurrency },
    options,
  );
  const child = (id: number) => `ses_${directory}_${id}`;
  let next = 0;
  const checkpoints = new Map<string, PromiseWithResolvers<unknown>>();
  const started: Array<{ childID: string; inboxID: string; text: string }> = [];
  const native = mock(async (input: unknown, rawContext: unknown) => {
    const args = input as { prompt: string; sessionID?: string };
    const context = rawContext as {
      signal: AbortSignal;
      progress(update: object): Promise<void>;
    };
    const childID = args.sessionID ?? child(++next);
    const inboxID = `msg_${started.length + 1}`;
    await context.progress({ sessionID: childID, status: 'running' });
    const prompt = {
      text: args.sessionID ? args.prompt : `Native preamble\n${args.prompt}`,
    };
    if (!options.skipPromptCapture)
      runtime.capturePrompt({ sessionID: childID, messageID: inboxID, prompt });
    options.onCaptured?.();
    started.push({ childID, inboxID, text: prompt.text });
    await checkpoints.get(inboxID)?.promise;
    context.signal.throwIfAborted();
    return {
      output: {
        sessionID: childID,
        status: 'running',
        output: 'Native response',
      },
      content: 'Native response',
      metadata: { sessionID: childID },
    };
  });
  const wrapped = runtime.wrap(native, { session: options.session });
  return {
    ...runtime,
    native,
    child,
    started,
    checkpoints,
    launch(
      args: object,
      options: { parentID?: string; signal?: AbortSignal } = {},
    ) {
      return wrapped(
        {
          agent: 'fixer',
          description: 'Fix API',
          prompt: 'Fix the API',
          ...args,
        },
        {
          sessionID: options.parentID ?? parent,
          signal: options.signal ?? new AbortController().signal,
          progress: async () => {},
        },
      );
    },
    emit(type: string, seq: number, childID = child(1), data = {}) {
      runtime.observeEvent(event(type, childID, seq, data));
    },
  };
}

test('separately bundled host decodes advertised queue arguments and retains its native validators', async () => {
  await withTmpDir(async (directory) => {
    const entry = join(directory, 'host.ts');
    await writeFile(
      entry,
      `export { Effect, Fiber, Schema } from ${JSON.stringify(require.resolve('effect'))};`,
    );
    const bundle = await Bun.build({
      entrypoints: [entry],
      outdir: join(directory, 'bundle'),
      target: 'node',
      packages: 'bundle',
    });
    expect(bundle.success).toBe(true);
    const {
      Effect: HostEffect,
      Fiber: HostFiber,
      Schema: HostSchema,
    } = (await import(
      pathToFileURL(join(directory, 'bundle', 'host.js')).href
    )) as typeof import('effect');
    expect(HostSchema.Struct).not.toBe(Schema.Struct);
    const native = HostSchema.Struct({
      agent: HostSchema.String,
      description: HostSchema.String,
      prompt: HostSchema.String,
      model: HostSchema.optionalKey(HostSchema.String),
      sessionID: HostSchema.optionalKey(
        HostSchema.String.check(HostSchema.isStartingWith('ses')).pipe(
          HostSchema.brand('Session.ID'),
        ),
      ),
    });
    const raw = {
      agent: 'fixer',
      description: 'Fix API',
      prompt: 'Work',
      id: 'fix-api',
      depends_on: ['inspect-api'],
      sessionID: 'ses_child',
    };
    expect(HostSchema.decodeUnknownSync(native)(raw)).not.toHaveProperty(
      'depends_on',
    );
    const extended = extendNativeSubagentInput(native) as StandardSchemaV1 & {
      '~standard': {
        jsonSchema: { input(options: { target: string }): unknown };
      };
    };
    expect(
      extended['~standard'].jsonSchema.input({ target: 'draft-2020-12' }),
    ).toMatchObject({
      required: ['agent', 'description', 'prompt'],
      properties: {
        sessionID: { pattern: '^ses' },
        id: { type: 'string' },
        depends_on: { type: 'array', maxItems: 256 },
      },
    });
    // OpenCode's Standard Schema path evaluates this validator rather than
    // passing its foreign AST into the host Effect parser.
    const validate = (value: unknown) =>
      HostEffect.runPromise(
        HostEffect.promise(async () => extended['~standard'].validate(value)),
      );
    expect(await validate(raw)).toEqual({ value: raw });
    expect(await validate({ ...raw, sessionID: 'invalid' })).toHaveProperty(
      'issues',
    );
    expect(
      await validate({ ...raw, depends_on: Array(257).fill('prerequisite') }),
    ).toHaveProperty('issues');

    const source = acquireNativeAdmissionRuntime('queue-als-source');
    const destination = acquireNativeAdmissionRuntime('queue-als-destination');
    const childID = 'ses_als_child';
    const prompt = { text: 'Work' };
    try {
      const native = source.wrap(async (input, rawContext) => {
        const context = rawContext as {
          progress(update: object): Promise<void>;
        };
        expect(input).toMatchObject({ prompt: 'Work' });
        return HostEffect.runPromise(
          HostEffect.gen(function* () {
            yield* HostEffect.promise(() =>
              context.progress({ sessionID: childID }),
            );
            yield* HostEffect.yieldNow;
            const prepare = yield* HostEffect.forkChild(
              HostEffect.promise(async () => {
                await Promise.resolve();
                destination.capturePrompt({
                  sessionID: childID,
                  messageID: 'msg_als',
                  prompt,
                });
              }),
            );
            yield* HostFiber.join(prepare);
            return {
              content: 'Native response',
              metadata: { sessionID: childID },
            };
          }),
        );
      });
      await native(
        { ...raw, depends_on: [], sessionID: undefined },
        { sessionID: parent, progress: async () => {} },
      );
      expect(prompt).toEqual({ text: 'Work' });
      destination.observeEvent(
        event('session.inbox.enqueued', childID, 1, { inboxID: 'msg_als' }),
      );
      destination.observeEvent(event('session.execution.started', childID, 2));
      destination.observeEvent(
        event('session.inbox.delivered', childID, 3, { inboxID: 'msg_als' }),
      );
      destination.observeEvent(
        event('session.execution.succeeded', childID, 4),
      );
      expect(source.scheduler.list(parent)).toMatchObject([
        { logicalID: 'fix-api', state: 'completed' },
      ]);
    } finally {
      await Promise.all([source.release(), destination.release()]);
    }
  });
});

test('blocked dependencies consume no native capacity and wait for the exact child outcome', async () => {
  const host = execution('queue-independent-lanes', 2);
  try {
    const first = await host.launch({ id: 'inspect' });
    expect(first).toMatchObject({
      output: { sessionID: host.child(1), output: 'Native response' },
      metadata: { id: 'inspect', admission_id: expect.any(String) },
    });
    expect(host.started[0]?.text).toBe('Native preamble\nFix the API');
    await expect(host.launch({ id: 'inspect' })).rejects.toThrow(
      'Duplicate logical task id',
    );
    await expect(
      host.launch(
        { id: 'foreign', depends_on: ['inspect'] },
        { parentID: 'ses_unrelated' },
      ),
    ).rejects.toThrow('Unknown or cross-parent');
    const dependent = host.launch({ id: 'implement', depends_on: ['inspect'] });
    await host.launch({ id: 'independent' });
    expect(host.native).toHaveBeenCalledTimes(2);
    expect(host.scheduler.snapshot()).toEqual({ active: 2, queued: 1 });
    host.emit('session.inbox.enqueued', 1, host.child(1), { inboxID: 'msg_1' });
    host.emit('session.execution.started', 2);
    host.emit('session.inbox.delivered', 3, host.child(1), {
      inboxID: 'msg_1',
    });
    host.emit('session.step.failed', 4);
    host.emit('session.execution.interrupted', 5, host.child(1), {
      reason: 'shutdown',
    });
    expect(host.scheduler.snapshot()).toEqual({ active: 2, queued: 1 });
    host.emit('session.execution.started', 6);
    host.emit('session.execution.failed', 4);
    host.emit('session.execution.succeeded', 7);
    await dependent;
    expect(host.native).toHaveBeenCalledTimes(3);
    expect(
      await host.scheduler.waitForTasks(parent, ['inspect']),
    ).toMatchObject([{ state: 'completed' }]);
  } finally {
    host.release();
  }
});

test('a native follow-up held in the inbox waits for its own busy period', async () => {
  const host = execution('queue-follow-up-fence', 3);
  try {
    await host.launch({ id: 'first' });
    host.emit('session.inbox.enqueued', 1, host.child(1), { inboxID: 'msg_1' });
    host.emit('session.execution.started', 2);
    host.emit('session.inbox.delivered', 3, host.child(1), {
      inboxID: 'msg_1',
    });
    await host.launch({ id: 'followup', sessionID: host.child(1) });
    expect(host.started[1]?.text).toBe('Fix the API');
    const dependent = host.launch({
      id: 'dependent',
      depends_on: ['followup'],
    });
    host.emit('session.inbox.enqueued', 4, host.child(1), { inboxID: 'msg_2' });
    host.emit('session.execution.succeeded', 5);
    expect(host.scheduler.list(parent)).toMatchObject([
      { logicalID: 'first', state: 'completed' },
      { logicalID: 'followup', state: 'running' },
    ]);
    host.emit('session.model.selected', 6, host.child(1), {
      model: { providerID: 'alternate', id: 'model' },
    });
    expect(host.scheduler.holdsReservation(host.child(1))).toBe(true);
    expect(host.scheduler.list(parent)[1]?.model).toBe('alternate/model');
    host.emit('session.execution.started', 7);
    host.emit('session.inbox.delivered', 8, host.child(1), {
      inboxID: 'msg_2',
    });
    host.emit('session.execution.succeeded', 9);
    await dependent;
    expect(
      await host.scheduler.waitForTasks(parent, ['followup']),
    ).toMatchObject([{ state: 'completed' }]);
  } finally {
    host.release();
  }
});

test.each([true, false])(
  'a matching recovery decision preserves the original admission only when accepted (%s)',
  async (confirmed) => {
    const recovery = Promise.withResolvers<string | undefined>();
    const recover = mock(() => recovery.promise);
    const host = execution(`queue-recovery-${confirmed}`, 1, { recover });
    try {
      await host.launch({ id: 'first' });
      host.emit('session.inbox.enqueued', 1, host.child(1), {
        inboxID: 'msg_1',
      });
      host.emit('session.execution.started', 2);
      host.emit('session.inbox.delivered', 3, host.child(1), {
        inboxID: 'msg_1',
      });
      const dependent = host.launch({ id: 'after', depends_on: ['first'] });
      void dependent.catch(() => undefined);
      host.observeEvent(
        event('session.execution.failed', host.child(1), 4, {
          error: { message: 'No route' },
        }),
      );
      expect(recover).toHaveBeenCalledWith(
        expect.any(Object),
        host.child(1),
        'No route',
      );
      expect(host.scheduler.list(parent)[0]?.state).toBe('running');
      host.emit('session.execution.started', 5);
      host.emit('session.execution.succeeded', 6);
      recovery.resolve(confirmed ? 'provider/fallback' : undefined);
      if (confirmed) await dependent;
      else await expect(dependent).rejects.toThrow('Task prerequisite failed');
      expect(host.scheduler.list(parent)[0]?.state).toBe(
        confirmed ? 'completed' : 'error',
      );
      expect(host.native).toHaveBeenCalledTimes(confirmed ? 2 : 1);
    } finally {
      host.release();
    }
  },
);

test('overlapping generations share reservations and limits without crossing directories', async () => {
  const first = execution('queue-shared-generations', 1);
  const second = acquireNativeAdmissionRuntime('queue-shared-generations', {
    defaultConcurrency: 1,
  });
  const separate = acquireNativeAdmissionRuntime('queue-other-directory', {
    defaultConcurrency: 1,
  });
  try {
    await first.launch({ id: 'native' });
    expect(second.scheduler).toBe(first.scheduler);
    expect(separate.scheduler).not.toBe(first.scheduler);
    expect(second.scheduler.snapshot().active).toBe(1);
    expect(separate.scheduler.snapshot().active).toBe(0);
    first.release();
    second.observeEvent(
      event('session.inbox.enqueued', first.child(1), 1, { inboxID: 'msg_1' }),
    );
    second.observeEvent(event('session.execution.started', first.child(1), 2));
    second.observeEvent(
      event('session.inbox.delivered', first.child(1), 3, { inboxID: 'msg_1' }),
    );
    second.observeEvent(
      event('session.execution.succeeded', first.child(1), 4),
    );
    expect(second.scheduler.snapshot().active).toBe(0);
  } finally {
    first.release();
    second.release();
    separate.release();
  }
});

test('parent abort after the prompt hook lets the accepted native Job commit', async () => {
  const reachedPrompt = Promise.withResolvers<void>();
  const original = new AbortController();
  const host = execution('queue-post-prompt-stop', 1, {
    onCaptured: () => reachedPrompt.resolve(),
  });
  const hostReceipt = Promise.withResolvers<unknown>();
  host.checkpoints.set('msg_1', hostReceipt);
  try {
    const launched = host.launch({ id: 'first' }, { signal: original.signal });
    await reachedPrompt.promise;
    original.abort();
    hostReceipt.resolve(undefined);
    expect(await launched).toMatchObject({
      metadata: { sessionID: host.child(1), id: 'first' },
    });
    expect(host.scheduler.snapshot().active).toBe(1);
    host.emit('session.inbox.enqueued', 1, host.child(1), { inboxID: 'msg_1' });
    host.emit('session.execution.started', 2);
    host.emit('session.inbox.delivered', 3, host.child(1), {
      inboxID: 'msg_1',
    });
    host.emit('session.execution.succeeded', 4);
    expect(host.scheduler.list(parent)[0]?.state).toBe('completed');
  } finally {
    await host.release();
  }
});

test('missing prompt evidence preserves the native result and does not release a live reservation', async () => {
  const host = execution('queue-unobserved', 1, { skipPromptCapture: true });
  try {
    const launched = await host.launch({ id: 'first' });
    expect(launched).toMatchObject({ output: { sessionID: host.child(1) } });
    expect(host.scheduler.list(parent)).toMatchObject([
      { state: 'running', observationError: expect.any(String) },
    ]);
    host.emit('session.execution.started', 1);
    expect(host.scheduler.snapshot().active).toBe(1);
    host.emit('session.deleted', 2);
    expect(host.scheduler.snapshot().active).toBe(0);
  } finally {
    await host.release();
  }
});

test('an authoritative idle read releases an unobserved prompt as an admission error', async () => {
  const idle = Promise.withResolvers<void>();
  const childID = 'ses_queue-unobserved-idle_1';
  const wait = mock(() => idle.promise);
  const get = mock(async () => ({
    id: childID,
    outcome: 'succeeded',
    time: { busy: 100, idle: 200 },
  }));
  const list = async () => ({ data: [], cursor: {} });
  const host = execution('queue-unobserved-idle', 1, {
    skipPromptCapture: true,
    session: { wait, get, list },
  });
  try {
    await host.launch({ id: 'first' });
    const dependent = host.launch({ id: 'after', depends_on: ['first'] });
    void dependent.catch(() => undefined);
    host.observeEvent({
      ...event('session.execution.succeeded', childID, 5),
      created: 200,
    });
    expect(wait).toHaveBeenCalledWith({ sessionID: childID });
    expect(host.scheduler.snapshot().active).toBe(1);
    idle.resolve();
    await expect(dependent).rejects.toThrow('Task prerequisite failed');
    expect(host.scheduler.list(parent)[0]?.state).toBe('error');
    expect(host.scheduler.snapshot().active).toBe(0);
    expect(get).toHaveBeenCalledTimes(1);
  } finally {
    await host.release();
  }
});

test('a native child can dispatch within its ancestor reservation under a sole-slot limit', async () => {
  const host = execution('queue-nested', 1);
  try {
    await host.launch({ id: 'root' });
    await expect(
      host.launch(
        { id: 'nested', model: 'other/model' },
        { parentID: host.child(1) },
      ),
    ).resolves.toMatchObject({
      metadata: { sessionID: host.child(2), id: 'nested' },
    });
    expect(host.scheduler.snapshot()).toEqual({ active: 1, queued: 0 });
  } finally {
    await host.release();
  }
});

test('a moved child uses the destination recovery resolver by exact durable identity', async () => {
  const origin = mock(() => Promise.resolve(undefined));
  const destination = mock(() => Promise.resolve('destination/fallback'));
  const host = execution('queue-move-origin', 1, { recover: origin });
  const detachDestination = registerNativeAdmissionRecovery(
    'queue-move-dest',
    destination,
  );
  try {
    await host.launch({ id: 'first' });
    host.emit('session.inbox.enqueued', 1, host.child(1), { inboxID: 'msg_1' });
    host.emit('session.execution.started', 2);
    host.emit('session.inbox.delivered', 3, host.child(1), {
      inboxID: 'msg_1',
    });
    host.emit('session.moved', 4, host.child(1), {
      location: { directory: 'queue-move-dest' },
    });
    const failure = event('session.execution.failed', host.child(1), 5, {
      error: { message: 'No route' },
    });
    expect(observeTrackedAdmissionFailure(failure)).toBe(true);
    expect(host.observeEvent(failure)).toBe(true);
    host.emit('session.execution.started', 6);
    host.emit('session.execution.succeeded', 7);
    expect(await host.scheduler.waitForTasks(parent, ['first'])).toMatchObject([
      { state: 'completed' },
    ]);
    expect(destination).toHaveBeenCalledTimes(1);
    expect(origin).not.toHaveBeenCalled();
  } finally {
    detachDestination();
    await host.release();
  }
});

test('startup census reserves live native capacity without restoring invisible dependency aliases', async () => {
  const readStarted = Promise.withResolvers<void>();
  const readResult = Promise.withResolvers<unknown>();
  const list = mock(() => {
    readStarted.resolve();
    return readResult.promise;
  });
  const host = execution('queue-restart-census', 1, { session: { list } });
  const recovered = 'ses_recovered_now';
  const alreadyEnded = 'ses_recovered_stale';
  try {
    const pending = host.launch({ id: 'after' });
    await readStarted.promise;
    host.observeEvent({
      ...event('session.execution.succeeded', alreadyEnded, 5),
      created: 150,
    });
    readResult.resolve({
      data: [recovered, alreadyEnded].map((id) => ({
        id,
        parentID: parent,
        time: { busy: 100 },
        model: { providerID: 'test', id: 'model' },
      })),
      cursor: {},
    });
    await expect(host.launch({ depends_on: [recovered] })).rejects.toThrow(
      'Unknown or cross-parent',
    );
    expect(list).toHaveBeenCalledTimes(1);
    expect(host.scheduler.snapshot()).toEqual({ active: 1, queued: 1 });
    expect(host.scheduler.list(parent)).toMatchObject([
      { logicalID: 'after', state: 'queued' },
    ]);
    expect(host.native).not.toHaveBeenCalled();
    host.observeEvent({
      ...event('session.execution.succeeded', recovered, 8),
      created: 200,
    });
    await pending;
    expect(host.native).toHaveBeenCalledTimes(1);
  } finally {
    await host.release();
  }
});

test('an invalid startup census fails closed and a later admission can retry', async () => {
  const list = mock(async () => ({ data: [], cursor: {} }));
  list.mockImplementationOnce(async () => ({ data: [], cursor: { next: 42 } }));
  const host = execution('queue-restart-retry', 1, { session: { list } });
  try {
    await expect(host.launch({ id: 'first' })).rejects.toThrow(
      'invalid native child occupancy cursor',
    );
    expect(host.native).not.toHaveBeenCalled();
    expect(host.scheduler.list(parent)).toEqual([]);
    await host.launch({ id: 'first' });
    expect(list).toHaveBeenCalledTimes(2);
    expect(host.native).toHaveBeenCalledTimes(1);
  } finally {
    await host.release();
  }
});
