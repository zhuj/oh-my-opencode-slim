import { describe, expect, test } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { withTmpDirSync } from '../../test-utils';
import { filterStaleContextFiles } from './task-context-tracker';

describe('filterStaleContextFiles', () => {
  test('keeps a file that still exists on disk', () => {
    withTmpDirSync((dir) => {
      writeFileSync(path.join(dir, 'a.ts'), '1\n2\n3\n4\n5');
      const kept = filterStaleContextFiles(dir, [
        { path: 'a.ts', lastReadAt: 1 },
      ]);
      expect(kept).toHaveLength(1);
    });
  });

  test('drops a missing file', () => {
    withTmpDirSync((dir) => {
      const kept = filterStaleContextFiles(dir, [
        { path: 'gone.ts', lastReadAt: 1 },
      ]);
      expect(kept).toHaveLength(0);
    });
  });

  test('drops a path that is no longer a regular file', () => {
    withTmpDirSync((dir) => {
      mkdirSync(path.join(dir, 'now-a-dir'));
      const kept = filterStaleContextFiles(dir, [
        { path: 'now-a-dir', lastReadAt: 1 },
      ]);
      expect(kept).toHaveLength(0);
    });
  });

  test('keeps a large file without reading it', () => {
    withTmpDirSync((dir) => {
      writeFileSync(path.join(dir, 'big.log'), `x\n`.repeat(600 * 1024));
      const kept = filterStaleContextFiles(dir, [
        { path: 'big.log', lastReadAt: 1 },
      ]);
      expect(kept).toHaveLength(1);
    });
  });

  test('drops a stored entry that went stale after the first commit', () => {
    withTmpDirSync((dir) => {
      writeFileSync(path.join(dir, 'live.ts'), '1\n2\n3\n4\n5');
      // Continuation scenario: stored board context re-validated alongside
      // fresh context; the deleted stored file must leave the result.
      const stored = [
        { path: 'deleted.ts', lastReadAt: 1 },
        { path: 'live.ts', lastReadAt: 2 },
      ];
      const fresh = [{ path: 'live.ts', lastReadAt: 3 }];
      const kept = filterStaleContextFiles(dir, [...stored, ...fresh]);
      expect(kept.some((file) => file.path === 'deleted.ts')).toBe(false);
      expect(kept.every((file) => file.path === 'live.ts')).toBe(true);
    });
  });
});
