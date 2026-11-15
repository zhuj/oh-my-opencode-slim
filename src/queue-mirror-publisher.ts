import { unlinkSync } from 'node:fs';
import {
  getQueueMirrorPath,
  projectQueueMirror,
  type QueueMirrorSnapshot,
  type QueueMirrorWriteOptions,
  type QueueMirrorWriteResult,
  writeQueueMirrorSnapshot,
} from './queue-mirror';
import type { BackgroundTaskQueueSnapshot } from './utils/background-task-concurrency';

export interface QueueMirrorPublisherSource {
  listParentSessionIDs(): readonly string[];
  listQueue(parentSessionID: string): readonly BackgroundTaskQueueSnapshot[];
  isAdmissionPaused(parentSessionID: string): boolean;
}

type QueueMirrorWriter = (
  snapshot: QueueMirrorSnapshot,
  projectDirectory: string,
  options: QueueMirrorWriteOptions,
) => Promise<QueueMirrorWriteResult>;

type QueueMirrorPublisherOptions = {
  readonly projectDirectory: string;
  readonly publisherID: string;
  readonly runtimeID: string;
  readonly source: QueueMirrorPublisherSource;
  readonly heartbeatMs?: number;
  readonly now?: () => number;
  readonly write?: QueueMirrorWriter;
  readonly remove?: (projectDirectory: string) => void;
  readonly isCurrent?: () => boolean;
  readonly scheduleHeartbeat?: (
    callback: () => void,
    intervalMs: number,
  ) => () => void;
};

export interface QueueMirrorPublisher {
  notify(): void;
  flush(): Promise<void>;
  dispose(): void;
}

const DEFAULT_HEARTBEAT_MS = 10_000;

export function createQueueMirrorPublisher(
  options: QueueMirrorPublisherOptions,
): QueueMirrorPublisher {
  const now = options.now ?? Date.now;
  const write = options.write ?? writeQueueMirrorSnapshot;
  const remove = options.remove ?? removeQueueMirror;
  const isCurrent = options.isCurrent ?? (() => true);
  const heartbeatMs = options.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;
  const scheduleHeartbeat =
    options.scheduleHeartbeat ?? scheduleQueueMirrorHeartbeat;
  let revision = 0;
  let requested = false;
  let disposed = false;
  let running: Promise<void> | undefined;

  const notify = (): void => {
    if (disposed) return;
    requested = true;
    running ??= drain();
  };

  const cancelHeartbeat =
    heartbeatMs > 0 ? scheduleHeartbeat(notify, heartbeatMs) : undefined;

  async function drain(): Promise<void> {
    await Promise.resolve();
    while (requested && !disposed) {
      requested = false;
      revision += 1;
      const snapshot = projectQueueMirror({
        publisherID: options.publisherID,
        runtimeID: options.runtimeID,
        revision,
        updatedAt: now(),
        parents: [...new Set(options.source.listParentSessionIDs())].map(
          (parentSessionID) => ({
            parentSessionID,
            paused: options.source.isAdmissionPaused(parentSessionID),
            queue: options.source.listQueue(parentSessionID),
          }),
        ),
      });
      try {
        await write(snapshot, options.projectDirectory, {
          shouldCommit: () => !disposed && isCurrent(),
        });
      } catch (error) {
        if (error instanceof Error) continue;
      }
    }
    running = undefined;
  }

  return {
    notify,
    flush: async () => {
      await running;
    },
    dispose: () => {
      if (disposed) return;
      disposed = true;
      requested = false;
      cancelHeartbeat?.();
      if (!isCurrent()) return;
      try {
        remove(options.projectDirectory);
      } catch (error) {
        if (error instanceof Error) return;
      }
    },
  };
}

function scheduleQueueMirrorHeartbeat(
  callback: () => void,
  intervalMs: number,
): () => void {
  const timer = setInterval(callback, intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}

function removeQueueMirror(projectDirectory: string): void {
  try {
    unlinkSync(getQueueMirrorPath(projectDirectory));
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') return;
    if (error instanceof Error) return;
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}
