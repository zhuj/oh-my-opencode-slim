import { expect, test } from 'bun:test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { readGeneratedSkillCommandNames } from '../skill-command-lookup';
import { buildSkillCommandPrompt } from '../skill-command-template';
import { withTmpDir } from '../test-utils';
import { createSkillCommandController } from './skill-command-lifecycle';
import { skillCommandHost } from './skill-command-test-fixture';

test('disk-only mode changes replace executors and remove/re-add generated commands', async () => {
  await withTmpDir(async (root) => {
    const host = skillCommandHost();
    const path = join(root, 'SKILL.md');
    host.setSkills([{ id: 'mode-skill', path, content: 'HOST_BODY' }]);
    const submitted: Array<Record<string, unknown>> = [];
    const controller = createSkillCommandController(
      {
        ...host.ctx,
        session: {
          prompt: async (input) => {
            submitted.push(input);
          },
        },
      },
      [],
      'reference',
    );
    try {
      for (const mode of [
        'full',
        'reference',
        'none',
        'full',
        undefined,
      ] as const) {
        writeFileSync(
          path,
          mode ? `---\nslim:\n  command: ${mode}\n---\nDISK_BODY` : 'DISK_BODY',
        );
        controller.observeEvent({ type: 'skill.updated' });
        await controller.whenIdle();
        const command = host.replay().get('mode-skill');
        if (mode === 'none') {
          expect(command).toBeUndefined();
          expect(
            readGeneratedSkillCommandNames()?.has('mode-skill') ?? false,
          ).toBe(false);
          expect(host.count()).toBe(0);
        } else {
          expect(command).toBeDefined();
          await command?.execute({
            sessionID: 'ses_mode',
            prompt: { text: 'args' },
          });
          const text = submitted.at(-1)?.text;
          if (mode === 'full') {
            expect(text).toBe(
              buildSkillCommandPrompt('HOST_BODY', 'args', root),
            );
          } else {
            expect(text).toContain(JSON.stringify('mode-skill'));
            expect(text).not.toContain('HOST_BODY');
          }
          expect(readGeneratedSkillCommandNames()?.has('mode-skill')).toBe(
            true,
          );
          expect(host.count()).toBe(1);
        }
      }
      expect(host.calls.registrations).toBe(4);
      expect(host.calls.peak).toBe(1);
    } finally {
      await controller.dispose();
    }
  });
});

test('none commands do not enter visible-name bookkeeping or trigger replacement', async () => {
  const host = skillCommandHost();
  host.setSkills([
    { id: 'hidden', content: '---\nslim:\n  command: none\n---\nbody' },
    { id: 'visible' },
  ]);
  const controller = createSkillCommandController(host.ctx, []);
  try {
    await controller.refresh();
    await controller.refresh();
    expect([...host.replay().keys()]).toEqual(['visible']);
    expect([...(readGeneratedSkillCommandNames() ?? [])]).toEqual(['visible']);
    expect(host.calls.registrations).toBe(1);
  } finally {
    await controller.dispose();
  }
});

test('global none still discovers explicit per-skill overrides on refresh', async () => {
  const host = skillCommandHost();
  const controller = createSkillCommandController(host.ctx, [], 'none');
  try {
    await controller.refresh();
    expect(host.count()).toBe(0);
    host.setSkills([
      {
        id: 'override',
        content: '---\nslim:\n  command: reference\n---\nbody',
      },
    ]);
    await controller.refresh();
    expect([...host.replay().keys()]).toEqual(['override']);
  } finally {
    await controller.dispose();
  }
});

test('disk mode changes expose and preserve an earlier explicit collision', async () => {
  await withTmpDir(async (root) => {
    const host = skillCommandHost();
    const path = join(root, 'SKILL.md');
    writeFileSync(path, '---\nslim:\n  command: full\n---\nbody');
    host.setSkills([{ id: 'collision', path, content: 'HOST_BODY' }]);
    let explicitEnabled = false;
    const execute = async () => {};
    const explicit = await host.ctx.command.transform((draft) => {
      if (explicitEnabled) draft.add({ name: 'collision', execute });
    });
    const controller = createSkillCommandController(host.ctx, []);
    try {
      await controller.refresh();
      explicitEnabled = true;
      writeFileSync(path, '---\nslim:\n  command: none\n---\nbody');
      await controller.refresh();
      expect(host.replay().get('collision')?.execute).toBe(execute);
      expect(readGeneratedSkillCommandNames()?.has('collision') ?? false).toBe(
        false,
      );
      writeFileSync(path, '---\nslim:\n  command: reference\n---\nbody');
      await controller.refresh();
      expect(host.replay().get('collision')?.execute).toBe(execute);
    } finally {
      await controller.dispose();
      explicit.dispose();
    }
  });
});

test('unchanged command and exact source preserve the owned registration', async () => {
  const host = skillCommandHost();
  let disposals = 0;
  const transform = host.ctx.command.transform;
  host.ctx.command.transform = async (callback) => {
    const registration = await transform(callback);
    return {
      dispose: () => {
        disposals++;
        registration.dispose();
      },
    };
  };
  const skills = [{ id: 'report', path: '/skills/report/SKILL.md' }];
  host.setSkills(skills);
  const controller = createSkillCommandController(host.ctx, []);
  await controller.refresh();
  host.setSkills(skills.map((skill) => ({ ...skill })));
  controller.observeEvent({ type: 'skill.updated' });
  await controller.whenIdle();
  controller.observeEvent({ type: 'plugin.updated' });
  await controller.whenIdle();
  expect(host.calls.registrations).toBe(1);
  expect(disposals).toBe(0);
  expect([...host.replay().keys()]).toEqual(['report']);
  await controller.dispose();
  expect(disposals).toBe(1);
});

test.each([
  { id: 'report', path: '/other/report/SKILL.md' },
  { id: 'other', path: '/skills/report/SKILL.md' },
  {
    id: 'report',
    path: '/skills/report/SKILL.md',
    description: 'Updated description',
  },
  { id: 'report', path: '/skills/report/SKILL.md', content: 'Updated body' },
])('changed command metadata or source reconciles %j', async (skill) => {
  const host = skillCommandHost();
  host.setSkills([{ id: 'report', path: '/skills/report/SKILL.md' }]);
  const controller = createSkillCommandController(host.ctx, []);
  await controller.refresh();
  host.setSkills([skill]);
  await controller.refresh();
  expect(host.calls.registrations).toBe(2);
  expect(host.count()).toBe(1);
  expect([...host.replay().keys()]).toEqual([skill.id]);
  await controller.refresh();
  expect(host.calls.registrations).toBe(2);
  await controller.dispose();
});

test('observable explicit inventory changes reconcile otherwise identical skills', async () => {
  const host = skillCommandHost();
  let enabled = false;
  const execute = async () => {};
  await host.ctx.command.transform((draft) => {
    if (enabled) {
      draft.add({ name: 'report', execute });
      draft.add({ name: 'explicit', execute });
    }
  });
  const controller = createSkillCommandController(host.ctx, []);
  await controller.refresh();
  enabled = true;
  await controller.refresh();
  expect(host.calls.registrations).toBe(3);
  expect(host.replay().get('report')?.execute).toBe(execute);
  await controller.refresh();
  expect(host.calls.registrations).toBe(3);
  enabled = false;
  await controller.refresh();
  expect(host.calls.registrations).toBe(4);
  expect([...host.replay().keys()]).toEqual(['opencode', 'report']);
  await controller.dispose();
});

test('discovers filesystem skills registered after the two setup builtins', async () => {
  // Given: filesystem discovery happens after plugin setup returns.
  const host = skillCommandHost();
  const controller = createSkillCommandController(host.ctx, []);
  await controller.refresh();
  // When
  host.setSkills(
    [
      'opencode',
      'report',
      'show-me',
      ...Array.from({ length: 82 }, (_, i) => `skill-${i}`),
    ].map((id) => ({ id })),
  );
  controller.observeEvent({ type: 'skill.updated', data: {} });
  controller.observeEvent({ type: 'plugin.updated', data: {} });
  await controller.whenIdle();
  // Then
  expect(host.replay().has('show-me')).toBe(true);
  expect(host.replay().size).toBe(85);
  expect(host.calls.skills).toBe(2);
  expect(host.calls.peak).toBe(1);
  await controller.dispose();
});

test('refresh replaces metadata and removes deleted skills', async () => {
  // Given
  const host = skillCommandHost();
  const controller = createSkillCommandController(host.ctx, []);
  await controller.refresh();
  // When
  host.setSkills([{ id: 'report', description: 'Updated description' }]);
  controller.observeEvent({ type: 'skill.updated', data: {} });
  await controller.whenIdle();
  // Then
  expect([...host.replay().keys()]).toEqual(['report']);
  expect(host.replay().get('report')?.description).toBe('Updated description');
  expect(host.count()).toBe(1);
  await controller.dispose();
});

test('disposal exposes earlier explicit executor for a formerly generated name', async () => {
  // Given: an earlier transform later gains an explicit name hidden by ours.
  const host = skillCommandHost();
  let enabled = false;
  const execute = async () => {};
  await host.ctx.command.transform((draft) => {
    if (enabled) draft.add({ name: 'report', execute });
  });
  const controller = createSkillCommandController(host.ctx, ['reserved']);
  await controller.refresh();
  // When
  enabled = true;
  host.setSkills([{ id: 'report' }, { id: 'reserved' }]);
  controller.observeEvent({ type: 'plugin.updated', data: {} });
  await controller.whenIdle();
  // Then
  expect(host.replay().get('report')?.execute).toBe(execute);
  expect([...host.replay().keys()]).toEqual(['report']);
  await controller.dispose();
  expect(host.replay().get('report')?.execute).toBe(execute);
});

test.each([
  { type: 'command.updated', data: {} },
  {
    type: 'skill.updated',
    location: { directory: '/other', workspaceID: 'workspace' },
  },
  {
    type: 'plugin.updated',
    location: { directory: '/project', workspaceID: 'other' },
  },
  { type: 'skill.updated', location: { directory: '/project' } },
  { type: 'skill.updated', location: {} },
])('ignores foreign or self-triggering event %j', async (event) => {
  // Given
  const host = skillCommandHost();
  const controller = createSkillCommandController(host.ctx, []);
  await controller.refresh();
  // When
  controller.observeEvent(event);
  await controller.whenIdle();
  // Then
  expect(host.calls.skills).toBe(1);
  await controller.dispose();
});

test.each([undefined, { directory: '/project', workspaceID: 'workspace' }])(
  'accepts instance-local or matching scoped events %j',
  async (location) => {
    // Given
    const host = skillCommandHost();
    const controller = createSkillCommandController(host.ctx, []);
    // When
    controller.observeEvent({ type: 'skill.updated', location, data: {} });
    await controller.whenIdle();
    // Then
    expect(host.replay().size).toBe(2);
    await controller.dispose();
  },
);

test.each(['skill', 'command'] as const)(
  'invalid %s inventory removes stale generated commands',
  async (api) => {
    // Given
    const host = skillCommandHost();
    const controller = createSkillCommandController(host.ctx, []);
    await controller.refresh();
    host.ctx[api].list = async () => ({ data: [{}] });
    // When
    controller.observeEvent({ type: 'skill.updated', data: {} });
    await controller.whenIdle();
    // Then
    expect(host.count()).toBe(0);
    await controller.dispose();
  },
);

test.each(['skill', 'command', 'registration'] as const)(
  'recovers from rejected %s API on next event',
  async (api) => {
    // Given
    const host = skillCommandHost();
    const controller = createSkillCommandController(host.ctx, []);
    await controller.refresh();
    const list =
      api === 'command' ? host.ctx.command.list : host.ctx.skill.list;
    const transform = host.ctx.command.transform;
    const reject = async () => {
      throw new Error('Unavailable');
    };
    if (api === 'registration') {
      host.ctx.command.transform = reject;
      host.setSkills([{ id: 'changed' }]);
    } else host.ctx[api].list = reject;
    // When
    await controller.refresh();
    expect(host.count()).toBe(0);
    if (api === 'registration') host.ctx.command.transform = transform;
    else host.ctx[api].list = list;
    controller.observeEvent({ type: 'skill.updated', data: {} });
    await controller.whenIdle();
    // Then
    expect(host.count()).toBe(1);
    await controller.dispose();
  },
);

test('an unreadable skill body fails the inventory read without registering', async () => {
  // Given: a throwing inventory accessor invalidates the host snapshot,
  // independently of best-effort filesystem frontmatter reads.
  const host = skillCommandHost();
  host.setSkills([
    {
      id: 'show-me',
      get content() {
        throw new Error('Body read');
      },
    },
  ]);
  const controller = createSkillCommandController(host.ctx, []);
  // When
  await controller.refresh();
  // Then
  expect(host.replay().has('show-me')).toBe(false);
  await controller.dispose();
});

test.each([
  'skill',
  'skill.list',
  'command.list',
  'command.transform',
  'session.prompt',
] as const)(
  'unavailable %s capability leaves no generated registration',
  async (capability) => {
    // Given
    const host = skillCommandHost();
    const ctx = {
      ...host.ctx,
      skill:
        capability === 'skill'
          ? undefined
          : capability === 'skill.list'
            ? {}
            : host.ctx.skill,
      command:
        capability === 'command.list'
          ? { transform: host.ctx.command.transform }
          : capability === 'command.transform'
            ? { list: host.ctx.command.list }
            : host.ctx.command,
      session: capability === 'session.prompt' ? {} : host.ctx.session,
    };
    const controller = createSkillCommandController(ctx, []);
    // When
    await controller.refresh();
    // Then
    expect(host.count()).toBe(0);
    await controller.dispose();
  },
);
