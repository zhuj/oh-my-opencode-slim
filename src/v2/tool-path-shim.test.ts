import { describe, expect, test } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { resolveV1TouchedFilePaths } from '../hooks/rules-context-usage';
import { createRulesInjectorHook } from '../hooks/rules-injector/hook';
import { withTmpDir } from '../test-utils';
import { createToolExecuteBridges } from './setup';
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

  test('native after-hook appends rules to a fresh result only, preserving native output and error', async () => {
    await withTmpDir(async (root) => {
      const rules = join(root, '.local', 'rules');
      mkdirSync(rules, { recursive: true });
      writeFileSync(
        join(rules, 'ts.md'),
        '---\nglobs: src/**/*.ts\n---\nLOCAL RULE',
      );
      const hook = createRulesInjectorHook({
        projectBoundary: root,
        prefixes: ['.local'],
        resolveTouchedFilePaths: resolveV1TouchedFilePaths,
        readRemainingContextTokens: async () => null,
        reportError: (error) => {
          throw error;
        },
        resolveGlobalRoots: () => [],
      });
      const pathCalls: string[] = [];
      const { afterBridge } = createToolExecuteBridges(
        undefined,
        async (input, output) =>
          hook.onToolExecuteAfter(input as never, output as never),
        undefined,
        (tool, result) => {
          pathCalls.push(tool);
          return resolveV2TouchedFilePaths(tool, result, root);
        },
      );
      const original = 'Read file src/a.ts, lines 1-1\n1: source';
      const structured = {
        type: 'text',
        offset: 1,
        lineCount: 1,
        content: 'source',
      };
      const makeEvent = () => ({
        tool: 'read',
        sessionID: 's',
        status: 'completed',
        result: { output: structured, content: original },
      });
      const failed = {
        ...makeEvent(),
        status: 'error',
        error: { message: 'Host failure' },
      };
      await afterBridge(failed);
      expect(failed.error.message).toBe('Host failure');
      expect(failed.result.content).toBe(original);
      expect(pathCalls).toEqual([]);

      const first = makeEvent();
      await afterBridge(first);
      expect(first.result.output).toBe(structured);
      expect(first.result.content).toStartWith(original);
      expect(first.result.content).toContain('LOCAL RULE');

      const second = makeEvent();
      await afterBridge(second);
      expect(second.result.content).toBe(original);
      expect(first.result.content).toContain('LOCAL RULE');
      expect(pathCalls).toEqual(['read', 'read']);
    });
  });

  test('bridges OpenCode 2.4 file result receipts and metadata', () => {
    const location = '/work/project';
    expect(
      resolveV2TouchedFilePaths(
        'read',
        {
          output: { type: 'text', offset: 7, lineCount: 1, content: 'source' },
          content: 'Read file src/a.ts, lines 7-7\n7: source',
        },
        location,
      ),
    ).toEqual(['/work/project/src/a.ts']);
    expect(
      resolveV2TouchedFilePaths(
        'write',
        {
          output: 'Created file successfully: src/new.ts',
        },
        location,
      ),
    ).toEqual(['/work/project/src/new.ts']);
    expect(
      resolveV2TouchedFilePaths(
        'edit',
        {
          output: 'Edited src/a.ts (1 replacement)',
          metadata: { files: [{ file: 'src/a.ts' }] },
        },
        location,
      ),
    ).toEqual(['/work/project/src/a.ts']);
    expect(
      resolveV2TouchedFilePaths(
        'patch',
        {
          output: {},
          metadata: { files: [{ file: 'src/a.ts' }, { file: 'src/b.ts' }] },
        },
        location,
      ),
    ).toEqual(['/work/project/src/a.ts', '/work/project/src/b.ts']);
  });

  test('does not treat directory or virtual read receipts as file evidence', () => {
    const location = '/work/project';
    expect(
      resolveV2TouchedFilePaths(
        'read',
        {
          output: { type: 'directory', entries: [] },
          content: 'Read file file.ts, lines 1-1',
        },
        location,
      ),
    ).toEqual([]);
    expect(
      resolveV2TouchedFilePaths(
        'read',
        {
          output: { type: 'text', offset: 1, lineCount: 1, content: 'source' },
          content: 'Read file skill://example/file.ts, lines 1-1',
        },
        location,
      ),
    ).toEqual([]);
    expect(
      resolveV2TouchedFilePaths(
        'read',
        {
          output: { type: 'media', uri: 'file:///work/project/image.png' },
          content: [
            { type: 'file', name: 'other-machine:/work/project/image.png' },
          ],
        },
        location,
      ),
    ).toEqual([]);
    expect(
      resolveV2TouchedFilePaths(
        'read',
        {
          output: { type: 'media', uri: 'file:///work/project/image.png' },
          content: [{ type: 'file', name: 'image.png' }],
        },
        location,
      ),
    ).toEqual(['/work/project/image.png']);
    expect(
      resolveV2TouchedFilePaths(
        'write',
        {
          output: 'Created file successfully: ../elsewhere.ts',
        },
        location,
      ),
    ).toEqual([]);
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
