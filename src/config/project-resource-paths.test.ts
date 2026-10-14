import { describe, expect, test } from 'bun:test';
import { mkdirSync, symlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { getConfigSearchDirs } from '../cli/paths';
import { withTmpDirSync } from '../test-utils';
import { mergePluginConfigs } from './loader';
import {
  computeResourceDepth,
  DEFAULT_RESOURCE_PREFIXES,
  normalizeResourcePrefixes,
  OPENCODE_CONFIG_DEPTH,
  resolveProjectResourceRoots,
} from './project-resource-paths';
import { RuntimeConfig } from './runtime';

function makeDirectory(directory: string): string {
  mkdirSync(directory, { recursive: true });
  return directory;
}

describe('resource prefix configuration', () => {
  test('uses defaults only when omitted and preserves explicit empty list', () => {
    const defaults = RuntimeConfig.init(
      '/virtual/default-prefixes',
      {},
    ).resourcePrefixes;
    const empty = RuntimeConfig.init('/virtual/empty-prefixes', {
      resource_prefixes: [],
    }).resourcePrefixes;
    expect(defaults).toEqual(DEFAULT_RESOURCE_PREFIXES);
    expect(empty).toEqual([]);
    expect(
      normalizeResourcePrefixes(['.local/', '.local', '.opencode/']),
    ).toEqual(['.local', '.opencode']);
    RuntimeConfig.reset('/virtual/default-prefixes');
    RuntimeConfig.reset('/virtual/empty-prefixes');
  });

  test('project config replaces an explicit user list and omission inherits', () => {
    const user = { resource_prefixes: ['.local'] };
    expect(mergePluginConfigs(user, {})).toMatchObject({
      resource_prefixes: ['.local'],
    });
    expect(
      mergePluginConfigs(user, { resource_prefixes: ['.opencode'] }),
    ).toMatchObject({ resource_prefixes: ['.opencode'] });
    expect(mergePluginConfigs(user, { resource_prefixes: [] })).toMatchObject({
      resource_prefixes: [],
    });
  });
});

describe('computeResourceDepth', () => {
  test('scores the home directory as zero and counts hops below it', () => {
    const home = homedir();
    expect(computeResourceDepth(home)).toBe(0);
    expect(computeResourceDepth(join(home, 'work'))).toBe(1);
    expect(computeResourceDepth(join(home, 'work', 'proj'))).toBe(2);
  });

  test('scores an OpenCode config directory as the least specific depth', () => {
    const configDirs = getConfigSearchDirs();
    expect(configDirs.length).toBeGreaterThan(0);
    for (const configDir of configDirs) {
      expect(computeResourceDepth(configDir)).toBe(OPENCODE_CONFIG_DEPTH);
      expect(computeResourceDepth(join(configDir, 'rules'))).toBe(
        OPENCODE_CONFIG_DEPTH,
      );
    }
  });

  test('ranks a root outside home below every home-based root', () => {
    expect(computeResourceDepth('/')).toBe(-24578);
    expect(computeResourceDepth('/', { givenPathHops: 3 })).toBe(-24575);
    expect(computeResourceDepth('/')).toBeLessThan(
      computeResourceDepth(homedir()),
    );
  });

  test('scores a symlinked path by its spelling, not by its target', () => {
    withTmpDirSync((root) => {
      const nested = makeDirectory(join(root, 'real', 'nested'));
      const link = join(root, 'link');
      symlinkSync(
        nested,
        link,
        process.platform === 'win32' ? 'junction' : 'dir',
      );
      // Spelled `root/link` the path sits one hop below the root. Resolving it
      // would drop it two hops down at `root/real/nested` instead.
      expect(computeResourceDepth(link)).toBe(
        computeResourceDepth(join(root, 'link')),
      );
      expect(computeResourceDepth(link)).toBeLessThan(
        computeResourceDepth(nested),
      );
    });
  });
});

describe('resolveProjectResourceRoots', () => {
  test('ignores absolute and parent-traversing direct prefixes', () => {
    withTmpDirSync((root) => {
      const boundary = makeDirectory(join(root, 'repo'));
      const active = makeDirectory(join(boundary, 'app'));
      makeDirectory(join(root, 'outside', 'rules'));
      makeDirectory(join(active, '.local', 'rules'));

      const roots = resolveProjectResourceRoots({
        activeDirectory: active,
        boundaryDirectory: boundary,
        prefixes: ['../outside', join(root, 'outside'), '.local'],
        category: 'rules',
      });

      expect(roots.map((entry) => entry.path)).toEqual([
        join(active, '.local', 'rules'),
      ]);
    });
  });

  test('normalizes trailing separators and deduplicates prefixes in order', () => {
    withTmpDirSync((root) => {
      const boundary = makeDirectory(join(root, 'repo'));
      const active = makeDirectory(join(boundary, 'app'));
      const expected = makeDirectory(join(active, '.local', 'rules'));

      const roots = resolveProjectResourceRoots({
        activeDirectory: active,
        boundaryDirectory: boundary,
        prefixes: ['.local/', '.local', '.local\\'],
        category: 'rules',
      });

      expect(roots.map((entry) => entry.path)).toEqual([expected]);
      expect(roots[0]?.prefix).toBe('.local');
    });
  });

  test('orders nearest ancestor then prefix and stops at boundary', () => {
    withTmpDirSync((root) => {
      const boundary = makeDirectory(join(root, 'repo'));
      const parent = makeDirectory(join(boundary, 'packages'));
      const active = makeDirectory(join(parent, 'app'));
      const expected = [
        join(active, '.local', 'rules'),
        join(active, '.opencode', 'rules'),
        join(parent, '.local', 'rules'),
        join(boundary, '.local', 'rules'),
      ];
      for (const directory of expected) makeDirectory(directory);
      makeDirectory(join(root, '.local', 'rules'));
      const roots = resolveProjectResourceRoots({
        activeDirectory: active,
        boundaryDirectory: boundary,
        prefixes: ['.local/', '.opencode'],
        category: 'rules',
      });
      expect(roots.map((entry) => entry.path)).toEqual(expected);
    });
  });

  test('deduplicates by canonical path and rejects escaping symlinks', () => {
    withTmpDirSync((root) => {
      const boundary = makeDirectory(join(root, 'repo'));
      const active = makeDirectory(join(boundary, 'app'));
      const canonical = makeDirectory(join(active, '.local', 'skills'));
      const alias = join(active, '.local-alias');
      symlinkSync(
        dirname(canonical),
        alias,
        process.platform === 'win32' ? 'junction' : 'dir',
      );
      expect(
        resolveProjectResourceRoots({
          activeDirectory: active,
          boundaryDirectory: boundary,
          prefixes: ['.local', '.local-alias'],
          category: 'skills',
        }).map((entry) => entry.path),
      ).toEqual([canonical]);

      const external = makeDirectory(join(root, 'external', '.local', 'rules'));
      const localPrefix = makeDirectory(join(active, '.local'));
      symlinkSync(
        external,
        join(localPrefix, 'rules'),
        process.platform === 'win32' ? 'junction' : 'dir',
      );
      expect(
        resolveProjectResourceRoots({
          activeDirectory: active,
          boundaryDirectory: boundary,
          prefixes: ['.local'],
          category: 'rules',
        }),
      ).toEqual([]);
    });
  });

  test('keeps the configured spelling of a symlinked prefix', () => {
    withTmpDirSync((root) => {
      const boundary = makeDirectory(join(root, 'repo'));
      const active = makeDirectory(join(boundary, 'app'));
      makeDirectory(join(active, 'shared', 'rules'));
      symlinkSync(
        join(active, 'shared'),
        join(active, '.local'),
        process.platform === 'win32' ? 'junction' : 'dir',
      );
      expect(
        resolveProjectResourceRoots({
          activeDirectory: active,
          boundaryDirectory: boundary,
          prefixes: ['.local'],
          category: 'rules',
        }).map((entry) => [entry.path, entry.relativePath]),
      ).toEqual([[join(active, '.local', 'rules'), 'app/.local/rules']]);
    });
  });

  test('returns no roots if active directory is outside boundary', () => {
    withTmpDirSync((root) => {
      const boundary = makeDirectory(join(root, 'repo'));
      const active = makeDirectory(join(root, 'outside'));
      makeDirectory(join(active, '.local', 'rules'));
      expect(
        resolveProjectResourceRoots({
          activeDirectory: active,
          boundaryDirectory: boundary,
          prefixes: ['.local'],
          category: 'rules',
        }),
      ).toEqual([]);
    });
  });
});
