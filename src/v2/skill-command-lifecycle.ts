import { z } from 'zod';
import { setGeneratedSkillCommandNames } from '../skill-command-lookup';
import type { SkillCommandMode } from '../skill-command-mode';
import { log } from '../utils/logger';
import {
  readCommandNames,
  readSkillMetadata,
  registerSkillCommandMetadata,
  type SkillCommandContext,
  type SkillCommandMetadata,
} from './skill-commands';
import type { V2Registration } from './types';

const invalidationSchema = z.object({
  type: z.enum(['skill.updated', 'plugin.updated']),
  location: z
    .object({ directory: z.string(), workspaceID: z.string().optional() })
    .optional(),
});

/** One owned transform, serialized refreshes, and no activation wait in setup. */
export function createSkillCommandController(
  ctx: SkillCommandContext,
  reservedNames: readonly string[],
  globalMode?: SkillCommandMode,
) {
  let registration: V2Registration | undefined;
  let inventory:
    | {
        metadata: string;
        visibleNames: ReadonlySet<string>;
        explicitNames: ReadonlySet<string>;
      }
    | undefined;
  let running: Promise<void> | undefined;
  let dirty = false;
  let stopped = false;

  function effectiveSkills(
    metadata: SkillCommandMetadata,
    explicitNames: ReadonlySet<string>,
  ) {
    const reserved = new Set([...explicitNames, ...reservedNames]);
    return metadata
      .filter(({ id, commandMode }) => {
        if (reserved.has(id)) return false;
        reserved.add(id);
        return commandMode !== 'none';
      })
      .sort((a, b) => a.id.localeCompare(b.id));
  }

  async function reconcile() {
    const metadata = await readSkillMetadata(ctx.skill, globalMode);
    if (stopped) return;
    let readable = true;
    if (registration && inventory && metadata) {
      const names = await readCommandNames(ctx.command);
      if (stopped) return;
      readable = names !== undefined;
      const visibleNames = inventory.visibleNames;
      // Hidden same-name explicit additions wait for an observable change:
      // the add-only registry cannot expose them without disposing our transform.
      if (
        names &&
        names.size === visibleNames.size &&
        [...names].every((name) => visibleNames.has(name)) &&
        JSON.stringify(effectiveSkills(metadata, inventory.explicitNames)) ===
          inventory.metadata
      )
        return;
    }
    // Removing our transform exposes earlier explicit definitions. A set of
    // formerly generated names cannot distinguish those definitions from ours.
    await registration?.dispose();
    registration = undefined;
    inventory = undefined;
    setGeneratedSkillCommandNames(undefined);
    if (stopped || !metadata || !readable) return;
    const names = await readCommandNames(ctx.command);
    if (stopped || !names) return;
    registration = await registerSkillCommandMetadata(
      ctx,
      [...names, ...reservedNames],
      metadata,
    );
    if (registration) {
      const skills = effectiveSkills(metadata, names);
      inventory = {
        metadata: JSON.stringify(skills),
        visibleNames: new Set([...names, ...skills.map(({ id }) => id)]),
        explicitNames: names,
      };
    }
  }

  function refresh(): Promise<void> {
    if (stopped) return Promise.resolve();
    dirty = true;
    if (!running) {
      running = Promise.resolve().then(async () => {
        try {
          while (dirty && !stopped) {
            dirty = false;
            try {
              await reconcile();
            } catch {
              // Optional boundary: preserve explicit commands, never log bodies.
              log('[v2] skill command reconciliation failed');
            }
          }
        } finally {
          running = undefined;
        }
      });
    }
    return running;
  }

  function stop() {
    stopped = true;
    dirty = false;
  }

  return {
    refresh,
    whenIdle: () => running ?? Promise.resolve(),
    stop,
    observeEvent(event: unknown): void {
      const parsed = invalidationSchema.safeParse(event);
      if (!parsed.success) return;
      const location = parsed.data.location;
      if (
        location &&
        (location.directory !== ctx.location?.directory ||
          location.workspaceID !== ctx.location?.workspaceID)
      )
        return;
      void refresh();
    },
    async dispose(): Promise<void> {
      stop();
      await running;
      await registration?.dispose();
      registration = undefined;
      inventory = undefined;
      setGeneratedSkillCommandNames(undefined);
    },
  };
}
