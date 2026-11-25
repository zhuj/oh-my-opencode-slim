/// <reference types="bun-types" />

import { describe, expect, mock, spyOn, test } from 'bun:test';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { withTmpDirSync } from '../../../test-utils';

mock.restore();

const {
  buildFolderHashIndex,
  computeFileHash,
  computeFolderHash,
  getFoldersWithFiles,
  loadState,
  main,
  PatternMatcher,
  selectFiles,
} = await import('./codemap.mjs');

function withTempDir(run: (root: string) => void): void {
  withTmpDirSync(run);
}

function writeJson(filePath: string, value: object): void {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, JSON.stringify(value));
}

function readJson(filePath: string): unknown {
  return JSON.parse(readFileSync(filePath, 'utf8'));
}

function withSystemTempDir(run: (root: string) => void): void {
  withTmpDirSync(run);
}

type FileHashes = Record<string, string>;

/**
 * Verbatim copy of the pre-optimization folder-hash algorithm, kept as the
 * oracle for byte-identity. `entriesExamined` counts the prefix checks the
 * old per-folder `Object.entries(...).filter(...)` performed.
 */
function referenceFolderHashes(
  fileHashes: FileHashes,
  folders: Iterable<string>,
) {
  const hashes: FileHashes = {};
  let entriesExamined = 0;

  for (const folder of folders) {
    const folderFiles = Object.entries(fileHashes)
      .filter(
        ([filePath]) =>
          filePath.startsWith(`${folder}/`) ||
          (folder === '.' && !filePath.includes('/')),
      )
      .sort(([a], [b]) => a.localeCompare(b));
    entriesExamined += Object.keys(fileHashes).length;

    if (!folderFiles.length) {
      hashes[folder] = '';
      continue;
    }

    const hasher = createHash('md5');
    for (const [filePath, hash] of folderFiles) {
      hasher.update(`${filePath}:${hash}\n`);
    }
    hashes[folder] = hasher.digest('hex');
  }

  return { hashes, entriesExamined };
}

/** Verbatim copy of the pre-optimization ancestor-prefix derivation. */
function referenceFoldersWithFiles(files: readonly string[], root: string) {
  const folders = new Set<string>(['.']);

  for (const filePath of files) {
    const relPath = path.relative(root, filePath).split(path.sep).join('/');
    const parts = relPath.split('/').slice(0, -1);
    for (let i = 0; i < parts.length; i++) {
      folders.add(parts.slice(0, i + 1).join('/'));
    }
  }

  return folders;
}

function indexHashes(
  index: {
    hashFor(folder: string): string;
  },
  folders: Iterable<string>,
): FileHashes {
  const hashes: FileHashes = {};
  for (const folder of folders) {
    hashes[folder] = index.hashFor(folder);
  }
  return hashes;
}

describe('PatternMatcher', () => {
  test('matches expected paths', () => {
    const matcher = new PatternMatcher([
      'node_modules/',
      'dist/',
      '*.log',
      'src/**/*.ts',
    ]);

    expect(matcher.matches('node_modules/foo.js')).toBe(true);
    expect(matcher.matches('vendor/node_modules/bar.js')).toBe(true);
    expect(matcher.matches('dist/main.js')).toBe(true);
    expect(matcher.matches('src/dist/output.js')).toBe(true);
    expect(matcher.matches('error.log')).toBe(true);
    expect(matcher.matches('logs/access.log')).toBe(true);
    expect(matcher.matches('src/index.ts')).toBe(true);
    expect(matcher.matches('src/utils/helper.ts')).toBe(true);
    expect(matcher.matches('README.md')).toBe(false);
    expect(matcher.matches('tests/test.py')).toBe(false);
  });
});

describe('hash helpers', () => {
  test('computes file hash', () => {
    withTempDir((root) => {
      const filePath = path.join(root, 'file.txt');
      writeFileSync(filePath, 'test content');

      expect(computeFileHash(filePath)).toBe(
        '9473fdd0d880a43c21b7778d34872157',
      );
    });
  });

  test('computes stable folder hash', () => {
    const fileHashes = {
      'src/a.ts': 'hash-a',
      'src/b.ts': 'hash-b',
      'tests/test.ts': 'hash-test',
    };

    const hash1 = computeFolderHash('src', fileHashes);
    const hash2 = computeFolderHash('src', fileHashes);
    const hash3 = computeFolderHash('src', {
      'src/a.ts': 'hash-a-modified',
      'src/b.ts': 'hash-b',
    });

    expect(hash1).toBe(hash2);
    expect(hash1).not.toBe(hash3);
  });
});

describe('getFoldersWithFiles', () => {
  test('does not rebuild ancestor prefixes with array slices', () => {
    const root = path.resolve('/repo');
    const file = path.join(
      root,
      ...Array.from({ length: 80 }, (_, i) => `d${i}`),
      'file.ts',
    );
    const sliceSpy = spyOn(Array.prototype, 'slice');
    let sliceCalls: number;
    let folders: Set<string>;
    try {
      folders = getFoldersWithFiles([file], root);
      sliceCalls = sliceSpy.mock.calls.length;
    } finally {
      sliceSpy.mockRestore();
    }
    expect(folders.size).toBe(81);
    expect(sliceCalls).toBe(0);
  });

  test('matches the pre-optimization prefix derivation and insertion order', () => {
    withSystemTempDir((root) => {
      // Given: nested files, a top-level file, and sibling-prefixed folders.
      const relPaths = [
        'package.json',
        'src/index.ts',
        'src/deep/nested/mod.ts',
        'src/deep/other.ts',
        'srcx/looks-alike.ts',
        'test/case.ts',
      ];
      const files = relPaths.map((rel) => path.join(root, ...rel.split('/')));
      for (const filePath of files) {
        mkdirSync(path.dirname(filePath), { recursive: true });
        writeFileSync(filePath, 'x');
      }

      // When
      const folders = [...getFoldersWithFiles(files, root)];

      // Then: same set, same first-seen order as the slice/join derivation.
      expect(folders).toEqual([...referenceFoldersWithFiles(files, root)]);
      expect(folders).toContain('src');
      expect(folders).toContain('src/deep');
      // `src` and `srcx` are distinct folders, not one prefix of the other.
      expect(folders).toContain('srcx');
      expect(folders[0]).toBe('.');
    });
  });

  test('seeded top-level folder survives when only nested files exist', () => {
    withSystemTempDir((root) => {
      // Given: no top-level file, so the old `slice(0, -1)` loop adds nothing.
      const filePath = path.join(root, 'src', 'index.ts');
      mkdirSync(path.dirname(filePath), { recursive: true });
      writeFileSync(filePath, 'x');

      // When
      const folders = getFoldersWithFiles([filePath], root);

      // Then
      expect(folders.has('.')).toBe(true);
      expect(folders.has('src')).toBe(true);
    });
  });
});

describe('buildFolderHashIndex', () => {
  test('enumerates the input once even when every file has many ancestors', () => {
    const fileHashes: FileHashes = {};
    const depth = 40;
    const prefix = Array.from({ length: depth }, (_, i) => `d${i}`).join('/');
    for (let i = 0; i < 100; i++) fileHashes[`${prefix}/file${i}.ts`] = `h${i}`;
    let enumerations = 0;
    let reads = 0;
    const observed = new Proxy(fileHashes, {
      ownKeys(target) {
        enumerations++;
        return Reflect.ownKeys(target);
      },
      get(target, key, receiver) {
        reads++;
        return Reflect.get(target, key, receiver);
      },
    });
    const index = buildFolderHashIndex(observed);
    for (const folder of index.folders.keys()) index.hashFor(folder);
    expect(enumerations).toBe(1);
    expect(reads).toBe(100);
    expect(index.stats.pairChecks).toBe(100 * depth);
    expect(indexHashes(index, index.folders.keys())).toEqual(
      referenceFolderHashes(fileHashes, index.folders.keys()).hashes,
    );
  });

  test('preserves stable ordering for collation-equal paths and helper edge cases', () => {
    const fileHashes: FileHashes = {
      'src/e\u0301.ts': 'decomposed',
      'src/é.ts': 'composed',
      './nested/file.ts': 'dot-relative',
      'top.ts': 'top',
      '/absolute/file.ts': 'absolute',
    };
    expect('src/e\u0301.ts'.localeCompare('src/é.ts')).toBe(0);
    const queried = ['src', '.', './nested', '', '/absolute', 'missing'];
    const reference = referenceFolderHashes(fileHashes, queried).hashes;
    const index = buildFolderHashIndex(fileHashes);
    expect(indexHashes(index, queried)).toEqual(reference);
    for (const folder of queried) {
      expect(computeFolderHash(folder, fileHashes)).toBe(reference[folder]);
    }
    expect(buildFolderHashIndex({}).hashFor('.')).toBe('');
  });

  test('is byte-identical to the pre-optimization algorithm', () => {
    withSystemTempDir((root) => {
      // Given: a tree that exercises top-level files, nesting, sibling
      // prefixes, case differences, and a folder with no files of its own.
      const relPaths = [
        'package.json',
        'README.md',
        'src.ts',
        'src/index.ts',
        'src/Alpha.ts',
        'src/beta.ts',
        'src/deep/nested/mod.ts',
        'src/deep/other.ts',
        'srcx/looks-alike.ts',
        'tests/unit/case.spec.ts',
      ];
      const files = relPaths.map((rel) => path.join(root, ...rel.split('/')));
      for (const [i, filePath] of files.entries()) {
        mkdirSync(path.dirname(filePath), { recursive: true });
        writeFileSync(filePath, `content-${i}\n`);
      }

      const fileHashes: FileHashes = {};
      for (const filePath of files) {
        const rel = path.relative(root, filePath).split(path.sep).join('/');
        fileHashes[rel] = computeFileHash(filePath);
      }
      const folders = getFoldersWithFiles(files, root);
      // Include a folder that holds no file, to pin the empty-hash contract.
      const queried = [...folders, 'empty', 'src/deep/hollow'];

      // When
      const index = buildFolderHashIndex(fileHashes);
      const actual = indexHashes(index, queried);

      // Then
      expect(actual).toEqual(referenceFolderHashes(fileHashes, queried).hashes);
    });
  });

  test('matches the single-folder helper for every folder', () => {
    withSystemTempDir((root) => {
      // Given
      const relPaths = [
        'top.ts',
        'a/one.ts',
        'a/b/two.ts',
        'a/b/c/three.ts',
        'ab/four.ts',
      ];
      const files = relPaths.map((rel) => path.join(root, ...rel.split('/')));
      for (const [i, filePath] of files.entries()) {
        mkdirSync(path.dirname(filePath), { recursive: true });
        writeFileSync(filePath, `v${i}`);
      }

      const fileHashes: FileHashes = {};
      for (const filePath of files) {
        const rel = path.relative(root, filePath).split(path.sep).join('/');
        fileHashes[rel] = computeFileHash(filePath);
      }

      // When
      const index = buildFolderHashIndex(fileHashes);

      // Then
      for (const folder of getFoldersWithFiles(files, root)) {
        expect(index.hashFor(folder)).toBe(
          computeFolderHash(folder, fileHashes),
        );
      }
    });
  });

  test('does not match a sibling folder whose name is a path prefix', () => {
    // Given: `src.ts` must not be treated as living inside `src/`.
    const fileHashes: FileHashes = {
      'src.ts': 'sibling-hash',
      'src/index.ts': 'inside-hash',
    };

    // When
    const index = buildFolderHashIndex(fileHashes);

    // Then
    expect(index.hashFor('src')).toBe(
      referenceFolderHashes(fileHashes, ['src']).hashes.src,
    );
    expect(index.hashFor('src')).not.toBe('');
    expect(index.hashFor('src.ts')).toBe('');
    // The `src.ts` file only lands in the top-level bucket.
    expect(index.hashFor('.')).toBe(
      referenceFolderHashes(fileHashes, ['.']).hashes['.'],
    );
    expect(index.folders.has('src.ts')).toBe(false);
  });

  test('orders each folder by localeCompare, not by insertion order', () => {
    // Given: names inserted out of collation order, plus a case difference
    // that a code-unit sort would place differently.
    const fileHashes: FileHashes = {
      'src/beta.ts': 'h-beta',
      'src/Alpha.ts': 'h-alpha',
      'src/a-dash.ts': 'h-dash',
      'src/alpha.ts': 'h-alpha-lower',
    };
    const collated = [...Object.keys(fileHashes)].sort((a, b) =>
      a.localeCompare(b),
    );
    // Sanity: the collation order is not the insertion order, so an
    // implementation that hashes in insertion order would be caught.
    expect(collated).not.toEqual(Object.keys(fileHashes));
    expect(collated).not.toEqual([...collated].sort());

    // When
    const index = buildFolderHashIndex(fileHashes);

    // Then: identical bytes to hashing the collation-ordered subset.
    expect(index.hashFor('src')).toBe(
      referenceFolderHashes(fileHashes, ['src']).hashes.src,
    );
  });

  test('exposes exactly the folders that hold files', () => {
    // Given
    const fileHashes: FileHashes = {
      'top.ts': 'h0',
      'a/one.ts': 'h1',
      'a/b/two.ts': 'h2',
    };

    // When
    const index = buildFolderHashIndex(fileHashes);

    // Then
    expect([...index.folders.keys()].sort()).toEqual(['.', 'a', 'a/b']);
  });

  test('indexes O(F) entries and O(F * depth) folder pairs, not O(G x F)', () => {
    // Given: a few thousand files spread over a few hundred folders.
    const fileCount = 3000;
    const leafCount = 300;
    const fileHashes: FileHashes = {};
    for (let i = 0; i < fileCount; i++) {
      const leaf = i % leafCount;
      const depth = (i % 3) + 1;
      const segments = Array.from({ length: depth }, (_, d) => `d${d}`);
      const relPath = [
        ...segments.slice(0, depth - 1),
        `leaf${leaf}`,
        `file${i}.ts`,
      ].join('/');
      fileHashes[relPath] = `hash-${i}`;
    }

    const folders = referenceFoldersWithFiles(
      Object.keys(fileHashes).map((rel) =>
        path.join('/repo', ...rel.split('/')),
      ),
      '/repo',
    );
    const folderCount = folders.size;
    // Layout sanity: G is meaningfully smaller than F, otherwise the
    // old-vs-new comparison below would be measuring the wrong thing.
    expect(folderCount).toBeLessThan(fileCount / 2);
    expect(folderCount).toBeGreaterThan(100);

    // When
    const index = buildFolderHashIndex(fileHashes);
    const reference = referenceFolderHashes(fileHashes, folders);

    // Then: entry materialization is one pass, not one pass per folder.
    expect(index.stats.entryLists).toBe(1);
    expect(index.stats.entryElements).toBe(fileCount);
    // Old algorithm examined every file entry once per folder.
    expect(reference.entriesExamined).toBe(fileCount * folderCount);
    expect(index.stats.pairChecks).toBeLessThanOrEqual(fileCount * 4);
    // And the values are still identical.
    expect(indexHashes(index, folders)).toEqual(reference.hashes);
  });
});

describe('selectFiles', () => {
  test('respects include and exclude patterns', () => {
    withTempDir((root) => {
      mkdirSync(path.join(root, 'src'));
      mkdirSync(path.join(root, 'node_modules'));
      writeFileSync(path.join(root, 'src', 'index.ts'), 'code');
      writeFileSync(path.join(root, 'src', 'index.test.ts'), 'test');
      writeFileSync(path.join(root, 'node_modules', 'foo.js'), 'dep');
      writeFileSync(path.join(root, 'package.json'), '{}');

      const selected = selectFiles(
        root,
        ['src/**/*.ts', 'package.json'],
        ['**/*.test.ts', 'node_modules/'],
        [],
        [],
      ).map((filePath) =>
        path.relative(root, filePath).split(path.sep).join('/'),
      );

      expect(selected).toEqual(['package.json', 'src/index.ts']);
    });
  });
});

describe('loadState', () => {
  test('migrates legacy codemap state before cartography without deleting either', () => {
    withTempDir((root) => {
      // Given
      const legacyCodemapPath = path.join(root, '.slim', 'codemap.json');
      const legacyCartographyPath = path.join(
        root,
        '.slim',
        'cartography.json',
      );
      const legacyCodemapState = { source: 'legacy-codemap' };
      const legacyCartographyState = { source: 'legacy-cartography' };
      writeJson(legacyCodemapPath, legacyCodemapState);
      writeJson(legacyCartographyPath, legacyCartographyState);

      // When
      const state = loadState(root);

      // Then
      expect(state).toEqual(legacyCodemapState);
      expect(readJson(legacyCodemapPath)).toEqual(legacyCodemapState);
      expect(readJson(legacyCartographyPath)).toEqual(legacyCartographyState);
      expect(
        readJson(path.join(root, '.local', '.slim', 'codemap.json')),
      ).toEqual(legacyCodemapState);
    });
  });

  test('migrates legacy cartography state without deleting it', () => {
    withTempDir((root) => {
      // Given
      const legacyPath = path.join(root, '.slim', 'cartography.json');
      const legacyState = { source: 'legacy-cartography' };
      writeJson(legacyPath, legacyState);

      // When
      const state = loadState(root);

      // Then
      expect(state).toEqual(legacyState);
      expect(readJson(legacyPath)).toEqual(legacyState);
      expect(
        readJson(path.join(root, '.local', '.slim', 'codemap.json')),
      ).toEqual(legacyState);
    });
  });

  test('prefers new-root state over both legacy state files', () => {
    withTempDir((root) => {
      // Given
      const newState = { source: 'new-root' };
      writeJson(path.join(root, '.local', '.slim', 'codemap.json'), newState);
      writeJson(path.join(root, '.slim', 'codemap.json'), {
        source: 'legacy-codemap',
      });
      writeJson(path.join(root, '.slim', 'cartography.json'), {
        source: 'legacy-cartography',
      });

      // When
      const state = loadState(root);

      // Then
      expect(state).toEqual(newState);
    });
  });
});

describe('codemap commands', () => {
  test('materializes file entries once during init, not once per folder', () => {
    withTempDir((root) => {
      for (let i = 0; i < 30; i++) {
        const file = path.join(root, `folder${i}`, 'nested', 'file.ts');
        mkdirSync(path.dirname(file), { recursive: true });
        writeFileSync(file, `content${i}`);
      }
      const entriesSpy = spyOn(Object, 'entries');
      let materializations: number;
      try {
        expect(main(['init', '--root', root])).toBe(0);
        materializations = entriesSpy.mock.calls.length;
      } finally {
        entriesSpy.mockRestore();
      }
      expect(materializations).toBe(1);
    });
  });

  test('init writes state and mirrored generated maps only under project local', () => {
    withTempDir((root) => {
      // Given
      mkdirSync(path.join(root, 'src'));
      writeFileSync(path.join(root, 'src', 'index.ts'), 'export {};\n');

      // When
      const exitCode = main([
        'init',
        '--root',
        root,
        '--include',
        'src/**/*.ts',
      ]);

      // Then
      expect(exitCode).toBe(0);
      expect(
        existsSync(path.join(root, '.local', '.slim', 'codemap.json')),
      ).toBe(true);
      expect(
        existsSync(
          path.join(root, '.local', '.slim', 'codemaps', 'codemap.md'),
        ),
      ).toBe(true);
      expect(
        existsSync(
          path.join(root, '.local', '.slim', 'codemaps', 'src', 'codemap.md'),
        ),
      ).toBe(true);
      expect(existsSync(path.join(root, '.slim', 'codemap.json'))).toBe(false);
      expect(existsSync(path.join(root, 'codemap.md'))).toBe(false);
      expect(existsSync(path.join(root, 'src', 'codemap.md'))).toBe(false);
    });
  });

  test('init preserves authored legacy maps', () => {
    withTempDir((root) => {
      // Given
      const rootMapPath = path.join(root, 'codemap.md');
      const sourceMapPath = path.join(root, 'src', 'codemap.md');
      mkdirSync(path.dirname(sourceMapPath), { recursive: true });
      writeFileSync(path.join(root, 'src', 'index.ts'), 'export {};\n');
      writeFileSync(rootMapPath, '# Authored root map\n');
      writeFileSync(sourceMapPath, '# Authored source map\n');

      // When
      const exitCode = main([
        'init',
        '--root',
        root,
        '--include',
        'src/**/*.ts',
      ]);

      // Then
      expect(exitCode).toBe(0);
      expect(readFileSync(rootMapPath, 'utf8')).toBe('# Authored root map\n');
      expect(readFileSync(sourceMapPath, 'utf8')).toBe(
        '# Authored source map\n',
      );
    });
  });

  test('init writes folder hashes byte-identical to the reference algorithm', () => {
    withSystemTempDir((root) => {
      // Given: a tree spanning top-level files, nesting, and sibling prefixes.
      const relPaths = [
        'package.json',
        'src.ts',
        'src/index.ts',
        'src/deep/nested/mod.ts',
        'srcx/looks-alike.ts',
      ];
      for (const [i, rel] of relPaths.entries()) {
        const filePath = path.join(root, ...rel.split('/'));
        mkdirSync(path.dirname(filePath), { recursive: true });
        writeFileSync(filePath, `v${i}\n`);
      }

      // When
      const logSpy = spyOn(console, 'log').mockImplementation(() => {});
      let exitCode: number;
      let lines: string[];
      try {
        exitCode = main(['init', '--root', root]);
        lines = logSpy.mock.calls.map((call) => String(call[0]));
      } finally {
        logSpy.mockRestore();
      }

      // Then
      expect(exitCode).toBe(0);
      const state = readJson(
        path.join(root, '.local', '.slim', 'codemap.json'),
      ) as { file_hashes: FileHashes; folder_hashes: FileHashes };

      const expected = referenceFolderHashes(
        state.file_hashes,
        referenceFoldersWithFiles(
          Object.keys(state.file_hashes).map((rel) => path.join(root, rel)),
          root,
        ),
      ).hashes;
      expect(state.folder_hashes).toEqual(expected);
      // Key order is part of the emitted artifact.
      expect(Object.keys(state.folder_hashes)).toEqual(Object.keys(expected));
      expect(JSON.stringify(state.folder_hashes)).toBe(
        JSON.stringify(expected),
      );
      expect(lines).toEqual([
        `Scanning ${root}...`,
        'Include patterns: ["**/*"]',
        'Exclude patterns: []',
        'Exceptions: []',
        'Selected 5 files',
        'Created .local/.slim/codemap.json',
        'Created 5 empty maps under .local/.slim/codemaps',
      ]);
    });
  });

  test('changes lists files and folders in the documented order', () => {
    withSystemTempDir((root) => {
      // Given
      const relPaths = [
        'package.json',
        'src/index.ts',
        'src/deep/nested/mod.ts',
        'srcx/looks-alike.ts',
      ];
      for (const [i, rel] of relPaths.entries()) {
        const filePath = path.join(root, ...rel.split('/'));
        mkdirSync(path.dirname(filePath), { recursive: true });
        writeFileSync(filePath, `v${i}\n`);
      }
      expect(main(['init', '--root', root])).toBe(0);

      // When: add, modify, and remove so all three buckets are non-empty,
      // and touch a deeply nested file so multi-level prefixes are covered.
      writeFileSync(path.join(root, 'src', 'added.ts'), 'new\n');
      writeFileSync(path.join(root, 'src', 'index.ts'), 'changed\n');
      writeFileSync(
        path.join(root, 'src', 'deep', 'nested', 'mod.ts'),
        'deep-changed\n',
      );
      rmSync(path.join(root, 'srcx', 'looks-alike.ts'));

      const logSpy = spyOn(console, 'log').mockImplementation(() => {});
      let lines: string[];
      try {
        expect(main(['changes', '--root', root])).toBe(0);
        lines = logSpy.mock.calls.map((call) => String(call[0]));
      } finally {
        logSpy.mockRestore();
      }

      // Then
      expect(lines).toEqual([
        '\n1 added:',
        '  + src/added.ts',
        '\n1 removed:',
        '  - srcx/looks-alike.ts',
        '\n2 modified:',
        '  ~ src/deep/nested/mod.ts',
        '  ~ src/index.ts',
        '\n5 folders affected:',
        '  ./',
        '  src/',
        '  src/deep/',
        '  src/deep/nested/',
        '  srcx/',
      ]);
    });
  });

  test('update keeps folder hashes and map set identical to init', () => {
    withSystemTempDir((root) => {
      // Given
      const relPaths = [
        'package.json',
        'src/index.ts',
        'src/deep/nested/mod.ts',
        'srcx/looks-alike.ts',
      ];
      for (const [i, rel] of relPaths.entries()) {
        const filePath = path.join(root, ...rel.split('/'));
        mkdirSync(path.dirname(filePath), { recursive: true });
        writeFileSync(filePath, `v${i}\n`);
      }
      expect(main(['init', '--root', root])).toBe(0);
      const afterInit = readJson(
        path.join(root, '.local', '.slim', 'codemap.json'),
      ) as { file_hashes: FileHashes; folder_hashes: FileHashes };

      // When
      const logSpy = spyOn(console, 'log').mockImplementation(() => {});
      try {
        expect(main(['update', '--root', root])).toBe(0);
      } finally {
        logSpy.mockRestore();
      }
      const afterUpdate = readJson(
        path.join(root, '.local', '.slim', 'codemap.json'),
      ) as { file_hashes: FileHashes; folder_hashes: FileHashes };

      // Then: unchanged tree, unchanged hashes; maps exist for every folder.
      expect(afterUpdate.file_hashes).toEqual(afterInit.file_hashes);
      expect(afterUpdate.folder_hashes).toEqual(afterInit.folder_hashes);
      for (const folder of Object.keys(afterUpdate.folder_hashes)) {
        const mapPath =
          folder === '.'
            ? path.join(root, '.local', '.slim', 'codemaps', 'codemap.md')
            : path.join(
                root,
                '.local',
                '.slim',
                'codemaps',
                ...folder.split('/'),
                'codemap.md',
              );
        expect(existsSync(mapPath)).toBe(true);
      }
    });
  });

  test('update migrates legacy state and writes updates only to new root', () => {
    withTempDir((root) => {
      // Given
      const legacyPath = path.join(root, '.slim', 'codemap.json');
      const legacyState = {
        metadata: {
          include_patterns: ['src/**/*.ts'],
          exclude_patterns: [],
          exceptions: [],
        },
        file_hashes: {},
        folder_hashes: {},
      };
      writeJson(legacyPath, legacyState);
      mkdirSync(path.join(root, 'src'));
      writeFileSync(path.join(root, 'src', 'index.ts'), 'export {};\n');

      // When
      const exitCode = main(['update', '--root', root]);

      // Then
      expect(exitCode).toBe(0);
      expect(readJson(legacyPath)).toEqual(legacyState);
      expect(
        existsSync(path.join(root, '.local', '.slim', 'codemap.json')),
      ).toBe(true);
      expect(existsSync(path.join(root, 'codemap.md'))).toBe(false);
      expect(existsSync(path.join(root, 'src', 'codemap.md'))).toBe(false);
    });
  });
});
