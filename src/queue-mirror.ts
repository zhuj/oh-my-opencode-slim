import { randomUUID } from 'node:crypto';
import { renameSync } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { z } from 'zod';
import { getTuiStatePath } from './tui-state';
import type { BackgroundTaskQueueSnapshot } from './utils/background-task-concurrency';

const QUEUE_MIRROR_SCHEMA = 'oh-my-opencode-slim.queue-mirror';
const QUEUE_MIRROR_VERSION = 1;
const QUEUE_MIRROR_FILE = 'queue-state.json';
const QUEUE_MIRROR_ADMISSION_LIMIT = 5;
export const QUEUE_MIRROR_STALE_AFTER_MS = 30_000;

const QueueMirrorAdmissionSchema = z
  .object({
    id: z.string().min(1),
    state: z.union([z.literal('queued'), z.literal('postponed')]),
    queuePosition: z.number().int().positive().optional(),
    model: z.string().min(1).optional(),
    provider: z.string().min(1).optional(),
  })
  .strict()
  .readonly();

const QueueMirrorParentSchema = z
  .object({
    parentSessionID: z.string().min(1),
    paused: z.boolean(),
    totalQueued: z.number().int().nonnegative(),
    postponedCount: z.number().int().nonnegative(),
    admissions: z
      .array(QueueMirrorAdmissionSchema)
      .max(QUEUE_MIRROR_ADMISSION_LIMIT)
      .readonly(),
  })
  .strict()
  .readonly();

const QueueMirrorSnapshotSchema = z
  .object({
    schema: z.literal(QUEUE_MIRROR_SCHEMA),
    version: z.literal(QUEUE_MIRROR_VERSION),
    publisherID: z.string().min(1),
    runtimeID: z.string().min(1),
    revision: z.number().int().nonnegative(),
    updatedAt: z.number().finite().nonnegative(),
    parents: z.array(QueueMirrorParentSchema).readonly(),
  })
  .strict()
  .readonly();

export type QueueMirrorSnapshot = z.infer<typeof QueueMirrorSnapshotSchema>;

export type QueueMirrorProjectionInput = {
  readonly publisherID: string;
  readonly runtimeID: string;
  readonly revision: number;
  readonly updatedAt: number;
  readonly parents: readonly {
    readonly parentSessionID: string;
    readonly paused: boolean;
    readonly queue: readonly BackgroundTaskQueueSnapshot[];
  }[];
};

export type QueueMirrorReadResult =
  | { readonly kind: 'available'; readonly snapshot: QueueMirrorSnapshot }
  | {
      readonly kind: 'unavailable';
      readonly reason: 'missing' | 'malformed' | 'stale' | 'io';
    };

export type QueueMirrorWriteResult =
  | { readonly kind: 'written' }
  | { readonly kind: 'skipped' }
  | { readonly kind: 'failed'; readonly reason: string };

type QueueMirrorReadOptions = {
  readonly now?: () => number;
  readonly staleAfterMs?: number;
};

export type QueueMirrorWriteOptions = {
  readonly shouldCommit?: () => boolean;
};

export function getQueueMirrorPath(projectDirectory: string): string {
  return path.join(
    path.dirname(getTuiStatePath(projectDirectory)),
    QUEUE_MIRROR_FILE,
  );
}

export function projectQueueMirror(
  input: QueueMirrorProjectionInput,
): QueueMirrorSnapshot {
  return {
    schema: QUEUE_MIRROR_SCHEMA,
    version: QUEUE_MIRROR_VERSION,
    publisherID: input.publisherID,
    runtimeID: input.runtimeID,
    revision: input.revision,
    updatedAt: input.updatedAt,
    parents: input.parents.map((parent) => {
      const queued = parent.queue.filter(
        ({ record }) => record.state === 'queued',
      );
      const postponed = parent.queue.filter(
        ({ record }) => record.state === 'postponed',
      );
      return {
        parentSessionID: parent.parentSessionID,
        paused: parent.paused,
        totalQueued: queued.length,
        postponedCount: postponed.length,
        admissions: [...queued, ...postponed]
          .slice(0, QUEUE_MIRROR_ADMISSION_LIMIT)
          .map(({ record, queuePosition }) => ({
            id: record.id,
            state: record.state === 'queued' ? 'queued' : 'postponed',
            ...(queuePosition === undefined ? {} : { queuePosition }),
            ...(record.model === undefined ? {} : { model: record.model }),
            ...(record.provider === undefined
              ? {}
              : { provider: record.provider }),
          })),
      };
    }),
  };
}

export async function readQueueMirrorSnapshot(
  projectDirectory: string,
  options: QueueMirrorReadOptions = {},
): Promise<QueueMirrorReadResult> {
  let encoded: string;
  try {
    encoded = await fs.readFile(getQueueMirrorPath(projectDirectory), 'utf8');
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') {
      return { kind: 'unavailable', reason: 'missing' };
    }
    return { kind: 'unavailable', reason: 'io' };
  }

  let decoded: unknown;
  try {
    decoded = JSON.parse(encoded);
  } catch (error) {
    if (error instanceof SyntaxError) {
      return { kind: 'unavailable', reason: 'malformed' };
    }
    return { kind: 'unavailable', reason: 'io' };
  }

  const parsed = QueueMirrorSnapshotSchema.safeParse(decoded);
  if (!parsed.success) return { kind: 'unavailable', reason: 'malformed' };

  const now = options.now ?? Date.now;
  const staleAfterMs = options.staleAfterMs ?? QUEUE_MIRROR_STALE_AFTER_MS;
  if (now() - parsed.data.updatedAt > staleAfterMs) {
    return { kind: 'unavailable', reason: 'stale' };
  }
  return { kind: 'available', snapshot: parsed.data };
}

export async function writeQueueMirrorSnapshot(
  snapshot: QueueMirrorSnapshot,
  projectDirectory: string,
  options: QueueMirrorWriteOptions = {},
): Promise<QueueMirrorWriteResult> {
  const mirrorPath = getQueueMirrorPath(projectDirectory);
  const temporaryPath = `${mirrorPath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await fs.mkdir(path.dirname(mirrorPath), { recursive: true });
    await fs.writeFile(temporaryPath, `${JSON.stringify(snapshot)}\n`);
    if (options.shouldCommit && !options.shouldCommit()) {
      await fs.rm(temporaryPath, { force: true });
      return { kind: 'skipped' };
    }
    renameSync(temporaryPath, mirrorPath);
    return { kind: 'written' };
  } catch (error) {
    const reason = errorMessage(error);
    try {
      await fs.rm(temporaryPath, { force: true });
    } catch (cleanupError) {
      return {
        kind: 'failed',
        reason: `${reason}; cleanup failed: ${errorMessage(cleanupError)}`,
      };
    }
    return { kind: 'failed', reason };
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
