import { createHash, randomUUID } from 'node:crypto';
import {
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';

export interface BackgroundJobSnapshot {
  version: 1;
  rootSessionID: string;
  updatedAt: number;
  records: Record<string, unknown>;
}

export interface BackgroundJobSnapshotMutation {
  upsert: readonly Record<string, unknown>[];
  removeTaskIDs: readonly string[];
}

export interface BackgroundJobSnapshotStore {
  readRoot(rootSessionID: string): Promise<BackgroundJobSnapshot | undefined>;
  readAll(): Promise<BackgroundJobSnapshot[]>;
  applyMutation(
    rootSessionID: string,
    mutation: BackgroundJobSnapshotMutation,
    updatedAt: number,
  ): Promise<void>;
  removeRoot(rootSessionID: string): Promise<void>;
}

const LOCK_TIMEOUT_MS = 5_000;
const LOCK_RETRY_MS = 10;

interface SnapshotStoreOptions {
  lockTimeoutMs?: number;
  atomicReplace?: (temporary: string, target: string) => Promise<void>;
  initializeOwner?: (path: string, contents: string) => Promise<void>;
}

function isSnapshot(
  value: unknown,
  rootSessionID?: string,
): value is BackgroundJobSnapshot {
  if (!value || typeof value !== 'object') return false;
  const snapshot = value as Partial<BackgroundJobSnapshot>;
  return (
    snapshot.version === 1 &&
    typeof snapshot.rootSessionID === 'string' &&
    (rootSessionID === undefined || snapshot.rootSessionID === rootSessionID) &&
    typeof snapshot.updatedAt === 'number' &&
    Number.isFinite(snapshot.updatedAt) &&
    !!snapshot.records &&
    typeof snapshot.records === 'object' &&
    !Array.isArray(snapshot.records)
  );
}

export function createBackgroundJobSnapshotStore(
  projectDir: string,
  options: SnapshotStoreOptions = {},
): BackgroundJobSnapshotStore {
  const directory = join(projectDir, '.local', '.slim', 'background-jobs');
  const pathFor = (root: string) =>
    join(directory, `${createHash('sha256').update(root).digest('hex')}.json`);

  async function readPath(
    path: string,
    root: string,
  ): Promise<BackgroundJobSnapshot | undefined> {
    let text: string;
    try {
      text = await readFile(path, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
    const parsed: unknown = JSON.parse(text);
    if (!isSnapshot(parsed, root))
      throw new Error(
        `Invalid or mismatched background-job snapshot for ${root}`,
      );
    return parsed;
  }

  async function withLock<T>(
    root: string,
    action: () => Promise<T>,
  ): Promise<T> {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const lockPath = `${pathFor(root)}.lock`;
    const deadline = Date.now() + (options.lockTimeoutMs ?? LOCK_TIMEOUT_MS);
    let token = '';
    while (!token) {
      try {
        await mkdir(lockPath, { mode: 0o700 });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        // Lock exists: wait within bounded timeout; never delete/rename
        // any lock owner regardless of age, PID, or format.
        if (Date.now() >= deadline) {
          throw new Error(`Timed out acquiring snapshot lock for ${root}`);
        }
        await new Promise((resolve) => setTimeout(resolve, LOCK_RETRY_MS));
        continue;
      }
      token = randomUUID();
      try {
        await (
          options.initializeOwner ??
          ((pth, contents) => writeFile(pth, contents, { mode: 0o600 }))
        )(
          join(lockPath, 'owner'),
          JSON.stringify({ token, pid: process.pid, createdAt: Date.now() }),
        );
      } catch (error) {
        try {
          await rm(lockPath, { recursive: true, force: true });
        } catch {
          /* Preserve the owner initialization error; contention remains bounded. */
        }
        throw error;
      }
    }
    try {
      return await action();
    } finally {
      try {
        const owner = JSON.parse(
          await readFile(join(lockPath, 'owner'), 'utf8'),
        ) as { token?: string; pid?: number; createdAt?: number };
        if (owner.token === token) {
          await rm(lockPath, { recursive: true, force: true });
        }
        // If ownership is different or unreadable, preserve exclusion;
        // never delete or rename a live/successor claim.
      } catch {
        /* Preserve a lock whose ownership cannot be established. */
      }
    }
  }

  async function replace(
    root: string,
    snapshot: BackgroundJobSnapshot,
  ): Promise<void> {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const target = pathFor(root);
    const temporary = `${target}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, `${JSON.stringify(snapshot)}\n`, {
        flag: 'wx',
        mode: 0o600,
      });
      await (options.atomicReplace ?? rename)(temporary, target);
    } catch (error) {
      await rm(temporary, { force: true });
      throw error;
    }
  }

  return {
    async readRoot(rootSessionID) {
      try {
        return await readPath(pathFor(rootSessionID), rootSessionID);
      } catch (error) {
        console.warn(
          `Skipping invalid background-job snapshot: ${String(error)}`,
        );
        return undefined;
      }
    },
    async readAll() {
      let files: string[];
      try {
        files = await readdir(directory);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
        throw error;
      }
      const snapshots: BackgroundJobSnapshot[] = [];
      for (const file of files.filter((name) => name.endsWith('.json'))) {
        try {
          const snapshot = JSON.parse(
            await readFile(join(directory, file), 'utf8'),
          ) as unknown;
          if (!isSnapshot(snapshot))
            throw new Error('Invalid snapshot envelope');
          if (pathFor(snapshot.rootSessionID) !== join(directory, file))
            throw new Error('Snapshot filename does not match root ID');
          snapshots.push(snapshot);
        } catch (error) {
          console.warn(
            `Skipping invalid background-job snapshot ${file}: ${String(error)}`,
          );
        }
      }
      return snapshots;
    },
    async applyMutation(rootSessionID, mutation, updatedAt) {
      await withLock(rootSessionID, async () => {
        const current = await readPath(pathFor(rootSessionID), rootSessionID);
        const records: Record<string, unknown> = Object.assign(
          Object.create(null) as Record<string, unknown>,
          current?.records,
        );
        for (const taskID of mutation.removeTaskIDs) delete records[taskID];
        for (const record of mutation.upsert) {
          if (typeof record.taskID !== 'string')
            throw new Error('Snapshot record must have a string taskID');
          records[record.taskID] = record;
        }
        if (Object.keys(records).length === 0) {
          if (mutation.removeTaskIDs.length > 0)
            await rm(pathFor(rootSessionID), { force: true });
          return;
        }
        await replace(rootSessionID, {
          version: 1,
          rootSessionID,
          updatedAt,
          records,
        });
      });
    },
    async removeRoot(rootSessionID) {
      await withLock(rootSessionID, async () => {
        await readPath(pathFor(rootSessionID), rootSessionID);
        await rm(pathFor(rootSessionID), { force: true });
      });
    },
  };
}
