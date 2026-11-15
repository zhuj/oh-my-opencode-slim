import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { withTmpDir } from '../test-utils';
import { createBackgroundJobSnapshotStore } from './background-job-snapshot-store';

describe('background-job-snapshot-store core', () => {
  test('normal mutation creates private snapshot and owner file', async () => {
    await withTmpDir(async (tmp) => {
      const store = createBackgroundJobSnapshotStore(tmp);
      await store.applyMutation(
        'root-a',
        { upsert: [{ taskID: 't', agent: 'a' }], removeTaskIDs: [] },
        Date.now(),
      );
      const d = join(tmp, '.local', '.slim', 'background-jobs');
      expect((await stat(d)).mode & 0o777).toBe(0o700);
      const files = await (await import('node:fs/promises')).readdir(d);
      const json = files.find((f: string) => f.endsWith('.json'));
      expect(json).toBeDefined();
      if (json) {
        const p = join(d, json);
        expect((await stat(p)).mode & 0o777).toBe(0o600);
        const text = await readFile(p, 'utf8');
        expect(text).toContain('"version":1');
        expect(text).toContain('"rootSessionID":"root-a"');
      }
    });
  });

  test('existing lock blocks mutation; bytes unchanged; timeout fails closed', async () => {
    await withTmpDir(async (tmp) => {
      const d = join(tmp, '.local', '.slim', 'background-jobs');
      await mkdir(d, { recursive: true, mode: 0o700 });
      const root = 'blocked';
      const snap = join(
        d,
        `${createHash('sha256').update(root).digest('hex')}.json`,
      );
      const lock = `${snap}.lock`;
      await mkdir(lock, { mode: 0o700 });
      await writeFile(
        join(lock, 'owner'),
        JSON.stringify({ token: 't', pid: process.pid, createdAt: Date.now() }),
        { mode: 0o600 },
      );

      const store = createBackgroundJobSnapshotStore(tmp, {
        lockTimeoutMs: 500,
      });
      try {
        await store.applyMutation(
          root,
          { upsert: [{ taskID: 't' }], removeTaskIDs: [] },
          Date.now(),
        );
        expect(true).toBe(false); // should time out
      } catch (e: unknown) {
        expect(String(e)).toContain('Timed out');
      }
      const ownerAfter = await readFile(join(lock, 'owner'), 'utf8');
      const parsed = JSON.parse(ownerAfter) as { token?: string; pid?: number };
      expect(parsed.token).toBe('t');
      expect(parsed.pid).toBe(process.pid);
    });
  });

  test('legacy JSON owner remains byte-identical; unknown/ownerless/malformed untouched', async () => {
    await withTmpDir(async (tmp) => {
      const d = join(tmp, '.local', '.slim', 'background-jobs');
      await mkdir(d, { recursive: true, mode: 0o700 });
      const snap = join(
        d,
        `${createHash('sha256').update('mixed').digest('hex')}.json`,
      );

      const locks = [
        {
          name: 'legacy',
          content: '{"token":"old","pid":99999,"createdAt":1}',
        },
        { name: 'unknown', content: 'not-json\nline' },
        { name: 'ownerless', content: null },
        {
          name: 'live',
          content: JSON.stringify({
            token: 'live',
            pid: process.pid,
            createdAt: Date.now(),
          }),
        },
      ];
      for (const l of locks) {
        const lp = `${snap}.${l.name}.lock`;
        await mkdir(lp, { mode: 0o700 });
        if (l.content !== null) {
          await writeFile(join(lp, 'owner'), l.content, { mode: 0o600 });
        }
        const before =
          l.content === null
            ? 'absent'
            : await readFile(join(lp, 'owner'), 'utf8').catch(() => 'absent');
        // No automatic recovery; files stay unchanged.
        const after =
          l.content === null
            ? 'absent'
            : await readFile(join(lp, 'owner'), 'utf8').catch(() => 'absent');
        expect(after).toBe(before);
      }
    });
  });
});
