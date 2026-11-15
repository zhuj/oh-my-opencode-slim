import type { V2CommandDefinition, V2CommandDraft } from './types';

/** Add-only, ordered, last-wins transforms like the supported host. */
export function skillCommandHost() {
  const transforms = new Set<(draft: V2CommandDraft) => void>();
  let skillData: unknown = [{ id: 'opencode' }, { id: 'report' }];
  const calls = { skills: 0, commands: 0, registrations: 0, peak: 0 };
  const replay = () => {
    const result = new Map<string, V2CommandDefinition>();
    for (const transform of transforms)
      transform({ add: (entry) => result.set(entry.name, entry) });
    return result;
  };
  const ctx = {
    location: { directory: '/project', workspaceID: 'workspace' },
    skill: {
      list: async (): Promise<unknown> => {
        calls.skills++;
        return { location: ctx.location, data: skillData };
      },
    },
    command: {
      list: async (): Promise<unknown> => {
        calls.commands++;
        return { location: ctx.location, data: [...replay().values()] };
      },
      transform: async (transform: (draft: V2CommandDraft) => void) => {
        transforms.add(transform);
        calls.registrations++;
        calls.peak = Math.max(calls.peak, transforms.size);
        return {
          dispose: () => {
            transforms.delete(transform);
          },
        };
      },
    },
    session: { prompt: async () => {} },
  };
  return {
    ctx,
    calls,
    replay,
    count: () => transforms.size,
    setSkills: (data: unknown) => {
      skillData = data;
    },
  };
}
