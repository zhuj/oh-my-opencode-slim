import { describe, expect, spyOn, test } from 'bun:test';
import * as fs from 'node:fs';
import { join, relative } from 'node:path';
import { withTmpDirSync } from '../test-utils';
import type { MarketplacePackageBundle } from './schemas';
import { MarketplaceStore } from './store';

function bundle(): MarketplacePackageBundle {
  return {
    manifest: {
      schemaVersion: 2,
      id: 'community/example',
      version: '1.0.0',
      displayName: 'Example',
      description: 'Cost fixture',
      agentName: 'example',
      prompt: 'x'.repeat(100_000),
      author: { name: 'Community' },
      tags: [],
      license: 'MIT',
      compatibility: { plugin: '*' },
      routing: { description: 'Testing', keywords: [], when: 'Testing' },
      skills: [],
      mcps: [],
      tools: [],
      model: { source: 'session' },
    },
  };
}

function withStore(run: (store: MarketplaceStore) => void): void {
  withTmpDirSync((root) => {
    const store = new MarketplaceStore({
      rootDir: root,
      pluginVersion: '3.2.0',
    });
    store.install(bundle());
    store.loadSelected([]);
    run(store);
  });
}

function quarantine(
  store: MarketplaceStore,
  kind: 'repair' | 'removed',
): string {
  const root = join(store.paths.stagingDir, kind, 'community', 'example');
  for (const operation of ['a', 'b', 'c']) {
    const directory = join(
      root,
      ...(kind === 'repair' ? ['1.0.0'] : []),
      operation,
    );
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(join(directory, 'package.json'), '{recoverable bytes');
  }
  return root;
}

function packageReads(store: MarketplaceStore, run: () => void): number {
  const original = fs.readFileSync;
  const read = spyOn(fs, 'readFileSync');
  read.mockImplementation((...args: Parameters<typeof fs.readFileSync>) =>
    original(...args),
  );
  try {
    run();
    return read.mock.calls.filter(
      ([target]) =>
        String(target).startsWith(store.paths.packagesDir) &&
        String(target).endsWith('package.json'),
    ).length;
  } finally {
    read.mockRestore();
  }
}

function tree(root: string): [string, string][] {
  return fs
    .readdirSync(root, { recursive: true, withFileTypes: true })
    .map((entry): [string, string] => {
      const target = join(entry.parentPath, entry.name);
      return [
        relative(root, target),
        entry.isDirectory() ? '<dir>' : fs.readFileSync(target).toString('hex'),
      ];
    })
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
}

describe('marketplace reconciliation operation counts', () => {
  test('list reuses the orphan package listing and preserves baseline bytes', () => {
    withStore((store) => {
      const orphan = join(store.paths.packagesDir, 'other', 'orphan');
      for (const name of ['z', 'a']) {
        fs.mkdirSync(join(orphan, name), { recursive: true });
        fs.writeFileSync(join(orphan, name, 'bytes'), name);
      }
      const expected = tree(store.paths.rootDir).filter(
        ([target]) =>
          target !== 'packages/other' && !target.startsWith('packages/other/'),
      );
      const original = fs.readdirSync;
      const read = spyOn(fs, 'readdirSync').mockImplementation(
        (...args: Parameters<typeof fs.readdirSync>) => original(...args),
      );
      const originalStat = fs.lstatSync;
      const stat = spyOn(fs, 'lstatSync').mockImplementation(
        (...args: Parameters<typeof fs.lstatSync>) => originalStat(...args),
      );
      let calls: number;
      let statCalls: number;
      try {
        expect(store.list().map((pkg) => pkg.manifest.id)).toEqual([
          'community/example',
        ]);
        calls = read.mock.calls.filter(([target]) => target === orphan).length;
        statCalls = stat.mock.calls.filter(
          ([target]) => target === orphan,
        ).length;
      } finally {
        stat.mockRestore();
        read.mockRestore();
      }
      expect(tree(store.paths.rootDir)).toEqual(expected);
      expect([calls, statCalls]).toEqual([1, 1]);
    });
  });

  test.each(['repair', 'removed'] as const)(
    '%s verifies three quarantines once, including corrupt selections',
    (kind) => {
      withStore((store) => {
        const root = quarantine(store, kind);
        const manifest = join(
          store.paths.packagesDir,
          'community',
          'example',
          '1.0.0',
          'package.json',
        );
        const original = fs.readFileSync(manifest);
        fs.writeFileSync(manifest, '{corrupt');
        const before = tree(store.paths.rootDir);
        const failedReads = packageReads(store, () => store.loadSelected([]));
        expect(tree(store.paths.rootDir)).toEqual(before);
        expect(failedReads).toBe(1);
        // Disk edits between leases must not reuse the failed verification.
        fs.writeFileSync(manifest, original);
        expect(packageReads(store, () => store.loadSelected([]))).toBe(1);
        expect(fs.existsSync(root)).toBe(false);
      });
    },
  );

  test('overlapping repair, removal and old versions share one guard per pass', () => {
    withStore((store) => {
      quarantine(store, 'repair');
      quarantine(store, 'removed');
      const old = join(
        store.paths.packagesDir,
        'community',
        'example',
        '0.9.0',
      );
      fs.mkdirSync(old);
      fs.writeFileSync(join(old, 'bytes'), 'older');
      const before = tree(store.paths.rootDir);
      const expected = before.filter(
        ([target]) =>
          !target.startsWith('.staging/repair') &&
          !target.startsWith('.staging/removed') &&
          !target.startsWith('packages/community/example/0.9.0'),
      );
      const reads = packageReads(store, () => store.loadSelected([]));
      expect(tree(store.paths.rootDir)).toEqual(expected);
      expect(reads).toBe(1);
      // A new quarantine created externally is still reconciled next call.
      const root = quarantine(store, 'removed');
      expect(packageReads(store, () => store.loadSelected([]))).toBe(1);
      expect(fs.existsSync(root)).toBe(false);
    });
  });

  test('restoring a selected repair invalidates an earlier failed guard', () => {
    withStore((store) => {
      const selected = join(
        store.paths.packagesDir,
        'community',
        'example',
        '1.0.0',
      );
      const backupRoot = quarantine(store, 'repair');
      for (const operation of ['a', 'b', 'c']) {
        fs.cpSync(selected, join(backupRoot, '1.0.0', operation), {
          recursive: true,
        });
      }
      const olderBackup = join(backupRoot, '0.9.0', 'a');
      fs.mkdirSync(olderBackup, { recursive: true });
      fs.writeFileSync(join(olderBackup, 'bytes'), 'recoverable old bytes');
      const removedRoot = quarantine(store, 'removed');
      fs.rmSync(selected, { recursive: true });
      const reads = packageReads(store, () => store.loadSelected([]));
      expect(fs.existsSync(selected)).toBe(true);
      expect(fs.existsSync(olderBackup)).toBe(true);
      expect(fs.existsSync(join(backupRoot, '1.0.0'))).toBe(false);
      expect(fs.existsSync(removedRoot)).toBe(false);
      expect(reads).toBe(2);
      // The older backup retained before restoration is reaped next lease.
      store.loadSelected([]);
      expect(fs.existsSync(backupRoot)).toBe(false);
    });
  });

  test('transient operational failures retain per-entry recovery ordering', () => {
    withStore((store) => {
      const root = quarantine(store, 'removed');
      const original = fs.readFileSync;
      let injected = false;
      const read = spyOn(fs, 'readFileSync').mockImplementation(
        (...args: Parameters<typeof fs.readFileSync>) => {
          if (
            !injected &&
            String(args[0]).startsWith(store.paths.packagesDir)
          ) {
            injected = true;
            throw Object.assign(new Error('transient read failure'), {
              code: 'EIO',
            });
          }
          return original(...args);
        },
      );
      try {
        store.loadSelected([]);
      } finally {
        read.mockRestore();
      }
      expect(injected).toBe(true);
      expect(fs.readdirSync(root)).toEqual(['a']);
      store.loadSelected([]);
      expect(fs.existsSync(root)).toBe(false);
    });
  });
});
