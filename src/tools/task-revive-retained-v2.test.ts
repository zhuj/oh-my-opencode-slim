import { expect, spyOn, test } from 'bun:test';
import { tick } from '../utils/test-timers';
import { childID, retainedV2 } from './task-revive-retained-v2.fixture';

test('restored uncertain V2 work waits for native idle then admits one identity-bound continuation', async () => {
  const h = retainedV2();
  const retained = h.record();
  expect(retained.state).toBe('stopped');
  expect(retained.statusUncertain).toBe(true);
  const result = h.revive().catch((error: unknown) => error);
  await tick();
  if (h.wait.mock.calls.length === 0) throw await result;
  expect(h.wait).toHaveBeenCalledTimes(1);
  expect(h.prompt).not.toHaveBeenCalled();
  expect(h.record()).toBe(retained);
  h.idle.resolve();
  expect(await result).toContain('status: started');
  expect(h.record().generation).toBeGreaterThan(retained.generation);
  expect(retained.statusUncertain).toBe(true);
  expect(h.prompt).toHaveBeenCalledTimes(1);
  const submitted = h.prompt.mock.calls[0][0];
  if (typeof submitted.id !== 'string')
    throw new Error('Expected queued input ID');
  expect(submitted.sessionID).toBe(childID);
  expect(submitted.delivery).toBe('queue');
  expect(submitted.id).toStartWith('msg_omos_revive_');
  expect(h.tracker.promptMessageIDFor(childID, h.record().generation)).toBe(
    submitted.id,
  );
  expect(h.interrupt).not.toHaveBeenCalled();
});

test.each([
  ['missing idle channel', { queuedPromptIdentity: true }],
  ['missing queued identity', { waitForSessionIdle: async () => {} }],
  ['missing all capabilities', {}],
])(
  'retained recovery refuses %s without prompting',
  async (_name, capabilities) => {
    const h = retainedV2();
    Reflect.set(h.input, 'experimental_v2', capabilities);
    await expect(h.revive()).rejects.toThrow();
    expect(h.prompt).not.toHaveBeenCalled();
    expect(h.interrupt).not.toHaveBeenCalled();
    expect(h.record().statusUncertain).toBe(true);
  },
);

test.each([
  ['rejected wait', () => Promise.reject(new Error('native wait failed'))],
  [
    'synchronous failure',
    () => {
      throw new Error('native wait failed');
    },
  ],
  ['missing promise', () => undefined],
  ['malformed operation', () => ({ idle: true })],
  ['false completion', () => Promise.resolve(false)],
  ['malformed completion', () => Promise.resolve({ idle: true })],
])(
  'retained recovery refuses %s without changing the old round',
  async (_name, wait) => {
    const h = retainedV2();
    const old = h.record();
    Reflect.set(h.input, 'experimental_v2', {
      queuedPromptIdentity: true,
      waitForSessionIdle: wait,
    });
    await expect(h.revive()).rejects.toThrow();
    expect(h.record()).toBe(old);
    expect(h.prompt).not.toHaveBeenCalled();
    expect(h.interrupt).not.toHaveBeenCalled();
    expect(h.timers.pending()).toBe(0);
  },
);

test('native idle deadline fences a late successful settlement', async () => {
  const h = retainedV2();
  const old = h.record();
  const outcome = h.revive().catch((error: unknown) => error);
  await h.entered;
  await h.timers.advance(50);
  expect(await outcome).toBeInstanceOf(Error);
  h.idle.resolve();
  await tick();
  expect(h.record()).toBe(old);
  expect(h.prompt).not.toHaveBeenCalled();
  expect(h.interrupt).not.toHaveBeenCalled();
  expect(h.timers.pending()).toBe(0);
});

test('expired observation time refuses idle even before its timer callback runs', async () => {
  const h = retainedV2();
  let now = 0;
  const runtime = h.options.idleWaitRuntime;
  if (!runtime) throw new Error('Expected manual idle runtime');
  h.options.idleWaitRuntime = { ...runtime, now: () => now };
  const outcome = h.revive().catch((error: unknown) => error);
  await h.entered;
  now = 50;
  h.idle.resolve();
  expect(await outcome).toBeInstanceOf(Error);
  expect(h.prompt).not.toHaveBeenCalled();
  expect(h.timers.pending()).toBe(0);
});

test.each([NaN, Infinity, 0, -1])(
  'invalid native idle budget %s fails closed',
  async (timeout) => {
    const h = retainedV2({ waitForIdleTimeoutMs: timeout });
    await expect(h.revive()).rejects.toThrow(
      'Invalid session idle wait timeout',
    );
    expect(h.wait).not.toHaveBeenCalled();
    expect(h.prompt).not.toHaveBeenCalled();
  },
);

test.each([
  'local uncertainty',
  'explicit cancellation',
  'timeout',
  'terminal outcome',
])('%s is not widened into restored recovery', async (kind) => {
  const h = retainedV2();
  const old = h.record();
  if (kind === 'local uncertainty') old.externalOrigin = undefined;
  if (kind === 'explicit cancellation') old.cancellationRequested = true;
  if (kind === 'timeout') old.timedOut = true;
  if (kind === 'terminal outcome') old.terminalState = 'completed';
  await expect(h.revive()).rejects.toThrow(
    'not a verified retained terminal session',
  );
  expect(h.record()).toBe(old);
  expect(h.prompt).not.toHaveBeenCalled();
  expect(h.interrupt).not.toHaveBeenCalled();
});

test.each(['fallback', 'observation', 'queued identity'])(
  'pending %s blocks uncertain recovery',
  async (kind) => {
    const h = retainedV2();
    if (kind === 'fallback') h.options.isFallbackPending = () => true;
    if (kind === 'observation')
      spyOn(h.tracker, 'isObservationPending').mockReturnValue(true);
    if (kind === 'queued identity')
      spyOn(h.tracker, 'promptMessageIDFor').mockReturnValue('msg_prior');
    await expect(h.revive()).rejects.toThrow('pending admission');
    expect(h.wait).not.toHaveBeenCalled();
    expect(h.prompt).not.toHaveBeenCalled();
    expect(h.interrupt).not.toHaveBeenCalled();
  },
);

test('native idle does not bypass a pending prior admission lease', async () => {
  const h = retainedV2();
  const lease = h.board.acquireLease(
    childID,
    h.record().generation,
    'relaunch',
  );
  if (!lease) throw new Error('Expected fixture lease');
  await expect(h.revive()).rejects.toThrow('lease unavailable');
  expect(h.board.validateLease(lease)).toBe(true);
  expect(h.prompt).not.toHaveBeenCalled();
  h.board.releaseLease(lease);
});
