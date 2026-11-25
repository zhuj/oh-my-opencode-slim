import { expect, test } from 'bun:test';
import { createTimerHarness } from '../utils/test-timers';
import { createSkillCommandController } from './skill-command-lifecycle';
import { skillCommandHost } from './skill-command-test-fixture';

test.each(['skill', 'command'] as const)(
  'event during awaited %s read schedules another serial pass',
  async (api) => {
    // Given
    const host = skillCommandHost();
    const controller = createSkillCommandController(host.ctx, []);
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const read = host.ctx[api].list;
    let once = true;
    host.ctx[api].list = async () => {
      const snapshot = await read();
      if (once) {
        once = false;
        entered.resolve();
        await release.promise;
      }
      return snapshot;
    };
    const initial = controller.refresh();
    await entered.promise;
    // When
    host.setSkills([{ id: 'show-me' }]);
    controller.observeEvent({ type: 'skill.updated', data: {} });
    controller.observeEvent({ type: 'plugin.updated', data: {} });
    release.resolve();
    await initial;
    // Then
    expect([...host.replay().keys()]).toEqual(['show-me']);
    expect(host.calls.skills).toBe(2);
    expect(host.calls.peak).toBe(1);
    await controller.dispose();
  },
);

test.each(['skill', 'command', 'registration'] as const)(
  'teardown during awaited %s leaves no transform or resurrection',
  async (api) => {
    // Given
    const host = skillCommandHost();
    const controller = createSkillCommandController(host.ctx, []);
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const transform = host.ctx.command.transform;
    const read =
      api === 'command' ? host.ctx.command.list : host.ctx.skill.list;
    if (api === 'registration') {
      host.ctx.command.transform = async (callback) => {
        const registration = await transform(callback);
        entered.resolve();
        await release.promise;
        return registration;
      };
    } else {
      host.ctx[api].list = async () => {
        entered.resolve();
        await release.promise;
        return read();
      };
    }
    const initial = controller.refresh();
    await entered.promise;
    // When
    const disposing = controller.dispose();
    controller.observeEvent({ type: 'skill.updated', data: {} });
    release.resolve();
    await Promise.all([initial, disposing]);
    await controller.refresh();
    await controller.dispose();
    // Then
    expect(host.count()).toBe(0);
    expect(host.calls.registrations).toBe(api === 'registration' ? 1 : 0);
  },
);

test('command.updated emitted by own registration never queues another pass', async () => {
  // Given
  const host = skillCommandHost();
  const controller = createSkillCommandController(host.ctx, []);
  const transform = host.ctx.command.transform;
  host.ctx.command.transform = async (callback) => {
    const registration = await transform(callback);
    controller.observeEvent({ type: 'command.updated', data: {} });
    return registration;
  };
  // When
  await controller.refresh();
  // Then
  expect(host.calls.registrations).toBe(1);
  expect(host.calls.skills).toBe(1);
  await controller.dispose();
});

test('a failed disposal does not stack another generated transform', async () => {
  // Given
  const host = skillCommandHost();
  let rejectDisposal = true;
  const transform = host.ctx.command.transform;
  host.ctx.command.transform = async (callback) => {
    const registration = await transform(callback);
    return {
      dispose: () => {
        if (rejectDisposal) throw new Error('Disposal failed');
        registration.dispose();
      },
    };
  };
  const controller = createSkillCommandController(host.ctx, []);
  await controller.refresh();
  // When
  await controller.refresh();
  // Then
  expect(host.count()).toBe(1);
  expect(host.calls.registrations).toBe(1);
  rejectDisposal = false;
  await controller.dispose();
  expect(host.count()).toBe(0);
});

test('a stalled inventory lookup does not delay generation cleanup indefinitely', async () => {
  const host = skillCommandHost();
  const timers = createTimerHarness();
  let submitted = 0;
  host.ctx.session.prompt = async () => {
    submitted++;
  };
  const controller = createSkillCommandController(
    host.ctx,
    [],
    undefined,
    timers,
  );
  await controller.refresh();
  const previous = host.replay().get('opencode');
  expect(previous).toBeDefined();
  host.ctx.skill.list = () => new Promise<never>(() => {});
  const refresh = controller.refresh();
  await timers.tick();
  const disposing = controller.dispose();
  await previous?.execute({
    sessionID: 'ses_closed',
    prompt: { text: 'ignored' },
  });
  expect(submitted).toBe(0);
  expect(timers.pending()).toBe(1);
  await timers.advance(2_000);
  await Promise.all([refresh, disposing]);
  expect(host.count()).toBe(0);
  expect(timers.pending()).toBe(0);
});
