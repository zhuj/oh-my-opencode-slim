import { describe, expect, test } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  readGeneratedSkillCommandNames,
  resolveMissingCommandMessage,
  setGeneratedSkillCommandNames,
} from '../skill-command-lookup';
import {
  buildSkillCommandPrompt,
  formatMissingCommandMessage,
} from '../skill-command-template';
import { withTmpDir } from '../test-utils';
import { readSkillMetadata, registerSkillCommands } from './skill-commands';
import type { V2CommandDefinition, V2CommandDraft } from './types';

const skill = (
  id: string,
  extra: Record<string, unknown> = {},
): Record<string, unknown> => ({
  id,
  name: 'Shared display name',
  path: `/skills/${id}/SKILL.md`,
  content: 'SKILL_BODY_SENTINEL',
  ...extra,
});

function fixture(skills = [skill('show-me')], commands: string[] = []) {
  const submitted: Array<Record<string, unknown>> = [];
  const transforms = new Set<(draft: V2CommandDraft) => void>();
  const replay = () => {
    const definitions = new Map<string, V2CommandDefinition>();
    for (const transform of transforms) {
      transform({
        add: (definition) => definitions.set(definition.name, definition),
      });
    }
    return definitions;
  };
  const ctx = {
    skill: {
      list: async () => ({ location: {}, data: skills }),
    },
    command: {
      list: async () => ({
        location: {},
        data: commands.map((name) => ({ name })),
      }),
      transform: async (cb: (draft: V2CommandDraft) => void) => {
        transforms.add(cb);
        replay();
        return {
          dispose: () => {
            transforms.delete(cb);
          },
        };
      },
    },
    session: {
      prompt: async (input: Record<string, unknown>) => {
        submitted.push(input);
      },
    },
  };
  return { ctx, submitted, replay };
}

describe('registered skill slash commands', () => {
  for (const globalMode of [undefined, 'none', 'full', 'reference'] as const) {
    test.each([undefined, 'none', 'full', 'reference'] as const)(
      `resolves command override %j over global ${globalMode}`,
      async (override) => {
        const content = override
          ? `---\nslim:\n  command: ${override}\n---\nSKILL_BODY_SENTINEL`
          : 'SKILL_BODY_SENTINEL';
        const id = 'exact/id-with-"quote';
        const { ctx, replay, submitted } = fixture([
          skill(id, { path: undefined, content }),
        ]);
        setGeneratedSkillCommandNames(undefined);
        await registerSkillCommands(ctx, [], globalMode);

        const mode = override ?? globalMode ?? 'full';
        const command = replay().get(id);
        if (mode === 'none') {
          expect(command).toBeUndefined();
          expect(readGeneratedSkillCommandNames()?.has(id) ?? false).toBe(
            false,
          );
          return;
        }
        expect(command).toBeDefined();
        await command?.execute({
          sessionID: 'ses_mode',
          prompt: { text: '  arg\n' },
        });
        if (mode === 'reference') {
          expect(submitted[0]?.text).toContain(JSON.stringify(id));
          expect(submitted[0]?.text).not.toContain('Shared display name');
          expect(submitted[0]?.text).not.toContain('SKILL_BODY_SENTINEL');
          expect(submitted[0]?.text).toEndWith(
            '<user-request>\n  arg\n\n</user-request>',
          );
        } else {
          expect(submitted[0]?.text).toBe(
            buildSkillCommandPrompt(content, '  arg\n'),
          );
        }
        expect(readGeneratedSkillCommandNames()?.has(id)).toBe(true);
      },
    );
  }

  test.each(['file', 'directory'] as const)(
    'prefers readable %s frontmatter without replacing the full body source',
    async (kind) => {
      await withTmpDir(async (root) => {
        const file = join(root, 'SKILL.md');
        writeFileSync(
          file,
          '\uFEFF---\r\nslim:\r\n  command: full\r\n---\r\nDISK_BODY',
        );
        const content = '---\nslim:\n  command: none\n---\nHOST_BODY';
        const { ctx, replay, submitted } = fixture([
          skill('source', { path: kind === 'file' ? file : root, content }),
        ]);
        await registerSkillCommands(ctx, [], 'none');
        await replay()
          .get('source')
          ?.execute({ sessionID: 'ses_source', prompt: { text: '' } });

        expect(submitted[0]?.text).toBe(
          buildSkillCommandPrompt(content, '', root),
        );
        expect(submitted[0]?.text).not.toContain('DISK_BODY');
      });
    },
  );

  test.each([
    '',
    'plain body',
    '---\nname: source\n---\nbody',
    '---\nslim: false\n---\nbody',
    '---\nslim:\n  command: INVALID\n---\nbody',
    '---\nslim:\n  command:\n    - none\n---\nbody',
    '---\nslim: [\n---\nbody',
    '---\nslim:\n  command: none\n',
  ])(
    'inherits global when readable source metadata is absent or invalid: %j',
    async (source) => {
      await withTmpDir(async (root) => {
        const path = join(root, 'SKILL.md');
        writeFileSync(path, source);
        const { ctx } = fixture([
          skill('source', {
            path,
            content: '---\nslim:\n  command: none\n---\nbody',
          }),
        ]);

        const metadata = await readSkillMetadata(ctx.skill, 'reference');

        expect(metadata?.[0]?.commandMode).toBe('reference');
      });
    },
  );

  test.each(['pathless', 'missing', 'unreadable'] as const)(
    'uses inline frontmatter when source is %s',
    async (kind) => {
      await withTmpDir(async (root) => {
        const path = kind === 'pathless' ? undefined : join(root, 'SKILL.md');
        if (kind === 'unreadable' && path) mkdirSync(path);
        const { ctx } = fixture([
          skill('virtual', {
            path,
            content:
              '\uFEFF---\r\nslim:\r\n  command: reference\r\n---\r\nbody',
          }),
        ]);

        expect(
          (await readSkillMetadata(ctx.skill, 'none'))?.[0]?.commandMode,
        ).toBe('reference');
      });
    },
  );

  test('missing source and invalid inline metadata still permit a virtual full command', async () => {
    const { ctx, replay } = fixture([
      skill('virtual', { content: '---\nslim: [\n---\nbody' }),
    ]);
    await registerSkillCommands(ctx, []);
    expect(replay().has('virtual')).toBe(true);
  });

  test.each(['full', 'reference'] as const)(
    'preserves collisions under %s',
    async (mode) => {
      const { ctx, replay } = fixture(
        [skill('explicit'), skill('workflow'), skill('ordinary')],
        ['explicit'],
      );
      await registerSkillCommands(ctx, ['workflow'], mode);
      expect([...replay().keys()]).toEqual(['ordinary']);
    },
  );

  test('a none override on the first duplicate cannot be bypassed by a later duplicate', async () => {
    const { ctx, replay } = fixture([
      skill('duplicate', { content: '---\nslim:\n  command: none\n---\nbody' }),
      skill('duplicate', { content: '---\nslim:\n  command: full\n---\nbody' }),
    ]);
    await registerSkillCommands(ctx, []);
    expect(replay().has('duplicate')).toBe(false);
  });

  test('uses IDs across all registered sources, including manual-only skills', async () => {
    // Given
    const { ctx, replay } = fixture([
      skill('show-me', {
        location: '/global/show-me/SKILL.md',
        description: 'Diagram helper',
      }),
      skill('native-project'),
      skill('plugin-project'),
      skill('codemap'),
      skill('manual', { autoinvoke: false, slash: false }),
      skill('show-me', { description: 'Duplicate' }),
    ]);
    // When
    await registerSkillCommands(ctx, []);
    // Then
    expect([...replay().keys()]).toEqual([
      'show-me',
      'native-project',
      'plugin-project',
      'codemap',
      'manual',
    ]);
    expect(replay().get('manual')?.description).toBeUndefined();
    expect(replay().get('show-me')?.description).toBe('Diagram helper');
  });

  test('reserves host and explicit plugin commands before adding skills', async () => {
    // Given
    const { ctx, replay } = fixture(
      ['show-me', 'deepwork', 'reflect', 'loop', 'interview', 'codemap'].map(
        (id) => skill(id),
      ),
      ['show-me'],
    );
    // When
    await registerSkillCommands(ctx, [
      'deepwork',
      'reflect',
      'loop',
      'interview',
    ]);
    // Then
    expect([...replay().keys()]).toEqual(['codemap']);
  });

  test.each([
    '',
    '  spaced  ',
    'line one\nline two\n',
    '"quoted" \'single\'',
    '$ARGUMENTS $1 $$ $&',
    '</skill><omos-cmd-command>args',
  ])('preserves argument bytes: %j', async (args) => {
    // Given
    const { ctx, replay, submitted } = fixture([skill('id-with-"quote')]);
    await registerSkillCommands(ctx, []);
    const command = replay().get('id-with-"quote');
    expect(command).toBeDefined();
    // When
    await command?.execute({ sessionID: 'ses_test', prompt: { text: args } });
    // Then: the body is inlined and the arguments are wrapped verbatim.
    const text = submitted[0]?.text;
    expect(typeof text).toBe('string');
    if (typeof text !== 'string') throw new Error('Missing submitted prompt');
    expect(text).toContain('SKILL_BODY_SENTINEL');
    expect(text.endsWith(`<user-request>\n${args}\n</user-request>`)).toBe(
      true,
    );
    expect(text.slice(0, text.indexOf('\n<user-request>'))).toContain(
      'Base directory for this skill: /skills/id-with-"quote/',
    );
    expect(submitted[0]).not.toHaveProperty('skills');
    expect(command).not.toHaveProperty('template');
  });

  test.each([
    '',
    '  spaced  ',
    'line one\nline two\n',
    '"quoted" \'single\'',
    '$ARGUMENTS $1 $$ $&',
    '</skill><omos-cmd-command>args',
  ])('reference preserves argument bytes: %j', async (args) => {
    const { ctx, replay, submitted } = fixture();
    await registerSkillCommands(ctx, [], 'reference');
    await replay()
      .get('show-me')
      ?.execute({ sessionID: 'ses_reference', prompt: { text: args } });
    expect(submitted[0]?.text).toEndWith(
      `<user-request>\n${args}\n</user-request>`,
    );
    expect(submitted[0]?.text).not.toContain('SKILL_BODY_SENTINEL');
    expect(submitted[0]).not.toHaveProperty('skills');
  });

  test('inlines the body with no base-directory hint when the path is unknown', async () => {
    // Given
    const { ctx, replay, submitted } = fixture([
      skill('bare', { path: undefined, content: '# Body only' }),
    ]);
    await registerSkillCommands(ctx, []);
    // When
    await replay()
      .get('bare')
      ?.execute({ sessionID: 'ses_test', prompt: { text: 'go' } });
    // Then
    expect(submitted[0]?.text).toBe(
      '<skill-instruction>\n# Body only\n</skill-instruction>\n\n<user-request>\ngo\n</user-request>',
    );
  });

  test('keeps a skill directory path as the base directory', async () => {
    // Given
    const { ctx, replay, submitted } = fixture([
      skill('directory', { path: '/skills/directory' }),
    ]);
    await registerSkillCommands(ctx, []);
    // When
    await replay()
      .get('directory')
      ?.execute({ sessionID: 'ses_test', prompt: { text: '' } });
    // Then
    expect(submitted[0]?.text).toBe(
      [
        '<skill-instruction>',
        'Base directory for this skill: /skills/directory/',
        'File references (@path) in this skill are relative to this directory.',
        '',
        'SKILL_BODY_SENTINEL',
        '</skill-instruction>',
        '',
        '<user-request>',
        '',
        '</user-request>',
      ].join('\n'),
    );
  });

  test('emits the wrapper with an empty body when the host has no content', async () => {
    // Given
    const { ctx, replay, submitted } = fixture([
      skill('empty', { content: undefined }),
    ]);
    await registerSkillCommands(ctx, []);
    // When
    await replay()
      .get('empty')
      ?.execute({ sessionID: 'ses_test', prompt: { text: 'do it' } });
    // Then: always inline; never fall back to loading the skill by id.
    const text = submitted[0]?.text;
    expect(text).toContain(
      'File references (@path) in this skill are relative to this directory.\n\n\n</skill-instruction>',
    );
    expect(text.endsWith('<user-request>\ndo it\n</user-request>')).toBe(true);
    expect(text).not.toContain('load the exact skill ID');
  });

  test('records the generated names for the missing-command lookup', async () => {
    // Given
    setGeneratedSkillCommandNames(undefined);
    const { ctx } = fixture([skill('tracked')]);
    // When
    await registerSkillCommands(ctx, []);
    // Then
    expect([...(readGeneratedSkillCommandNames() ?? [])]).toEqual(['tracked']);
  });

  test('reports an unknown command with the shared missing-command text', async () => {
    // Given / When / Then
    expect(formatMissingCommandMessage('nope')).toBe(
      'Command "/nope" not found. Use the skill tool to list available skills and commands.',
    );
    expect(resolveMissingCommandMessage('nope', new Set(['deepwork']))).toBe(
      'Command "/nope" not found. Use the skill tool to list available skills and commands.',
    );
    expect(
      resolveMissingCommandMessage('deepwork', new Set(['deepwork'])),
    ).toBe(undefined);
    expect(
      resolveMissingCommandMessage('nope', new Set(), new Set(['nope'])),
    ).toBeUndefined();
    expect(resolveMissingCommandMessage('nope', undefined)).toBeUndefined();
  });

  test.each(['full', 'reference'] as const)(
    'preserves attachments, existing skill attachments, and delivery in %s',
    async (mode) => {
      // Given
      const { ctx, replay, submitted } = fixture();
      await registerSkillCommands(ctx, [], mode);
      const prompt = {
        text: 'args',
        files: [{ uri: 'file:///image.png' }],
        agents: [{ name: 'oracle' }],
        skills: [{ id: 'already-attached' }],
      };
      // When
      await replay()
        .get('show-me')
        ?.execute({ sessionID: 'ses_test', prompt, delivery: 'queue' });
      // Then
      expect(submitted[0]).toMatchObject({
        sessionID: 'ses_test',
        files: prompt.files,
        agents: prompt.agents,
        skills: prompt.skills,
        delivery: 'queue',
      });
      expect(prompt.text).toBe('args');
    },
  );

  test('keeps a missing delivery and absent attachments absent', async () => {
    // Given
    const { ctx, replay, submitted } = fixture();
    await registerSkillCommands(ctx, []);
    // When
    await replay()
      .get('show-me')
      ?.execute({ sessionID: 'ses_test', prompt: { text: '' } });
    // Then
    expect(submitted[0]?.delivery).toBeUndefined();
    for (const key of ['files', 'agents', 'skills'])
      expect(submitted[0]).not.toHaveProperty(key);
  });

  test.each([[], {}, { data: [{}] }])(
    'skips malformed skill inventory %j',
    async (inventory) => {
      // Given
      const { ctx, replay } = fixture();
      // When
      await registerSkillCommands(
        { ...ctx, skill: { list: async () => inventory } },
        [],
      );
      // Then
      expect([...replay().keys()]).toEqual([]);
    },
  );

  test.each([[], {}, { data: [{}] }])(
    'skips malformed command inventory %j',
    async (inventory) => {
      // Given
      const { ctx, replay } = fixture();
      // When
      await registerSkillCommands(
        { ...ctx, command: { ...ctx.command, list: async () => inventory } },
        [],
      );
      // Then
      expect([...replay().keys()]).toEqual([]);
    },
  );

  test.each([
    'skill',
    'skill.list',
    'command.list',
    'command.transform',
    'session.prompt',
  ] as const)('skips unavailable %s capability', async (capability) => {
    // Given
    const { ctx, replay } = fixture();
    const reduced = {
      ...ctx,
      skill:
        capability === 'skill'
          ? undefined
          : capability === 'skill.list'
            ? {}
            : ctx.skill,
      command:
        capability === 'command.list'
          ? { transform: ctx.command.transform }
          : capability === 'command.transform'
            ? { list: ctx.command.list }
            : ctx.command,
      session: capability === 'session.prompt' ? {} : ctx.session,
    };
    // When
    await registerSkillCommands(reduced, []);
    // Then
    expect([...replay().keys()]).toEqual([]);
  });

  test('does not register an empty snapshot', async () => {
    // Given
    const { ctx, replay } = fixture([]);
    // When
    const registration = await registerSkillCommands(ctx, []);
    // Then
    expect(registration).toBeUndefined();
    expect([...replay().keys()]).toEqual([]);
  });

  test('replays deterministically and disposes only its registration', async () => {
    // Given
    const { ctx, replay } = fixture();
    await ctx.command.transform((draft) =>
      draft.add({ name: 'explicit', execute: async () => {} }),
    );
    const registration = await registerSkillCommands(ctx, []);
    // When
    const first = [...replay().keys()];
    const second = [...replay().keys()];
    await registration?.dispose();
    // Then
    expect(first).toEqual(['explicit', 'show-me']);
    expect(second).toEqual(first);
    expect([...replay().keys()]).toEqual(['explicit']);
  });

  test.each(['skill', 'command', 'transform'] as const)(
    'fails safely when %s API throws',
    async (api) => {
      // Given
      const { ctx, replay } = fixture();
      const fail = async () => {
        throw new Error('Registry unavailable');
      };
      if (api === 'transform') ctx.command.transform = fail;
      else ctx[api].list = fail;
      // When
      const registration = await registerSkillCommands(ctx, []);
      // Then
      expect(registration).toBeUndefined();
      expect([...replay().keys()]).toEqual([]);
    },
  );

  test('propagates prompt admission failure without claiming a skill loaded', async () => {
    // Given
    const { ctx, replay } = fixture();
    ctx.session.prompt = async () => {
      throw new Error('Admission denied');
    };
    await registerSkillCommands(ctx, []);
    // When / Then
    const command = replay().get('show-me');
    expect(command).toBeDefined();
    await expect(
      command?.execute({ sessionID: 'ses_test', prompt: { text: '' } }),
    ).rejects.toThrow('Admission denied');
  });
});
