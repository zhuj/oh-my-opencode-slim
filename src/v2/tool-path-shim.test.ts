import { describe, expect, test } from 'bun:test';
import { resolveV2TouchedFilePaths } from './tool-path-shim';

describe('resolveV2TouchedFilePaths', () => {
  test('reads only documented paths for read, write, edit, and patch', () => {
    expect(
      resolveV2TouchedFilePaths('read', {
        output: { type: 'file', uri: 'file:///work/a' },
      }),
    ).toEqual(['/work/a']);
    expect(
      resolveV2TouchedFilePaths('write', { output: { target: '/work/a' } }),
    ).toEqual(['/work/a']);
    expect(
      resolveV2TouchedFilePaths(
        'edit',
        { output: { files: [{ file: 'a' }, { file: '/work/b' }] } },
        '/work',
      ),
    ).toEqual(['/work/a', '/work/b']);
    expect(
      resolveV2TouchedFilePaths('patch', {
        output: { applied: [{ target: '/work/a' }, { target: '/work/b' }] },
      }),
    ).toEqual(['/work/a', '/work/b']);
  });

  test('rejects relative absolute-only paths and unsafe edit resolutions', () => {
    expect(
      resolveV2TouchedFilePaths('write', { output: { target: 'a' } }),
    ).toEqual([]);
    expect(
      resolveV2TouchedFilePaths(
        'edit',
        {
          output: {
            files: [
              { file: '../escape' },
              { file: './dot' },
              { file: 'a//b' },
              { file: 'a' },
            ],
          },
        },
        '/work/../outside',
      ),
    ).toEqual([]);
    expect(
      resolveV2TouchedFilePaths(
        'edit',
        {
          output: {
            files: [{ file: '../escape' }, { file: '/work/../escape' }],
          },
        },
        '/work',
      ),
    ).toEqual([]);
  });

  test('rejects noncanonical absolute paths for every path-bearing tool', () => {
    expect(
      resolveV2TouchedFilePaths('write', {
        output: { target: '/work/../escape' },
      }),
    ).toEqual([]);
    expect(
      resolveV2TouchedFilePaths('edit', {
        output: { files: [{ file: '/work//escape' }] },
      }),
    ).toEqual([]);
    expect(
      resolveV2TouchedFilePaths('patch', {
        output: { applied: [{ target: '/work/../escape' }] },
      }),
    ).toEqual([]);
  });

  test('rejects edits resolving outside the validated location', () => {
    expect(
      resolveV2TouchedFilePaths(
        'edit',
        { output: { files: [{ file: 'sub/../../outside' }] } },
        '/work/project',
      ),
    ).toEqual([]);
  });

  test('ignores malformed tool shapes and malformed file URLs', () => {
    expect(
      resolveV2TouchedFilePaths('read', {
        output: { type: 'file', uri: 'file://[invalid' },
      }),
    ).toEqual([]);
    expect(
      resolveV2TouchedFilePaths('read', {
        output: { type: 'text', uri: 'file:///work/a' },
      }),
    ).toEqual([]);
    expect(
      resolveV2TouchedFilePaths('write', { output: { target: 42 } }),
    ).toEqual([]);
    expect(
      resolveV2TouchedFilePaths(
        'edit',
        { output: { files: [{}, null, { file: 42 }] } },
        '/work',
      ),
    ).toEqual([]);
    expect(
      resolveV2TouchedFilePaths('patch', {
        output: { applied: [null, {}, { target: 42 }] },
      }),
    ).toEqual([]);
  });

  test('does not infer paths from args or title fields', () => {
    expect(
      resolveV2TouchedFilePaths('write', {
        args: { target: '/work/from-args' },
        title: '/work/from-title',
        output: {
          args: { target: '/work/nested-args' },
          title: '/work/nested-title',
        },
      }),
    ).toEqual([]);
    expect(
      resolveV2TouchedFilePaths(
        'edit',
        {
          args: { files: [{ file: 'from-args' }] },
          output: { files: [], title: '/work/title' },
        },
        '/work',
      ),
    ).toEqual([]);
  });

  test('preserves order, deduplicates, and returns empty for unavailable evidence', () => {
    expect(
      resolveV2TouchedFilePaths('patch', {
        output: {
          applied: [
            { target: '/work/b' },
            { target: '/work/a' },
            { target: '/work/b' },
          ],
        },
      }),
    ).toEqual(['/work/b', '/work/a']);
    expect(
      resolveV2TouchedFilePaths('edit', { output: { files: [{ file: 'a' }] } }),
    ).toEqual([]);
    expect(
      resolveV2TouchedFilePaths('read', {
        output: { type: 'text', text: '/work/a' },
      }),
    ).toEqual([]);
    expect(resolveV2TouchedFilePaths('write', null)).toEqual([]);
  });
});
