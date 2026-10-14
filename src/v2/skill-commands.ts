import { dirname } from 'node:path';
import { z } from 'zod';
import { setGeneratedSkillCommandNames } from '../skill-command-lookup';
import {
  resolveSkillCommandMode,
  type SkillCommandMode,
} from '../skill-command-mode';
import {
  buildSkillCommandPrompt,
  buildSkillReferencePrompt,
} from '../skill-command-template';
import { log } from '../utils/logger';
import type { V2Context, V2Registration } from './types';

const commandListSchema = z.object({
  data: z.array(z.object({ name: z.string() })),
});
const skillListSchema = z.object({
  data: z.array(
    z.object({
      id: z.string().min(1),
      description: z.string().optional(),
      path: z.string().optional(),
      content: z.string().optional(),
    }),
  ),
});

type RegistryReader = { readonly list?: () => Promise<unknown> };

export type SkillCommandContext = {
  readonly location?: V2Context['location'];
  readonly skill?: RegistryReader;
  readonly command: RegistryReader &
    Partial<Pick<V2Context['command'], 'transform'>>;
  readonly session: Pick<V2Context['session'], 'prompt'>;
};

export type SkillCommandMetadata = Array<
  z.infer<typeof skillListSchema>['data'][number] & {
    readonly commandMode: SkillCommandMode;
  }
>;

/**
 * Directory CONTAINING SKILL.md. Supported hosts report the skill directory,
 * but slim registers bundled skills with the SKILL.md file path, so a file
 * tail must be stripped rather than emitted as a base directory.
 */
function skillBaseDirectory(path: string | undefined): string | undefined {
  if (path === undefined || path === '') return undefined;
  return path.endsWith('.md') ? dirname(path) : path;
}

export async function readSkillMetadata(
  skill: RegistryReader | undefined,
  globalMode?: SkillCommandMode,
): Promise<SkillCommandMetadata | undefined> {
  if (typeof skill?.list !== 'function') return undefined;
  try {
    return skillListSchema.parse(await skill.list()).data.map((entry) => ({
      ...entry,
      commandMode: resolveSkillCommandMode(entry, globalMode),
    }));
  } catch {
    log('[v2] skill commands unavailable: skill inventory failed');
    return undefined;
  }
}

/** Unknown inventory means no generic commands: add-only drafts cannot check
 * collisions, and overwriting an unseen explicit command is unsafe. */
export async function readCommandNames(
  command: RegistryReader,
): Promise<ReadonlySet<string> | undefined> {
  if (typeof command?.list !== 'function') return undefined;
  try {
    const snapshot = commandListSchema.parse(await command.list());
    return new Set(snapshot.data.map((entry) => entry.name));
  } catch {
    // Optional host capability boundary; never log registry contents/errors.
    log('[v2] skill commands unavailable: command inventory failed');
    return undefined;
  }
}

export async function registerSkillCommands(
  ctx: SkillCommandContext,
  reservedNames: readonly string[],
  globalMode?: SkillCommandMode,
): Promise<V2Registration | undefined> {
  const snapshot = await readSkillMetadata(ctx.skill, globalMode);
  if (!snapshot) return undefined;
  const hostNames = await readCommandNames(ctx.command);
  if (!hostNames) return undefined;
  return registerSkillCommandMetadata(
    ctx,
    [...hostNames, ...reservedNames],
    snapshot,
  );
}

/** Register already parsed metadata against a freshly read collision set. */
export async function registerSkillCommandMetadata(
  ctx: SkillCommandContext,
  reservedNames: readonly string[],
  snapshot: SkillCommandMetadata,
): Promise<V2Registration | undefined> {
  if (
    typeof ctx.command?.transform !== 'function' ||
    typeof ctx.session.prompt !== 'function'
  )
    return undefined;

  try {
    const reserved = new Set(reservedNames);
    const skills = snapshot.filter(({ id, commandMode }) => {
      if (reserved.has(id)) return false;
      reserved.add(id);
      return commandMode !== 'none';
    });
    if (skills.length === 0) return undefined;
    const prompt = ctx.session.prompt.bind(ctx.session);
    const registration = await ctx.command.transform((draft) => {
      for (const skill of skills) {
        const baseDirectory = skillBaseDirectory(skill.path);
        draft.add({
          name: skill.id,
          ...(skill.description === undefined
            ? {}
            : { description: skill.description }),
          execute: async (invocation) => {
            // No host $ARGUMENTS substitution on v2; keep invocation fields intact.
            await prompt({
              ...invocation.prompt,
              sessionID: invocation.sessionID,
              delivery: invocation.delivery,
              text:
                skill.commandMode === 'reference'
                  ? buildSkillReferencePrompt(skill.id, invocation.prompt.text)
                  : buildSkillCommandPrompt(
                      skill.content ?? '',
                      invocation.prompt.text,
                      baseDirectory,
                    ),
            });
          },
        });
      }
    });
    setGeneratedSkillCommandNames(skills.map(({ id }) => id));
    log('[v2] skill commands registered', {
      catalog: snapshot.length,
      generated: skills.length,
    });
    return registration;
  } catch {
    // Optional registry/registration failure must not disable explicit commands.
    log('[v2] skill commands unavailable: registration failed');
    return undefined;
  }
}
